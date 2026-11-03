import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { defaultRedisEval } from '../scripts/lib/_upstash-pipeline.mjs';

const originalFetch = globalThis.fetch;
const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
  if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
});

describe('defaultRedisEval', () => {
  it('sends one EVAL through the pinned pipeline transport', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    let request;
    globalThis.fetch = async (url, init) => {
      request = { url, init };
      return Response.json([{ result: [1, 9, 90, 0] }]);
    };

    const result = await defaultRedisEval('return {1}', ['day', 'month'], [10, 0]);
    assert.deepEqual(result, [1, 9, 90, 0]);
    assert.equal(request.url, 'https://redis.example/pipeline');
    assert.deepEqual(JSON.parse(request.init.body), [
      ['EVAL', 'return {1}', '2', 'day', 'month', '10', '0'],
    ]);
  });

  it('fails closed when Redis reports a script error', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    globalThis.fetch = async () => Response.json([{ error: 'script rejected' }]);
    assert.equal(await defaultRedisEval('return 1', [], []), null);
  });

  it('fails closed for malformed, missing, or ambiguous pipeline replies', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    for (const body of [[], [{ result: 1 }, { result: 2 }], [{}], { result: 1 }]) {
      globalThis.fetch = async () => Response.json(body);
      assert.equal(await defaultRedisEval('return 1', [], []), null);
    }
  });

  it('fails closed for invalid JSON, non-OK responses, and transport errors', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    globalThis.fetch = async () => new Response('{', { status: 200 });
    assert.equal(await defaultRedisEval('return 1', [], []), null);
    globalThis.fetch = async () => new Response('unavailable', { status: 503 });
    assert.equal(await defaultRedisEval('return 1', [], []), null);
    globalThis.fetch = async () => { throw new Error('socket reset'); };
    assert.equal(await defaultRedisEval('return 1', [], []), null);
  });
});
