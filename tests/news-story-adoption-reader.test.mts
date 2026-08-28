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
    const requests: Array<{ url: string; commands: unknown }> = [];
    const responses: unknown[] = [
      [
        { result: 'canonical-hash' },
        { result: ['1000', '2000', '1'] },
      ],
      [
        { result: ['900', '2000', '1'] },
      ],
    ];
    globalThis.fetch = (async (input, init) => {
      requests.push({
        url: String(input),
        commands: JSON.parse(String(init?.body)),
      });
      return redisResponse(responses.shift());
    }) as typeof fetch;

    const state = await __testing__.readAdoptionState(['member-hash'], 0, Date.now() + 6_000);

    assert.deepEqual(requests.map(({ url }) => url), [
      'https://redis.test/multi-exec',
      'https://redis.test/multi-exec',
    ]);
    assert.deepEqual(requests[0]?.commands, [
      ['GET', 'story:alias:v1:member-hash'],
      ['HMGET', 'story:track:v1:member-hash', 'firstSeen', 'lastSeen', 'anchorEligible'],
    ]);
    assert.deepEqual(requests[1]?.commands, [
      ['HMGET', 'story:track:v1:canonical-hash', 'firstSeen', 'lastSeen', 'anchorEligible'],
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
    const responses: unknown[] = [
      [
        { result: 'alias-1' },
        { result: 'alias-2' },
        { result: 'alias-3' },
        { result: 'alias-4' },
        { result: ['1000', null, '1'] },
        { result: [null, '2000', '1'] },
        { result: ['', '2000', '1'] },
        { result: ['not-a-time', '2000', '1'] },
      ],
      [
        { result: ['500', '2000', '1'] },
        { result: ['501', '2000', '1'] },
        { result: ['502', '2000', '1'] },
        { result: ['503', '2000', '1'] },
      ],
    ];
    globalThis.fetch = (async () => redisResponse(responses.shift())) as typeof fetch;

    const state = await __testing__.readAdoptionState(
      ['h1', 'h2', 'h3', 'h4'],
      0,
      Date.now() + 6_000,
    );

    assert.equal(state.aliasTargetByHash.size, 4);
    assert.equal(state.trackFirstSeenByHash.size, 0);
    assert.equal(state.incompleteHashes.size, 0);
  });

  it('rejects an ineligible alias target while the trusted canonical survives', async () => {
    enableRedis();
    const now = Date.now();
    const responses: unknown[] = [
      [
        { result: 'b-plus-reuters' },
        { result: 'trusted-canonical' },
        { result: ['1000', String(now), '0'] },
        { result: ['2000', String(now), '1'] },
      ],
      [
        // A hostile A+B alias cannot make an ineligible B+Reuters track a
        // canonical target. The target is readable, but must fail closed.
        { result: ['3000', String(now), '0'] },
      ],
    ];
    globalThis.fetch = (async () => redisResponse(responses.shift())) as typeof fetch;

    const state = await __testing__.readAdoptionState(
      ['a-plus-b', 'trusted-canonical'],
      now - 1_000,
      Date.now() + 6_000,
    );

    assert.equal(state.aliasTargetByHash.has('a-plus-b'), false);
    assert.equal(state.trackFirstSeenByHash.get('trusted-canonical'), 2000);
    assert.equal(state.incompleteHashes.size, 0);

    // The rejected alias cannot out-vote the independently trusted member.
    const { adoptExistingCanonical } = await import('../server/worldmonitor/news/v1/dedup.mjs');
    assert.equal(
      adoptExistingCanonical(
        ['a-plus-b', 'trusted-canonical'],
        'trusted-canonical',
        state.aliasTargetByHash,
        state.trackFirstSeenByHash,
      ),
      'trusted-canonical',
    );
  });

  it('marks source members incomplete when alias target reads are unavailable', async () => {
    enableRedis();
    const responses: unknown[] = [
      [
        { result: 'missing-target' },
        { result: ['1000', '2000', '0'] },
      ],
      [],
    ];
    globalThis.fetch = (async () => redisResponse(responses.shift())) as typeof fetch;

    const state = await __testing__.readAdoptionState(
      ['member-hash'],
      0,
      Date.now() + 6_000,
    );

    assert.equal(state.aliasTargetByHash.size, 0);
    assert.deepEqual([...state.incompleteHashes], ['member-hash']);
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

  it('rejects stale self-aliases even when their eligibility stamp is still 1', async () => {
    enableRedis();
    globalThis.fetch = (async () => redisResponse([
      { result: 'stale-member' },
      { result: ['1000', '500', '1'] },
    ])) as typeof fetch;

    const state = await __testing__.readAdoptionState(
      ['stale-member'],
      1_000,
      Date.now() + 6_000,
    );

    assert.equal(state.aliasTargetByHash.has('stale-member'), false);
    assert.equal(state.trackFirstSeenByHash.has('stale-member'), false);
    assert.equal(state.incompleteHashes.size, 0);
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

  it('uses a short positive remainder as the Redis transaction timeout', async () => {
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

    // A slow cold fetch can leave less than REDIS_PIPELINE_TIMEOUT_MS. The
    // reader must still try an otherwise-fast transaction inside the remaining
    // absolute budget instead of skipping every cluster at offset zero.
    const state = await __testing__.readAdoptionState(['near-deadline'], 0, Date.now() + 250);

    assert.deepEqual(calls, [2]);
    assert.equal(state.incompleteHashes.size, 0);
  });
});
