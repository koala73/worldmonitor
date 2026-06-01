// Health classifier — classify + cascade + overall-status regression tests.
//
// Exercises the REAL /api/health classifier surface exported via `__testing__`
// (classifyKey + STATUS_COUNTS) plus the overall-status thresholds the handler
// applies inline. classifyKey resolves cascade coverage PROACTIVELY
// (isCascadeCovered) at classify time — there is no separate downgrade pass —
// so cascade behavior is asserted through classifyKey's returned status.
//
// Uses node:test + node:assert to match the repo's data-test runner
// (`tsx --test tests/*.test.mjs` / `node --test`), the same harness as
// tests/health-content-age.test.mjs. Vitest's describe/it is NOT compatible
// with the bare node test runner used here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { __testing__ } from '../api/health.js';

const { classifyKey, STATUS_COUNTS, BOOTSTRAP_KEYS, STANDALONE_KEYS } = __testing__;

const NOW = 1_700_000_000_000;
const ONE_MIN_MS = 60_000;

// Build the same ctx shape the handler constructs: four Maps + now.
//   strens:     { redisDataKey -> byteLen }
//   errors:     { redisDataKey -> errMsg }
//   metaValues: { seedMetaKey  -> raw JSON string }
//   metaErrors: { seedMetaKey  -> errMsg }
function makeCtx({ strens = {}, errors = {}, metaValues = {}, metaErrors = {} } = {}) {
  return {
    keyStrens: new Map(Object.entries(strens)),
    keyErrors: new Map(Object.entries(errors)),
    keyMetaValues: new Map(Object.entries(metaValues).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])),
    keyMetaErrors: new Map(Object.entries(metaErrors)),
    now: NOW,
  };
}

const seedMeta = (over = {}) => JSON.stringify({ fetchedAt: NOW - ONE_MIN_MS, recordCount: 5, ...over });

// Mirror of the handler's overall-status computation (api/health.js ~850-859).
// The handler computes this inline; these tests exercise the LOCAL replica —
// they document the intended HEALTHY/WARNING/DEGRADED/UNHEALTHY thresholds but
// do NOT catch handler drift if the 0.03 constant or branch order changes in
// api/health.js without updating here. Non-REDIS_DOWN states return HTTP 200
// (verdict in the JSON `status`); REDIS_DOWN returns 503.
function computeOverall(critCount, realWarnCount, totalChecks) {
  let status;
  if (critCount === 0 && realWarnCount === 0) status = 'HEALTHY';
  else if (critCount === 0) status = 'WARNING';
  else if (critCount / totalChecks <= 0.03) status = 'DEGRADED';
  else status = 'UNHEALTHY';
  return { status, http: 200 };
}

// ── STATUS_COUNTS buckets ───────────────────────────────────────────────────

test('STATUS_COUNTS buckets OK/cascade to ok, empty to crit, on-demand/stale to warn', () => {
  assert.equal(STATUS_COUNTS.OK, 'ok');
  assert.equal(STATUS_COUNTS.OK_CASCADE, 'ok');
  assert.equal(STATUS_COUNTS.EMPTY, 'crit');
  assert.equal(STATUS_COUNTS.EMPTY_DATA, 'crit');
  assert.equal(STATUS_COUNTS.EMPTY_ON_DEMAND, 'warn');
  assert.equal(STATUS_COUNTS.STALE_SEED, 'warn');
});

// ── classifyKey core statuses ───────────────────────────────────────────────

test('classifyKey: fresh seed + data → OK', () => {
  const entry = classifyKey('earthquakes', BOOTSTRAP_KEYS.earthquakes, { allowOnDemand: false },
    makeCtx({
      strens: { [BOOTSTRAP_KEYS.earthquakes]: 1234 },
      metaValues: { 'seed-meta:seismology:earthquakes': seedMeta() },
    }));
  assert.equal(entry.status, 'OK');
});

test('classifyKey: present-but-stale seed → STALE_SEED (warn), data still present', () => {
  const entry = classifyKey('earthquakes', BOOTSTRAP_KEYS.earthquakes, { allowOnDemand: false },
    makeCtx({
      strens: { [BOOTSTRAP_KEYS.earthquakes]: 1234 },
      // earthquakes maxStaleMin=30; 200 min exceeds it
      metaValues: { 'seed-meta:seismology:earthquakes': seedMeta({ fetchedAt: NOW - 200 * ONE_MIN_MS }) },
    }));
  assert.equal(entry.status, 'STALE_SEED');
  assert.equal(STATUS_COUNTS[entry.status], 'warn');
});

test('classifyKey: empty bootstrap key (no cascade) → EMPTY (crit)', () => {
  const entry = classifyKey('earthquakes', BOOTSTRAP_KEYS.earthquakes, { allowOnDemand: false },
    makeCtx({ metaValues: { 'seed-meta:seismology:earthquakes': seedMeta() } }));
  assert.equal(entry.status, 'EMPTY');
  assert.equal(STATUS_COUNTS[entry.status], 'crit');
});

test('classifyKey: empty on-demand standalone key → EMPTY_ON_DEMAND (warn)', () => {
  // minerals is in ON_DEMAND_KEYS and has no SEED_META entry.
  const entry = classifyKey('minerals', STANDALONE_KEYS.minerals, { allowOnDemand: true }, makeCtx({}));
  assert.equal(entry.status, 'EMPTY_ON_DEMAND');
  assert.equal(STATUS_COUNTS[entry.status], 'warn');
});

test('classifyKey: suppressed retailer-spread (present key, 0 records) while fresh → OK, not EMPTY_DATA', () => {
  // The consumer-prices aggregate job writes retailer_spread_pct: 0 ("spread
  // suppressed (N/4 common items)") when a market's retailers share < 4 common
  // basket items — a valid data-coverage state, not an outage. The key exists
  // (296-byte payload → hasData=true) with metaCount=0, so without the
  // EMPTY_DATA_OK_KEYS exemption it would wrongly classify EMPTY_DATA (crit) and
  // tip /api/health to DEGRADED. Fresh seed-meta → OK.
  const entry = classifyKey('consumerPricesSpread', BOOTSTRAP_KEYS.consumerPricesSpread,
    { allowOnDemand: false },
    makeCtx({
      strens: { [BOOTSTRAP_KEYS.consumerPricesSpread]: 296 },
      metaValues: {
        'seed-meta:consumer-prices:retailer-spread:ae:essentials-ae':
          seedMeta({ recordCount: 0 }),
      },
    }));
  assert.equal(entry.status, 'OK');
  assert.equal(STATUS_COUNTS[entry.status], 'ok');
});

test('classifyKey: suppressed retailer-spread that goes STALE still warns (publish job stopped)', () => {
  // The EMPTY_DATA_OK exemption must NOT mask a genuine publish-job outage:
  // once seed-meta age exceeds maxStaleMin (1500), 0 records degrades to
  // STALE_SEED (warn), not silent OK.
  const entry = classifyKey('consumerPricesSpread', BOOTSTRAP_KEYS.consumerPricesSpread,
    { allowOnDemand: false },
    makeCtx({
      strens: { [BOOTSTRAP_KEYS.consumerPricesSpread]: 296 },
      metaValues: {
        'seed-meta:consumer-prices:retailer-spread:ae:essentials-ae':
          seedMeta({ recordCount: 0, fetchedAt: NOW - 2000 * ONE_MIN_MS }),
      },
    }));
  assert.equal(entry.status, 'STALE_SEED');
  assert.equal(STATUS_COUNTS[entry.status], 'warn');
});

// ── cascade coverage (proactive, via isCascadeCovered) ──────────────────────

test('cascade: empty theaterPostureLive with data in a sibling → OK_CASCADE (no crit/warn leak)', () => {
  // group ['theaterPosture','theaterPostureLive','theaterPostureBackup']
  const entry = classifyKey('theaterPostureLive', STANDALONE_KEYS.theaterPostureLive, { allowOnDemand: true },
    makeCtx({
      strens: {
        [STANDALONE_KEYS.theaterPostureLive]: 0,   // empty
        [STANDALONE_KEYS.theaterPosture]: 4096,    // sibling (stale fallback) has data
      },
    }));
  assert.equal(entry.status, 'OK_CASCADE');
  assert.equal(STATUS_COUNTS[entry.status], 'ok');
});

test('cascade: all theater-posture members empty → EMPTY (no false OK_CASCADE)', () => {
  // theaterPostureLive is NOT in ON_DEMAND_KEYS, so a wholly-empty group is a
  // real outage → EMPTY (crit). The cascade only shields a member when a
  // SIBLING has data; when every member is empty there is nothing to cascade
  // from, so the status falls through to the strict EMPTY path.
  const entry = classifyKey('theaterPostureLive', STANDALONE_KEYS.theaterPostureLive, { allowOnDemand: true },
    makeCtx({
      strens: {
        [STANDALONE_KEYS.theaterPostureLive]: 0,
        [STANDALONE_KEYS.theaterPosture]: 0,
        [STANDALONE_KEYS.theaterPostureBackup]: 0,
      },
    }));
  assert.equal(entry.status, 'EMPTY');
  assert.equal(STATUS_COUNTS[entry.status], 'crit');
});

test('cascade: militaryFlights stale-fallback sibling with data shields the empty live key', () => {
  // group ['militaryFlights','militaryFlightsStale']
  const entry = classifyKey('militaryFlights', STANDALONE_KEYS.militaryFlights, { allowOnDemand: true },
    makeCtx({
      strens: {
        [STANDALONE_KEYS.militaryFlights]: 0,
        [STANDALONE_KEYS.militaryFlightsStale]: 8192,
      },
    }));
  assert.equal(entry.status, 'OK_CASCADE');
});

test('cascade: a member that HAS data classifies on its own merits (OK), never downgraded', () => {
  const entry = classifyKey('militaryFlights', STANDALONE_KEYS.militaryFlights, { allowOnDemand: true },
    makeCtx({
      strens: {
        [STANDALONE_KEYS.militaryFlights]: 8192,
        [STANDALONE_KEYS.militaryFlightsStale]: 8192,
      },
      metaValues: { 'seed-meta:military:flights': seedMeta() },
    }));
  assert.equal(entry.status, 'OK');
});

// ── overall status thresholds ───────────────────────────────────────────────

test('overall: 0 crit / 0 warn → HEALTHY / 200', () => {
  assert.deepEqual(computeOverall(0, 0, 150), { status: 'HEALTHY', http: 200 });
});

test('overall: warn>0 (no crit) → WARNING / 200', () => {
  assert.deepEqual(computeOverall(0, 1, 150), { status: 'WARNING', http: 200 });
  assert.deepEqual(computeOverall(0, 40, 150), { status: 'WARNING', http: 200 });
});

test('overall: crit within ~3% of total → DEGRADED / 200', () => {
  // 3/150 = 0.02 <= 0.03
  assert.deepEqual(computeOverall(3, 0, 150), { status: 'DEGRADED', http: 200 });
  assert.deepEqual(computeOverall(1, 5, 150), { status: 'DEGRADED', http: 200 });
});

test('overall: crit above ~3% of total → UNHEALTHY / 200', () => {
  // 5/150 = 0.033 > 0.03
  assert.deepEqual(computeOverall(5, 0, 150), { status: 'UNHEALTHY', http: 200 });
  assert.deepEqual(computeOverall(20, 2, 150), { status: 'UNHEALTHY', http: 200 });
});
