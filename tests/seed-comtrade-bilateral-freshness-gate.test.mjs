// Regression test for the seed-comtrade-bilateral-hs4 freshness gate.
// Backstop against the Comtrade Free APIs 500/month quota being burned by a
// stuck-on cron. Discovered 2026-05-11: Railway cron was set to daily but
// only fired once every ~2 weeks via Watch-Paths accident; if the filter
// ever starts firing reliably, daily × ~396 calls = ~24× over quota. The
// gate inside the seeder is the belt-and-suspenders defense regardless of
// cron cadence.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkSeedMetaFreshness,
  FRESHNESS_GATE_MS,
  SEED_META_TTL_SECONDS,
} from '../scripts/seed-comtrade-bilateral-hs4.mjs';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const ORIGINAL_REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

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
  // Pin the buffer too — without it the relationship is brittle to clock skew.
  const bufferSeconds = SEED_META_TTL_SECONDS - gateSeconds;
  assert.ok(
    bufferSeconds >= 86_400,
    `seed-meta TTL must outlive the gate by ≥1 day for clock-skew + missed-tick slack (got ${bufferSeconds}s)`,
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
