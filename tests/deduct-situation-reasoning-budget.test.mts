// analyze_situation returned `provider: 'error'` on every call (2026-10-16).
// Production llm_call telemetry: deepseek-v4-flash answered HTTP 200 with
// finish_reason "length", completion_tokens == max_tokens (1500) and empty
// content — the reasoning trace consumed the whole budget — and the free
// fallback was rate-limited. This stub replays that provider behaviour: a
// reasoning-enabled request burns the budget, a reasoning-disabled one answers.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { deductSituation } from '../server/worldmonitor/intelligence/v1/deduct-situation.ts';
import { __testing__ as llmHealth } from '../server/_shared/llm-health.ts';

const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;
const originalAbortSignalTimeout = AbortSignal.timeout;
const ENV_KEYS = [
  'OPENROUTER_API_KEY', 'LLM_REASONING_PROVIDER', 'LLM_REASONING_MODEL', 'OLLAMA_API_URL',
  'LLM_API_URL', 'LLM_API_KEY', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const ANSWER = '**Bottom line**\n- Tanker traffic cuts tighten Asian crude supply.';

type ChatBody = { model: string; reasoning?: { enabled?: boolean }; max_tokens: number };

function chatResponse(content: string, finishReason: string, completionTokens: number): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage: { total_tokens: completionTokens + 640, prompt_tokens: 640, completion_tokens: completionTokens },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('deduct-situation LLM call', () => {
  const requests: ChatBody[] = [];

  beforeEach(() => {
    requests.length = 0;
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.OPENROUTER_API_KEY = 'or-test-key';
    process.env.LLM_REASONING_PROVIDER = 'openrouter';
    process.env.LLM_REASONING_MODEL = 'deepseek/deepseek-v4-flash';

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (new URL(url).origin !== 'https://openrouter.ai') {
        throw new Error(`unexpected fetch ${url}`);
      }
      if (init?.method !== 'POST') return new Response('ok', { status: 200 });
      const body = JSON.parse(String(init.body)) as ChatBody;
      requests.push(body);
      if (body.model.endsWith(':free')) {
        return new Response('{"error":{"code":429,"message":"rate-limited upstream"}}', { status: 429 });
      }
      if (body.reasoning?.enabled === false) return chatResponse(ANSWER, 'stop', 420);
      return chatResponse('', 'length', body.max_tokens);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Date.now = originalDateNow;
    AbortSignal.timeout = originalAbortSignalTimeout;
    llmHealth.reset();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('returns an analysis when the reasoning model would spend the whole budget on hidden reasoning', async () => {
    const res = await deductSituation(
      { request: new Request('https://api.worldmonitor.app/api/intelligence/v1/deduct-situation', { method: 'POST' }) } as never,
      { query: `Implications of reduced tanker traffic through Hormuz ${Date.now()}`, geoContext: '', framework: '' },
    );

    assert.equal(res.provider, 'openrouter', `expected the paid provider to answer, got ${JSON.stringify(res)}`);
    assert.match(res.analysis, /Bottom line/);
    assert.equal(requests[0]?.reasoning?.enabled, false, 'the first attempt must disable hidden reasoning');
  });

  for (const fallbackSucceeds of [true, false]) {
    it(`uses the remaining deadline after a primary timeout when the fallback ${fallbackSucceeds ? 'answers' : 'also times out'}`, async () => {
      let now = 1_000;
      Date.now = () => now;
      const timeouts = new Map<AbortSignal, number>();
      AbortSignal.timeout = ((delay: number) => {
        const signal = new AbortController().signal;
        timeouts.set(signal, delay);
        return signal;
      }) as typeof AbortSignal.timeout;
      const attempts: Array<{ model: string; timeout: number }> = [];
      globalThis.fetch = (async (_input, init) => {
        if (init?.method !== 'POST') return new Response('ok');
        const body = JSON.parse(String(init.body)) as ChatBody;
        const timeout = timeouts.get(init.signal as AbortSignal)!;
        attempts.push({ model: body.model, timeout });
        if (body.model.endsWith(':free') && fallbackSucceeds) {
          return chatResponse(ANSWER, 'stop', 420);
        }
        now += timeout;
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }) as typeof fetch;

      const result = await deductSituation(
        { request: new Request('https://api.worldmonitor.app/api/intelligence/v1/deduct-situation', { method: 'POST' }) } as never,
        { query: `Hormuz timeout recovery ${fallbackSucceeds}`, geoContext: '', framework: '' },
      );

      assert.deepEqual(attempts, [
        { model: 'deepseek/deepseek-v4-flash', timeout: 15_000 },
        { model: 'google/gemma-4-26b-a4b-it:free', timeout: 7_000 },
      ]);
      assert.equal(result.provider, fallbackSucceeds ? 'openrouter-free' : 'error');
      assert.equal(result.analysis, fallbackSucceeds ? ANSWER : '');
      assert.ok(now - 1_000 <= 22_000, 'fallback must fit inside the original deadline');
    });
  }
});
