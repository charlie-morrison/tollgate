/**
 * The request handler: one function that turns an incoming request into a response.
 *
 * Deliberately not an HTTP server. Everything decided here — what to charge, whether a
 * payment counts, what a buyer is told when the answer is "we don't know" — is decided
 * without a socket, so the properties can be tested directly rather than through a port.
 * `server.mjs` is the thin adapter that owns the socket and nothing else.
 *
 * The order of operations is the security design, and it is not the obvious one:
 *
 *   1. Meter the LIVE request. The price is derived from what is being asked for now,
 *      never from anything the buyer quoted back to us. A buyer who pays for one record
 *      and presents that receipt against a hundred is refused here, not by good manners.
 *   2. No payment? Quote, and stop. The quote is free — an honest buyer must be able to
 *      learn the price before spending, and a paywall in front of the price tag is a
 *      protocol violation dressed up as revenue protection.
 *   3. Verify before settle. Settling first means committing network resources on behalf
 *      of a payment nobody checked.
 *   4. Claim the replay key AFTER verify passes and BEFORE settle. Claiming later leaves
 *      a window where the same signed bytes are replayable if settle times out; claiming
 *      earlier lets an attacker burn a legitimate buyer's transaction with a junk verify.
 *   5. Serve only after settlement is confirmed.
 */

import { createHash } from 'node:crypto';

import { meter, publishedSchedule, InvalidRequestError } from './meter.mjs';
import {
  buildChallenge,
  readPaymentHeader,
  PaymentHeaderError,
  SCHEME,
} from './challenge.mjs';
import {
  buildRequirements,
  verifyPayment,
  settlePayment,
  FacilitatorError,
} from './facilitator.mjs';
import { buildReceipt, readReceipts, emitReceipt } from './receipts.mjs';
import { tokenAmountFor, buildTokenOffer, tokenSchedule } from './hts.mjs';
import {
  buildDiscoveryDocument,
  DISCOVERY_PATH,
  REFERENCE_RESOURCE_PATH,
} from './discovery.mjs';

/**
 * Every offer this server is willing to be paid under, as server-authored requirements.
 *
 * HBAR first, then the token if one is configured. The order is fixed in code and does
 * not depend on anything in the request: a buyer selects an offer by signing a
 * transaction that satisfies it, never by telling us which one to apply.
 */
export function candidateRequirements({ config, price, resource }) {
  const base = { payTo: config.payTo, feePayer: config.facilitator.feePayer };
  const list = [buildRequirements({ config: base, price, resource })];

  if (config.token) {
    list.push(
      buildRequirements({
        config: { ...base, asset: config.token.tokenId },
        price,
        resource,
        amount: tokenAmountFor(price, config.token.tinybarPerUnit),
      }),
    );
  }
  return list;
}

/** The 402 body, carrying one offer per asset we accept. */
function challengeFor({ config, price, resource, reason }) {
  const challenge = buildChallenge({ config, price, resource, schedule: publishedSchedule() });
  if (config.token) {
    challenge.accepts.push(
      buildTokenOffer({ base: challenge.accepts[0], token: config.token, price }),
    );
    challenge.tokenSchedule = tokenSchedule(config.token);
  }
  return reason === undefined ? challenge : { ...challenge, reason };
}

/**
 * A replay guard with an explicit two-step claim.
 *
 * `claim` is deliberately not `has`+`add`: the check and the insert must be one
 * operation, or two concurrent requests carrying the same transaction both see "not
 * seen" and both get served.
 */
export class ReplayGuard {
  #seen = new Map();
  #ttlMs;

  constructor({ ttlMs = 60 * 60 * 1000 } = {}) {
    this.#ttlMs = ttlMs;
  }

  /** @returns {boolean} true if this caller now owns the key; false if it was taken. */
  claim(key, now = Date.now()) {
    this.#sweep(now);
    if (this.#seen.has(key)) return false;
    this.#seen.set(key, now);
    return true;
  }

  /**
   * Give a key back. Used only when settlement is *definitively* refused, so an honest
   * buyer whose payment the facilitator rejected is not locked out of retrying with a
   * corrected one. Never called on an indeterminate outcome — see below.
   */
  release(key) {
    this.#seen.delete(key);
  }

  get size() {
    return this.#seen.size;
  }

  #sweep(now) {
    if (this.#ttlMs === Infinity) return;
    for (const [key, at] of this.#seen) {
      if (now - at > this.#ttlMs) this.#seen.delete(key);
    }
  }
}

/**
 * Handle one request.
 *
 * @param {object} args
 * @param {string} args.method
 * @param {string} args.url                absolute URL of this request
 * @param {(name: string) => (string|null)} args.getHeader
 * @param {object} args.config             { payTo, facilitator: { url, feePayer } }
 * @param {ReplayGuard} args.replayGuard
 * @param {(request: object) => Promise<any>} args.serve   produces the paid-for data
 * @param {object} [args.deps]             injection seam for tests
 * @returns {Promise<{status: number, headers: object, body: object}>}
 */
export async function handleRequest({
  method,
  url,
  getHeader,
  config,
  replayGuard,
  serve,
  deps = {},
}) {
  const {
    verify = verifyPayment,
    settle = settlePayment,
    emit = emitReceipt,
    fetchImpl,
    timeoutMs,
  } = deps;

  const parsed = new URL(url);

  if (method !== 'GET' && method !== 'HEAD') {
    return json(405, { error: 'method not allowed', allow: 'GET' }, { Allow: 'GET' });
  }

  if (parsed.pathname === '/health') {
    return json(200, {
      status: 'ok',
      // Stated plainly because it is the unusual property, and a reader of a payments
      // box should not have to infer it from the absence of code.
      //
      // It is COMPUTED, never hardcoded. Enabling receipt writing gives this process an
      // operator key, and a health endpoint that kept claiming otherwise would be lying
      // about the single property the design is built on. Note what the key can and
      // cannot do: it signs receipts and pays their sub-cent fees, and is deliberately
      // not the payee, so it can never move revenue.
      holdsPrivateKey: Boolean(config.receipts?.operatorKey),
      payTo: config.payTo,
      facilitator: config.facilitator.url,
      receipts: config.receipts?.topicId
        ? { topicId: config.receipts.topicId, writeEnabled: Boolean(config.receipts.operatorKey) }
        : null,
      schedule: publishedSchedule(),
    });
  }

  if (parsed.pathname === '/schedule') {
    return json(200, { schedule: publishedSchedule() });
  }

  // The public settlement trail. Free and keyless, deliberately: an audit trail you have
  // to pay us to read, or that only we can read, is not much of an audit trail.
  if (parsed.pathname === '/receipts') {
    if (!config.receipts?.topicId) {
      return json(404, { error: 'receipts not enabled on this deployment' });
    }
    try {
      const trail = await readReceipts(config.receipts.topicId, { fetchImpl, timeoutMs });
      return json(200, trail);
    } catch (err) {
      // Distinguished from an empty trail on purpose: "we could not read the ledger" and
      // "the ledger says nothing happened" are opposite answers.
      return json(502, { error: 'could not read the receipt topic', detail: err.message });
    }
  }

  // Discovery. Free and unthrottled for the same reason the quote is: a service nobody
  // can find without being told about it is not discoverable, and a directory crawler
  // that gets a 429 concludes we are down.
  if (parsed.pathname === DISCOVERY_PATH) {
    // The reference price comes from the meter with NO parameters, which is exactly what
    // a bare `/query` is priced at. Not a constant repeated here — a constant would be
    // free to drift away from the meter, and a discovery document that misquotes is
    // worse than one that does not exist.
    const { price: referencePrice } = meter(new URLSearchParams());
    const resource = `${parsed.origin}${REFERENCE_RESOURCE_PATH}`;
    // Built from the CHALLENGE, not from the verification requirements. The two disagree
    // about one field on purpose: the 402 advertises `asset: "HBAR"` while the facilitator
    // envelope names the same asset `0.0.0`, Hedera's id for it. A directory consumer
    // compares a listing against the 402 it gets back, so the listing has to be the 402's
    // view. Publishing the internal form would have listed an asset no buyer ever sees.
    const reference = challengeFor({ config, price: referencePrice, resource });
    return json(
      200,
      buildDiscoveryDocument({
        config: {
          ...config,
          schedule: reference.schedule,
          tokenSchedule: reference.tokenSchedule ?? null,
        },
        origin: parsed.origin,
        offers: reference.accepts,
      }),
    );
  }

  if (parsed.pathname !== '/query') {
    return json(404, {
      error: 'not found',
      endpoints: ['/query', '/schedule', '/receipts', '/health', DISCOVERY_PATH],
    });
  }

  // 1. Price the live request. Before any payment is examined, and before any quote is
  //    issued, so a nonsense request is refused rather than priced.
  let request;
  let price;
  try {
    ({ request, price } = meter(parsed.searchParams));
  } catch (err) {
    if (err instanceof InvalidRequestError) {
      return json(400, { error: 'invalid request', detail: err.message, param: err.param });
    }
    throw err;
  }

  const resource = `${parsed.origin}${parsed.pathname}${parsed.search}`;

  // 2. No payment: quote and stop. Free, always.
  let payment;
  try {
    payment = readPaymentHeader(getHeader('x-payment'));
  } catch (err) {
    if (!(err instanceof PaymentHeaderError)) throw err;
    // The reason travels with the challenge. "You sent no payment" and "you sent an empty
    // one" are different mistakes and a buyer debugging at 3am should not have to guess.
    return json(402, challengeFor({ config, price, resource, reason: err.reason }));
  }

  // The terms are ours. Nothing from the buyer's envelope reaches this call except the
  // signed transaction itself, and the price is the one derived in step 1.
  //
  // With two assets on offer there is a question of which one the buyer paid in, and
  // exactly one safe answer: the server tries its OWN offers in turn and the buyer's
  // signature selects one by satisfying it. The unsafe answer — letting the envelope
  // declare its asset — is the same trust bug as letting it declare its price, one field
  // along: an attacker would name the asset whose terms suit them. So there is
  // deliberately no code path here that reads an asset from the buyer, not even as a hint
  // for ordering, because a hint that reorders a list of candidates is one refactor away
  // from being the thing that chooses.
  const candidates = candidateRequirements({ config, price, resource });

  // 3. Verify against each of our own offers until one is satisfied.
  let verdict;
  let requirements;
  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop -- ordered by design; see above
      verdict = await verify({
        baseUrl: config.facilitator.url,
        requirements: candidate,
        transaction: payment.transaction,
        fetchImpl,
        timeoutMs,
      });
    } catch (err) {
      if (err instanceof FacilitatorError) {
        // "We could not check" is not "your payment is bad". Reporting an outage as a
        // rejection tells a buyer their good payment failed, and invites them to pay
        // twice. Note this aborts rather than falling through to the next asset: an
        // outage masked by "well, try the other one" would surface as a payment
        // rejection, which is the exact confusion this branch exists to prevent.
        return json(502, {
          error: 'payment verification unavailable',
          detail: err.message,
          reason: err.reason,
          retryable: true,
        });
      }
      throw err;
    }
    requirements = candidate;
    if (verdict.isValid) break;
  }

  if (!verdict.isValid) {
    return json(402, {
      ...challengeFor({ config, price, resource }),
      error: 'payment rejected',
      reason: verdict.invalidReason,
    });
  }

  // 4. Claim the replay key: after verify, before settle.
  const replayKey = replayKeyFor(payment.transaction);
  if (!replayGuard.claim(replayKey)) {
    return json(409, {
      error: 'payment already used',
      detail: 'each signed transaction buys exactly one response',
    });
  }

  // 5. Settle, then serve.
  let settlement;
  try {
    settlement = await settle({
      baseUrl: config.facilitator.url,
      requirements,
      transaction: payment.transaction,
      fetchImpl,
      timeoutMs,
    });
  } catch (err) {
    if (err instanceof FacilitatorError) {
      // The key is NOT released here, and that is the whole point. A settle that timed
      // out or could not be reached may still have landed on-chain; releasing the key
      // would let the same bytes be presented again and, if the first one did land,
      // charge the buyer twice. The buyer is told the outcome is unknown and given the
      // transaction to check for themselves on a ledger neither of us controls.
      return json(502, {
        error: 'settlement outcome unknown',
        detail: err.message,
        reason: err.reason,
        indeterminate: true,
        advice: 'check the mirror node before re-paying; this payment may have settled',
      });
    }
    throw err;
  }

  if (!settlement.success) {
    // A definitive refusal, so the buyer may retry with a corrected payment.
    replayGuard.release(replayKey);
    return json(402, {
      ...challengeFor({ config, price, resource }),
      error: 'settlement refused',
      reason: settlement.errorReason,
    });
  }

  const data = await serve(request);

  // The public record, written after the buyer has what they paid for and never awaited.
  // A consensus round must not sit between a paying buyer and their data, and a failure
  // to file the paperwork must never be able to fail a request that already settled.
  if (config.receipts?.topicId && config.receipts?.operatorId && config.receipts?.operatorKey) {
    emit(
      buildReceipt({
        transactionId: settlement.transactionId,
        payer: verdict.payer ?? null,
        payee: config.payTo,
        // What ACTUALLY moved, in the asset it moved in — taken from the requirements the
        // buyer's signature satisfied, not from the tinybar price. A token payment logged
        // as tinybar would put a false number in the one record meant to be trusted.
        amount: BigInt(requirements.amount),
        asset: requirements.asset === '0.0.0' ? 'HBAR' : requirements.asset,
        resource,
      }),
      config.receipts,
      { onError: (err) => console.error('[tollgate] receipt not filed:', err.message) },
    );
  }

  return json(
    200,
    {
      request,
      charged:
        requirements.asset === '0.0.0'
          ? { amount: requirements.amount, currency: 'tinybar', asset: 'HBAR' }
          : {
              amount: requirements.amount,
              currency: 'token-unit',
              asset: requirements.asset,
              decimals: config.token?.decimals,
              meteredPriceTinybar: price.toString(),
            },
      settlement: { transactionId: settlement.transactionId, payer: verdict.payer },
      data,
    },
    {
      // The x402 response header, so a client can record what it paid without parsing prose.
      'X-PAYMENT-RESPONSE': Buffer.from(
        JSON.stringify({
          success: true,
          transaction: settlement.transactionId,
          network: SCHEME.network,
          payer: verdict.payer,
        }),
      ).toString('base64'),
    },
  );
}

/**
 * The replay key.
 *
 * The signed transaction bytes are the identity of the payment: same bytes, same transfer,
 * same one purchase. Hashing rather than storing raw keeps the guard's memory bounded and
 * keeps signed payloads out of a long-lived in-process map.
 */
export function replayKeyFor(transaction) {
  return createHash('sha256').update(transaction).digest('hex');
}

function json(status, body, headers = {}) {
  return {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  };
}
