import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDiscoveryDocument,
  DISCOVERY_PATH,
  REFERENCE_RESOURCE_PATH,
} from '../src/discovery.mjs';
import { handleRequest } from '../src/handler.mjs';
import { priceFor } from '../src/meter.mjs';

const CONFIG = {
  payTo: '0.0.10181166',
  facilitator: { url: 'https://api.testnet.blocky402.com', feePayer: '0.0.7162784' },
};

const TOKEN = {
  tokenId: '0.0.10464963',
  symbol: 'X402T',
  decimals: 2,
  tinybarPerUnit: 1000n,
};

const OFFERS = [
  {
    scheme: 'exact',
    network: 'hedera:testnet',
    amount: '220000',
    maxAmountRequired: '220000',
    asset: 'HBAR',
    payTo: CONFIG.payTo,
    resource: 'http://example.test/query',
    maxTimeoutSeconds: 120,
    extra: { feePayer: CONFIG.facilitator.feePayer },
  },
  {
    scheme: 'exact',
    network: 'hedera:testnet',
    amount: '220',
    maxAmountRequired: '220',
    asset: TOKEN.tokenId,
    payTo: CONFIG.payTo,
    resource: 'http://example.test/query',
    maxTimeoutSeconds: 120,
    extra: { feePayer: CONFIG.facilitator.feePayer },
  },
];

const build = (over = {}) =>
  buildDiscoveryDocument({
    config: CONFIG,
    origin: 'http://example.test',
    offers: OFFERS,
    now: () => new Date('2026-09-12T12:00:00.000Z'),
    ...over,
  });

test('discovery: publishes one item with the conventional shape', () => {
  const doc = build();
  assert.equal(doc.x402Version, 1);
  assert.equal(doc.items.length, 1);
  const item = doc.items[0];
  assert.equal(item.type, 'http');
  assert.equal(item.serviceName, 'Tollgate');
  assert.equal(item.lastUpdated, '2026-09-12T12:00:00.000Z');
  assert.ok(Array.isArray(item.tags) && item.tags.includes('hedera'));
});

test('discovery: the advertised resource is the reference path on the given origin', () => {
  const item = build().items[0];
  assert.equal(item.resource, `http://example.test${REFERENCE_RESOURCE_PATH}`);
});

test('discovery: every configured asset is listed', () => {
  const assets = build().items[0].accepts.map((a) => a.asset);
  assert.deepEqual(assets, ['HBAR', '0.0.10464963']);
});

test('discovery: listed offers carry the fee payer, which a client cannot guess', () => {
  for (const offer of build().items[0].accepts) {
    assert.equal(offer.extra.feePayer, '0.0.7162784');
  }
});

// The honesty property this module exists for. `quality` is facilitator-observed usage;
// a service filling it in is publishing its own reputation.
test('discovery: never self-reports quality, even when the offers carry such a field', () => {
  const poisoned = OFFERS.map((o) => ({
    ...o,
    quality: { l30DaysTotalCalls: 99999, l30DaysUniquePayers: 4242 },
  }));
  const item = buildDiscoveryDocument({
    config: { ...CONFIG, quality: { l30DaysTotalCalls: 1 }, curated: true },
    origin: 'http://example.test',
    offers: poisoned,
  }).items[0];

  assert.ok(!('quality' in item), 'item must not carry a quality block');
  assert.ok(!('curated' in item), 'curation is not a self-assigned property');
  for (const offer of item.accepts) {
    assert.ok(!('quality' in offer), 'offers must not carry quality either');
  }
  assert.ok(!JSON.stringify(item).includes('99999'));
  assert.ok(!JSON.stringify(item).includes('4242'));
});

test('discovery: says plainly that the price is metered, not flat', () => {
  const ext = build().items[0].extensions;
  assert.match(ext.metered.note, /metered/i);
  assert.deepEqual(ext.metered.priceVariesWith, ['records', 'detail']);
});

test('discovery: carries the schedule so an agent can budget any request, not just this one', () => {
  const schedule = { currency: 'tinybar', base: '200000', perRecord: '20000' };
  const ext = build({ config: { ...CONFIG, schedule } }).items[0].extensions;
  assert.deepEqual(ext.metered.schedule, schedule);
});

test('discovery: advertises the receipt trail only when one is configured', () => {
  assert.equal(build().items[0].extensions.receipts, undefined);

  const withReceipts = build({
    config: { ...CONFIG, receipts: { topicId: '0.0.10446488' } },
  }).items[0].extensions.receipts;
  assert.equal(withReceipts.topicId, '0.0.10446488');
  assert.equal(withReceipts.readableBy, 'anyone');
  assert.match(withReceipts.verifyItYourself, /topics\/0\.0\.10446488\/messages/);
});

test('discovery: refuses a relative or malformed origin rather than listing a dead address', () => {
  for (const bad of ['/query', 'example.test', '', 'http://example.test/', null, 'ftp://x.test']) {
    assert.throws(() => build({ origin: bad }), /origin must be an absolute/);
  }
});

test('discovery: refuses to publish a listing with no offers', () => {
  assert.throws(() => build({ offers: [] }), /at least one offer/);
  assert.throws(() => build({ offers: null }), /at least one offer/);
});

// ---------------------------------------------------------------------------
// The crossing tests. A discovery document that quietly disagrees with the 402 is the
// whole failure mode, and it cannot be caught from inside this module's own fixtures.
// ---------------------------------------------------------------------------

const handlerArgs = (url, config) => ({
  method: 'GET',
  url,
  getHeader: () => null,
  config,
  replayGuard: { claim: () => true, release: () => {} },
  serve: async () => ({ ok: true }),
});

test('crossing: the published amount is what the 402 actually charges for that resource', async () => {
  const config = { ...CONFIG, token: TOKEN };

  const disco = await handleRequest(handlerArgs(`http://example.test${DISCOVERY_PATH}`, config));
  const live = await handleRequest(handlerArgs('http://example.test/query', config));

  assert.equal(disco.status, 200);
  assert.equal(live.status, 402);

  const listed = disco.body.items[0];
  // Same resource...
  assert.equal(listed.resource, live.body.accepts[0].resource);
  // ...and the same money, asset for asset, in the order the server offers them.
  assert.deepEqual(
    listed.accepts.map((a) => [a.asset, a.amount]),
    live.body.accepts.map((a) => [a.asset, a.maxAmountRequired]),
  );
});

test('crossing: the published amount equals the meter, not a constant', async () => {
  const disco = await handleRequest(
    handlerArgs(`http://example.test${DISCOVERY_PATH}`, CONFIG),
  );
  const expected = priceFor({ records: 1, detail: 'summary' }).toString();
  assert.equal(disco.body.items[0].accepts[0].amount, expected);
});

test('crossing: discovery follows the host it was reached on', async () => {
  const disco = await handleRequest(
    handlerArgs(`http://144.172.101.164:8404${DISCOVERY_PATH}`, CONFIG),
  );
  assert.equal(disco.body.items[0].resource, 'http://144.172.101.164:8404/query');
});

test('crossing: discovery is free — it never demands payment', async () => {
  const disco = await handleRequest(
    handlerArgs(`http://example.test${DISCOVERY_PATH}`, CONFIG),
  );
  assert.equal(disco.status, 200);
  assert.ok(!('error' in disco.body));
});

test('crossing: the 404 list tells a caller where the discovery document is', async () => {
  const missing = await handleRequest(handlerArgs('http://example.test/nope', CONFIG));
  assert.equal(missing.status, 404);
  assert.ok(missing.body.endpoints.includes(DISCOVERY_PATH));
});
