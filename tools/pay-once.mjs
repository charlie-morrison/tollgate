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
  TokenId,
  Transaction,
  TransactionId,
} from '@hashgraph/sdk';

const url = process.argv[2];
if (!url) {
  console.error('usage: pay-once.mjs <url> [--max-tinybar N] [--asset HBAR|0.0.x] [--max-units N]');
  process.exit(2);
}
const maxIdx = process.argv.indexOf('--max-tinybar');
const MAX_TINYBAR = maxIdx > 0 ? BigInt(process.argv[maxIdx + 1]) : 5_000_000n;

// Which advertised offer to take. The gateway may quote the same request in HBAR and in
// an HTS token; the buyer chooses, and the choice is expressed by what it signs.
const assetIdx = process.argv.indexOf('--asset');
const WANT_ASSET = assetIdx > 0 ? process.argv[assetIdx + 1] : 'HBAR';

// A token amount is NOT tinybar, so --max-tinybar cannot police it. A spend cap in the
// wrong denomination is worse than none: it reads as a limit and permits anything.
const unitsIdx = process.argv.indexOf('--max-units');
const MAX_UNITS = unitsIdx > 0 ? BigInt(process.argv[unitsIdx + 1]) : null;

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
const hederaOffers = (challenge.accepts || []).filter(
  (a) => a.scheme === 'exact' && String(a.network).startsWith('hedera'),
);
if (hederaOffers.length === 0) {
  console.error('no hedera offer in challenge');
  process.exit(1);
}
const offer = hederaOffers.find((a) => a.asset === WANT_ASSET);
if (!offer) {
  console.error(
    `no offer for asset ${WANT_ASSET}; the gateway advertises ` +
      hederaOffers.map((a) => a.asset).join(', '),
  );
  process.exit(1);
}

const isToken = offer.asset !== 'HBAR';
const amount = BigInt(offer.maxAmountRequired);
const unit = isToken ? `units of ${offer.asset}` : 'tinybar';
console.log(`[buyer] quoted ${amount} ${unit} for ${offer.resource}`);
console.log(`[buyer] payee ${offer.payTo}, fee payer ${offer.extra?.feePayer}`);

// 2. Spend policy, before any signature exists — and in the offer's OWN denomination.
//    Comparing 350 token units against a 5,000,000-tinybar cap would "pass" a policy that
//    never looked at the thing being spent.
if (isToken) {
  if (MAX_UNITS === null) {
    console.error(
      `[buyer] REFUSING: offer is denominated in ${offer.asset}; pass --max-units to set a ` +
        'cap in that unit (a tinybar cap does not bound a token spend)',
    );
    process.exit(3);
  }
  if (amount > MAX_UNITS) {
    console.error(`[buyer] REFUSING: ${amount} units exceeds policy ${MAX_UNITS}`);
    process.exit(3);
  }
} else if (amount > MAX_TINYBAR) {
  console.error(`[buyer] REFUSING: ${amount} exceeds policy ${MAX_TINYBAR}`);
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

const transfer = new TransferTransaction();
if (isToken) {
  // Signed as the DEBITED party only. The custom fee on this token is EXCLUSIVE, so the
  // payee is credited exactly `amount` and the fee is charged to us on top — which is
  // what lets an `exact`-scheme check pass at all.
  transfer
    .addTokenTransfer(TokenId.fromString(offer.asset), AccountId.fromString(ACCOUNT), -amount)
    .addTokenTransfer(TokenId.fromString(offer.asset), AccountId.fromString(offer.payTo), amount);
} else {
  transfer
    .addHbarTransfer(AccountId.fromString(ACCOUNT), Hbar.fromTinybars(-amount))
    .addHbarTransfer(AccountId.fromString(offer.payTo), Hbar.fromTinybars(amount));
}

const tx = await transfer
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
