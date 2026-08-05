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

// #6001/#5947: the chain fell through on TRANSPORT errors only. When the
// primary model returned well-formed text that the brief composer then
// rejected on its editorial gates, seed-insights gave up and published
// degraded — never trying a fallback model that would have passed. Measured
// against a live digest: openrouter composed 2/6, groq 6/6, yet production
// only ever asked openrouter.
describe('seed-insights callLLM output acceptance (#6001)', () => {
  it('falls through to the next provider when the caller rejects the output', async () => {
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    process.env.GROQ_API_KEY = 'groq-test-key';
    delete process.env.OLLAMA_API_URL;

    const seen = [];
    __setInsightsLlmTransportForTests({
      fetch: async (url) => {
        seen.push(String(url));
        return okResponse(String(url).includes('openrouter') ? `${LONG_BRIEF} REJECT_ME` : LONG_BRIEF);
      },
    });

    const result = await callLLM(null, {
      systemPrompt: 'sys',
      userPrompt: 'user',
      accept: (text) => (text.includes('REJECT_ME') ? null : { composed: true }),
    });

    assert.ok(result, 'an accepted provider result must be returned');
    assert.equal(result.provider, 'groq');
    assert.equal(result.text, LONG_BRIEF);
    assert.equal(seen.length, 2, 'both providers must be attempted');
  });

  it('returns the last attempt when every provider is rejected, so the failure stays classifiable', async () => {
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    process.env.GROQ_API_KEY = 'groq-test-key';
    delete process.env.OLLAMA_API_URL;

    __setInsightsLlmTransportForTests({ fetch: async () => okResponse(`${LONG_BRIEF} REJECT_ME`) });

    const result = await callLLM(null, {
      systemPrompt: 'sys',
      userPrompt: 'user',
      accept: (text) => (text.includes('REJECT_ME') ? null : { composed: true }),
    });

    // Not null: a null here would classify as PROVIDER (transport) failure and
    // hide that the model DID answer and the composer rejected it.
    assert.ok(result, 'a rejected-but-present response must still be returned');
    assert.match(result.text, /REJECT_ME/);
  });

  it('keeps the first provider when no acceptor is supplied', async () => {
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    process.env.GROQ_API_KEY = 'groq-test-key';
    delete process.env.OLLAMA_API_URL;

    const seen = [];
    __setInsightsLlmTransportForTests({
      fetch: async (url) => { seen.push(String(url)); return okResponse(LONG_BRIEF); },
    });

    const result = await callLLM(null, { systemPrompt: 'sys', userPrompt: 'user' });
    assert.equal(result.provider, 'openrouter');
    assert.equal(seen.length, 1, 'legacy path must not probe extra providers');
  });

  // Narrow claim: callLLM itself does not propagate an acceptor fault. It does
  // NOT prove the surrounding run survives — the caller's own compose is what
  // must be fault-tolerant, and seed-insights makes composeFromText defensive.
  it('does not propagate an acceptor fault out of callLLM', async () => {
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    process.env.GROQ_API_KEY = 'groq-test-key';
    delete process.env.OLLAMA_API_URL;

    __setInsightsLlmTransportForTests({ fetch: async () => okResponse(LONG_BRIEF) });

    const result = await callLLM(null, {
      systemPrompt: 'sys',
      userPrompt: 'user',
      accept: () => { throw new Error('composer blew up'); },
    });
    assert.ok(result, 'an acceptor fault must not lose an otherwise usable response');
  });

  it('prefers a cleanly-rejected response over one whose acceptor threw', async () => {
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    process.env.GROQ_API_KEY = 'groq-test-key';
    delete process.env.OLLAMA_API_URL;

    __setInsightsLlmTransportForTests({
      fetch: async (url) => okResponse(String(url).includes('openrouter') ? `${LONG_BRIEF} CLEAN` : `${LONG_BRIEF} POISON`),
    });

    const result = await callLLM(null, {
      systemPrompt: 'sys',
      userPrompt: 'user',
      accept: (text) => { if (text.includes('POISON')) throw new Error('boom'); return null; },
    });

    // Returning the poison candidate would hand the caller text its own
    // composer is known to choke on.
    assert.match(result.text, /CLEAN/, 'a faulted candidate must not outrank a clean rejection');
  });

  it('reports the FIRST rejection so the failure code names the primary model stage', async () => {
    process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
    process.env.GROQ_API_KEY = 'groq-test-key';
    delete process.env.OLLAMA_API_URL;

    __setInsightsLlmTransportForTests({
      fetch: async (url) => okResponse(String(url).includes('openrouter') ? `${LONG_BRIEF} PRIMARY` : `${LONG_BRIEF} FALLBACK`),
    });

    const result = await callLLM(null, { systemPrompt: 'sys', userPrompt: 'user', accept: () => null });
    assert.match(result.text, /PRIMARY/, 'the last provider would misattribute the failure stage');
  });
});
