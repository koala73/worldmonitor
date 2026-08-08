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

  // Budget stop twin of seed-insights. After the #6110 equality fix (`>=`),
  // two equal 6s sleeps against 12s usable no longer exhaust the clock — the
  // second is fail-fast. Drive the stop via withRetry wait overshoot:
  //   usable 12s, hint 3s, retryDelayMs 8s → waits 8s then 16s → usable <= 0.
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
          return { ok: false, status: 429, headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? '3' : null) } };
        },
      });

      const result = await callLlmDefault(PROMPT, { retryDelayMs: 8_000, callBudgetMs: 17_000 });

      assert.equal(result, null);
      assert.equal(calls, 2);
      assert.deepEqual(waits, [8000, 16000], 'backoff overshoots remaining after the first under-budget sleep');
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

// #6110: narrative shares seed-insights' provider-waterfall shape and was
// migrated to `remainingBudgetMs` in the same change, so it needs the same
// proof. Review caught that the migration originally shipped here with zero
// coverage — only the seed-insights twin was tested.
describe('narrative callLlmDefault does not sleep on an unreachable Retry-After (#6110)', () => {
  it('fails a provider over immediately when its hint outruns the run budget', async () => {
    process.env.GROQ_API_KEY = 'groq-test-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    const originalSetTimeout = globalThis.setTimeout;
    const waits = [];
    const providers = [];
    globalThis.setTimeout = (fn, ms, ...args) => { waits.push(ms); fn(...args); return 0; };

    try {
      __setNarrativeTransportForTests({
        fetch: async (url) => {
          const href = String(url);
          providers.push(href.includes('api.groq.com') ? 'groq' : 'openrouter');
          if (href.includes('openrouter.ai')) {
            // The groq daily-quota shape: ~20 minutes out.
            return { ok: false, status: 429, headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? '1213' : null) } };
          }
          return okResponse('llama-3.3-70b-versatile', '{"situation":"ok"}');
        },
      });

      const result = await callLlmDefault(PROMPT, { retryDelayMs: 0 });

      assert.deepEqual(waits, [], 'a hint 20 minutes out must not be slept on at all');
      assert.deepEqual(providers, ['openrouter', 'groq'], 'the budget saved must be spent on the next provider');
      assert.equal(result?.provider, 'groq');
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it('fails over with no sleep when the hint exactly equals usable budget', async () => {
    // callBudgetMs 7000 − 5s guard = 2000ms usable. Equality must fail-fast so
    // the next provider still gets a real attempt (same composition as insights).
    process.env.GROQ_API_KEY = 'groq-test-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    const originalSetTimeout = globalThis.setTimeout;
    const originalDateNow = Date.now;
    const waits = [];
    const providers = [];
    const frozen = 1_700_000_000_000;
    Date.now = () => frozen;
    globalThis.setTimeout = (fn, ms, ...args) => { waits.push(ms); fn(...args); return 0; };

    try {
      __setNarrativeTransportForTests({
        fetch: async (url) => {
          const href = String(url);
          providers.push(href.includes('api.groq.com') ? 'groq' : 'openrouter');
          if (href.includes('openrouter.ai')) {
            return { ok: false, status: 429, headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? '2' : null) } };
          }
          return okResponse('llama-3.3-70b-versatile', '{"situation":"ok"}');
        },
      });

      const result = await callLlmDefault(PROMPT, { retryDelayMs: 0, callBudgetMs: 7_000 });

      assert.deepEqual(waits, [], 'equality must fail-fast, not sleep the full remainder');
      assert.deepEqual(providers, ['openrouter', 'groq'], 'saved budget must reach the next provider');
      assert.equal(result?.provider, 'groq');
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      Date.now = originalDateNow;
    }
  });
});
