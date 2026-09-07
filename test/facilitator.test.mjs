import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEnvelope,
  buildRequirements,
  verifyPayment,
  settlePayment,
  readSupported,
  selectOffer,
  FacilitatorError,
  X402_WIRE_VERSION,
} from '../src/facilitator.mjs';

const CONFIG = { payTo: '0.0.10181166', feePayer: '0.0.7162784' };
const RESOURCE = 'https://example.test/query?records=3';
const TX = 'CgwKAhgDEgYIABAAGAA=';

const reqs = (over = {}) => ({ ...buildRequirements({ config: CONFIG, price: 260000n, resource: RESOURCE }), ...over });

/** A fetch stand-in that records what it was asked and replies with a canned body. */
function stubFetch(status, body, sink = []) {
  const f = async (url, init) => {
    sink.push({ url, method: (init && init.method) || 'GET', body: init && init.body ? JSON.parse(init.body) : null });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  f.calls = sink;
  return f;
}

// --- requirements are server-authored -------------------------------------

test('buildRequirements produces every term from config and the meter', () => {
  const r = buildRequirements({ config: CONFIG, price: 260000n, resource: RESOURCE });
  assert.equal(r.scheme, 'exact');
  assert.equal(r.network, 'hedera:testnet');
  assert.equal(r.maxAmountRequired, '260000');
  assert.equal(r.payTo, CONFIG.payTo);
  assert.equal(r.asset, '0.0.0', 'native HBAR, not an HTS token');
  assert.equal(r.extra.feePayer, CONFIG.feePayer);
  assert.equal(r.resource, RESOURCE);
});

test('the price crosses the wire as a string, because JSON numbers lose large tinybar', () => {
  const big = 9007199254740993n; // > Number.MAX_SAFE_INTEGER
  const r = buildRequirements({ config: CONFIG, price: big, resource: RESOURCE });
  assert.equal(r.maxAmountRequired, '9007199254740993');
  assert.notEqual(Number(r.maxAmountRequired).toString(), r.maxAmountRequired);
});

test('a float price is refused rather than rounded', () => {
  assert.throws(() => buildRequirements({ config: CONFIG, price: 260000, resource: RESOURCE }), TypeError);
});

test('a non-positive price is refused — a free tollgate is a bug, not an offer', () => {
  assert.throws(() => buildRequirements({ config: CONFIG, price: 0n, resource: RESOURCE }), RangeError);
  assert.throws(() => buildRequirements({ config: CONFIG, price: -1n, resource: RESOURCE }), RangeError);
});

test('missing fee payer is refused by name at config time', () => {
  assert.throws(
    () => buildRequirements({ config: { payTo: '0.0.1' }, price: 1n, resource: RESOURCE }),
    (e) => e instanceof FacilitatorError && e.reason === 'config_invalid',
  );
});

// --- the envelope ----------------------------------------------------------

test('envelope carries paymentPayload.accepted — omitting it is a 500, not a 400', () => {
  const env = buildEnvelope({ requirements: reqs(), transaction: TX });
  assert.ok(env.paymentPayload.accepted, 'accepted must be present');
  assert.deepEqual(env.paymentPayload.accepted, env.paymentRequirements);
});

test('envelope is x402 v2 at both levels — the facilitator rejects v1', () => {
  const env = buildEnvelope({ requirements: reqs(), transaction: TX });
  assert.equal(env.x402Version, X402_WIRE_VERSION);
  assert.equal(env.paymentPayload.x402Version, X402_WIRE_VERSION);
  assert.equal(X402_WIRE_VERSION, 2);
});

test('the buyer contributes exactly one field: the transaction', () => {
  const env = buildEnvelope({ requirements: reqs(), transaction: TX });
  assert.deepEqual(Object.keys(env.paymentPayload.payload), ['transaction']);
  assert.equal(env.paymentPayload.payload.transaction, TX);
});

test('an empty or absent transaction is refused by name, not sent', () => {
  for (const bad of ['', null, undefined, 42, {}]) {
    assert.throws(
      () => buildEnvelope({ requirements: reqs(), transaction: bad }),
      (e) => e instanceof FacilitatorError && e.reason === 'transaction_missing',
      `transaction ${JSON.stringify(bad)} should be refused`,
    );
  }
});

test('requirements missing extra.feePayer are refused before any network call', () => {
  const r = reqs();
  const stripped = { ...r, extra: {} };
  assert.throws(
    () => buildEnvelope({ requirements: stripped, transaction: TX }),
    (e) => e instanceof FacilitatorError && e.reason === 'fee_payer_missing',
  );
});

// --- the trap: HTTP 200 does not mean paid ---------------------------------

test('an invalid payment arrives as HTTP 200 and must still be a rejection', async () => {
  const f = stubFetch(200, { isValid: false, invalidReason: 'amount_mismatch' });
  const v = await verifyPayment({ baseUrl: 'https://f.test', requirements: reqs(), transaction: TX, fetchImpl: f });
  assert.equal(v.isValid, false);
  assert.equal(v.invalidReason, 'amount_mismatch');
});

test('a rejection with no stated reason is still a rejection, and is named', async () => {
  const f = stubFetch(200, {});
  const v = await verifyPayment({ baseUrl: 'https://f.test', requirements: reqs(), transaction: TX, fetchImpl: f });
  assert.equal(v.isValid, false);
  assert.equal(v.invalidReason, 'unspecified');
});

test('only a literal isValid:true is accepted — no truthiness', async () => {
  for (const truthy of ['true', 1, 'yes', {}]) {
    const f = stubFetch(200, { isValid: truthy });
    const v = await verifyPayment({ baseUrl: 'https://f.test', requirements: reqs(), transaction: TX, fetchImpl: f });
    assert.equal(v.isValid, false, `isValid=${JSON.stringify(truthy)} must not pass`);
  }
});

test('a valid payment reports the payer the facilitator inferred', async () => {
  const f = stubFetch(200, { isValid: true, payer: '0.0.10181137' });
  const v = await verifyPayment({ baseUrl: 'https://f.test', requirements: reqs(), transaction: TX, fetchImpl: f });
  assert.equal(v.isValid, true);
  assert.equal(v.payer, '0.0.10181137');
  assert.equal(v.invalidReason, null);
});

test('a 5xx is an error, never a rejection verdict', async () => {
  const f = stubFetch(500, { message: 'Payment verification failed' });
  await assert.rejects(
    () => verifyPayment({ baseUrl: 'https://f.test', requirements: reqs(), transaction: TX, fetchImpl: f }),
    (e) => e instanceof FacilitatorError && e.reason === 'verify_http_error' && e.status === 500,
  );
});

test('an unreachable facilitator is distinct from a refused payment', async () => {
  const f = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(
    () => verifyPayment({ baseUrl: 'https://f.test', requirements: reqs(), transaction: TX, fetchImpl: f }),
    (e) => e instanceof FacilitatorError && e.reason === 'verify_unreachable',
  );
});

test('a non-JSON body is named rather than crashing the handler', async () => {
  const f = async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } });
  await assert.rejects(
    () => verifyPayment({ baseUrl: 'https://f.test', requirements: reqs(), transaction: TX, fetchImpl: f }),
    (e) => e instanceof FacilitatorError && e.reason === 'verify_unreadable',
  );
});

// --- settlement ------------------------------------------------------------

test('settlement returns the native Hedera tx id shape', async () => {
  const f = stubFetch(200, { success: true, transaction: '0.0.7162784@1787758480.645254410' });
  const s = await settlePayment({ baseUrl: 'https://f.test', requirements: reqs(), transaction: TX, fetchImpl: f });
  assert.equal(s.success, true);
  assert.match(s.transactionId, /^0\.0\.\d+@\d+\.\d+$/);
});

test('a failed settlement names its reason and yields no tx id', async () => {
  const f = stubFetch(200, { success: false, errorReason: 'fee_payer_mismatch' });
  const s = await settlePayment({ baseUrl: 'https://f.test', requirements: reqs(), transaction: TX, fetchImpl: f });
  assert.equal(s.success, false);
  assert.equal(s.transactionId, null);
  assert.equal(s.errorReason, 'fee_payer_mismatch');
});

test('verify and settle hit their own paths on the configured host', async () => {
  const sink = [];
  const f = stubFetch(200, { isValid: true, success: true, transaction: '0.0.1@1.1' }, sink);
  await verifyPayment({ baseUrl: 'https://f.test/', requirements: reqs(), transaction: TX, fetchImpl: f });
  await settlePayment({ baseUrl: 'https://f.test/', requirements: reqs(), transaction: TX, fetchImpl: f });
  assert.deepEqual(sink.map((c) => c.url), ['https://f.test/verify', 'https://f.test/settle']);
  assert.deepEqual(sink.map((c) => c.method), ['POST', 'POST']);
});

// --- reading the advertised offer ------------------------------------------

const SUPPORTED = {
  kinds: [
    { x402Version: 2, scheme: 'exact', network: 'hedera:mainnet', extra: { feePayer: '0.0.999' } },
    { x402Version: 2, scheme: 'exact', network: 'hedera:testnet', extra: { feePayer: '0.0.7162784' } },
  ],
};

test('the fee payer is read from the live offer, not pinned to a constant', () => {
  const offer = selectOffer(SUPPORTED, 'hedera:testnet');
  assert.equal(offer.feePayer, '0.0.7162784');
  assert.equal(selectOffer(SUPPORTED, 'hedera:mainnet').feePayer, '0.0.999');
});

test('an unavailable network is refused by name rather than defaulting to another', () => {
  assert.throws(
    () => selectOffer(SUPPORTED, 'hedera:previewnet'),
    (e) => e instanceof FacilitatorError && e.reason === 'offer_unavailable',
  );
});

test('an offer without a fee payer is refused — signing against a guess fails late', () => {
  assert.throws(
    () => selectOffer({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'n' }] }, 'n'),
    (e) => e instanceof FacilitatorError && e.reason === 'fee_payer_missing',
  );
});

test('/supported is read over GET and its failure is named', async () => {
  const sink = [];
  const ok = stubFetch(200, SUPPORTED, sink);
  assert.deepEqual(await readSupported({ baseUrl: 'https://f.test', fetchImpl: ok }), SUPPORTED);
  assert.equal(sink[0].method, 'GET');
  assert.equal(sink[0].url, 'https://f.test/supported');

  const bad = stubFetch(503, {});
  await assert.rejects(
    () => readSupported({ baseUrl: 'https://f.test', fetchImpl: bad }),
    (e) => e instanceof FacilitatorError && e.reason === 'supported_http_error',
  );
});

// --- the property that the whole module exists to hold ---------------------

test('a buyer envelope spread into the arguments cannot alter the terms sent', () => {
  const honest = buildEnvelope({ requirements: reqs(), transaction: TX });

  // Everything an attacker might hope leaks through: their own favourable terms, their own
  // `accepted` block, a different payee, a one-tinybar price.
  const attacker = {
    requirements: reqs(),
    transaction: TX,
    accepted: { scheme: 'exact', network: 'hedera:testnet', maxAmountRequired: '1', payTo: '0.0.66', asset: '0.0.0', extra: { feePayer: '0.0.66' } },
    paymentRequirements: { maxAmountRequired: '1', payTo: '0.0.66' },
    maxAmountRequired: '1',
    payTo: '0.0.66',
    x402Version: 1,
  };
  const got = buildEnvelope(attacker);

  assert.deepEqual(got, honest, 'no extra argument property may influence the envelope');
  assert.equal(got.paymentRequirements.payTo, CONFIG.payTo);
  assert.equal(got.paymentRequirements.maxAmountRequired, '260000');
  assert.equal(got.paymentPayload.accepted.payTo, CONFIG.payTo);
  assert.equal(got.paymentPayload.accepted.maxAmountRequired, '260000');
  assert.equal(got.x402Version, 2);
});

test('accepted and paymentRequirements cannot diverge — that divergence is a refusal', () => {
  const env = buildEnvelope({ requirements: reqs(), transaction: TX });
  assert.equal(env.paymentPayload.accepted, env.paymentRequirements, 'same object, so they cannot drift');
});

test('requirements carry the amount field the facilitator validates on', () => {
  // Measured against the live facilitator: omitting `amount` is HTTP 400 "amount should
  // not be empty, amount must be a string" — a rejection of the request, not of the
  // payment, and one that no amount of correct signing can survive. Both spellings must
  // be present and must agree, or the server quotes one price and demands another.
  const r = buildRequirements({
    config: { payTo: '0.0.1', feePayer: '0.0.2' },
    price: 350000n,
    resource: 'http://x/q',
  });
  assert.equal(r.amount, '350000');
  assert.equal(r.maxAmountRequired, '350000');
  assert.equal(typeof r.amount, 'string', 'the validator demands a string, not a number');
});
