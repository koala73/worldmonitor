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
import { readFileSync } from 'node:fs';

import { __testing__ } from '../api/health.js';
import { BUNDLE_HEARTBEAT_TTL_SECONDS, bundleHeartbeatKey } from '../scripts/_bundle-runner.mjs';
import { BOOTSTRAP_KEY as AVIATION_BOOTSTRAP_KEY, BOOTSTRAP_META_KEY as AVIATION_BOOTSTRAP_META_KEY } from '../scripts/seed-aviation.mjs';

const {
  classifyKey,
  healthResponseBody,
  STATUS_COUNTS,
  BOOTSTRAP_KEYS,
  STANDALONE_KEYS,
  SEED_META,
  ON_DEMAND_KEYS,
  ZERO_RECORD_DATA_OK_KEYS,
  EMPTY_DATA_OK_KEYS,
} = __testing__;

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
const classifyNewsInsights = (over = {}) => classifyKey(
  'newsInsights',
  BOOTSTRAP_KEYS.newsInsights,
  { allowOnDemand: false },
  makeCtx({
    strens: { [BOOTSTRAP_KEYS.newsInsights]: 4096 },
    metaValues: { [SEED_META.newsInsights.key]: seedMeta(over) },
  }),
);

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

test('classifyKey: non-empty failedDatasets surfaces a partial static seed as SEED_ERROR', () => {
  const entry = classifyKey(
    'resilienceStaticIndex',
    STANDALONE_KEYS.resilienceStaticIndex,
    { allowOnDemand: false },
    makeCtx({
      strens: { [STANDALONE_KEYS.resilienceStaticIndex]: 4096 },
      metaValues: {
        [SEED_META.resilienceStaticIndex.key]: seedMeta({
          status: 'ok',
          recordCount: 196,
          failedDatasets: ['wgi'],
        }),
      },
    }),
  );

  assert.equal(entry.status, 'SEED_ERROR');
  assert.deepEqual(entry.failedDatasets, ['wgi']);
  const snapshot = {
    status: 'WARNING',
    summary: { total: 1, ok: 0, warn: 1, crit: 0 },
    checkedAt: new Date(NOW).toISOString(),
    checks: { resilienceStaticIndex: entry },
  };
  assert.deepEqual(
    healthResponseBody(snapshot, true).problems.resilienceStaticIndex.failedDatasets,
    ['wgi'],
  );
  assert.deepEqual(
    healthResponseBody(healthResponseBody(snapshot, true), true).problems.resilienceStaticIndex.failedDatasets,
    ['wgi'],
    'the cached compact snapshot preserves the failed adapter projection',
  );

  const siblingEntry = classifyKey(
    'resilienceStaticFao',
    STANDALONE_KEYS.resilienceStaticFao,
    { allowOnDemand: false },
    makeCtx({
      strens: { [STANDALONE_KEYS.resilienceStaticFao]: 4096 },
      metaValues: {
        [SEED_META.resilienceStaticFao.key]: seedMeta({
          status: 'ok',
          recordCount: 196,
          failedDatasets: ['wgi'],
        }),
      },
    }),
  );
  assert.equal(siblingEntry.status, 'OK');
  assert.equal(siblingEntry.failedDatasets, undefined);
});

test('classifyKey: failedDatasets projection validates, deduplicates, and stops at 50 entries', () => {
  const valid = Array.from({ length: 60 }, (_, index) => `dataset-${index}`);
  const entry = classifyKey(
    'resilienceStaticIndex',
    STANDALONE_KEYS.resilienceStaticIndex,
    { allowOnDemand: false },
    makeCtx({
      strens: { [STANDALONE_KEYS.resilienceStaticIndex]: 4096 },
      metaValues: {
        [SEED_META.resilienceStaticIndex.key]: seedMeta({
          status: 'ok',
          recordCount: 196,
          failedDatasets: [null, '', 'x'.repeat(101), valid[0], valid[0], ...valid.slice(1)],
        }),
      },
    }),
  );

  assert.equal(entry.status, 'SEED_ERROR');
  assert.deepEqual(entry.failedDatasets, valid.slice(0, 50));
});

test('classifyKey: resilience ranking and interval metadata must match the active cache state', () => {
  const original = {
    RESILIENCE_PILLAR_COMBINE_ENABLED: process.env.RESILIENCE_PILLAR_COMBINE_ENABLED,
    RESILIENCE_SCHEMA_V2_ENABLED: process.env.RESILIENCE_SCHEMA_V2_ENABLED,
    RESILIENCE_EDUCATION_ENABLED: process.env.RESILIENCE_EDUCATION_ENABLED,
  };
  process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'false';
  process.env.RESILIENCE_SCHEMA_V2_ENABLED = 'true';
  process.env.RESILIENCE_EDUCATION_ENABLED = 'true';

  const expected = {
    recordCount: 196,
    _formula: 'd6',
    _educationState: 'education-on',
    _intervalMethodology: 'weight-perturbation-sensitivity-v3',
  };

  try {
    for (const name of ['resilienceRanking', 'resilienceIntervals']) {
      const dataKey = BOOTSTRAP_KEYS[name] ?? STANDALONE_KEYS[name];
      assert.ok(dataKey, `${name} must have a registered data key`);
      const classify = (tags) => classifyKey(
        name,
        dataKey,
        { allowOnDemand: false },
        makeCtx({
          strens: { [dataKey]: 2048 },
          metaValues: { [SEED_META[name].key]: seedMeta(tags) },
        }),
      );

      const healthy = classify(expected);
      assert.equal(healthy.status, 'OK', `${name} current cache state must be healthy`);
      assert.equal(healthy.cacheState.ok, true);

      for (const staleTags of [
        {},
        { ...expected, _formula: 'pc' },
        { ...expected, _educationState: 'education-off' },
        { ...expected, _intervalMethodology: 'weight-perturbation-sensitivity-v2' },
      ]) {
        const stale = classify(staleTags);
        assert.equal(stale.status, 'STALE_SEED', `${name} must reject stale or missing cache-state tags`);
        assert.equal(stale.cacheState.ok, false);
        assert.equal(stale.cacheState.requiredFormula, 'd6');
        assert.equal(stale.cacheState.requiredEducationState, 'education-on');
        assert.equal(stale.cacheState.requiredIntervalMethodology, 'weight-perturbation-sensitivity-v3');
      }
    }
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('classifyKey: resilience formula defaults active and only explicit false selects rollback', () => {
  const originalPillar = process.env.RESILIENCE_PILLAR_COMBINE_ENABLED;
  const originalSchema = process.env.RESILIENCE_SCHEMA_V2_ENABLED;
  const originalEducation = process.env.RESILIENCE_EDUCATION_ENABLED;
  process.env.RESILIENCE_SCHEMA_V2_ENABLED = 'true';
  process.env.RESILIENCE_EDUCATION_ENABLED = 'true';

  try {
    for (const { raw, formula } of [
      { raw: undefined, formula: 'pc' },
      { raw: 'true', formula: 'pc' },
      { raw: 'false', formula: 'd6' },
    ]) {
      if (raw === undefined) delete process.env.RESILIENCE_PILLAR_COMBINE_ENABLED;
      else process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = raw;
      const dataKey = BOOTSTRAP_KEYS.resilienceRanking ?? STANDALONE_KEYS.resilienceRanking;
      assert.ok(dataKey);
      const tags = {
        _formula: formula,
        _educationState: 'education-on',
        _intervalMethodology: 'weight-perturbation-sensitivity-v3',
      };
      const entry = classifyKey(
        'resilienceRanking',
        dataKey,
        { allowOnDemand: false },
        makeCtx({
          strens: { [dataKey]: 2048 },
          metaValues: { [SEED_META.resilienceRanking.key]: seedMeta(tags) },
        }),
      );
      assert.equal(entry.status, 'OK', `pillar=${String(raw)} must require ${formula}`);
      assert.equal(entry.cacheState.requiredFormula, formula);
    }
  } finally {
    if (originalPillar == null) delete process.env.RESILIENCE_PILLAR_COMBINE_ENABLED;
    else process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = originalPillar;
    if (originalSchema == null) delete process.env.RESILIENCE_SCHEMA_V2_ENABLED;
    else process.env.RESILIENCE_SCHEMA_V2_ENABLED = originalSchema;
    if (originalEducation == null) delete process.env.RESILIENCE_EDUCATION_ENABLED;
    else process.env.RESILIENCE_EDUCATION_ENABLED = originalEducation;
  }
});

test('classifyKey: resilience interval metadata below the publication floor is partial', () => {
  const dataKey = STANDALONE_KEYS.resilienceIntervals;
  const entry = classifyKey(
    'resilienceIntervals',
    dataKey,
    { allowOnDemand: false },
    makeCtx({
      strens: { [dataKey]: 2048 },
      metaValues: {
        [SEED_META.resilienceIntervals.key]: seedMeta({
          recordCount: 179,
          _formula: 'pc',
          _educationState: 'education-on',
          _intervalMethodology: 'weight-perturbation-sensitivity-v3',
        }),
      },
    }),
  );

  assert.equal(entry.status, 'COVERAGE_PARTIAL');
  assert.equal(entry.records, 179);
  assert.equal(entry.minRecordCount, 180);
});

test('classifyKey: resilience interval coverage fails closed on missing or malformed counts', () => {
  const dataKey = STANDALONE_KEYS.resilienceIntervals;
  const malformedCounts = [undefined, null, 'invalid', Infinity, {}, []];

  for (const recordCount of malformedCounts) {
    const entry = classifyKey(
      'resilienceIntervals',
      dataKey,
      { allowOnDemand: false },
      makeCtx({
        strens: { [dataKey]: 2048 },
        metaValues: {
          [SEED_META.resilienceIntervals.key]: seedMeta({
            recordCount,
            _formula: 'pc',
            _educationState: 'education-on',
            _intervalMethodology: 'weight-perturbation-sensitivity-v3',
          }),
        },
      }),
    );

    assert.equal(entry.status, 'COVERAGE_PARTIAL', `recordCount=${String(recordCount)}`);
    assert.equal(entry.minRecordCount, 180);
  }
});

test('classifyKey: consumer-price coverage below the declared completion floor degrades', () => {
  const key = BOOTSTRAP_KEYS.consumerPricesCoverage;
  const entry = classifyKey('consumerPricesCoverage', key, { allowOnDemand: false }, makeCtx({
    strens: { [key]: 2048 },
    metaValues: {
      [SEED_META.consumerPricesCoverage.key]: seedMeta({
        recordCount: 4,
        coverage: { completedPages: 4, failedPages: 8, completionRatio: 0.3333, rejectedCount: 2 },
      }),
    },
  }));

  assert.equal(entry.status, 'COVERAGE_DEGRADED');
  assert.equal(STATUS_COUNTS[entry.status], 'warn');
});

test('classifyKey: consumer-price coverage at the floor remains healthy', () => {
  const key = BOOTSTRAP_KEYS.consumerPricesCoverage;
  const entry = classifyKey('consumerPricesCoverage', key, { allowOnDemand: false }, makeCtx({
    strens: { [key]: 2048 },
    metaValues: {
      [SEED_META.consumerPricesCoverage.key]: seedMeta({
        recordCount: 4,
        coverage: { completedPages: 6, failedPages: 6, completionRatio: 0.5, rejectedCount: 0 },
      }),
    },
  }));

  assert.equal(entry.status, 'OK');
});

test('classifyKey: a healthy market rollup keeps failed-retailer diagnostics without paging', () => {
  const key = BOOTSTRAP_KEYS.consumerPricesCoverageGB;
  const entry = classifyKey('consumerPricesCoverageGB', key, { allowOnDemand: false }, makeCtx({
    strens: { [key]: 2048 },
    metaValues: {
      [SEED_META.consumerPricesCoverageGB.key]: seedMeta({
        recordCount: 2,
        coverage: {
          status: 'healthy',
          completedPages: 12,
          failedPages: 12,
          completionRatio: 0.5,
          rejectedCount: 0,
          retailers: [
            { slug: 'ocado-gb', coverageStatus: 'healthy', pagesAttempted: 12, pagesSucceeded: 12 },
            { slug: 'tesco-gb', coverageStatus: 'failed', pagesAttempted: 12, pagesSucceeded: 0 },
          ],
        },
      }),
    },
  }));

  assert.equal(entry.status, 'OK');
  assert.equal(entry.coverage.status, 'healthy');
  assert.equal(entry.coverage.retailers[1].coverageStatus, 'failed');
});

test('classifyKey: consumer-price coverage requires diagnostics and exposes retailer rejection state', () => {
  const key = BOOTSTRAP_KEYS.consumerPricesCoverage;
  const entry = classifyKey('consumerPricesCoverage', key, { allowOnDemand: false }, makeCtx({
    strens: { [key]: 2048 },
    metaValues: {
      [SEED_META.consumerPricesCoverage.key]: seedMeta({
        recordCount: 4,
        coverage: {
          status: 'partial',
          completedPages: 8,
          failedPages: 2,
          completionRatio: 0.8,
          rejectedCount: 3,
          retailers: [{
            slug: 'retailer-a',
            name: 'Retailer A',
            coverageStatus: 'failed',
            pagesAttempted: 2,
            pagesSucceeded: 0,
            failedPages: 2,
            rejectedCount: 1,
            completionRatio: 0,
          }],
        },
      }),
    },
  }));

  assert.equal(entry.status, 'COVERAGE_PARTIAL');
  assert.equal(entry.coverage.status, 'partial');
  assert.equal(entry.coverage.rejectedCount, 3);
  assert.equal(entry.coverage.retailers[0].coverageStatus, 'failed');
});

// #6182: COVERAGE_PARTIAL is the same status whether the pages never loaded or
// a price was extracted and the validator refused it, and those need opposite
// fixes. The reason map is the only thing that separates them, so health must
// relay it — under a closed vocabulary, like every other producer code.
test('classifyKey: consumer-price coverage relays bounded failure reasons and drops unknown codes', () => {
  const key = BOOTSTRAP_KEYS.consumerPricesCoverage;
  const entry = classifyKey('consumerPricesCoverage', key, { allowOnDemand: false }, makeCtx({
    strens: { [key]: 2048 },
    metaValues: {
      [SEED_META.consumerPricesCoverage.key]: seedMeta({
        recordCount: 4,
        coverage: {
          status: 'partial',
          completedPages: 8,
          failedPages: 2,
          completionRatio: 0.8,
          rejectedCount: 3,
          failureReasons: {
            'missing-price': 2,
            'validator-rejected': 1,
            'not-a-real-reason': 9,
            'provider-error': -4,
          },
          retailers: [{
            slug: 'retailer-a',
            name: 'Retailer A',
            coverageStatus: 'failed',
            pagesAttempted: 2,
            pagesSucceeded: 0,
            failedPages: 2,
            rejectedCount: 1,
            completionRatio: 0,
            failureReasons: { 'missing-price': 2, 'bogus-code': 1 },
          }],
        },
      }),
    },
  }));

  assert.deepEqual(entry.coverage.failureReasons, {
    'missing-price': 2,
    'validator-rejected': 1,
  });
  assert.deepEqual(entry.coverage.retailers[0].failureReasons, { 'missing-price': 2 });
});

test('classifyKey: consumer-price coverage without failure reasons reports an empty map', () => {
  const key = BOOTSTRAP_KEYS.consumerPricesCoverage;
  const entry = classifyKey('consumerPricesCoverage', key, { allowOnDemand: false }, makeCtx({
    strens: { [key]: 2048 },
    metaValues: {
      [SEED_META.consumerPricesCoverage.key]: seedMeta({
        recordCount: 4,
        coverage: {
          status: 'partial',
          completedPages: 8,
          failedPages: 2,
          completionRatio: 0.8,
          rejectedCount: 3,
          retailers: [{ slug: 'retailer-a', coverageStatus: 'partial' }],
        },
      }),
    },
  }));

  assert.deepEqual(entry.coverage.failureReasons, {});
  assert.deepEqual(entry.coverage.retailers[0].failureReasons, {});
});

test('classifyKey: missing consumer-price coverage metadata fails closed', () => {
  const key = BOOTSTRAP_KEYS.consumerPricesCoverage;
  const entry = classifyKey('consumerPricesCoverage', key, { allowOnDemand: false }, makeCtx({
    strens: { [key]: 2048 },
    metaValues: { [SEED_META.consumerPricesCoverage.key]: seedMeta({ recordCount: 4 }) },
  }));

  assert.equal(entry.status, 'COVERAGE_DEGRADED');
  assert.equal(entry.coverage, null);
});

test('health registers every currently enabled consumer-price market coverage key', () => {
  for (const market of ['ae', 'au', 'br', 'gb', 'in', 'sa', 'sg', 'us']) {
    const name = market === 'ae' ? 'consumerPricesCoverage' : `consumerPricesCoverage${market.toUpperCase()}`;
    assert.equal(BOOTSTRAP_KEYS[name], `consumer-prices:coverage:${market}`);
    assert.equal(SEED_META[name].key, `seed-meta:consumer-prices:coverage:${market}`);
    assert.equal(SEED_META[name].requireCoverage, true);
  }
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

test('classifyKey: repeated insights synthesis rejection warns while the LKG remains present', () => {
  const entry = classifyNewsInsights({
    fetchedAt: NOW - 5 * ONE_MIN_MS,
    recordCount: 8,
    lastAttemptAt: NOW - 2 * ONE_MIN_MS,
    lastSuccessAt: NOW - 45 * ONE_MIN_MS,
    servedGeneratedAt: '2026-08-01T06:30:39.268Z',
    consecutiveFailures: 2,
    lastSynthesisFailureCode: 'INSIGHTS_SYNTHESIS_PARSE',
  });

  assert.equal(entry.status, 'SEED_ERROR');
  assert.equal(entry.records, 8);
  assert.equal(entry.consecutiveFailures, 2);
  assert.equal(entry.lastSynthesisFailureCode, 'INSIGHTS_SYNTHESIS_PARSE');
  assert.equal(entry.servedGeneratedAt, '2026-08-01T06:30:39.268Z');
  assert.equal(entry.lastSuccessAt, NOW - 45 * ONE_MIN_MS);
  assert.equal(STATUS_COUNTS[entry.status], 'warn');
});

test('classifyKey: one recent insights synthesis failure stays OK within the warning bounds', () => {
  const entry = classifyNewsInsights({
    fetchedAt: NOW - 5 * ONE_MIN_MS,
    recordCount: 8,
    lastAttemptAt: NOW - 2 * ONE_MIN_MS,
    lastSuccessAt: NOW - 5 * ONE_MIN_MS,
    servedGeneratedAt: '2026-08-01T08:25:39.268Z',
    consecutiveFailures: 1,
    lastSynthesisFailureCode: 'INSIGHTS_SYNTHESIS_GATE',
  });

  assert.equal(entry.status, 'OK');
  assert.equal(STATUS_COUNTS[entry.status], 'ok');
  assert.equal(entry.consecutiveFailures, 1);
  assert.equal(entry.lastSynthesisFailureCode, 'INSIGHTS_SYNTHESIS_GATE');
});

test('classifyKey: an old single insights synthesis failure warns by age', () => {
  const entry = classifyNewsInsights({
    fetchedAt: NOW - 5 * ONE_MIN_MS,
    recordCount: 8,
    lastAttemptAt: NOW - 25 * ONE_MIN_MS,
    lastSuccessAt: NOW - 10 * ONE_MIN_MS,
    servedGeneratedAt: '2026-08-01T06:30:39.268Z',
    consecutiveFailures: 1,
    lastSynthesisFailureCode: 'INSIGHTS_SYNTHESIS_GATE',
  });

  assert.equal(entry.status, 'SEED_ERROR');
  assert.equal(entry.synthesisFailureAgeMin, 25);
});

test('classifyKey: a fresh successful insights publication clears synthesis warning state', () => {
  const entry = classifyNewsInsights({
    fetchedAt: NOW - ONE_MIN_MS,
    recordCount: 8,
    lastAttemptAt: NOW - ONE_MIN_MS,
    lastSuccessAt: NOW - ONE_MIN_MS,
    servedGeneratedAt: '2026-08-01T08:30:39.268Z',
    consecutiveFailures: 0,
    lastSynthesisFailureCode: null,
  });

  assert.equal(entry.status, 'OK');
  assert.equal(entry.consecutiveFailures, 0);
  assert.equal(entry.servedGeneratedAt, '2026-08-01T08:30:39.268Z');
});

test('classifyKey: no-LKG synthesis failure warns even on the first attempted publication', () => {
  const entry = classifyNewsInsights({
    fetchedAt: NOW - ONE_MIN_MS,
    recordCount: 8,
    lastAttemptAt: NOW - ONE_MIN_MS,
    lastSuccessAt: null,
    servedGeneratedAt: '2026-08-01T08:30:39.268Z',
    consecutiveFailures: 1,
    lastSynthesisFailureCode: 'INSIGHTS_SYNTHESIS_MISSING_CLUSTER',
  });

  assert.equal(entry.status, 'SEED_ERROR');
  assert.equal(entry.consecutiveFailures, 1);
  assert.equal(entry.lastSuccessAt, null);
});

// ── marketImplications: the hourly tail LLM stage ────────────────────────────
// Same bounded-degradation contract as newsInsights, sized to an hourly cron:
// the panel serves published cards for hours, so ONE missed generation while
// fresh cards are still being served is not an incident. Two consecutive
// misses (~2h, the maxStaleMin budget) is.
const classifyMarketImplications = (over = {}) => classifyKey(
  'marketImplications',
  STANDALONE_KEYS.marketImplications,
  { allowOnDemand: false },
  makeCtx({
    strens: { [STANDALONE_KEYS.marketImplications]: 4096 },
    metaValues: {
      [SEED_META.marketImplications.key]: JSON.stringify({
        fetchedAt: NOW - 94 * ONE_MIN_MS,
        recordCount: 5,
        status: 'ok',
        ...over,
      }),
    },
  }),
);

test('classifyKey: one market-implications LLM miss over fresh served cards stays OK', () => {
  // The reported production state: three of five hourly attempts published,
  // the latest attempt timed out, five valid cards still served.
  const entry = classifyMarketImplications({
    lastAttemptAt: NOW - 4 * ONE_MIN_MS,
    lastSuccessAt: NOW - 94 * ONE_MIN_MS,
    servedGeneratedAt: '2026-08-05T17:02:30.133Z',
    consecutiveFailures: 1,
    lastSynthesisFailureCode: 'MARKET_IMPLICATIONS_LLM_NO_RESPONSE',
  });

  assert.equal(entry.status, 'OK', 'a single transient LLM miss must not warn while five cards are being served');
  assert.equal(STATUS_COUNTS[entry.status], 'ok');
  assert.equal(entry.records, 5);
  assert.equal(entry.consecutiveFailures, 1, 'the miss is still reported, it just is not an alarm yet');
  assert.equal(entry.lastSynthesisFailureCode, 'MARKET_IMPLICATIONS_LLM_NO_RESPONSE');
});

test('classifyKey: two consecutive market-implications misses warn with the reason attached', () => {
  const entry = classifyMarketImplications({
    lastAttemptAt: NOW - 4 * ONE_MIN_MS,
    lastSuccessAt: NOW - 154 * ONE_MIN_MS,
    servedGeneratedAt: '2026-08-05T17:02:30.133Z',
    consecutiveFailures: 2,
    lastSynthesisFailureCode: 'MARKET_IMPLICATIONS_LLM_NO_RESPONSE',
  });

  assert.equal(entry.status, 'SEED_ERROR');
  assert.equal(STATUS_COUNTS[entry.status], 'warn');
  assert.equal(entry.consecutiveFailures, 2);
  assert.equal(entry.lastSynthesisFailureCode, 'MARKET_IMPLICATIONS_LLM_NO_RESPONSE');
  assert.equal(entry.servedGeneratedAt, '2026-08-05T17:02:30.133Z');
});

test('classifyKey: every market-implications failure code reaches health', () => {
  for (const code of [
    'MARKET_IMPLICATIONS_LLM_NO_RESPONSE',
    'MARKET_IMPLICATIONS_NO_PARSEABLE_CARDS',
    'MARKET_IMPLICATIONS_VALIDATION',
    'MARKET_IMPLICATIONS_UNKNOWN',
  ]) {
    const entry = classifyMarketImplications({
      lastAttemptAt: NOW - 4 * ONE_MIN_MS,
      consecutiveFailures: 2,
      lastSynthesisFailureCode: code,
    });
    assert.equal(entry.lastSynthesisFailureCode, code, `${code} must survive validation`);
  }
});

test('classifyKey: a foreign failure code is rejected on the market-implications key', () => {
  // The code vocabulary is per-key. A newsInsights code appearing here would
  // mean the pattern degenerated into "any string", which would let a
  // malformed producer write arbitrary text into the health response.
  const entry = classifyMarketImplications({
    lastAttemptAt: NOW - 4 * ONE_MIN_MS,
    consecutiveFailures: 2,
    lastSynthesisFailureCode: 'INSIGHTS_SYNTHESIS_PARSE',
  });

  assert.equal(entry.status, 'SEED_ERROR', 'the streak still escalates');
  assert.equal(entry.lastSynthesisFailureCode, undefined, 'but a foreign code is not echoed');
});

test('classifyKey: a stalled market-implications cron warns by attempt age, not silently', () => {
  // A single miss followed by no further attempt for over two hours: the
  // served cards are past the staleness budget, so this would classify as a
  // bare STALE_SEED. The failure contract upgrades it to SEED_ERROR so the
  // operator gets the reason, not just the age.
  const entry = classifyMarketImplications({
    fetchedAt: NOW - 190 * ONE_MIN_MS,
    lastAttemptAt: NOW - 125 * ONE_MIN_MS,
    lastSuccessAt: NOW - 190 * ONE_MIN_MS,
    consecutiveFailures: 1,
    lastSynthesisFailureCode: 'MARKET_IMPLICATIONS_LLM_NO_RESPONSE',
  });

  assert.equal(entry.status, 'SEED_ERROR');
  assert.equal(entry.synthesisFailureAgeMin, 125);
});

test('classifyKey: market-implications age escalation still fires with no failure recorded', () => {
  // A budget starve records no failure at all, so the streak contract must not
  // be the only thing that can escalate — the served vintage aging past
  // maxStaleMin (120) still has to surface on its own.
  const entry = classifyMarketImplications({
    fetchedAt: NOW - 200 * ONE_MIN_MS,
    lastAttemptAt: NOW - 200 * ONE_MIN_MS,
    lastSuccessAt: NOW - 200 * ONE_MIN_MS,
    consecutiveFailures: 0,
  });

  assert.equal(entry.status, 'STALE_SEED');
  assert.equal(STATUS_COUNTS[entry.status], 'warn');
});

test('every synthesisFailure key declares its own failure-code vocabulary', () => {
  // readSeedMeta falls back to the insights pattern when a key omits
  // failureCodePattern, which would silently DROP every code a third producer
  // writes — its streak would still escalate, but the reason would vanish.
  // The fallback stays for safety; this is the guard that stops a new key
  // from depending on it.
  const withContract = Object.entries(SEED_META).filter(([, cfg]) => cfg?.synthesisFailure);
  assert.ok(withContract.length >= 2, 'guard against this passing because the mechanism disappeared');
  for (const [name, cfg] of withContract) {
    assert.ok(
      cfg.synthesisFailure.failureCodePattern instanceof RegExp,
      `${name} must declare its own failureCodePattern, not inherit the insights default`,
    );
    assert.ok(
      !cfg.synthesisFailure.failureCodePattern.global,
      `${name}'s pattern must not be /g — a stateful lastIndex makes .test() alternate between true and false`,
    );
  }
});

test('classifyKey: a failure streak must not downgrade a vanished panel from EMPTY to a warn', () => {
  // The canonical key holds 180min; the seed-meta holds 7 days. So a cron that
  // dies right after a miss leaves a failure-bearing meta pointing at a panel
  // that emptied hours ago. A producer-failure warning describes
  // degraded-but-serving — when nothing is served at all, the stronger
  // absence verdict has to win, or a blank homepage panel reports warn
  // instead of crit for the rest of the week.
  const entry = classifyKey(
    'marketImplications',
    STANDALONE_KEYS.marketImplications,
    { allowOnDemand: false },
    makeCtx({
      strens: {}, // canonical key expired -> panel is blank
      metaValues: {
        [SEED_META.marketImplications.key]: JSON.stringify({
          fetchedAt: NOW - 190 * ONE_MIN_MS,
          recordCount: 5,
          status: 'ok',
          lastAttemptAt: NOW - 185 * ONE_MIN_MS,
          lastSuccessAt: NOW - 190 * ONE_MIN_MS,
          consecutiveFailures: 1,
          lastSynthesisFailureCode: 'MARKET_IMPLICATIONS_LLM_NO_RESPONSE',
        }),
      },
    }),
  );

  assert.equal(entry.status, 'EMPTY');
  assert.equal(STATUS_COUNTS[entry.status], 'crit', 'an absent homepage panel is a crit, per the ON_DEMAND_KEYS policy block');
  assert.equal(
    entry.lastSynthesisFailureCode,
    'MARKET_IMPLICATIONS_LLM_NO_RESPONSE',
    'the recorded reason survives the escalation — a bare crit with no cause makes the operator re-read seed-meta by hand',
  );
});

test('classifyKey: an insights failure streak likewise cannot mask a vanished LKG', () => {
  // Same precedence, asserted on the other key that carries this contract, so
  // the fix is not silently market-implications-only.
  const entry = classifyKey(
    'newsInsights',
    BOOTSTRAP_KEYS.newsInsights,
    { allowOnDemand: false },
    makeCtx({
      strens: {},
      metaValues: {
        [SEED_META.newsInsights.key]: seedMeta({
          lastAttemptAt: NOW - 2 * ONE_MIN_MS,
          consecutiveFailures: 2,
          lastSynthesisFailureCode: 'INSIGHTS_SYNTHESIS_PARSE',
        }),
      },
    }),
  );

  assert.equal(entry.status, 'EMPTY');
});

test('classifyKey: a market-implications run with nothing servable still errors immediately', () => {
  // The producer's fail-closed branch: no last-good cards to hold a content
  // clock against, so it writes the zero-record error meta and health must
  // warn on the FIRST occurrence.
  const entry = classifyMarketImplications({
    fetchedAt: NOW - ONE_MIN_MS,
    recordCount: 0,
    status: 'error',
    errorReason: 'llm_no_response',
  });

  assert.equal(entry.status, 'SEED_ERROR');
  assert.equal(STATUS_COUNTS[entry.status], 'warn');
});

// ── Producer fault vs. missing data, fleet-wide (#6263) ──────────────────────
// The synthesisFailure arm above learned to yield to the absence verdict. The
// `seedError` and `sourceBlocked` arms sit on the same seam and apply to EVERY
// SEED_META key, so the rule has to be stated once for all of them: a
// producer-fault verdict says WHY the producer is unhappy, the absence verdict
// says WHETHER anything is being served, and when both are true the STRONGER
// one wins.
//
// That is deliberately not the one-word `&& hasData` guard the issue proposed.
// Four key classes resolve an absent data key to something SOFTER than
// SEED_ERROR — EMPTY_DATA_OK_KEYS (OK/STALE_SEED), cascade coverage
// (OK_CASCADE), on-demand (EMPTY_ON_DEMAND) and rollout (ROLLOUT_PENDING) — so
// a bare guard would demote or silence those instead of escalating them. Each
// class gets a lock below.

test('classifyKey: an error seed-meta must not downgrade a vanished panel from EMPTY to a warn', () => {
  // The fleet-wide twin of the synthesisFailure case above. seed-meta holds 7
  // days, the canonical key 180min, so a producer that errored once and then
  // stopped leaves a blank homepage panel reporting warn for the rest of the
  // week.
  const entry = classifyKey(
    'marketImplications',
    STANDALONE_KEYS.marketImplications,
    { allowOnDemand: false },
    makeCtx({
      strens: {}, // canonical key expired -> panel is blank
      metaValues: {
        [SEED_META.marketImplications.key]: JSON.stringify({
          fetchedAt: NOW - 190 * ONE_MIN_MS,
          recordCount: 0,
          status: 'error',
          errorReason: 'llm_no_response',
          errorCode: 'MARKET_IMPLICATIONS_LLM_NO_RESPONSE',
        }),
      },
    }),
  );

  assert.equal(entry.status, 'EMPTY');
  assert.equal(STATUS_COUNTS[entry.status], 'crit');
  assert.equal(
    entry.errorCode,
    'MARKET_IMPLICATIONS_LLM_NO_RESPONSE',
    'escalating the severity must not cost the operator the cause the producer recorded',
  );
});

test('classifyKey: a degraded sourceState likewise cannot mask a vanished panel', () => {
  // seedError has two producers: `status:'error'` (above) and any non-ok
  // `sourceState` (here). The second reaches classifyKey with a FRESH
  // fetchedAt — seedStale stays false — so it is the arm that can hide an
  // absence behind an otherwise healthy-looking meta.
  const entry = classifyKey(
    'marketImplications',
    STANDALONE_KEYS.marketImplications,
    { allowOnDemand: false },
    makeCtx({
      strens: {},
      metaValues: {
        [SEED_META.marketImplications.key]: JSON.stringify({
          fetchedAt: NOW - ONE_MIN_MS,
          recordCount: 5,
          sourceState: 'error',
        }),
      },
    }),
  );

  assert.equal(entry.status, 'EMPTY');
  assert.equal(STATUS_COUNTS[entry.status], 'crit');
});

test('classifyKey: a blocked source with no data escalates like every other fault', () => {
  // The `sourceBlocked` arm has the same shape and today produces the fleet's
  // one self-contradiction: crossStraitActivityJapanMod is excluded from it, so
  // that key ALREADY reports EMPTY for a blocked-and-absent state while every
  // other key reports SEED_ERROR. One state, two verdicts. Assert both agree.
  const blockedAndAbsent = (name) => classifyKey(
    name,
    STANDALONE_KEYS[name],
    { allowOnDemand: false },
    makeCtx({
      strens: {},
      metaValues: {
        [SEED_META[name].key]: JSON.stringify({
          fetchedAt: NOW - ONE_MIN_MS,
          recordCount: 0,
          sourceState: 'blocked',
        }),
      },
    }),
  );

  assert.equal(blockedAndAbsent('humanitarianSummary').status, 'EMPTY');
  assert.equal(blockedAndAbsent('crossStraitActivityJapanMod').status, 'EMPTY');

  // Both landing on EMPTY proves they AGREE, but not that the blocked fault
  // still fires at all — a guard that dropped it entirely would produce the
  // same pair. Pin the other direction on the same key: with data present, the
  // non-Japan blocked arm still yields its fault.
  const blockedWithData = classifyKey(
    'humanitarianSummary',
    STANDALONE_KEYS.humanitarianSummary,
    { allowOnDemand: false },
    makeCtx({
      strens: { [STANDALONE_KEYS.humanitarianSummary]: 2048 },
      metaValues: {
        [SEED_META.humanitarianSummary.key]: JSON.stringify({
          fetchedAt: NOW - ONE_MIN_MS,
          recordCount: 4,
          sourceState: 'blocked',
        }),
      },
    }),
  );
  assert.equal(blockedWithData.status, 'SEED_ERROR');
});

test('classifyKey: a collapsed forecast funnel keeps SEED_ERROR when its payload is absent', () => {
  // forecastFunnel is in EMPTY_DATA_OK_KEYS, so its absence branch resolves to
  // OK/STALE_SEED — softer than the fault. api/health.js's own comment on the
  // set entry states the dependency: "A COLLAPSED funnel still surfaces via
  // seed-meta status:'error' → SEED_ERROR, which classifyKey checks before this
  // branch." A bare `&& hasData` guard would demote the collapse to a generic
  // STALE_SEED and drop the reason.
  const entry = classifyKey(
    'forecastFunnel',
    STANDALONE_KEYS.forecastFunnel,
    { allowOnDemand: false },
    makeCtx({
      strens: {},
      metaValues: {
        [SEED_META.forecastFunnel.key]: JSON.stringify({
          fetchedAt: NOW - ONE_MIN_MS,
          recordCount: 0,
          status: 'error',
          errorReason: 'funnel_collapsed',
        }),
      },
    }),
  );

  assert.equal(entry.status, 'SEED_ERROR');
  assert.equal(STATUS_COUNTS[entry.status], 'warn');
});

test('classifyKey: a fresh degraded funnel source is not silently OK when its payload is absent', () => {
  // The sharpest edge of the same class: `sourceState` degradation leaves
  // seedStale false, so EMPTY_DATA_OK_KEYS resolves the absence to plain OK. A
  // bare `&& hasData` guard would turn a reported producer fault into a green
  // check — the exact softening #6263 exists to remove.
  const entry = classifyKey(
    'forecastFunnel',
    STANDALONE_KEYS.forecastFunnel,
    { allowOnDemand: false },
    makeCtx({
      strens: {},
      metaValues: {
        [SEED_META.forecastFunnel.key]: JSON.stringify({
          fetchedAt: NOW - ONE_MIN_MS,
          recordCount: 0,
          sourceState: 'error',
        }),
      },
    }),
  );

  assert.equal(entry.status, 'SEED_ERROR');
  // The absence verdict this beat, asserted directly: with the fault removed
  // the very same fixture resolves to a green OK, so the fault is doing all the
  // work here and a guard that skipped it would ship a silent pass.
  const withoutFault = classifyKey(
    'forecastFunnel',
    STANDALONE_KEYS.forecastFunnel,
    { allowOnDemand: false },
    makeCtx({
      strens: {},
      metaValues: {
        [SEED_META.forecastFunnel.key]: JSON.stringify({
          fetchedAt: NOW - ONE_MIN_MS,
          recordCount: 0,
        }),
      },
    }),
  );
  assert.equal(withoutFault.status, 'OK');
});

test('classifyKey: cascade coverage does not hide a producer error on the covered key', () => {
  // militaryFlights cascades onto militaryFlightsStale. Cascade answers "is the
  // panel being served from a sibling", which is true here — but the live
  // producer still reported a fault, and OK_CASCADE would erase it. Absence
  // resolves to `ok`, softer than the fault, so the fault holds.
  const entry = classifyKey(
    'militaryFlights',
    STANDALONE_KEYS.militaryFlights,
    { allowOnDemand: false },
    makeCtx({
      strens: { [STANDALONE_KEYS.militaryFlightsStale]: 2048 },
      metaValues: {
        [SEED_META.militaryFlights.key]: JSON.stringify({
          fetchedAt: NOW - ONE_MIN_MS,
          recordCount: 0,
          status: 'error',
          errorReason: 'opensky_auth_failed',
        }),
      },
    }),
  );

  assert.equal(entry.status, 'SEED_ERROR');
});

test('classifyKey: a compact projection that must always publish is EMPTY when it errors with no payload', () => {
  // MISSING_DATA_IS_FAILURE_KEYS members publish a canonical payload on every
  // successful cycle, so a vanished payload is a real publish failure. The set
  // is also a subset of EMPTY_DATA_OK_KEYS, whose absence verdict is only
  // STALE_SEED — so if the strict arm is skipped, the fault ties the softer
  // verdict and wins, and the key reports warn.
  //
  // The arm is skipped exactly when `seedStale === true`, and readSeedMeta
  // SYNTHESIZES that on the `status:'error'` return as a fault marker rather
  // than measuring it. Reading a fault marker as "the meta aged out" is what
  // let #6263's own headline case — a `status:'error'` seed-meta over a
  // vanished panel — survive on all eight of these keys.
  const entry = classifyKey(
    'crossStraitActivityBootstrap',
    STANDALONE_KEYS.crossStraitActivityBootstrap,
    { allowOnDemand: false },
    makeCtx({
      strens: {},
      metaValues: {
        [SEED_META.crossStraitActivityBootstrap.key]: JSON.stringify({
          fetchedAt: NOW - ONE_MIN_MS,
          recordCount: 0,
          status: 'error',
          errorReason: 'publish_failed',
        }),
      },
    }),
  );

  assert.equal(entry.status, 'EMPTY');
  assert.equal(STATUS_COUNTS[entry.status], 'crit');
});

test('classifyKey: both fault paths agree for one physical state on a strict projection', () => {
  // The parity that finding above turns on. `status:'error'` and a non-ok
  // `sourceState` are two ways to say "the producer is failing", and
  // readSeedMeta treats them differently — the first forces seedStale true, the
  // second measures it. Same key, same absent payload, same fault: the verdict
  // must not depend on which dialect the producer used.
  const classifyWith = (meta) => classifyKey(
    'wildfiresBootstrap',
    STANDALONE_KEYS.wildfiresBootstrap,
    { allowOnDemand: false },
    makeCtx({
      strens: {},
      metaValues: {
        [SEED_META.wildfiresBootstrap.key]: JSON.stringify({
          fetchedAt: NOW - ONE_MIN_MS,
          recordCount: 0,
          ...meta,
        }),
      },
    }),
  );

  assert.equal(
    classifyWith({ status: 'error', errorReason: 'publish_failed' }).status,
    classifyWith({ sourceState: 'error' }).status,
    'a producer reporting failure via status:error must classify like one reporting it via sourceState',
  );
});

test('classifyKey: a strict projection that has never published keeps its STALE_SEED grace', () => {
  // The other side of the same guard, and the reason it cannot simply be
  // deleted: before the producer's first run the payload is absent with no
  // fault recorded, and EMPTY (crit) would be a false alarm on a key that is
  // merely new. Only a REPORTED fault revokes the grace — absence alone does
  // not.
  const entry = classifyKey(
    'wildfiresBootstrap',
    STANDALONE_KEYS.wildfiresBootstrap,
    { allowOnDemand: false },
    makeCtx({
      strens: {},
      metaValues: {
        [SEED_META.wildfiresBootstrap.key]: JSON.stringify({
          fetchedAt: NOW - 10_000 * ONE_MIN_MS, // long past maxStaleMin
          recordCount: 0,
        }),
      },
    }),
  );

  assert.equal(entry.status, 'STALE_SEED');
  assert.equal(STATUS_COUNTS[entry.status], 'warn');
});

test('classifyKey: an unconfigured adapter raises no fault and publishes no errorCode', () => {
  // NOT_CONFIGURED means "this deployment never opted into the adapter", so
  // there is nothing to be degraded ABOUT — the fault is skipped entirely
  // rather than merely losing the verdict. Without the `!sourceUnavailable`
  // guard the fault still fires, and a green NOT_CONFIGURED entry ships an
  // errorCode for a producer this deployment does not run.
  //
  // Asserted on `errorCode` only. `lastSynthesisFailureCode` is deliberately
  // ungated upstream — it rides with consecutiveFailures/lastAttemptAt, which
  // publish on every status — so its presence here is correct, not a leak.
  const entry = classifyKey(
    'marketImplications',
    STANDALONE_KEYS.marketImplications,
    { allowOnDemand: false },
    makeCtx({
      strens: { [STANDALONE_KEYS.marketImplications]: 4096 },
      metaValues: {
        [SEED_META.marketImplications.key]: JSON.stringify({
          fetchedAt: NOW - ONE_MIN_MS,
          recordCount: 5,
          sourceState: 'unavailable',
          errorCode: 'PRODUCER_FAILED',
          lastAttemptAt: NOW - ONE_MIN_MS,
          lastSuccessAt: NOW - 200 * ONE_MIN_MS,
          consecutiveFailures: 3,
          lastSynthesisFailureCode: 'MARKET_IMPLICATIONS_LLM_NO_RESPONSE',
        }),
      },
    }),
  );

  assert.equal(entry.status, 'NOT_CONFIGURED');
  assert.equal(STATUS_COUNTS[entry.status], 'ok');
  assert.equal(Object.hasOwn(entry, 'errorCode'), false, 'an unconfigured adapter has no fault to explain');
});

test('classifyKey: a fault outranks every served-data verdict it precedes', () => {
  // The refactor hoisted the fault arms out of the status if/else chain into a
  // precomputed `fault`, and only the placement of `else if (fault)` keeps them
  // ahead of the records===0 / staleness / coverage arms. Nothing else pins
  // that ordering, so a reordering would go unnoticed — most visibly as
  // EMPTY_DATA, which is what a mis-ordered fault arm produces for the
  // zero-record case.
  const withData = (over) => classifyKey(
    'gdeltIntel',
    BOOTSTRAP_KEYS.gdeltIntel,
    { allowOnDemand: false },
    makeCtx({
      strens: { [BOOTSTRAP_KEYS.gdeltIntel]: 4096 },
      metaValues: {
        'seed-meta:intelligence:gdelt-intel': JSON.stringify({
          fetchedAt: NOW - ONE_MIN_MS,
          recordCount: 5,
          ...over,
        }),
      },
    }),
  );

  assert.equal(withData({ status: 'error' }).status, 'SEED_ERROR', 'fault beats a healthy served payload');
  assert.equal(
    withData({ status: 'error', recordCount: 0 }).status,
    'SEED_ERROR',
    'fault beats EMPTY_DATA — a zero-record payload under a reported fault is the fault, not a separate finding',
  );
  assert.equal(
    withData({ sourceState: 'error', fetchedAt: NOW - 10_000 * ONE_MIN_MS }).status,
    'SEED_ERROR',
    'fault beats STALE_SEED',
  );
});

test('classifyKey: an on-demand key with an error seed-meta keeps the error verdict', () => {
  // EMPTY_ON_DEMAND and SEED_ERROR are both warn, so severity alone does not
  // separate them — the tie goes to the fault, which is the only one of the two
  // that carries a cause.
  const entry = classifyKey(
    'macroSignals',
    STANDALONE_KEYS.macroSignals,
    { allowOnDemand: true },
    makeCtx({
      strens: {},
      metaValues: {
        [SEED_META.macroSignals.key]: JSON.stringify({
          fetchedAt: NOW - ONE_MIN_MS,
          recordCount: 0,
          status: 'error',
          errorReason: 'macro_publish_failed',
        }),
      },
    }),
  );

  assert.equal(entry.status, 'SEED_ERROR');
  assert.equal(entry.onDemand, true);
});

test('compact health problem projection retains insights synthesis diagnostics', () => {
  const snapshot = {
    status: 'WARNING',
    summary: { total: 1, ok: 0, warn: 1, crit: 0 },
    checkedAt: '2026-08-01T08:31:00.000Z',
    checks: {
      newsInsights: {
        status: 'SEED_ERROR',
        records: 8,
        maxStaleMin: 30,
        consecutiveFailures: 2,
        lastSynthesisFailureCode: 'INSIGHTS_SYNTHESIS_PARSE',
        servedGeneratedAt: '2026-08-01T06:30:39.268Z',
      },
    },
  };

  assert.deepEqual(healthResponseBody(snapshot, true).problems.newsInsights, snapshot.checks.newsInsights);
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

test('classifyKey: sector valuation partial/total loss degrades despite 12 price rows', () => {
  for (const valuationState of [
    { sourceState: 'partial', valuationRecordCount: 3 },
    { sourceState: 'error', valuationRecordCount: 0 },
  ]) {
    const entry = classifyKey('sectors', BOOTSTRAP_KEYS.sectors, { allowOnDemand: false },
      makeCtx({
        strens: { [BOOTSTRAP_KEYS.sectors]: 1234 },
        metaValues: {
          'seed-meta:market:sectors': seedMeta({
            recordCount: 12,
            sectorRecordCount: 12,
            expectedValuationRecordCount: 12,
            ...valuationState,
          }),
        },
      }));

    assert.equal(entry.status, 'SEED_ERROR');
    assert.equal(entry.records, 12, 'price coverage remains visible');
    assert.equal(STATUS_COUNTS[entry.status], 'warn');
  }
});

test('classifyKey: sector valuation recovery returns health to OK', () => {
  const entry = classifyKey('sectors', BOOTSTRAP_KEYS.sectors, { allowOnDemand: false },
    makeCtx({
      strens: { [BOOTSTRAP_KEYS.sectors]: 1234 },
      metaValues: {
        'seed-meta:market:sectors': seedMeta({
          recordCount: 12,
          sectorRecordCount: 12,
          valuationRecordCount: 12,
          expectedValuationRecordCount: 12,
          sourceState: 'ok',
        }),
      },
    }));

  assert.equal(entry.status, 'OK');
  assert.equal(entry.records, 12);
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

test('classifyKey: predictionMarkets with one empty pool → COVERAGE_PARTIAL', () => {
  const entry = classifyKey('predictionMarkets', BOOTSTRAP_KEYS.predictionMarkets, { allowOnDemand: false },
    makeCtx({
      strens: { [BOOTSTRAP_KEYS.predictionMarkets]: 1234 },
      metaValues: {
        'seed-meta:prediction:markets': seedMeta({
          recordCount: 38,
          poolCounts: { geopolitical: 18, tech: 0, finance: 20 },
        }),
      },
    }));

  assert.equal(entry.status, 'COVERAGE_PARTIAL');
  assert.equal(entry.records, 38);
  assert.deepEqual(entry.poolCounts, { geopolitical: 18, tech: 0, finance: 20 });
  assert.deepEqual(entry.minPoolCounts, { geopolitical: 1, tech: 1, finance: 1 });
  assert.equal(STATUS_COUNTS[entry.status], 'warn');
});

test('classifyKey: stale prediction snapshot outranks per-pool coverage', () => {
  const entry = classifyKey('predictionMarkets', BOOTSTRAP_KEYS.predictionMarkets, { allowOnDemand: false },
    makeCtx({
      strens: { [BOOTSTRAP_KEYS.predictionMarkets]: 1234 },
      metaValues: {
        'seed-meta:prediction:markets': seedMeta({
          fetchedAt: NOW - 100 * ONE_MIN_MS,
          recordCount: 38,
          poolCounts: { geopolitical: 18, tech: 0, finance: 20 },
        }),
      },
    }));

  assert.equal(entry.status, 'STALE_SEED');
  assert.deepEqual(entry.poolCounts, { geopolitical: 18, tech: 0, finance: 20 });
});

test('classifyKey: predictionMarkets requires valid per-pool metadata', () => {
  const entry = classifyKey('predictionMarkets', BOOTSTRAP_KEYS.predictionMarkets, { allowOnDemand: false },
    makeCtx({
      strens: { [BOOTSTRAP_KEYS.predictionMarkets]: 1234 },
      metaValues: {
        'seed-meta:prediction:markets': seedMeta({ recordCount: 38 }),
      },
    }));

  assert.equal(entry.status, 'COVERAGE_PARTIAL');
  assert.equal(Object.hasOwn(entry, 'poolCounts'), false);
  assert.deepEqual(entry.minPoolCounts, { geopolitical: 1, tech: 1, finance: 1 });
});

test('classifyKey: predictionMarkets is OK when every pool meets its floor', () => {
  const entry = classifyKey('predictionMarkets', BOOTSTRAP_KEYS.predictionMarkets, { allowOnDemand: false },
    makeCtx({
      strens: { [BOOTSTRAP_KEYS.predictionMarkets]: 1234 },
      metaValues: {
        'seed-meta:prediction:markets': seedMeta({
          recordCount: 20,
          poolCounts: { geopolitical: 1, tech: 1, finance: 18 },
        }),
      },
    }));

  assert.equal(entry.status, 'OK');
  assert.deepEqual(entry.poolCounts, { geopolitical: 1, tech: 1, finance: 18 });
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
  assert.equal(entry.records, 5);
});

test('classifyKey: gdelt timeline repair metadata → SEED_ERROR while canonical articles remain available', () => {
  const entry = classifyKey('gdeltIntel', BOOTSTRAP_KEYS.gdeltIntel, { allowOnDemand: false },
    makeCtx({
      strens: { [BOOTSTRAP_KEYS.gdeltIntel]: 4096 },
      metaValues: {
        'seed-meta:intelligence:gdelt-intel': seedMeta({
          recordCount: 6,
          status: 'error',
          errorReason: 'timeline_keys_missing_or_unconfirmed',
          errorCode: 'GDELT_SHARED_PROXY_TLS',
          missingTimelineKeys: ['gdelt:intel:vol:military'],
        }),
      },
    }));
  assert.equal(entry.status, 'SEED_ERROR');
  assert.equal(STATUS_COUNTS[entry.status], 'warn');
  assert.equal(entry.records, 6,
    'SEED_ERROR preserves the declared canonical record count while surfacing the timeline outage');
  assert.equal(entry.errorCode, 'GDELT_SHARED_PROXY_TLS');
});

test('classifyKey: unsafe free-form error codes are not reflected into health', () => {
  const entry = classifyKey('gdeltIntel', BOOTSTRAP_KEYS.gdeltIntel, { allowOnDemand: false },
    makeCtx({
      strens: { [BOOTSTRAP_KEYS.gdeltIntel]: 4096 },
      metaValues: {
        'seed-meta:intelligence:gdelt-intel': seedMeta({
          status: 'error',
          errorCode: 'proxy failed at https://user:pass@example.test',
        }),
      },
    }));
  assert.equal(entry.status, 'SEED_ERROR');
  assert.equal(Object.hasOwn(entry, 'errorCode'), false);
});

test('compact health preserves the bounded GDELT failure code', () => {
  const snapshot = {
    status: 'WARNING',
    summary: { ok: 1, warn: 1, crit: 0 },
    checkedAt: '2026-07-29T08:00:00.000Z',
    checks: {
      gdeltIntel: {
        status: 'SEED_ERROR',
        records: 6,
        maxStaleMin: 720,
        errorCode: 'GDELT_SHARED_PROXY_TLS',
      },
    },
  };
  assert.deepEqual(healthResponseBody(snapshot, true).problems.gdeltIntel, {
    status: 'SEED_ERROR',
    records: 6,
    maxStaleMin: 720,
    errorCode: 'GDELT_SHARED_PROXY_TLS',
  });
});

test('classifyKey: degraded source with a non-positive or invalid fetchedAt exposes unknown age', () => {
  const name = 'crossStraitActivityJapanMod';
  const dataKey = STANDALONE_KEYS[name];
  const metaKey = SEED_META[name].key;

  for (const fetchedAt of [0, -1, 'invalid']) {
    const entry = classifyKey(name, dataKey, { allowOnDemand: true },
      makeCtx({
        strens: { [dataKey]: 396 },
        metaValues: {
          [metaKey]: seedMeta({
            fetchedAt,
            recordCount: 2,
            sourceState: 'error',
            stale: true,
          }),
        },
      }));

    assert.equal(entry.status, 'SEED_ERROR', String(fetchedAt));
    assert.equal(entry.records, 2, String(fetchedAt));
    assert.equal(
      Object.hasOwn(entry, 'seedAgeMin'),
      false,
      `${String(fetchedAt)} must remain unknown instead of fabricating an age`,
    );
  }
});

test('classifyKey: missing corporate-disclosure payload cannot be hidden by fresh zero-record metadata', () => {
  const name = 'chinaCorporateDisclosures';
  const dataKey = BOOTSTRAP_KEYS[name] ?? STANDALONE_KEYS[name];
  const metaKey = SEED_META[name].key;
  const entry = classifyKey(name, dataKey, { allowOnDemand: true },
    makeCtx({
      metaValues: {
        [metaKey]: seedMeta({ recordCount: 0 }),
      },
    }));

  assert.equal(entry.status, 'EMPTY');
  assert.equal(entry.records, 0);
  assert.equal(STATUS_COUNTS[entry.status], 'crit');
});

test('classifyKey: present current corporate-disclosure payload may contain zero admitted events', () => {
  const name = 'chinaCorporateDisclosures';
  const dataKey = BOOTSTRAP_KEYS[name] ?? STANDALONE_KEYS[name];
  const metaKey = SEED_META[name].key;
  const entry = classifyKey(name, dataKey, { allowOnDemand: true },
    makeCtx({
      strens: { [dataKey]: 512 },
      metaValues: {
        [metaKey]: seedMeta({ recordCount: 0 }),
      },
    }));

  assert.equal(entry.status, 'OK');
  assert.equal(entry.records, 0);
  assert.equal(STATUS_COUNTS[entry.status], 'ok');
});

test('classifyKey: a permanently blocked humanitarian provider surfaces as SEED_ERROR', () => {
  const dataKey = STANDALONE_KEYS.humanitarianSummary;
  const metaKey = SEED_META.humanitarianSummary.key;
  const entry = classifyKey('humanitarianSummary', dataKey, { allowOnDemand: false },
    makeCtx({
      strens: { [dataKey]: 1234 },
      metaValues: {
        [metaKey]: seedMeta({
          status: 'error',
          errorReason: 'HAPI_HDX_SNAPSHOT_FALLBACK_FAILED',
        }),
      },
    }));

  assert.equal(entry.status, 'SEED_ERROR');
  assert.equal(STATUS_COUNTS[entry.status], 'warn');
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
  ['comtradeBilateralHs4', 'seed-meta:comtrade:bilateral-hs4', 'seed-meta:comtrade:bilateral-hs4', 50400],
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

const ISSUE_6125_MILITARY_DOWNSTREAM_REGISTRATIONS = [
  ['militaryForecastInputs', 'military:forecast-inputs:stale:v1', 'seed-meta:military-forecast-inputs'],
  ['militarySurges', 'military:surges:stale:v1', 'seed-meta:military-surges'],
];

test('issue #6125: downstream military publish keys have strict 10-minute-cron budgets', () => {
  for (const [name, dataKey, metaKey] of ISSUE_6125_MILITARY_DOWNSTREAM_REGISTRATIONS) {
    assert.equal(STANDALONE_KEYS[name], dataKey, `${name} data key`);
    assert.deepEqual(SEED_META[name], { key: metaKey, maxStaleMin: 30 }, `${name} health budget`);
    assert.equal(ON_DEMAND_KEYS.has(name), false, `${name} must not be softened as on-demand`);
  }
});

test('issue #6125: a mid-publish crash after the headline write makes downstream health non-OK', () => {
  // Simulate the observed publish order: the headline flight snapshot and its
  // health metadata advance, then the process dies before forecast-input and
  // surge publication. The downstream checks must still alarm independently.
  const headline = classifyKey(
    'militaryFlights',
    STANDALONE_KEYS.militaryFlights,
    { allowOnDemand: true },
    makeCtx({
      strens: { [STANDALONE_KEYS.militaryFlights]: 4096 },
      metaValues: { [SEED_META.militaryFlights.key]: seedMeta() },
    }),
  );
  assert.equal(headline.status, 'OK');

  for (const [name, dataKey] of ISSUE_6125_MILITARY_DOWNSTREAM_REGISTRATIONS) {
    const missing = classifyKey(name, dataKey, { allowOnDemand: true }, makeCtx());
    assert.equal(missing.status, 'EMPTY', `${name} must alarm when the late write never happened`);

    const stale = classifyKey(
      name,
      dataKey,
      { allowOnDemand: true },
      makeCtx({
        strens: { [dataKey]: 4096 },
        metaValues: {
          [SEED_META[name].key]: seedMeta({ fetchedAt: NOW - 31 * ONE_MIN_MS }),
        },
      }),
    );
    assert.equal(stale.status, 'STALE_SEED', `${name} must alarm when its prior snapshot ages past 30min`);
  }
});

test('issue #6125: a fresh zero-surge snapshot is healthy, but a stale one still warns', () => {
  const name = 'militarySurges';
  const dataKey = STANDALONE_KEYS[name];
  const metaKey = SEED_META[name].key;

  assert.equal(ZERO_RECORD_DATA_OK_KEYS.has(name), true);

  const fresh = classifyKey(name, dataKey, { allowOnDemand: true }, makeCtx({
    strens: { [dataKey]: 256 },
    metaValues: { [metaKey]: seedMeta({ recordCount: 0 }) },
  }));
  assert.equal(fresh.status, 'OK');
  assert.equal(fresh.records, 0);

  const stale = classifyKey(name, dataKey, { allowOnDemand: true }, makeCtx({
    strens: { [dataKey]: 256 },
    metaValues: { [metaKey]: seedMeta({ recordCount: 0, fetchedAt: NOW - 31 * ONE_MIN_MS }) },
  }));
  assert.equal(stale.status, 'STALE_SEED');
  assert.equal(stale.records, 0);
});

test('HKO warning snapshots are classified through their matching seed-meta key', () => {
  assert.equal(STANDALONE_KEYS.hkoWarnings, 'weather:hko-warnings:v1');
  assert.deepEqual(SEED_META.hkoWarnings, {
    key: 'seed-meta:weather:hko-warnings',
    maxStaleMin: 540,
  });

  const entry = classifyKey('hkoWarnings', STANDALONE_KEYS.hkoWarnings, { allowOnDemand: true },
    makeCtx({
      strens: { [STANDALONE_KEYS.hkoWarnings]: 1024 },
      metaValues: { 'seed-meta:weather:hko-warnings': seedMeta({ recordCount: 1 }) },
    }));

  assert.equal(entry.status, 'OK');
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
  assert.equal(entry.maxStaleMin, 50400);
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

const BUNDLE_TICKS = [
  ['staticRefBundleTick', 'static-ref', 'scripts/seed-bundle-static-ref.mjs', 6691],
  ['staticRefHeavyBundleTick', 'static-ref-heavy', 'scripts/seed-bundle-static-ref-heavy.mjs', 6806],
];

test('classifyKey: each bundle tick heartbeat goes EMPTY when the cron never fired and STALE when it freezes', () => {
  for (const [name, label] of BUNDLE_TICKS) {
    const dataKey = STANDALONE_KEYS[name];
    const seedCfg = SEED_META[name];
    assert.equal(dataKey, bundleHeartbeatKey(label), name);

    const missing = classifyKey(name, dataKey, { allowOnDemand: true }, makeCtx({}));
    assert.equal(missing.status, 'EMPTY', name);
    assert.equal(STATUS_COUNTS[missing.status], 'crit', name);

    const stale = classifyKey(name, dataKey, { allowOnDemand: true }, makeCtx({
      strens: { [dataKey]: 128 },
      metaValues: { [seedCfg.key]: seedMeta({ fetchedAt: NOW - 2881 * ONE_MIN_MS, recordCount: 1 }) },
    }));
    assert.equal(stale.status, 'STALE_SEED', name);
    assert.equal(stale.maxStaleMin, 2880, name);
    assert.equal(STATUS_COUNTS[stale.status], 'warn', name);

    const fresh = classifyKey(name, dataKey, { allowOnDemand: true }, makeCtx({
      strens: { [dataKey]: 128 },
      metaValues: { [seedCfg.key]: seedMeta({ recordCount: 1 }) },
    }));
    assert.equal(fresh.status, 'OK', name);
  }
});

test('the three bundle tick heartbeats stay registered together (#6691 / #6806)', () => {
  for (const [name, label, bundlePath, issue] of BUNDLE_TICKS) {
    assert.equal(STANDALONE_KEYS[name], bundleHeartbeatKey(label));
    assert.equal(SEED_META[name].key, bundleHeartbeatKey(label));
    assert.equal(SEED_META[name].maxStaleMin, 2880, `${name} must use the 48h = 2× daily budget`);
    assert.equal(ON_DEMAND_KEYS.has(name), false, `${name} is a seeded watchdog, not on-demand`);
    assert.equal(SEED_META[name].cutover?.mode, 'expiring-ack');
    assert.equal(SEED_META[name].cutover?.fromKey, null);
    assert.equal(SEED_META[name].cutover?.status, 'EMPTY');
    assert.equal(SEED_META[name].cutover?.issue, issue);
    assert.ok(
      BUNDLE_HEARTBEAT_TTL_SECONDS > SEED_META[name].maxStaleMin * 60,
      `${name}: TTL must outlive maxStaleMin so a late tick is STALE_SEED, not EMPTY`,
    );
    const bundle = readFileSync(new URL(`../${bundlePath}`, import.meta.url), 'utf8');
    assert.match(bundle, new RegExp(`runBundle\\(\\s*'${label}'\\s*,`));
  }
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

test('classifyKey: expired transitional producers fail closed when missing or empty', () => {
  const graduatedNames = [
    'fxYoy',
    'hyperliquidFlow',
    'chokepointFlowsRelayHeartbeat',
    'climateNewsRelayHeartbeat',
    'eiaPetroleum',
    'digestNotifications',
  ];

  for (const name of graduatedNames) {
    const dataKey = BOOTSTRAP_KEYS[name] ?? STANDALONE_KEYS[name];
    const seedCfg = SEED_META[name];
    assert.ok(dataKey, `${name}: data key remains registered`);
    assert.ok(seedCfg, `${name}: freshness metadata remains registered`);
    assert.equal(ON_DEMAND_KEYS.has(name), false, `${name}: expired softening must be retired`);

    const missing = classifyKey(name, dataKey, { allowOnDemand: true }, makeCtx({}));
    assert.equal(missing.status, 'EMPTY', `${name}: a vanished producer output is critical`);
    assert.equal(STATUS_COUNTS[missing.status], 'crit');

    const empty = classifyKey(name, dataKey, { allowOnDemand: true }, makeCtx({
      strens: { [dataKey]: 128 },
      metaValues: { [seedCfg.key]: seedMeta({ recordCount: 0 }) },
    }));
    assert.equal(empty.status, 'EMPTY_DATA', `${name}: zero records are critical`);
    assert.equal(STATUS_COUNTS[empty.status], 'crit');
  }
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

// #6987. flightDelays serves the combined page-load aggregate but read its
// record count from seed-meta:aviation:faa, which carries the FAA-ONLY count
// (seed-aviation.mjs writes it as faa.alerts.length). On 2026-08-20 a quiet FAA
// window published recordCount=0 while the aggregate still served 115 alerts --
// 14 of them FAA-sourced -- and classifyKey read that zero as EMPTY_DATA,
// blocking the seed-freshness monitor with a healthy panel.
const classifyFlightDelays = (over = {}, strlen = 57_608) => classifyKey(
  'flightDelays',
  BOOTSTRAP_KEYS.flightDelays,
  { allowOnDemand: false },
  makeCtx({
    strens: { [BOOTSTRAP_KEYS.flightDelays]: strlen },
    metaValues: { [SEED_META.flightDelays.key]: seedMeta(over) },
  }),
);

test('#6987 — a quiet FAA window does not empty the aggregate flightDelays serves', () => {
  // The exact production shape: aggregate full, FAA contributing nothing.
  assert.equal(classifyFlightDelays({ recordCount: 115 }).status, 'OK');
});

test('#6987 — an aggregate that is genuinely empty still alarms', () => {
  // The counterweight. Fixing the false alarm must not blind the probe: this is
  // the state the EMPTY_DATA verdict exists for, and it must survive.
  assert.equal(classifyFlightDelays({ recordCount: 0 }).status, 'EMPTY_DATA');
});

test('#6987 — flightDelays counts its own data key, not a contributing source', () => {
  // The regression itself, asserted structurally so it cannot creep back via a
  // key swap that the two behavioural tests above would still pass.
  assert.notEqual(
    SEED_META.flightDelays.key,
    'seed-meta:aviation:faa',
    'seed-meta:aviation:faa counts FAA alerts only — strictly smaller than the aggregate served',
  );
  // writeSeedMeta derives `seed-meta:<dataKey without :vN>`; pinning health to
  // that derivation is what keeps the count and the payload the same population.
  assert.equal(
    SEED_META.flightDelays.key,
    `seed-meta:${BOOTSTRAP_KEYS.flightDelays.replace(/:v\d+$/, '')}`,
  );
});

test('#6987 — health and seed-aviation agree on the aggregate meta key', () => {
  // Cross-file, against the seeder's REAL exported constants rather than a
  // regex over its source: if the producer renames the key it writes, or health
  // repoints, this fails instead of both sides drifting quietly.
  assert.equal(BOOTSTRAP_KEYS.flightDelays, AVIATION_BOOTSTRAP_KEY);
  assert.equal(SEED_META.flightDelays.key, AVIATION_BOOTSTRAP_META_KEY);
});

// The other half of #6987. faaDelays had no SEED_META entry at all, on the
// grounds that it "shares flightDelays's meta key" — the sharing that caused the
// bug. It now has an explicit one (ported from #6988), which must ADD staleness
// coverage without withdrawing the quiet-window allowance that makes an empty
// FAA feed a valid state rather than a fault.
const classifyFaaDelays = (over = {}) => classifyKey(
  'faaDelays',
  STANDALONE_KEYS.faaDelays,
  { allowOnDemand: false },
  makeCtx({
    strens: { [STANDALONE_KEYS.faaDelays]: 13 }, // {"alerts":[]}
    metaValues: { [SEED_META.faaDelays.key]: seedMeta(over) },
  }),
);

test('#6987 — a quiet FAA window stays valid for the sidecar probe', () => {
  assert.ok(
    EMPTY_DATA_OK_KEYS.has('faaDelays'),
    'an empty FAA feed is a normal state; withdrawing that turns quiet nights into alarms',
  );
  assert.equal(classifyFaaDelays({ recordCount: 0 }).status, 'OK');
});

test('#6987 — the sidecar probe gains the staleness coverage it never had', () => {
  // The point of giving faaDelays its own entry: allowed-to-be-empty must not
  // also mean allowed-to-stop. 200min against maxStaleMin 90.
  assert.equal(
    classifyFaaDelays({ recordCount: 0, fetchedAt: NOW - 200 * ONE_MIN_MS }).status,
    'STALE_SEED',
  );
});

test('#6987 — the two aviation probes no longer share a meta key', () => {
  // The regression in one line: sharing let FAA's allowed-empty count decide the
  // aggregate probe, which is not allowed to be empty.
  assert.notEqual(SEED_META.flightDelays.key, SEED_META.faaDelays.key);
  assert.equal(SEED_META.faaDelays.key, 'seed-meta:aviation:faa');
});
