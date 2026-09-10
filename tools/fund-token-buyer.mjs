/**
 * Issue token credits to a buyer, so the token rail can be demonstrated end to end.
 *
 *   HEDERA_OPERATOR_ID=… HEDERA_OPERATOR_KEY=… \
 *   node tools/fund-token-buyer.mjs <tokenId> <buyerAccountId> <units>
 *
 * The buyer must NOT be the treasury, and this refuses to fund it. Not a safety check — a
 * demo-honesty one. The treasury is exempt from its own token's custom fees, so a payment
 * it funds shows the 2% fee never firing: the collector receives nothing, the buyer is
 * debited exactly the amount, and the run looks like a clean success while demonstrating
 * the opposite of what the token is for. Measured, not assumed — a first end-to-end run
 * did exactly this before the buyer was moved off the treasury.
 *
 * No association step: an account with `max_automatic_token_associations = -1` associates
 * on first receipt. Where that is 0, the buyer must associate the token itself first, and
 * the transfer below fails with TOKEN_NOT_ASSOCIATED_TO_ACCOUNT rather than silently.
 */

import {
  Client,
  PrivateKey,
  AccountId,
  TokenId,
  TransferTransaction,
} from '@hashgraph/sdk';

const [tokenId, buyer, rawUnits] = process.argv.slice(2);
if (!tokenId || !buyer || !rawUnits) {
  console.error('usage: fund-token-buyer.mjs <tokenId> <buyerAccountId> <units>');
  process.exit(2);
}
const units = BigInt(rawUnits);
if (units <= 0n) {
  console.error('units must be positive');
  process.exit(2);
}

const id = process.env.HEDERA_OPERATOR_ID;
const key = process.env.HEDERA_OPERATOR_KEY;
if (!id || !key) {
  console.error('set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY (the token treasury)');
  process.exit(2);
}

const info = await (
  await fetch(`https://testnet.mirrornode.hedera.com/api/v1/tokens/${tokenId}`)
).json();

if (buyer === info.treasury_account_id) {
  console.error(
    `refusing: ${buyer} is the treasury of ${tokenId} and is exempt from its custom fees; ` +
      'a payment it funds would show the fee not firing',
  );
  process.exit(3);
}
for (const fee of info.custom_fees?.fractional_fees ?? []) {
  if (fee.collector_account_id === buyer) {
    console.error(`refusing: ${buyer} collects this token's custom fee and is exempt from it`);
    process.exit(3);
  }
}

const treasury = AccountId.fromString(id);
const treasuryKey = PrivateKey.fromStringECDSA(key);
const client = Client.forTestnet().setOperator(treasury, treasuryKey);

try {
  const tx = await new TransferTransaction()
    .addTokenTransfer(TokenId.fromString(tokenId), treasury, -units)
    .addTokenTransfer(TokenId.fromString(tokenId), AccountId.fromString(buyer), units)
    .setTransactionMemo('tollgate token credits')
    .execute(client);
  const receipt = await tx.getReceipt(client);

  console.log(
    JSON.stringify(
      {
        tokenId,
        from: id,
        to: buyer,
        units: units.toString(),
        status: receipt.status.toString(),
        verifyItYourself: `https://testnet.mirrornode.hedera.com/api/v1/accounts/${buyer}/tokens?token.id=${tokenId}`,
      },
      null,
      2,
    ),
  );
} finally {
  client.close();
}
