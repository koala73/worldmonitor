import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { getResilienceRanking } from '../server/worldmonitor/resilience/v1/get-resilience-ranking.ts';
import { getResilienceScore } from '../server/worldmonitor/resilience/v1/get-resilience-score.ts';
import { RESILIENCE_FIXTURES } from './helpers/resilience-fixtures.mts';

const originalFetch = globalThis.fetch;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const originalVercelEnv = process.env.VERCEL_ENV;

function createRedisFetch(fixtures: Record<string, unknown>) {
  const redis = new Map<string, string>();
  const sortedSets = new Map<string, Array<{ member: string; score: number }>>();

  for (const [key, value] of Object.entries(fixtures)) {
    redis.set(key, JSON.stringify(value));
  }

  const upsertSortedSet = (key: string, score: number, member: string) => {
    const next = (sortedSets.get(key) ?? []).filter((item) => item.member !== member);
    next.push({ member, score });
    next.sort((left, right) => left.score - right.score || left.member.localeCompare(right.member));
    sortedSets.set(key, next);
  };

  const removeByRank = (key: string, start: number, stop: number) => {
    const items = [...(sortedSets.get(key) ?? [])];
    if (items.length === 0) return;

    const normalizeIndex = (index: number) => (index < 0 ? items.length + index : index);
    const startIndex = Math.max(0, normalizeIndex(start));
    const stopIndex = Math.min(items.length - 1, normalizeIndex(stop));
    if (startIndex > stopIndex) return;
    items.splice(startIndex, stopIndex - startIndex + 1);
    sortedSets.set(key, items);
  };

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith(process.env.UPSTASH_REDIS_REST_URL || '')) {
      throw new Error(`Unexpected URL: ${url}`);
    }

    const parsed = new URL(url);
    if (parsed.pathname.startsWith('/get/')) {
      const key = decodeURIComponent(parsed.pathname.slice('/get/'.length));
      return new Response(JSON.stringify({ result: redis.get(key) ?? null }), { status: 200 });
    }

    if (parsed.pathname.startsWith('/set/')) {
      const parts = parsed.pathname.split('/');
      const key = decodeURIComponent(parts[2] || '');
      const value = decodeURIComponent(parts[3] || '');
      redis.set(key, value);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }

    if (parsed.pathname === '/pipeline') {
      const commands = JSON.parse(typeof init?.body === 'string' ? init.body : '[]') as Array<Array<string | number>>;
      const result = commands.map((command) => {
        const [verb, key = '', ...args] = command;
        const redisKey = String(key);

        if (verb === 'GET') {
          return { result: redis.get(redisKey) ?? null };
        }

        if (verb === 'SET') {
          redis.set(redisKey, String(args[0] || ''));
          return { result: 'OK' };
        }

        if (verb === 'ZADD') {
          for (let index = 0; index < args.length; index += 2) {
            upsertSortedSet(redisKey, Number(args[index] || 0), String(args[index + 1] || ''));
          }
          return { result: 1 };
        }

        if (verb === 'ZRANGE') {
          const items = [...(sortedSets.get(redisKey) ?? [])];
          const withScores = args.map(String).includes('WITHSCORES');
          if (!withScores) return { result: items.map((item) => item.member) };
          return {
            result: items.flatMap((item) => [item.member, String(item.score)]),
          };
        }

        if (verb === 'ZREMRANGEBYRANK') {
          removeByRank(redisKey, Number(args[0] || 0), Number(args[1] || 0));
          return { result: 1 };
        }

        throw new Error(`Unexpected pipeline command: ${verb}`);
      });
      return new Response(JSON.stringify(result), { status: 200 });
    }

    throw new Error(`Unexpected Redis path: ${parsed.pathname}`);
  }) as typeof fetch;

  return { fetchImpl, redis, sortedSets };
}

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
    assert.ok(response.cronbachAlpha >= 0);
    assert.equal(response.trend, 'rising');
    assert.ok(response.change30d > 0);
    assert.equal(typeof response.lowConfidence, 'boolean');

    const cachedScore = redis.get('resilience:score:US');
    assert.ok(cachedScore, 'expected score cache to be written');
    assert.equal(JSON.parse(cachedScore || '{}').countryCode, 'US');

    const history = sortedSets.get('resilience:history:US') ?? [];
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(history.some((entry) => entry.member.startsWith(today + ':')), 'expected today history member to be written');

    await getResilienceScore({ request: new Request('https://example.com') } as never, {
      countryCode: 'US',
    });
    assert.equal((sortedSets.get('resilience:history:US') ?? []).length, history.length, 'cache hit must not append history');
  });

  it('returns cached ranking entries first, leaves placeholders for misses, and warms missing scores', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    delete process.env.VERCEL_ENV;

    const { fetchImpl, redis } = createRedisFetch(RESILIENCE_FIXTURES);
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
    globalThis.fetch = fetchImpl;

    const first = await getResilienceRanking({ request: new Request('https://example.com') } as never, {});

    assert.equal(first.items.length, 3);
    assert.ok(redis.has('resilience:score:YE'), 'missing country should be warmed during first call');
    assert.ok(first.items.every((item) => item.overallScore >= 0), 'all scores should be computed on first call');
    assert.ok(redis.has('resilience:ranking'), 'fully scored ranking should be cached');
  });
});
