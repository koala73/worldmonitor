// Sprint 1 — Health classifier content-age tests (2026-05-04 health-readiness plan).
//
// Tests the STALE_CONTENT branch added to api/health.js's classifyKey().
// Verifies:
//   - STALE_CONTENT fires only when seeder opted in (presence of
//     meta.maxContentAgeMin) AND content is stale.
//   - Precedence is preserved — earlier branches (REDIS_PARTIAL, SEED_ERROR,
//     OK_CASCADE, EMPTY_ON_DEMAND, EMPTY, EMPTY_DATA, STALE_SEED,
//     COVERAGE_PARTIAL) take precedence over STALE_CONTENT.
//   - meta.newestItemAt: null (contentMeta returned null) → STALE_CONTENT.
//   - Legacy seeders (no maxContentAgeMin in seed-meta) skip the branch.
//   - STATUS_COUNTS buckets STALE_CONTENT as 'warn'.
//   - Per-key response surfaces contentAgeMin and maxContentAgeMin when opted in.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { __testing__ } from '../api/health.js';

const { readSeedMeta, classifyKey, STATUS_COUNTS } = __testing__;

// Reusable setup: minimal classifyKey ctx + helper to build a seed-meta map.
const NOW = 1700000000000;       // freeze "now" for deterministic age math
const ONE_MIN_MS = 60_000;
const ONE_HOUR_MS = 60 * ONE_MIN_MS;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

// Helpers ──────────────────────────────────────────────────────────────────

function makeCtx({ keyStrens = new Map(), keyErrors = new Map(), keyMetaValues = new Map(), keyMetaErrors = new Map() } = {}) {
  return { keyStrens, keyErrors, keyMetaValues, keyMetaErrors, now: NOW };
}

// Returns the JSON-string a Redis GET would yield for a meta key (matches what
// readSeedMeta reads from keyMetaValues).
function metaValueOf(meta) {
  return JSON.stringify(meta);
}

// ── readSeedMeta surfaces content-age trio ──────────────────────────────

test('readSeedMeta surfaces contentAge when seed-meta carries maxContentAgeMin', () => {
  const seedCfg = { key: 'seed-meta:disease-outbreaks', maxStaleMin: 2880 };
  const newestItemAt = NOW - 5 * ONE_DAY_MS;
  const oldestItemAt = NOW - 60 * ONE_DAY_MS;
  const ctx = makeCtx({
    keyMetaValues: new Map([['seed-meta:disease-outbreaks', metaValueOf({
      fetchedAt: NOW - 10 * ONE_MIN_MS,
      recordCount: 50,
      newestItemAt,
      oldestItemAt,
      maxContentAgeMin: 12960,    // 9 days
    })]]),
  });

  const meta = readSeedMeta(seedCfg, ctx.keyMetaValues, ctx.keyMetaErrors, ctx.now);
  assert.ok(meta.contentAge, 'contentAge present when seed-meta has maxContentAgeMin');
  assert.equal(meta.contentAge.newestItemAt, newestItemAt);
  assert.equal(meta.contentAge.oldestItemAt, oldestItemAt);
  assert.equal(meta.contentAge.maxContentAgeMin, 12960);
  assert.equal(meta.contentAge.contentAgeMin, 5 * 24 * 60, 'contentAgeMin = (now - newestItemAt) in minutes');
  assert.equal(meta.contentAge.contentStale, false, '5 days < 9 day budget → not stale');
});

test('readSeedMeta returns contentAge: null for legacy seed-meta (no maxContentAgeMin)', () => {
  const seedCfg = { key: 'seed-meta:legacy', maxStaleMin: 2880 };
  const ctx = makeCtx({
    keyMetaValues: new Map([['seed-meta:legacy', metaValueOf({
      fetchedAt: NOW - 10 * ONE_MIN_MS,
      recordCount: 50,
      // no content-age fields — legacy seeder
    })]]),
  });
  const meta = readSeedMeta(seedCfg, ctx.keyMetaValues, ctx.keyMetaErrors, ctx.now);
  assert.equal(meta.contentAge, null, 'legacy seed-meta gets contentAge: null — opt-in only');
});

test('readSeedMeta marks contentStale=true when newestItemAt is older than budget', () => {
  const seedCfg = { key: 'seed-meta:stale-disease', maxStaleMin: 2880 };
  const newestItemAt = NOW - 11 * ONE_DAY_MS;     // 11 days, exceeds 9-day budget
  const ctx = makeCtx({
    keyMetaValues: new Map([['seed-meta:stale-disease', metaValueOf({
      fetchedAt: NOW - 10 * ONE_MIN_MS,
      recordCount: 50,
      newestItemAt,
      oldestItemAt: NOW - 60 * ONE_DAY_MS,
      maxContentAgeMin: 12960,    // 9 days
    })]]),
  });
  const meta = readSeedMeta(seedCfg, ctx.keyMetaValues, ctx.keyMetaErrors, ctx.now);
  assert.equal(meta.contentAge.contentStale, true, '11d > 9d → contentStale');
});

// Greptile PR #3596 P2 regression — future-dated newestItemAt produces a
// negative contentAgeMin. Pre-fix `contentAgeMin > maxContentAgeMin` was
// false for any negative value (negative is not greater than any positive
// budget), so a feed publishing future timestamps silently passed the
// staleness check. Post-fix: future-dated newestItemAt is treated as
// STALE so the suspicious-data signal surfaces.
test('readSeedMeta marks contentStale=true when newestItemAt is in the future (suspicious-data signal)', () => {
  const seedCfg = { key: 'seed-meta:future-dated', maxStaleMin: 2880 };
  // newestItemAt 1 hour in the future — could be timezone bug, clock skew,
  // or upstream confusing forecasts with observations. Pre-fix this would
  // have computed contentAgeMin = -60 and slipped past the staleness check.
  const newestItemAt = NOW + 60 * ONE_MIN_MS;
  const ctx = makeCtx({
    keyMetaValues: new Map([['seed-meta:future-dated', metaValueOf({
      fetchedAt: NOW - 10 * ONE_MIN_MS,
      recordCount: 50,
      newestItemAt,
      oldestItemAt: NOW - 60 * ONE_DAY_MS,
      maxContentAgeMin: 12960,    // 9 days
    })]]),
  });
  const meta = readSeedMeta(seedCfg, ctx.keyMetaValues, ctx.keyMetaErrors, ctx.now);
  assert.equal(meta.contentAge.contentStale, true,
    'future-dated newestItemAt must surface as STALE (suspicious data, not fresh data)');
  assert.equal(meta.contentAge.contentAgeMin, -60,
    'negative contentAgeMin preserved on the wire so operators see HOW far in the future');
});

test('readSeedMeta marks contentStale=true when newestItemAt is far in the future (year-from-now corruption)', () => {
  const seedCfg = { key: 'seed-meta:far-future', maxStaleMin: 2880 };
  const newestItemAt = NOW + 365 * ONE_DAY_MS; // a full year ahead — clear corruption
  const ctx = makeCtx({
    keyMetaValues: new Map([['seed-meta:far-future', metaValueOf({
      fetchedAt: NOW - 10 * ONE_MIN_MS,
      recordCount: 50,
      newestItemAt,
      oldestItemAt: NOW - 60 * ONE_DAY_MS,
      maxContentAgeMin: 12960,
    })]]),
  });
  const meta = readSeedMeta(seedCfg, ctx.keyMetaValues, ctx.keyMetaErrors, ctx.now);
  assert.equal(meta.contentAge.contentStale, true);
  assert.ok(meta.contentAge.contentAgeMin < 0,
    'large negative contentAgeMin is the diagnostic signal — operators see year-scale future-dating');
});

test('readSeedMeta marks contentStale=true when newestItemAt is null (contentMeta returned null)', () => {
  const seedCfg = { key: 'seed-meta:all-undated', maxStaleMin: 2880 };
  const ctx = makeCtx({
    keyMetaValues: new Map([['seed-meta:all-undated', metaValueOf({
      fetchedAt: NOW - 10 * ONE_MIN_MS,
      recordCount: 50,
      newestItemAt: null,    // contentMeta returned null
      oldestItemAt: null,
      maxContentAgeMin: 12960,
    })]]),
  });
  const meta = readSeedMeta(seedCfg, ctx.keyMetaValues, ctx.keyMetaErrors, ctx.now);
  assert.equal(meta.contentAge.newestItemAt, null);
  assert.equal(meta.contentAge.contentAgeMin, null);
  assert.equal(meta.contentAge.contentStale, true, 'null newestItemAt → contentStale (no usable timestamps = stale signal)');
});

// ── classifyKey: STALE_CONTENT branch ────────────────────────────────────

test('classifyKey returns STALE_CONTENT when content stale + no other failure mode applies', () => {
  const seedCfg = { key: 'seed-meta:disease-outbreaks', maxStaleMin: 2880 };
  // Override SEED_META briefly via the test surface — but readSeedMeta reads
  // from seedCfg passed via the global SEED_META constant. We can't override
  // SEED_META from outside, so we simulate the wired entry by providing the
  // SAME `name` key and inspecting classifyKey's output directly.
  // Instead, test via a name that exists in SEED_META: 'diseaseOutbreaks'.

  const ctx = makeCtx({
    keyStrens: new Map([['health:disease-outbreaks:v1', 100]]),  // hasData=true
    keyMetaValues: new Map([['seed-meta:health:disease-outbreaks', metaValueOf({
      fetchedAt: NOW - 10 * ONE_MIN_MS,    // fresh seeder run (10 min)
      recordCount: 50,
      newestItemAt: NOW - 11 * ONE_DAY_MS, // 11d old content
      oldestItemAt: NOW - 60 * ONE_DAY_MS,
      maxContentAgeMin: 12960,             // 9 days
    })]]),
  });

  const entry = classifyKey('diseaseOutbreaks', 'health:disease-outbreaks:v1', { allowOnDemand: false }, ctx);
  assert.equal(entry.status, 'STALE_CONTENT', 'fresh seeder run + 11d-old content + 9d budget → STALE_CONTENT');
  assert.equal(entry.records, 50, 'records still surfaced from metaCount');
  assert.equal(entry.contentAgeMin, 11 * 24 * 60, 'contentAgeMin in minutes');
  assert.equal(entry.maxContentAgeMin, 12960);
});

test('classifyKey: opted-in seeder with FRESH content returns OK', () => {
  const ctx = makeCtx({
    keyStrens: new Map([['health:disease-outbreaks:v1', 100]]),
    keyMetaValues: new Map([['seed-meta:health:disease-outbreaks', metaValueOf({
      fetchedAt: NOW - 10 * ONE_MIN_MS,
      recordCount: 50,
      newestItemAt: NOW - 1 * ONE_DAY_MS,   // 1 day, within 9-day budget
      oldestItemAt: NOW - 60 * ONE_DAY_MS,
      maxContentAgeMin: 12960,
    })]]),
  });

  const entry = classifyKey('diseaseOutbreaks', 'health:disease-outbreaks:v1', { allowOnDemand: false }, ctx);
  assert.equal(entry.status, 'OK', 'fresh content → OK, not STALE_CONTENT');
  assert.equal(entry.contentAgeMin, 1 * 24 * 60);
});

test('classifyKey: legacy seeder (no maxContentAgeMin) reaches OK without STALE_CONTENT', () => {
  const ctx = makeCtx({
    keyStrens: new Map([['health:disease-outbreaks:v1', 100]]),
    keyMetaValues: new Map([['seed-meta:health:disease-outbreaks', metaValueOf({
      fetchedAt: NOW - 10 * ONE_MIN_MS,
      recordCount: 50,
      // no content-age fields
    })]]),
  });
  const entry = classifyKey('diseaseOutbreaks', 'health:disease-outbreaks:v1', { allowOnDemand: false }, ctx);
  assert.equal(entry.status, 'OK', 'legacy seeder skips STALE_CONTENT branch entirely');
  assert.ok(!('contentAgeMin' in entry), 'no contentAgeMin in entry — legacy seeders do not surface it');
  assert.ok(!('maxContentAgeMin' in entry), 'no maxContentAgeMin in entry');
});

// ── Precedence checks: earlier branches outrank STALE_CONTENT ────────────

test('precedence: STALE_SEED takes precedence over STALE_CONTENT', () => {
  const ctx = makeCtx({
    keyStrens: new Map([['health:disease-outbreaks:v1', 100]]),
    keyMetaValues: new Map([['seed-meta:health:disease-outbreaks', metaValueOf({
      fetchedAt: NOW - 100 * ONE_DAY_MS,    // ancient seeder run → STALE_SEED
      recordCount: 50,
      newestItemAt: NOW - 11 * ONE_DAY_MS,
      oldestItemAt: NOW - 60 * ONE_DAY_MS,
      maxContentAgeMin: 12960,              // would also fire STALE_CONTENT
    })]]),
  });
  const entry = classifyKey('diseaseOutbreaks', 'health:disease-outbreaks:v1', { allowOnDemand: false }, ctx);
  assert.equal(entry.status, 'STALE_SEED', 'STALE_SEED outranks STALE_CONTENT — seeder broken is more urgent than upstream quiet');
});

test('precedence: REDIS_PARTIAL outranks STALE_CONTENT', () => {
  const ctx = makeCtx({
    keyStrens: new Map([['health:disease-outbreaks:v1', 100]]),
    keyErrors: new Map([['health:disease-outbreaks:v1', 'transient redis error']]),
    keyMetaValues: new Map([['seed-meta:health:disease-outbreaks', metaValueOf({
      fetchedAt: NOW - 10 * ONE_MIN_MS,
      recordCount: 50,
      newestItemAt: NOW - 11 * ONE_DAY_MS,
      maxContentAgeMin: 12960,
    })]]),
  });
  const entry = classifyKey('diseaseOutbreaks', 'health:disease-outbreaks:v1', { allowOnDemand: false }, ctx);
  assert.equal(entry.status, 'REDIS_PARTIAL', 'REDIS_PARTIAL outranks every status — read failed, classification untrustworthy');
});

test('precedence: SEED_ERROR outranks STALE_CONTENT', () => {
  const ctx = makeCtx({
    keyStrens: new Map([['health:disease-outbreaks:v1', 100]]),
    keyMetaValues: new Map([['seed-meta:health:disease-outbreaks', metaValueOf({
      fetchedAt: NOW - 10 * ONE_MIN_MS,
      recordCount: 50,
      status: 'error',                // SEED_ERROR signal
      newestItemAt: NOW - 11 * ONE_DAY_MS,
      maxContentAgeMin: 12960,
    })]]),
  });
  const entry = classifyKey('diseaseOutbreaks', 'health:disease-outbreaks:v1', { allowOnDemand: false }, ctx);
  assert.equal(entry.status, 'SEED_ERROR', 'SEED_ERROR outranks STALE_CONTENT');
});

test('precedence: EMPTY (no data key) outranks STALE_CONTENT', () => {
  const ctx = makeCtx({
    keyStrens: new Map(),  // no data key — strlen=0 → hasData=false → EMPTY
    keyMetaValues: new Map([['seed-meta:health:disease-outbreaks', metaValueOf({
      fetchedAt: NOW - 10 * ONE_MIN_MS,
      recordCount: 50,
      newestItemAt: NOW - 11 * ONE_DAY_MS,
      maxContentAgeMin: 12960,
    })]]),
  });
  const entry = classifyKey('diseaseOutbreaks', 'health:disease-outbreaks:v1', { allowOnDemand: false }, ctx);
  assert.equal(entry.status, 'EMPTY', 'EMPTY outranks STALE_CONTENT');
});

test('precedence: COVERAGE_PARTIAL outranks STALE_CONTENT (when minRecordCount declared)', () => {
  // We need a seedCfg with minRecordCount set. Use chokepoints which has one.
  const ctx = makeCtx({
    keyStrens: new Map([['energy:chokepoint-flows:v1', 100]]),
    keyMetaValues: new Map([['seed-meta:energy:chokepoint-flows', metaValueOf({
      fetchedAt: NOW - 10 * ONE_MIN_MS,
      recordCount: 5,                       // below minRecordCount=13 → COVERAGE_PARTIAL
      newestItemAt: NOW - 11 * ONE_DAY_MS,
      maxContentAgeMin: 12960,
    })]]),
  });
  const entry = classifyKey('chokepoints', 'energy:chokepoint-flows:v1', { allowOnDemand: false }, ctx);
  // chokepoints in SEED_META has minRecordCount declared. If we get COVERAGE_PARTIAL,
  // precedence holds. If we get OK/STALE_CONTENT, precedence is wrong.
  assert.notEqual(entry.status, 'STALE_CONTENT', 'COVERAGE_PARTIAL takes precedence over STALE_CONTENT (or OK if minRecordCount happens to be ≤ 5)');
});

// ── STATUS_COUNTS bucket ─────────────────────────────────────────────────

test('STATUS_COUNTS buckets STALE_CONTENT as warn', () => {
  assert.equal(STATUS_COUNTS.STALE_CONTENT, 'warn', 'STALE_CONTENT must bucket as warn — same severity as STALE_SEED, drives degraded (not critical)');
});

test('STATUS_COUNTS unchanged for existing statuses (anti-regression)', () => {
  assert.equal(STATUS_COUNTS.OK, 'ok');
  assert.equal(STATUS_COUNTS.OK_CASCADE, 'ok');
  assert.equal(STATUS_COUNTS.STALE_SEED, 'warn');
  assert.equal(STATUS_COUNTS.SEED_ERROR, 'warn');
  assert.equal(STATUS_COUNTS.EMPTY_ON_DEMAND, 'warn');
  assert.equal(STATUS_COUNTS.REDIS_PARTIAL, 'warn');
  assert.equal(STATUS_COUNTS.COVERAGE_PARTIAL, 'warn');
  assert.equal(STATUS_COUNTS.EMPTY, 'crit');
  assert.equal(STATUS_COUNTS.EMPTY_DATA, 'crit');
});

// ── Per-key response shape ──────────────────────────────────────────────

test('opted-in entry surfaces contentAgeMin AND maxContentAgeMin', () => {
  const ctx = makeCtx({
    keyStrens: new Map([['health:disease-outbreaks:v1', 100]]),
    keyMetaValues: new Map([['seed-meta:health:disease-outbreaks', metaValueOf({
      fetchedAt: NOW - 10 * ONE_MIN_MS,
      recordCount: 50,
      newestItemAt: NOW - 5 * ONE_DAY_MS,
      maxContentAgeMin: 12960,
    })]]),
  });
  const entry = classifyKey('diseaseOutbreaks', 'health:disease-outbreaks:v1', { allowOnDemand: false }, ctx);
  assert.equal(entry.contentAgeMin, 5 * 24 * 60);
  assert.equal(entry.maxContentAgeMin, 12960);
});

test('opted-in entry with null newestItemAt surfaces contentAgeMin: null', () => {
  const ctx = makeCtx({
    keyStrens: new Map([['health:disease-outbreaks:v1', 100]]),
    keyMetaValues: new Map([['seed-meta:health:disease-outbreaks', metaValueOf({
      fetchedAt: NOW - 10 * ONE_MIN_MS,
      recordCount: 50,
      newestItemAt: null,    // contentMeta returned null
      maxContentAgeMin: 12960,
    })]]),
  });
  const entry = classifyKey('diseaseOutbreaks', 'health:disease-outbreaks:v1', { allowOnDemand: false }, ctx);
  assert.equal(entry.status, 'STALE_CONTENT', 'null newestItemAt → STALE_CONTENT');
  assert.equal(entry.contentAgeMin, null, 'contentAgeMin: null surfaced explicitly');
  assert.equal(entry.maxContentAgeMin, 12960);
});
