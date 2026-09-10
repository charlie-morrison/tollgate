/**
 * Create the HTS token that the gateway accepts as an alternative to HBAR.
 *
 *   HEDERA_OPERATOR_ID=0.0.x HEDERA_OPERATOR_KEY=<ecdsa hex> node tools/create-fee-token.mjs
 *
 * The token carries a 2% fractional custom fee, and the single most important line in
 * this file is `setAllCollectorsAreExempt(false)` combined with an EXCLUSIVE assessment:
 *
 *   .setAssessmentMethod(FeeAssessmentMethod.Exclusive)
 *
 * INCLUSIVE (the SDK default) takes the fee OUT of the transferred amount. The x402
 * scheme we settle under is `exact` — the facilitator checks the payee was credited
 * exactly the quoted amount — so an inclusive fee makes every settlement land short and
 * be rejected as underpaid, forever, for every buyer. The token would look configured
 * and be unusable, and the error would blame the payer.
 *
 * The fee collector is a separate account from the treasury on purpose, so the fee is
 * visibly not revenue. It is created with the operator's own public key rather than a
 * fresh keypair: nothing ever needs to spend from it, and a new private key would be one
 * more secret to store for no benefit.
 */

import {
  Client,
  PrivateKey,
  AccountId,
  AccountCreateTransaction,
  TokenCreateTransaction,
  TokenType,
  TokenSupplyType,
  CustomFractionalFee,
  FeeAssessmentMethod,
  Hbar,
} from '@hashgraph/sdk';

const id = process.env.HEDERA_OPERATOR_ID;
const key = process.env.HEDERA_OPERATOR_KEY;
if (!id || !key) {
  console.error('set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY');
  process.exit(2);
}

const operatorId = AccountId.fromString(id);
const operatorKey = PrivateKey.fromStringECDSA(key);
const client = Client.forTestnet().setOperator(operatorId, operatorKey);

const SYMBOL = process.env.TOKEN_SYMBOL || 'X402T';
const DECIMALS = Number(process.env.TOKEN_DECIMALS ?? 2);
const SUPPLY = Number(process.env.TOKEN_SUPPLY ?? 1_000_000);
const FEE_NUMERATOR = Number(process.env.FEE_NUMERATOR ?? 2);
const FEE_DENOMINATOR = Number(process.env.FEE_DENOMINATOR ?? 100);

try {
  // 1. A collector that is not the treasury, so the custom fee is visibly separate from
  //    the money the gateway earns.
  const collectorTx = await new AccountCreateTransaction()
    .setKeyWithoutAlias(operatorKey.publicKey)
    .setInitialBalance(new Hbar(0))
    .setAccountMemo('Tollgate — custom fee collector (not the payee)')
    .execute(client);
  const collectorId = (await collectorTx.getReceipt(client)).accountId.toString();

  // 2. The fee itself. EXCLUSIVE is the whole point; see the header.
  const fee = new CustomFractionalFee()
    .setNumerator(FEE_NUMERATOR)
    .setDenominator(FEE_DENOMINATOR)
    .setFeeCollectorAccountId(AccountId.fromString(collectorId))
    .setAssessmentMethod(FeeAssessmentMethod.Exclusive);

  const tokenTx = await new TokenCreateTransaction()
    .setTokenName('Tollgate x402 Credit')
    .setTokenSymbol(SYMBOL)
    .setTokenType(TokenType.FungibleCommon)
    .setSupplyType(TokenSupplyType.Finite)
    .setDecimals(DECIMALS)
    .setInitialSupply(SUPPLY)
    .setMaxSupply(SUPPLY)
    .setTreasuryAccountId(operatorId)
    .setCustomFees([fee])
    .setTokenMemo('Pay-per-call credit for the Tollgate x402 gateway')
    .execute(client);
  const receipt = await tokenTx.getReceipt(client);
  const tokenId = receipt.tokenId.toString();

  console.log(
    JSON.stringify(
      {
        tokenId,
        symbol: SYMBOL,
        decimals: DECIMALS,
        treasury: operatorId.toString(),
        feeCollector: collectorId,
        fee: `${FEE_NUMERATOR}/${FEE_DENOMINATOR} EXCLUSIVE (net_of_transfers)`,
        status: receipt.status.toString(),
        // Read it back rather than believing this script: an INCLUSIVE fee here would
        // make every settlement fail later, so the flag is worth confirming on-chain.
        verifyItYourself: `https://testnet.mirrornode.hedera.com/api/v1/tokens/${tokenId}`,
        env: [
          `TOLLGATE_TOKEN_ID=${tokenId}`,
          `TOLLGATE_TOKEN_SYMBOL=${SYMBOL}`,
          `TOLLGATE_TOKEN_DECIMALS=${DECIMALS}`,
          'TOLLGATE_TINYBAR_PER_UNIT=1000',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  client.close();
}
