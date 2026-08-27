import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest';
import { __resetKeyPrefixCacheForTests } from '../server/_shared/redis';

const originalFetch = globalThis.fetch;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const originalLocalApiMode = process.env.LOCAL_API_MODE;
const originalVercelEnv = process.env.VERCEL_ENV;
const originalVercelCommitSha = process.env.VERCEL_GIT_COMMIT_SHA;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRedisUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
  if (originalRedisToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
  if (originalLocalApiMode === undefined) delete process.env.LOCAL_API_MODE;
  else process.env.LOCAL_API_MODE = originalLocalApiMode;
  if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = originalVercelEnv;
  if (originalVercelCommitSha === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
  else process.env.VERCEL_GIT_COMMIT_SHA = originalVercelCommitSha;
  __resetKeyPrefixCacheForTests();
});

function enableRedis(): void {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  process.env.VERCEL_ENV = 'production';
  delete process.env.VERCEL_GIT_COMMIT_SHA;
  delete process.env.LOCAL_API_MODE;
}

function redisResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

describe('news digest adoption-state reader', () => {
  it('uses one atomic transaction for alias and track reads', async () => {
    enableRedis();
    let requestUrl = '';
    let requestCommands: unknown;
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      requestCommands = JSON.parse(String(init?.body));
      return redisResponse([
        { result: 'canonical-hash' },
        { result: ['1000', '2000', '1'] },
      ]);
    }) as typeof fetch;

    const state = await __testing__.readAdoptionState(['member-hash'], 0, Date.now() + 6_000);

    assert.equal(requestUrl, 'https://redis.test/multi-exec');
    assert.deepEqual(requestCommands, [
      ['GET', 'story:alias:v1:member-hash'],
      ['HMGET', 'story:track:v1:member-hash', 'firstSeen', 'lastSeen', 'anchorEligible'],
    ]);
    assert.equal(state.aliasTargetByHash.get('member-hash'), 'canonical-hash');
    assert.equal(state.trackFirstSeenByHash.get('member-hash'), 1000);
    assert.equal(state.incompleteHashes.size, 0);
  });

  it('rejects truncated and per-command-error responses before applying either map', async () => {
    enableRedis();
    const responses = [
      [{ result: 'must-not-apply' }],
      [{ result: 'must-not-apply' }, { error: 'WRONGTYPE' }],
    ];
    globalThis.fetch = (async () => redisResponse(responses.shift())) as typeof fetch;

    for (const expectedHashes of [['h1'], ['h1', 'h2']]) {
      const state = await __testing__.readAdoptionState(expectedHashes, 0, Date.now() + 6_000);
      assert.equal(state.aliasTargetByHash.size, 0);
      assert.equal(state.trackFirstSeenByHash.size, 0);
      assert.deepEqual([...state.incompleteHashes], expectedHashes);
    }
  });

  it('rejects null, empty, and malformed timestamps before numeric conversion', async () => {
    enableRedis();
    globalThis.fetch = (async () => redisResponse([
      { result: 'alias-1' },
      { result: 'alias-2' },
      { result: 'alias-3' },
      { result: 'alias-4' },
      { result: ['1000', null, '1'] },
      { result: [null, '2000', '1'] },
      { result: ['', '2000', '1'] },
      { result: ['not-a-time', '2000', '1'] },
    ])) as typeof fetch;

    const state = await __testing__.readAdoptionState(
      ['h1', 'h2', 'h3', 'h4'],
      0,
      Date.now() + 6_000,
    );

    assert.equal(state.aliasTargetByHash.size, 4);
    assert.equal(state.trackFirstSeenByHash.size, 0);
    assert.equal(state.incompleteHashes.size, 0);
  });

  it('fails closed for legacy/ineligible tracks instead of trusting an old firstSeen', async () => {
    enableRedis();
    globalThis.fetch = (async () => redisResponse([
      { result: 'hostile-member' },
      { result: 'legacy-member' },
      { result: 'trusted-member' },
      { result: ['1000', '2000', '0'] },
      { result: ['900', '2000', null] },
      { result: ['3000', '4000', '1'] },
    ])) as typeof fetch;

    const state = await __testing__.readAdoptionState(
      ['hostile-member', 'legacy-member', 'trusted-member'],
      0,
      Date.now() + 6_000,
    );

    // A self-alias is an anchor claim. Explicitly ineligible and missing
    // legacy metadata must not make it eligible, even with a valid old
    // firstSeen.
    assert.equal(state.aliasTargetByHash.has('hostile-member'), false);
    assert.equal(state.trackFirstSeenByHash.has('hostile-member'), false);
    assert.equal(state.aliasTargetByHash.has('legacy-member'), false);
    assert.equal(state.trackFirstSeenByHash.has('legacy-member'), false);
    assert.equal(state.aliasTargetByHash.get('trusted-member'), 'trusted-member');
    assert.equal(state.trackFirstSeenByHash.get('trusted-member'), 3000);
  });

  it('chunks at 400 hashes and skips further work after the deadline', async () => {
    enableRedis();
    const calls: number[] = [];
    globalThis.fetch = (async (_input, init) => {
      const commands = JSON.parse(String(init?.body)) as unknown[];
      calls.push(commands.length);
      return redisResponse(commands.map((command) => {
        const [verb] = command as string[];
        return { result: verb === 'HMGET' ? [null, null, null] : null };
      }));
    }) as typeof fetch;

    const hashes = Array.from({ length: 401 }, (_, i) => `h${i}`);
    const state = await __testing__.readAdoptionState(hashes, 0, Date.now() + 6_000);

    assert.deepEqual(calls, [800, 2]);
    assert.equal(state.incompleteHashes.size, 0);

    const deadlineCalls: number[] = [];
    globalThis.fetch = (async (_input, init) => {
      deadlineCalls.push(JSON.parse(String(init?.body)).length);
      return redisResponse([]);
    }) as typeof fetch;
    const skipped = await __testing__.readAdoptionState(['late'], 0, Date.now() - 1);
    assert.deepEqual(deadlineCalls, []);
    assert.deepEqual([...skipped.incompleteHashes], ['late']);
  });
});
