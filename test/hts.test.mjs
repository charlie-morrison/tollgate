import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  tokenAmountFor,
  assertTokenUsable,
  assertBuyerNotFeeExempt,
  buildTokenOffer,
  tokenSchedule,
  tokenFromEnv,
  TokenUnusableError,
  DEFAULT_TINYBAR_PER_UNIT,
} from '../src/hts.mjs';

import { priceFor, parseRequest } from '../src/meter.mjs';
import { buildChallenge } from '../src/challenge.mjs';

const TOKEN = {
  tokenId: '0.0.123456',
  symbol: 'X402C',
  decimals: 2,
  tinybarPerUnit: 1_000n,
};

const CONFIG = {
  payTo: '0.0.10181166',
  facilitator: { feePayer: '0.0.7162784', url: 'https://api.testnet.blocky402.com' },
};

/** A token shaped the way an exact-scheme payment needs: EXCLUSIVE fractional fee. */
function usableTokenInfo(overrides = {}) {
  return {
    token_id: '0.0.123456',
    deleted: false,
    pause_status: 'NOT_APPLICABLE',
    treasury_account_id: '0.0.10181137',
    custom_fees: {
      fractional_fees: [
        {
          collector_account_id: '0.0.10319196',
          net_of_transfers: true,
          amount: { numerator: 2, denominator: 100 },
        },
      ],
      royalty_fees: [],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// conversion — the token must not become a second pricing authority
// ---------------------------------------------------------------------------

test('token amount is a pure function of the metered tinybar price', () => {
  const price = priceFor(parseRequest(new URLSearchParams('records=3&detail=full')));
  assert.equal(price, 350_000n);
  assert.equal(tokenAmountFor(price, TOKEN.tinybarPerUnit), 350n);
});

test('the same tinybar price always yields the same token amount', () => {
  const a = tokenAmountFor(240_000n, 1_000n);
  const b = tokenAmountFor(240_000n, 1_000n);
  assert.equal(a, b);
  assert.equal(a, 240n);
});

test('conversion rounds UP so choosing the token can never underpay the seller', () => {
  // 200_001 tinybar at 1000/unit is 200.001 units; a floor would charge 200.
  assert.equal(tokenAmountFor(200_001n, 1_000n), 201n);
  assert.equal(tokenAmountFor(200_999n, 1_000n), 201n);
  assert.equal(tokenAmountFor(201_000n, 1_000n), 201n);
});

test('conversion is exact when the price divides evenly', () => {
  assert.equal(tokenAmountFor(1_000n, 1_000n), 1n);
  assert.equal(tokenAmountFor(1_000_000n, 1_000n), 1_000n);
});

test('every positive price buys at least one whole unit — never zero, never free work', () => {
  // This is why tokenAmountFor carries no "rounded to zero" branch: the ceiling makes
  // that state unreachable. Pinned across the extremes rather than asserted in prose.
  for (const rate of [1n, 10n, 1_000n, 10n ** 9n]) {
    for (const p of [1n, 9n, 999n, 200_000n, 5_200_000n]) {
      assert.ok(tokenAmountFor(p, rate) >= 1n, `price ${p} at rate ${rate}`);
    }
  }
});

test('money is never a float or a Number', () => {
  assert.throws(() => tokenAmountFor(350000, 1_000n), TypeError);
  assert.throws(() => tokenAmountFor(350_000n, 1000), TypeError);
  assert.throws(() => tokenAmountFor(3.5, 1_000n), TypeError);
});

test('non-positive prices and rates are refused', () => {
  assert.throws(() => tokenAmountFor(0n, 1_000n), RangeError);
  assert.throws(() => tokenAmountFor(-1n, 1_000n), RangeError);
  assert.throws(() => tokenAmountFor(350_000n, 0n), RangeError);
  assert.throws(() => tokenAmountFor(350_000n, -5n), RangeError);
});

test('the default rate is an integer bigint', () => {
  assert.equal(typeof DEFAULT_TINYBAR_PER_UNIT, 'bigint');
  assert.ok(DEFAULT_TINYBAR_PER_UNIT > 0n);
});

// ---------------------------------------------------------------------------
// trap 1 — an INCLUSIVE fractional fee makes exact-scheme settlement impossible
// ---------------------------------------------------------------------------

test('a token with an EXCLUSIVE fractional fee is usable', () => {
  assert.equal(assertTokenUsable(usableTokenInfo()), true);
});

test('an INCLUSIVE fractional fee is refused by name, not discovered at settlement', () => {
  const info = usableTokenInfo();
  info.custom_fees.fractional_fees[0].net_of_transfers = false;
  assert.throws(
    () => assertTokenUsable(info),
    (e) => e instanceof TokenUnusableError && e.reason === 'INCLUSIVE_FRACTIONAL_FEE',
  );
});

test('a missing net_of_transfers flag is treated as INCLUSIVE, not as absent', () => {
  const info = usableTokenInfo();
  delete info.custom_fees.fractional_fees[0].net_of_transfers;
  assert.throws(
    () => assertTokenUsable(info),
    (e) => e.reason === 'INCLUSIVE_FRACTIONAL_FEE',
  );
});

test('one INCLUSIVE fee among several EXCLUSIVE ones still refuses the token', () => {
  const info = usableTokenInfo();
  info.custom_fees.fractional_fees.push({
    collector_account_id: '0.0.999',
    net_of_transfers: false,
    amount: { numerator: 1, denominator: 100 },
  });
  assert.throws(() => assertTokenUsable(info), (e) => e.reason === 'INCLUSIVE_FRACTIONAL_FEE');
});

test('a token with no custom fees at all is usable', () => {
  const info = usableTokenInfo({ custom_fees: { fractional_fees: [], royalty_fees: [] } });
  assert.equal(assertTokenUsable(info), true);
});

test('deleted, paused and royalty-bearing tokens are each refused with their own reason', () => {
  assert.throws(
    () => assertTokenUsable(usableTokenInfo({ deleted: true })),
    (e) => e.reason === 'TOKEN_DELETED',
  );
  assert.throws(
    () => assertTokenUsable(usableTokenInfo({ pause_status: 'PAUSED' })),
    (e) => e.reason === 'TOKEN_PAUSED',
  );
  const royal = usableTokenInfo();
  royal.custom_fees.royalty_fees = [{ collector_account_id: '0.0.1' }];
  assert.throws(() => assertTokenUsable(royal), (e) => e.reason === 'ROYALTY_FEE');
});

test('absent token info is an error, never an implicit pass', () => {
  assert.throws(() => assertTokenUsable(null), (e) => e.reason === 'MISSING_TOKEN_INFO');
  assert.throws(() => assertTokenUsable(undefined), (e) => e.reason === 'MISSING_TOKEN_INFO');
});

// ---------------------------------------------------------------------------
// trap 2 — the treasury is exempt from its own token's fees
// ---------------------------------------------------------------------------

test('an ordinary buyer is accepted', () => {
  assert.equal(assertBuyerNotFeeExempt('0.0.10319277', usableTokenInfo()), true);
});

test('the treasury is refused as buyer: its settlement would show the fee not firing', () => {
  assert.throws(
    () => assertBuyerNotFeeExempt('0.0.10181137', usableTokenInfo()),
    (e) => e instanceof TokenUnusableError && e.reason === 'BUYER_FEE_EXEMPT',
  );
});

test('a fee collector is refused as buyer for the same reason', () => {
  assert.throws(
    () => assertBuyerNotFeeExempt('0.0.10319196', usableTokenInfo()),
    (e) => e.reason === 'BUYER_FEE_EXEMPT',
  );
});

test('a missing buyer is an error rather than a pass', () => {
  assert.throws(() => assertBuyerNotFeeExempt('', usableTokenInfo()), (e) => e.reason === 'MISSING_BUYER');
  assert.throws(() => assertBuyerNotFeeExempt(null, usableTokenInfo()), (e) => e.reason === 'MISSING_BUYER');
});

// ---------------------------------------------------------------------------
// the offer — it may differ from the HBAR offer in asset and amount, nothing else
// ---------------------------------------------------------------------------

test('the token offer shares every term with the HBAR offer except asset and amount', () => {
  const price = 350_000n;
  const challenge = buildChallenge({
    config: CONFIG,
    price,
    resource: 'http://example.test/query',
    schedule: {},
  });
  const base = challenge.accepts[0];
  const offer = buildTokenOffer({ base, token: TOKEN, price });

  assert.equal(offer.scheme, base.scheme);
  assert.equal(offer.network, base.network);
  assert.equal(offer.payTo, base.payTo);
  assert.equal(offer.resource, base.resource);
  assert.equal(offer.maxTimeoutSeconds, base.maxTimeoutSeconds);
  assert.equal(offer.extra.feePayer, base.extra.feePayer);

  assert.equal(base.asset, 'HBAR');
  assert.equal(offer.asset, TOKEN.tokenId);
  assert.equal(offer.maxAmountRequired, '350');
  assert.equal(base.maxAmountRequired, '350000');
});

test('the token offer carries decimals, which a buyer cannot infer from the amount', () => {
  const offer = buildTokenOffer({
    base: buildChallenge({
      config: CONFIG,
      price: 200_000n,
      resource: 'http://example.test/q',
      schedule: {},
    }).accepts[0],
    token: TOKEN,
    price: 200_000n,
  });
  assert.equal(offer.extra.tokenDecimals, 2);
});

test('both offers quote the SAME request, so their amounts track one price', () => {
  for (const qs of ['records=1', 'records=5&detail=full', 'records=100']) {
    const price = priceFor(parseRequest(new URLSearchParams(qs)));
    const base = buildChallenge({
      config: CONFIG,
      price,
      resource: 'http://example.test/q',
      schedule: {},
    }).accepts[0];
    const offer = buildTokenOffer({ base, token: TOKEN, price });
    assert.equal(BigInt(offer.maxAmountRequired), tokenAmountFor(price, TOKEN.tinybarPerUnit));
    // and the token can never be the cheaper rail in tinybar terms
    assert.ok(BigInt(offer.maxAmountRequired) * TOKEN.tinybarPerUnit >= price);
  }
});

test('an invalid token config is refused rather than defaulted', () => {
  const base = buildChallenge({
    config: CONFIG,
    price: 200_000n,
    resource: 'http://example.test/q',
    schedule: {},
  }).accepts[0];
  assert.throws(() => buildTokenOffer({ base, token: { ...TOKEN, tokenId: 'X402C' }, price: 1n }), TypeError);
  assert.throws(() => buildTokenOffer({ base, token: { ...TOKEN, decimals: -1 }, price: 1n }), TypeError);
  assert.throws(
    () => buildTokenOffer({ base, token: { ...TOKEN, tinybarPerUnit: 1000 }, price: 1n }),
    TypeError,
  );
  assert.throws(() => buildTokenOffer({ base: null, token: TOKEN, price: 1n }), TypeError);
});

// ---------------------------------------------------------------------------
// published schedule — an agent must be able to budget in the token
// ---------------------------------------------------------------------------

test('the published token schedule reproduces the served amount', () => {
  const s = tokenSchedule(TOKEN);
  const price = priceFor(parseRequest(new URLSearchParams('records=2&detail=full')));
  const reproduced =
    (price + BigInt(s.tinybarPerUnit) - 1n) / BigInt(s.tinybarPerUnit);
  assert.equal(reproduced, tokenAmountFor(price, TOKEN.tinybarPerUnit));
  assert.equal(s.tokenId, TOKEN.tokenId);
  assert.equal(s.decimals, 2);
});

test('the schedule states amounts as strings; JSON numbers lose large values', () => {
  const s = tokenSchedule(TOKEN);
  assert.equal(typeof s.tinybarPerUnit, 'string');
});

// ---------------------------------------------------------------------------
// config — the token rail is optional, but never half-enabled
// ---------------------------------------------------------------------------

test('no token id means no token rail, and that is not an error', () => {
  assert.equal(tokenFromEnv({}), null);
});

test('a token id with a missing symbol or decimals is refused, not guessed', () => {
  assert.throws(
    () => tokenFromEnv({ TOLLGATE_TOKEN_ID: '0.0.1', TOLLGATE_TOKEN_DECIMALS: '2' }),
    (e) => e.reason === 'INCOMPLETE_TOKEN_CONFIG',
  );
  assert.throws(
    () => tokenFromEnv({ TOLLGATE_TOKEN_ID: '0.0.1', TOLLGATE_TOKEN_SYMBOL: 'X' }),
    (e) => e.reason === 'INCOMPLETE_TOKEN_CONFIG',
  );
  assert.throws(
    () =>
      tokenFromEnv({
        TOLLGATE_TOKEN_ID: '0.0.1',
        TOLLGATE_TOKEN_SYMBOL: 'X',
        TOLLGATE_TOKEN_DECIMALS: 'two',
      }),
    (e) => e.reason === 'INCOMPLETE_TOKEN_CONFIG',
  );
});

test('a non-numeric rate is refused rather than silently falling back', () => {
  assert.throws(
    () =>
      tokenFromEnv({
        TOLLGATE_TOKEN_ID: '0.0.1',
        TOLLGATE_TOKEN_SYMBOL: 'X',
        TOLLGATE_TOKEN_DECIMALS: '2',
        TOLLGATE_TINYBAR_PER_UNIT: '1_000',
      }),
    (e) => e.reason === 'INCOMPLETE_TOKEN_CONFIG',
  );
});

test('a complete token config is read exactly as given', () => {
  const t = tokenFromEnv({
    TOLLGATE_TOKEN_ID: '0.0.10319197',
    TOLLGATE_TOKEN_SYMBOL: 'X402C',
    TOLLGATE_TOKEN_DECIMALS: '2',
    TOLLGATE_TINYBAR_PER_UNIT: '1000',
  });
  assert.deepEqual(t, {
    tokenId: '0.0.10319197',
    symbol: 'X402C',
    decimals: 2,
    tinybarPerUnit: 1_000n,
  });
});

test('an omitted rate uses the published default rather than zero', () => {
  const t = tokenFromEnv({
    TOLLGATE_TOKEN_ID: '0.0.1',
    TOLLGATE_TOKEN_SYMBOL: 'X',
    TOLLGATE_TOKEN_DECIMALS: '0',
  });
  assert.equal(t.tinybarPerUnit, DEFAULT_TINYBAR_PER_UNIT);
});

// ---------------------------------------------------------------------------
// crossing test — the guards run against the REAL mirror-node shape, not only
// against a fixture I invented. Captured live from token 0.0.10464963.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

const LIVE = JSON.parse(
  readFileSync(new URL('./fixtures-token-live.json', import.meta.url), 'utf8'),
);

test('the real mirror response for our token passes the usability guard', () => {
  assert.equal(assertTokenUsable(LIVE), true);
});

test('the real response omits royalty_fees entirely, and that is not a failure', () => {
  // Worth pinning: the shape I wrote by hand had `royalty_fees: []`, the live API has no
  // such key at all. A guard written against the invented shape would read undefined.
  assert.equal('royalty_fees' in LIVE.custom_fees, false);
  assert.equal(assertTokenUsable(LIVE), true);
});

test('the real fee is EXCLUSIVE, which is what makes exact-scheme settlement possible', () => {
  assert.equal(LIVE.custom_fees.fractional_fees[0].net_of_transfers, true);
  assert.equal(LIVE.custom_fees.fractional_fees[0].amount.numerator, 2);
  assert.equal(LIVE.custom_fees.fractional_fees[0].amount.denominator, 100);
});

test('fixed_fees are present on the live token and do NOT disqualify it', () => {
  assert.ok(Array.isArray(LIVE.custom_fees.fixed_fees));
  assert.equal(assertTokenUsable({ ...LIVE, custom_fees: { ...LIVE.custom_fees, fixed_fees: [{ amount: 1 }] } }), true);
});

test('the live treasury and collector are both refused as buyers', () => {
  assert.throws(
    () => assertBuyerNotFeeExempt(LIVE.treasury_account_id, LIVE),
    (e) => e.reason === 'BUYER_FEE_EXEMPT',
  );
  assert.throws(
    () => assertBuyerNotFeeExempt(LIVE.custom_fees.fractional_fees[0].collector_account_id, LIVE),
    (e) => e.reason === 'BUYER_FEE_EXEMPT',
  );
});

test('the live token id and decimals match the configuration we serve', () => {
  const t = tokenFromEnv({
    TOLLGATE_TOKEN_ID: LIVE.token_id,
    TOLLGATE_TOKEN_SYMBOL: LIVE.symbol,
    TOLLGATE_TOKEN_DECIMALS: String(LIVE.decimals),
    TOLLGATE_TINYBAR_PER_UNIT: '1000',
  });
  assert.equal(t.tokenId, LIVE.token_id);
  assert.equal(t.symbol, 'X402T');

  // The mirror node returns `decimals` as a STRING while our config holds a Number.
  // Worth a test rather than a silent coercion: comparing them with === is false, so
  // anything that validates config against the chain has to convert first or it will
  // report a mismatch on a token that is perfectly correct.
  assert.equal(typeof LIVE.decimals, 'string');
  assert.equal(typeof t.decimals, 'number');
  assert.equal(t.decimals, Number(LIVE.decimals));
});
