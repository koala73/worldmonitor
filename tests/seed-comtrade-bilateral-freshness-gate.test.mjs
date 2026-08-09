// Regression test for the seed-comtrade-bilateral-hs4 freshness gate.
// Backstop against the Comtrade Free APIs 500/month quota being burned by a
// stuck-on cron. Discovered 2026-05-11: Railway cron was set to daily but
// only fired once every ~2 weeks via Watch-Paths accident; if the filter
// ever starts firing reliably, daily × ~396 calls = ~24× over quota. The
// gate inside the seeder is the belt-and-suspenders defense regardless of
// cron cadence.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  checkSeedMetaFreshness,
  FRESHNESS_GATE_MS,
  SEED_META_TTL_SECONDS,
} from '../scripts/seed-comtrade-bilateral-hs4.mjs';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const ORIGINAL_REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const root = join(import.meta.dirname, '..');

function mockRedisGet(value) {
  // Upstash REST /pipeline returns an array of { result } objects.
  globalThis.fetch = async () =>
    new Response(JSON.stringify([{ result: value }]), { status: 200 });
}

function mockRedisError() {
  globalThis.fetch = async () =>
    new Response('boom', { status: 500 });
}

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://test.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_REDIS_URL === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = ORIGINAL_REDIS_URL;
  if (ORIGINAL_REDIS_TOKEN === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = ORIGINAL_REDIS_TOKEN;
});

test('checkSeedMetaFreshness: fresh seed (1 day old) reports fresh=true', async () => {
  const now = Date.now();
  mockRedisGet(JSON.stringify({ fetchedAt: now - 1 * 86_400_000, recordCount: 180, status: 'ok' }));
  const result = await checkSeedMetaFreshness(now);
  assert.equal(result.fresh, true);
  assert.equal(result.reason, 'within-gate');
});

test('checkSeedMetaFreshness: stale seed (25 days old) reports fresh=false', async () => {
  const now = Date.now();
  mockRedisGet(JSON.stringify({ fetchedAt: now - 25 * 86_400_000, recordCount: 180, status: 'ok' }));
  const result = await checkSeedMetaFreshness(now);
  assert.equal(result.fresh, false);
  assert.equal(result.reason, 'stale');
});

test('checkSeedMetaFreshness: exactly at the 24-day gate boundary is treated as stale', async () => {
  // The gate is `ageMs < FRESHNESS_GATE_MS` (strict <), so exactly-at-gate
  // falls through to a re-seed. Pins the boundary so a future refactor that
  // flips the comparison to `<=` has to update this assertion.
  const now = Date.now();
  mockRedisGet(JSON.stringify({ fetchedAt: now - 24 * 86_400_000, recordCount: 180, status: 'ok' }));
  const result = await checkSeedMetaFreshness(now);
  assert.equal(result.fresh, false, 'exactly-at-gate falls through to re-seed');
});

test('checkSeedMetaFreshness: missing seed-meta returns fresh=false (no-meta)', async () => {
  mockRedisGet(null);
  const result = await checkSeedMetaFreshness(Date.now());
  assert.equal(result.fresh, false);
  assert.equal(result.reason, 'no-meta');
});

test('checkSeedMetaFreshness: malformed seed-meta returns fresh=false (no-fetchedAt)', async () => {
  mockRedisGet(JSON.stringify({ recordCount: 5 })); // missing fetchedAt
  const result = await checkSeedMetaFreshness(Date.now());
  assert.equal(result.fresh, false);
  assert.equal(result.reason, 'no-fetchedAt');
});

test('checkSeedMetaFreshness: invalid JSON in seed-meta returns fresh=false (read-error)', async () => {
  mockRedisGet('not-valid-json');
  const result = await checkSeedMetaFreshness(Date.now());
  assert.equal(result.fresh, false);
  assert.equal(result.reason, 'read-error');
});

test('checkSeedMetaFreshness: Redis HTTP 500 fails open (fresh=false, reason=read-error)', async () => {
  mockRedisError();
  const result = await checkSeedMetaFreshness(Date.now());
  assert.equal(result.fresh, false);
  assert.equal(result.reason, 'read-error');
});

test('checkSeedMetaFreshness: fetchedAt:0 (legacy bad write) treated as no-fetchedAt', async () => {
  mockRedisGet(JSON.stringify({ fetchedAt: 0 }));
  const result = await checkSeedMetaFreshness(Date.now());
  assert.equal(result.fresh, false);
  assert.equal(result.reason, 'no-fetchedAt');
});

test('invariant: SEED_META_TTL_SECONDS strictly outlives FRESHNESS_GATE_MS', () => {
  // Greptile review on PR #3661 caught the original: meta TTL was 9d while
  // gate was 24d, leaving a 15-day fail-open window between Redis eviction
  // and gate expiry. This invariant prevents the bug from regressing.
  const gateSeconds = FRESHNESS_GATE_MS / 1000;
  assert.ok(
    SEED_META_TTL_SECONDS > gateSeconds,
    `SEED_META_TTL_SECONDS (${SEED_META_TTL_SECONDS}s) must be > FRESHNESS_GATE_MS in seconds (${gateSeconds}s)`,
  );
  // Pin the monthly continuity window too — without it seed-meta expires
  // before the next scheduled run and compact health escalates to EMPTY.
  assert.ok(
    SEED_META_TTL_SECONDS >= 35 * 86_400,
    `seed-meta TTL must cover a 31-day month plus 4 days of cron/deploy jitter (got ${SEED_META_TTL_SECONDS}s)`,
  );
});

test('a degraded run still holds the gate shut — the quota cannot afford a retry', async () => {
  // Deliberate, and the opposite of the intuitive fix. Letting a 'partial' run
  // re-open the gate would be unbounded: one pass costs ~394 of the 500
  // calls/month quota and quota exhaustion is itself a cause of 'partial', so
  // the degraded state feeds itself and every tick retriggers a full run. The
  // gate is the only quota guard living in the repo rather than in Railway
  // config, so it must not be conditional on run quality. Degradation is made
  // visible through recordCount/minRecordCount instead.
  mockRedisGet(JSON.stringify({ fetchedAt: Date.now(), recordCount: 4, status: 'partial' }));

  const result = await checkSeedMetaFreshness();

  assert.equal(result.fresh, true, 'a recent partial run must NOT reopen the quota gate');
  assert.equal(result.reason, 'within-gate');
});

test('an errored run also holds the gate shut', async () => {
  // The error path writes status 'error' AFTER the fetch loop has already
  // spent the quota, so it is the most expensive case to let through.
  mockRedisGet(JSON.stringify({ fetchedAt: Date.now(), recordCount: 0, status: 'error' }));

  const result = await checkSeedMetaFreshness();

  assert.equal(result.fresh, true);
});

test('an old degraded run is stale and does run again', async () => {
  // The flip side: waiting is bounded by the gate, not indefinite.
  mockRedisGet(JSON.stringify({
    fetchedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
    recordCount: 4,
    status: 'partial',
  }));

  const result = await checkSeedMetaFreshness();

  assert.equal(result.fresh, false);
  assert.equal(result.reason, 'stale');
});

test('a healthy recent run still skips the next tick (quota guard intact)', async () => {
  // The mirror of the test above: loosening the gate for degraded runs must not
  // loosen it for good ones, or every tick burns ~394 of the 500/month quota.
  mockRedisGet(JSON.stringify({ fetchedAt: Date.now(), recordCount: 180, status: 'ok' }));

  const result = await checkSeedMetaFreshness();

  assert.equal(result.fresh, true);
  assert.equal(result.reason, 'within-gate');
});

test('legacy seed-meta with no status field keeps the original age-only behaviour', async () => {
  mockRedisGet(JSON.stringify({ fetchedAt: Date.now(), recordCount: 180 }));

  const result = await checkSeedMetaFreshness();

  assert.equal(result.fresh, true, 'absent status must not be treated as degraded');
});

test('health freshness budgets cover the monthly Railway cadence without masking a missed run', () => {
  const compactHealth = readFileSync(join(root, 'api', 'health.js'), 'utf8');
  const seedHealth = readFileSync(join(root, 'api', 'seed-health.js'), 'utf8');

  // Capture the numbers and assert the RELATIONSHIP rather than pinning two
  // literals. Pinned literals let a future cadence change update both files
  // and this test in lockstep while silently breaking the invariant that
  // seed-health warns before compact health times out.
  // Not anchored on a trailing `}` — these entries also carry minRecordCount,
  // and requiring the value to be the last property made the guard silently
  // stop matching the moment one was added.
  const maxStaleMatch = compactHealth.match(
    /comtradeBilateralHs4:\s*\{[^}]*?maxStaleMin:\s*(\d+)/,
  );
  const intervalMatch = seedHealth.match(
    /'comtrade:bilateral-hs4':\s*\{[^}]*?intervalMin:\s*(\d+)/,
  );
  assert.ok(maxStaleMatch, 'compact health must register comtradeBilateralHs4 with a maxStaleMin');
  assert.ok(intervalMatch, 'seed-health must register comtrade:bilateral-hs4 with an intervalMin');

  const maxStaleMin = Number(maxStaleMatch[1]);
  const intervalMin = Number(intervalMatch[1]);

  assert.ok(
    maxStaleMin >= 35 * 24 * 60,
    `compact health must allow >=35 days for the monthly Comtrade HS4 seed (got ${maxStaleMin} min)`,
  );
  assert.equal(
    intervalMin * 2,
    maxStaleMin,
    `seed-health intervalMin*2 (${intervalMin * 2}) must equal the compact-health budget (${maxStaleMin})`,
  );
});

test('invariant: seed-meta TTL chosen by writeMeta covers the full gate window (no fail-open hole)', () => {
  // Property statement: at any t ∈ [0, FRESHNESS_GATE_MS), if a successful run
  // wrote seed-meta at t=0, the meta key must still exist in Redis. Without
  // this property, the gate goes from "skip if fresh" to "fail-open and burn
  // the upstream quota" between TTL-eviction and gate-elapsed.
  for (const tMs of [0, FRESHNESS_GATE_MS / 4, FRESHNESS_GATE_MS / 2, FRESHNESS_GATE_MS - 1]) {
    const tSeconds = tMs / 1000;
    assert.ok(
      tSeconds < SEED_META_TTL_SECONDS,
      `at t=${tSeconds}s after write, meta TTL (${SEED_META_TTL_SECONDS}s) must still cover us`,
    );
  }
});
