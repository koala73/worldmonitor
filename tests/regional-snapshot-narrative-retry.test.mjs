import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { callLlmDefault, __setNarrativeTransportForTests } from '../scripts/regional-snapshot/narrative.mjs';

const PROMPT = { systemPrompt: 'system', userPrompt: 'user' };

const originalEnv = {
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
};

afterEach(() => {
  __setNarrativeTransportForTests(null);
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function okResponse(model, content) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ model, choices: [{ message: { content } }] }),
  };
}

describe('narrative callLlmDefault retry/budget', () => {
  it('honors a 429 Retry-After on the same provider before falling through', async () => {
    process.env.GROQ_API_KEY = 'groq-test-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    const originalSetTimeout = globalThis.setTimeout;
    const waits = [];
    const calls = [];
    globalThis.setTimeout = (fn, ms, ...args) => { waits.push(ms); fn(...args); return 0; };

    try {
      __setNarrativeTransportForTests({
        fetch: async (url) => {
          calls.push(String(url));
          if (calls.length <= 2) {
            return { ok: false, status: 429, headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? '2' : null) } };
          }
          return okResponse('deepseek/deepseek-v4-flash', '{"situation":"ok"}');
        },
      });

      const result = await callLlmDefault(PROMPT, { retryDelayMs: 0 });

      assert.deepEqual(waits, [2000, 2000]);
      assert.equal(calls.length, 3);
      assert.ok(calls.every((u) => u.includes('openrouter.ai')));
      assert.equal(result?.provider, 'openrouter');
      assert.equal(result?.model, 'deepseek/deepseek-v4-flash');
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('caps an oversized Retry-After hint before retrying', async () => {
    process.env.GROQ_API_KEY = 'groq-test-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    const originalSetTimeout = globalThis.setTimeout;
    const waits = [];
    let calls = 0;
    globalThis.setTimeout = (fn, ms, ...args) => { waits.push(ms); fn(...args); return 0; };

    try {
      __setNarrativeTransportForTests({
        fetch: async () => {
          calls += 1;
          if (calls === 1) return { ok: false, status: 503, headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? '30' : null) } };
          return okResponse('deepseek/deepseek-v4-flash', '{"situation":"ok"}');
        },
      });

      const result = await callLlmDefault(PROMPT, { retryDelayMs: 0 });

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
    const originalDateNow = Date.now;
    const originalSetTimeout = globalThis.setTimeout;
    const waits = [];
    let now = 1_000;
    let calls = 0;
    Date.now = () => now;
    globalThis.setTimeout = (fn, ms, ...args) => { waits.push(ms); now += ms; fn(...args); return 0; };

    try {
      __setNarrativeTransportForTests({
        fetch: async (url) => {
          calls += 1;
          assert.ok(String(url).includes('openrouter.ai'), 'budget stop must not fall through to groq');
          return { ok: false, status: 429, headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? '30' : null) } };
        },
      });

      const result = await callLlmDefault(PROMPT, { retryDelayMs: 0, callBudgetMs: 17_000 });

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
    const providers = [];

    __setNarrativeTransportForTests({
      fetch: async (url) => {
        const href = String(url);
        providers.push(href.includes('api.groq.com') ? 'groq' : 'openrouter');
        if (href.includes('openrouter.ai')) return { ok: false, status: 402, headers: { get: () => null } };
        return okResponse('llama-3.3-70b-versatile', '{"situation":"ok"}');
      },
    });

    const result = await callLlmDefault(PROMPT, { retryDelayMs: 0 });

    assert.deepEqual(providers, ['openrouter', 'groq']);
    assert.equal(result?.provider, 'groq');
  });
});
