// src/data/retryableLoad.test.mjs
// The bundled data packs memoize their load. This pins the half of that
// contract the two hand-rolled caches got wrong (roadmap L7): a failure must
// not be remembered, or one transient error downgrades the whole session.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RETRY_COOLDOWN_MAX_MS,
  RETRY_COOLDOWN_MS,
  createRetryableLoader,
} from './retryableLoad.js';

/** Controllable clock so cooldown assertions cost no wall time. */
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance(ms) { t += ms; } };
}

test('a successful load runs once and is shared by later callers', async () => {
  let calls = 0;
  const load = createRetryableLoader(async () => { calls += 1; return { pack: calls }; });
  const first = await load();
  const second = await load();
  assert.equal(calls, 1);
  assert.equal(first, second, 'the memoized value must be the same object');
});

test('concurrent callers share one in-flight load', async () => {
  let calls = 0;
  const load = createRetryableLoader(async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 1));
    return calls;
  });
  const [a, b, c] = await Promise.all([load(), load(), load()]);
  assert.equal(calls, 1);
  assert.deepEqual([a, b, c], [1, 1, 1]);
});

test('a failed load is not cached, but retries wait out a cooldown', async () => {
  const clock = fakeClock();
  let calls = 0;
  const load = createRetryableLoader(async () => {
    calls += 1;
    if (calls === 1) throw new Error('pack unavailable');
    return 'loaded';
  }, { now: clock.now });

  await assert.rejects(load(), /pack unavailable/);
  assert.equal(calls, 1);

  // Inside the cooldown a looping caller replays the recorded reason and
  // never touches the loader — one broken pack must not become a hot loop.
  clock.advance(RETRY_COOLDOWN_MS - 1);
  await assert.rejects(load(), /pack unavailable/);
  await assert.rejects(load(), /pack unavailable/);
  assert.equal(calls, 1, 'the cooldown must suppress the retry, not just slow it');

  clock.advance(1);
  assert.equal(await load(), 'loaded', 'a transient failure must not poison the session');
  assert.equal(calls, 2);
});

test('a success after the cooldown is cached permanently', async () => {
  const clock = fakeClock();
  let calls = 0;
  const load = createRetryableLoader(async () => {
    calls += 1;
    if (calls === 1) throw new Error('pack unavailable');
    return { pack: calls };
  }, { now: clock.now });

  await assert.rejects(load(), /pack unavailable/);
  clock.advance(RETRY_COOLDOWN_MS);
  const first = await load();
  clock.advance(RETRY_COOLDOWN_MAX_MS * 10);
  const second = await load();
  assert.equal(calls, 2, 'a recovered loader must never run again');
  assert.equal(first, second);
});

test('consecutive failures back off, capped at the ceiling', async () => {
  const clock = fakeClock();
  let calls = 0;
  const load = createRetryableLoader(async () => {
    calls += 1;
    throw new Error('pack unavailable');
  }, { now: clock.now, cooldownMs: 100, maxCooldownMs: 250 });

  await assert.rejects(load(), /pack unavailable/); // calls 1 → wait 100
  clock.advance(100);
  await assert.rejects(load(), /pack unavailable/); // calls 2 → wait 200
  clock.advance(100);
  await assert.rejects(load(), /pack unavailable/);
  assert.equal(calls, 2, 'the second cooldown is longer than the first');
  clock.advance(100);
  await assert.rejects(load(), /pack unavailable/); // calls 3 → wait 250 (capped)
  assert.equal(calls, 3);
  clock.advance(250);
  await assert.rejects(load(), /pack unavailable/);
  assert.equal(calls, 4, 'the backoff stops growing at the ceiling');
});

test('a falsy rejection still counts as a failure and still gets a cooldown', async () => {
  // The cooldown gate keys off an explicit flag, not the rejection value —
  // a loader rejecting with null/0/'' must not slip past it.
  for (const reason of [null, undefined, 0, '']) {
    const clock = fakeClock();
    let calls = 0;
    const load = createRetryableLoader(async () => {
      calls += 1;
      if (calls === 1) throw reason;
      return 'loaded';
    }, { now: clock.now });

    await assert.rejects(() => load(), (thrown) => thrown === reason || thrown === undefined);
    clock.advance(RETRY_COOLDOWN_MS - 1);
    await load().then(
      () => assert.fail(`a ${String(reason)} rejection bypassed the cooldown`),
      () => {},
    );
    assert.equal(calls, 1, `a ${String(reason)} rejection must not retry inside the cooldown`);
    clock.advance(1);
    assert.equal(await load(), 'loaded');
    assert.equal(calls, 2);
  }
});

test('a synchronous throw rejects and stays retryable', async () => {
  const clock = fakeClock();
  let calls = 0;
  const load = createRetryableLoader(() => {
    calls += 1;
    if (calls === 1) throw new Error('bad path');
    return 'loaded';
  }, { now: clock.now });
  await assert.rejects(load(), /bad path/);
  clock.advance(RETRY_COOLDOWN_MS);
  assert.equal(await load(), 'loaded');
});

test('every concurrent caller of a failing load sees the rejection, then retry succeeds', async () => {
  const clock = fakeClock();
  let calls = 0;
  const load = createRetryableLoader(async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (calls === 1) throw new Error('pack unavailable');
    return 'loaded';
  }, { now: clock.now });
  const results = await Promise.allSettled([load(), load()]);
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
  assert.equal(calls, 1, 'the failing load is still shared, not duplicated');
  clock.advance(RETRY_COOLDOWN_MS);
  assert.equal(await load(), 'loaded');
});
