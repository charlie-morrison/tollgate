#!/usr/bin/env node
/**
 * A buyer. Hits a Tollgate endpoint cold, reads the 402, signs, retries, gets served.
 *
 * This is the *only* file in the repo that imports the Hedera SDK, and that asymmetry is
 * the architecture rather than an accident: the buyer signs, the facilitator submits, and
 * the resource server holds no key at all. Run this against a Tollgate and nothing on the
 * server side ever touches a private key.
 *
 *   HEDERA_ACCOUNT_ID=0.0.x HEDERA_PRIVATE_KEY=302e… node tools/pay-once.mjs \
 *     "http://host:8403/query?records=3&detail=full" [--max-tinybar N]
 *
 * The spend policy is enforced *before* signing. An agent that signs first and checks the
 * price afterwards has already lost the argument.
 */

import {
  Client,
  AccountId,
  PrivateKey,
  Hbar,
  TransferTransaction,
  Transaction,
  TransactionId,
} from '@hashgraph/sdk';

const url = process.argv[2];
if (!url) {
  console.error('usage: pay-once.mjs <url> [--max-tinybar N]');
  process.exit(2);
}
const maxIdx = process.argv.indexOf('--max-tinybar');
const MAX_TINYBAR = maxIdx > 0 ? BigInt(process.argv[maxIdx + 1]) : 5_000_000n;

const ACCOUNT = process.env.HEDERA_ACCOUNT_ID;
const KEY = process.env.HEDERA_PRIVATE_KEY;
if (!ACCOUNT || !KEY) {
  console.error('HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY are required');
  process.exit(2);
}

// 1. Cold call. Expect a 402 carrying a machine-readable price.
const cold = await fetch(url);
if (cold.status !== 402) {
  console.error(`expected 402, got ${cold.status}`);
  console.error(await cold.text());
  process.exit(1);
}
const challenge = await cold.json();
const offer = (challenge.accepts || []).find(
  (a) => a.scheme === 'exact' && String(a.network).startsWith('hedera'),
);
if (!offer) {
  console.error('no hedera offer in challenge');
  process.exit(1);
}

const price = BigInt(offer.maxAmountRequired);
console.log(`[buyer] quoted ${price} tinybar for ${offer.resource}`);
console.log(`[buyer] payee ${offer.payTo}, fee payer ${offer.extra?.feePayer}`);

// 2. Spend policy, before any signature exists.
if (price > MAX_TINYBAR) {
  console.error(`[buyer] REFUSING: ${price} exceeds policy ${MAX_TINYBAR}`);
  process.exit(3);
}

// 3. Build the transfer the offer asked for. The fee payer is the facilitator's account,
//    named in the challenge — a buyer cannot guess it, which is why the offer carries it.
const feePayer = offer.extra?.feePayer;
if (!feePayer) {
  console.error('[buyer] offer does not name a fee payer; cannot build a signable transfer');
  process.exit(1);
}

const client = Client.forTestnet().setOperator(
  AccountId.fromString(ACCOUNT),
  PrivateKey.fromStringECDSA(KEY),
);

const tx = await new TransferTransaction()
  .addHbarTransfer(AccountId.fromString(ACCOUNT), Hbar.fromTinybars(-price))
  .addHbarTransfer(AccountId.fromString(offer.payTo), Hbar.fromTinybars(price))
  .setTransactionMemo('x402 tollgate')
  .setTransactionId(TransactionId.generate(AccountId.fromString(feePayer)))
  .setNodeAccountIds([new AccountId(3)])
  .freeze()
  .sign(PrivateKey.fromStringECDSA(KEY));

const signed = Buffer.from(tx.toBytes()).toString('base64');

// Sanity: the bytes must round-trip, or we are about to hand the facilitator garbage.
Transaction.fromBytes(Buffer.from(signed, 'base64'));

// 4. Retry with the payment attached. Exactly one field goes back.
const header = Buffer.from(
  JSON.stringify({
    x402Version: 1,
    scheme: offer.scheme,
    network: offer.network,
    payload: { transaction: signed },
  }),
).toString('base64');

const paid = await fetch(url, { headers: { 'X-PAYMENT': header } });
const body = await paid.json();

console.log(`[buyer] HTTP ${paid.status}`);
console.log(JSON.stringify(body, null, 2).slice(0, 1400));

const receipt = paid.headers.get('x-payment-response');
if (receipt) {
  console.log('[buyer] X-PAYMENT-RESPONSE:', Buffer.from(receipt, 'base64').toString('utf8'));
}

client.close();
process.exit(paid.status === 200 ? 0 : 1);
