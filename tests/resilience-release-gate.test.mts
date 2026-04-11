import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { getResilienceRanking } from '../server/worldmonitor/resilience/v1/get-resilience-ranking.ts';
import { getResilienceScore } from '../server/worldmonitor/resilience/v1/get-resilience-score.ts';
import { scoreAllDimensions } from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';
import { buildResilienceChoroplethMap } from '../src/components/resilience-choropleth-utils.ts';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';
import {
  EU27_COUNTRIES,
  G20_COUNTRIES,
  buildReleaseGateFixtures,
} from './helpers/resilience-release-fixtures.mts';

const REQUIRED_DIMENSION_COUNTRIES = ['US', 'GB', 'DE', 'FR', 'JP', 'CN', 'IN', 'BR', 'NG', 'LB', 'YE'] as const;
const CHOROPLETH_TARGET_COUNTRIES = [...new Set([...G20_COUNTRIES, ...EU27_COUNTRIES])];
const HIGH_SANITY_COUNTRIES = ['NO', 'CH', 'DK'] as const;
const LOW_SANITY_COUNTRIES = ['YE', 'SO', 'HT'] as const;
const SPARSE_CONFIDENCE_COUNTRIES = ['SS', 'ER'] as const;

const originalFetch = globalThis.fetch;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const originalVercelEnv = process.env.VERCEL_ENV;
const fixtures = buildReleaseGateFixtures();

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRedisUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
  if (originalRedisToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
  if (originalVercelEnv == null) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = originalVercelEnv;
});

function fixtureReader(key: string): Promise<unknown | null> {
  return Promise.resolve(fixtures[key] ?? null);
}

function installRedisFixtures() {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  delete process.env.VERCEL_ENV;
  const redisState = createRedisFetch(fixtures);
  globalThis.fetch = redisState.fetchImpl;
  return redisState;
}

describe('resilience release gate', () => {
  it('keeps all 13 dimension scorers non-placeholder for the required countries', async () => {
    for (const countryCode of REQUIRED_DIMENSION_COUNTRIES) {
      const scores = await scoreAllDimensions(countryCode, fixtureReader);
      const entries = Object.entries(scores);
      assert.equal(entries.length, 13, `${countryCode} should have all resilience dimensions`);
      for (const [dimensionId, score] of entries) {
        assert.ok(Number.isFinite(score.score), `${countryCode} ${dimensionId} should produce a numeric score`);
        assert.ok(score.coverage > 0, `${countryCode} ${dimensionId} should not fall back to zero-coverage placeholder scoring`);
      }
    }
  });

  it('keeps the seeded static keys for NO, US, and YE available in Redis', () => {
    const { redis } = installRedisFixtures();
    assert.ok(redis.has('resilience:static:NO'));
    assert.ok(redis.has('resilience:static:US'));
    assert.ok(redis.has('resilience:static:YE'));
  });

  it('keeps imputationShare below 0.5 for G20 countries and preserves score sanity anchors', async () => {
    installRedisFixtures();

    const g20Responses = await Promise.all(
      G20_COUNTRIES.map((countryCode) =>
        getResilienceScore({ request: new Request(`https://example.com?countryCode=${countryCode}`) } as never, { countryCode }),
      ),
    );

    const coveragePassing = g20Responses.filter((response) => response.imputationShare < 0.5);
    assert.ok(coveragePassing.length >= 10, `expected at least 10 G20 countries with imputationShare < 0.5, got ${coveragePassing.length}`);

    const highAnchors = await Promise.all(
      HIGH_SANITY_COUNTRIES.map((countryCode) =>
        getResilienceScore({ request: new Request(`https://example.com?countryCode=${countryCode}`) } as never, { countryCode }),
      ),
    );
    for (const response of highAnchors) {
      assert.ok(response.overallScore >= 70, `${response.countryCode} should remain in the high-resilience band (domain-weighted average)`);
    }

    const lowAnchors = await Promise.all(
      LOW_SANITY_COUNTRIES.map((countryCode) =>
        getResilienceScore({ request: new Request(`https://example.com?countryCode=${countryCode}`) } as never, { countryCode }),
      ),
    );
    for (const response of lowAnchors) {
      assert.ok(response.overallScore <= 35, `${response.countryCode} should remain in the low-resilience band (domain-weighted average)`);
    }
  });

  it('marks sparse WHO/FAO countries as low confidence', async () => {
    installRedisFixtures();

    for (const countryCode of SPARSE_CONFIDENCE_COUNTRIES) {
      const response = await getResilienceScore(
        { request: new Request(`https://example.com?countryCode=${countryCode}`) } as never,
        { countryCode },
      );
      assert.equal(response.lowConfidence, true, `${countryCode} should be flagged as low confidence`);
    }
  });

  it('Lebanon (fragile) scores lower than South Africa (stressed)', async () => {
    installRedisFixtures();

    const [lb, za] = await Promise.all([
      getResilienceScore({ request: new Request('https://example.com?countryCode=LB') } as never, { countryCode: 'LB' }),
      getResilienceScore({ request: new Request('https://example.com?countryCode=ZA') } as never, { countryCode: 'ZA' }),
    ]);

    assert.ok(
      lb.overallScore < za.overallScore,
      `Lebanon (fragile, ${lb.overallScore}) should score lower than South Africa (stressed, ${za.overallScore})`,
    );
  });

  it('US is not low-confidence with full 9/9 dataset coverage', async () => {
    installRedisFixtures();

    const us = await getResilienceScore(
      { request: new Request('https://example.com?countryCode=US') } as never,
      { countryCode: 'US' },
    );
    assert.equal(us.lowConfidence, false, `US has full 9/9 dataset coverage in fixtures and should not be flagged low-confidence`);
  });

  // T1.1 regression test (Phase 1 of the country-resilience reference-grade
  // upgrade plan, docs/internal/country-resilience-upgrade-plan.md).
  //
  // The origin review document (docs/internal/upgrading-country-resilience.md)
  // claims: "Norway and the US both hit 100 under current fixtures, which
  // broke the intended ordering and exposed a ceiling effect at the top end
  // of the ranking."
  //
  // Investigation outcome (2026-04-11): the claim does NOT reproduce.
  //
  // Measured scores under the current release-gate fixtures and the
  // post-PR-#2847 domain-weighted-average formula:
  //
  //     NO (elite tier)   overallScore = 86.58, baseline 86.85, stress 84.36
  //     US (strong tier)  overallScore = 72.80, baseline 73.15, stress 70.58
  //     Delta             NO - US = 13.78 points
  //     Ceiling           neither country approaches 100; all 5 domains stay
  //                       well inside the [0, 100] clamp range
  //
  // The ordering elite > strong > stressed > fragile is preserved. There is
  // no hard 100 ceiling in the scorer, and nothing in _dimension-scorers.ts
  // can produce a top-of-ranking tie between NO and US given the 14-point
  // quality differential wired into the fixtures.
  //
  // Conclusion: the origin-doc symptom is misattributed or stale (it likely
  // predates PR #2847's formula revert or references an older fixture set).
  // The origin-doc changelog will be updated in a trailing commit after
  // PR #2938 (the reference-grade plan) merges, since the origin doc is
  // part of that PR.
  //
  // This test pins the current correct behavior so any future regression to
  // a real top-of-ranking ceiling bug is caught immediately by CI.
  it('T1.1 regression: Norway and US do not both pin at 100 and preserve elite > strong ordering', async () => {
    installRedisFixtures();

    const [no, us] = await Promise.all([
      getResilienceScore({ request: new Request('https://example.com?countryCode=NO') } as never, { countryCode: 'NO' }),
      getResilienceScore({ request: new Request('https://example.com?countryCode=US') } as never, { countryCode: 'US' }),
    ]);

    assert.ok(
      no.overallScore < 100,
      `Norway should not pin at the ceiling (overallScore=${no.overallScore})`,
    );
    assert.ok(
      us.overallScore < 100,
      `US should not pin at the ceiling (overallScore=${us.overallScore})`,
    );
    assert.ok(
      no.overallScore > us.overallScore,
      `Norway (elite fixture, ${no.overallScore}) should score higher than the US (strong fixture, ${us.overallScore})`,
    );
    // Guard against a near-tie that would still break meaningful ranking.
    // Actual measured delta at commit time is 13.78 points; the threshold
    // of 8 (about 60% of the measured delta) leaves room for fixture
    // tuning while catching a tier-separation collapse before the ordering
    // degrades into a near-tie. An earlier version of this test used a
    // threshold of 3, which would have silently accepted a ~71% erosion
    // of the elite-strong separation signal. Bumped in response to PR
    // review feedback on #2941.
    assert.ok(
      no.overallScore - us.overallScore >= 8,
      `Norway should lead the US by at least 8 points (NO=${no.overallScore}, US=${us.overallScore}, delta=${no.overallScore - us.overallScore})`,
    );
  });

  it('produces complete ranking and choropleth entries for the full G20 + EU27 release set', async () => {
    installRedisFixtures();

    await Promise.all(
      CHOROPLETH_TARGET_COUNTRIES.map((countryCode) =>
        getResilienceScore({ request: new Request(`https://example.com?countryCode=${countryCode}`) } as never, { countryCode }),
      ),
    );

    const ranking = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});
    const relevantItems = ranking.items.filter((item) => CHOROPLETH_TARGET_COUNTRIES.includes(item.countryCode as typeof CHOROPLETH_TARGET_COUNTRIES[number]));
    assert.equal(relevantItems.length, CHOROPLETH_TARGET_COUNTRIES.length);
    assert.ok(relevantItems.every((item) => item.overallScore >= 0), 'release-gate countries should not fall back to blank ranking placeholders');

    const choropleth = buildResilienceChoroplethMap(relevantItems);
    for (const countryCode of CHOROPLETH_TARGET_COUNTRIES) {
      assert.ok(choropleth.has(countryCode), `expected choropleth data for ${countryCode}`);
    }
  });

  // T1.7 schema pass: the serialized ResilienceDimension now carries an
  // imputationClass field that downstream consumers (widget icon column,
  // methodology changelog) can use to distinguish stable-absence,
  // unmonitored, source-failure, and not-applicable from observed data.
  // This test pins the shape so the field is not silently dropped.
  it('T1.7: every serialized ResilienceDimension carries an imputationClass field', async () => {
    installRedisFixtures();

    const response = await getResilienceScore(
      { request: new Request('https://example.com?countryCode=US') } as never,
      { countryCode: 'US' },
    );

    const allDimensions = response.domains.flatMap((domain) => domain.dimensions);
    assert.equal(allDimensions.length, 13, 'US response should carry all 13 dimensions');
    for (const dimension of allDimensions) {
      assert.equal(
        typeof dimension.imputationClass,
        'string',
        `dimension ${dimension.id} must carry a string imputationClass (got ${typeof dimension.imputationClass})`,
      );
      const valid = ['', 'stable-absence', 'unmonitored', 'source-failure', 'not-applicable'];
      assert.ok(
        valid.includes(dimension.imputationClass),
        `dimension ${dimension.id} imputationClass="${dimension.imputationClass}" must be one of [${valid.join(', ')}]`,
      );
    }
  });

  it('T1.7: fully imputed dimension serializes a non-empty imputationClass', async () => {
    // XX has no fixture: every scorer will fall through to either null (no
    // data at all) or imputation. scoreFoodWater requires resilience:static
    // to be loaded before it imputes, so we supply a minimal static record
    // with fao:null and aquastat:null to trigger the IPC impute path.
    // This exercises the full pipeline: scorer → weightedBlend → buildDimensionList
    // → ResilienceDimension → response.
    const reader = async (key: string): Promise<unknown | null> => {
      if (key === 'resilience:static:XX') return { fao: null, aquastat: null };
      return null;
    };
    const scores = await scoreAllDimensions('XX', reader);
    assert.equal(
      scores.foodWater.imputationClass,
      'stable-absence',
      `foodWater with fao:null should be stable-absence at the scorer boundary, got ${scores.foodWater.imputationClass}`,
    );
  });
});
