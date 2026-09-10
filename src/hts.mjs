/**
 * Paying in an HTS token instead of HBAR — without acquiring a second pricing authority.
 *
 * The gateway advertises the SAME metered request in either HBAR or a token and lets the
 * buyer choose. The temptation is to give the token its own price list. That would be a
 * second authority and it would drift from the first (DESIGN.md rule 1), so the token
 * amount here is a *pure function* of the tinybar price the meter already produced. There
 * is still exactly one number that decides what a request costs.
 *
 * Two properties of Hedera custom fees make this harder than a unit conversion, and both
 * were measured on-chain rather than read off a docs page:
 *
 *   1. A fractional custom fee must be EXCLUSIVE (`net_of_transfers: true`). The x402
 *      scheme is `exact`: the facilitator checks the payee was credited exactly
 *      `maxAmountRequired`. An INCLUSIVE fee is taken *out of* the transfer, so the payee
 *      lands short by the fee on every single settlement and every payment is rejected as
 *      underpaid. The token is unusable and the error blames the buyer.
 *
 *   2. The treasury is exempt from its own token's custom fees. A demo funded from the
 *      treasury therefore shows the fee *not* firing, and quietly proves the opposite of
 *      what it claims. So a buyer that is the treasury is refused here by name.
 *
 * Amounts are the token's smallest unit, as BigInt — 'units', not display tokens.
 */

/** Thrown when a token cannot be used for x402 settlement. Never worked around. */
export class TokenUnusableError extends Error {
  constructor(message, { reason } = {}) {
    super(message);
    this.name = 'TokenUnusableError';
    /** Machine-readable cause, so callers branch on a value and not on prose. */
    this.reason = reason;
  }
}

/**
 * How many tinybar one smallest-unit of the token is worth.
 *
 * Deliberately an integer, and deliberately part of the published schedule: a buyer that
 * cannot reproduce the conversion cannot budget in the token, and would have to pay once
 * to discover what the token price is.
 */
export const DEFAULT_TINYBAR_PER_UNIT = 1_000n;

/**
 * Convert a metered tinybar price into token units.
 *
 * Rounds UP. Rounding down would let a buyer pay strictly less than the metered price by
 * choosing the token — a discount for picking a payment rail, which is a pricing bug
 * dressed as a feature. Rounding up costs the buyer at most one unit and can never
 * underpay the seller.
 *
 * @param {bigint} priceTinybar  from meter.priceFor — the single pricing authority
 * @param {bigint} [tinybarPerUnit]
 * @returns {bigint} token units (smallest denomination)
 */
export function tokenAmountFor(priceTinybar, tinybarPerUnit = DEFAULT_TINYBAR_PER_UNIT) {
  if (typeof priceTinybar !== 'bigint') {
    throw new TypeError('priceTinybar must be a bigint (tinybar); money is not a float');
  }
  if (typeof tinybarPerUnit !== 'bigint') {
    throw new TypeError('tinybarPerUnit must be a bigint');
  }
  if (priceTinybar <= 0n) {
    throw new RangeError(`refusing to convert a non-positive price: ${priceTinybar}`);
  }
  if (tinybarPerUnit <= 0n) {
    throw new RangeError(`tinybarPerUnit must be positive, got ${tinybarPerUnit}`);
  }

  // Ceiling division on integers. No floats anywhere near a price.
  //
  // There is deliberately no "converted to zero units" guard below. With both inputs
  // already checked positive, a ceiling can never return less than 1, so such a guard
  // would be unreachable — and an unreachable branch reads like a tested defence while
  // being neither. The property is pinned by test instead: every positive price buys at
  // least one whole unit, so the seller is never asked to serve a request for nothing.
  return (priceTinybar + tinybarPerUnit - 1n) / tinybarPerUnit;
}

/**
 * Reject a token that cannot carry an `exact`-scheme payment.
 *
 * Takes the token's own mirror-node description rather than our belief about it, so a
 * token reconfigured after deployment is caught rather than assumed to still be fine.
 *
 * @param {object} tokenInfo mirror node /api/v1/tokens/{id} shape
 */
export function assertTokenUsable(tokenInfo) {
  if (!tokenInfo || typeof tokenInfo !== 'object') {
    throw new TokenUnusableError('no token info supplied', { reason: 'MISSING_TOKEN_INFO' });
  }
  if (tokenInfo.deleted === true) {
    throw new TokenUnusableError(`token ${tokenInfo.token_id} is deleted`, {
      reason: 'TOKEN_DELETED',
    });
  }
  if (tokenInfo.pause_status === 'PAUSED') {
    throw new TokenUnusableError(`token ${tokenInfo.token_id} is paused`, {
      reason: 'TOKEN_PAUSED',
    });
  }

  const fractional = tokenInfo.custom_fees?.fractional_fees ?? [];
  for (const fee of fractional) {
    // The whole point of trap 1. `net_of_transfers: false` is INCLUSIVE — the fee comes
    // out of the transferred amount, the payee is credited less than `amount`, and the
    // facilitator rejects the settlement as underpaid. Every time, for everyone.
    if (fee.net_of_transfers !== true) {
      throw new TokenUnusableError(
        `token ${tokenInfo.token_id} has an INCLUSIVE fractional fee; an exact-scheme ` +
          'payment would credit the payee less than the quoted amount and always be rejected',
        { reason: 'INCLUSIVE_FRACTIONAL_FEE' },
      );
    }
  }

  // `fixed_fees` are deliberately NOT rejected. A fixed custom fee is charged to the
  // sender *in addition to* the transfer rather than out of it, so the payee is still
  // credited exactly `maxAmountRequired` and the `exact` scheme still holds. It makes the
  // buyer's debit larger than the quote, which is the buyer's business to read off the
  // token — not a reason for the gateway to refuse the asset.
  //
  // A royalty fee is different: it applies to NFT transfers, so on a token we intend to
  // accept as fungible payment its presence means the token is not what we think it is.
  // Note the live mirror response omits `royalty_fees` entirely for fungible tokens
  // rather than sending an empty array, hence the nullish default.
  if ((tokenInfo.custom_fees?.royalty_fees ?? []).length > 0) {
    throw new TokenUnusableError(
      `token ${tokenInfo.token_id} carries royalty fees; not a fungible payment token`,
      { reason: 'ROYALTY_FEE' },
    );
  }
  return true;
}

/**
 * Refuse a buyer who is exempt from the token's own custom fees.
 *
 * Trap 2, and it is a *demo honesty* guard rather than a security one. The treasury and
 * any listed fee collector pay no custom fee, so a settlement they fund shows the fee
 * never firing — the collector receives nothing and the buyer is debited only the amount.
 * That run looks like a success and demonstrates the reverse of the claim being made.
 *
 * @param {string} buyer      account paying
 * @param {object} tokenInfo  mirror node token description
 */
export function assertBuyerNotFeeExempt(buyer, tokenInfo) {
  if (typeof buyer !== 'string' || buyer.length === 0) {
    throw new TokenUnusableError('no buyer account supplied', { reason: 'MISSING_BUYER' });
  }
  const exempt = new Set();
  if (tokenInfo?.treasury_account_id) exempt.add(tokenInfo.treasury_account_id);
  for (const fee of tokenInfo?.custom_fees?.fractional_fees ?? []) {
    if (fee.collector_account_id) exempt.add(fee.collector_account_id);
  }

  if (exempt.has(buyer)) {
    throw new TokenUnusableError(
      `buyer ${buyer} is exempt from this token's custom fees (treasury or fee collector); ` +
        'a settlement it funds would show the fee not firing and prove the opposite of the claim',
      { reason: 'BUYER_FEE_EXEMPT' },
    );
  }
  return true;
}

/**
 * The token half of the published schedule.
 *
 * Same reason the tinybar schedule is published: an agent should be able to compute the
 * token price of its next call without paying for one first.
 */
export function tokenSchedule(token) {
  assertTokenConfig(token);
  return Object.freeze({
    tokenId: token.tokenId,
    symbol: token.symbol,
    decimals: token.decimals,
    tinybarPerUnit: token.tinybarPerUnit.toString(),
    formula: 'units = ceil(tinybarPrice / tinybarPerUnit)',
    note:
      'the token amount is derived from the tinybar price, so both assets are quoted by ' +
      'the same meter; choosing the token never changes what the request costs',
  });
}

/**
 * Build the token offer that sits alongside the HBAR offer in a 402.
 *
 * Shares `scheme`/`network`/`resource`/`payTo` with the HBAR offer by construction —
 * they are passed in, not restated — so the two offers cannot disagree about anything
 * except the asset and the amount.
 *
 * @param {object} args
 * @param {object} args.base    the HBAR offer, used as the template
 * @param {object} args.token   token config
 * @param {bigint} args.price   tinybar, from the meter
 */
export function buildTokenOffer({ base, token, price }) {
  assertTokenConfig(token);
  if (!base || typeof base !== 'object') {
    throw new TypeError('base offer required');
  }
  const units = tokenAmountFor(price, token.tinybarPerUnit);
  return {
    ...base,
    maxAmountRequired: units.toString(),
    asset: token.tokenId,
    description: `${base.description}; priced in ${token.symbol}, derived from the tinybar quote`,
    extra: { ...base.extra, tokenDecimals: token.decimals },
  };
}

/**
 * Read a token configuration out of the environment.
 *
 * Returns null when no token is configured — the token rail is optional and the gateway
 * must work identically without it. Half-configured is an error rather than a default:
 * a token id with no rate would silently price every request at the fallback rate.
 */
export function tokenFromEnv(env = process.env) {
  const tokenId = env.TOLLGATE_TOKEN_ID;
  if (!tokenId) return null;

  const rawRate = env.TOLLGATE_TINYBAR_PER_UNIT;
  const rawDecimals = env.TOLLGATE_TOKEN_DECIMALS;
  const symbol = env.TOLLGATE_TOKEN_SYMBOL;

  if (!symbol) {
    throw new TokenUnusableError(
      'TOLLGATE_TOKEN_ID is set but TOLLGATE_TOKEN_SYMBOL is not; refusing to guess',
      { reason: 'INCOMPLETE_TOKEN_CONFIG' },
    );
  }
  if (rawDecimals === undefined || !/^\d+$/.test(rawDecimals)) {
    throw new TokenUnusableError(
      `TOLLGATE_TOKEN_DECIMALS must be a whole number, got ${JSON.stringify(rawDecimals)}`,
      { reason: 'INCOMPLETE_TOKEN_CONFIG' },
    );
  }
  if (rawRate !== undefined && !/^\d+$/.test(rawRate)) {
    throw new TokenUnusableError(
      `TOLLGATE_TINYBAR_PER_UNIT must be a whole number, got ${JSON.stringify(rawRate)}`,
      { reason: 'INCOMPLETE_TOKEN_CONFIG' },
    );
  }

  const token = {
    tokenId,
    symbol,
    decimals: Number(rawDecimals),
    tinybarPerUnit: rawRate === undefined ? DEFAULT_TINYBAR_PER_UNIT : BigInt(rawRate),
  };
  assertTokenConfig(token);
  return token;
}

function assertTokenConfig(token) {
  if (!token || typeof token !== 'object') {
    throw new TypeError('token config required');
  }
  if (typeof token.tokenId !== 'string' || !/^\d+\.\d+\.\d+$/.test(token.tokenId)) {
    throw new TypeError(`token.tokenId must be a Hedera id, got ${JSON.stringify(token.tokenId)}`);
  }
  if (typeof token.symbol !== 'string' || token.symbol.length === 0) {
    throw new TypeError('token.symbol required');
  }
  if (!Number.isInteger(token.decimals) || token.decimals < 0) {
    throw new TypeError(`token.decimals must be a non-negative integer, got ${token.decimals}`);
  }
  if (typeof token.tinybarPerUnit !== 'bigint' || token.tinybarPerUnit <= 0n) {
    throw new TypeError('token.tinybarPerUnit must be a positive bigint');
  }
  return true;
}
