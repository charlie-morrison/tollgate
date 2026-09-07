import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RateLimiter, clientIp, configFromEnv } from '../src/server.mjs';

test('a bucket allows exactly its capacity before refusing', () => {
  const rl = new RateLimiter({ capacity: 3, windowMs: 60_000 });
  const t = 1_000_000;
  assert.equal(rl.take('a', t).allowed, true);
  assert.equal(rl.take('a', t).allowed, true);
  assert.equal(rl.take('a', t).allowed, true);
  assert.equal(rl.take('a', t).allowed, false);
});

test('a refusal says when to come back', () => {
  const rl = new RateLimiter({ capacity: 1, windowMs: 60_000 });
  const t = 1_000_000;
  rl.take('a', t);
  const denied = rl.take('a', t);
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterSeconds > 0, 'a 429 without Retry-After is a guessing game');
});

test('buckets refill with time rather than resetting on a boundary', () => {
  const rl = new RateLimiter({ capacity: 2, windowMs: 1000 });
  const t = 1_000_000;
  rl.take('a', t);
  rl.take('a', t);
  assert.equal(rl.take('a', t).allowed, false);
  assert.equal(rl.take('a', t + 600).allowed, true, 'partial refill should grant a token');
});

test('callers are limited independently', () => {
  const rl = new RateLimiter({ capacity: 1, windowMs: 60_000 });
  const t = 1_000_000;
  assert.equal(rl.take('a', t).allowed, true);
  assert.equal(rl.take('b', t).allowed, true, 'one noisy caller must not throttle everyone');
  assert.equal(rl.take('a', t).allowed, false);
});

test('idle buckets are swept so the map cannot grow without bound', () => {
  const rl = new RateLimiter({ capacity: 1, windowMs: 1000 });
  const t = 1_000_000;
  rl.take('a', t);
  rl.take('b', t);
  assert.equal(rl.size, 2);
  rl.sweep(t + 20_000);
  assert.equal(rl.size, 0);
});

test('a client-supplied forwarding header cannot pick its own bucket by default', () => {
  // If this were honoured untrusted, an attacker rotates the header and the limit is
  // decorative.
  const req = {
    headers: { 'x-forwarded-for': '9.9.9.9' },
    socket: { remoteAddress: '10.0.0.1' },
  };
  assert.equal(clientIp(req, { trustProxy: false }), '10.0.0.1');
  assert.equal(clientIp(req, { trustProxy: true }), '9.9.9.9');
});

test('a forwarded chain takes the original client, not the last hop', () => {
  const req = {
    headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.5' },
    socket: { remoteAddress: '10.0.0.5' },
  };
  assert.equal(clientIp(req, { trustProxy: true }), '9.9.9.9');
});

test('config refuses to boot without a payee rather than defaulting to one', () => {
  assert.throws(
    () => configFromEnv({ TOLLGATE_FEE_PAYER: '0.0.1' }),
    /TOLLGATE_PAY_TO/,
  );
  assert.throws(
    () => configFromEnv({ TOLLGATE_PAY_TO: '0.0.1' }),
    /TOLLGATE_FEE_PAYER/,
  );
});

test('config reads a facilitator default but never a payee default', () => {
  const cfg = configFromEnv({ TOLLGATE_PAY_TO: '0.0.7', TOLLGATE_FEE_PAYER: '0.0.9' });
  assert.equal(cfg.payTo, '0.0.7');
  assert.equal(cfg.facilitator.feePayer, '0.0.9');
  assert.match(cfg.facilitator.url, /^https:\/\//);
});
