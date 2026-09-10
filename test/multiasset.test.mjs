/**
 * Crossing tests for the two-asset rail.
 *
 * These exist because of a defect class this project has already been bitten by: modules
 * that are individually green and disagree with each other. `hts.mjs` can be perfect and
 * `handler.mjs` can be perfect while the token offer the buyer is shown differs from the
 * requirements the buyer is checked against — and no single-module test can see it.
 *
 * So everything here asserts across a seam: the advertised offer against the verified
 * requirements, the amount charged against the amount recorded, and the choice of asset
 * against the (deliberately nonexistent) influence of the buyer's envelope.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleRequest, ReplayGuard, candidateRequirements } from '../src/handler.mjs';
import { FacilitatorError } from '../src/facilitator.mjs';
import { tokenAmountFor } from '../src/hts.mjs';

const TOKEN = {
  tokenId: '0.0.10464963',
  symbol: 'X402T',
  decimals: 2,
  tinybarPerUnit: 1_000n,
};

const HBAR_ONLY = {
  payTo: '0.0.10181166',
  facilitator: { url: 'https://facilitator.example', feePayer: '0.0.7162784' },
};

const TWO_ASSET = { ...HBAR_ONLY, token: TOKEN };

const TX = 'CgwKAhABEgYIABC…signed-bytes';
const URL_3_FULL = 'http://svc.example/query?records=3&detail=full';

/**
 * @param {object} opts
 * @param {(requirements: object) => object} opts.verdictFor  decide per candidate, so a
 *   payment can be valid for exactly one asset — which is what a real payment is.
 */
function harness({
  config = TWO_ASSET,
  url = URL_3_FULL,
  payment = null,
  verdictFor = () => ({ isValid: true, invalidReason: null, payer: '0.0.10319277', raw: {} }),
  verifyThrows = null,
  emitted = [],
} = {}) {
  const calls = [];
  const deps = {
    verify: async (args) => {
      calls.push({ op: 'verify', asset: args.requirements.asset, amount: args.requirements.amount });
      if (verifyThrows) throw verifyThrows;
      return verdictFor(args.requirements);
    },
    settle: async (args) => {
      calls.push({ op: 'settle', asset: args.requirements.asset, amount: args.requirements.amount });
      return { success: true, transactionId: '0.0.7162784@1789.1', errorReason: null, raw: {} };
    },
    emit: (receipt) => {
      emitted.push(receipt);
    },
  };
  return {
    calls,
    emitted,
    run: () =>
      handleRequest({
        method: 'GET',
        url,
        getHeader: (n) => (n === 'x-payment' && payment !== null ? payment : null),
        config,
        replayGuard: new ReplayGuard(),
        serve: async () => ({ rows: ['a'] }),
        deps,
      }),
  };
}

const paymentHeader = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');

// ---------------------------------------------------------------------------
// the challenge advertises exactly what the verifier will demand
// ---------------------------------------------------------------------------

test('with a token configured the 402 advertises two offers, HBAR first', async () => {
  const res = await harness().run();
  assert.equal(res.status, 402);
  assert.equal(res.body.accepts.length, 2);
  assert.equal(res.body.accepts[0].asset, 'HBAR');
  assert.equal(res.body.accepts[1].asset, TOKEN.tokenId);
});

test('the advertised token amount equals the requirement the verifier uses', async () => {
  const res = await harness().run();
  const advertised = res.body.accepts[1].maxAmountRequired;

  const reqs = candidateRequirements({
    config: TWO_ASSET,
    price: 350_000n,
    resource: URL_3_FULL,
  });
  const tokenReq = reqs.find((r) => r.asset === TOKEN.tokenId);
  // The seam: what the buyer is shown, and what the buyer is judged against.
  assert.equal(advertised, tokenReq.maxAmountRequired);
  assert.equal(advertised, '350');
});

test('the advertised HBAR amount also equals its requirement', async () => {
  const res = await harness().run();
  const reqs = candidateRequirements({ config: TWO_ASSET, price: 350_000n, resource: URL_3_FULL });
  const hbar = reqs.find((r) => r.asset === '0.0.0');
  assert.equal(res.body.accepts[0].maxAmountRequired, hbar.maxAmountRequired);
  assert.equal(hbar.amount, hbar.maxAmountRequired);
});

test('without a token the 402 is unchanged — one offer, no token schedule', async () => {
  const res = await harness({ config: HBAR_ONLY }).run();
  assert.equal(res.status, 402);
  assert.equal(res.body.accepts.length, 1);
  assert.equal(res.body.accepts[0].asset, 'HBAR');
  assert.equal(res.body.tokenSchedule, undefined);
});

test('the published token schedule reproduces the advertised token amount', async () => {
  const res = await harness().run();
  const s = res.body.tokenSchedule;
  const price = 350_000n;
  const reproduced = (price + BigInt(s.tinybarPerUnit) - 1n) / BigInt(s.tinybarPerUnit);
  assert.equal(String(reproduced), res.body.accepts[1].maxAmountRequired);
});

test('both offers quote the same request across the whole schedule', async () => {
  for (const [qs, tinybar] of [
    ['records=1', 220_000n],
    ['records=5&detail=full', 450_000n],
    ['records=100', 2_200_000n],
  ]) {
    const res = await harness({ url: `http://svc.example/query?${qs}` }).run();
    assert.equal(res.body.accepts[0].maxAmountRequired, tinybar.toString());
    assert.equal(
      res.body.accepts[1].maxAmountRequired,
      tokenAmountFor(tinybar, TOKEN.tinybarPerUnit).toString(),
    );
  }
});

// ---------------------------------------------------------------------------
// candidate order is ours, and the buyer cannot reach it
// ---------------------------------------------------------------------------

test('candidates are HBAR then token, and every field is server-authored', () => {
  const reqs = candidateRequirements({ config: TWO_ASSET, price: 240_000n, resource: 'http://x/q' });
  assert.equal(reqs.length, 2);
  assert.equal(reqs[0].asset, '0.0.0');
  assert.equal(reqs[1].asset, TOKEN.tokenId);
  for (const r of reqs) {
    assert.equal(r.payTo, TWO_ASSET.payTo);
    assert.equal(r.extra.feePayer, TWO_ASSET.facilitator.feePayer);
    assert.equal(r.resource, 'http://x/q');
    assert.equal(r.scheme, 'exact');
    assert.equal(r.network, 'hedera:testnet');
  }
});

test('one candidate when no token is configured', () => {
  const reqs = candidateRequirements({ config: HBAR_ONLY, price: 240_000n, resource: 'http://x/q' });
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].asset, '0.0.0');
});

test('an attacker-declared asset and amount cannot change the candidates checked', async () => {
  const h = harness({
    payment: paymentHeader({
      payload: { transaction: TX },
      // Everything an attacker might hope influences the check:
      asset: TOKEN.tokenId,
      amount: '1',
      maxAmountRequired: '1',
      accepted: { scheme: 'exact', network: 'hedera:testnet', asset: TOKEN.tokenId, amount: '1' },
      paymentRequirements: { payTo: '0.0.666', asset: TOKEN.tokenId, amount: '1' },
    }),
    // Refuse everything, so the run enumerates every candidate and we see all of them.
    verdictFor: () => ({ isValid: false, invalidReason: 'nope', payer: null, raw: {} }),
  });
  await h.run();
  const verifies = h.calls.filter((c) => c.op === 'verify');
  assert.equal(verifies.length, 2);
  // Amounts are the metered ones, not the attacker's "1".
  assert.deepEqual(
    verifies.map((v) => `${v.asset}:${v.amount}`),
    ['0.0.0:350000', `${TOKEN.tokenId}:350`],
  );
});

// ---------------------------------------------------------------------------
// a payment valid for the token only — served, charged and recorded in the token
// ---------------------------------------------------------------------------

test('a token payment is served even though the HBAR candidate is checked first', async () => {
  const h = harness({
    payment: paymentHeader({ payload: { transaction: TX } }),
    verdictFor: (r) =>
      r.asset === TOKEN.tokenId
        ? { isValid: true, invalidReason: null, payer: '0.0.10319277', raw: {} }
        : { isValid: false, invalidReason: 'asset_mismatch', payer: null, raw: {} },
  });
  const res = await h.run();
  assert.equal(res.status, 200);

  // Settlement happened against the TOKEN requirements, not the HBAR ones it tried first.
  const settle = h.calls.find((c) => c.op === 'settle');
  assert.equal(settle.asset, TOKEN.tokenId);
  assert.equal(settle.amount, '350');
});

test('the served response names the token it was actually paid in', async () => {
  const res = await harness({
    payment: paymentHeader({ payload: { transaction: TX } }),
    verdictFor: (r) =>
      r.asset === TOKEN.tokenId
        ? { isValid: true, invalidReason: null, payer: '0.0.10319277', raw: {} }
        : { isValid: false, invalidReason: 'asset_mismatch', payer: null, raw: {} },
  }).run();

  assert.equal(res.body.charged.asset, TOKEN.tokenId);
  assert.equal(res.body.charged.amount, '350');
  assert.equal(res.body.charged.currency, 'token-unit');
  assert.equal(res.body.charged.decimals, 2);
  // The tinybar price is still reported, so a reader can check the conversion themselves.
  assert.equal(res.body.charged.meteredPriceTinybar, '350000');
});

test('the receipt records the token amount and asset, never the tinybar price', async () => {
  const emitted = [];
  await harness({
    config: {
      ...TWO_ASSET,
      receipts: { topicId: '0.0.10446488', operatorId: '0.0.10181137', operatorKey: 'ab'.repeat(32) },
    },
    payment: paymentHeader({ payload: { transaction: TX } }),
    verdictFor: (r) =>
      r.asset === TOKEN.tokenId
        ? { isValid: true, invalidReason: null, payer: '0.0.10319277', raw: {} }
        : { isValid: false, invalidReason: 'asset_mismatch', payer: null, raw: {} },
    emitted,
  }).run();

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].asset, TOKEN.tokenId);
  assert.equal(emitted[0].amount, '350');
  assert.equal(emitted[0].currency, 'token-unit');
  // 350000 would be the tinybar price — a false entry in a record meant to be trusted.
  assert.notEqual(emitted[0].amount, '350000');
});

test('an HBAR payment still records HBAR and tinybar with a token configured', async () => {
  const emitted = [];
  const res = await harness({
    config: {
      ...TWO_ASSET,
      receipts: { topicId: '0.0.10446488', operatorId: '0.0.10181137', operatorKey: 'ab'.repeat(32) },
    },
    payment: paymentHeader({ payload: { transaction: TX } }),
    emitted,
  }).run();

  assert.equal(res.status, 200);
  assert.equal(res.body.charged.asset, 'HBAR');
  assert.equal(res.body.charged.currency, 'tinybar');
  assert.equal(res.body.charged.amount, '350000');
  assert.equal(emitted[0].asset, 'HBAR');
  assert.equal(emitted[0].currency, 'tinybar');
  assert.equal(emitted[0].amount, '350000');
});

test('an HBAR payment costs exactly one verify — the token is never consulted', async () => {
  const h = harness({ payment: paymentHeader({ payload: { transaction: TX } }) });
  await h.run();
  assert.equal(h.calls.filter((c) => c.op === 'verify').length, 1);
});

// ---------------------------------------------------------------------------
// a payment valid for neither, and an outage that must not be masked
// ---------------------------------------------------------------------------

test('a payment valid for neither asset is refused with both offers re-advertised', async () => {
  const res = await harness({
    payment: paymentHeader({ payload: { transaction: TX } }),
    verdictFor: () => ({ isValid: false, invalidReason: 'amount_mismatch', payer: null, raw: {} }),
  }).run();
  assert.equal(res.status, 402);
  assert.equal(res.body.error, 'payment rejected');
  assert.equal(res.body.accepts.length, 2);
});

test('a facilitator outage aborts rather than silently trying the other asset', async () => {
  // The temptation is "verify failed, try the token" — which would turn an outage into a
  // payment rejection and tell a buyer their good payment was bad.
  const h = harness({
    payment: paymentHeader({ payload: { transaction: TX } }),
    verifyThrows: new FacilitatorError('upstream 503', { reason: 'unreachable' }),
  });
  const res = await h.run();
  assert.equal(res.status, 502);
  assert.equal(res.body.retryable, true);
  assert.equal(h.calls.filter((c) => c.op === 'verify').length, 1);
  assert.equal(h.calls.filter((c) => c.op === 'settle').length, 0);
});

test('a nonsense request is still refused before any asset is quoted', async () => {
  const res = await harness({ url: 'http://svc.example/query?records=abc' }).run();
  assert.equal(res.status, 400);
  assert.equal(res.body.accepts, undefined);
});
