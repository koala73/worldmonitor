import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest';
import { __resetKeyPrefixCacheForTests } from '../server/_shared/redis';

const originalFetch = globalThis.fetch;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const originalVercelEnv = process.env.VERCEL_ENV;
const originalLocalApiMode = process.env.LOCAL_API_MODE;
const originalDateNow = Date.now;

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
  Date.now = originalDateNow;
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
  function enableRedis(): void {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    process.env.VERCEL_ENV = 'preview';
    delete process.env.LOCAL_API_MODE;
  }

  function okResponse(commands: Array<Array<string | number>>): Response {
    return new Response(JSON.stringify(commands.map(([verb]) => ({ result: verb === 'EVAL' ? 1 : 'OK' }))), { status: 200 });
  }

  it('commits each complete alias group through a fenced atomic script and keeps base pipelines within the command budget', async () => {
    enableRedis();

    const requests: Array<{ url: string; commands: Array<Array<string | number>> }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (!url.endsWith('/pipeline') && !url.endsWith('/multi-exec')) {
        throw new Error(`unexpected Redis endpoint: ${url}`);
      }
      const commands = JSON.parse(String(init?.body)) as Array<Array<string | number>>;
      requests.push({ url, commands });
      return okResponse(commands);
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

    const pipelines = requests.filter(({ url }) => url.endsWith('/pipeline'));
    const allCommands = pipelines.flatMap(({ commands }) => commands);
    const aliasScripts = allCommands.filter(([verb]) => verb === 'EVAL');
    const aliasLocks = allCommands.filter(([verb, key]) =>
      verb === 'SET' && String(key).includes('story:alias:publish-lock:v1'));
    const aliasPipelineRequests = pipelines.filter(({ commands }) =>
      commands.some(([verb]) => verb === 'EVAL'));
    assert.ok(
      pipelines.every(({ commands }) => commands.length <= __testing__.MAX_REDIS_PIPELINE_COMMANDS),
      'base tracking pipelines must stay within the hard Redis command limit',
    );
    assert.equal(
      allCommands.filter(([verb, key]) =>
        verb === 'SET' && String(key).includes('story:alias:v1:')).length,
      0,
      'continuity aliases must not be mixed into arbitrary base pipeline chunks',
    );
    assert.equal(aliasLocks.length, 1, 'one fenced lease covers the complete alias publication');
    assert.equal(aliasScripts.length, hashes.length, 'each canonical group gets one atomic alias script');
    assert.equal(aliasPipelineRequests.length, 1, 'independent alias groups share one Redis round-trip');
    assert.equal(aliasPipelineRequests[0]?.commands.length, hashes.length);
    assert.ok(
      aliasScripts.every((command) => {
        const keyCount = Number(command[2]);
        const aliasKeys = command.slice(4, 3 + keyCount);
        return keyCount === 6
          && String(command[3]).includes('story:alias:publish-lock:v1')
          && aliasKeys.length === 5
          && aliasKeys.every((key) => String(key).includes('story:alias:v1:'));
      }),
      'every complete alias group must use one fenced atomic script',
    );
  });

  it('defers an oversized alias group instead of exposing a partial generation', async () => {
    enableRedis();
    const requests: Array<{ url: string; commands: Array<Array<string | number>> }> = [];
    globalThis.fetch = (async (input, init) => {
      const commands = JSON.parse(String(init?.body)) as Array<Array<string | number>>;
      requests.push({ url: String(input), commands });
      return okResponse(commands);
    }) as typeof fetch;

    const items = [item(0)];
    const hashes = ['canonical'];
    const aliases = new Map<string, Set<string>>([[
      'canonical',
      new Set(Array.from(
        { length: __testing__.MAX_REDIS_PIPELINE_COMMANDS + 1 },
        (_, index) => `member-${index}`,
      )),
    ]]);

    await __testing__.writeStoryTracking(items, 'tech', 'en', hashes, aliases);

    assert.equal(
      requests.flatMap(({ commands }) => commands).filter(([verb]) => verb === 'EVAL').length,
      0,
      'a group too large for one script must not be split into visible aliases',
    );
    assert.equal(
      requests.flatMap(({ commands }) => commands).filter(([verb, key]) =>
        verb === 'SET' && String(key).includes('story:alias:v1:')).length,
      0,
    );
  });

  it('stops before the next tracking batch when the absolute deadline is spent', async () => {
    enableRedis();
    let now = 10_000;
    const deadlineAt = now + 20;
    Date.now = () => now;
    const requests: Array<{ url: string; commands: Array<Array<string | number>> }> = [];
    let trackingPipelineCount = 0;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const commands = JSON.parse(String(init?.body)) as Array<Array<string | number>>;
      requests.push({ url, commands });
      if (url.endsWith('/pipeline') && commands.some(([verb]) => verb === 'HINCRBY')) {
        trackingPipelineCount += 1;
        if (trackingPipelineCount === 1) now = deadlineAt;
      }
      return okResponse(commands);
    }) as typeof fetch;

    const items = Array.from({ length: 160 }, (_, index) => item(index));
    const hashes = items.map((_, index) => `canonical-${index}`);

    await __testing__.writeStoryTracking(items, 'tech', 'en', hashes, undefined, deadlineAt);

    assert.equal(trackingPipelineCount, 1, 'the expired deadline must stop the second serial batch');
    assert.equal(
      requests.flatMap(({ commands }) => commands).filter(([verb]) => verb === 'EVAL').length,
      0,
      'unconfirmed base tracking must not publish aliases',
    );
  });

  it('keeps a canonical eligible when its display representative is low tier', async () => {
    enableRedis();
    const requests: Array<{ url: string; commands: Array<Array<string | number>> }> = [];
    globalThis.fetch = (async (input, init) => {
      const commands = JSON.parse(String(init?.body)) as Array<Array<string | number>>;
      requests.push({ url: String(input), commands });
      return okResponse(commands);
    }) as typeof fetch;

    const lowTierRepresentative = { ...item(0), source: 'Farm A', importanceScore: 99 };
    const trustedMember = { ...item(1), source: 'Reuters', importanceScore: 1 };
    await __testing__.writeStoryTracking(
      [lowTierRepresentative, trustedMember],
      'tech',
      'en',
      ['canonical', 'canonical'],
    );

    const anchorStamp = requests.flatMap(({ commands }) => commands).find((command) =>
      command[0] === 'HSET'
      && String(command[1]).includes('story:track:v1:canonical')
      && command[2] === 'anchorEligible',
    );
    assert.equal(anchorStamp?.[3], '1');
  });

  it('keeps full-cluster eligibility when the trusted member is outside the displayed slice', async () => {
    enableRedis();
    const requests: Array<{ url: string; commands: Array<Array<string | number>> }> = [];
    globalThis.fetch = (async (input, init) => {
      const commands = JSON.parse(String(init?.body)) as Array<Array<string | number>>;
      requests.push({ url: String(input), commands });
      return okResponse(commands);
    }) as typeof fetch;

    const displayedLowTierMember = { ...item(0), source: 'Farm A', importanceScore: 99 };
    await __testing__.writeStoryTracking(
      [displayedLowTierMember],
      'tech',
      'en',
      ['canonical'],
      undefined,
      Number.POSITIVE_INFINITY,
      new Map([['canonical', true]]),
    );

    const anchorStamp = requests.flatMap(({ commands }) => commands).find((command) =>
      command[0] === 'HSET'
      && String(command[1]).includes('story:track:v1:canonical')
      && command[2] === 'anchorEligible',
    );
    assert.equal(anchorStamp?.[3], '1');
  });
});
