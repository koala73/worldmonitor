import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { getResilienceRanking } from '../server/worldmonitor/resilience/v1/get-resilience-ranking.ts';
import { sortRankingItems } from '../server/worldmonitor/resilience/v1/_shared.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';
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

describe('resilience ranking contracts', () => {
  it('sorts descending by overall score and keeps unscored placeholders at the end', () => {
    const sorted = sortRankingItems([
      { countryCode: 'US', overallScore: 61, level: 'medium', lowConfidence: false },
      { countryCode: 'YE', overallScore: -1, level: 'unknown', lowConfidence: true },
      { countryCode: 'NO', overallScore: 82, level: 'high', lowConfidence: false },
      { countryCode: 'DE', overallScore: -1, level: 'unknown', lowConfidence: true },
      { countryCode: 'JP', overallScore: 61, level: 'medium', lowConfidence: false },
    ]);

    assert.deepEqual(
      sorted.map((item) => [item.countryCode, item.overallScore]),
      [['NO', 82], ['JP', 61], ['US', 61], ['DE', -1], ['YE', -1]],
    );
  });

  it('returns the cached ranking payload unchanged when the ranking cache already exists', async () => {
    const { redis } = installRedis(RESILIENCE_FIXTURES);
    const cached = {
      items: [
        { countryCode: 'NO', overallScore: 82, level: 'high', lowConfidence: false },
        { countryCode: 'US', overallScore: 61, level: 'medium', lowConfidence: false },
      ],
    };
    redis.set('resilience:ranking', JSON.stringify(cached));

    const response = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    assert.deepEqual(response, cached);
    assert.equal(redis.has('resilience:score:YE'), false, 'cache hit must not trigger score warmup');
  });

  it('warms missing scores synchronously and returns complete ranking on first call', async () => {
    const { redis } = installRedis(RESILIENCE_FIXTURES);
    redis.set('resilience:score:NO', JSON.stringify({
      countryCode: 'NO',
      overallScore: 82,
      level: 'high',
      domains: [],
      cronbachAlpha: 0.82,
      trend: 'stable',
      change30d: 1.2,
      lowConfidence: false,
    }));
    redis.set('resilience:score:US', JSON.stringify({
      countryCode: 'US',
      overallScore: 61,
      level: 'medium',
      domains: [],
      cronbachAlpha: 0.67,
      trend: 'rising',
      change30d: 4.3,
      lowConfidence: false,
    }));

    const response = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    assert.equal(response.items.length, 3);
    assert.ok(redis.has('resilience:score:YE'), 'missing country should be warmed during first call');
    assert.ok(response.items.every((item) => item.overallScore >= 0), 'all scores should be computed on first call');
    assert.ok(redis.has('resilience:ranking'), 'fully scored ranking should be cached');
  });
});
