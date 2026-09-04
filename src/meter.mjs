/**
 * The meter: the single pricing authority.
 *
 * Both the 402 quote and the payment check call `priceFor` over the same parsed request.
 * There is deliberately no second path that computes a price — two paths drift, and a
 * gateway whose quote and charge disagree fails in a way nobody can debug from outside.
 *
 * Amounts are tinybar, as BigInt. Money is not a float.
 */

/** Thrown for a request that cannot be priced. Never defaulted around. */
export class InvalidRequestError extends Error {
  constructor(message, { param = null } = {}) {
    super(message);
    this.name = 'InvalidRequestError';
    this.param = param;
  }
}

/**
 * Published fee schedule.
 *
 * `base` sits above the measured cost of settling a native HBAR transfer — 129,394
 * tinybar median over 100 successful CRYPTOTRANSFERs on testnet, measured 2026-09-04 with
 * tools/measure-settlement-fee.mjs — with headroom, so the smallest billable request is
 * still above water. Pricing the floor at cost means every minimum call is a small loss.
 */
export const SCHEDULE = Object.freeze({
  currency: 'tinybar',
  base: 200_000n,
  perRecord: 20_000n,
  perRecordDetailed: 30_000n,
  maxRecords: 100,
  measuredSettlementFee: 129_394n,
  measuredAt: '2026-09-04',
});

/**
 * Parse and validate the billable parameters of a request.
 *
 * Every rejection here is loud. A silent default — treating `records=abc` as 1 — bills
 * somebody for a request they did not make, and they have no way to discover it happened.
 *
 * @param {URLSearchParams} params
 * @returns {{records: number, detail: 'summary'|'full'}}
 */
export function parseRequest(params) {
  const rawRecords = params.get('records');
  const rawDetail = params.get('detail');

  let records = 1;
  if (rawRecords !== null) {
    if (!/^\d+$/.test(rawRecords)) {
      throw new InvalidRequestError(
        `records must be a whole number, got ${JSON.stringify(rawRecords)}`,
        { param: 'records' },
      );
    }
    records = Number(rawRecords);
    if (records < 1 || records > SCHEDULE.maxRecords) {
      throw new InvalidRequestError(
        `records must be between 1 and ${SCHEDULE.maxRecords}, got ${records}`,
        { param: 'records' },
      );
    }
  }

  let detail = 'summary';
  if (rawDetail !== null) {
    if (rawDetail !== 'summary' && rawDetail !== 'full') {
      throw new InvalidRequestError(
        `detail must be "summary" or "full", got ${JSON.stringify(rawDetail)}`,
        { param: 'detail' },
      );
    }
    detail = rawDetail;
  }

  return { records, detail };
}

/**
 * Price a parsed request, in tinybar.
 *
 * @param {{records: number, detail: 'summary'|'full'}} request
 * @returns {bigint}
 */
export function priceFor(request) {
  const { records, detail } = request;
  if (!Number.isInteger(records) || records < 1 || records > SCHEDULE.maxRecords) {
    throw new InvalidRequestError(`unpriceable record count: ${records}`, { param: 'records' });
  }
  if (detail !== 'summary' && detail !== 'full') {
    throw new InvalidRequestError(`unpriceable detail level: ${detail}`, { param: 'detail' });
  }

  const perUnit = detail === 'full' ? SCHEDULE.perRecord + SCHEDULE.perRecordDetailed
                                    : SCHEDULE.perRecord;
  return SCHEDULE.base + perUnit * BigInt(records);
}

/** Convenience: parse and price in one step, for the request-handling path. */
export function meter(params) {
  const request = parseRequest(params);
  return { request, price: priceFor(request) };
}

/**
 * The schedule as an agent can consume it, so a caller can budget before spending and
 * can reproduce any quote we give. A price nobody can predict is not a price, it is a bill.
 */
export function publishedSchedule() {
  return {
    currency: SCHEDULE.currency,
    base: SCHEDULE.base.toString(),
    perRecord: SCHEDULE.perRecord.toString(),
    perRecordDetailSurcharge: SCHEDULE.perRecordDetailed.toString(),
    maxRecords: SCHEDULE.maxRecords,
    formula: 'base + records * (perRecord + (detail=full ? perRecordDetailSurcharge : 0))',
  };
}
