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
    sortedSets.set('resilience:history:US', [
      { member: '2026-04-01:20', score: 20260401 },
      { member: '2026-04-02:30', score: 20260402 },
    ]);
    globalThis.fetch = fetchImpl;

    const response = await getResilienceScore({ request: new Request('https://example.com') } as never, {
      countryCode: 'us',
    });

    assert.equal(response.countryCode, 'US');
    assert.equal(response.domains.length, 5);
    assert.equal(response.domains.flatMap((domain) => domain.dimensions).length, 13);
    assert.ok(response.overallScore > 0 && response.overallScore <= 100);
    assert.equal(response.level, response.overallScore >= 70 ? 'high' : response.overallScore >= 40 ? 'medium' : 'low');
    assert.equal(response.trend, 'rising');
    assert.ok(response.change30d > 0);
    assert.equal(typeof response.lowConfidence, 'boolean');
    assert.ok(response.imputationShare >= 0 && response.imputationShare <= 1, `imputationShare out of bounds: ${response.imputationShare}`);

    const cachedScore = redis.get('resilience:score:v2:US');
    assert.ok(cachedScore, 'expected score cache to be written');
    assert.equal(JSON.parse(cachedScore || '{}').countryCode, 'US');

    const history = sortedSets.get('resilience:history:US') ?? [];
    assert.ok(history.some((entry) => entry.member.startsWith(today + ':')), 'expected today history member to be written');

    await getResilienceScore({ request: new Request('https://example.com') } as never, {
      countryCode: 'US',
    });
    assert.equal((sortedSets.get('resilience:history:US') ?? []).length, history.length, 'cache hit must not append history');
  });
});
