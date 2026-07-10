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

const { classifyKey, STATUS_COUNTS, BOOTSTRAP_KEYS, STANDALONE_KEYS, SEED_META } = __testing__;

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

test('classifyKey: riskScores partial realtime family coverage → COVERAGE_PARTIAL', () => {
  const entry = classifyKey('riskScores', BOOTSTRAP_KEYS.riskScores, { allowOnDemand: false },
    makeCtx({
      strens: { [BOOTSTRAP_KEYS.riskScores]: 1234 },
      metaValues: { 'seed-meta:intelligence:risk-scores': seedMeta({ recordCount: 1 }) },
    }));

  assert.equal(entry.status, 'COVERAGE_PARTIAL');
  assert.equal(entry.records, 1);
  assert.equal(entry.minRecordCount, 3);
  assert.equal(STATUS_COUNTS[entry.status], 'warn');
});

test('classifyKey: portwatchPortActivity below 174 countries → COVERAGE_PARTIAL', () => {
  const entry = classifyKey('portwatchPortActivity', STANDALONE_KEYS.portwatchPortActivity, { allowOnDemand: true },
    makeCtx({
      strens: { [STANDALONE_KEYS.portwatchPortActivity]: 1234 },
      metaValues: { 'seed-meta:supply_chain:portwatch-ports': seedMeta({ recordCount: 139 }) },
    }));

  assert.equal(entry.status, 'COVERAGE_PARTIAL');
  assert.equal(entry.records, 139);
  assert.equal(entry.minRecordCount, 174);
  assert.equal(STATUS_COUNTS[entry.status], 'warn');
});

test('classifyKey: socialVelocity error seed-meta → SEED_ERROR while data is preserved', () => {
  const entry = classifyKey('socialVelocity', BOOTSTRAP_KEYS.socialVelocity, { allowOnDemand: false },
    makeCtx({
      strens: { [BOOTSTRAP_KEYS.socialVelocity]: 1234 },
      metaValues: {
        'seed-meta:intelligence:social-reddit': seedMeta({
          status: 'error',
          errorReason: 'empty_reddit_response: r/worldnews HTTP 403; r/geopolitics HTTP 403',
        }),
      },
    }));
  assert.equal(entry.status, 'SEED_ERROR');
  assert.equal(STATUS_COUNTS[entry.status], 'warn');
  assert.equal(entry.records, 1);
});

test('classifyKey: socialVelocity/wsbTickers tolerate the 3h cadence — fresh at 300min → OK', () => {
  // Cadence dropped 1h→3h (ScrapeCreators), so maxStaleMin was raised 180→540.
  // A healthy seed-meta aged 300min (5h, inside 540) must NOT false-alarm.
  for (const [name, metaKey] of [
    ['socialVelocity', 'seed-meta:intelligence:social-reddit'],
    ['wsbTickers', 'seed-meta:intelligence:wsb-tickers'],
  ]) {
    const entry = classifyKey(name, BOOTSTRAP_KEYS[name], { allowOnDemand: false },
      makeCtx({
        strens: { [BOOTSTRAP_KEYS[name]]: 4096 },
        metaValues: { [metaKey]: seedMeta({ fetchedAt: NOW - 300 * ONE_MIN_MS }) },
      }));
    assert.equal(entry.status, 'OK', `${name} at 300min should be OK`);
  }
});

test('classifyKey: dead relay, data still present (9h–12h window) → STALE_SEED (warn)', () => {
  // A dead relay stops refreshing seed-meta, but the data key lives for its full
  // 12h TTL (> maxStaleMin=540min/9h), so 540–720min is a real present-but-stale
  // window → STALE_SEED. This is reachable in production ONLY because the data-key
  // TTL (43200s) STRICTLY exceeds maxStaleMin; at TTL==maxStaleMin the key would
  // expire exactly when staleness begins and classifyKey would emit EMPTY instead.
  for (const [name, metaKey] of [
    ['socialVelocity', 'seed-meta:intelligence:social-reddit'],
    ['wsbTickers', 'seed-meta:intelligence:wsb-tickers'],
  ]) {
    const entry = classifyKey(name, BOOTSTRAP_KEYS[name], { allowOnDemand: false },
      makeCtx({
        strens: { [BOOTSTRAP_KEYS[name]]: 4096 },
        metaValues: { [metaKey]: seedMeta({ fetchedAt: NOW - 600 * ONE_MIN_MS }) },
      }));
    assert.equal(entry.status, 'STALE_SEED', `${name} at 600min (data present) should be STALE_SEED`);
    assert.equal(STATUS_COUNTS[entry.status], 'warn');
  }
});

test('classifyKey: dead relay past the 12h TTL, data key expired → EMPTY (crit) escalation', () => {
  // Once the data key expires (after the 12h TTL on a fully-dead relay),
  // hasData=false → classifyKey hits the !hasData branch (checked BEFORE seedStale,
  // api/health.js) and returns EMPTY (crit), escalating from the earlier STALE_SEED
  // warn. Verified shape: { status: 'EMPTY', records: 0 }.
  for (const [name, metaKey] of [
    ['socialVelocity', 'seed-meta:intelligence:social-reddit'],
    ['wsbTickers', 'seed-meta:intelligence:wsb-tickers'],
  ]) {
    const entry = classifyKey(name, BOOTSTRAP_KEYS[name], { allowOnDemand: false },
      makeCtx({
        // no strens entry → data key absent (expired)
        metaValues: { [metaKey]: seedMeta({ fetchedAt: NOW - 800 * ONE_MIN_MS }) },
      }));
    assert.equal(entry.status, 'EMPTY', `${name} with expired data should be EMPTY`);
    assert.equal(STATUS_COUNTS[entry.status], 'crit');
    assert.equal(entry.records, 0);
  }
});

test('classifyKey: empty bootstrap key (no cascade) → EMPTY (crit)', () => {
  const entry = classifyKey('earthquakes', BOOTSTRAP_KEYS.earthquakes, { allowOnDemand: false },
    makeCtx({ metaValues: { 'seed-meta:seismology:earthquakes': seedMeta() } }));
  assert.equal(entry.status, 'EMPTY');
  assert.equal(STATUS_COUNTS[entry.status], 'crit');
});

const ISSUE_5055_HEALTH_REGISTRATIONS = [
  ['energyPrices', 'economic:energy:v1:all', 'seed-meta:economic:energy-prices', 150],
  ['researchArxivHnTrending', 'research:arxiv:v1:cs.AI::50', 'seed-meta:research:arxiv-hn-trending', 150],
  ['defensePatents', 'patents:defense:latest', 'seed-meta:military:defense-patents', 25200],
  ['acledIntel', 'conflict:acled:v1:all:0:0', 'seed-meta:conflict:acled-intel', 38],
  ['portwatchDisruptions', 'portwatch:disruptions:active:v1', 'seed-meta:portwatch:disruptions', 150],
  ['comtradeBilateralHs4', 'seed-meta:comtrade:bilateral-hs4', 'seed-meta:comtrade:bilateral-hs4', 34560],
  ['sharedFxRates', 'shared:fx-rates:v1', 'seed-meta:shared:fx-rates', 3600],
  ['submarineCables', 'infrastructure:submarine-cables:v1', 'seed-meta:infrastructure:submarine-cables', 25200],
];

test('issue #5055: validated seed-meta writers are registered in /api/health', () => {
  for (const [name, dataKey, metaKey, maxStaleMin] of ISSUE_5055_HEALTH_REGISTRATIONS) {
    assert.equal(STANDALONE_KEYS[name], dataKey, `${name} data key`);
    assert.equal(SEED_META[name]?.key, metaKey, `${name} seed-meta key`);
    assert.equal(SEED_META[name]?.maxStaleMin, maxStaleMin, `${name} maxStaleMin`);
  }
});

test('classifyKey: issue #5055 strict seeds surface missing metadata instead of reporting OK', () => {
  const entry = classifyKey('energyPrices', STANDALONE_KEYS.energyPrices, { allowOnDemand: true },
    makeCtx({ strens: { [STANDALONE_KEYS.energyPrices]: 2048 } }));

  assert.equal(entry.status, 'STALE_SEED');
  assert.equal(entry.records, 1);
  assert.equal(entry.maxStaleMin, 150);
  assert.equal(STATUS_COUNTS[entry.status], 'warn');
});

test('classifyKey: issue #5099 ACLED display feed is strict, not on-demand softened', () => {
  const missing = classifyKey('acledIntel', STANDALONE_KEYS.acledIntel, { allowOnDemand: true },
    makeCtx({}));
  assert.equal(missing.status, 'EMPTY');
  assert.equal(missing.records, 0);
  assert.equal(missing.maxStaleMin, 38);
  assert.equal(STATUS_COUNTS[missing.status], 'crit');

  const dataWithoutMeta = classifyKey('acledIntel', STANDALONE_KEYS.acledIntel, { allowOnDemand: true },
    makeCtx({ strens: { [STANDALONE_KEYS.acledIntel]: 2048 } }));
  assert.equal(dataWithoutMeta.status, 'STALE_SEED');
  assert.equal(dataWithoutMeta.records, 1);
  assert.equal(dataWithoutMeta.maxStaleMin, 38);
  assert.equal(STATUS_COUNTS[dataWithoutMeta.status], 'warn');
});

test('classifyKey: issue #5055 Comtrade bilateral probe is explicitly meta-only', () => {
  const metaKey = 'seed-meta:comtrade:bilateral-hs4';
  const entry = classifyKey('comtradeBilateralHs4', STANDALONE_KEYS.comtradeBilateralHs4, { allowOnDemand: true },
    makeCtx({
      strens: { [metaKey]: 96 },
      metaValues: { [metaKey]: seedMeta({ recordCount: 180 }) },
    }));

  assert.equal(STANDALONE_KEYS.comtradeBilateralHs4, metaKey);
  assert.equal(entry.status, 'OK');
  assert.equal(entry.records, 180);
  assert.equal(entry.maxStaleMin, 34560);
});

test('classifyKey: empty on-demand standalone key → EMPTY_ON_DEMAND (warn)', () => {
  // minerals is in ON_DEMAND_KEYS and has no SEED_META entry.
  const entry = classifyKey('minerals', STANDALONE_KEYS.minerals, { allowOnDemand: true }, makeCtx({}));
  assert.equal(entry.status, 'EMPTY_ON_DEMAND');
  assert.equal(STATUS_COUNTS[entry.status], 'warn');
});

test('classifyKey: webcams active pointer is registered with seed-meta freshness', () => {
  const entry = classifyKey('webcams', STANDALONE_KEYS.webcams, { allowOnDemand: true },
    makeCtx({
      strens: { [STANDALONE_KEYS.webcams]: 13 },
      metaValues: { 'seed-meta:webcam:cameras:geo': seedMeta({ recordCount: 65000 }) },
    }));

  assert.equal(STANDALONE_KEYS.webcams, 'webcam:cameras:active');
  assert.equal(entry.status, 'OK');
  assert.equal(entry.records, 65000);
  assert.equal(entry.maxStaleMin, 1440);
});

test('classifyKey: digestNotifications heartbeat goes stale when the cron stops', () => {
  const entry = classifyKey('digestNotifications', STANDALONE_KEYS.digestNotifications, { allowOnDemand: true },
    makeCtx({
      strens: { [STANDALONE_KEYS.digestNotifications]: 256 },
      metaValues: {
        'seed-meta:digest:last-run': seedMeta({
          fetchedAt: NOW - 120 * ONE_MIN_MS,
          sentCount: 0,
        }),
      },
    }));

  assert.equal(STANDALONE_KEYS.digestNotifications, 'digest:last-run');
  assert.equal(entry.status, 'STALE_SEED');
  assert.equal(entry.maxStaleMin, 90);
  assert.equal(STATUS_COUNTS[entry.status], 'warn');
});

test('classifyKey: digestNotifications missing before first cron run is transitional warn', () => {
  const entry = classifyKey('digestNotifications', STANDALONE_KEYS.digestNotifications, { allowOnDemand: true },
    makeCtx({}));

  assert.equal(entry.status, 'EMPTY_ON_DEMAND');
  assert.equal(entry.records, 0);
  assert.equal(entry.maxStaleMin, 90);
  assert.equal(STATUS_COUNTS[entry.status], 'warn');
});

test('classifyKey: suppressed retailer-spread (present key, 0 records) while fresh → OK, not EMPTY_DATA', () => {
  // The consumer-prices aggregate job writes retailer_spread_pct: 0 ("spread
  // suppressed (N/4 common items)") when a market's retailers share < 4 common
  // basket items — a valid data-coverage state, not an outage. The key exists
  // (296-byte payload → hasData=true) with metaCount=0, so without the
  // zero-record exemption it would wrongly classify EMPTY_DATA (crit) and
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

test('classifyKey: missing retailer-spread payload is still EMPTY even with fresh 0-record meta', () => {
  // The suppressed-spread exemption only applies once Redis proves the payload
  // exists. A missing canonical key is still a publish/write failure and must
  // not be hidden by the zero-record allowance.
  const entry = classifyKey('consumerPricesSpread', BOOTSTRAP_KEYS.consumerPricesSpread,
    { allowOnDemand: false },
    makeCtx({
      metaValues: {
        'seed-meta:consumer-prices:retailer-spread:ae:essentials-ae':
          seedMeta({ recordCount: 0 }),
      },
    }));
  assert.equal(entry.status, 'EMPTY');
  assert.equal(STATUS_COUNTS[entry.status], 'crit');
});

test('classifyKey: suppressed retailer-spread that goes STALE still warns (publish job stopped)', () => {
  // The zero-record exemption must NOT mask a genuine publish-job outage:
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

// ── CF Radar outages: sparse zeroIsValid feed (seed-internet-outages) ───────

test('classifyKey: outages present key + 0 records while fresh → OK (sparse feed, not EMPTY_DATA)', () => {
  // CF Radar curated outage annotations are sparse; most 28d windows publish an
  // empty {outages:[]} envelope (hasData=true) with recordCount=0. With
  // zeroIsValid the seeder refreshes seed-meta fresh, so this must classify OK,
  // not EMPTY_DATA (crit) and not STALE_SEED.
  const entry = classifyKey('outages', BOOTSTRAP_KEYS.outages, { allowOnDemand: false },
    makeCtx({
      strens: { [BOOTSTRAP_KEYS.outages]: 149 }, // empty {outages:[]} envelope
      metaValues: { 'seed-meta:infra:outages': seedMeta({ recordCount: 0 }) },
    }));
  assert.equal(entry.status, 'OK');
  assert.equal(STATUS_COUNTS[entry.status], 'ok');
});

test('classifyKey: missing outages payload is still EMPTY even with fresh 0-record meta', () => {
  // The zero-record exemption is NARROW: it only applies once Redis proves the
  // payload exists. A missing canonical key means publish died and must alarm
  // EMPTY (crit), not be hidden by the sparse-feed allowance.
  const entry = classifyKey('outages', BOOTSTRAP_KEYS.outages, { allowOnDemand: false },
    makeCtx({
      metaValues: { 'seed-meta:infra:outages': seedMeta({ recordCount: 0 }) },
    }));
  assert.equal(entry.status, 'EMPTY');
  assert.equal(STATUS_COUNTS[entry.status], 'crit');
});

test('classifyKey: outages present + 0 records that goes STALE still warns (cron stopped)', () => {
  // The exemption must NOT mask a genuine cron outage: once seed-meta age
  // exceeds maxStaleMin (30), 0 records degrades to STALE_SEED (warn), not OK.
  const entry = classifyKey('outages', BOOTSTRAP_KEYS.outages, { allowOnDemand: false },
    makeCtx({
      strens: { [BOOTSTRAP_KEYS.outages]: 149 },
      metaValues: { 'seed-meta:infra:outages': seedMeta({ recordCount: 0, fetchedAt: NOW - 200 * ONE_MIN_MS }) },
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
