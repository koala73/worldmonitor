import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { getResilienceScore } from '../server/worldmonitor/resilience/v1/get-resilience-score.ts';
import { RESILIENCE_INTERVAL_METHODOLOGY } from '../server/worldmonitor/resilience/v1/_shared.ts';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';
import { RESILIENCE_FIXTURES } from './helpers/resilience-fixtures.mts';

const originalFetch = globalThis.fetch;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const originalVercelEnv = process.env.VERCEL_ENV;
const originalPillarCombine = process.env.RESILIENCE_PILLAR_COMBINE_ENABLED;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRedisUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
  if (originalRedisToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
  if (originalVercelEnv == null) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = originalVercelEnv;
  if (originalPillarCombine == null) delete process.env.RESILIENCE_PILLAR_COMBINE_ENABLED;
  else process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = originalPillarCombine;
});

describe('resilience score interval integration', () => {
  it('includes scoreInterval when Redis has interval data', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'false';
    delete process.env.VERCEL_ENV;

    const fixtures = {
      ...RESILIENCE_FIXTURES,
      'resilience:intervals:v9:US': {
        p05: 65.2,
        p95: 72.8,
        _formula: 'd6',
        draws: 100,
        computedAt: '2026-04-06T00:00:00.000Z',
        methodology: RESILIENCE_INTERVAL_METHODOLOGY,
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

  it('omits stale-formula interval data', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'false';
    delete process.env.VERCEL_ENV;

    const fixtures = {
      ...RESILIENCE_FIXTURES,
      'resilience:intervals:v9:US': {
        p05: 65.2,
        p95: 72.8,
        _formula: 'pc',
        draws: 100,
        computedAt: '2026-04-06T00:00:00.000Z',
        methodology: RESILIENCE_INTERVAL_METHODOLOGY,
      },
    };

    const { fetchImpl } = createRedisFetch(fixtures);
    globalThis.fetch = fetchImpl;

    const response = await getResilienceScore(
      { request: new Request('https://example.com') } as never,
      { countryCode: 'US' },
    );

    assert.equal(response.scoreInterval, undefined, 'stale-formula scoreInterval should be ignored');
  });

  it('omits wrong-methodology interval data', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'false';
    delete process.env.VERCEL_ENV;

    const fixtures = {
      ...RESILIENCE_FIXTURES,
      'resilience:intervals:v9:US': {
        p05: 65.2,
        p95: 72.8,
        _formula: 'd6',
        draws: 100,
        computedAt: '2026-04-06T00:00:00.000Z',
        methodology: 'legacy-weight-perturbation-v2',
      },
    };

    const { fetchImpl } = createRedisFetch(fixtures);
    globalThis.fetch = fetchImpl;

    const response = await getResilienceScore(
      { request: new Request('https://example.com') } as never,
      { countryCode: 'US' },
    );

    assert.equal(response.scoreInterval, undefined, 'wrong-methodology scoreInterval should be ignored');
  });

  it('omits untagged interval data', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'false';
    delete process.env.VERCEL_ENV;

    const fixtures = {
      ...RESILIENCE_FIXTURES,
      'resilience:intervals:v9:US': {
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

    assert.equal(response.scoreInterval, undefined, 'untagged scoreInterval should be ignored');
  });

  it('omits malformed interval bounds', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'false';
    delete process.env.VERCEL_ENV;

    const cases = [
      { name: 'reversed', p05: 80, p95: 70 },
      { name: 'below range', p05: -1, p95: 70 },
      { name: 'above range', p05: 65.2, p95: 101 },
    ];

    for (const item of cases) {
      const fixtures = {
        ...RESILIENCE_FIXTURES,
        'resilience:intervals:v9:US': {
          p05: item.p05,
          p95: item.p95,
          _formula: 'd6',
          draws: 100,
          computedAt: '2026-04-06T00:00:00.000Z',
          methodology: RESILIENCE_INTERVAL_METHODOLOGY,
        },
      };

      const { fetchImpl } = createRedisFetch(fixtures);
      globalThis.fetch = fetchImpl;

      const response = await getResilienceScore(
        { request: new Request('https://example.com') } as never,
        { countryCode: 'US' },
      );

      assert.equal(response.scoreInterval, undefined, `${item.name} scoreInterval should be ignored`);
    }
  });

  it('omits scoreInterval when Redis has no interval data', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'false';
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
