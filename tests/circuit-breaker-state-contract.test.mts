import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clearAllCircuitBreakers,
  createCircuitBreaker,
} from '../src/utils/circuit-breaker';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

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
  assert.equal(await blockedCaller, 7, 'a caller arriving during a recovery probe must await that probe result');
  assert.equal(extraCalls, 0, 'a caller arriving during a recovery probe must not bypass half-open state');
});

test('a caller for another cache key waits for recovery, then runs its own fetch', async () => {
  clearAllCircuitBreakers();
  const breaker = createCircuitBreaker<number>({
    name: 'state-contract-cross-key-probe',
    maxFailures: 2,
    cooldownMs: 20,
  });

  breaker.recordFailure('first');
  breaker.recordFailure('second');
  await sleep(30);

  const held = createDeferred();
  const probeA = breaker.execute(async () => {
    await held.promise;
    return 7;
  }, 0, { cacheKey: 'A' });

  let bCalls = 0;
  const callerB = breaker.execute(async () => {
    bCalls += 1;
    return 9;
  }, 0, { cacheKey: 'B' });

  held.resolve();
  assert.equal(await probeA, 7);
  assert.equal(await callerB, 9, 'a different cache key must not receive the probe owner payload');
  assert.equal(bCalls, 1, 'the different cache key must fetch after the shared health probe succeeds');
});

test('probe-owner cancellation does not reject an unrelated waiter', async () => {
  clearAllCircuitBreakers();
  const breaker = createCircuitBreaker<number>({
    name: 'state-contract-probe-cancel-waiter',
    maxFailures: 2,
    cooldownMs: 20,
  });

  breaker.recordFailure('first');
  breaker.recordFailure('second');
  await sleep(30);

  const held = createDeferred();
  const cancelled = new Error('caller cancelled');
  const owner = breaker.execute(async () => {
    await held.promise;
    throw cancelled;
  }, 0, {
    ignoreError: (error) => error === cancelled,
  });
  const waiterOutcome = breaker.execute(async () => 9, 0).then(
    (value) => ({ kind: 'resolved' as const, value }),
    (error: unknown) => ({ kind: 'rejected' as const, error }),
  );

  held.resolve();
  await assert.rejects(owner, (error: unknown) => error === cancelled);
  assert.deepEqual(
    await waiterOutcome,
    { kind: 'resolved', value: 0 },
    'caller-owned cancellation must stay private to the caller that supplied ignoreError',
  );
});

test('an ignored cancelled probe keeps the next concurrent retry half-open', async () => {
  clearAllCircuitBreakers();
  const breaker = createCircuitBreaker<number>({
    name: 'state-contract-probe-cancel-retry',
    maxFailures: 2,
    cooldownMs: 20,
  });

  breaker.recordFailure('first');
  breaker.recordFailure('second');
  await sleep(30);

  const cancelled = new Error('caller cancelled');
  await assert.rejects(
    breaker.execute(async () => {
      throw cancelled;
    }, 0, { ignoreError: (error) => error === cancelled }),
    (error: unknown) => error === cancelled,
  );

  const held = createDeferred();
  let retryCalls = 0;
  let bypassCalls = 0;
  const retry = breaker.execute(async () => {
    retryCalls += 1;
    await held.promise;
    return 7;
  }, 0);
  const waiter = breaker.execute(async () => {
    bypassCalls += 1;
    return 9;
  }, 0);

  held.resolve();
  assert.equal(await retry, 7);
  assert.equal(await waiter, 7, 'the concurrent caller must join the retry probe');
  assert.equal(retryCalls, 1);
  assert.equal(bypassCalls, 0, 'ignored cancellation must not reopen unrestricted live traffic');
});

for (const reset of ['clearCache', 'clearMemoryCache', 'recordSuccess'] as const) {
  test(`${reset} does not release an active recovery probe`, async () => {
    clearAllCircuitBreakers();
    const breaker = createCircuitBreaker<number>({
      name: `state-contract-active-probe-${reset}`,
      maxFailures: 2,
      cooldownMs: 20,
      cacheTtlMs: 0,
    });

    breaker.recordFailure('first');
    breaker.recordFailure('second');
    await sleep(30);

    const held = createDeferred();
    const probe = breaker.execute(async () => {
      await held.promise;
      return 7;
    }, 0, { cacheKey: 'A' });

    if (reset === 'recordSuccess') {
      breaker.recordSuccess(11, 'unrelated');
    } else {
      breaker[reset]();
    }

    let bypassCalls = 0;
    const waiter = breaker.execute(async () => {
      bypassCalls += 1;
      return 9;
    }, 0, { cacheKey: 'A' });

    await sleep(0);
    assert.equal(bypassCalls, 0, `${reset} must leave the active probe latch owned by that probe`);
    held.resolve();
    assert.equal(await probe, 7);
    assert.equal(await waiter, 7);
  });
}

test('joining an in-flight SWR after cooldown expiry does not latch the recovery probe', async () => {
  clearAllCircuitBreakers();
  const breaker = createCircuitBreaker<number>({
    name: 'state-contract-swr-join',
    maxFailures: 2,
    cooldownMs: 40,
    cacheTtlMs: 5,
    persistCache: false,
  });

  await breaker.execute(async () => 1, 0, { cacheKey: 'A' });
  await sleep(10);

  let releaseA: () => void = () => {};
  const holdA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  let aCalls = 0;
  const staleReturn = breaker.execute(async () => {
    aCalls += 1;
    await holdA;
    return 2;
  }, 0, { cacheKey: 'A' });
  assert.equal(await staleReturn, 1);
  assert.equal(aCalls, 1);

  breaker.recordFailure('b1');
  breaker.recordFailure('b2');
  assert.equal(breaker.isOnCooldown(), true);
  await sleep(50);
  assert.equal(breaker.isOnCooldown(), false);

  const joined = await breaker.execute(async () => 3, 0, { cacheKey: 'A' });
  assert.equal(joined, 1, 'joining the in-flight SWR must still serve the stale cache');

  releaseA();
  await sleep(20);

  let laterCalls = 0;
  const later = await breaker.execute(async () => {
    laterCalls += 1;
    return 4;
  }, 0, { cacheKey: 'B' });
  assert.equal(later, 4);
  assert.equal(
    laterCalls,
    1,
    'after the joined SWR settles, other keys must still be able to contact upstream',
  );
});

test('a hung recovery probe times out, reopens cooldown, and unblocks later callers', async () => {
  clearAllCircuitBreakers();
  const breaker = createCircuitBreaker<number>({
    name: 'state-contract-probe-timeout',
    maxFailures: 2,
    cooldownMs: 20,
    persistCache: false,
    recoveryProbeTimeoutMs: 25,
  });

  breaker.recordFailure('first');
  breaker.recordFailure('second');
  await sleep(30);

  let releaseHung: () => void = () => {};
  const hung = new Promise<void>((resolve) => {
    releaseHung = resolve;
  });
  let hungCalls = 0;
  const probe = breaker.execute(async () => {
    hungCalls += 1;
    await hung;
    return 1;
  }, 0);

  assert.equal(await probe, 0);
  assert.equal(hungCalls, 1);
  assert.equal(
    breaker.isOnCooldown(),
    true,
    'a timed-out recovery probe must restore cooldown immediately',
  );

  await sleep(30);
  let laterCalls = 0;
  const later = await breaker.execute(async () => {
    laterCalls += 1;
    return 2;
  }, 0);
  assert.equal(later, 2);
  assert.equal(laterCalls, 1, 'timeout must clear the probe flag so a later execute can fetch');

  releaseHung();
  await sleep(10);
  assert.equal(
    breaker.getCached(),
    2,
    'a late hung-probe success must not overwrite the later live fetch',
  );
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
