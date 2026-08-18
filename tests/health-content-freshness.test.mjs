// #6060 — health must not report a 174/174 PortWatch run with stale China
// content as an undifferentiated healthy state.
//
// The existing STALE_CONTENT branch keys off `newestItemAt`, which answers
// "did the source publish anything recently". That question is useless for a
// per-country corpus: one 170-hour-old decision-critical fixture hides behind
// 173 fresh ones. This adds the per-entity half — the producer publishes a
// `contentFreshness` block and health fails closed when it is absent.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { __testing__ } from '../api/health.js';
import { jsonResponse } from '../api/_json-response.js';
import { buildContentFreshnessAssessment } from '../api/_content-freshness.js';

const {
  readSeedMeta,
  classifyKey,
  healthResponseBody,
  STATUS_COUNTS,
  SEED_META,
  ACTIVATION_MARKERS,
  CONTENT_FRESHNESS_ROLLOUT_UNTIL_MS,
} = __testing__;

const NOW = Date.parse('2026-08-03T14:42:58.000Z');
const MINUTE_MS = 60_000;
const PORTWATCH_CONTENT_BUDGET_MINUTES = 10 * 24 * 60;
const PORTWATCH_META_KEY = 'seed-meta:supply_chain:portwatch-ports';
const PORTWATCH_DATA_KEY = 'supply_chain:portwatch-ports:v1:_countries';
const PORTWATCH_ACTIVATION_KEY = ACTIVATION_MARKERS.portwatchContentFreshness;
const CONTENT_FRESHNESS_ROLLOUT_UNTIL = CONTENT_FRESHNESS_ROLLOUT_UNTIL_MS[PORTWATCH_ACTIVATION_KEY];

function contentFreshnessOf(overrides = {}) {
  return {
    budgetMinutes: PORTWATCH_CONTENT_BUDGET_MINUTES,
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

function portwatchCtx(meta, now = NOW) {
  return {
    keyStrens: new Map([[PORTWATCH_DATA_KEY, 4096]]),
    keyErrors: new Map(),
    keyMetaValues: new Map([[PORTWATCH_META_KEY, JSON.stringify(meta)]]),
    keyMetaErrors: new Map(),
    now,
  };
}

// Default context is post-activation: the producer has published the block at
// least once, so a later absence is a real regression rather than a deploy lag.
// `activated` is three-valued (#6095): true = marker read and present, false =
// marker read and absent (the only state that earns grace), null = the marker
// read failed, so its state is unknown and it is missing from the map entirely.
function classifyPortwatch(meta, { activated = true, now = NOW } = {}) {
  return classifyKey(
    'portwatchPortActivity',
    PORTWATCH_DATA_KEY,
    {},
    {
      ...portwatchCtx(meta, now),
      activationStates: activated === null
        ? new Map()
        : new Map([['portwatchContentFreshness', activated]]),
    },
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
  const seedCfg = {
    key: PORTWATCH_META_KEY,
    maxStaleMin: 2160,
    requireContentFreshness: { countries: ['CN', 'HK'], budgetMinutes: PORTWATCH_CONTENT_BUDGET_MINUTES },
  };

  it('surfaces a bounded content-freshness block', () => {
    const ctx = portwatchCtx(completeRun(contentFreshnessOf({
      freshCount: 173,
      staleCount: 1,
      staleCountries: ['CN'],
      criticalFreshCount: 1,
      criticalStaleCountries: ['CN'],
      criticalOldestObservedAt: Date.parse('2026-07-26T12:02:43.475Z'),
      criticalOldestObservedCountry: 'CN',
      criticalOldestAgeMinutes: 10_240,
    })));
    const meta = readSeedMeta(seedCfg, ctx.keyMetaValues, ctx.keyMetaErrors, ctx.now);

    assert.ok(meta.contentFreshness, 'block present');
    assert.equal(meta.contentFreshness.contentStale, true);
    assert.equal(meta.contentFreshness.staleCount, 1);
    assert.deepEqual(meta.contentFreshness.criticalStaleCountries, ['CN']);
    assert.equal(
      meta.contentFreshness.criticalOldestAgeMinutes,
      Math.round((NOW - Date.parse('2026-07-26T12:02:43.475Z')) / MINUTE_MS),
    );
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
  it('is registered to require content freshness over a health-pinned scope and budget', () => {
    assert.deepEqual(
      SEED_META.portwatchPortActivity.requireContentFreshness,
      { countries: ['CN', 'HK'], budgetMinutes: PORTWATCH_CONTENT_BUDGET_MINUTES },
      'health pins both the alarm scope and its threshold, not just the scope',
    );
    assert.equal(SEED_META.portwatchPortActivity.minRecordCount, 174);
  });

  // The producer's counts are a measurement taken at seeder-run time, and
  // seed-meta is rewritten only on a canonical-advancing 12h run. Trusting the
  // count alone lets OK persist while the observation ages past budget — the
  // exact green-while-dead failure this alarm exists to prevent.
  it('re-ages the producer measurement instead of trusting a frozen count', () => {
    // Seeder measured CN just inside the budget. Health reads that same meta
    // after the observation crosses the pinned boundary.
    //
    // Derived from PORTWATCH_CONTENT_BUDGET_MINUTES, never hardcoded hours: the
    // fixture means "one hour PAST the boundary", and a literal 145h silently
    // became "well inside it" the moment the budget moved 144h -> 240h.
    const observedAt = NOW - (PORTWATCH_CONTENT_BUDGET_MINUTES + 60) * MINUTE_MS;
    const entry = classifyPortwatch({
      fetchedAt: NOW - 12 * 60 * MINUTE_MS,
      recordCount: 174,
      contentFreshness: contentFreshnessOf({
        criticalFreshCount: 2,
        criticalStaleCountries: [],
        criticalOldestObservedAt: observedAt,
        criticalOldestObservedCountry: 'CN',
        // The producer's own frozen number, one hour INSIDE the boundary.
        criticalOldestAgeMinutes: PORTWATCH_CONTENT_BUDGET_MINUTES - 60,
      }),
    });

    assert.equal(
      entry.status,
      'STALE_CONTENT',
      'a stale-but-fresh-at-measurement-time observation must still alarm',
    );
    assert.equal(
      entry.contentFreshness.criticalOldestAgeMinutes,
      PORTWATCH_CONTENT_BUDGET_MINUTES + 60,
      'the published age is recomputed against now, not echoed from the producer',
    );
  });

  it('keeps OK while the re-aged observation is still inside the pinned budget', () => {
    const entry = classifyPortwatch({
      fetchedAt: NOW - 12 * 60 * MINUTE_MS,
      recordCount: 174,
      contentFreshness: contentFreshnessOf({
        criticalOldestObservedAt: NOW - (PORTWATCH_CONTENT_BUDGET_MINUTES - 60) * MINUTE_MS,
        criticalOldestAgeMinutes: 142 * 60,
      }),
    });
    assert.equal(entry.status, 'OK');
    assert.equal(entry.contentFreshness.criticalOldestAgeMinutes, PORTWATCH_CONTENT_BUDGET_MINUTES - 60);
  });

  it('uses the raw millisecond boundary when re-aging content', () => {
    const budgetMs = PORTWATCH_CONTENT_BUDGET_MINUTES * MINUTE_MS;
    for (const extraMs of [0, 1]) {
      const entry = classifyPortwatch(completeRun(contentFreshnessOf({
        criticalOldestObservedAt: NOW - budgetMs - extraMs,
        criticalOldestAgeMinutes: PORTWATCH_CONTENT_BUDGET_MINUTES,
      })));
      assert.equal(
        entry.status,
        'STALE_CONTENT',
        `an observation ${extraMs}ms beyond the boundary must be stale`,
      );
    }
  });

  it('ignores a producer-supplied budget in favour of the one health pins', () => {
    // A producer that widens its own budget to 30 days must not be able to
    // certify a 180h-old observation as fresh.
    const entry = classifyPortwatch(completeRun(contentFreshnessOf({
      budgetMinutes: 30 * 24 * 60,
      criticalOldestObservedAt: NOW - (PORTWATCH_CONTENT_BUDGET_MINUTES + 36 * 60) * MINUTE_MS,
      criticalOldestAgeMinutes: 180 * 60,
    })));
    assert.equal(entry.status, 'STALE_CONTENT');
    assert.equal(entry.contentFreshness.budgetMinutes, PORTWATCH_CONTENT_BUDGET_MINUTES, 'the pinned budget is published');
  });

  it('fails closed when an all-fresh claim carries no re-ageable timestamp', () => {
    const entry = classifyPortwatch(completeRun(contentFreshnessOf({
      criticalOldestObservedAt: null,
    })));
    assert.equal(entry.status, 'COVERAGE_DEGRADED');
    assert.deepEqual(
      entry.contentFreshness.unusableReasons,
      ['critical_observation_time_unusable'],
    );
  });

  // Without this, the producer defines both the numerator and the denominator
  // of its own alarm: shrink PORTWATCH_DECISION_CRITICAL_COUNTRIES to ['HK']
  // and health reports OK with CN 170h stale — precisely the #6060 failure.
  it('fails closed when the producer narrows the declared critical set', () => {
    const entry = classifyPortwatch(completeRun(contentFreshnessOf({
      criticalCountries: ['HK'],
      criticalFreshCount: 1,
      criticalStaleCountries: [],
    })));
    assert.equal(
      entry.status,
      'COVERAGE_DEGRADED',
      'a producer cannot silently drop a country out of the alarm scope',
    );
    assert.equal(entry.contentFreshness.usable, false);
  });

  it('fails closed when the producer declares a critical set health does not expect', () => {
    for (const declared of [[], ['CN'], ['HK', 'SG'], ['cn', 'hk']]) {
      const entry = classifyPortwatch(completeRun(contentFreshnessOf({
        criticalCountries: declared,
        criticalFreshCount: declared.length,
      })));
      assert.equal(
        entry.status,
        'COVERAGE_DEGRADED',
        `declared set ${JSON.stringify(declared)} does not cover the pinned scope`,
      );
    }
  });

  // `usable` is six ANDed conditions. Without a named reason a consumer has to
  // reimplement that boolean from the raw counts to guess which one tripped —
  // and `declared_scope_narrowed` is not reconstructable from the response at
  // all, since the expected scope lives in health config, not seed metadata.
  it('names which condition made the block unusable', () => {
    const reasonsFor = (overrides) => classifyPortwatch(completeRun(
      contentFreshnessOf(overrides),
    )).contentFreshness.unusableReasons;

    assert.deepEqual(reasonsFor({}), [], 'a usable block names no failure');
    assert.deepEqual(reasonsFor({ criticalCountries: ['HK'], criticalFreshCount: 1 }), [
      'declared_scope_narrowed',
    ]);
    assert.deepEqual(reasonsFor({ coveredCount: null }), ['covered_count_unusable']);
    assert.deepEqual(reasonsFor({ freshCount: 'many' }), ['fresh_count_unusable']);
    assert.deepEqual(reasonsFor({ coveredCount: 174, freshCount: 175 }), [
      'fresh_exceeds_covered',
    ]);
    assert.deepEqual(reasonsFor({ criticalFreshCount: null }), [
      'critical_fresh_count_unusable',
    ]);
    assert.deepEqual(reasonsFor({ criticalFreshCount: 3 }), [
      'critical_fresh_exceeds_declared',
    ]);
    assert.deepEqual(reasonsFor({ staleCount: 'unknown' }), [
      'stale_count_unusable',
    ]);
    assert.deepEqual(reasonsFor({ unknownCount: 'unknown' }), [
      'unknown_count_unusable',
    ]);
    assert.deepEqual(reasonsFor({
      coveredCount: 1,
      freshCount: 1,
      staleCount: 0,
      unknownCount: 0,
      criticalFreshCount: 2,
    }), [
      'critical_fresh_exceeds_covered',
    ]);
    // Independent conditions accumulate rather than short-circuiting to one.
    // criticalFreshCount is dropped to 0 so the empty declared set does not
    // also trip `critical_fresh_exceeds_declared` and muddy the assertion.
    assert.deepEqual(
      reasonsFor({ coveredCount: null, criticalCountries: [], criticalFreshCount: 0 }),
      ['covered_count_unusable', 'declared_scope_narrowed'],
    );
  });

  it('fails closed when the consumer budget is unusable', () => {
    const assessment = buildContentFreshnessAssessment(
      { contentFreshness: contentFreshnessOf() },
      { countries: ['CN', 'HK'], budgetMinutes: 0 },
      NOW,
    );

    assert.equal(assessment.usable, false);
    assert.deepEqual(assessment.unusableReasons, ['expected_budget_unusable']);
  });

  it('publishes the fields that separate absent-from-run from present-but-stale', () => {
    const entry = classifyPortwatch(completeRun(contentFreshnessOf({
      criticalFreshCount: 1,
      criticalStaleCountries: ['CN'],
      criticalMissingCountries: 1,
      criticalOldestObservedAt: Date.parse('2026-07-26T12:02:43.475Z'),
    })));
    assert.equal(entry.contentFreshness.criticalMissingCountries, 1);
    assert.equal(
      entry.contentFreshness.criticalOldestObservedAt,
      Date.parse('2026-07-26T12:02:43.475Z'),
    );
  });

  it('publishes the scope health pinned, not only the scope the producer declared', () => {
    const entry = classifyPortwatch(completeRun(contentFreshnessOf({
      criticalCountries: ['CN', 'HK', 'TW'],
      criticalFreshCount: 3,
    })));
    assert.deepEqual(entry.contentFreshness.expectedCriticalCountries, ['CN', 'HK']);
    assert.deepEqual(entry.contentFreshness.criticalCountries, ['CN', 'HK', 'TW']);
  });

  it('accepts a producer set that covers the pinned scope with extras', () => {
    const entry = classifyPortwatch(completeRun(contentFreshnessOf({
      criticalCountries: ['CN', 'HK', 'TW'],
      criticalFreshCount: 3,
    })));
    assert.equal(entry.status, 'OK', 'widening the producer scope is not a failure');
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
      criticalOldestObservedAt: Date.parse('2026-07-26T12:02:43.475Z'),
      criticalOldestObservedCountry: 'CN',
      criticalOldestAgeMinutes: 10_240,
    })));

    assert.equal(entry.status, 'STALE_CONTENT');
    assert.equal(entry.records, 174, 'cardinality stays truthful — this is not a coverage gap');
    assert.deepEqual(entry.contentFreshness.criticalStaleCountries, ['CN']);
    assert.equal(
      entry.contentFreshness.criticalOldestObservedCountry,
      'CN',
      'operators get the stale source family, not a generic warning',
    );
    assert.equal(
      entry.contentFreshness.criticalOldestAgeMinutes,
      Math.round((NOW - Date.parse('2026-07-26T12:02:43.475Z')) / MINUTE_MS),
    );
  });

  it('alarms when a decision-critical country drops out of the run entirely', () => {
    const entry = classifyPortwatch(completeRun(contentFreshnessOf({
      criticalFreshCount: 1,
      criticalStaleCountries: ['CN'],
      criticalMissingCountries: 1,
    })));
    assert.equal(entry.status, 'STALE_CONTENT');
  });

  // api/health.js is a Vercel edge function that redeploys in minutes; the
  // producer is a Railway cron on a 12h cadence. Failing closed unconditionally
  // would light a warning on a key that is genuinely fine for up to a full
  // cron interval after every deploy — alarm noise that erodes the alarm.
  it('does not fail closed before the producer has ever published the block', () => {
    const entry = classifyPortwatch(completeRun(undefined), { activated: false });
    assert.equal(entry.status, 'OK', 'a deployment that predates the feature is not a fault');
    assert.equal(entry.contentFreshness, undefined);
  });

  it('fails closed once the producer has published the block at least once', () => {
    const entry = classifyPortwatch(completeRun(undefined), { activated: true });
    assert.equal(
      entry.status,
      'COVERAGE_DEGRADED',
      'losing a block the producer proved it can write is a regression',
    );
  });

  // #6095/#6111 — the grace is earned by evidence, then bounded by the
  // deployment window. A marker health could not read says nothing about
  // whether the producer ever published; an evicted or renamed marker can only
  // earn clean-absent grace until the compiled deadline.
  it('refuses grace when the marker state is unknown rather than read-absent', () => {
    const entry = classifyPortwatch(completeRun(undefined), { activated: null });
    assert.equal(
      entry.status,
      'COVERAGE_DEGRADED',
      'an unread marker must fail closed, not re-enter an expired grace',
    );
  });

  it('bounds clean-absent grace and publishes its deadline', () => {
    const pending = classifyPortwatch(completeRun(undefined), {
      activated: false,
      now: NOW,
    });
    assert.equal(pending.status, 'OK');
    assert.equal(
      pending.contentFreshnessPendingUntil,
      new Date(CONTENT_FRESHNESS_ROLLOUT_UNTIL).toISOString(),
    );

    const expired = classifyPortwatch(completeRun(undefined), {
      activated: false,
      now: CONTENT_FRESHNESS_ROLLOUT_UNTIL,
    });
    assert.equal(expired.status, 'COVERAGE_DEGRADED');
    assert.ok(expired.contentFreshness, 'the expired block is evaluated and published for diagnosis');
  });

  it('still evaluates a block that is present before activation is observed', () => {
    const stale = classifyPortwatch(completeRun(contentFreshnessOf({
      criticalFreshCount: 1,
      criticalStaleCountries: ['CN'],
    })), { activated: false });
    assert.equal(
      stale.status,
      'STALE_CONTENT',
      'the grace covers only absence, never a block that is present and stale',
    );

    // The grace must not extend to a block the producer DID write but wrote
    // incoherently — that is a live regression, not a deployment-order state,
    // and softening it would let a broken producer hide behind the marker.
    const broken = classifyPortwatch(completeRun(contentFreshnessOf({
      criticalCountries: ['HK'],
      criticalFreshCount: 1,
    })), { activated: false });
    assert.equal(broken.status, 'COVERAGE_DEGRADED');
    assert.deepEqual(broken.contentFreshness.unusableReasons, ['declared_scope_narrowed']);
  });

  it('does not grant activation grace to scalar or array blocks', () => {
    for (const malformed of [42, [], 'not-an-object', null]) {
      const entry = classifyPortwatch(completeRun(malformed), { activated: false });
      assert.equal(
        entry.status,
        'COVERAGE_DEGRADED',
        `present malformed contentFreshness=${JSON.stringify(malformed)} must fail closed before activation`,
      );
    }
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
      { coveredCount: 174, freshCount: 173, staleCount: 0, unknownCount: 0 },
      { coveredCount: 174, freshCount: 173, staleCount: -1, unknownCount: 2 },
      { coveredCount: 0, freshCount: 0, staleCount: 0, unknownCount: 0, criticalFreshCount: 2 },
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
