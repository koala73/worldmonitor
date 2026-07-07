import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { callLLM, __setInsightsLlmTransportForTests } from '../scripts/seed-insights.mjs';

const LONG_BRIEF = 'Insights brief succeeded with more than enough narrative content to pass.';

const originalEnv = {
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OLLAMA_API_URL: process.env.OLLAMA_API_URL,
};

afterEach(() => {
  __setInsightsLlmTransportForTests(null);
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function okResponse(content) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ model: 'deepseek/deepseek-v4-flash', choices: [{ message: { content } }] }),
  };
}

describe('seed-insights callLLM retry/budget', () => {
  it('honors a 429 Retry-After on the same provider before falling through', async () => {
    process.env.GROQ_API_KEY = 'groq-test-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    delete process.env.OLLAMA_API_URL;
    const originalSetTimeout = globalThis.setTimeout;
    const waits = [];
    const calls = [];
    globalThis.setTimeout = (fn, ms, ...args) => { waits.push(ms); fn(...args); return 0; };

    try {
      __setInsightsLlmTransportForTests({
        fetch: async (url) => {
          calls.push(String(url));
          if (calls.length <= 2) {
            return { ok: false, status: 429, headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? '2' : null) } };
          }
          return okResponse(LONG_BRIEF);
        },
      });

      const result = await callLLM('Some breaking headline', { retryDelayMs: 0 });

      assert.deepEqual(waits, [2000, 2000]);
      assert.equal(calls.length, 3);
      assert.ok(calls.every((u) => u.includes('openrouter.ai')));
      assert.equal(result?.provider, 'openrouter');
      assert.equal(result?.text, LONG_BRIEF);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('caps an oversized Retry-After hint before retrying', async () => {
    process.env.GROQ_API_KEY = 'groq-test-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    delete process.env.OLLAMA_API_URL;
    const originalSetTimeout = globalThis.setTimeout;
    const waits = [];
    let calls = 0;
    globalThis.setTimeout = (fn, ms, ...args) => { waits.push(ms); fn(...args); return 0; };

    try {
      __setInsightsLlmTransportForTests({
        fetch: async () => {
          calls += 1;
          if (calls === 1) return { ok: false, status: 429, headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? '30' : null) } };
          return okResponse(LONG_BRIEF);
        },
      });

      const result = await callLLM('Some breaking headline', { retryDelayMs: 0 });

      assert.deepEqual(waits, [10000]);
      assert.equal(calls, 2);
      assert.equal(result?.provider, 'openrouter');
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('stops at the call budget without falling through to the next provider', async () => {
    process.env.GROQ_API_KEY = 'groq-test-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    delete process.env.OLLAMA_API_URL;
    const originalDateNow = Date.now;
    const originalSetTimeout = globalThis.setTimeout;
    const waits = [];
    let now = 1_000;
    let calls = 0;
    Date.now = () => now;
    globalThis.setTimeout = (fn, ms, ...args) => { waits.push(ms); now += ms; fn(...args); return 0; };

    try {
      __setInsightsLlmTransportForTests({
        fetch: async (url) => {
          calls += 1;
          assert.ok(String(url).includes('openrouter.ai'), 'budget stop must not fall through to groq');
          return { ok: false, status: 429, headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? '30' : null) } };
        },
      });

      const result = await callLLM('Some breaking headline', { retryDelayMs: 0, callBudgetMs: 17_000 });

      assert.equal(result, null);
      assert.equal(calls, 2);
      assert.deepEqual(waits, [10000, 2000]);
    } finally {
      Date.now = originalDateNow;
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('falls through to the next provider after a non-retryable 402', async () => {
    process.env.GROQ_API_KEY = 'groq-test-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    delete process.env.OLLAMA_API_URL;
    const providers = [];

    __setInsightsLlmTransportForTests({
      fetch: async (url) => {
        const href = String(url);
        providers.push(href.includes('api.groq.com') ? 'groq' : 'openrouter');
        if (href.includes('openrouter.ai')) return { ok: false, status: 402, headers: { get: () => null } };
        return okResponse(LONG_BRIEF);
      },
    });

    const result = await callLLM('Some breaking headline', { retryDelayMs: 0 });

    assert.deepEqual(providers, ['openrouter', 'groq']);
    assert.equal(result?.provider, 'groq');
  });
});
