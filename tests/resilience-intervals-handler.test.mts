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

describe('resilience score interval integration', () => {
  it('includes scoreInterval when Redis has interval data', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    delete process.env.VERCEL_ENV;

    const fixtures = {
      ...RESILIENCE_FIXTURES,
      'resilience:intervals:v2:US': {
        p05: 65.2,
        p95: 72.8,
        draws: 100,
        computedAt: '2026-04-06T00:00:00.000Z',
      },
    };

    const { fetchImpl } = createRedisFetch(fixtures);
    globalThis.fetch = fetchImpl;

    const response = await getResilienceScore(
      { request: new Request('https://example.com') } as never,
      { countryCode: 'US' },
    );

    assert.ok(response.scoreInterval, 'scoreInterval should be present');
    assert.equal(response.scoreInterval.p05, 65.2);
    assert.equal(response.scoreInterval.p95, 72.8);
  });

  it('omits scoreInterval when Redis has no interval data', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    delete process.env.VERCEL_ENV;

    const { fetchImpl } = createRedisFetch(RESILIENCE_FIXTURES);
    globalThis.fetch = fetchImpl;

    const response = await getResilienceScore(
      { request: new Request('https://example.com') } as never,
      { countryCode: 'US' },
    );

    assert.equal(response.scoreInterval, undefined, 'scoreInterval should be absent when no interval data exists');
  });
});
