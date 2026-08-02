// #6060 — health must not report a 174/174 PortWatch run with stale China
// content as an undifferentiated healthy state.
//
// The existing STALE_CONTENT branch keys off `newestItemAt`, which answers
// "did the source publish anything recently". That question is useless for a
// per-country corpus: one 98-hour-old decision-critical country hides behind
// 173 fresh ones. This adds the per-entity half — the producer publishes a
// `contentFreshness` block and health fails closed when it is absent.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { __testing__ } from '../api/health.js';
import { jsonResponse } from '../api/_json-response.js';

const {
  readSeedMeta,
  classifyKey,
  healthResponseBody,
  STATUS_COUNTS,
  SEED_META,
} = __testing__;

const NOW = Date.parse('2026-08-02T14:42:58.000Z');
const MINUTE_MS = 60_000;
const PORTWATCH_META_KEY = 'seed-meta:supply_chain:portwatch-ports';
const PORTWATCH_DATA_KEY = 'supply_chain:portwatch-ports:v1:_countries';

function contentFreshnessOf(overrides = {}) {
  return {
    budgetMinutes: 4320,
    assessedAt: NOW,
    coveredCount: 174,
    freshCount: 174,
    staleCount: 0,
    unknownCount: 0,
    staleCountries: [],
    staleCountriesTruncated: 0,
    oldestObservedAt: NOW - 60 * MINUTE_MS,
    oldestObservedCountry: 'US',
    oldestAgeMinutes: 60,
    criticalCountries: ['CN', 'HK'],
    criticalFreshCount: 2,
    criticalStaleCountries: [],
    criticalMissingCountries: 0,
    criticalOldestObservedAt: NOW - 60 * MINUTE_MS,
    criticalOldestObservedCountry: 'CN',
    criticalOldestAgeMinutes: 60,
    ...overrides,
  };
}

function portwatchCtx(meta) {
  return {
    keyStrens: new Map([[PORTWATCH_DATA_KEY, 4096]]),
    keyErrors: new Map(),
    keyMetaValues: new Map([[PORTWATCH_META_KEY, JSON.stringify(meta)]]),
    keyMetaErrors: new Map(),
    now: NOW,
  };
}

function classifyPortwatch(meta) {
  return classifyKey(
    'portwatchPortActivity',
    PORTWATCH_DATA_KEY,
    {},
    portwatchCtx(meta),
  );
}

// A run exactly like the 12:03 UTC production run: OK, 174 seeded, complete
// coverage, zero refreshFailures — the transport half is genuinely healthy.
function completeRun(contentFreshness) {
  return {
    fetchedAt: NOW - 159 * MINUTE_MS,
    recordCount: 174,
    coverage: {
      target: 174,
      referenceCountryCount: 174,
      published: 174,
      complete: true,
      missingCountries: [],
      unidentifiedMissingCount: 0,
      refreshFailures: [],
    },
    ...(contentFreshness === undefined ? {} : { contentFreshness }),
  };
}

describe('readSeedMeta content-freshness parsing', () => {
  const seedCfg = { key: PORTWATCH_META_KEY, maxStaleMin: 2160, requireContentFreshness: true };

  it('surfaces a bounded content-freshness block', () => {
    const ctx = portwatchCtx(completeRun(contentFreshnessOf({
      freshCount: 173,
      staleCount: 1,
      staleCountries: ['CN'],
      criticalFreshCount: 1,
      criticalStaleCountries: ['CN'],
      criticalOldestObservedAt: Date.parse('2026-07-29T12:02:43.475Z'),
      criticalOldestObservedCountry: 'CN',
      criticalOldestAgeMinutes: 5920,
    })));
    const meta = readSeedMeta(seedCfg, ctx.keyMetaValues, ctx.keyMetaErrors, ctx.now);

    assert.ok(meta.contentFreshness, 'block present');
    assert.equal(meta.contentFreshness.contentStale, true);
    assert.equal(meta.contentFreshness.staleCount, 1);
    assert.deepEqual(meta.contentFreshness.criticalStaleCountries, ['CN']);
    assert.equal(meta.contentFreshness.criticalOldestAgeMinutes, 5920);
  });

  it('does not alarm on fleet-wide rotation lag outside the decision-critical set', () => {
    // 30-of-174 refreshes per 12h run means the rotation tail is routinely
    // past budget. That is the seeder working as designed, not an incident.
    const ctx = portwatchCtx(completeRun(contentFreshnessOf({
      freshCount: 150,
      staleCount: 24,
      staleCountries: ['BR', 'ZA'],
    })));
    const meta = readSeedMeta(seedCfg, ctx.keyMetaValues, ctx.keyMetaErrors, ctx.now);
    assert.equal(meta.contentFreshness.contentStale, false);
    assert.equal(meta.contentFreshness.staleCount, 24, 'still visible to operators');
  });

  it('caps the reported stale-country list independently of the producer', () => {
    const ctx = portwatchCtx(completeRun(contentFreshnessOf({
      freshCount: 0,
      staleCount: 174,
      staleCountries: Array.from({ length: 200 }, (_, index) => `C${index}`),
    })));
    const meta = readSeedMeta(seedCfg, ctx.keyMetaValues, ctx.keyMetaErrors, ctx.now);
    assert.equal(meta.contentFreshness.staleCountries.length, 40);
  });

  it('returns null for a check that never opted in', () => {
    const legacyCfg = { key: PORTWATCH_META_KEY, maxStaleMin: 2160 };
    const ctx = portwatchCtx(completeRun(contentFreshnessOf()));
    const meta = readSeedMeta(legacyCfg, ctx.keyMetaValues, ctx.keyMetaErrors, ctx.now);
    assert.equal(meta.contentFreshness, null, 'opt-in is health-config, not producer-driven');
  });
});

describe('portwatchPortActivity classification', () => {
  it('is registered to require content freshness', () => {
    assert.equal(SEED_META.portwatchPortActivity.requireContentFreshness, true);
    assert.equal(SEED_META.portwatchPortActivity.minRecordCount, 174);
  });

  it('reports OK when 174/174 countries are also content-fresh', () => {
    const entry = classifyPortwatch(completeRun(contentFreshnessOf()));
    assert.equal(entry.status, 'OK');
    assert.equal(entry.records, 174);
  });

  it('#6060: a complete 174/174 run with stale China content is not healthy', () => {
    const entry = classifyPortwatch(completeRun(contentFreshnessOf({
      freshCount: 173,
      staleCount: 1,
      staleCountries: ['CN'],
      criticalFreshCount: 1,
      criticalStaleCountries: ['CN'],
      criticalOldestObservedAt: Date.parse('2026-07-29T12:02:43.475Z'),
      criticalOldestObservedCountry: 'CN',
      criticalOldestAgeMinutes: 5920,
    })));

    assert.equal(entry.status, 'STALE_CONTENT');
    assert.equal(entry.records, 174, 'cardinality stays truthful — this is not a coverage gap');
    assert.deepEqual(entry.contentFreshness.criticalStaleCountries, ['CN']);
    assert.equal(
      entry.contentFreshness.criticalOldestObservedCountry,
      'CN',
      'operators get the stale source family, not a generic warning',
    );
    assert.equal(entry.contentFreshness.criticalOldestAgeMinutes, 5920);
  });

  it('alarms when a decision-critical country drops out of the run entirely', () => {
    const entry = classifyPortwatch(completeRun(contentFreshnessOf({
      criticalFreshCount: 1,
      criticalStaleCountries: ['CN'],
      criticalMissingCountries: 1,
    })));
    assert.equal(entry.status, 'STALE_CONTENT');
  });

  it('fails closed when a required content-freshness block is missing or malformed', () => {
    for (const missing of [undefined, null, 'not-an-object', 42, []]) {
      const entry = classifyPortwatch(completeRun(missing));
      assert.equal(
        entry.status,
        'COVERAGE_DEGRADED',
        `contentFreshness=${JSON.stringify(missing) ?? 'undefined'} must not read as healthy`,
      );
    }
  });

  it('fails closed when the block is present but its counts are unusable', () => {
    for (const broken of [
      { coveredCount: 174, freshCount: 'many' },
      { coveredCount: 174, freshCount: -1 },
      { coveredCount: null, freshCount: 174 },
      { coveredCount: 174, freshCount: 175 },
      // A producer that declares no critical set cannot prove the decision
      // inputs are fresh, whatever its fleet-wide numbers say.
      { criticalCountries: [] },
      { criticalCountries: 'CN,HK' },
      { criticalFreshCount: null },
      { criticalFreshCount: 3 },
    ]) {
      const entry = classifyPortwatch(completeRun({ ...contentFreshnessOf(), ...broken }));
      assert.equal(
        entry.status,
        'COVERAGE_DEGRADED',
        `unusable counts ${JSON.stringify(broken)} must not read as healthy`,
      );
    }
  });

  it('keeps cardinality and transport shortfalls ahead of content staleness', () => {
    const stale = contentFreshnessOf({
      freshCount: 173,
      staleCount: 1,
      staleCountries: ['CN'],
      criticalFreshCount: 1,
      criticalStaleCountries: ['CN'],
    });

    const shortCoverage = classifyPortwatch({ ...completeRun(stale), recordCount: 120 });
    assert.equal(shortCoverage.status, 'COVERAGE_PARTIAL', 'a real coverage gap outranks it');

    const staleSeed = classifyPortwatch({
      ...completeRun(stale),
      fetchedAt: NOW - 3000 * MINUTE_MS,
    });
    assert.equal(staleSeed.status, 'STALE_SEED', 'a dead producer outranks it');
  });

  it('buckets STALE_CONTENT as a warning, not a pass', () => {
    assert.equal(STATUS_COUNTS.STALE_CONTENT, 'warn');
  });

  // The anonymous `?compact=1` projection echoes whole check entries for every
  // problem status. `chinaDecisionSignals` is already stripped there because
  // China source freshness is operator-only; a named stale-country list is the
  // same class of detail and must not ride out on the public status endpoint.
  it('keeps named stale countries out of the anonymous compact projection', () => {
    const entry = classifyPortwatch(completeRun(contentFreshnessOf({
      freshCount: 173,
      staleCount: 1,
      staleCountries: ['CN'],
      criticalFreshCount: 1,
      criticalStaleCountries: ['CN'],
      criticalOldestObservedCountry: 'CN',
    })));
    assert.equal(entry.status, 'STALE_CONTENT');

    const compact = healthResponseBody({
      status: 'WARNING',
      summary: { ok: 1, warning: 1 },
      checkedAt: '2026-08-02T14:42:58.000Z',
      checks: { portwatchPortActivity: entry },
    }, true);

    const problem = compact.problems?.portwatchPortActivity;
    assert.equal(problem?.status, 'STALE_CONTENT', 'the status stays publicly visible');
    assert.equal(problem?.contentFreshness, undefined, 'the per-country detail does not');
    assert.doesNotMatch(JSON.stringify(compact), /"CN"/);

    // Operators still get the whole entry from the authenticated shape.
    const full = healthResponseBody({
      status: 'WARNING',
      summary: { ok: 1, warning: 1 },
      checkedAt: '2026-08-02T14:42:58.000Z',
      checks: { portwatchPortActivity: entry },
    }, false);
    assert.deepEqual(
      full.checks.portwatchPortActivity.contentFreshness,
      entry.contentFreshness,
    );
  });

  // api/_json-response.js strips reserved key names fleet-wide, so an entry
  // that classifies correctly in memory can still reach operators gutted.
  it('survives the shared response serializer intact', async () => {
    const entry = classifyPortwatch(completeRun(contentFreshnessOf({
      freshCount: 173,
      staleCount: 1,
      staleCountries: ['CN'],
      criticalFreshCount: 1,
      criticalStaleCountries: ['CN'],
    })));
    const body = await jsonResponse({ checks: { portwatchPortActivity: entry } }, 200).json();
    assert.deepEqual(
      body.checks.portwatchPortActivity.contentFreshness,
      entry.contentFreshness,
    );
  });
});
