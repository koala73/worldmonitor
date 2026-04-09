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
      assert.ok(response.overallScore >= 60, `${response.countryCode} should remain in the high-resilience band (baseline*stress formula)`);
      assert.ok(response.baselineScore > response.stressScore * 0.8, `${response.countryCode} baseline should be >= 80% of stress for resilient countries`);
    }

    const lowAnchors = await Promise.all(
      LOW_SANITY_COUNTRIES.map((countryCode) =>
        getResilienceScore({ request: new Request(`https://example.com?countryCode=${countryCode}`) } as never, { countryCode }),
      ),
    );
    for (const response of lowAnchors) {
      assert.ok(response.overallScore <= 20, `${response.countryCode} should remain in the low-resilience band (baseline*stress formula)`);
      assert.ok(response.stressScore < 40, `${response.countryCode} (fragile) should have stressScore < 40`);
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
});
