import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';
process.env.WORLDMONITOR_VALID_KEYS = 'test-health-admin-key';

const { default: handler, __testing__ } = await import('../api/health.js');

const {
  HEALTH_VERDICT_SNAPSHOT_KEY: HEALTH_SNAPSHOT_KEY,
  HEALTH_VERDICT_COMPACT_SNAPSHOT_KEY: HEALTH_COMPACT_SNAPSHOT_KEY,
  buildCompactVerdictSnapshot,
  HEALTH_VERDICT_SNAPSHOT_TTL_SECONDS,
  HEALTH_VERDICT_REFRESH_LOCK_KEY: HEALTH_REFRESH_LOCK_KEY,
  HEALTH_VERDICT_REFRESH_WAIT_MS,
} = __testing__;
const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
const realDateNow = Date.now;

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
  Date.now = realDateNow;
});

function healthySnapshot(checkedAt = new Date().toISOString()) {
  return {
    status: 'HEALTHY',
    summary: { total: 1, ok: 1, warn: 0, onDemandWarn: 0, staleContent: 0, crit: 0 },
    checkedAt,
    checks: { example: { status: 'OK', records: 1 } },
  };
}

test('scopes health verdict Redis keys to non-production deployments', () => {
  const baseKey = 'health:verdict:v1';
  const lockBaseKey = `${baseKey}:refresh-lock`;

  assert.equal(__testing__.healthVerdictRedisKey(baseKey, undefined, undefined), baseKey);
  assert.equal(
    __testing__.healthVerdictRedisKey(baseKey, 'production', '1234567890abcdef'),
    baseKey,
  );
  assert.equal(
    __testing__.healthVerdictRedisKey(baseKey, 'preview', '1234567890abcdef'),
    'preview:12345678:health:verdict:v1',
  );
  assert.equal(
    __testing__.healthVerdictRedisKey(lockBaseKey, 'preview', undefined),
    'preview:dev:health:verdict:v1:refresh-lock',
  );
});

test('one sweep serves both callers, each from its own snapshot', async () => {
  // #5300: one sweep writes TWO snapshots — the full check map (operator reads) and
  // the compact body (?compact=1, the browser poll). Mock both.
  const snapshotStore = { [HEALTH_SNAPSHOT_KEY]: null, [HEALTH_COMPACT_SNAPSHOT_KEY]: null };
  const pipelineCalls = [];

  globalThis.fetch = async (_url, init) => {
    const commands = JSON.parse(init.body);
    pipelineCalls.push(commands);

    const results = commands.map(([op, key, value]) => {
      if (op === 'GET' && key in snapshotStore) {
        return { result: snapshotStore[key] };
      }
      if (op === 'STRLEN') return { result: 100 };
      if (op === 'LLEN') return { result: 1 };
      if (op === 'GET') {
        return { result: JSON.stringify({ fetchedAt: Date.now(), recordCount: 1 }) };
      }
      if (op === 'EXISTS') return { result: 0 };
      if (op === 'SET' && key in snapshotStore) {
        snapshotStore[key] = value;
        return { result: 'OK' };
      }
      return { result: 'OK' };
    });

    return new Response(JSON.stringify(results), { status: 200 });
  };

  const compactResponse = await handler(
    new Request('https://api.worldmonitor.app/api/health?compact=1'),
  );
  const compactBody = await compactResponse.json();

  const detailedResponse = await handler(
    new Request('https://api.worldmonitor.app/api/health', {
      headers: { 'x-worldmonitor-key': 'test-health-admin-key' },
    }),
  );
  const detailedBody = await detailedResponse.json();

  const sweepCalls = pipelineCalls.filter((commands) =>
    commands.some(([op]) => op === 'STRLEN' || op === 'LLEN'));
  assert.equal(sweepCalls.length, 1, 'two callers inside the TTL must share one full health sweep');

  // Each caller reads ONLY the snapshot it will render. The browser poll
  // (?compact=1) must not drag the full ~20 KB check map out of Redis to show a
  // tenth of it — that was ~2.2 GB/day of wasted egress (#5300).
  const readsOf = (key) => pipelineCalls.filter((commands) =>
    commands.length === 1 && commands[0][0] === 'GET' && commands[0][1] === key);
  assert.equal(readsOf(HEALTH_COMPACT_SNAPSHOT_KEY).length, 1, 'the compact caller reads the compact snapshot');
  assert.equal(readsOf(HEALTH_SNAPSHOT_KEY).length, 1, 'the detailed caller reads the full snapshot');

  // ...and ONE sweep persists both, in a single pipeline, so they cannot disagree.
  const writesOf = (key) => pipelineCalls.flat().filter((command) => command[0] === 'SET' && command[1] === key);
  assert.equal(writesOf(HEALTH_SNAPSHOT_KEY).length, 1);
  assert.equal(writesOf(HEALTH_COMPACT_SNAPSHOT_KEY).length, 1);
  for (const key of [HEALTH_SNAPSHOT_KEY, HEALTH_COMPACT_SNAPSHOT_KEY]) {
    assert.deepEqual(writesOf(key)[0].slice(3), ['EX', String(HEALTH_VERDICT_SNAPSHOT_TTL_SECONDS)]);
  }
  const persistPipeline = pipelineCalls.find((commands) =>
    commands.some(([op, key]) => op === 'SET' && key === HEALTH_SNAPSHOT_KEY));
  assert.ok(
    persistPipeline.some(([op, key]) => op === 'SET' && key === HEALTH_COMPACT_SNAPSHOT_KEY),
    'both snapshots must be written by the same sweep, in one pipeline',
  );

  // The stored compact snapshot is a fraction of the full one — the whole point.
  const storedFull = writesOf(HEALTH_SNAPSHOT_KEY)[0][2];
  const storedCompact = writesOf(HEALTH_COMPACT_SNAPSHOT_KEY)[0][2];
  assert.ok(storedCompact.length < storedFull.length, 'the compact snapshot must be smaller than the full one');
  assert.equal(JSON.parse(storedCompact).checks, undefined, 'the compact snapshot must not carry the check map');

  assert.equal(compactResponse.headers.get('Cache-Control'), 'no-store, max-age=0');
  assert.equal(detailedResponse.headers.get('Cache-Control'), 'private, no-store, max-age=0');
  assert.equal(compactBody.checkedAt, detailedBody.checkedAt, 'snapshot hit must expose the original check time');
  assert.ok(!Object.hasOwn(compactBody, 'checks'), 'public compact shape stays compact');
  assert.ok(Object.hasOwn(detailedBody, 'checks'), 'authenticated detailed shape is derived from the same snapshot');
});

test('rejects malformed or older-than-TTL snapshots', () => {
  const now = Date.now();
  const validShape = {
    status: 'HEALTHY',
    summary: { total: 1, ok: 1, warn: 0, onDemandWarn: 0, staleContent: 0, crit: 0 },
    checkedAt: new Date(now - 30_000).toISOString(),
    checks: { example: { status: 'OK', records: 1 } },
  };

  assert.deepEqual(
    __testing__.parseHealthVerdictSnapshot(JSON.stringify(validShape), now),
    validShape,
  );
  assert.equal(
    __testing__.parseHealthVerdictSnapshot(JSON.stringify({
      ...validShape,
      checkedAt: new Date(now - (HEALTH_VERDICT_SNAPSHOT_TTL_SECONDS * 1_000 + 1)).toISOString(),
    }), now),
    null,
    'a lingering Redis key must not extend verdict staleness past the configured TTL',
  );
  assert.equal(__testing__.parseHealthVerdictSnapshot('{not-json', now), null);
});

test('coalesces concurrent cache misses into one full sweep', async () => {
  // #5300: one sweep writes TWO snapshots — the full check map (operator reads) and
  // the compact body (?compact=1, the browser poll). Mock both.
  const snapshotStore = { [HEALTH_SNAPSHOT_KEY]: null, [HEALTH_COMPACT_SNAPSHOT_KEY]: null };
  let refreshLocked = false;
  const pipelineCalls = [];

  globalThis.fetch = async (_url, init) => {
    const commands = JSON.parse(init.body);
    pipelineCalls.push(commands);

    if (commands.some(([op]) => op === 'STRLEN' || op === 'LLEN')) {
      // Longer than the old fixed 2s waiter window: followers must still wait
      // for the lock owner rather than falling through to a duplicate sweep.
      await new Promise((resolve) => setTimeout(resolve, 2_100));
    }

    const results = commands.map(([op, key, value]) => {
      if (op === 'GET' && key in snapshotStore) return { result: snapshotStore[key] };
      if (op === 'SET' && key === HEALTH_REFRESH_LOCK_KEY) {
        if (refreshLocked) return { result: null };
        refreshLocked = true;
        return { result: 'OK' };
      }
      if (op === 'STRLEN') return { result: 100 };
      if (op === 'LLEN') return { result: 1 };
      if (op === 'GET') {
        return { result: JSON.stringify({ fetchedAt: Date.now(), recordCount: 1 }) };
      }
      if (op === 'EXISTS') return { result: 0 };
      if (op === 'SET' && key in snapshotStore) {
        snapshotStore[key] = value;
        return { result: 'OK' };
      }
      return { result: 'OK' };
    });

    return new Response(JSON.stringify(results), { status: 200 });
  };

  const [first, second] = await Promise.all([
    handler(new Request('https://api.worldmonitor.app/api/health?compact=1')),
    handler(new Request('https://api.worldmonitor.app/api/health?compact=1')),
  ]);
  const [firstBody, secondBody] = await Promise.all([first.json(), second.json()]);

  const sweepCalls = pipelineCalls.filter((commands) =>
    commands.some(([op]) => op === 'STRLEN' || op === 'LLEN'));
  assert.equal(sweepCalls.length, 1, 'a cold burst must elect one snapshot refresher');
  assert.equal(firstBody.checkedAt, secondBody.checkedAt);
});

test('projects only failing checks from a cached compact snapshot', async () => {
  const snapshot = {
    ...healthySnapshot(),
    status: 'WARNING',
    summary: { total: 3, ok: 2, warn: 1, onDemandWarn: 0, staleContent: 0, crit: 0 },
    checks: {
      healthy: { status: 'OK', records: 1 },
      cascade: { status: 'OK_CASCADE', records: 1 },
      delayed: { status: 'STALE_SEED', seedAgeMin: 30 },
    },
  };
  // The problems are now projected ONCE, at sweep time, into the compact snapshot —
  // so the browser poll reads ~1 KB instead of the full check map (#5300). A compact
  // caller must therefore read the compact key, and must never touch the full one.
  const compactSnapshot = buildCompactVerdictSnapshot(snapshot);
  globalThis.fetch = async (_url, init) => {
    const commands = JSON.parse(init.body);
    assert.deepEqual(commands, [['GET', HEALTH_COMPACT_SNAPSHOT_KEY]],
      'a ?compact=1 caller must read the compact snapshot, never the full check map');
    return new Response(JSON.stringify([{ result: JSON.stringify(compactSnapshot) }]), { status: 200 });
  };

  const response = await handler(new Request('https://api.worldmonitor.app/api/health?compact=1'));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.problems, { delayed: snapshot.checks.delayed });
  assert.ok(!Object.hasOwn(body, 'checks'));
  assert.equal(body.checkedAt, snapshot.checkedAt);
  // The stored form carries only the problems, not all three checks.
  assert.equal(compactSnapshot.checks, undefined);
  assert.deepEqual(Object.keys(compactSnapshot.problems), ['delayed']);
});

test('takes over refresh after the prior lock owner disappears', async () => {
  let lockAttempts = 0;
  let sweepCount = 0;
  globalThis.setTimeout = (resolve) => {
    resolve();
    return 0;
  };
  globalThis.fetch = async (_url, init) => {
    const commands = JSON.parse(init.body);
    if (commands.some(([op]) => op === 'STRLEN' || op === 'LLEN')) sweepCount++;
    const results = commands.map(([op, key]) => {
      if (op === 'GET' && key === HEALTH_SNAPSHOT_KEY) return { result: null };
      if (op === 'SET' && key === HEALTH_REFRESH_LOCK_KEY) {
        lockAttempts++;
        return { result: lockAttempts === 1 ? null : 'OK' };
      }
      if (op === 'STRLEN') return { result: 100 };
      if (op === 'LLEN') return { result: 1 };
      if (op === 'GET') return { result: JSON.stringify({ fetchedAt: Date.now(), recordCount: 1 }) };
      if (op === 'EXISTS') return { result: 0 };
      return { result: 'OK' };
    });
    return new Response(JSON.stringify(results), { status: 200 });
  };

  const response = await handler(new Request('https://api.worldmonitor.app/api/health?compact=1'));

  assert.equal(response.status, 200);
  assert.equal(lockAttempts, 2);
  assert.equal(sweepCount, 1);
});

test('does not report REDIS_DOWN when a healthy Redis lock stays contended', async () => {
  let sweepCount = 0;
  globalThis.setTimeout = (resolve) => {
    resolve();
    return 0;
  };
  globalThis.fetch = async (_url, init) => {
    const commands = JSON.parse(init.body);
    if (commands.some(([op]) => op === 'STRLEN' || op === 'LLEN')) sweepCount++;
    const results = commands.map(([op, key]) => {
      if (op === 'GET' && key === HEALTH_SNAPSHOT_KEY) return { result: null };
      if (op === 'SET' && key === HEALTH_REFRESH_LOCK_KEY) return { result: null };
      if (op === 'STRLEN') return { result: 100 };
      if (op === 'LLEN') return { result: 1 };
      if (op === 'GET') return { result: JSON.stringify({ fetchedAt: Date.now(), recordCount: 1 }) };
      if (op === 'EXISTS') return { result: 0 };
      return { result: 'OK' };
    });
    return new Response(JSON.stringify(results), { status: 200 });
  };

  const response = await handler(new Request('https://api.worldmonitor.app/api/health?compact=1'));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.notEqual(body.status, 'REDIS_DOWN');
  assert.equal(sweepCount, 1, 'bounded contention fallback performs one direct sweep');
});

test('does not start a doomed Redis request at the contention deadline', async () => {
  let fakeNow = realDateNow();
  let snapshotReads = 0;
  let sweepCount = 0;
  Date.now = () => fakeNow;
  globalThis.setTimeout = (resolve) => {
    fakeNow += HEALTH_VERDICT_REFRESH_WAIT_MS - 1;
    resolve();
    return 0;
  };
  globalThis.fetch = async (_url, init) => {
    const commands = JSON.parse(init.body);
    if (commands.some(([op]) => op === 'STRLEN' || op === 'LLEN')) sweepCount++;
    if (commands.length === 1 && commands[0][0] === 'GET' && (commands[0][1] === HEALTH_SNAPSHOT_KEY || commands[0][1] === HEALTH_COMPACT_SNAPSHOT_KEY)) {
      snapshotReads++;
      if (snapshotReads > 1) {
        return new Response(null, { status: 504 });
      }
      return new Response(JSON.stringify([{ result: null }]), { status: 200 });
    }
    const results = commands.map(([op, key]) => {
      if (op === 'SET' && key === HEALTH_REFRESH_LOCK_KEY) return { result: null };
      if (op === 'STRLEN') return { result: 100 };
      if (op === 'LLEN') return { result: 1 };
      if (op === 'GET') return { result: JSON.stringify({ fetchedAt: Date.now(), recordCount: 1 }) };
      if (op === 'EXISTS') return { result: 0 };
      return { result: 'OK' };
    });
    return new Response(JSON.stringify(results), { status: 200 });
  };

  const response = await handler(new Request('https://api.worldmonitor.app/api/health?compact=1'));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.notEqual(body.status, 'REDIS_DOWN');
  assert.equal(snapshotReads, 1, 'near-deadline contention must skip a doomed Redis HTTP request');
  assert.equal(sweepCount, 1, 'near-deadline contention falls back to one direct sweep');
});

test('releases its refresh lock when snapshot persistence fails', async () => {
  // #5300: one sweep writes TWO snapshots — the full check map (operator reads) and
  // the compact body (?compact=1, the browser poll). Mock both.
  const snapshotStore = { [HEALTH_SNAPSHOT_KEY]: null, [HEALTH_COMPACT_SNAPSHOT_KEY]: null };
  let refreshLockToken = null;
  let snapshotWriteAttempts = 0;
  let sweepCount = 0;
  globalThis.fetch = async (_url, init) => {
    const commands = JSON.parse(init.body);
    if (commands.some(([op]) => op === 'STRLEN' || op === 'LLEN')) sweepCount++;

    // A sweep persists BOTH snapshots in one pipeline (#5300), so a failed
    // persistence attempt fails the pair. Failing only one would leave a usable
    // compact snapshot behind, and the next caller would rightly serve it instead
    // of re-sweeping — which is not the path this test is probing.
    const isSnapshotPersist = commands.some(([op, key]) => op === 'SET' && key === HEALTH_SNAPSHOT_KEY);
    let failThisWriteAttempt = false;
    if (isSnapshotPersist) {
      snapshotWriteAttempts++;
      failThisWriteAttempt = snapshotWriteAttempts === 1;
    }

    const results = commands.map(([op, key, value]) => {
      if (op === 'GET' && key in snapshotStore) return { result: snapshotStore[key] };
      if (op === 'SET' && key === HEALTH_REFRESH_LOCK_KEY) {
        if (refreshLockToken) return { result: null };
        refreshLockToken = value;
        return { result: 'OK' };
      }
      if (op === 'EVAL') {
        if (commands[0][4] === refreshLockToken) refreshLockToken = null;
        return { result: 1 };
      }
      if (op === 'SET' && key in snapshotStore) {
        if (failThisWriteAttempt) return { error: 'transient write failure' };
        snapshotStore[key] = value;
        return { result: 'OK' };
      }
      if (op === 'STRLEN') return { result: 100 };
      if (op === 'LLEN') return { result: 1 };
      if (op === 'GET') return { result: JSON.stringify({ fetchedAt: Date.now(), recordCount: 1 }) };
      if (op === 'EXISTS') return { result: 0 };
      return { result: 'OK' };
    });
    return new Response(JSON.stringify(results), { status: 200 });
  };

  const first = await handler(new Request('https://api.worldmonitor.app/api/health?compact=1'));
  const second = await handler(new Request('https://api.worldmonitor.app/api/health?compact=1'));

  assert.equal(first.status, 200, 'a live verdict remains usable when only memoization fails');
  assert.equal(second.status, 200);
  assert.equal(snapshotWriteAttempts, 2, 'the next request retries immediately after lock release');
  assert.equal(sweepCount, 2);
});

test('validates snapshot age after the Redis read completes', async () => {
  let fakeNow = realDateNow();
  const almostExpired = healthySnapshot(new Date(fakeNow - 59_000).toISOString());
  let sweepCount = 0;
  Date.now = () => fakeNow;
  globalThis.fetch = async (_url, init) => {
    const commands = JSON.parse(init.body);
    if (commands.length === 1 && commands[0][0] === 'GET' && commands[0][1] === HEALTH_SNAPSHOT_KEY) {
      fakeNow += 2_000;
      return new Response(JSON.stringify([{ result: JSON.stringify(almostExpired) }]), { status: 200 });
    }
    if (commands.some(([op]) => op === 'STRLEN' || op === 'LLEN')) sweepCount++;
    const results = commands.map(([op]) => {
      if (op === 'STRLEN') return { result: 100 };
      if (op === 'LLEN') return { result: 1 };
      if (op === 'GET') return { result: JSON.stringify({ fetchedAt: Date.now(), recordCount: 1 }) };
      if (op === 'EXISTS') return { result: 0 };
      return { result: 'OK' };
    });
    return new Response(JSON.stringify(results), { status: 200 });
  };

  const response = await handler(new Request('https://api.worldmonitor.app/api/health?compact=1'));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(sweepCount, 1, 'a snapshot that expires in flight must be recomputed');
  assert.notEqual(body.checkedAt, almostExpired.checkedAt);
});
