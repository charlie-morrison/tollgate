/**
 * Measure what a native HBAR transfer actually costs to settle, from live ledger data.
 *
 * The base charge in the fee schedule has to sit above this number with headroom,
 * otherwise a minimum-size request is sold for less than it costs to settle and the
 * gateway loses money on its own floor.
 *
 * This is a measurement tool, not part of the serving path. Run it, read the number,
 * put the number in docs/PRICING.md — do not have the server price itself off a live
 * network call it cannot make deterministically.
 *
 *   node tools/measure-settlement-fee.mjs [sampleSize]
 */

import { MIRROR_TESTNET } from '../src/mirror.mjs';

const sampleSize = Number(process.argv[2] ?? 100);

function median(sorted) {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

const url =
  `${MIRROR_TESTNET}/api/v1/transactions` +
  `?transactiontype=CRYPTOTRANSFER&result=success&order=desc&limit=${Math.min(sampleSize, 100)}`;

const res = await fetch(url, { headers: { accept: 'application/json' } });
if (!res.ok) {
  console.error(`mirror node returned ${res.status}`);
  process.exit(1);
}
const { transactions = [] } = await res.json();

const fees = transactions
  .map((t) => Number(t.charged_tx_fee))
  .filter((n) => Number.isFinite(n) && n > 0)
  .sort((a, b) => a - b);

if (fees.length === 0) {
  console.error('no fee data in sample — refusing to report a number');
  process.exit(2);
}

const asHbar = (tinybar) => (tinybar / 1e8).toFixed(8);

console.log(`sample:  ${fees.length} successful CRYPTOTRANSFER txs, hedera testnet`);
console.log(`min:     ${fees[0]} tinybar (${asHbar(fees[0])} HBAR)`);
console.log(`median:  ${median(fees)} tinybar (${asHbar(median(fees))} HBAR)`);
console.log(`p90:     ${fees[Math.floor(fees.length * 0.9)]} tinybar`);
console.log(`max:     ${fees[fees.length - 1]} tinybar (${asHbar(fees[fees.length - 1])} HBAR)`);
