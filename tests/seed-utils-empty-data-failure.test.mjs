// Regression test for PR #3078: strict-floor validators must not poison
// seed-meta on validation failure when opts.emptyDataIsFailure is set.
//
// Without this guarantee, a single transient empty fetch would refresh
// seed-meta with fetchedAt=now, locking bundle runners out of retry for a
// full interval (30 days for the IMF extended bundle).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { runSeed } from '../scripts/_seed-utils.mjs';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_EXIT = process.exit;
const ORIGINAL_ENV = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
};

let recordedCalls;

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example.com';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  recordedCalls = [];

  globalThis.fetch = async (url, opts = {}) => {
    const body = opts?.body ? (() => { try { return JSON.parse(opts.body); } catch { return opts.body; } })() : null;
    recordedCalls.push({ url: String(url), method: opts?.method || 'GET', body });
    // Lock acquire: SET NX returns OK. Pipeline (EXPIRE) returns array. Default: OK.
    if (Array.isArray(body) && Array.isArray(body[0])) {
      return new Response(JSON.stringify(body.map(() => ({ result: 0 }))), { status: 200 });
    }
    return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
  };

  // runSeed's skipped path calls process.exit(0). Convert to a throw so the
  // test can proceed after the seed "finishes" and inspect recorded calls.
  process.exit = (code) => {
    const e = new Error(`__test_exit__:${code}`);
    e.exitCode = code;
    throw e;
  };
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.exit = ORIGINAL_EXIT;
  if (ORIGINAL_ENV.UPSTASH_REDIS_REST_URL == null) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = ORIGINAL_ENV.UPSTASH_REDIS_REST_URL;
  if (ORIGINAL_ENV.UPSTASH_REDIS_REST_TOKEN == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = ORIGINAL_ENV.UPSTASH_REDIS_REST_TOKEN;
});

function countMetaSets(resourceSuffix) {
  return recordedCalls.filter(c =>
    Array.isArray(c.body)
    && c.body[0] === 'SET'
    && typeof c.body[1] === 'string'
    && c.body[1] === `seed-meta:test:${resourceSuffix}`,
  ).length;
}

async function runWithExitTrap(fn) {
  try {
    await fn();
  } catch (err) {
    if (!String(err.message).startsWith('__test_exit__:')) throw err;
  }
}

test('validation failure with emptyDataIsFailure:true does NOT refresh seed-meta', async () => {
  await runWithExitTrap(() =>
    runSeed('test', 'empty-fail', 'test:empty-fail:v1', async () => ({ items: [] }), {
      validateFn: (d) => d?.items?.length >= 10, // always fails for empty
      emptyDataIsFailure: true,
      ttlSeconds: 3600,
    }),
  );

  assert.equal(
    countMetaSets('empty-fail'), 0,
    'seed-meta must NOT be SET on validation-fail when emptyDataIsFailure is true; ' +
    'refreshing fetchedAt here would mask outages and block bundle retries',
  );
});

test('validation failure WITHOUT emptyDataIsFailure DOES refresh seed-meta (quiet-period feeds)', async () => {
  await runWithExitTrap(() =>
    runSeed('test', 'empty-legacy', 'test:empty-legacy:v1', async () => ({ items: [] }), {
      validateFn: (d) => d?.items?.length >= 10,
      ttlSeconds: 3600,
    }),
  );

  assert.ok(
    countMetaSets('empty-legacy') >= 1,
    'legacy behavior for quiet-period feeds (news, events) must still write ' +
    'seed-meta count=0 so health does not false-positive STALE_SEED',
  );
});

// PR #3582: When validateFn rejects a transient blip but canonical key still
// holds a contract-mode envelope with recordCount > 0, seed-meta should mirror
// the canonical's (fetchedAt, recordCount) rather than overwrite with zero.
// Production motivation: resilience:power-losses 2026-05-03 — canonical had
// 216 countries but a partial WB fetch (149 < 150 floor) caused validateFn
// to reject; runSeed wrote recordCount=0 to seed-meta; /api/health flipped
// EMPTY_DATA even though the canonical data was fine. The mirror behavior
// keeps health honest while preserving STALE_SEED honesty (mirrored
// fetchedAt is the canonical's ORIGINAL value, not now).
function withCanonicalEnvelope({ canonicalKey, fetchedAt, recordCount, sourceVersion = 'test-v1', contentAge }) {
  const seed = {
    fetchedAt,
    recordCount,
    sourceVersion,
    schemaVersion: 1,
    state: 'OK',
  };
  // Optional content-age trio (2026-05-04 health-readiness plan).
  // Used by the Sprint 1 anti-regression test that asserts the validate-fail
  // mirror preserves content fields end-to-end (Codex round 1 P0b).
  if (contentAge && typeof contentAge === 'object') {
    seed.newestItemAt = contentAge.newestItemAt ?? null;
    seed.oldestItemAt = contentAge.oldestItemAt ?? null;
    seed.maxContentAgeMin = contentAge.maxContentAgeMin;
  }
  const envelope = {
    _seed: seed,
    data: { items: Array.from({ length: recordCount }, (_, i) => ({ id: i })) },
  };
  return async (url, opts = {}) => {
    const u = String(url);
    const body = opts?.body ? (() => { try { return JSON.parse(opts.body); } catch { return opts.body; } })() : null;
    recordedCalls.push({ url: u, method: opts?.method || 'GET', body });
    // Match GET on the canonical key — return the envelope wrapped in {result}.
    if (u.includes(`/get/${encodeURIComponent(canonicalKey)}`) || u.endsWith(`/get/${canonicalKey}`)) {
      return new Response(JSON.stringify({ result: JSON.stringify(envelope) }), { status: 200 });
    }
    if (Array.isArray(body) && Array.isArray(body[0])) {
      return new Response(JSON.stringify(body.map(() => ({ result: 0 }))), { status: 200 });
    }
    return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
  };
}

function lastMetaSetBody(resourceSuffix) {
  const setCalls = recordedCalls.filter(c =>
    Array.isArray(c.body)
    && c.body[0] === 'SET'
    && typeof c.body[1] === 'string'
    && c.body[1] === `seed-meta:test:${resourceSuffix}`,
  );
  if (setCalls.length === 0) return null;
  const last = setCalls[setCalls.length - 1];
  // Body shape is ['SET', metaKey, JSON.stringify(meta), 'EX', ttl]
  try { return JSON.parse(last.body[2]); } catch { return null; }
}

test('PR #3582: validation failure with non-empty canonical envelope MIRRORS its (fetchedAt, recordCount)', async () => {
  const FROZEN_FETCHED_AT = 1700000000000; // arbitrary fixed past timestamp
  const RECORD_COUNT = 216;
  globalThis.fetch = withCanonicalEnvelope({
    canonicalKey: 'test:partial-fetch:v1',
    fetchedAt: FROZEN_FETCHED_AT,
    recordCount: RECORD_COUNT,
    sourceVersion: 'wb-power-losses-2026',
  });

  await runWithExitTrap(() =>
    runSeed('test', 'partial-fetch', 'test:partial-fetch:v1', async () => ({ items: [] }), {
      validateFn: (d) => d?.items?.length >= 10, // rejects (transient blip)
      ttlSeconds: 3600,
    }),
  );

  const meta = lastMetaSetBody('partial-fetch');
  assert.ok(meta, 'seed-meta must be written (mirror path) when a valid canonical envelope exists');
  assert.equal(
    meta.recordCount, RECORD_COUNT,
    `seed-meta.recordCount must MIRROR canonical (${RECORD_COUNT}), not be overwritten with 0 — ` +
    'health-reported count should track last-good data, not the failed transient fetch',
  );
  assert.equal(
    meta.fetchedAt, FROZEN_FETCHED_AT,
    'seed-meta.fetchedAt must MIRROR canonical original fetchedAt (not Date.now()) — ' +
    'STALE_SEED must still fire naturally when canonical truly ages past maxStaleMin',
  );
});

test('PR #3582: validation failure with MISSING canonical falls back to recordCount=0 (legacy)', async () => {
  // Default fetch mock returns {result: 'OK'} on GET, which fails JSON.parse
  // inside readCanonicalEnvelopeMeta — so the helper returns null and runSeed
  // falls through to the original quiet-period behavior. This proves the
  // mirror logic is non-disruptive for legacy bare-shape / missing-key seeders.
  await runWithExitTrap(() =>
    runSeed('test', 'no-canonical', 'test:no-canonical:v1', async () => ({ items: [] }), {
      validateFn: (d) => d?.items?.length >= 10,
      ttlSeconds: 3600,
    }),
  );

  const meta = lastMetaSetBody('no-canonical');
  assert.ok(meta, 'seed-meta must still be written when no canonical envelope to mirror');
  assert.equal(meta.recordCount, 0, 'falls back to recordCount=0 when canonical envelope is missing/malformed');
});

// Sprint 1 (2026-05-04 health-readiness plan, Codex round 1 P0b):
// validate-fail mirror MUST preserve content-age fields from the canonical
// envelope. Without this, /api/health loses the STALE_CONTENT signal exactly
// when last-good-with-stale-content data is being served — the worst possible
// time for the alarm to vanish.
test('Sprint 1: validation failure with canonical contentAge MIRRORS newestItemAt/oldestItemAt/maxContentAgeMin', async () => {
  const FROZEN_FETCHED_AT = 1700000000000;
  const FROZEN_NEWEST_AT = 1699000000000;   // older than fetchedAt = realistic for sparse upstream
  const FROZEN_OLDEST_AT = 1690000000000;
  const RECORD_COUNT = 216;
  globalThis.fetch = withCanonicalEnvelope({
    canonicalKey: 'test:content-age-mirror:v1',
    fetchedAt: FROZEN_FETCHED_AT,
    recordCount: RECORD_COUNT,
    sourceVersion: 'tgh-bundle-v2',
    contentAge: {
      newestItemAt: FROZEN_NEWEST_AT,
      oldestItemAt: FROZEN_OLDEST_AT,
      maxContentAgeMin: 12960,    // 9 days, matching disease-outbreaks pilot
    },
  });

  await runWithExitTrap(() =>
    runSeed('test', 'content-age-mirror', 'test:content-age-mirror:v1', async () => ({ items: [] }), {
      validateFn: (d) => d?.items?.length >= 10,    // rejects → mirror branch
      ttlSeconds: 3600,
    }),
  );

  const meta = lastMetaSetBody('content-age-mirror');
  assert.ok(meta, 'seed-meta must be written via the mirror branch');
  assert.equal(meta.recordCount, RECORD_COUNT, 'recordCount mirrored');
  assert.equal(meta.fetchedAt, FROZEN_FETCHED_AT, 'fetchedAt mirrored (canonical original, not now)');
  assert.equal(
    meta.newestItemAt, FROZEN_NEWEST_AT,
    'newestItemAt MUST be mirrored — without this, STALE_CONTENT signal vanishes during transient validate-fails',
  );
  assert.equal(meta.oldestItemAt, FROZEN_OLDEST_AT, 'oldestItemAt mirrored');
  assert.equal(meta.maxContentAgeMin, 12960, 'maxContentAgeMin mirrored');
});

// Anti-regression: legacy seeder (no contentMeta) — meta must NOT carry
// content fields. Proves the mirror is gated on canonical envelope presence
// of the content trio, not added unconditionally.
test('Sprint 1: validation failure with canonical envelope BUT no contentAge writes legacy meta shape', async () => {
  const FROZEN_FETCHED_AT = 1700000000000;
  const RECORD_COUNT = 100;
  globalThis.fetch = withCanonicalEnvelope({
    canonicalKey: 'test:legacy-mirror:v1',
    fetchedAt: FROZEN_FETCHED_AT,
    recordCount: RECORD_COUNT,
    // no contentAge — legacy contract-mode seeder
  });

  await runWithExitTrap(() =>
    runSeed('test', 'legacy-mirror', 'test:legacy-mirror:v1', async () => ({ items: [] }), {
      validateFn: (d) => d?.items?.length >= 10,
      ttlSeconds: 3600,
    }),
  );

  const meta = lastMetaSetBody('legacy-mirror');
  assert.ok(meta, 'seed-meta written via mirror');
  assert.equal(meta.recordCount, RECORD_COUNT);
  assert.equal(meta.fetchedAt, FROZEN_FETCHED_AT);
  assert.ok(!('newestItemAt' in meta), 'newestItemAt absent for legacy seeders');
  assert.ok(!('oldestItemAt' in meta), 'oldestItemAt absent for legacy seeders');
  assert.ok(!('maxContentAgeMin' in meta), 'maxContentAgeMin absent for legacy seeders');
});
