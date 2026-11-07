// The deduction cache key hashes the query and the geo context together. Joined
// with a bare `|`, ("a|b", "") and ("a", "b|") hashed the same text, so two
// different prompts shared one cached answer for an hour.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { deductSituation } from '../server/worldmonitor/intelligence/v1/deduct-situation.ts';
import { __testing__ as llmHealth } from '../server/_shared/llm-health.ts';

const originalFetch = globalThis.fetch;
const REDIS_URL = 'https://redis.test';
const ENV_KEYS = [
  'OPENROUTER_API_KEY', 'LLM_REASONING_PROVIDER', 'LLM_REASONING_MODEL', 'OLLAMA_API_URL',
  'LLM_API_URL', 'LLM_API_KEY', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'VERCEL_ENV',
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

describe('deduct-situation cache key', () => {
  const deductKeys = new Set<string>();

  beforeEach(() => {
    deductKeys.clear();
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.OPENROUTER_API_KEY = 'or-test-key';
    process.env.LLM_REASONING_PROVIDER = 'openrouter';
    process.env.LLM_REASONING_MODEL = 'deepseek/deepseek-v4-flash';
    process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.origin === REDIS_URL) {
        const text = decodeURIComponent(url.pathname) + (typeof init?.body === 'string' ? init.body : '');
        for (const match of text.matchAll(/deduct:situation:[^"/,\]\s]+/g)) deductKeys.add(match[0]);
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        const result = Array.isArray(body) && Array.isArray(body[0]) ? body.map(() => ({ result: null })) : { result: null };
        return Response.json(result);
      }
      if (url.origin !== 'https://openrouter.ai') throw new Error(`unexpected fetch ${url}`);
      if (init?.method !== 'POST') return new Response('ok', { status: 200 });
      return new Response(JSON.stringify({
        choices: [{ message: { content: '**Bottom line**\n- answer' }, finish_reason: 'stop' }],
        usage: { total_tokens: 700, prompt_tokens: 640, completion_tokens: 60 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    llmHealth.reset();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  const deduct = (query: string, geoContext: string) => deductSituation(
    { request: new Request('https://api.worldmonitor.app/api/intelligence/v1/deduct-situation', { method: 'POST' }) } as never,
    { query, geoContext, framework: '' },
  );

  it('gives two prompts that differ only in where a "|" falls their own entries', async () => {
    await deduct('Hormuz closure|crude', '');
    assert.equal(deductKeys.size, 1, 'the first call reads its cache entry');
    await deduct('Hormuz closure', 'crude|');
    assert.equal(deductKeys.size, 2, `expected two cache keys, got ${[...deductKeys].join(', ')}`);
  });
});
