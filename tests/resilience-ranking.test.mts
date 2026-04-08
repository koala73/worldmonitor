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
        { countryCode: 'NO', overallScore: 82, level: 'high', lowConfidence: false, overallCoverage: 0.95 },
        { countryCode: 'US', overallScore: 61, level: 'medium', lowConfidence: false, overallCoverage: 0.88 },
      ],
      greyedOut: [],
    };
    redis.set('resilience:ranking:v4', JSON.stringify(cached));

    const response = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    assert.deepEqual(response, cached);
    assert.equal(redis.has('resilience:score:v4:YE'), false, 'cache hit must not trigger score warmup');
  });

  it('returns all-greyed-out cached payload without rewarming (items=[], greyedOut non-empty)', async () => {
    // Regression for: `cached?.items?.length` was falsy when items=[] even though
    // greyedOut had entries, causing unnecessary rewarming on every request.
    const { redis } = installRedis(RESILIENCE_FIXTURES);
    const cached = {
      items: [],
      greyedOut: [
        { countryCode: 'SS', overallScore: 12, level: 'critical', lowConfidence: true, overallCoverage: 0.15 },
        { countryCode: 'ER', overallScore: 10, level: 'critical', lowConfidence: true, overallCoverage: 0.12 },
      ],
    };
    redis.set('resilience:ranking:v4', JSON.stringify(cached));

    const response = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    assert.deepEqual(response, cached);
    assert.equal(redis.has('resilience:score:v4:SS'), false, 'all-greyed-out cache hit must not trigger score warmup');
  });

  it('warms missing scores synchronously and returns complete ranking on first call', async () => {
    const { redis } = installRedis(RESILIENCE_FIXTURES);
    const domainWithCoverage = [{ name: 'political', dimensions: [{ name: 'd1', coverage: 0.9 }] }];
    redis.set('resilience:score:v4:NO', JSON.stringify({
      countryCode: 'NO',
      overallScore: 82,
      level: 'high',
      domains: domainWithCoverage,
      trend: 'stable',
      change30d: 1.2,
      lowConfidence: false,
      imputationShare: 0.05,
    }));
    redis.set('resilience:score:v4:US', JSON.stringify({
      countryCode: 'US',
      overallScore: 61,
      level: 'medium',
      domains: domainWithCoverage,
      trend: 'rising',
      change30d: 4.3,
      lowConfidence: false,
      imputationShare: 0.1,
    }));

    const response = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    const totalItems = response.items.length + (response.greyedOut?.length ?? 0);
    assert.equal(totalItems, 3, `expected 3 total items across ranked + greyedOut, got ${totalItems}`);
    assert.ok(redis.has('resilience:score:v4:YE'), 'missing country should be warmed during first call');
    assert.ok(response.items.every((item) => item.overallScore >= 0), 'ranked items should all have computed scores');
    assert.ok(redis.has('resilience:ranking:v4'), 'fully scored ranking should be cached');
  });
});
