/**
 * Client for the Blocky402 facilitator — the party that co-signs and submits settlement.
 *
 * Three things about this API are easy to get wrong, and all three are silent:
 *
 *   1. `/verify` answers **HTTP 200 for a rejected payment**. The verdict lives in the
 *      body (`isValid`), not in the status line. A client written the ordinary way —
 *      `if (res.ok) serve()` — accepts forged and underpaid payments while looking
 *      completely correct. `verifyPayment` therefore never returns a bare truthy value;
 *      it returns a verdict object, and `isValid` is only ever read from the body.
 *
 *   2. The envelope must carry `paymentPayload.accepted`. The facilitator dereferences it
 *      on the first line of its own validation, so omitting it raises a TypeError inside
 *      their service and surfaces as a generic 500 — identical for every input, valid and
 *      invalid alike. That uniformity reads exactly like an outage and is not one.
 *
 *   3. `extra.feePayer` must be echoed into the requirements. The facilitator pays the
 *      network fee, so the buyer signs a transaction it does not pay for; if the fee payer
 *      the buyer signed against and the one in the requirements disagree, the settlement is
 *      refused after the buyer has already signed.
 *
 * The security-relevant asymmetry: `requirements` here is always server-authored. The only
 * buyer-supplied value that enters this module is the base64 transaction. See DESIGN.md
 * rule 2 — a facilitator asked to check a payment against terms written by that payment's
 * own sender will happily approve one tinybar.
 */

export const X402_WIRE_VERSION = 2;

/** Reasons this module refuses on its own, before or instead of asking the facilitator. */
export class FacilitatorError extends Error {
  constructor(message, { reason, status, body } = {}) {
    super(message);
    this.name = 'FacilitatorError';
    this.reason = reason;
    this.status = status;
    this.body = body;
  }
}

/**
 * Build the exact wire envelope the facilitator expects.
 *
 * `accepted` is deliberately set to the *same object* the caller passes as requirements,
 * because the two must agree — the facilitator compares them and refuses divergence with
 * `accepted_payment_requirements_mismatch`. Deriving it here rather than accepting it as a
 * parameter is the point: there is no argument through which a buyer could make the two
 * differ, so that whole class of attack has nowhere to enter.
 *
 * @param {object} args
 * @param {object} args.requirements  server-authored payment requirements
 * @param {string} args.transaction   base64 TransferTransaction bytes, signed by the buyer
 */
export function buildEnvelope({ requirements, transaction }) {
  assertRequirements(requirements);
  if (typeof transaction !== 'string' || transaction.length === 0) {
    throw new FacilitatorError('transaction must be a non-empty base64 string', {
      reason: 'transaction_missing',
    });
  }

  const accepted = requirements;
  return {
    x402Version: X402_WIRE_VERSION,
    paymentPayload: {
      x402Version: X402_WIRE_VERSION,
      scheme: requirements.scheme,
      network: requirements.network,
      // The facilitator dereferences this. Omitting it is a 500, not a 400.
      accepted,
      payload: { transaction },
    },
    paymentRequirements: requirements,
  };
}

/**
 * Assemble server-authored requirements from config and the metered price.
 *
 * Every field originates here or in config. Nothing is copied out of a request.
 *
 * @param {object} args
 * @param {{payTo: string, feePayer: string, network?: string, asset?: string}} args.config
 * @param {bigint} args.price     tinybar
 * @param {string} args.resource  absolute URL of what is being sold
 */
export function buildRequirements({ config, price, resource }) {
  if (!config || typeof config.payTo !== 'string' || !config.payTo) {
    throw new FacilitatorError('config.payTo is required', { reason: 'config_invalid' });
  }
  if (typeof config.feePayer !== 'string' || !config.feePayer) {
    throw new FacilitatorError('config.feePayer is required', { reason: 'config_invalid' });
  }
  if (typeof price !== 'bigint') {
    throw new TypeError('price must be a bigint (tinybar); money is not a float');
  }
  if (price <= 0n) {
    throw new RangeError(`refusing to charge a non-positive price: ${price}`);
  }
  if (typeof resource !== 'string' || !resource) {
    throw new FacilitatorError('resource must be an absolute URL', { reason: 'config_invalid' });
  }

  return Object.freeze({
    scheme: 'exact',
    network: config.network || 'hedera:testnet',
    // Both spellings, and both are load-bearing. The facilitator's validator requires
    // `amount` and rejects the whole request without it — "amount should not be empty,
    // amount must be a string", HTTP 400, measured — while `maxAmountRequired` is the
    // name the x402 challenge uses. Sending only the protocol's spelling is refused
    // before the payment is ever examined.
    amount: price.toString(),
    // tinybar is an integer count; JSON numbers cannot hold large ones exactly, so string.
    maxAmountRequired: price.toString(),
    resource,
    payTo: config.payTo,
    // "0.0.0" is native HBAR rather than an HTS token.
    asset: config.asset || '0.0.0',
    // Required by the validator, and as a NUMBER — "maxTimeoutSeconds must not be less
    // than 1, must be a number conforming to the specified constraints", HTTP 400,
    // measured. Note the asymmetry with the amounts, which must be strings: this API
    // does not take one position on numeric types, so neither can we.
    maxTimeoutSeconds: 120,
    extra: Object.freeze({ feePayer: config.feePayer }),
  });
}

/**
 * Ask the facilitator whether a payment satisfies server-authored requirements.
 *
 * @returns {Promise<{isValid: boolean, invalidReason: (string|null), payer: (string|null), raw: object}>}
 */
export async function verifyPayment({ baseUrl, requirements, transaction, fetchImpl, timeoutMs }) {
  const envelope = buildEnvelope({ requirements, transaction });
  const raw = await postJson({
    url: joinUrl(baseUrl, '/verify'),
    body: envelope,
    fetchImpl,
    timeoutMs,
    op: 'verify',
  });

  // HTTP 200 says the facilitator answered, never that the payment is good.
  const isValid = raw.isValid === true;
  return {
    isValid,
    invalidReason: isValid ? null : (raw.invalidReason || 'unspecified'),
    payer: typeof raw.payer === 'string' ? raw.payer : null,
    raw,
  };
}

/**
 * Submit a verified payment for settlement.
 *
 * Callers must verify first. This is not paranoia about the facilitator: settling an
 * unverified transaction means the service has committed network resources on behalf of a
 * payment it never checked, and the failure is discovered after the buyer has been served.
 *
 * @returns {Promise<{success: boolean, transactionId: (string|null), errorReason: (string|null), raw: object}>}
 */
export async function settlePayment({ baseUrl, requirements, transaction, fetchImpl, timeoutMs }) {
  const envelope = buildEnvelope({ requirements, transaction });
  const raw = await postJson({
    url: joinUrl(baseUrl, '/settle'),
    body: envelope,
    fetchImpl,
    timeoutMs,
    op: 'settle',
  });

  const success = raw.success === true;
  return {
    success,
    // Hedera-native form: 0.0.<feePayer>@<seconds>.<nanos>
    transactionId: typeof raw.transaction === 'string' ? raw.transaction : null,
    errorReason: success ? null : (raw.errorReason || raw.error || 'unspecified'),
    raw,
  };
}

/** Read the facilitator's advertised capabilities (`GET /supported`). */
export async function readSupported({ baseUrl, fetchImpl, timeoutMs }) {
  const doFetch = pickFetch(fetchImpl);
  const res = await withTimeout(
    (signal) => doFetch(joinUrl(baseUrl, '/supported'), { method: 'GET', signal }),
    timeoutMs,
    'supported',
  );
  if (!res.ok) {
    throw new FacilitatorError(`facilitator /supported returned ${res.status}`, {
      reason: 'supported_http_error',
      status: res.status,
    });
  }
  return res.json();
}

/**
 * Find the offer for a given network among the facilitator's advertised kinds, so the
 * fee payer is read from the source of truth rather than pinned to a constant that
 * silently rots when the sponsor rotates the account.
 */
export function selectOffer(supported, network) {
  const kinds = (supported && supported.kinds) || [];
  const match = kinds.find(
    (k) => k && k.network === network && k.scheme === 'exact' && k.x402Version === X402_WIRE_VERSION,
  );
  if (!match) {
    throw new FacilitatorError(`facilitator advertises no exact/v${X402_WIRE_VERSION} offer for ${network}`, {
      reason: 'offer_unavailable',
    });
  }
  const feePayer = match.extra && match.extra.feePayer;
  if (typeof feePayer !== 'string' || !feePayer) {
    throw new FacilitatorError(`offer for ${network} carries no extra.feePayer`, {
      reason: 'fee_payer_missing',
    });
  }
  return { network: match.network, scheme: match.scheme, feePayer };
}

// ---------------------------------------------------------------------------

function assertRequirements(r) {
  if (!r || typeof r !== 'object') {
    throw new FacilitatorError('requirements must be an object', { reason: 'requirements_invalid' });
  }
  for (const field of ['scheme', 'network', 'maxAmountRequired', 'resource', 'payTo', 'asset']) {
    if (typeof r[field] !== 'string' || !r[field]) {
      throw new FacilitatorError(`requirements.${field} is required`, {
        reason: 'requirements_invalid',
      });
    }
  }
  if (!r.extra || typeof r.extra.feePayer !== 'string' || !r.extra.feePayer) {
    throw new FacilitatorError('requirements.extra.feePayer is required — the facilitator pays the fee', {
      reason: 'fee_payer_missing',
    });
  }
}

async function postJson({ url, body, fetchImpl, timeoutMs, op }) {
  const doFetch = pickFetch(fetchImpl);
  const res = await withTimeout(
    (signal) =>
      doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      }),
    timeoutMs,
    op,
  );

  let parsed;
  try {
    parsed = await res.json();
  } catch {
    throw new FacilitatorError(`facilitator ${op} returned a non-JSON body (HTTP ${res.status})`, {
      reason: `${op}_unreadable`,
      status: res.status,
    });
  }

  // A 5xx from this API has historically meant "our validator threw", not "your payment
  // is bad" — so it must never be collapsed into a rejection verdict.
  if (!res.ok) {
    // Carry the validator's own words into the message. A bare "returned HTTP 400" says
    // only that something is wrong with the request, and the whole difficulty of talking
    // to this API is working out *which* field it means.
    const said = typeof parsed?.message === 'string' ? parsed.message
               : typeof parsed?.error === 'string' ? parsed.error
               : '';
    throw new FacilitatorError(
      `facilitator ${op} returned HTTP ${res.status}${said ? `: ${said}` : ''}`,
      { reason: `${op}_http_error`, status: res.status, body: parsed },
    );
  }
  return parsed;
}

function pickFetch(fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  if (typeof f !== 'function') {
    throw new FacilitatorError('no fetch implementation available', { reason: 'no_fetch' });
  }
  return f;
}

async function withTimeout(run, timeoutMs, op) {
  const ms = Number.isFinite(timeoutMs) ? timeoutMs : 15000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await run(ac.signal);
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new FacilitatorError(`facilitator ${op} timed out after ${ms}ms`, {
        reason: `${op}_timeout`,
      });
    }
    throw new FacilitatorError(`facilitator ${op} is unreachable: ${err && err.message}`, {
      reason: `${op}_unreachable`,
    });
  } finally {
    clearTimeout(timer);
  }
}

function joinUrl(baseUrl, path) {
  if (typeof baseUrl !== 'string' || !baseUrl) {
    throw new FacilitatorError('baseUrl is required', { reason: 'config_invalid' });
  }
  return baseUrl.replace(/\/+$/, '') + path;
}
