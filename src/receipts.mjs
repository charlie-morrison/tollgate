/**
 * Public settlement receipts on the Hedera Consensus Service.
 *
 * A paywall asks its users to believe two things: that they were charged what they were
 * quoted, and that the money went where the offer said it would. Tollgate already lets a
 * buyer check the second on the mirror node. This module publishes the first — one
 * ordered, timestamped, publicly readable record per settled payment, on a topic the
 * operator cannot rewrite.
 *
 * Two rules shape the whole file:
 *
 * 1. READING IS KEYLESS. Receipts are read over the mirror node's REST API — no key, no
 *    account, no SDK. That is what makes the trail *verifiable by a stranger* rather than
 *    a claim we make about ourselves. `receiptsUrl()` hands out the raw mirror URL so a
 *    reader can skip us entirely.
 *
 * 2. WRITING IS OPTIONAL AND SEPARATE. Submitting needs an operator key, and Tollgate's
 *    sharpest property is that the resource server holds none. So the SDK import is lazy
 *    and lives only on the write path: a deployment with receipts disabled never loads it
 *    and never has a key. The write operator is also deliberately NOT the payee — it
 *    signs receipts and pays their sub-cent fees, and cannot touch revenue.
 */

/** The receipt schema. Field-for-field the shape the Hedera harness PRD specifies. */
export const RECEIPT_SCHEMA = 'x402.receipt.v1';

/**
 * Refuse to publish a receipt larger than this.
 *
 * The SDK will happily chunk a large topic message across several consensus messages.
 * That is the wrong behaviour here: a chunked receipt reads back off the mirror node as
 * fragments, i.e. as several malformed receipts, and a reader cannot tell a fragment from
 * a corrupt record. Refusing loudly is better than publishing something unreadable, so
 * this sits conservatively below the single-message limit.
 */
export const MAX_RECEIPT_BYTES = 900;

export class ReceiptTooLargeError extends Error {
  constructor(bytes) {
    super(`receipt is ${bytes} bytes, over the ${MAX_RECEIPT_BYTES}-byte single-message limit`);
    this.name = 'ReceiptTooLargeError';
    this.bytes = bytes;
  }
}

/**
 * Build a receipt from settlement facts.
 *
 * Pure: no clock of its own beyond the caller's `at`, no network, no SDK. That keeps the
 * shape of a receipt testable without a topic, and keeps the decision about *what is
 * true* separate from the decision about *where to publish it*.
 *
 * `amount` is carried as a STRING on purpose. Tinybar values are large enough that JSON
 * number parsing loses precision at the top of the range, and a payment record that
 * silently rounds is worse than no record at all.
 *
 * An unknown payer is recorded as `null`, never as a guess or an empty string. A receipt
 * that says "we do not know who paid" is honest; one that invents an account is evidence
 * of nothing.
 */
export function buildReceipt({
  transactionId,
  payer = null,
  payee,
  amount,
  resource,
  at = new Date(),
}) {
  if (typeof transactionId !== 'string' || transactionId.length === 0) {
    throw new TypeError('transactionId must be a non-empty string');
  }
  if (typeof payee !== 'string' || payee.length === 0) {
    throw new TypeError('payee must be a non-empty string');
  }
  if (typeof resource !== 'string' || resource.length === 0) {
    throw new TypeError('resource must be a non-empty string');
  }
  if (payer !== null && (typeof payer !== 'string' || payer.length === 0)) {
    throw new TypeError('payer must be a non-empty string or null');
  }

  const normalisedAmount =
    typeof amount === 'bigint' || typeof amount === 'number' ? String(amount) : amount;
  if (typeof normalisedAmount !== 'string' || !/^\d+$/.test(normalisedAmount)) {
    throw new TypeError(`amount must be a whole number of tinybar, got ${String(amount)}`);
  }

  return {
    schema: RECEIPT_SCHEMA,
    transactionId,
    payer,
    payee,
    amount: normalisedAmount,
    currency: 'tinybar',
    asset: 'HBAR',
    resource,
    at: at.toISOString(),
  };
}

/**
 * Serialise a receipt, refusing anything that would be chunked.
 *
 * Returns the bytes rather than a string so the caller cannot re-encode under a different
 * assumption and land back over the limit.
 */
export function encodeReceipt(receipt) {
  const bytes = Buffer.from(JSON.stringify(receipt), 'utf8');
  if (bytes.length > MAX_RECEIPT_BYTES) throw new ReceiptTooLargeError(bytes.length);
  return bytes;
}

/**
 * The URL anyone can use to read the receipt topic without going through us.
 *
 * This is published in the service's own responses. A verification path that only we can
 * walk is not verification.
 */
export function receiptsUrl(topicId, { mirror = 'https://testnet.mirrornode.hedera.com', limit = 25 } = {}) {
  if (typeof topicId !== 'string' || !/^\d+\.\d+\.\d+$/.test(topicId)) {
    throw new TypeError(`topic id must look like 0.0.x, got ${String(topicId)}`);
  }
  return `${mirror}/api/v1/topics/${topicId}/messages?limit=${limit}&order=desc`;
}

/**
 * Read receipts back off the mirror node. Keyless, and this is the point.
 *
 * A topic is public and anyone may write to an open one, so every message is treated as
 * untrusted input: anything that is not JSON, or does not carry our schema tag, is
 * reported as unparsed rather than crashed on and rather than presented as ours.
 */
export async function readReceipts(
  topicId,
  { mirror = 'https://testnet.mirrornode.hedera.com', limit = 25, fetchImpl = fetch, timeoutMs = 10_000 } = {},
) {
  const url = receiptsUrl(topicId, { mirror, limit });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { signal: controller.signal });
  } catch (err) {
    throw new Error(`mirror node unreachable while reading receipts: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`mirror node returned HTTP ${res.status} reading receipts`);

  const body = await res.json();
  const receipts = [];
  const unparsed = [];

  for (const message of body.messages ?? []) {
    let decoded;
    try {
      decoded = JSON.parse(Buffer.from(message.message, 'base64').toString('utf8'));
    } catch {
      unparsed.push({ sequenceNumber: message.sequence_number, reason: 'not JSON' });
      continue;
    }
    if (decoded?.schema !== RECEIPT_SCHEMA) {
      unparsed.push({ sequenceNumber: message.sequence_number, reason: 'foreign schema' });
      continue;
    }
    receipts.push({
      ...decoded,
      sequenceNumber: message.sequence_number,
      consensusAt: message.consensus_timestamp,
    });
  }

  return { topicId, receipts, unparsed, verifyItYourself: url };
}

/**
 * Submit a receipt to HCS. The only function here that needs a key.
 *
 * The SDK is imported lazily so that a keyless deployment — the default — never pulls it
 * in. `configFromEnv` in the server refuses to enable writing without an operator, so
 * this cannot be reached by accident.
 */
export async function submitReceipt(receipt, { topicId, operatorId, operatorKey, network = 'testnet' }) {
  if (!topicId || !operatorId || !operatorKey) {
    throw new Error('submitReceipt needs topicId, operatorId and operatorKey');
  }
  const bytes = encodeReceipt(receipt);

  const { Client, PrivateKey, AccountId, TopicMessageSubmitTransaction } = await import('@hashgraph/sdk');
  const client =
    network === 'mainnet'
      ? Client.forMainnet().setOperator(AccountId.fromString(operatorId), PrivateKey.fromStringECDSA(operatorKey))
      : Client.forTestnet().setOperator(AccountId.fromString(operatorId), PrivateKey.fromStringECDSA(operatorKey));

  try {
    const submit = await new TopicMessageSubmitTransaction()
      .setTopicId(topicId)
      .setMessage(bytes)
      .execute(client);
    const rx = await submit.getReceipt(client);
    return {
      topicId,
      sequenceNumber: rx.topicSequenceNumber ? Number(rx.topicSequenceNumber) : null,
      status: rx.status?.toString() ?? null,
    };
  } finally {
    client.close();
  }
}

/**
 * Fire-and-forget emission, for use on the request path.
 *
 * Two properties matter more than the receipt itself, and both are enforced here rather
 * than left to the caller's discipline:
 *
 *   - It is never awaited by the response. A consensus round must not sit between a
 *     paying buyer and the data they just bought.
 *   - It can never fail the request. A receipt is a record of a settlement that already
 *     happened; losing the record is bad, but refusing to serve a buyer who has already
 *     paid because our bookkeeping hiccuped is worse.
 */
export function emitReceipt(receipt, options, { onError = () => {} } = {}) {
  submitReceipt(receipt, options).catch((err) => {
    try {
      onError(err);
    } catch {
      /* an error handler that throws must not take the process with it */
    }
  });
}
