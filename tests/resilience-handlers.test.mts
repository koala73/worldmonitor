import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { getResilienceScore } from '../server/worldmonitor/resilience/v1/get-resilience-score.ts';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';
import { RESILIENCE_FIXTURES } from './helpers/resilience-fixtures.mts';

const originalFetch = globalThis.fetch;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const originalVercelEnv = process.env.VERCEL_ENV;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRedisUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
  if (originalRedisToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
  if (originalVercelEnv == null) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = originalVercelEnv;
});

describe('resilience handlers', () => {
  it('computes and caches a country score with domains, trend metadata, and history writes', async () => {
    const today = new Date().toISOString().slice(0, 10);
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    delete process.env.VERCEL_ENV;

    const { fetchImpl, redis, sortedSets } = createRedisFetch(RESILIENCE_FIXTURES);
    sortedSets.set('resilience:history:v11:US', [
      { member: '2026-04-01:20', score: 20260401 },
      { member: '2026-04-02:30', score: 20260402 },
    ]);
    globalThis.fetch = fetchImpl;

    const response = await getResilienceScore({ request: new Request('https://example.com') } as never, {
      countryCode: 'us',
    });

    assert.equal(response.countryCode, 'US');
    assert.equal(response.domains.length, 6);
    // 20 active + 2 retired (fuelStockDays, reserveAdequacy) = 22. Retired
    // dims stay in the response for structural continuity; they're
    // filtered out of confidence averages via RESILIENCE_RETIRED_DIMENSIONS.
    // Plan 2026-04-25-004 Phase 2: financialSystemExposure is the 20th
    // active dim (ships flag-gated dark; counted in the structural total).
    assert.equal(response.domains.flatMap((domain) => domain.dimensions).length, 22);
    assert.ok(response.overallScore > 0 && response.overallScore <= 100);
    assert.equal(response.level, response.overallScore >= 70 ? 'high' : response.overallScore >= 40 ? 'medium' : 'low');
    assert.equal(response.trend, 'rising');
    assert.ok(response.change30d > 0);
    assert.equal(typeof response.lowConfidence, 'boolean');
    assert.ok(response.imputationShare >= 0 && response.imputationShare <= 1, `imputationShare out of bounds: ${response.imputationShare}`);
    assert.equal(typeof response.baselineScore, 'number', 'baselineScore should be present');
    assert.equal(typeof response.stressScore, 'number', 'stressScore should be present');
    assert.equal(typeof response.stressFactor, 'number', 'stressFactor should be present');
    assert.ok(response.baselineScore >= 0 && response.baselineScore <= 100, `baselineScore out of bounds: ${response.baselineScore}`);
    assert.ok(response.stressScore >= 0 && response.stressScore <= 100, `stressScore out of bounds: ${response.stressScore}`);
    assert.ok(response.stressFactor >= 0 && response.stressFactor <= 0.5, `stressFactor out of bounds: ${response.stressFactor}`);
    assert.equal(response.dataVersion, '2024-04-03', 'dataVersion should be the ISO date from seed-meta fetchedAt');

    const cachedScore = redis.get('resilience:score:v16:US');
    assert.ok(cachedScore, 'expected score cache to be written');
    assert.equal(JSON.parse(cachedScore || '{}').countryCode, 'US');

    const history = sortedSets.get('resilience:history:v11:US') ?? [];
    assert.ok(history.some((entry) => entry.member.startsWith(today + ':')), 'expected today history member to be written');

    await getResilienceScore({ request: new Request('https://example.com') } as never, {
      countryCode: 'US',
    });
    assert.equal((sortedSets.get('resilience:history:v11:US') ?? []).length, history.length, 'cache hit must not append history');
  });
});
