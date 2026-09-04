import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCHEDULE,
  InvalidRequestError,
  parseRequest,
  priceFor,
  meter,
  publishedSchedule,
} from '../src/meter.mjs';

const q = (s) => new URLSearchParams(s);

test('an empty request is one summary record', () => {
  assert.deepEqual(parseRequest(q('')), { records: 1, detail: 'summary' });
});

test('prices the arithmetic it publishes', () => {
  assert.equal(priceFor({ records: 1, detail: 'summary' }), 220_000n);
  assert.equal(priceFor({ records: 3, detail: 'summary' }), 260_000n);
  assert.equal(priceFor({ records: 3, detail: 'full' }), 350_000n);
  assert.equal(priceFor({ records: 100, detail: 'full' }), 5_200_000n);
});

test('the published schedule reproduces the served price', () => {
  // An agent that cannot recompute our quote has to pay to discover the price.
  const s = publishedSchedule();
  for (const records of [1, 7, 42, 100]) {
    for (const detail of ['summary', 'full']) {
      const fromSchedule =
        BigInt(s.base) +
        BigInt(records) *
          (BigInt(s.perRecord) + (detail === 'full' ? BigInt(s.perRecordDetailSurcharge) : 0n));
      assert.equal(fromSchedule, priceFor({ records, detail }), `${records}/${detail}`);
    }
  }
});

test('quote and charge cannot diverge — they are the same call', () => {
  const params = q('records=5&detail=full');
  const quoted = meter(params).price;
  const charged = priceFor(parseRequest(params));
  assert.equal(quoted, charged);
});

test('the smallest billable request still clears the settlement fee', () => {
  const floor = priceFor({ records: 1, detail: 'summary' });
  assert.ok(
    floor > SCHEDULE.measuredSettlementFee,
    `floor ${floor} must exceed measured settlement fee ${SCHEDULE.measuredSettlementFee}`,
  );
  // and with real headroom, not by a hair
  assert.ok(floor > SCHEDULE.measuredSettlementFee * 3n / 2n);
});

test('price rises strictly with work', () => {
  let previous = 0n;
  for (let records = 1; records <= SCHEDULE.maxRecords; records++) {
    const price = priceFor({ records, detail: 'summary' });
    assert.ok(price > previous, `records=${records} must cost more than records=${records - 1}`);
    previous = price;
    assert.ok(
      priceFor({ records, detail: 'full' }) > price,
      `full detail must cost more than summary at records=${records}`,
    );
  }
});

test('refuses junk record counts instead of defaulting to 1', () => {
  // A silent default bills someone for a request they never made.
  for (const bad of ['abc', '3.5', '1e3', '-1', '', ' 3', '0x10', '١٢']) {
    assert.throws(
      () => parseRequest(q(`records=${encodeURIComponent(bad)}`)),
      InvalidRequestError,
      `should have refused records=${bad}`,
    );
  }
});

test('refuses out-of-range record counts by name', () => {
  assert.throws(() => parseRequest(q('records=0')), (err) => {
    assert.ok(err instanceof InvalidRequestError);
    assert.equal(err.param, 'records');
    return true;
  });
  assert.throws(() => parseRequest(q(`records=${SCHEDULE.maxRecords + 1}`)), InvalidRequestError);
});

test('refuses an unknown detail level', () => {
  assert.throws(() => parseRequest(q('detail=verbose')), (err) => {
    assert.ok(err instanceof InvalidRequestError);
    assert.equal(err.param, 'detail');
    return true;
  });
});

test('priceFor will not price a request that never went through the parser', () => {
  // Defence in depth: the parser is the front door, but nothing may bypass validation
  // and reach the money.
  assert.throws(() => priceFor({ records: 0, detail: 'summary' }), InvalidRequestError);
  assert.throws(() => priceFor({ records: 1.5, detail: 'summary' }), InvalidRequestError);
  assert.throws(() => priceFor({ records: 101, detail: 'summary' }), InvalidRequestError);
  assert.throws(() => priceFor({ records: 1, detail: 'full ' }), InvalidRequestError);
});

test('the schedule is immutable at runtime', () => {
  assert.throws(() => {
    SCHEDULE.base = 1n;
  }, TypeError);
});
