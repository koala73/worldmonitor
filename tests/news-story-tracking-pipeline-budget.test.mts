import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest';
import { __resetKeyPrefixCacheForTests } from '../server/_shared/redis';

const originalFetch = globalThis.fetch;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const originalVercelEnv = process.env.VERCEL_ENV;
const originalLocalApiMode = process.env.LOCAL_API_MODE;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRedisUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
  if (originalRedisToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
  if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = originalVercelEnv;
  if (originalLocalApiMode === undefined) delete process.env.LOCAL_API_MODE;
  else process.env.LOCAL_API_MODE = originalLocalApiMode;
  __resetKeyPrefixCacheForTests();
});

function item(index: number) {
  return {
    source: `Farm ${index}`,
    originPublisher: '',
    originPublisherTrusted: false,
    title: `Story headline ${index}`,
    link: `https://example.test/story/${index}`,
    publishedAt: 1_750_000_000_000 + index,
    isAlert: false,
    level: 'medium' as const,
    category: 'general',
    confidence: 0.9,
    classSource: 'keyword' as const,
    importanceScore: 42,
    credibilityScore: 50,
    corroborationCount: 1,
    entityCorroborationCount: 0,
    lang: 'en',
    description: '',
    isOpinion: false,
    isFeelGood: false,
    isEphemeralLiveCoverage: false,
  };
}

describe('news story tracking pipeline command budget', () => {
  it('splits large alias clusters so every Redis pipeline has at most 1000 commands', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    process.env.VERCEL_ENV = 'preview';
    delete process.env.LOCAL_API_MODE;

    const pipelineLengths: number[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (!url.endsWith('/pipeline')) throw new Error(`unexpected Redis endpoint: ${url}`);
      const commands = JSON.parse(String(init?.body)) as unknown[];
      pipelineLengths.push(commands.length);
      return new Response(JSON.stringify(commands.map(() => ({ result: 'OK' }))), { status: 200 });
    }) as typeof fetch;

    const items = Array.from({ length: 80 }, (_, index) => item(index));
    const hashes = items.map((_, index) => `canonical-${index}`);
    const aliases = new Map<string, Set<string>>(
      hashes.map((hash) => [
        hash,
        new Set(Array.from({ length: 5 }, (_, aliasIndex) => `${hash}-member-${aliasIndex}`)),
      ]),
    );

    await __testing__.writeStoryTracking(items, 'tech', 'en', hashes, aliases);

    assert.ok(pipelineLengths.length >= 2, 'a deliberately oversized batch must be split');
    assert.ok(
      pipelineLengths.every((length) => length <= __testing__.MAX_REDIS_PIPELINE_COMMANDS),
      `pipeline lengths ${pipelineLengths.join(', ')} exceed the hard command limit`,
    );
    assert.equal(
      Math.max(...pipelineLengths),
      __testing__.MAX_REDIS_PIPELINE_COMMANDS,
      'the split should fill the first chunk to the declared hard limit',
    );
  });
});
