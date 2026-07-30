// Regression tests for issue #5478 (strands 2 + 3): the tone/vol timeline
// keys must survive a multi-day GDELT brownout, and the seeder must expose a
// content-age signal so cache-merge coasting is visible to /api/health.
//
// Strand 2 background: TIMELINE_TTL was 12h (2x the 6h cron) — sized for one
// missed tick, not a brownout. During the 2026-07 GDELT outage every run's
// timeline fetch came back empty, the per-run EXPIRE-extend kept last-good
// alive only until the first sequence of failed runs crossed 12h, and then
// all 12 gdelt:intel:{tone,vol}:* keys expired (verified 2026-07-23: every
// key EXISTS=0). Once expired, EXPIRE is a no-op and nothing re-seeds them.
// Also: a timeline writeExtraKey exhausting its retries crashed the whole
// run AFTER the canonical publish had already succeeded.
//
// Strand 3 background: the cache-merge fallback republishes weeks-old
// articles under a fresh envelope fetchedAt, so seed-meta age never trips.
// Per-topic fetchedAt is the honest coasting signal — contentMeta feeds it
// to the health classifier via the content-age trio (STALE_CONTENT).

import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

const {
  afterPublish,
  contentMeta,
  fetchTopicTimeline,
  repairTimelines,
  runCli,
  runTimelineRepair,
  GDELT_LOCK_TTL_MS,
  TIMELINE_TTL,
  RUN_SEED_OPTS,
} =
  await import('../scripts/seed-gdelt-intel.mjs');

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalWarn = console.warn;

let calls;
let warns;

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200 });
}

function abortError() {
  const err = new Error('The operation was aborted due to timeout');
  err.name = 'AbortError';
  return err;
}

beforeEach(() => {
  calls = [];
  warns = [];
  console.warn = (...args) => { warns.push(args.join(' ')); };
  globalThis.setTimeout = (cb, ms, ...args) =>
    originalSetTimeout(cb, ms >= 500 ? 0 : ms, ...args);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  console.warn = originalWarn;
});

// ---------- strand 2: TTL sized for brownouts ----------

test('TIMELINE_TTL is brownout-scale (7 days), not one-missed-tick-scale', () => {
  assert.equal(TIMELINE_TTL, 604800,
    '12h TTL dies on the first >12h GDELT outage; the per-run EXPIRE-extend keeps last-good alive up to the TTL, so the TTL must cover a realistic brownout');
});

test('afterPublish writes fresh timelines with the brownout-scale TTL and the RUN-level fetchedAt', async () => {
  globalThis.fetch = async (url, opts = {}) => {
    const body = opts?.body ? JSON.parse(opts.body) : null;
    calls.push({ u: String(url), body });
    if (String(url).endsWith('/pipeline')) return jsonResponse(body.map(() => ({ result: 1 })));
    return jsonResponse({ result: 'OK' });
  };

  // topic.fetchedAt is COASTED (articles 429'd and were backfilled from the
  // previous snapshot) but the timeline succeeded THIS run — the write must
  // carry the run-level fetchedAt, or the cross-source 48h signal-grade guard
  // would suppress a genuinely fresh series.
  await afterPublish({
    fetchedAt: '2026-07-23T08:00:00.000Z',
    topics: [{ id: 'military', fetchedAt: '2026-07-01T00:00:00.000Z', _tone: [{ date: '20260723', value: -2.1 }], _vol: [] }],
  });

  const toneSet = calls.find((c) => Array.isArray(c.body) && c.body[0] === 'SET' && c.body[1] === 'gdelt:intel:tone:military');
  assert.ok(toneSet, 'fresh tone timeline must be written');
  assert.equal(toneSet.body[4], 604800, 'timeline SET must carry the brownout-scale TTL');
  assert.equal(JSON.parse(toneSet.body[2]).fetchedAt, '2026-07-23T08:00:00.000Z',
    'a timeline fetched this run must be stamped with the run-level fetchedAt, not the coasted article time');
  const expire = calls.find((c) => Array.isArray(c.body) && Array.isArray(c.body[0]));
  assert.ok(expire, 'empty vol timeline must fall back to EXPIRE-extend');
  assert.deepEqual(expire.body[0], ['EXPIRE', 'gdelt:intel:vol:military', 604800],
    'EXPIRE-extend must also use the brownout-scale TTL');
});

test('afterPublish reports DEGRADED when an empty timeline cannot extend an absent key', async () => {
  globalThis.fetch = async (url, opts = {}) => {
    const body = opts?.body ? JSON.parse(opts.body) : null;
    calls.push({ u: String(url), body });
    if (String(url).endsWith('/pipeline')) return jsonResponse(body.map(() => ({ result: 0 })));
    return jsonResponse({ result: 'OK' });
  };

  const outcome = await afterPublish({
    fetchedAt: '2026-07-27T17:14:00.000Z',
    topics: [{
      id: 'military',
      _tone: [{ date: '20260727', value: -1.5 }],
      _vol: [],
    }],
  });

  assert.equal(outcome.completionState, 'DEGRADED');
  assert.deepEqual(outcome.freshnessMetaPatch, {
    status: 'error',
    errorReason: 'timeline_keys_missing_or_unconfirmed',
    missingTimelineKeys: ['gdelt:intel:vol:military'],
  });
  assert.ok(
    warns.some((warning) => warning.includes('node scripts/seed-gdelt-intel.mjs --repair-timelines')),
    `the warning must name the runnable repair command; warnings were: ${JSON.stringify(warns)}`,
  );
});

test('afterPublish reports only the failed key from mixed EXPIRE results', async () => {
  globalThis.fetch = async (url, opts = {}) => {
    const body = opts?.body ? JSON.parse(opts.body) : null;
    calls.push({ u: String(url), body });
    if (String(url).endsWith('/pipeline')) {
      return jsonResponse(body.map((_, index) => ({ result: index === 0 ? 1 : 0 })));
    }
    return jsonResponse({ result: 'OK' });
  };

  const outcome = await afterPublish({
    fetchedAt: '2026-07-27T17:14:00.000Z',
    topics: [
      { id: 'military', _tone: [{ date: '20260727', value: -1.5 }], _vol: [] },
      { id: 'cyber', _tone: [{ date: '20260727', value: -2.5 }], _vol: [] },
    ],
  });

  assert.equal(outcome.completionState, 'DEGRADED');
  assert.deepEqual(outcome.freshnessMetaPatch.missingTimelineKeys, ['gdelt:intel:vol:cyber']);
});

test('afterPublish surfaces the bounded transport code even while last-good timelines survive', async () => {
  globalThis.fetch = async (url, opts = {}) => {
    const body = opts?.body ? JSON.parse(opts.body) : null;
    calls.push({ u: String(url), body });
    if (String(url).endsWith('/pipeline')) return jsonResponse(body.map(() => ({ result: 1 })));
    return jsonResponse({ result: 'OK' });
  };

  const outcome = await afterPublish({
    fetchedAt: '2026-07-29T08:00:00.000Z',
    _gdeltFailureCode: 'GDELT_SHARED_PROXY_TLS',
    _freshTopicCount: 0,
    topics: [{ id: 'military', _tone: [], _vol: [] }],
  });

  assert.deepEqual(outcome, {
    completionState: 'DEGRADED',
    freshnessMetaPatch: {
      status: 'error',
      errorReason: 'gdelt_upstream_unavailable',
      errorCode: 'GDELT_SHARED_PROXY_TLS',
      freshTopicCount: 0,
    },
  });
});

test('fetchTopicTimeline keeps normal fetches best-effort but rethrows in strict repair mode', async () => {
  const exhausted = new Error('GDELT exhausted after proxy attempts: HTTP 429');
  const topic = { id: 'military', query: 'military sourcelang:eng' };
  const bestEffort = await fetchTopicTimeline(topic, 'TimelineTone', {
    _fetchJson: async () => { throw exhausted; },
  });
  assert.deepEqual(bestEffort, []);
  await assert.rejects(
    fetchTopicTimeline(topic, 'TimelineTone', {
      strict: true,
      _fetchJson: async () => { throw exhausted; },
    }),
    /HTTP 429/,
  );
});

test('repairTimelines recreates all 12 absent tone/vol keys with non-empty data and the timeline TTL', async () => {
  const written = new Map();
  const result = await repairTimelines({
    _readTimeline: async () => null,
    _fetchTimeline: async (topic, mode) => [{
      date: '20260727',
      value: mode === 'TimelineTone' ? -1 : 10,
      topic: topic.id,
    }],
    _writeTimeline: async (key, value, ttl) => { written.set(key, { value, ttl }); },
    _extendTtl: async () => true,
    _sleep: async () => {},
    _interRequestDelayMs: 0,
    _now: () => Date.parse('2026-07-27T17:14:00.000Z'),
  });

  assert.equal(result.completionState, 'OK');
  assert.equal(result.repairedCount, 12);
  assert.deepEqual(result.failedKeys, []);
  assert.equal(written.size, 12);
  for (const topic of ['military', 'cyber', 'nuclear', 'sanctions', 'intelligence', 'maritime']) {
    for (const series of ['tone', 'vol']) {
      const key = `gdelt:intel:${series}:${topic}`;
      assert.equal(written.get(key)?.ttl, TIMELINE_TTL, `${key} must carry a non-negative brownout-scale TTL`);
      assert.ok(written.get(key)?.value?.data?.length > 0, `${key} must contain repaired timeline data`);
    }
  }
});

test('repairTimelines does not report OK when any absent key cannot be fetched', async () => {
  const result = await repairTimelines({
    _readTimeline: async () => null,
    _fetchTimeline: async (topic, mode) =>
      topic.id === 'maritime' && mode === 'TimelineVol'
        ? Promise.reject(new Error('GDELT exhausted after proxy attempts: HTTP 429'))
        : [{ date: '20260727', value: 1 }],
    _writeTimeline: async () => {},
    _extendTtl: async () => true,
    _sleep: async () => {},
    _interRequestDelayMs: 0,
  });

  assert.equal(result.completionState, 'DEGRADED');
  assert.deepEqual(result.failedKeys, ['gdelt:intel:vol:maritime']);
  assert.ok(
    warns.some((warning) =>
      warning.includes('gdelt:intel:vol:maritime')
      && warning.includes('GDELT exhausted after proxy attempts: HTTP 429')),
    `repair warning must retain the exhausted fetch error; warnings were: ${JSON.stringify(warns)}`,
  );
});

test('repairTimelines opens a circuit after the first transport failure', async () => {
  let fetchCount = 0;
  const transportError = Object.assign(new Error('SSL_ERROR_SYSCALL'), {
    code: 'GDELT_SHARED_PROXY_TLS',
  });
  const result = await repairTimelines({
    _readTimeline: async () => null,
    _fetchTimeline: async () => {
      fetchCount += 1;
      throw transportError;
    },
    _writeTimeline: async () => assert.fail('failed transport must not write'),
    _extendTtl: async () => false,
    _sleep: async () => {},
    _interRequestDelayMs: 0,
  });

  assert.equal(fetchCount, 1, 'the remaining eleven keys must not repeat the failed route');
  assert.equal(result.completionState, 'DEGRADED');
  assert.equal(result.errorCode, 'GDELT_SHARED_PROXY_TLS');
  assert.equal(result.failedKeys.length, 12);
});

test('repairTimelines preserves existing data when TTL extension succeeds and repairs when it fails', async () => {
  const extendedKeys = [];
  const fetchedKeys = [];
  const writtenKeys = [];
  const failedExtensionKey = 'gdelt:intel:vol:military';
  const result = await repairTimelines({
    _readTimeline: async () => ({ data: [{ date: '20260726', value: 1 }] }),
    _extendTtl: async ([key]) => {
      extendedKeys.push(key);
      return key !== failedExtensionKey;
    },
    _fetchTimeline: async (topic, mode) => {
      fetchedKeys.push(`gdelt:intel:${mode === 'TimelineTone' ? 'tone' : 'vol'}:${topic.id}`);
      return [{ date: '20260727', value: 2 }];
    },
    _writeTimeline: async (key) => { writtenKeys.push(key); },
    _sleep: async () => {},
    _interRequestDelayMs: 0,
  });

  assert.equal(result.completionState, 'OK');
  assert.equal(result.preservedCount, 11);
  assert.equal(result.repairedCount, 1);
  assert.ok(result.preservedKeys.includes('gdelt:intel:tone:military'));
  assert.ok(!result.preservedKeys.includes(failedExtensionKey));
  assert.equal(extendedKeys.length, 12, 'every existing timeline must have its TTL checked');
  assert.deepEqual(fetchedKeys, [failedExtensionKey],
    'a successfully extended key must not be fetched, while a failed extension falls through');
  assert.deepEqual(writtenKeys, [failedExtensionKey],
    'only the key whose extension failed must be freshly written');
});

test('repairTimelines records a write failure and continues repairing later keys', async () => {
  const failedKey = 'gdelt:intel:vol:military';
  const writeAttempts = [];
  const result = await repairTimelines({
    _readTimeline: async () => null,
    _fetchTimeline: async () => [{ date: '20260727', value: 1 }],
    _writeTimeline: async (key) => {
      writeAttempts.push(key);
      if (key === failedKey) throw new Error('Redis SET failed');
    },
    _extendTtl: async () => true,
    _sleep: async () => {},
    _interRequestDelayMs: 0,
  });

  assert.equal(result.completionState, 'DEGRADED');
  assert.deepEqual(result.failedKeys, [failedKey]);
  assert.ok(!result.repairedKeys.includes(failedKey));
  assert.equal(result.repairedCount, 11);
  assert.ok(result.repairedKeys.includes('gdelt:intel:vol:maritime'),
    'the final key must still be repaired after the earlier write failure');
  assert.ok(writeAttempts.indexOf('gdelt:intel:vol:maritime') > writeAttempts.indexOf(failedKey));
});

test('repairTimelines paces every fetch after the first with exactly one configured delay', async () => {
  const delayMs = 37;
  const events = [];
  const result = await repairTimelines({
    _readTimeline: async () => null,
    _fetchTimeline: async (topic, mode) => {
      events.push(`fetch:${mode}:${topic.id}`);
      return [{ date: '20260727', value: 1 }];
    },
    _writeTimeline: async () => {},
    _extendTtl: async () => true,
    _sleep: async (ms) => { events.push(`sleep:${ms}`); },
    _interRequestDelayMs: delayMs,
  });

  assert.equal(result.completionState, 'OK');
  assert.equal(events[0], 'fetch:TimelineTone:military', 'the first fetch must start without a delay');
  assert.equal(events.length, 23, '12 fetches must have exactly 11 intervening sleeps');
  for (let fetchIndex = 1; fetchIndex < 12; fetchIndex++) {
    assert.equal(events[(fetchIndex * 2) - 1], `sleep:${delayMs}`);
    assert.match(events[fetchIndex * 2], /^fetch:/);
  }
});

test('runCli selects only timeline repair and maps its result to an exit code', async () => {
  for (const [completionState, expectedExitCode] of [['OK', 0], ['DEGRADED', 1]]) {
    let repairCalls = 0;
    const exitCode = await runCli(['--repair-timelines'], {
      _runTimelineRepair: async () => {
        repairCalls += 1;
        return { completionState };
      },
      _runSeed: async () => assert.fail('repair CLI must not run the normal seeder'),
    });
    assert.equal(exitCode, expectedExitCode);
    assert.equal(repairCalls, 1);
  }
});

test('runCli without the repair flag selects only the normal seed path', async () => {
  let seedArgs;
  const exitCode = await runCli([], {
    _runTimelineRepair: async () => assert.fail('normal CLI must not run timeline repair'),
    _runSeed: async (...args) => { seedArgs = args; },
  });

  assert.equal(exitCode, 0);
  assert.equal(seedArgs[0], 'intelligence');
  assert.equal(seedArgs[1], 'gdelt-intel');
  assert.equal(seedArgs[2], 'intelligence:gdelt-intel:v1');
  assert.equal(typeof seedArgs[3], 'function');
  assert.equal(seedArgs[4], RUN_SEED_OPTS);
});

test('runTimelineRepair holds the scheduled-seed lock through metadata reconciliation and clears only timeline errors', async () => {
  const order = [];
  let lockArgs;
  let lockExpiresAt;
  let simulatedNow = 0;
  let writtenMeta;
  let writtenTtl;
  const currentMeta = {
    fetchedAt: 1_722_090_000_000,
    recordCount: 6,
    sourceVersion: 'gdelt-doc-v2',
    newestItemAt: 1_722_080_000_000,
    oldestItemAt: 1_722_000_000_000,
    maxContentAgeMin: 1440,
    status: 'error',
    errorReason: 'timeline_keys_missing_or_unconfirmed',
    missingTimelineKeys: ['gdelt:intel:vol:military'],
  };
  const result = await runTimelineRepair({
    _runId: () => 'repair-test',
    _acquireLock: async (...args) => {
      order.push('acquire');
      lockArgs = args;
      lockExpiresAt = simulatedNow + args[2];
      return { locked: true, skipped: false, reason: null };
    },
    _repair: async () => {
      order.push('repair');
      // Exercise the degraded-path wall-clock envelope rather than merely
      // checking that the lease exceeds an arbitrary lower bound. Twelve
      // sequential Redis reads, strict GDELT fetches, retried writes, pacing,
      // and metadata I/O can consume about 75 minutes under capped
      // Retry-After responses.
      simulatedNow += 75 * 60_000;
      assert.ok(simulatedNow < lockExpiresAt,
        'repair ownership must still be live after the bounded worst-case retry envelope');
      return {
        completionState: 'OK',
        repairedCount: 1,
        preservedCount: 11,
        repairedKeys: ['gdelt:intel:vol:military'],
        preservedKeys: [],
        failedKeys: [],
      };
    },
    _readMeta: async () => {
      order.push('read-meta');
      return currentMeta;
    },
    _writeMeta: async (meta, ttl) => {
      order.push('write-meta');
      writtenMeta = meta;
      writtenTtl = ttl;
    },
    _releaseLock: async () => { order.push('release'); },
  });

  assert.equal(result.completionState, 'OK');
  assert.equal(result.metadataReconciled, true);
  assert.deepEqual(order, ['acquire', 'repair', 'read-meta', 'write-meta', 'release']);
  assert.equal(lockArgs[0], 'intelligence:gdelt-intel');
  assert.equal(lockArgs[1], 'repair-test');
  assert.equal(lockArgs[2], GDELT_LOCK_TTL_MS);
  assert.equal(writtenTtl, 7 * 86400);
  assert.deepEqual(writtenMeta, {
    fetchedAt: currentMeta.fetchedAt,
    recordCount: 6,
    sourceVersion: 'gdelt-doc-v2',
    newestItemAt: currentMeta.newestItemAt,
    oldestItemAt: currentMeta.oldestItemAt,
    maxContentAgeMin: 1440,
  });
});

test('runTimelineRepair preserves an unrelated health error after a full timeline repair', async () => {
  let writtenMeta;
  const result = await runTimelineRepair({
    _acquireLock: async () => ({ locked: true, skipped: false, reason: null }),
    _repair: async () => ({
      completionState: 'OK',
      repairedCount: 0,
      preservedCount: 12,
      repairedKeys: [],
      preservedKeys: [],
      failedKeys: [],
    }),
    _readMeta: async () => ({
      fetchedAt: 1,
      recordCount: 6,
      status: 'error',
      errorReason: 'article_source_unavailable',
      missingTimelineKeys: ['gdelt:intel:tone:cyber'],
    }),
    _writeMeta: async (meta) => { writtenMeta = meta; },
    _releaseLock: async () => {},
  });

  assert.equal(result.completionState, 'OK');
  assert.deepEqual(writtenMeta, {
    fetchedAt: 1,
    recordCount: 6,
    status: 'error',
    errorReason: 'article_source_unavailable',
  });
});

test('runTimelineRepair persists exact failed keys on a partial repair', async () => {
  let writtenMeta;
  const failedKeys = ['gdelt:intel:tone:nuclear', 'gdelt:intel:vol:maritime'];
  const result = await runTimelineRepair({
    _acquireLock: async () => ({ locked: true, skipped: false, reason: null }),
    _repair: async () => ({
      completionState: 'DEGRADED',
      repairedCount: 10,
      preservedCount: 0,
      repairedKeys: [],
      preservedKeys: [],
      failedKeys,
    }),
    _readMeta: async () => ({
      fetchedAt: 1_722_090_000_000,
      recordCount: 6,
      sourceVersion: 'gdelt-doc-v2',
      status: 'error',
      errorReason: 'article_source_unavailable',
      missingTimelineKeys: ['stale-key'],
    }),
    _writeMeta: async (meta) => { writtenMeta = meta; },
    _releaseLock: async () => {},
  });

  assert.equal(result.completionState, 'DEGRADED');
  assert.equal(result.metadataReconciled, true);
  assert.deepEqual(writtenMeta, {
    fetchedAt: 1_722_090_000_000,
    recordCount: 6,
    sourceVersion: 'gdelt-doc-v2',
    status: 'error',
    errorReason: 'article_source_unavailable',
    missingTimelineKeys: failedKeys,
  });
});

for (const [label, metaDeps, expectedError] of [
  [
    'absent metadata',
    { _readMeta: async () => null, _writeMeta: async () => assert.fail('must not write absent metadata') },
    /absent or unreadable/,
  ],
  [
    'metadata persistence failure',
    {
      _readMeta: async () => ({ fetchedAt: 1, recordCount: 6 }),
      _writeMeta: async () => { throw new Error('Redis SET failed'); },
    },
    /Redis SET failed/,
  ],
]) {
  test(`runTimelineRepair degrades on ${label} and still releases the lock`, async () => {
    let released = false;
    const result = await runTimelineRepair({
      _acquireLock: async () => ({ locked: true, skipped: false, reason: null }),
      _repair: async () => ({
        completionState: 'OK',
        repairedCount: 12,
        preservedCount: 0,
        repairedKeys: [],
        preservedKeys: [],
        failedKeys: [],
      }),
      ...metaDeps,
      _releaseLock: async () => { released = true; },
    });

    assert.equal(result.completionState, 'DEGRADED');
    assert.match(result.metadataError, expectedError);
    assert.equal(released, true);
  });
}

for (const [label, lockResult, expectedReason] of [
  ['contention', { locked: false, skipped: false, reason: null }, 'lock_contended'],
  ['Redis unavailability', { locked: false, skipped: true, reason: 'redis_unavailable' }, 'redis_unavailable'],
]) {
  test(`runTimelineRepair returns DEGRADED without repairing on lock ${label}`, async () => {
    let repaired = false;
    const result = await runTimelineRepair({
      _acquireLock: async () => lockResult,
      _repair: async () => {
        repaired = true;
        return {};
      },
      _releaseLock: async () => assert.fail('must not release a lock that was not acquired'),
    });

    assert.equal(result.completionState, 'DEGRADED');
    assert.equal(result.lockReason, expectedReason);
    assert.equal(repaired, false);
  });
}

// ---------- strand 2: a timeline write failure must not crash a published run ----------

test('afterPublish degrades a timeline write failure to EXPIRE-extend instead of crashing the run', async () => {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const body = opts?.body ? JSON.parse(opts.body) : null;
    calls.push({ u, body });
    if (u.endsWith('/pipeline')) return jsonResponse(body.map(() => ({ result: 1 })));
    if (Array.isArray(body) && body[0] === 'SET' && String(body[1]).startsWith('gdelt:intel:')) {
      throw abortError(); // every write attempt times out — retry exhaustion
    }
    return jsonResponse({ result: 'OK' });
  };

  // Must resolve: by the time afterPublish runs, the canonical publish already
  // succeeded — a timeline bookkeeping failure must not turn the run FATAL.
  await afterPublish({
    fetchedAt: '2026-07-23T08:00:00.000Z',
    topics: [{ id: 'military', _tone: [{ date: '20260723', value: -2.1 }], _vol: [] }],
  });

  const expired = calls
    .filter((c) => Array.isArray(c.body) && Array.isArray(c.body[0]))
    .flatMap((c) => c.body)
    .filter((cmd) => cmd[0] === 'EXPIRE')
    .map((cmd) => cmd[1]);
  assert.ok(expired.includes('gdelt:intel:tone:military'),
    'a failed fresh write must fall back to preserving last-good via EXPIRE-extend');
  assert.ok(
    warns.some((w) => w.includes('gdelt:intel:tone:military')),
    `the degraded write must be loud; warns were: ${JSON.stringify(warns)}`,
  );
});

// ---------- strand 3: content-age signal ----------

test('contentMeta reports newest/oldest per-topic fetch times', () => {
  const meta = contentMeta({
    fetchedAt: '2026-07-23T08:00:00.000Z',
    topics: [
      { id: 'military', fetchedAt: '2026-07-20T04:00:00.000Z', articles: [{}] },
      { id: 'nuclear', fetchedAt: '2026-07-01T00:00:00.000Z', articles: [{}] },
    ],
  });
  assert.equal(meta.newestItemAt, Date.parse('2026-07-20T04:00:00.000Z'),
    'newestItemAt = most recently fetched topic — ages only when EVERY topic is coasting');
  assert.equal(meta.oldestItemAt, Date.parse('2026-07-01T00:00:00.000Z'),
    'oldestItemAt = most starved topic');
});

test('contentMeta returns null when no topic carries a usable fetch time', () => {
  assert.equal(contentMeta({ topics: [] }), null);
  assert.equal(contentMeta({ topics: [{ id: 'military', fetchedAt: 'garbage', articles: [{}] }] }), null);
  assert.equal(contentMeta(null), null);
});

test('contentMeta ignores articleless topics so a total outage cannot mask STALE_CONTENT', () => {
  // Total-death scenario: brownout + expired canonical → no backfill possible,
  // every topic is empty but carries fetchedAt=now. Counting those would hold
  // newestItemAt fresh exactly when the alarm matters most.
  const meta = contentMeta({
    topics: [
      { id: 'military', fetchedAt: '2026-07-23T08:00:00.000Z', articles: [] },
      { id: 'nuclear', fetchedAt: '2026-07-01T00:00:00.000Z', articles: [{}] },
    ],
  });
  assert.equal(meta.newestItemAt, Date.parse('2026-07-01T00:00:00.000Z'),
    'only topics that actually carry articles count toward content age');
  assert.equal(
    contentMeta({ topics: [{ id: 'military', fetchedAt: '2026-07-23T08:00:00.000Z', articles: [] }] }),
    null,
    'all-empty topics → null → health reads STALE_CONTENT',
  );
});

test('runSeed opts wire in the content-age trio and the resilient afterPublish', () => {
  assert.equal(RUN_SEED_OPTS.contentMeta, contentMeta, 'content-age opt-in must use the exported contentMeta');
  assert.equal(RUN_SEED_OPTS.maxContentAgeMin, 1440,
    '24h = 6x the 4h cadence; only a real brownout (every topic failing every run for a day) trips STALE_CONTENT');
  assert.equal(RUN_SEED_OPTS.lockTtlMs, GDELT_LOCK_TTL_MS,
    'scheduled seed and repair must share the same full-operation ownership budget');
  assert.ok(RUN_SEED_OPTS.lockTtlMs > 75 * 60_000,
    'scheduled seed lock must cover the bounded worst-case retry envelope, not only the 150s fetch phase');
  assert.equal(RUN_SEED_OPTS.afterPublish, afterPublish, 'main entry must run the degrade-not-crash afterPublish');
  assert.equal(typeof RUN_SEED_OPTS.validateFn, 'function');
  assert.equal(RUN_SEED_OPTS.declareRecords.length, 1);
});

test('canonical publication strips run diagnostics while seed-meta can still consume them', () => {
  const published = RUN_SEED_OPTS.publishTransform({
    fetchedAt: '2026-07-29T08:00:00.000Z',
    _gdeltFailureCode: 'GDELT_SHARED_PROXY_HTTP_429',
    _freshTopicCount: 0,
    topics: [{
      id: 'military',
      articles: [{ title: 'cached', url: 'https://example.test/cached' }],
      failureCode: 'GDELT_SHARED_PROXY_HTTP_429',
      budgetExceeded: false,
      _tone: [],
      _vol: [],
    }],
  });
  assert.equal(Object.hasOwn(published, '_gdeltFailureCode'), false);
  assert.equal(Object.hasOwn(published, '_freshTopicCount'), false);
  assert.deepEqual(Object.keys(published.topics[0]).sort(), ['articles', 'id']);
});
