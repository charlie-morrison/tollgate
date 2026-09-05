/**
 * The 402 challenge, and the reading of what comes back.
 *
 * This module is where DESIGN.md rule 2 stops being a paragraph and becomes code: the
 * buyer supplies exactly one thing — a signed transaction — and every *term* of the trade
 * is authored here, from server config and from the live request being served.
 *
 * The hole this closes is not hypothetical. If a server echoes the buyer's declared terms
 * into the verification call, it asks the facilitator "does this payment satisfy the
 * conditions its own sender wrote?", and a one-tinybar payment against one-tinybar terms
 * is a perfectly valid payment. The check passes and the server is robbed politely.
 */

/** Thrown when an incoming payment header cannot be read. Every case is named. */
export class PaymentHeaderError extends Error {
  constructor(message, { reason } = {}) {
    super(message);
    this.name = 'PaymentHeaderError';
    /** Machine-readable cause, so callers branch on a value and not on prose. */
    this.reason = reason;
  }
}

export const X402_VERSION = 1;

/** The settlement scheme we ask for, and the one we will accept a payment under. */
export const SCHEME = Object.freeze({
  scheme: 'exact',
  network: 'hedera-testnet',
});

/**
 * Build the machine-readable body of a `402 Payment Required`.
 *
 * The price is passed in rather than computed here on purpose. `meter.priceFor` is the
 * single pricing authority (rule 1); a second module that also knows how to price is
 * exactly the drift this design is trying to make impossible.
 *
 * `extra.feePayer` matters more than it looks: the facilitator submits the settlement and
 * pays the network fee, so the buyer signs a transaction whose fee payer is not the buyer.
 * An agent cannot guess that account, so the challenge has to name it — otherwise the
 * buyer signs something the facilitator cannot submit, and the failure surfaces late and
 * illegibly.
 *
 * @param {object} args
 * @param {{payTo: string, facilitator: {feePayer: string, url: string}}} args.config
 * @param {bigint} args.price      tinybar, from the meter
 * @param {string} args.resource   absolute URL of the thing being sold
 * @param {object} [args.schedule] published fee schedule, so a buyer can budget
 */
export function buildChallenge({ config, price, resource, schedule }) {
  assertConfig(config);
  if (typeof price !== 'bigint') {
    throw new TypeError('price must be a bigint (tinybar); money is not a float');
  }
  if (price <= 0n) {
    throw new RangeError(`refusing to advertise a non-positive price: ${price}`);
  }

  return {
    x402Version: X402_VERSION,
    error: 'payment required',
    accepts: [
      {
        ...SCHEME,
        maxAmountRequired: price.toString(),
        asset: 'HBAR',
        payTo: config.payTo,
        resource,
        description: 'metered access; the amount quoted is for this exact request',
        mimeType: 'application/json',
        maxTimeoutSeconds: 120,
        extra: {
          feePayer: config.facilitator.feePayer,
          facilitator: config.facilitator.url,
        },
      },
    ],
    // Not part of the protocol; included so an agent can reproduce this quote and budget
    // the next one without having to pay to discover the price.
    schedule,
  };
}

/**
 * Read an incoming `X-PAYMENT` header.
 *
 * Accepts either base64-encoded JSON (what x402 clients send) or bare JSON, because a
 * human poking the endpoint with curl should get a real error about their payment rather
 * than a decoding riddle.
 *
 * Returns exactly one value. Anything else the buyer put in the envelope is read past
 * deliberately — see the module comment.
 *
 * @param {string|null|undefined} header
 * @returns {{transaction: string}}
 */
export function readPaymentHeader(header) {
  if (header === null || header === undefined) {
    throw new PaymentHeaderError('no payment attached', { reason: 'ABSENT' });
  }
  if (typeof header !== 'string' || header.trim() === '') {
    // Distinct from ABSENT on purpose. "You sent an empty payment" and "you sent no
    // payment" are different mistakes, and collapsing them sends the caller hunting in
    // the wrong place.
    throw new PaymentHeaderError('payment header present but empty', { reason: 'EMPTY' });
  }

  const text = decodeEnvelope(header.trim());

  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new PaymentHeaderError('payment header is not JSON', { reason: 'MALFORMED' });
  }
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new PaymentHeaderError('payment header is not an object', { reason: 'MALFORMED' });
  }

  const transaction = envelope?.payload?.transaction;
  if (typeof transaction !== 'string' || transaction.trim() === '') {
    throw new PaymentHeaderError('payment header carries no transaction', {
      reason: 'NO_TRANSACTION',
    });
  }

  return { transaction: transaction.trim() };
}

/**
 * The terms of the trade, authored by the server.
 *
 * Note the absence of any parameter through which a caller could influence the result
 * other than the request actually being served. That absence is the security property;
 * it is not an oversight that there is no `overrides` argument.
 *
 * @param {object} args
 * @param {{payTo: string, facilitator: {feePayer: string}}} args.config
 * @param {bigint} args.price     re-derived from the live request, never quoted back
 * @param {string} args.resource
 */
export function buildPaymentRequirements({ config, price, resource }) {
  assertConfig(config);
  if (typeof price !== 'bigint') {
    throw new TypeError('price must be a bigint (tinybar)');
  }
  return {
    ...SCHEME,
    amount: price.toString(),
    maxAmountRequired: price.toString(),
    asset: 'HBAR',
    payTo: config.payTo,
    resource,
    maxTimeoutSeconds: 120,
    extra: { feePayer: config.facilitator.feePayer },
  };
}

/**
 * Assemble the body posted to the facilitator's `/verify` and `/settle`.
 *
 * `accepted` is populated because the facilitator validates the requested scheme from
 * inside the payload, not only from the requirements block; a payload without it is
 * rejected before the payment is ever examined.
 *
 * @param {object} args
 * @param {{transaction: string}} args.payment  the one field taken from the buyer
 * @param {object} args.requirements            from buildPaymentRequirements
 */
export function buildVerifyEnvelope({ payment, requirements }) {
  if (typeof payment?.transaction !== 'string' || payment.transaction === '') {
    throw new PaymentHeaderError('cannot build an envelope without a transaction', {
      reason: 'NO_TRANSACTION',
    });
  }
  return {
    x402Version: X402_VERSION,
    paymentPayload: {
      x402Version: X402_VERSION,
      ...SCHEME,
      accepted: [{ ...SCHEME }],
      payload: { transaction: payment.transaction },
    },
    paymentRequirements: requirements,
  };
}

function decodeEnvelope(raw) {
  if (raw.startsWith('{')) return raw;
  try {
    return Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    throw new PaymentHeaderError('payment header is neither JSON nor base64', {
      reason: 'MALFORMED',
    });
  }
}

function assertConfig(config) {
  if (!config?.payTo) throw new TypeError('config.payTo is required');
  if (!config?.facilitator?.feePayer) throw new TypeError('config.facilitator.feePayer is required');
}
