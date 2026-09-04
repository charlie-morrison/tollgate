import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toMirrorTxId,
  netTransfer,
  isSuccess,
  consensusAt,
  receiptUrl,
} from '../src/mirror.mjs';

test('converts the wire transaction id form into the mirror path form', () => {
  assert.equal(
    toMirrorTxId('0.0.1234@1789000000.123456789'),
    '0.0.1234-1789000000-123456789',
  );
});

test('accepts an already-converted id unchanged', () => {
  assert.equal(
    toMirrorTxId('0.0.1234-1789000000-123456789'),
    '0.0.1234-1789000000-123456789',
  );
});

test('preserves a leading-zero nanosecond field', () => {
  // 0.000000042s is not 42s. Losing the zeros silently points at a different transaction.
  assert.equal(
    toMirrorTxId('0.0.9@1789000000.000000042'),
    '0.0.9-1789000000-000000042',
  );
});

test('refuses a malformed id loudly rather than guessing', () => {
  for (const bad of ['', '   ', 'nonsense', '0.0.1234', '0.0.1234@nope', '@1.2', null, 42]) {
    assert.throws(() => toMirrorTxId(bad), TypeError, `should have refused: ${String(bad)}`);
  }
});

test('nets a double-entry transfer list for one account', () => {
  const record = {
    transfers: [
      { account: '0.0.buyer', amount: -1_000_000 },
      { account: '0.0.payee', amount: 1_000_000 },
      { account: '0.0.node', amount: 0 },
    ],
  };
  assert.equal(netTransfer(record, '0.0.payee'), 1_000_000n);
  assert.equal(netTransfer(record, '0.0.buyer'), -1_000_000n);
});

test('sums every entry when an account appears more than once', () => {
  // The gross reading would call this a 1,000,000 credit. It is a 400,000 credit.
  const record = {
    transfers: [
      { account: '0.0.payee', amount: 1_000_000 },
      { account: '0.0.payee', amount: -600_000 },
    ],
  };
  assert.equal(netTransfer(record, '0.0.payee'), 400_000n);
});

test('an account absent from the transfer list nets zero', () => {
  assert.equal(netTransfer({ transfers: [] }, '0.0.payee'), 0n);
  assert.equal(netTransfer(null, '0.0.payee'), 0n);
});

test('only SUCCESS counts as paid', () => {
  assert.equal(isSuccess({ result: 'SUCCESS' }), true);
  for (const r of ['INSUFFICIENT_ACCOUNT_BALANCE', 'DUPLICATE_TRANSACTION', '', undefined]) {
    assert.equal(isSuccess({ result: r }), false);
  }
  assert.equal(isSuccess(null), false);
});

test('reads a consensus timestamp, and refuses to invent one', () => {
  assert.deepEqual(
    consensusAt({ consensus_timestamp: '1789000000.123456789' }),
    new Date(1789000000 * 1000),
  );
  assert.equal(consensusAt({}), null);
  assert.equal(consensusAt(null), null);
});

test('publishes a third-party-checkable receipt url', () => {
  assert.equal(
    receiptUrl('0.0.1234@1789000000.123456789'),
    'https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.1234-1789000000-123456789',
  );
});
