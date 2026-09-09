import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RECEIPT_SCHEMA,
  MAX_RECEIPT_BYTES,
  ReceiptTooLargeError,
  buildReceipt,
  encodeReceipt,
  receiptsUrl,
  readReceipts,
  emitReceipt,
} from '../src/receipts.mjs';

const facts = {
  transactionId: '0.0.7162784@1789000000.123456789',
  payer: '0.0.10181137',
  payee: '0.0.10181166',
  amount: 350000n,
  resource: 'http://example.test/query?records=3&detail=full',
  at: new Date('2026-09-09T20:00:00.000Z'),
};

test('a receipt carries the sponsor-specified schema tag', () => {
  assert.equal(buildReceipt(facts).schema, 'x402.receipt.v1');
  assert.equal(RECEIPT_SCHEMA, 'x402.receipt.v1');
});

test('records the settlement facts verbatim', () => {
  const r = buildReceipt(facts);
  assert.equal(r.transactionId, facts.transactionId);
  assert.equal(r.payer, '0.0.10181137');
  assert.equal(r.payee, '0.0.10181166');
  assert.equal(r.resource, facts.resource);
  assert.equal(r.currency, 'tinybar');
  assert.equal(r.asset, 'HBAR');
  assert.equal(r.at, '2026-09-09T20:00:00.000Z');
});

// The precision rule. A tinybar amount large enough to lose its low digits through a JSON
// number would turn a receipt into a rounded approximation of what was actually charged.
test('carries the amount as a string, not a JSON number', () => {
  const r = buildReceipt(facts);
  assert.equal(typeof r.amount, 'string');
  assert.equal(r.amount, '350000');
});

test('a large amount survives a JSON round-trip exactly', () => {
  const big = 9007199254740993n; // Number.MAX_SAFE_INTEGER + 2
  const r = buildReceipt({ ...facts, amount: big });
  const back = JSON.parse(JSON.stringify(r));
  assert.equal(back.amount, '9007199254740993');
  assert.notEqual(back.amount, String(Number(big)));
});

test('accepts a plain number amount but still stores it as a string', () => {
  assert.equal(buildReceipt({ ...facts, amount: 240000 }).amount, '240000');
});

test('refuses an amount that is not a whole number of tinybar', () => {
  for (const bad of ['3.5', '-1', '', 'abc', 1.5, null]) {
    assert.throws(() => buildReceipt({ ...facts, amount: bad }), TypeError, `accepted ${bad}`);
  }
});

// An unknown payer is a fact worth recording honestly. Inventing one would make the
// receipt evidence of nothing.
test('records an unknown payer as null rather than guessing', () => {
  assert.equal(buildReceipt({ ...facts, payer: null }).payer, null);
});

test('refuses an empty-string payer instead of treating it as unknown', () => {
  assert.throws(() => buildReceipt({ ...facts, payer: '' }), TypeError);
});

test('refuses to build without the facts that make a receipt meaningful', () => {
  assert.throws(() => buildReceipt({ ...facts, transactionId: '' }), TypeError);
  assert.throws(() => buildReceipt({ ...facts, payee: undefined }), TypeError);
  assert.throws(() => buildReceipt({ ...facts, resource: '' }), TypeError);
});

test('encodes to bytes under the single-message limit', () => {
  const bytes = encodeReceipt(buildReceipt(facts));
  assert.ok(Buffer.isBuffer(bytes));
  assert.ok(bytes.length <= MAX_RECEIPT_BYTES);
  assert.equal(JSON.parse(bytes.toString('utf8')).amount, '350000');
});

// The chunking rule. The SDK would split an oversized message silently, and the fragments
// read back off the mirror as several malformed receipts.
test('refuses an oversized receipt rather than letting it be chunked', () => {
  const huge = buildReceipt({ ...facts, resource: 'http://example.test/' + 'x'.repeat(2000) });
  assert.throws(() => encodeReceipt(huge), ReceiptTooLargeError);
});

test('the oversize error reports the measured size', () => {
  const huge = buildReceipt({ ...facts, resource: 'http://example.test/' + 'x'.repeat(2000) });
  try {
    encodeReceipt(huge);
    assert.fail('expected ReceiptTooLargeError');
  } catch (err) {
    assert.ok(err.bytes > MAX_RECEIPT_BYTES);
    assert.match(err.message, /single-message limit/);
  }
});

test('publishes a mirror URL a stranger can use without us', () => {
  const url = receiptsUrl('0.0.10290826');
  assert.equal(
    url,
    'https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10290826/messages?limit=25&order=desc',
  );
});

test('refuses a topic id that is not a Hedera entity id', () => {
  for (const bad of ['topic-1', '', '0.0', null, 10290826]) {
    assert.throws(() => receiptsUrl(bad), TypeError, `accepted ${bad}`);
  }
});

const mirrorReply = (messages) => async () => ({
  ok: true,
  status: 200,
  json: async () => ({ messages }),
});

const b64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');

test('reads receipts back off the mirror node', async () => {
  const out = await readReceipts('0.0.10290826', {
    fetchImpl: mirrorReply([
      { sequence_number: 2, consensus_timestamp: '1789000001.000000000', message: b64(buildReceipt(facts)) },
    ]),
  });
  assert.equal(out.receipts.length, 1);
  assert.equal(out.receipts[0].amount, '350000');
  assert.equal(out.receipts[0].sequenceNumber, 2);
  assert.equal(out.unparsed.length, 0);
  assert.match(out.verifyItYourself, /mirrornode/);
});

// A public topic is public input. Anyone may write to an open one, so foreign traffic must
// never be crashed on and must never be presented as ours.
test('treats a foreign message as unparsed rather than as our receipt', async () => {
  const out = await readReceipts('0.0.10290826', {
    fetchImpl: mirrorReply([
      { sequence_number: 3, consensus_timestamp: '1789000002.000000000', message: b64({ schema: 'someone.else.v1', amount: '1' }) },
    ]),
  });
  assert.equal(out.receipts.length, 0);
  assert.deepEqual(out.unparsed, [{ sequenceNumber: 3, reason: 'foreign schema' }]);
});

test('survives a message that is not JSON at all', async () => {
  const out = await readReceipts('0.0.10290826', {
    fetchImpl: mirrorReply([
      { sequence_number: 4, consensus_timestamp: '1789000003.000000000', message: Buffer.from('hello there').toString('base64') },
    ]),
  });
  assert.equal(out.receipts.length, 0);
  assert.equal(out.unparsed[0].reason, 'not JSON');
});

test('reports an unreachable mirror node loudly instead of returning zero receipts', async () => {
  await assert.rejects(
    readReceipts('0.0.10290826', { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }),
    /mirror node unreachable/,
  );
});

test('reports a mirror node error status rather than an empty trail', async () => {
  await assert.rejects(
    readReceipts('0.0.10290826', { fetchImpl: async () => ({ ok: false, status: 503 }) }),
    /HTTP 503/,
  );
});

// The request-path rules. Both are properties of emitReceipt itself, not of its callers.
test('emitting never throws into the request path even when submission fails', async () => {
  const seen = [];
  assert.doesNotThrow(() =>
    emitReceipt(buildReceipt(facts), { topicId: null }, { onError: (e) => seen.push(e) }),
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.length, 1);
  assert.match(seen[0].message, /needs topicId/);
});

test('emitting returns synchronously rather than awaiting consensus', () => {
  const started = Date.now();
  emitReceipt(buildReceipt(facts), { topicId: null });
  assert.ok(Date.now() - started < 50);
});

test('an onError handler that itself throws cannot take the process down', async () => {
  assert.doesNotThrow(() =>
    emitReceipt(buildReceipt(facts), { topicId: null }, { onError: () => { throw new Error('bad handler'); } }),
  );
  await new Promise((r) => setImmediate(r));
});

// ── Wiring properties: these are about the service, not the module ──────────────────

import { handleRequest, ReplayGuard } from '../src/handler.mjs';
import { configFromEnv } from '../src/server.mjs';

const baseEnv = { TOLLGATE_PAY_TO: '0.0.10181166', TOLLGATE_FEE_PAYER: '0.0.7162784' };

test('receipts stay off unless a topic is configured', () => {
  assert.equal(configFromEnv({ ...baseEnv }).receipts, null);
});

test('a topic alone gives a keyless read-only trail', () => {
  const c = configFromEnv({ ...baseEnv, TOLLGATE_RECEIPT_TOPIC: '0.0.10446488' });
  assert.equal(c.receipts.topicId, '0.0.10446488');
  assert.equal(c.receipts.operatorKey, null);
});

// A half-configured writer is the dangerous state: it looks enabled and files nothing.
test('refuses an operator id without its key, and the reverse', () => {
  assert.throws(
    () => configFromEnv({ ...baseEnv, TOLLGATE_RECEIPT_TOPIC: '0.0.1', HEDERA_OPERATOR_ID: '0.0.2' }),
    /BOTH/,
  );
  assert.throws(
    () => configFromEnv({ ...baseEnv, TOLLGATE_RECEIPT_TOPIC: '0.0.1', HEDERA_OPERATOR_KEY: 'abc' }),
    /BOTH/,
  );
});

test('refuses an operator with no topic to write to', () => {
  assert.throws(
    () => configFromEnv({ ...baseEnv, HEDERA_OPERATOR_ID: '0.0.2', HEDERA_OPERATOR_KEY: 'abc' }),
    /without TOLLGATE_RECEIPT_TOPIC/,
  );
});

const health = async (config) => {
  const res = await handleRequest({
    method: 'GET',
    url: 'http://x.test/health',
    getHeader: () => undefined,
    config,
    replayGuard: new ReplayGuard(),
    serve: async () => ({}),
  });
  return res.body;
};

// The honesty property. holdsPrivateKey must follow the deployment, not a constant.
test('health reports no private key on a read-only deployment', async () => {
  const body = await health(configFromEnv({ ...baseEnv, TOLLGATE_RECEIPT_TOPIC: '0.0.10446488' }));
  assert.equal(body.holdsPrivateKey, false);
  assert.equal(body.receipts.writeEnabled, false);
});

test('health admits the private key once receipt writing is enabled', async () => {
  const body = await health(
    configFromEnv({
      ...baseEnv,
      TOLLGATE_RECEIPT_TOPIC: '0.0.10446488',
      HEDERA_OPERATOR_ID: '0.0.10181137',
      HEDERA_OPERATOR_KEY: 'deadbeef',
    }),
  );
  assert.equal(body.holdsPrivateKey, true);
  assert.equal(body.receipts.writeEnabled, true);
});

test('the receipts route is unavailable rather than empty when not configured', async () => {
  const res = await handleRequest({
    method: 'GET',
    url: 'http://x.test/receipts',
    getHeader: () => undefined,
    config: configFromEnv({ ...baseEnv }),
    replayGuard: new ReplayGuard(),
    serve: async () => ({}),
  });
  assert.equal(res.status, 404);
  assert.match(res.body.error, /not enabled/);
});

test('an unreadable topic is a 502, never an empty trail', async () => {
  const res = await handleRequest({
    method: 'GET',
    url: 'http://x.test/receipts',
    getHeader: () => undefined,
    config: configFromEnv({ ...baseEnv, TOLLGATE_RECEIPT_TOPIC: '0.0.10446488' }),
    replayGuard: new ReplayGuard(),
    serve: async () => ({}),
    deps: { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } },
  });
  assert.equal(res.status, 502);
  assert.notEqual(res.status, 200);
});

// The property that actually matters, and which a "returns quickly" test does NOT pin:
// the request path must not await the emission. A receipt that never completes must not
// hold a paying buyer's response open.
test('a receipt submission that never settles cannot delay the buyer', async () => {
  let released;
  const forever = new Promise((r) => { released = r; });

  const config = configFromEnv({
    ...baseEnv,
    TOLLGATE_RECEIPT_TOPIC: '0.0.10446488',
    HEDERA_OPERATOR_ID: '0.0.10181137',
    HEDERA_OPERATOR_KEY: 'deadbeef',
  });

  const res = await Promise.race([
    handleRequest({
      method: 'GET',
      url: 'http://x.test/query?records=1',
      getHeader: (n) =>
        n === 'x-payment'
          ? Buffer.from(JSON.stringify({ payload: { transaction: 'AAAA' } })).toString('base64')
          : undefined,
      config,
      replayGuard: new ReplayGuard(),
      serve: async () => ({ ok: true }),
      deps: {
        verify: async () => ({ isValid: true, payer: '0.0.10181137' }),
        settle: async () => ({ success: true, transactionId: '0.0.7@1789000000.1' }),
        emit: () => forever, // never resolves; awaiting this would hang the request
      },
    }),
    new Promise((r) => setTimeout(() => r({ status: 'TIMED_OUT' }), 300)),
  ]);

  released();
  assert.equal(res.status, 200, 'the buyer was served without waiting for the receipt');
});
