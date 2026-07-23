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

const { afterPublish, contentMeta, TIMELINE_TTL, RUN_SEED_OPTS } =
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
    '24h = 4x the 6h cadence; only a real brownout (every topic failing every run for a day) trips STALE_CONTENT');
  assert.equal(RUN_SEED_OPTS.afterPublish, afterPublish, 'main entry must run the degrade-not-crash afterPublish');
  assert.equal(typeof RUN_SEED_OPTS.validateFn, 'function');
  assert.equal(RUN_SEED_OPTS.declareRecords.length, 1);
});
