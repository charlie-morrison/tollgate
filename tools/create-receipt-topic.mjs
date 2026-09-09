/**
 * Create the HCS topic that carries public settlement receipts.
 *
 * Run once per deployment. The topic id it prints goes into TOLLGATE_RECEIPT_TOPIC.
 *
 *   HEDERA_OPERATOR_ID=0.0.x HEDERA_OPERATOR_KEY=<ecdsa hex> node tools/create-receipt-topic.mjs
 *
 * The topic is created WITHOUT a submit key, i.e. open. That is deliberate: a receipt
 * trail whose writer also controls who may write to it is a weaker claim than one anybody
 * can audit and append to. The reader compensates — src/receipts.mjs treats every message
 * as untrusted input and reports anything that is not one of our receipts as unparsed.
 *
 * There is no admin key either, so the topic cannot be updated or deleted afterwards —
 * including by us. An operator who can erase the record is not offering much of a record.
 */

import { Client, PrivateKey, AccountId, TopicCreateTransaction } from '@hashgraph/sdk';

const id = process.env.HEDERA_OPERATOR_ID;
const key = process.env.HEDERA_OPERATOR_KEY;
if (!id || !key) {
  console.error('set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY');
  process.exit(2);
}

const client = Client.forTestnet().setOperator(
  AccountId.fromString(id),
  PrivateKey.fromStringECDSA(key),
);

try {
  const tx = await new TopicCreateTransaction()
    .setTopicMemo('Tollgate — public x402 settlement receipts (x402.receipt.v1)')
    .execute(client);
  const receipt = await tx.getReceipt(client);
  const topicId = receipt.topicId.toString();

  console.log(JSON.stringify({
    topicId,
    status: receipt.status.toString(),
    submitKey: null,
    adminKey: null,
    readItYourself: `https://testnet.mirrornode.hedera.com/api/v1/topics/${topicId}/messages?limit=25&order=desc`,
  }, null, 2));
} finally {
  client.close();
}
