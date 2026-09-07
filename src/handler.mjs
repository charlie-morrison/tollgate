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
      holdsPrivateKey: false,
      payTo: config.payTo,
      facilitator: config.facilitator.url,
      schedule: publishedSchedule(),
    });
  }

  if (parsed.pathname === '/schedule') {
    return json(200, { schedule: publishedSchedule() });
  }

  if (parsed.pathname !== '/query') {
    return json(404, { error: 'not found', endpoints: ['/query', '/schedule', '/health'] });
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
    const challenge = buildChallenge({
      config,
      price,
      resource,
      schedule: publishedSchedule(),
    });
    // The reason travels with the challenge. "You sent no payment" and "you sent an empty
    // one" are different mistakes and a buyer debugging at 3am should not have to guess.
    return json(402, { ...challenge, reason: err.reason });
  }

  // The terms are ours. Nothing from the buyer's envelope reaches this call except the
  // signed transaction itself, and the price is the one derived in step 1.
  const requirements = buildRequirements({
    config: { payTo: config.payTo, feePayer: config.facilitator.feePayer },
    price,
    resource,
  });

  // 3. Verify.
  let verdict;
  try {
    verdict = await verify({
      baseUrl: config.facilitator.url,
      requirements,
      transaction: payment.transaction,
      fetchImpl,
      timeoutMs,
    });
  } catch (err) {
    if (err instanceof FacilitatorError) {
      // "We could not check" is not "your payment is bad". Reporting an outage as a
      // rejection tells a buyer their good payment failed, and invites them to pay twice.
      return json(502, {
        error: 'payment verification unavailable',
        detail: err.message,
        reason: err.reason,
        retryable: true,
      });
    }
    throw err;
  }

  if (!verdict.isValid) {
    return json(402, {
      ...buildChallenge({ config, price, resource, schedule: publishedSchedule() }),
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
      ...buildChallenge({ config, price, resource, schedule: publishedSchedule() }),
      error: 'settlement refused',
      reason: settlement.errorReason,
    });
  }

  const data = await serve(request);

  return json(
    200,
    {
      request,
      charged: { amount: price.toString(), currency: 'tinybar', asset: 'HBAR' },
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
