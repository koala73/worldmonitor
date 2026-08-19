import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clearAllCircuitBreakers,
  createCircuitBreaker,
} from '../src/utils/circuit-breaker';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('cooldown queries do not reset the accumulated failure count', async () => {
  clearAllCircuitBreakers();
  const breaker = createCircuitBreaker<{ value: string }>({
    name: 'state-contract-query',
    maxFailures: 2,
    cooldownMs: 20,
  });

  breaker.recordFailure('first');
  breaker.recordFailure('second');
  assert.equal(breaker.isOnCooldown(), true);

  await sleep(30);
  assert.equal(breaker.getCooldownRemaining(), 0);
  breaker.recordFailure('post-expiry query');

  assert.equal(
    breaker.isOnCooldown(),
    true,
    'reading an expired cooldown must not erase failures before a recovery probe succeeds',
  );
});

test('an expired cooldown uses one probe and reopens when that probe fails', async () => {
  clearAllCircuitBreakers();
  const breaker = createCircuitBreaker<number>({
    name: 'state-contract-probe',
    maxFailures: 2,
    cooldownMs: 20,
  });

  breaker.recordFailure('first');
  breaker.recordFailure('second');
  await sleep(30);
  assert.equal(breaker.isOnCooldown(), false);

  let probes = 0;
  const result = await breaker.execute(async () => {
    probes += 1;
    throw new Error('upstream still unavailable');
  }, 0);

  assert.equal(result, 0);
  assert.equal(probes, 1);
  assert.equal(
    breaker.isOnCooldown(),
    true,
    'a failed recovery probe must restore the cooldown immediately',
  );
});

test('concurrent callers wait for the same recovery probe', async () => {
  clearAllCircuitBreakers();
  const breaker = createCircuitBreaker<number>({
    name: 'state-contract-concurrent-probe',
    maxFailures: 2,
    cooldownMs: 20,
  });

  breaker.recordFailure('first');
  breaker.recordFailure('second');
  await sleep(30);

  let extraCalls = 0;
  const probe = breaker.execute(async () => {
    await sleep(30);
    return 7;
  }, 0);
  const blockedCaller = breaker.execute(async () => {
    extraCalls += 1;
    return 9;
  }, 0);

  assert.equal(await probe, 7);
  assert.equal(await blockedCaller, 0);
  assert.equal(extraCalls, 0, 'a caller arriving during a recovery probe must not bypass half-open state');
});

test('stale fallback returned during cooldown is reported as cached data', async () => {
  clearAllCircuitBreakers();
  const breaker = createCircuitBreaker<{ value: string }>({
    name: 'state-contract-stale-fallback',
    maxFailures: 1,
    cooldownMs: 1000,
    cacheTtlMs: 1,
  });

  breaker.recordSuccess({ value: 'last-good' });
  await sleep(20);
  breaker.recordFailure('open cooldown');

  const result = await breaker.execute(async () => {
    throw new Error('must not be called during cooldown');
  }, { value: 'default' });

  assert.deepEqual(result, { value: 'last-good' });
  const state = breaker.getDataState();
  assert.equal(state.mode, 'cached');
  assert.equal(
    typeof state.timestamp,
    'number',
    'the unavailable/default path has no cache timestamp, but a stale payload must retain its own',
  );
});

test('getCachedOrDefault honors the cache TTL', async () => {
  clearAllCircuitBreakers();
  const breaker = createCircuitBreaker<{ value: string }>({
    name: 'state-contract-ttl',
    cacheTtlMs: 1,
  });

  breaker.recordSuccess({ value: 'cached' });
  await sleep(20);

  assert.deepEqual(
    breaker.getCachedOrDefault({ value: 'default' }),
    { value: 'default' },
    'an expired entry must not bypass the TTL through getCachedOrDefault',
  );
});
