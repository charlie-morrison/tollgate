/**
 * Hedera mirror node client.
 *
 * This is the module that lets Tollgate confirm a payment against the ledger instead of
 * against somebody's word for it. It is deliberately read-only: no key, no SDK, no
 * signing. Plain REST over the public mirror node.
 *
 * Everything here fails loudly. A payment check that silently returns "nothing found"
 * when the network is unreachable is indistinguishable from a payment check that ran and
 * found nothing, and only one of those should serve data.
 */

export const MIRROR_TESTNET = 'https://testnet.mirrornode.hedera.com';
export const MIRROR_MAINNET = 'https://mainnet-public.mirrornode.hedera.com';

/** Thrown when the mirror node could not be consulted, as distinct from consulted-and-empty. */
export class MirrorUnavailableError extends Error {
  constructor(message, { status = null, cause = null } = {}) {
    super(message);
    this.name = 'MirrorUnavailableError';
    this.status = status;
    this.cause = cause;
  }
}

/**
 * Transaction ids arrive in two shapes and only one of them is a valid URL path segment.
 *
 * Wire form (what a facilitator or SDK hands you):   0.0.1234@1789000000.123456789
 * Mirror form (what the REST API expects):           0.0.1234-1789000000-123456789
 *
 * Passing the wire form straight through gets an HTTP 400, and a 400 swallowed by a
 * try/catch reads exactly like "that payment does not exist" — which is the wrong answer
 * to a very expensive question.
 */
export function toMirrorTxId(txId) {
  if (typeof txId !== 'string' || txId.length === 0) {
    throw new TypeError(`transaction id must be a non-empty string, got ${typeof txId}`);
  }
  const trimmed = txId.trim();

  // Already in mirror form: 0.0.1234-1789000000-123456789
  if (/^\d+\.\d+\.\d+-\d+-\d+$/.test(trimmed)) return trimmed;

  // Wire form: 0.0.1234@1789000000.123456789
  const wire = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(trimmed);
  if (wire) return `${wire[1]}-${wire[2]}-${wire[3]}`;

  throw new TypeError(`unrecognised transaction id shape: ${trimmed}`);
}

async function getJson(url, { timeoutMs = 10_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
  } catch (err) {
    throw new MirrorUnavailableError(`mirror node unreachable: ${url}`, { cause: err });
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 404) return null; // consulted, genuinely absent
  if (!res.ok) {
    throw new MirrorUnavailableError(`mirror node returned ${res.status} for ${url}`, {
      status: res.status,
    });
  }
  return res.json();
}

/**
 * Fetch a transaction record.
 *
 * @returns the mirror record, or null if the mirror has consulted and does not have it
 *          (either it never existed, or it has not reached consensus/ingestion yet).
 * @throws  {MirrorUnavailableError} if we could not ask.
 */
export async function getTransaction(txId, { mirror = MIRROR_TESTNET, timeoutMs } = {}) {
  const id = toMirrorTxId(txId);
  const body = await getJson(`${mirror}/api/v1/transactions/${id}`, { timeoutMs });
  if (!body) return null;
  const list = Array.isArray(body.transactions) ? body.transactions : [];
  if (list.length === 0) return null;
  // A single transaction id can yield several records (e.g. a child account creation).
  // The one that carries the transfer is the one whose id matches exactly.
  return list.find((t) => toMirrorTxId(t.transaction_id ?? '') === id) ?? list[0];
}

/**
 * Net HBAR movement for one account within a transaction, in tinybar.
 *
 * Hedera transfer lists are double-entry and an account can appear more than once in the
 * same list — a payer who is also the payee shows up as both a debit and a credit. Summing
 * every entry for the account is the only reading that is correct in both cases; taking
 * "the first entry that matches" quietly reports a gross figure as a net one.
 */
export function netTransfer(record, accountId) {
  if (!record || !Array.isArray(record.transfers)) return 0n;
  let net = 0n;
  for (const t of record.transfers) {
    if (t.account === accountId) net += BigInt(t.amount);
  }
  return net;
}

/** True when the network accepted the transaction. Anything else is not a payment. */
export function isSuccess(record) {
  return record?.result === 'SUCCESS';
}

/** Consensus timestamp as a Date, or null. */
export function consensusAt(record) {
  const ts = record?.consensus_timestamp;
  if (typeof ts !== 'string') return null;
  const seconds = Number(ts.split('.')[0]);
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : null;
}

/** Public, keyless URL a third party can open to check the same record we checked. */
export function receiptUrl(txId, { mirror = MIRROR_TESTNET } = {}) {
  return `${mirror}/api/v1/transactions/${toMirrorTxId(txId)}`;
}
