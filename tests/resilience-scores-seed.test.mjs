import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createIntervalDiagnostics,
} from '../scripts/_resilience-intervals.mjs';
import { listRankableCountries } from '../scripts/shared/rankable-universe.mjs';
import {
  RESILIENCE_RANKING_CACHE_KEY,
  RESILIENCE_RANKING_CACHE_TTL_SECONDS,
  RESILIENCE_INTERVAL_MIN_RECORD_COUNT,
  RESILIENCE_INTERVAL_PROBE_COUNTRY_CODE,
  RESILIENCE_SCORE_SECTION_META_TTL_SECONDS,
  RESILIENCE_SCORE_CACHE_PREFIX,
  RESILIENCE_STATIC_INDEX_KEY,
  buildIntervalPayloadFromCachedScore,
  buildSeedResultLogExtra,
  computeAndWriteIntervals,
  computeIntervals,
  getIntervalWriteFailure,
  fetchRuntimeCacheState,
  parseCachedScorePayload,
  seedResilienceScores,
  warmLaggardCountries,
  LAGGARD_WARMUP_BUDGET_MS,
} from '../scripts/seed-resilience-scores.mjs';

const D6_DOMAINS = [
  { id: 'economic', score: 70, weight: 0.17 },
  { id: 'infrastructure', score: 72, weight: 0.15 },
  { id: 'energy', score: 68, weight: 0.11 },
  { id: 'social-governance', score: 74, weight: 0.19 },
  { id: 'health-food', score: 69, weight: 0.13 },
  { id: 'recovery', score: 71, weight: 0.25 },
];

function acceptedIntervalCountryCodes() {
  const withoutProbe = listRankableCountries().filter(
    (countryCode) => countryCode !== RESILIENCE_INTERVAL_PROBE_COUNTRY_CODE,
  );
  return [
    ...withoutProbe.slice(0, RESILIENCE_INTERVAL_MIN_RECORD_COUNT - 1),
    RESILIENCE_INTERVAL_PROBE_COUNTRY_CODE,
  ];
}

// Three pillars so a pc-tagged payload produces a real pillar-jitter interval.
const PC_PILLARS = [
  { id: 'structural-readiness', score: 72, weight: 0.40 },
  { id: 'live-shock-exposure', score: 70, weight: 0.35 },
  { id: 'recovery-capacity', score: 68, weight: 0.25 },
];

function withD6CacheFormula(fn) {
  const originalCombine = process.env.RESILIENCE_PILLAR_COMBINE_ENABLED;
  const originalSchema = process.env.RESILIENCE_SCHEMA_V2_ENABLED;
  process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'false';
  process.env.RESILIENCE_SCHEMA_V2_ENABLED = 'true';
  try {
    return fn();
  } finally {
    if (originalCombine == null) delete process.env.RESILIENCE_PILLAR_COMBINE_ENABLED;
    else process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = originalCombine;
    if (originalSchema == null) delete process.env.RESILIENCE_SCHEMA_V2_ENABLED;
    else process.env.RESILIENCE_SCHEMA_V2_ENABLED = originalSchema;
  }
}

describe('exported constants', () => {
  it('RESILIENCE_RANKING_CACHE_KEY matches the canonical resilience:ranking shape', () => {
    // Plan 002 §U8 review: don't pin the exact version literal —
    // that creates a parallel source of truth that drifts on every
    // cache-prefix bump. Assert structural shape only.
    assert.match(RESILIENCE_RANKING_CACHE_KEY, /^resilience:ranking:v\d+$/);
  });

  it('RESILIENCE_SCORE_CACHE_PREFIX matches the canonical resilience:score: shape', () => {
    assert.match(RESILIENCE_SCORE_CACHE_PREFIX, /^resilience:score:v\d+:$/);
  });

  it('RESILIENCE_RANKING_CACHE_TTL_SECONDS is 12 hours (2x cron interval)', () => {
    // TTL must exceed cron interval (6h) so a missed/slow cron doesn't create
    // an EMPTY_ON_DEMAND gap. Seeder and handler must agree on the TTL.
    assert.equal(RESILIENCE_RANKING_CACHE_TTL_SECONDS, 12 * 60 * 60);
  });

  it('RESILIENCE_SCORE_SECTION_META_TTL_SECONDS is 12 hours (6x score cron interval)', () => {
    assert.equal(RESILIENCE_SCORE_SECTION_META_TTL_SECONDS, 12 * 60 * 60);
  });

  it('RESILIENCE_STATIC_INDEX_KEY matches expected key', () => {
    assert.equal(RESILIENCE_STATIC_INDEX_KEY, 'resilience:static:index:v1');
  });
});

describe('seed script does not export tsx/esm helpers', () => {
  it('ensureResilienceScoreCached is not exported', async () => {
    const mod = await import('../scripts/seed-resilience-scores.mjs');
    assert.equal(typeof mod.ensureResilienceScoreCached, 'undefined');
  });

  it('createMemoizedSeedReader is not exported', async () => {
    const mod = await import('../scripts/seed-resilience-scores.mjs');
    assert.equal(typeof mod.createMemoizedSeedReader, 'undefined');
  });

  it('buildRankingItem is not exported (ranking write removed)', async () => {
    const mod = await import('../scripts/seed-resilience-scores.mjs');
    assert.equal(typeof mod.buildRankingItem, 'undefined');
  });

  it('sortRankingItems is not exported (ranking write removed)', async () => {
    const mod = await import('../scripts/seed-resilience-scores.mjs');
    assert.equal(typeof mod.sortRankingItems, 'undefined');
  });

  it('buildRankingPayload is not exported (ranking write removed)', async () => {
    const mod = await import('../scripts/seed-resilience-scores.mjs');
    assert.equal(typeof mod.buildRankingPayload, 'undefined');
  });
});

describe('score cache payload validation', () => {
  it('accepts any valid formula tag independent of seeder env unless a live runtime formula is supplied', () => {
    // The seeder no longer re-derives a "current" formula from its own env.
    // Force the env to the d6 resolution to prove a 'pc' payload is still
    // accepted (the 2026-06-02 durable fix) — production owns the formula it
    // served. Once the live runtime manifest supplies a formula, stale cached
    // payloads from a prior formula must no longer count as warmed.
    const originalCombine = process.env.RESILIENCE_PILLAR_COMBINE_ENABLED;
    const originalSchema = process.env.RESILIENCE_SCHEMA_V2_ENABLED;
    process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'false';
    process.env.RESILIENCE_SCHEMA_V2_ENABLED = 'true';
    try {
      const valid = {
        countryCode: 'NO',
        overallScore: 82,
        level: 'high',
        _formula: 'd6',
        _educationState: 'education-on',
      };
      const activeState = { expectedEducationState: 'education-on' };

      assert.deepEqual(parseCachedScorePayload(JSON.stringify(valid), activeState), valid);
      assert.deepEqual(
        parseCachedScorePayload(JSON.stringify({
          _seed: { fetchedAt: Date.now(), recordCount: 1, sourceVersion: 'test', schemaVersion: 1, state: 'OK' },
          data: valid,
        }), activeState),
        valid,
        'contract envelopes should count when their inner score payload is valid',
      );
      // A 'pc' payload is valid even though the env resolves to 'd6'.
      assert.deepEqual(
        parseCachedScorePayload(JSON.stringify({ ...valid, _formula: 'pc' }), activeState),
        { ...valid, _formula: 'pc' },
        'pc payloads must be accepted regardless of the seeder env formula',
      );
      assert.deepEqual(
        parseCachedScorePayload(JSON.stringify({ ...valid, _formula: 'pc' }), { ...activeState, expectedFormula: 'pc' }),
        { ...valid, _formula: 'pc' },
        'pc payloads must count when they match the live runtime formula',
      );
      assert.equal(
        parseCachedScorePayload(JSON.stringify({ ...valid, _formula: 'pc' }), { ...activeState, expectedFormula: 'd6' }),
        null,
        'pc payloads must be treated as stale when the live runtime formula is d6',
      );
      assert.equal(parseCachedScorePayload(JSON.stringify('__WM_NEG__'), activeState), null);
      assert.equal(parseCachedScorePayload(JSON.stringify({ ...valid, overallScore: 0 }), activeState), null);
      assert.equal(
        parseCachedScorePayload(JSON.stringify({ ...valid, _educationState: 'education-off' }), activeState),
        null,
        'scores from the opposite education construct state must be stale',
      );
      // Untagged / invalid-formula payloads are still rejected.
      assert.equal(parseCachedScorePayload(JSON.stringify({ countryCode: 'NO', overallScore: 82 }), activeState), null);
      assert.equal(parseCachedScorePayload(JSON.stringify({ ...valid, _formula: 'xx' }), activeState), null);
      assert.equal(parseCachedScorePayload('not-json', activeState), null);
    } finally {
      if (originalCombine == null) delete process.env.RESILIENCE_PILLAR_COMBINE_ENABLED;
      else process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = originalCombine;
      if (originalSchema == null) delete process.env.RESILIENCE_SCHEMA_V2_ENABLED;
      else process.env.RESILIENCE_SCHEMA_V2_ENABLED = originalSchema;
    }
  });
});

describe('runtime education cache-state gate', () => {
  it('maps both manifest flag states onto cache-state tags', async () => {
    const responseFor = (enabled) => async () => new Response(JSON.stringify({
      formulaTag: 'pc',
      constructVersions: { education: enabled ? 'active' : 'rollback' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

    assert.deepEqual(await fetchRuntimeCacheState(responseFor(true)), {
      expectedFormula: 'pc',
      expectedEducationState: 'education-on',
    });
    assert.deepEqual(await fetchRuntimeCacheState(responseFor(false)), {
      expectedFormula: 'pc',
      expectedEducationState: 'education-off',
    });
  });

  it('returns an unproven state for a missing flag, unknown formula, HTTP failure, or malformed JSON', async () => {
    assert.deepEqual(
      await fetchRuntimeCacheState(async () => new Response(JSON.stringify({ formulaTag: 'pc', constructVersions: {} }), { status: 200 })),
      { expectedFormula: 'pc', expectedEducationState: null },
    );
    assert.deepEqual(
      await fetchRuntimeCacheState(async () => new Response(JSON.stringify({ formulaTag: 'unknown', constructVersions: { education: 'active' } }), { status: 200 })),
      { expectedFormula: null, expectedEducationState: 'education-on' },
    );
    assert.deepEqual(
      await fetchRuntimeCacheState(async () => new Response('unavailable', { status: 503 })),
      { expectedFormula: null, expectedEducationState: null },
    );
    assert.deepEqual(
      await fetchRuntimeCacheState(async () => new Response('{', { status: 200 })),
      { expectedFormula: null, expectedEducationState: null },
    );
  });

  it('aborts before score-cache reads and warmup when either manifest state is unproven', async () => {
    const originalFetch = globalThis.fetch;
    const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
    const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    const requests = [];
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    globalThis.fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      assert.match(url, /\/get\/resilience%3Astatic%3Aindex%3Av1$/);
      return new Response(JSON.stringify({ result: JSON.stringify({ countries: ['US'] }) }), { status: 200 });
    };

    try {
      for (const runtimeState of [
        { expectedFormula: 'pc', expectedEducationState: null },
        { expectedFormula: null, expectedEducationState: 'education-on' },
      ]) {
        requests.length = 0;
        await assert.rejects(
          () => seedResilienceScores({
            runtimeCacheState: async () => runtimeState,
          }),
          /aborting before score-cache reads, warmup, and interval writes/,
        );
        assert.equal(requests.length, 1, 'only the static-index read may occur before the manifest gate');
      }
    } finally {
      globalThis.fetch = originalFetch;
      if (originalUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      if (originalToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
    }
  });
});

describe('interval seed health classification', () => {
  it('does not fail interval health for an intentionally empty static index skip', () => {
    assert.equal(getIntervalWriteFailure({ skipped: true, reason: 'no_index' }), null);
  });

  it('fails when current score cache stays missing or stale after warmup', () => {
    const failure = getIntervalWriteFailure({
      skipped: false,
      total: 196,
      recordCount: 0,
      intervalsWritten: 0,
      intervalMissingScorePayloadCount: 196,
    });

    assert.equal(failure?.reason, 'missing_score_cache');
    assert.match(failure?.message ?? '', /wrote 0 interval keys for 196 rankable countries/);
    assert.match(failure?.message ?? '', /cachedScores=0/);
  });

  it('fails with a stale-cache reason when score payloads have an old formula tag', () => {
    const failure = getIntervalWriteFailure({
      skipped: false,
      total: 196,
      recordCount: 0,
      intervalsWritten: 0,
      intervalStaleScorePayloadCount: 196,
    });

    assert.equal(failure?.reason, 'stale_score_cache');
    assert.match(failure?.message ?? '', /staleScorePayloads=196/);
  });

  it('fails with malformed-cache reason when cached score payload JSON cannot be parsed', () => {
    const failure = getIntervalWriteFailure({
      skipped: false,
      total: 196,
      recordCount: 0,
      intervalsWritten: 0,
      intervalMalformedScorePayloadCount: 196,
    });

    assert.equal(failure?.reason, 'malformed_score_cache');
    assert.match(failure?.message ?? '', /malformedScorePayloads=196/);
  });

  it('fails with invalid-cache reason when cached score payload shape is unusable', () => {
    const failure = getIntervalWriteFailure({
      skipped: false,
      total: 196,
      recordCount: 0,
      intervalsWritten: 0,
      intervalInvalidScorePayloadCount: 196,
    });

    assert.equal(failure?.reason, 'invalid_score_cache');
    assert.match(failure?.message ?? '', /invalidScorePayloads=196/);
  });

  it('fails with a formula-specific reason when cached score payloads are unusable for intervals', () => {
    const failure = getIntervalWriteFailure({
      skipped: false,
      total: 196,
      recordCount: 196,
      intervalsWritten: 0,
      intervalFormulaSkipCount: 196,
    });

    assert.equal(failure?.reason, 'unusable_score_formula');
  });

  it('passes when the interval publication meets the coverage floor', () => {
    assert.equal(getIntervalWriteFailure({
      skipped: false,
      total: 196,
      recordCount: 196,
      intervalsWritten: 196,
    }), null);
  });

  it('fails when an interval publication is non-empty but below the coverage floor', () => {
    const failure = getIntervalWriteFailure({
      skipped: false,
      total: 196,
      recordCount: 196,
      intervalsWritten: RESILIENCE_INTERVAL_MIN_RECORD_COUNT - 1,
    });

    assert.equal(failure?.reason, 'insufficient_interval_coverage');
    assert.match(failure?.message ?? '', /179\/196/);
  });
});

describe('cached score interval payload classification', () => {
  it('publishes interval keys and freshness metadata in one proxy-supported transaction', async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    const countryCodes = acceptedIntervalCountryCodes();
    const pipelineResults = countryCodes.map((countryCode) => ({
      result: JSON.stringify({
        countryCode,
        _formula: 'd6',
        _educationState: 'education-on',
        overallScore: 70,
        domains: D6_DOMAINS,
      }),
    }));
    globalThis.fetch = async (input, init) => {
      requests.push({ input: String(input), body: JSON.parse(init.body) });
      return new Response(JSON.stringify([{ error: 'simulated interval write failure' }]), { status: 200 });
    };

    try {
      await assert.rejects(
        () => computeAndWriteIntervals(
          'https://redis.example.test',
          'token',
          countryCodes,
          pipelineResults,
          { expectedFormula: 'd6', expectedEducationState: 'education-on' },
        ),
        /atomic publish failed persistence proof/,
      );
      assert.equal(requests.length, 1, 'the interval generation must use one Redis request');
      assert.match(requests[0].input, /\/multi-exec$/);
      const commands = requests[0].body;
      assert.equal(commands.length, listRankableCountries().length + 1);
      assert.ok(commands.every((command) => command[0] !== 'EVAL'));
      assert.deepEqual(commands[0].slice(0, 2), ['SET', `resilience:intervals:v11:${listRankableCountries()[0]}`]);
      assert.deepEqual(commands.at(-1).slice(0, 2), ['SET', 'seed-meta:resilience:intervals']);
      const intervalPayload = JSON.parse(commands[0][2]);
      const metadataPayload = JSON.parse(commands.at(-1)[2]);
      assert.equal(intervalPayload._formula, 'd6');
      assert.equal(intervalPayload._educationState, 'education-on');
      assert.equal(metadataPayload._formula, intervalPayload._formula);
      assert.equal(metadataPayload._educationState, intervalPayload._educationState);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('refuses a one-country opposite-state generation before Redis publication', async () => {
    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    globalThis.fetch = async () => {
      requestCount++;
      throw new Error('Redis must not be called below the interval coverage floor');
    };
    const countryCodes = listRankableCountries();
    const pipelineResults = countryCodes.map((countryCode, index) => ({
      result: index === 0
        ? JSON.stringify({
          countryCode,
          _formula: 'd6',
          _educationState: 'education-on',
          overallScore: 70,
          domains: D6_DOMAINS,
        })
        : null,
    }));

    try {
      await assert.rejects(
        () => computeAndWriteIntervals(
          'https://redis.example.test',
          'token',
          countryCodes,
          pipelineResults,
          { expectedFormula: 'd6', expectedEducationState: 'education-on' },
        ),
        /below the 180-country publication floor; the previous generation was preserved/,
      );
      assert.equal(requestCount, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('refuses an otherwise sufficient generation that omits the fixed health probe', async () => {
    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    globalThis.fetch = async () => {
      requestCount++;
      throw new Error('Redis must not be called without the health probe');
    };
    const countryCodes = listRankableCountries()
      .filter((countryCode) => countryCode !== RESILIENCE_INTERVAL_PROBE_COUNTRY_CODE)
      .slice(0, RESILIENCE_INTERVAL_MIN_RECORD_COUNT);
    const pipelineResults = countryCodes.map((countryCode) => ({
      result: JSON.stringify({
        countryCode,
        _formula: 'd6',
        _educationState: 'education-on',
        overallScore: 70,
        domains: D6_DOMAINS,
      }),
    }));

    try {
      await assert.rejects(
        () => computeAndWriteIntervals(
          'https://redis.example.test',
          'token',
          countryCodes,
          pipelineResults,
          { expectedFormula: 'd6', expectedEducationState: 'education-on' },
        ),
        /missing the required US health probe; the previous generation was preserved/,
      );
      assert.equal(requestCount, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('atomically deletes omitted old-state intervals from an accepted generation', async () => {
    const originalFetch = globalThis.fetch;
    const allCountryCodes = listRankableCountries();
    const publishedCodes = acceptedIntervalCountryCodes();
    const omittedCodes = allCountryCodes.filter((countryCode) => !publishedCodes.includes(countryCode));
    const redis = new Map([
      [`resilience:intervals:v11:${omittedCodes[0]}`, JSON.stringify({
        p05: 10,
        p95: 20,
        _formula: 'd6',
        _educationState: 'education-off',
        methodology: 'weight-perturbation-sensitivity-v3',
      })],
    ]);
    globalThis.fetch = async (input, init) => {
      assert.match(String(input), /\/multi-exec$/);
      const commands = JSON.parse(init.body);
      const results = commands.map(([verb, key, value]) => {
        if (verb === 'DEL') return { result: redis.delete(key) ? 1 : 0 };
        assert.equal(verb, 'SET');
        redis.set(key, value);
        return { result: 'OK' };
      });
      return new Response(JSON.stringify(results), { status: 200 });
    };
    const countryCodes = allCountryCodes;
    const pipelineResults = countryCodes.map((countryCode) => ({
      result: omittedCodes.includes(countryCode)
        ? null
        : JSON.stringify({
          countryCode,
          _formula: 'd6',
          _educationState: 'education-on',
          overallScore: 70,
          domains: D6_DOMAINS,
        }),
    }));

    try {
      const result = await computeAndWriteIntervals(
        'https://redis.example.test',
        'token',
        countryCodes,
        pipelineResults,
        { expectedFormula: 'd6', expectedEducationState: 'education-on' },
      );
      assert.equal(result.recordCount, RESILIENCE_INTERVAL_MIN_RECORD_COUNT);
      for (const countryCode of omittedCodes) {
        assert.equal(redis.has(`resilience:intervals:v11:${countryCode}`), false, 'omitted old-state interval must be deleted');
      }
      for (const countryCode of publishedCodes) {
        assert.equal(JSON.parse(redis.get(`resilience:intervals:v11:${countryCode}`))._educationState, 'education-on');
      }
      const meta = JSON.parse(redis.get('seed-meta:resilience:intervals'));
      assert.equal(meta.recordCount, RESILIENCE_INTERVAL_MIN_RECORD_COUNT);
      assert.equal(meta._educationState, 'education-on');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('records formula skips for score payloads missing formula tags', () => {
    withD6CacheFormula(() => {
      const diagnostics = createIntervalDiagnostics();
      const payload = buildIntervalPayloadFromCachedScore(JSON.stringify({
        countryCode: 'MS',
        overallScore: 70,
        _educationState: 'education-on',
        domains: D6_DOMAINS,
      }), 'MS', diagnostics, { expectedEducationState: 'education-on' });

      assert.equal(payload, null);
      assert.equal(diagnostics.formulaSkipCount, 1);
      assert.deepEqual(diagnostics.formulaSkipSamples[0], {
        countryCode: 'MS',
        formula: undefined,
        reason: 'missing_formula',
      });
      assert.equal(diagnostics.invalidScorePayloadCount, 0);
    });
  });

  it('writes pc intervals from pc-tagged payloads even when the seeder env resolves to d6', () => {
    // Regression for the 2026-06-02 production incident: `seed-bundle-resilience`
    // ran without RESILIENCE_PILLAR_COMBINE_ENABLED=true, so the seeder resolved
    // to 'd6' while every live score was tagged 'pc'. The old env-formula gate
    // rejected all 196 payloads as "stale", wrote zero intervals, failed the
    // seed section, and left `resilienceIntervals` EMPTY in production while the
    // ranking stayed fresh. The interval writer must trust the payload's own
    // `_formula` tag, not a formula re-derived from this process's env.
    withD6CacheFormula(() => {
      const diagnostics = createIntervalDiagnostics();
      const payload = buildIntervalPayloadFromCachedScore(JSON.stringify({
        countryCode: 'PC',
        _formula: 'pc',
        _educationState: 'education-on',
        overallScore: 75,
        domains: D6_DOMAINS,
        pillars: PC_PILLARS,
      }), 'PC', diagnostics, { expectedFormula: 'pc', expectedEducationState: 'education-on' });

      assert.ok(payload, 'pc payload must produce an interval even under a d6 seeder env');
      assert.equal(payload._formula, 'pc', 'interval formula must follow the payload tag, not the seeder env');
      assert.equal(diagnostics.staleScorePayloadCount, 0, 'pc-vs-d6 must no longer be treated as stale');
      assert.equal(diagnostics.formulaSkipCount, 0);
      assert.equal(diagnostics.intervalPayloadSkipCount, 0);
      assert.equal(diagnostics.missingScorePayloadCount, 0);
    });
  });

  it('records stale score payloads when cached formula differs from the live runtime formula', () => {
    withD6CacheFormula(() => {
      const diagnostics = createIntervalDiagnostics();
      const payload = buildIntervalPayloadFromCachedScore(JSON.stringify({
        countryCode: 'ST',
        _formula: 'pc',
        _educationState: 'education-on',
        overallScore: 75,
        domains: D6_DOMAINS,
        pillars: PC_PILLARS,
      }), 'ST', diagnostics, { expectedFormula: 'd6', expectedEducationState: 'education-on' });

      assert.equal(payload, null);
      assert.equal(diagnostics.staleScorePayloadCount, 1);
      assert.deepEqual(diagnostics.staleScorePayloadSamples[0], {
        countryCode: 'ST',
        formula: 'pc',
        expectedFormula: 'd6',
      });
      assert.equal(diagnostics.formulaSkipCount, 0);
      assert.equal(diagnostics.intervalPayloadSkipCount, 0);
    });
  });

  it('builds intervals for current tagged score payloads', () => {
    withD6CacheFormula(() => {
      const diagnostics = createIntervalDiagnostics();
      const payload = buildIntervalPayloadFromCachedScore(JSON.stringify({
        countryCode: 'OK',
        _formula: 'd6',
        _educationState: 'education-on',
        overallScore: 70,
        domains: D6_DOMAINS,
      }), 'OK', diagnostics, { expectedEducationState: 'education-on' });

      assert.ok(payload);
      assert.equal(payload._formula, 'd6');
      assert.equal(diagnostics.formulaSkipCount, 0);
      assert.equal(diagnostics.staleScorePayloadCount, 0);
      assert.equal(diagnostics.invalidScorePayloadCount, 0);
    });
  });
});

describe('seed result logging and exit classification', () => {
  it('marks zero interval writes as an error and non-zero exit decision', () => {
    const { extra, intervalFailure, exitCode } = buildSeedResultLogExtra({
      skipped: false,
      total: 196,
      recordCount: 0,
      intervalsWritten: 0,
      intervalMissingScorePayloadCount: 196,
    });

    assert.equal(exitCode, 1);
    assert.equal(intervalFailure?.reason, 'missing_score_cache');
    assert.equal(extra.status, 'ERROR');
    assert.equal(extra.intervalFailureReason, 'missing_score_cache');
    assert.match(extra.error, /wrote 0 interval keys/);
  });

  it('keeps successful interval writes as normal seed-complete metadata', () => {
    const { extra, intervalFailure, exitCode } = buildSeedResultLogExtra({
      skipped: false,
      total: 196,
      recordCount: 196,
      intervalsWritten: 196,
    });

    assert.equal(exitCode, 0);
    assert.equal(intervalFailure, null);
    assert.equal(extra.status, undefined);
    assert.equal(extra.intervalsWritten, 196);
  });
});

describe('computeIntervals', () => {
  it('returns p05 <= p95', () => {
    const domainScores = [65, 70, 55, 80, 60];
    const weights = [0.22, 0.20, 0.15, 0.25, 0.18];
    const result = computeIntervals(domainScores, weights, 200);
    assert.ok(result.p05 <= result.p95, `p05 (${result.p05}) should be <= p95 (${result.p95})`);
  });

  it('returns values within the domain score range', () => {
    const domainScores = [40, 60, 50, 70, 55];
    const weights = [0.22, 0.20, 0.15, 0.25, 0.18];
    const result = computeIntervals(domainScores, weights, 200);
    assert.ok(result.p05 >= 30, `p05 (${result.p05}) should be >= 30`);
    assert.ok(result.p95 <= 80, `p95 (${result.p95}) should be <= 80`);
  });

  it('returns identical p05/p95 for uniform domain scores', () => {
    const domainScores = [50, 50, 50, 50, 50];
    const weights = [0.22, 0.20, 0.15, 0.25, 0.18];
    const result = computeIntervals(domainScores, weights, 100);
    assert.equal(result.p05, 50);
    assert.equal(result.p95, 50);
  });

  it('produces wider interval for more diverse domain scores', () => {
    const uniform = [50, 50, 50, 50, 50];
    const diverse = [20, 90, 30, 80, 40];
    const weights = [0.22, 0.20, 0.15, 0.25, 0.18];
    const uResult = computeIntervals(uniform, weights, 500);
    const dResult = computeIntervals(diverse, weights, 500);
    const uWidth = uResult.p95 - uResult.p05;
    const dWidth = dResult.p95 - dResult.p05;
    assert.ok(dWidth > uWidth, `Diverse width (${dWidth}) should be > uniform width (${uWidth})`);
  });
});

describe('script is self-contained .mjs', () => {
  // The seeder runs in a bare-node Railway container with no TypeScript loader
  // and no access to server/, so its import graph is a real deployment
  // constraint that nothing executable can observe. The diagnostic-identifier
  // assertions that used to sit alongside these (createIntervalDiagnostics,
  // intervalClampCount, formulaSkipCount, …) just restated names the seeder
  // logs; the logging behaviour itself is exercised by the interval and
  // classification suites above, which run the real functions.
  const src = readFileSync(
    new URL('../scripts/seed-resilience-scores.mjs', import.meta.url),
    'utf8',
  );

  it('never reaches into server/ or a TypeScript loader', () => {
    assert.equal(src.includes('../server/'), false, 'Must not import from ../server/');
    assert.equal(src.includes('tsx/esm'), false, 'Must not reference tsx/esm');
  });

  it('imports only local ./ relative paths', () => {
    for (const imp of [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])) {
      assert.ok(imp.startsWith('./'), `Import "${imp}" must be a local ./ relative path`);
    }
  });

  it('derives domain weights from the shared interval helper, not a private copy', () => {
    assert.match(src, /from ['"]\.\/_resilience-intervals\.mjs['"]/);
    assert.doesNotMatch(src, /const DOMAIN_WEIGHTS =/);
  });
});


describe('ensures ranking aggregate is present every cron, with truthful meta', () => {
  // The ranking aggregate has the same 6h TTL as the per-country scores. If we
  // only check + rebuild it inside the missing-scores branch, a cron tick that
  // finds all scores still warm will skip the probe entirely — and the ranking
  // can expire mid-cycle without anyone noticing until the NEXT cold-start
  // cron. The probe + rebuild path must run on every cron, regardless of
  // whether per-country warm was needed. The seed-meta write must be gated on
  // post-rebuild verification so it never claims freshness over a missing key.
  let src;
  before(async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const dir = dirname(fileURLToPath(import.meta.url));
    src = readFileSync(join(dir, '..', 'scripts', 'seed-resilience-scores.mjs'), 'utf8');
  });

  it('extracts refreshRankingAggregate helper used by both warm and skip-warm branches', () => {
    assert.match(src, /async function refreshRankingAggregate\b/, 'helper must be defined');
    const calls = [...src.matchAll(/await\s+refreshRankingAggregate\s*\(/g)];
    assert.ok(
      calls.length >= 2,
      `refreshRankingAggregate must be called from both branches (missing>0 and missing===0); found ${calls.length} call sites`,
    );
  });

  it('rotates the score cohort before reading interval inputs in both branches', () => {
    const refreshCalls = [...src.matchAll(/const rankingPresent = await refreshRankingAggregate\([^;]+;/g)]
      .map((match) => match.index);
    const scoreReads = [...src.matchAll(/const (?:finalResults|refreshedResults) = await redisPipeline\(url, token, getCommands\);/g)]
      .map((match) => match.index);
    const intervalWrites = [...src.matchAll(/const intervalResult = await computeAndWriteIntervals\(url, token, countryCodes, (?:finalResults|refreshedResults), expectedCacheState\);/g)]
      .map((match) => match.index);

    assert.equal(refreshCalls.length, 2, 'warm and pre-warmed branches must each rotate the score cohort');
    assert.equal(scoreReads.length, 2, 'each branch must re-read the score cohort after rotation');
    assert.equal(intervalWrites.length, 2, 'each branch must publish intervals from its re-read cohort');
    for (let index = 0; index < 2; index++) {
      assert.ok(refreshCalls[index] < scoreReads[index], 'score rotation must precede the interval input read');
      assert.ok(scoreReads[index] < intervalWrites[index], 'interval publication must use the post-rotation score read');
    }
  });

  it('preserves the prior interval generation when the forced refresh does not complete', async () => {
    const mod = await import('../scripts/seed-resilience-scores.mjs');
    assert.equal(
      typeof mod.refreshRankingAggregate,
      'function',
      'the refresh boundary must be directly testable as behavior, not only by source ordering',
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const href = typeof input === 'string' ? input : input.url;
      if (href.includes('/api/resilience/v1/get-resilience-ranking')) {
        return new Response('gateway timeout', { status: 504 });
      }
      if (href.includes('/strlen/')) {
        return new Response(JSON.stringify({ result: 31_370 }), { status: 200 });
      }
      if (href.includes('/get/seed-meta:resilience:ranking')) {
        return new Response(JSON.stringify({
          result: JSON.stringify({ fetchedAt: Date.now(), recordCount: 196 }),
        }), { status: 200 });
      }
      throw new Error(`Unexpected fetch in refresh failure test: ${href}`);
    });

    try {
      await assert.rejects(
        () => mod.refreshRankingAggregate({
          url: 'https://redis.example',
          token: 'token',
          laggardsWarmed: 0,
        }),
        /previous interval generation was preserved/i,
        'an old ranking key must not make a failed refresh look safe for interval publication',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('always triggers the rebuild HTTP call — never short-circuits on "key still present"', () => {
    // Skipping rebuild when the key exists recreates a timing hole: the key
    // can be alive at probe time but expire a few minutes later, leaving a
    // multi-hour gap until the NEXT cron where the key happens to be gone at
    // probe time. Always rebuilding is one cheap HTTP per cron.
    assert.doesNotMatch(
      src,
      /if\s*\(\s*rankingExists\s*!=\s*null[^)]*\)\s*return\s+true/,
      'refreshRankingAggregate must not early-return when the ranking key is still present',
    );
    // The HTTP rebuild call itself must be unconditional (not gated on a probe).
    assert.match(
      src,
      /async function refreshRankingAggregate[\s\S]*?\/api\/resilience\/v1\/get-resilience-ranking/,
      'rebuild HTTP call must be in the body of refreshRankingAggregate unconditionally',
    );
  });

  it('verifies the ranking key after the rebuild attempt for observability', () => {
    assert.match(
      src,
      /\/strlen\/\$\{encodeURIComponent\(RESILIENCE_RANKING_CACHE_KEY\)\}/,
      'STRLEN verify after rebuild surfaces when handler skipped the SET (coverage gate or partial pipeline)',
    );
  });

  it('does NOT DEL the ranking before rebuild — uses ?refresh=1 instead', () => {
    // The old flow (DEL + rebuild HTTP) created a brief absence window: if
    // the rebuild request failed transiently, the ranking stayed absent
    // until the next cron. We now send ?refresh=1 so the handler bypasses
    // its cache-hit early-return and recomputes+SETs atomically. On failure,
    // the existing (possibly stale) ranking remains.
    assert.doesNotMatch(
      src,
      /\['DEL',\s*RESILIENCE_RANKING_CACHE_KEY\]/,
      'seeder must not DEL the ranking key — ?refresh=1 is the atomic replacement path',
    );
    // ALL seeder-initiated calls to get-resilience-ranking must carry
    // ?refresh=1. The bulk-warm path (inside `if (missing > 0)`) also needs
    // it — the ranking TTL (12h) exceeds the score TTL (6h), so in the 6h-12h
    // window the handler would hit its cache and skip the warm entirely,
    // leaving per-country scores absent and coverage degraded.
    const rankingEndpointCalls = [...src.matchAll(/\/api\/resilience\/v1\/get-resilience-ranking(\?[^\s'`"]*)?/g)];
    assert.ok(rankingEndpointCalls.length >= 2, `expected at least 2 ranking-endpoint calls (bulk-warm + refresh), got ${rankingEndpointCalls.length}`);
    for (const [full, query] of rankingEndpointCalls) {
      assert.ok(
        (query || '').includes('refresh=1'),
        `ranking endpoint call must include ?refresh=1 — found: ${full}`,
      );
    }
  });

  it('uses the dedicated seed refresh key for ranking ?refresh=1 calls', () => {
    assert.match(
      src,
      /const WM_REFRESH_KEY = process\.env\.WORLDMONITOR_SEED_REFRESH_KEY\?\.trim\(\) \|\| '';/,
      'seeder must read the dedicated seed-only refresh secret',
    );
    assert.match(
      src,
      /if \(WM_REFRESH_KEY\) headers\['X-WorldMonitor-Key'\] = WM_REFRESH_KEY;/,
      'bulk ranking warmup must send the seed-only refresh secret, not a normal read key',
    );
    assert.match(
      src,
      /if \(WM_REFRESH_KEY\) rebuildHeaders\['X-WorldMonitor-Key'\] = WM_REFRESH_KEY;/,
      'scheduled ranking refresh must send the seed-only refresh secret, not a normal read key',
    );
  });

  it('fails fast when the dedicated seed refresh key is missing', () => {
    assert.match(
      src,
      /function requireSeedRefreshKey\(\)[\s\S]*?if \(WM_REFRESH_KEY\) return;[\s\S]*?throw new Error\('WORLDMONITOR_SEED_REFRESH_KEY is required for resilience ranking refresh'\);/,
      'seeder main must hard-fail when the seed-only refresh secret is missing',
    );
    assert.match(
      src,
      /requireSeedRefreshKey\(\);[\s\S]*?logSeedResult\('resilience:scores', 0,[\s\S]*?reason: 'missing_seed_refresh_key'/,
      'missing refresh-key failures must emit a seed_complete record before exiting non-zero',
    );
  });

  it('writes a score-section heartbeat independent of interval writes', () => {
    assert.match(
      src,
      /async function writeScoreSectionHeartbeat\b[\s\S]*?result\?\.skipped && result\.reason === 'no_index'[\s\S]*?return;[\s\S]*?writeFreshnessMetadata\(\s*'resilience',\s*'scores',[\s\S]*?RESILIENCE_SCORE_SECTION_META_TTL_SECONDS/,
      'score seeder must write seed-meta:resilience:scores for completed score/ranking work, but not for empty-index skips',
    );
    assert.match(
      src,
      /const result = await seedResilienceScores\(\);\s*await writeScoreSectionHeartbeat\(result\);/,
      'score heartbeat helper must run after the score/ranking section so it can gate completed runs and skip no_index safely',
    );
  });

  it('seeder does NOT write seed-meta:resilience:ranking (handler is sole writer)', () => {
    // A seeder-written meta can only attest to per-country score count, not
    // to whether the ranking aggregate was actually published. Handler gates
    // its SET on 90% coverage; if the gate trips, an older ranking survives
    // and seeder meta would lie about freshness. Remove the seeder write —
    // handler writes ranking + meta atomically, ensureRankingPresent()
    // triggers the handler every cron so meta stays fresh during quiet Pro
    // usage without the seeder needing to heartbeat.
    assert.doesNotMatch(
      src,
      /writeRankingSeedMeta\s*\(/,
      'seed-resilience-scores.mjs must NOT define or call writeRankingSeedMeta',
    );
    // Assert no SET command targets the meta key — comments that reference
    // the key name are fine and useful for future maintainers.
    assert.doesNotMatch(
      src,
      /\[\s*['"]SET['"]\s*,\s*['"]seed-meta:resilience:ranking['"]/,
      'seeder must not issue SET seed-meta:resilience:ranking (handler is sole writer)',
    );
  });
});

describe('seed-bundle-resilience section interval keeps refresh alive', () => {
  // The bundle runner skips a section when its seed-meta is younger than
  // intervalMs * 0.8. If intervalMs is too long (e.g. 6h), most Railway cron
  // fires hit the skip branch → refreshRankingAggregate() never runs →
  // ranking can expire between actual runs and create EMPTY_ON_DEMAND gaps.
  // 2h is the tested trade-off: frequent enough for the 12h ranking TTL to
  // stay well-refreshed, cheap enough per warm-path run (~5-10s).
  it('Resilience-Scores section has intervalMs ≤ 2 hours', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      join(dir, '..', 'scripts', 'seed-bundle-resilience.mjs'),
      'utf8',
    );
    // Match the label + section line, then extract the intervalMs value.
    const m = src.match(/label:\s*'Resilience-Scores'[\s\S]{0,400}?intervalMs:\s*(\d+)\s*\*\s*HOUR/);
    assert.ok(m, 'Resilience-Scores section must set intervalMs in HOUR units');
    const hours = Number(m[1]);
    assert.ok(
      hours > 0 && hours <= 2,
      `intervalMs must be ≤ 2 hours (found ${hours}) so refreshRankingAggregate runs frequently enough to keep the ranking key alive before its 12h TTL`,
    );
  });

  it('Resilience-Scores section gates on score heartbeat, not interval heartbeat', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      join(dir, '..', 'scripts', 'seed-bundle-resilience.mjs'),
      'utf8',
    );
    const section = src.match(/label:\s*'Resilience-Scores'[\s\S]{0,240}/)?.[0] ?? '';
    assert.match(section, /seedMetaKey:\s*'resilience:scores'/);
    assert.doesNotMatch(section, /seedMetaKey:\s*'resilience:intervals'/);
  });
});

describe('resilience operator docs', () => {
  it('operator force-refresh docs include the required seed refresh key', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const dir = dirname(fileURLToPath(import.meta.url));
    const files = [
      join(dir, '..', 'docs', 'railway-seed-consolidation-runbook.md'),
      join(dir, '..', 'scripts', 'post-pr3427-force-refresh.mjs'),
      join(dir, '..', 'scripts', 'post-pr3487-force-refresh.mjs'),
    ];

    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const scoreWarmCommands = [...src.matchAll(/node scripts\/seed-resilience-scores\.mjs/g)];
      assert.ok(scoreWarmCommands.length > 0, `${file} must document the score warm command`);
      for (const match of scoreWarmCommands) {
        const commandContext = src.slice(Math.max(0, match.index - 240), match.index + match[0].length);
        assert.match(
          commandContext,
          /WORLDMONITOR_SEED_REFRESH_KEY=<seed-refresh-key>/,
          `${file} must include WORLDMONITOR_SEED_REFRESH_KEY for seed-resilience-scores`,
        );
      }
      assert.doesNotMatch(
        src,
        /WORLDMONITOR_API_KEY=<key> node scripts\/seed-resilience-scores\.mjs/,
        `${file} must not document the pre-refresh-key score warm command`,
      );
    }
  });
});

describe('handler warm pipeline is chunked', () => {
  // The 222-country pipeline SET payload (~600KB) exceeds the 5s pipeline
  // timeout on Vercel Edge → handler reports 0 persisted, ranking skipped.
  // The fix is to chunk into smaller pipelines that comfortably fit. Static
  // assertion because behavioral tests can't easily synthesize 222 countries
  // through the full scoring pipeline.
  it('warmMissingResilienceScores splits SETs into batches', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      join(dir, '..', 'server', 'worldmonitor', 'resilience', 'v1', '_shared.ts'),
      'utf8',
    );
    assert.match(
      src,
      /const\s+SET_BATCH\s*=\s*\d+/,
      'SET_BATCH constant must be defined',
    );
    assert.match(
      src,
      /persistRedisCommandsWithRetry\(allSetCommands,\s*SET_BATCH\)/,
      'pipeline SETs must be issued in SET_BATCH-sized chunks',
    );
  });
});

describe('laggard warmup aggregate budget (#6562 item 3)', () => {
  it('LAGGARD_WARMUP_BUDGET_MS stays below the 240s Resilience-Scores section timeout', () => {
    assert.ok(
      LAGGARD_WARMUP_BUDGET_MS < 240_000,
      `budget ${LAGGARD_WARMUP_BUDGET_MS}ms must leave headroom below the 240s section cap`,
    );
  });

  it('stops warming once the budget is exhausted and reports the partial count', async () => {
    const stillMissing = Array.from({ length: 12 }, (_, i) => `C${String(i).padStart(2, '0')}`);
    const fetched = [];
    const fetchImpl = async (url) => {
      fetched.push(String(url));
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response('{}', { status: 200 });
    };
    const warmed = await warmLaggardCountries(stillMissing, {
      apiKey: 'test-key',
      budgetMs: 1,
      batchSize: 5,
      fetchImpl,
    });
    assert.equal(fetched.length, 5, 'only the first batch may start before the deadline trips');
    assert.equal(warmed, 5);
  });

  it('warms every laggard when the budget holds', async () => {
    const stillMissing = ['US', 'FR', 'DE', 'JP', 'KR', 'BR'];
    const fetched = [];
    const fetchImpl = async (url) => {
      fetched.push(String(url));
      return new Response('{}', { status: 200 });
    };
    const warmed = await warmLaggardCountries(stillMissing, {
      apiKey: 'test-key',
      budgetMs: 10_000,
      batchSize: 5,
      fetchImpl,
    });
    assert.equal(fetched.length, stillMissing.length);
    assert.equal(warmed, stillMissing.length);
  });

  it('skips warmup without an API key and fetches nothing', async () => {
    const warmed = await warmLaggardCountries(['US'], {
      apiKey: null,
      fetchImpl: async () => {
        throw new Error('must not fetch without an API key');
      },
    });
    assert.equal(warmed, 0);
  });

  it('counts only fulfilled requests toward the warmed total', async () => {
    const fetchImpl = async (url) => {
      const cc = new URL(String(url)).searchParams.get('countryCode');
      if (cc === 'FR') return new Response('{}', { status: 503 });
      return new Response('{}', { status: 200 });
    };
    const warmed = await warmLaggardCountries(['US', 'FR', 'DE'], {
      apiKey: 'test-key',
      budgetMs: 10_000,
      batchSize: 5,
      fetchImpl,
    });
    assert.equal(warmed, 2);
  });
});
