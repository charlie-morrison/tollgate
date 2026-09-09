/**
 * The socket adapter. Owns the port and nothing else.
 *
 * Every decision worth arguing about lives in `handler.mjs`, which has no socket and is
 * tested directly. This file exists to turn bytes into a call and a call back into bytes,
 * plus one thing that genuinely belongs at the transport edge: rate limiting.
 *
 * Why the limiter is here and not in the handler: the resource it protects is not ours.
 * Every payment we examine costs one call to the facilitator, and the facilitator's quota
 * is keyed to *our* IP. Without a limit, an unauthenticated stranger posting junk payment
 * headers exhausts that quota and takes the service offline for everyone — including
 * during judging. It is a property of being reachable, not a property of pricing.
 *
 * Where it sits matters as much as that it exists. It covers the verification path only.
 * `/health`, `/schedule` and the unpaid 402 quote stay free and unthrottled, because an
 * honest buyer must always be able to read the price before paying, and throttling the
 * quote breaks the protocol's own first step.
 */

import { createServer } from 'node:http';

import { handleRequest, ReplayGuard } from './handler.mjs';

/** A per-IP token bucket. Refills continuously rather than in steps, so a caller at the limit is not punished for arriving on a boundary. */
export class RateLimiter {
  #buckets = new Map();
  #capacity;
  #windowMs;

  constructor({ capacity = 20, windowMs = 60_000 } = {}) {
    this.#capacity = capacity;
    this.#windowMs = windowMs;
  }

  /** @returns {{allowed: boolean, retryAfterSeconds: number}} */
  take(key, now = Date.now()) {
    const rate = this.#capacity / this.#windowMs;
    const bucket = this.#buckets.get(key) || { tokens: this.#capacity, at: now };
    const refilled = Math.min(this.#capacity, bucket.tokens + (now - bucket.at) * rate);

    if (refilled < 1) {
      this.#buckets.set(key, { tokens: refilled, at: now });
      return { allowed: false, retryAfterSeconds: Math.ceil((1 - refilled) / rate / 1000) };
    }
    this.#buckets.set(key, { tokens: refilled - 1, at: now });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Drop idle buckets so a long-lived process does not accumulate one entry per visitor. */
  sweep(now = Date.now()) {
    for (const [key, b] of this.#buckets) {
      if (now - b.at > this.#windowMs * 10) this.#buckets.delete(key);
    }
  }

  get size() {
    return this.#buckets.size;
  }
}

/**
 * The data this service actually sells: Hedera account activity, read from the public
 * mirror node. Swappable — the payment machinery does not care what is behind it.
 */
async function defaultServe(request) {
  const { MIRROR_TESTNET } = await import('./mirror.mjs');
  const account = process.env.TOLLGATE_DATA_ACCOUNT || '0.0.10181166';
  const url =
    `${MIRROR_TESTNET}/api/v1/transactions` +
    `?account.id=${encodeURIComponent(account)}&limit=${request.records}&order=desc`;

  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`mirror node returned ${res.status}`);
  const body = await res.json();

  const rows = (body.transactions || []).slice(0, request.records).map((t) => {
    const row = {
      transactionId: t.transaction_id,
      type: t.name,
      result: t.result,
      consensusAt: t.consensus_timestamp,
      chargedFee: t.charged_tx_fee,
    };
    // The buyer paid a surcharge for this; it must actually differ.
    if (request.detail === 'full') {
      row.transfers = t.transfers || [];
      row.memo = t.memo_base64 ? Buffer.from(t.memo_base64, 'base64').toString('utf8') : '';
      row.node = t.node;
    }
    return row;
  });

  return { account, source: 'hedera mirror node (public, keyless)', rows };
}

export function createTollgate({
  config,
  serve = defaultServe,
  replayGuard = new ReplayGuard(),
  rateLimiter = new RateLimiter(),
} = {}) {
  const server = createServer(async (req, res) => {
    const origin = process.env.TOLLGATE_PUBLIC_ORIGIN || `http://${req.headers.host || 'localhost'}`;
    let url;
    try {
      url = new URL(req.url, origin);
    } catch {
      return send(res, 400, { 'Content-Type': 'application/json' }, { error: 'unparseable url' });
    }

    // Throttle the expensive path only: a request carrying a payment header is one that
    // will cost us a facilitator call.
    if (req.headers['x-payment'] !== undefined) {
      const ip = clientIp(req);
      const { allowed, retryAfterSeconds } = rateLimiter.take(ip);
      if (!allowed) {
        return send(
          res,
          429,
          { 'Content-Type': 'application/json', 'Retry-After': String(retryAfterSeconds) },
          { error: 'too many payment attempts', retryAfterSeconds },
        );
      }
    }

    try {
      const result = await handleRequest({
        method: req.method,
        url: url.toString(),
        getHeader: (name) => {
          const v = req.headers[name.toLowerCase()];
          return v === undefined ? null : Array.isArray(v) ? v[0] : v;
        },
        config,
        replayGuard,
        serve,
      });
      send(res, result.status, result.headers, result.body);
    } catch (err) {
      // Never leak internals to an anonymous caller; the operator gets the detail.
      console.error('[tollgate] unhandled', err);
      send(res, 500, { 'Content-Type': 'application/json' }, { error: 'internal error' });
    }
  });

  const sweeper = setInterval(() => rateLimiter.sweep(), 60_000);
  sweeper.unref();

  return server;
}

/**
 * Read the caller's address.
 *
 * `X-Forwarded-For` is honoured only when the operator has declared a trusted proxy,
 * because otherwise a header the client controls decides which bucket the client lands
 * in — which is to say, no limit at all.
 */
export function clientIp(req, { trustProxy = process.env.TOLLGATE_TRUST_PROXY === '1' } = {}) {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.trim() !== '') return fwd.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function send(res, status, headers, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { ...headers, 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

/** Config from the environment. No secrets by construction — the server holds no key. */
export function configFromEnv(env = process.env) {
  const payTo = env.TOLLGATE_PAY_TO;
  const feePayer = env.TOLLGATE_FEE_PAYER;
  // Blocky402's testnet facilitator, taken from its own /supported response rather than
  // from a marketing page. It is the only x402 facilitator advertising hedera-testnet.
  const facilitatorUrl = env.TOLLGATE_FACILITATOR || 'https://api.testnet.blocky402.com';

  const missing = [];
  if (!payTo) missing.push('TOLLGATE_PAY_TO');
  if (!feePayer) missing.push('TOLLGATE_FEE_PAYER');
  if (missing.length) {
    // Refuse to boot rather than start with a default payee — a service that silently
    // pays a placeholder account is worse than one that does not start.
    throw new Error(`missing required environment: ${missing.join(', ')}`);
  }

  // Receipts are opt-in and split in two, because the two halves have different costs.
  // Reading needs only a topic id and stays keyless. Writing needs an operator key, which
  // is the one thing this server is proud not to have — so it is enabled only when an
  // operator is supplied explicitly, and a half-configured writer is refused rather than
  // quietly downgraded to a read-only deployment that looks like it is filing receipts.
  const topicId = env.TOLLGATE_RECEIPT_TOPIC || null;
  const operatorId = env.HEDERA_OPERATOR_ID || null;
  const operatorKey = env.HEDERA_OPERATOR_KEY || null;
  if (!!operatorId !== !!operatorKey) {
    throw new Error(
      'receipt writing needs BOTH HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY, or neither',
    );
  }
  if (operatorId && !topicId) {
    throw new Error('receipt operator supplied without TOLLGATE_RECEIPT_TOPIC');
  }

  return {
    payTo,
    facilitator: { url: facilitatorUrl, feePayer },
    receipts: topicId ? { topicId, operatorId, operatorKey } : null,
  };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.PORT || 8403);
  const host = process.env.BIND || '127.0.0.1';
  createTollgate({ config: configFromEnv() }).listen(port, host, () => {
    console.log(`[tollgate] listening on ${host}:${port}`);
  });
}
