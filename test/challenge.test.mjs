import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  X402_VERSION,
  SCHEME,
  PaymentHeaderError,
  buildChallenge,
  readPaymentHeader,
  buildPaymentRequirements,
  buildVerifyEnvelope,
} from '../src/challenge.mjs';
import { meter, publishedSchedule } from '../src/meter.mjs';

const CONFIG = Object.freeze({
  payTo: '0.0.10181166',
  facilitator: {
    url: 'https://facilitator.example/v1',
    feePayer: '0.0.7162784',
  },
});

const RESOURCE = 'http://tollgate.example/data?records=3';
const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');

test('the challenge quotes the meter, not a second opinion', () => {
  // Rule 1 has to hold across module boundaries, not just inside the meter.
  const { price } = meter(new URLSearchParams('records=3&detail=full'));
  const challenge = buildChallenge({ config: CONFIG, price, resource: RESOURCE });

  assert.equal(challenge.accepts[0].maxAmountRequired, '350000');
  assert.equal(challenge.accepts[0].maxAmountRequired, price.toString());
  assert.equal(challenge.x402Version, X402_VERSION);
});

test('the challenge names the fee payer the buyer cannot guess', () => {
  const challenge = buildChallenge({ config: CONFIG, price: 220_000n, resource: RESOURCE });
  const offer = challenge.accepts[0];

  assert.equal(offer.extra.feePayer, CONFIG.facilitator.feePayer);
  assert.equal(offer.payTo, CONFIG.payTo);
  assert.equal(offer.network, SCHEME.network);
  assert.equal(offer.scheme, SCHEME.scheme);
});

test('the challenge can carry the schedule so an agent budgets before it spends', () => {
  const challenge = buildChallenge({
    config: CONFIG,
    price: 220_000n,
    resource: RESOURCE,
    schedule: publishedSchedule(),
  });
  assert.equal(challenge.schedule.base, '200000');
  assert.equal(challenge.schedule.currency, 'tinybar');
});

test('refuses to advertise a price that is not money', () => {
  assert.throws(
    () => buildChallenge({ config: CONFIG, price: 220_000, resource: RESOURCE }),
    TypeError,
  );
  assert.throws(
    () => buildChallenge({ config: CONFIG, price: 0n, resource: RESOURCE }),
    RangeError,
  );
});

test('reads the transaction out of a base64 envelope', () => {
  const header = b64({
    x402Version: 1,
    payload: { transaction: '0.0.999@1788000000.000000001' },
  });
  assert.deepEqual(readPaymentHeader(header), {
    transaction: '0.0.999@1788000000.000000001',
  });
});

test('reads bare JSON too, so curl gets a real error and not a riddle', () => {
  const header = JSON.stringify({ payload: { transaction: '0.0.999@1.2' } });
  assert.equal(readPaymentHeader(header).transaction, '0.0.999@1.2');
});

test('absent and empty are different mistakes', () => {
  // Collapsing these sends the caller hunting in the wrong place: one means "you forgot
  // to pay", the other means "your client built a broken header".
  assert.throws(() => readPaymentHeader(undefined), (e) => e.reason === 'ABSENT');
  assert.throws(() => readPaymentHeader(null), (e) => e.reason === 'ABSENT');
  assert.throws(() => readPaymentHeader(''), (e) => e.reason === 'EMPTY');
  assert.throws(() => readPaymentHeader('   '), (e) => e.reason === 'EMPTY');
});

test('every unreadable header is refused by name', () => {
  assert.throws(() => readPaymentHeader('{not json'), (e) => e.reason === 'MALFORMED');
  assert.throws(() => readPaymentHeader(b64([1, 2, 3])), (e) => e.reason === 'MALFORMED');
  assert.throws(() => readPaymentHeader(b64({ payload: {} })), (e) => e.reason === 'NO_TRANSACTION');
  assert.throws(() => readPaymentHeader(b64({})), (e) => e.reason === 'NO_TRANSACTION');
  assert.throws(
    () => readPaymentHeader(b64({ payload: { transaction: '   ' } })),
    (e) => e.reason === 'NO_TRANSACTION',
  );
  assert.throws(() => readPaymentHeader(b64({ payload: { transaction: 42 } })), PaymentHeaderError);
});

test('THE trust bug: buyer-supplied terms cannot reach the requirements', () => {
  // The attack: send a real, cheap, correctly-signed payment, and attach the terms it
  // satisfies. A server that echoes those terms asks the facilitator whether a payment
  // matches conditions written by its own sender — which it always does.
  const attacker = b64({
    payload: { transaction: '0.0.666@1.1' },
    // everything below is the attacker's wish list
    paymentRequirements: { amount: '1', payTo: '0.0.666', asset: 'HBAR' },
    accepted: [{ scheme: 'exact', network: 'hedera-testnet', amount: '1' }],
    amount: '1',
    payTo: '0.0.666',
    maxAmountRequired: '1',
  });

  const payment = readPaymentHeader(attacker);
  assert.deepEqual(payment, { transaction: '0.0.666@1.1' }, 'exactly one field survives');

  // Terms are re-derived from the live request, not from anything above.
  const { price } = meter(new URLSearchParams('records=100&detail=full'));
  const requirements = buildPaymentRequirements({ config: CONFIG, price, resource: RESOURCE });

  assert.equal(requirements.amount, '5200000');
  assert.equal(requirements.payTo, CONFIG.payTo);
  assert.notEqual(requirements.payTo, '0.0.666');

  const envelope = buildVerifyEnvelope({ payment, requirements });
  const wire = JSON.stringify(envelope);
  assert.ok(wire.includes('0.0.666@1.1'), 'the signed tx is forwarded');
  assert.ok(!wire.includes('"0.0.666"'), 'the attacker payee never reaches the wire');
  assert.ok(!wire.includes('"amount":"1"'), 'the attacker amount never reaches the wire');
});

test('no argument smuggles buyer terms into the requirements', () => {
  // The test above only proves the function is clean when called correctly. It would
  // still pass if someone later added a pass-through parameter — which is exactly how
  // this class of hole gets reintroduced. So: spread a full attacker envelope into the
  // arguments and demand the output is byte-identical to the honest call.
  const honest = buildPaymentRequirements({
    config: CONFIG,
    price: 220_000n,
    resource: RESOURCE,
  });

  const smuggled = buildPaymentRequirements({
    config: CONFIG,
    price: 220_000n,
    resource: RESOURCE,
    // every name a future pass-through might plausibly be given
    amount: '1',
    payTo: '0.0.666',
    asset: 'FAKE',
    maxAmountRequired: '1',
    overrides: { amount: '1', payTo: '0.0.666' },
    buyerDeclared: { amount: '1', payTo: '0.0.666' },
    paymentRequirements: { amount: '1', payTo: '0.0.666' },
    accepted: [{ scheme: 'exact', network: 'hedera-testnet', amount: '1' }],
    extra: { feePayer: '0.0.666' },
  });

  assert.deepEqual(smuggled, honest);
  assert.equal(smuggled.amount, '220000');
  assert.equal(smuggled.payTo, CONFIG.payTo);
  assert.equal(smuggled.asset, 'HBAR');
  assert.equal(smuggled.extra.feePayer, CONFIG.facilitator.feePayer);
});

test('no argument smuggles buyer terms into the challenge either', () => {
  const honest = buildChallenge({ config: CONFIG, price: 220_000n, resource: RESOURCE });
  const smuggled = buildChallenge({
    config: CONFIG,
    price: 220_000n,
    resource: RESOURCE,
    payTo: '0.0.666',
    accepts: [{ payTo: '0.0.666', maxAmountRequired: '1' }],
    maxAmountRequired: '1',
  });
  assert.deepEqual(smuggled, honest);
  assert.equal(smuggled.accepts[0].payTo, CONFIG.payTo);
  assert.equal(smuggled.accepts.length, 1);
});

test('the second door: a cheap receipt against an expensive request', () => {
  // Same defence, different angle. The buyer honestly paid for one record; the terms we
  // verify against come from the request in hand, which asks for a hundred.
  const cheap = meter(new URLSearchParams('records=1')).price;
  const expensive = meter(new URLSearchParams('records=100&detail=full')).price;

  const requirements = buildPaymentRequirements({
    config: CONFIG,
    price: expensive,
    resource: RESOURCE,
  });

  assert.equal(requirements.amount, expensive.toString());
  assert.notEqual(requirements.amount, cheap.toString());
});

test('the verify envelope carries the scheme where the facilitator looks for it', () => {
  // Measured against a live facilitator: the requested scheme is validated from inside
  // the payload, so an envelope without `accepted` is rejected before the payment is
  // ever examined.
  const requirements = buildPaymentRequirements({
    config: CONFIG,
    price: 220_000n,
    resource: RESOURCE,
  });
  const envelope = buildVerifyEnvelope({
    payment: { transaction: '0.0.5@1.1' },
    requirements,
  });

  assert.equal(envelope.paymentPayload.accepted[0].scheme, SCHEME.scheme);
  assert.equal(envelope.paymentPayload.accepted[0].network, SCHEME.network);
  assert.equal(envelope.paymentPayload.payload.transaction, '0.0.5@1.1');
  assert.equal(envelope.paymentRequirements.amount, '220000');
});

test('an envelope cannot be built without the one field the buyer supplies', () => {
  const requirements = buildPaymentRequirements({
    config: CONFIG,
    price: 220_000n,
    resource: RESOURCE,
  });
  assert.throws(
    () => buildVerifyEnvelope({ payment: {}, requirements }),
    (e) => e.reason === 'NO_TRANSACTION',
  );
});

test('config gaps fail loudly at build time, not at payment time', () => {
  assert.throws(() => buildChallenge({ config: {}, price: 1n, resource: RESOURCE }), TypeError);
  assert.throws(
    () => buildPaymentRequirements({ config: { payTo: '0.0.1' }, price: 1n, resource: RESOURCE }),
    TypeError,
  );
});
