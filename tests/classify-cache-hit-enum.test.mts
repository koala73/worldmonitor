// A classify cache hit is validated like a fresh LLM answer. The row is
// Redis-backed JSON under a token shared by every seeder and the relay, and
// `category` is rendered as a NewsPanel badge, so an out-of-enum hit must
// never be returned as a classification.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { classifyEvent } from '../server/worldmonitor/intelligence/v1/classify-event.ts';
import {
  CLASSIFY_VALID_CATEGORIES,
  CLASSIFY_VALID_LEVELS,
  isValidClassifyHit,
} from '../server/worldmonitor/intelligence/v1/_shared.ts';
import { __testing__ as llmHealth } from '../server/_shared/llm-health.ts';

const ENV_KEYS = [
  'OPENROUTER_API_KEY', 'OLLAMA_API_URL', 'LLM_API_URL', 'LLM_API_KEY', 'LLM_MODEL',
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'LOCAL_API_MODE',
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const originalFetch = globalThis.fetch;

function stubCacheHit(row: unknown) {
  const llmCalls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/chat/completions')) {
      llmCalls.push(url);
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"level":"low","category":"general"}' }, finish_reason: 'stop' }],
        usage: { total_tokens: 12 },
      }), { status: 200 });
    }
    if (url.includes('/get/')) return new Response(JSON.stringify({ result: JSON.stringify(row) }), { status: 200 });
    return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
  }) as typeof fetch;
  return llmCalls;
}

const ctx = () => ({ request: new Request('https://worldmonitor.app/api/intelligence/v1/classify-event'), pathParams: {}, headers: {} }) as never;
const input = { title: 'Port authority reports vessel grounding', description: '', source: '', country: '' };

describe('classify_event validates a cache hit against the enum', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.OPENROUTER_API_KEY = 'or-test-key';
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    llmHealth.reset();
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it('serves a valid hit without calling the model', async () => {
    const llmCalls = stubCacheHit({ level: 'high', category: 'conflict', timestamp: Date.now() });
    const res = await classifyEvent(ctx(), input);
    assert.equal(res.classification?.category, 'conflict');
    assert.equal(res.classification?.subcategory, 'high');
    assert.equal(llmCalls.length, 0);
  });

  it('returns no classification for an out-of-enum category and never renders it', async () => {
    const llmCalls = stubCacheHit({ level: 'high', category: '<img src=x onerror=alert(1)>', timestamp: Date.now() });
    const res = await classifyEvent(ctx(), input);
    assert.equal(res.classification, undefined);
    assert.equal(llmCalls.length, 0, 'a poisoned hit is dropped, not refetched through the LLM');
  });

  it('returns no classification for an out-of-enum level', async () => {
    stubCacheHit({ level: 'apocalyptic', category: 'conflict', timestamp: Date.now() });
    const res = await classifyEvent(ctx(), input);
    assert.equal(res.classification, undefined);
  });
});

describe('isValidClassifyHit', () => {
  it('accepts every level and category pair the writers emit', () => {
    for (const level of CLASSIFY_VALID_LEVELS) {
      for (const category of CLASSIFY_VALID_CATEGORIES) {
        assert.equal(isValidClassifyHit({ level, category }), true);
      }
    }
  });

  it('rejects anything outside the lists, including case and whitespace variants', () => {
    for (const hit of [
      { level: 'High', category: 'conflict' },
      { level: 'high', category: 'Conflict' },
      { level: 'high', category: ' conflict' },
      { level: '', category: 'conflict' },
      { level: 'high', category: '' },
      { level: '_skip', category: 'conflict' },
      { level: 'high', category: '<b>conflict</b>' },
    ]) {
      assert.equal(isValidClassifyHit(hit), false, JSON.stringify(hit));
    }
  });
});
