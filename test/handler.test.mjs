import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleRequest, ReplayGuard, replayKeyFor } from '../src/handler.mjs';
import { FacilitatorError } from '../src/facilitator.mjs';
import { SCHEDULE } from '../src/meter.mjs';
import { SCHEME } from '../src/challenge.mjs';

const CONFIG = {
  payTo: '0.0.10181166',
  facilitator: { url: 'https://facilitator.example', feePayer: '0.0.7162784' },
};

const TX = 'CgwKAhABEgYIABC…signed-bytes';

/** Build a call with recording stubs, so ordering and arguments are observable. */
function harness({
  url = 'http://svc.example/query?records=3&detail=full',
  method = 'GET',
  payment = null,
  verifyResult = { isValid: true, invalidReason: null, payer: '0.0.999', raw: {} },
  settleResult = { success: true, transactionId: '0.0.7162784@1787.1', errorReason: null, raw: {} },
  verifyThrows = null,
  settleThrows = null,
  replayGuard = new ReplayGuard(),
  served = { rows: ['a'] },
} = {}) {
  const calls = [];
  const deps = {
    verify: async (args) => {
      calls.push({ op: 'verify', args });
      if (verifyThrows) throw verifyThrows;
      return verifyResult;
    },
    settle: async (args) => {
      calls.push({ op: 'settle', args });
      if (settleThrows) throw settleThrows;
      return settleResult;
    },
  };
  const serve = async (request) => {
    calls.push({ op: 'serve', request });
    return served;
  };
  return {
    calls,
    replayGuard,
    run: () =>
      handleRequest({
        method,
        url,
        getHeader: (name) => (name === 'x-payment' && payment !== null ? payment : null),
        config: CONFIG,
        replayGuard,
        serve,
        deps,
      }),
  };
}

function encode(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

const honestPayment = encode({ payload: { transaction: TX } });

// ---------------------------------------------------------------- quoting is free

test('an unpaid request is quoted, not charged', async () => {
  const h = harness();
  const res = await h.run();

  assert.equal(res.status, 402);
  assert.equal(res.body.accepts[0].maxAmountRequired, String(SCHEDULE.base + 3n * (SCHEDULE.perRecord + SCHEDULE.perRecordDetailed)));
  assert.equal(res.body.reason, 'ABSENT');
  assert.deepEqual(h.calls, [], 'quoting must not touch the facilitator');
});

test('the quote names the fee payer, which a buyer cannot guess', async () => {
  const res = await harness().run();
  assert.equal(res.body.accepts[0].extra.feePayer, CONFIG.facilitator.feePayer);
});

test('an empty payment header is a different reason from an absent one', async () => {
  const res = await harness({ payment: '   ' }).run();
  assert.equal(res.status, 402);
  assert.equal(res.body.reason, 'EMPTY');
});

test('the published schedule is free and reproduces the quoted price', async () => {
  const sched = await harness({ url: 'http://svc.example/schedule' }).run();
  assert.equal(sched.status, 200);

  const quote = await harness({ url: 'http://svc.example/query?records=7' }).run();
  const s = sched.body.schedule;
  const expected = BigInt(s.base) + 7n * BigInt(s.perRecord);
  assert.equal(quote.body.accepts[0].maxAmountRequired, expected.toString());
});

test('health states the unusual property plainly', async () => {
  const res = await harness({ url: 'http://svc.example/health' }).run();
  assert.equal(res.status, 200);
  assert.equal(res.body.holdsPrivateKey, false);
});

// ---------------------------------------------------------------- bad input

test('an unpriceable request is refused before any quote is issued', async () => {
  const h = harness({ url: 'http://svc.example/query?records=abc', payment: honestPayment });
  const res = await h.run();

  assert.equal(res.status, 400);
  assert.equal(res.body.param, 'records');
  assert.deepEqual(h.calls, [], 'a request we cannot price must not reach the facilitator');
});

test('a request over the record cap is refused rather than clamped', async () => {
  const res = await harness({ url: `http://svc.example/query?records=${SCHEDULE.maxRecords + 1}` }).run();
  assert.equal(res.status, 400);
});

test('unknown paths and non-GET methods are refused', async () => {
  assert.equal((await harness({ url: 'http://svc.example/admin' }).run()).status, 404);
  assert.equal((await harness({ method: 'POST' }).run()).status, 405);
});

// ------------------------------------------------- the terms are the server's

test('the amount verified is derived from the live request, not from the buyer', async () => {
  // The buyer signs for a cheap request and presents it against an expensive one, and
  // helpfully supplies its own favourable terms in the envelope.
  const attacker = encode({
    payload: { transaction: TX },
    paymentRequirements: { amount: '1', maxAmountRequired: '1', payTo: '0.0.EVIL' },
    accepted: [{ amount: '1' }],
    amount: '1',
    maxAmountRequired: '1',
    payTo: '0.0.EVIL',
  });

  const h = harness({ url: 'http://svc.example/query?records=100&detail=full', payment: attacker });
  await h.run();

  const sent = h.calls.find((c) => c.op === 'verify').args.requirements;
  const expected = SCHEDULE.base + 100n * (SCHEDULE.perRecord + SCHEDULE.perRecordDetailed);

  assert.equal(sent.maxAmountRequired, expected.toString());
  assert.equal(sent.payTo, CONFIG.payTo, 'payee must come from server config');
  assert.equal(sent.extra.feePayer, CONFIG.facilitator.feePayer);
});

test('an attacker envelope cannot reach the requirements through any field', async () => {
  // Stronger than the above: compare a poisoned envelope against an honest one and
  // demand the requirements be byte-identical. This is the assertion that survives a
  // future refactor which "helpfully" starts reading buyer-supplied fields.
  const poisoned = encode({
    payload: { transaction: TX },
    // Every name a future refactor might plausibly reach for, including the ones the
    // facilitator's own wire format uses. An earlier version of this test omitted
    // `paymentRequirements` and therefore survived a mutation that read exactly that
    // field — a broad-sounding test that was not actually broad.
    paymentRequirements: { amount: '1', maxAmountRequired: '1', payTo: '0.0.EVIL' },
    requirements: { amount: '1', payTo: '0.0.EVIL' },
    accepted: [{ amount: '1', payTo: '0.0.EVIL' }],
    amount: '1',
    maxAmountRequired: '1',
    payTo: '0.0.EVIL',
    price: '1',
    resource: 'http://evil.example/free',
    scheme: 'free',
    network: 'mainnet',
    asset: 'FAKE',
    extra: { feePayer: '0.0.EVIL' },
  });

  const a = harness({ payment: honestPayment });
  const b = harness({ payment: poisoned });
  await a.run();
  await b.run();

  assert.deepEqual(
    b.calls.find((c) => c.op === 'verify').args.requirements,
    a.calls.find((c) => c.op === 'verify').args.requirements,
  );
});

test('the amount charged is the amount quoted for that same request', async () => {
  const h = harness({ url: 'http://svc.example/query?records=5', payment: honestPayment });
  const res = await h.run();

  const expected = SCHEDULE.base + 5n * SCHEDULE.perRecord;
  assert.equal(res.status, 200);
  assert.equal(res.body.charged.amount, expected.toString());
  assert.equal(h.calls.find((c) => c.op === 'verify').args.requirements.maxAmountRequired, expected.toString());
});

// -------------------------------------------------- the two halves must agree

test('the network we advertise is the network we verify against', async () => {
  // These were written on different days and tested independently with their own
  // fixtures, so each was internally consistent and the pair was not: the challenge said
  // "hedera-testnet" while the facilitator call said "hedera:testnet". A buyer selecting
  // an offer by network would never have matched. Nothing but a crossing test finds this.
  const h = harness({ payment: honestPayment });
  const quoted = (await harness().run()).body.accepts[0];
  await h.run();
  const verified = h.calls.find((c) => c.op === 'verify').args.requirements;

  assert.equal(quoted.network, verified.network);
  assert.equal(quoted.scheme, verified.scheme);
});

test('the advertised network is the CAIP-2 id the facilitator publishes', () => {
  // Pinned as a literal on purpose. The facilitator's /supported names
  // "hedera:testnet"; if a future edit makes this prettier it should fail here rather
  // than at a buyer's expense.
  assert.equal(SCHEME.network, 'hedera:testnet');
});

test('the payee we advertise is the payee we verify against', async () => {
  const h = harness({ payment: honestPayment });
  const quoted = (await harness().run()).body.accepts[0];
  await h.run();
  const verified = h.calls.find((c) => c.op === 'verify').args.requirements;

  assert.equal(quoted.payTo, verified.payTo);
  assert.equal(quoted.extra.feePayer, verified.extra.feePayer);
});

test('the price we advertise is the price we verify against, for the same request', async () => {
  const url = 'http://svc.example/query?records=11&detail=full';
  const quoted = (await harness({ url }).run()).body.accepts[0];
  const h = harness({ url, payment: honestPayment });
  await h.run();
  const verified = h.calls.find((c) => c.op === 'verify').args.requirements;

  assert.equal(quoted.maxAmountRequired, verified.maxAmountRequired);
});

// ---------------------------------------------------------------- ordering

test('verify happens before settle, and serving happens after both', async () => {
  const h = harness({ payment: honestPayment });
  const res = await h.run();

  assert.equal(res.status, 200);
  assert.deepEqual(h.calls.map((c) => c.op), ['verify', 'settle', 'serve']);
});

test('a rejected payment is never settled and never served', async () => {
  const h = harness({
    payment: honestPayment,
    verifyResult: { isValid: false, invalidReason: 'amount_mismatch', payer: null, raw: {} },
  });
  const res = await h.run();

  assert.equal(res.status, 402);
  assert.equal(res.body.reason, 'amount_mismatch');
  assert.deepEqual(h.calls.map((c) => c.op), ['verify']);
});

test('a refused settlement is never served', async () => {
  const h = harness({
    payment: honestPayment,
    settleResult: { success: false, transactionId: null, errorReason: 'insufficient_balance', raw: {} },
  });
  const res = await h.run();

  assert.equal(res.status, 402);
  assert.equal(res.body.reason, 'insufficient_balance');
  assert.ok(!h.calls.some((c) => c.op === 'serve'));
});

// ---------------------------------------------------------------- replay

test('the same signed transaction buys exactly one response', async () => {
  const guard = new ReplayGuard();
  const first = await harness({ payment: honestPayment, replayGuard: guard }).run();
  const second = harness({ payment: honestPayment, replayGuard: guard });
  const res = await second.run();

  assert.equal(first.status, 200);
  assert.equal(res.status, 409);
  assert.ok(!second.calls.some((c) => c.op === 'settle'), 'a replay must not be settled twice');
});

test('an indeterminate settlement does NOT free the payment for replay', async () => {
  // The heart of it: a settle that timed out may have landed. Releasing the key here
  // would let the same bytes be presented again and charge an honest buyer twice.
  const guard = new ReplayGuard();
  const boom = new FacilitatorError('settle timed out', { reason: 'timeout' });

  const first = await harness({ payment: honestPayment, replayGuard: guard, settleThrows: boom }).run();
  assert.equal(first.status, 502);
  assert.equal(first.body.indeterminate, true);

  const retry = await harness({ payment: honestPayment, replayGuard: guard }).run();
  assert.equal(retry.status, 409, 'indeterminate must not become a second charge');
});

test('a definitively refused settlement DOES free the payment, so an honest buyer can retry', async () => {
  const guard = new ReplayGuard();
  await harness({
    payment: honestPayment,
    replayGuard: guard,
    settleResult: { success: false, transactionId: null, errorReason: 'expired', raw: {} },
  }).run();

  assert.equal(guard.size, 0);
});

test('a rejected verify never claims the key at all', async () => {
  const guard = new ReplayGuard();
  await harness({
    payment: honestPayment,
    replayGuard: guard,
    verifyResult: { isValid: false, invalidReason: 'bad', payer: null, raw: {} },
  }).run();

  assert.equal(guard.size, 0, 'a stranger must not be able to burn a key with junk');
});

test('the replay key is the transaction, not the request', async () => {
  const guard = new ReplayGuard();
  await harness({ url: 'http://svc.example/query?records=1', payment: honestPayment, replayGuard: guard }).run();
  const other = await harness({
    url: 'http://svc.example/query?records=9',
    payment: honestPayment,
    replayGuard: guard,
  }).run();

  assert.equal(other.status, 409, 'same payment, different request, still one purchase');
});

test('distinct payments are independent', async () => {
  const guard = new ReplayGuard();
  const a = await harness({ payment: honestPayment, replayGuard: guard }).run();
  const b = await harness({
    payment: encode({ payload: { transaction: `${TX}-other` } }),
    replayGuard: guard,
  }).run();

  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
});

// ---------------------------------------------------------------- guard itself

test('claim is check-and-insert in one step', () => {
  const guard = new ReplayGuard();
  assert.equal(guard.claim('k'), true);
  assert.equal(guard.claim('k'), false);
});

test('claims expire, so the guard cannot grow without bound', () => {
  const guard = new ReplayGuard({ ttlMs: 1000 });
  const t0 = 1_000_000;
  assert.equal(guard.claim('k', t0), true);
  assert.equal(guard.claim('k', t0 + 500), false);
  assert.equal(guard.claim('k', t0 + 2000), true, 'expired claims are reclaimable');
});

test('the replay key does not store the signed payload verbatim', () => {
  const key = replayKeyFor(TX);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.ok(!key.includes(TX));
  assert.equal(replayKeyFor(TX), key, 'stable for the same bytes');
  assert.notEqual(replayKeyFor(`${TX}x`), key);
});

// ---------------------------------------------------------------- outages

test('an unreachable facilitator is an outage, never a payment rejection', async () => {
  // If this returned 402 the buyer would be told their good payment was bad, and would
  // reasonably pay again.
  const h = harness({
    payment: honestPayment,
    verifyThrows: new FacilitatorError('connect ECONNREFUSED', { reason: 'unreachable' }),
  });
  const res = await h.run();

  assert.equal(res.status, 502);
  assert.equal(res.body.retryable, true);
  assert.notEqual(res.status, 402);
  assert.ok(!h.calls.some((c) => c.op === 'settle'));
});

test('a facilitator 5xx during verify does not consume the payment', async () => {
  const guard = new ReplayGuard();
  await harness({
    payment: honestPayment,
    replayGuard: guard,
    verifyThrows: new FacilitatorError('facilitator /verify returned 500', { reason: 'http_error' }),
  }).run();

  assert.equal(guard.size, 0);
});

test('an indeterminate settlement tells the buyer where to check, and does not serve', async () => {
  const h = harness({
    payment: honestPayment,
    settleThrows: new FacilitatorError('aborted', { reason: 'timeout' }),
  });
  const res = await h.run();

  assert.equal(res.status, 502);
  assert.equal(res.body.indeterminate, true);
  assert.match(res.body.advice, /mirror node/);
  assert.ok(!h.calls.some((c) => c.op === 'serve'));
});

// ---------------------------------------------------------------- served shape

test('a served response reports what was bought and what settled', async () => {
  const res = await harness({ payment: honestPayment }).run();

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.request, { records: 3, detail: 'full' });
  assert.equal(res.body.settlement.transactionId, '0.0.7162784@1787.1');
  assert.equal(res.body.settlement.payer, '0.0.999');
  assert.deepEqual(res.body.data, { rows: ['a'] });
});

test('the x402 response header carries the settlement in machine-readable form', async () => {
  const res = await harness({ payment: honestPayment }).run();
  const decoded = JSON.parse(Buffer.from(res.headers['X-PAYMENT-RESPONSE'], 'base64').toString('utf8'));

  assert.equal(decoded.success, true);
  assert.equal(decoded.transaction, '0.0.7162784@1787.1');
  assert.equal(decoded.network, 'hedera:testnet');
});

test('the buyer is served the units they paid for', async () => {
  const h = harness({ url: 'http://svc.example/query?records=4&detail=summary', payment: honestPayment });
  await h.run();
  assert.deepEqual(h.calls.find((c) => c.op === 'serve').request, { records: 4, detail: 'summary' });
});
