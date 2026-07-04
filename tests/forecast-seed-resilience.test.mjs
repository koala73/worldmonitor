import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  makePrediction,
  resolveScenarioLlmResult,
  __redisSetForTests,
  __setRedisStoreForTests,
  __callForecastLlmForTests,
  __setForecastLlmCallOverrideForTests,
  __setForecastLlmTransportForTests,
  __setForecastLlmRunDeadlineForTests,
} from '../scripts/seed-forecasts.mjs';
import { CHROME_UA } from '../scripts/_seed-utils.mjs';

const REAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  __setRedisStoreForTests(null);
  __setForecastLlmCallOverrideForTests(null);
  __setForecastLlmTransportForTests(null);
  __setForecastLlmRunDeadlineForTests(null);
});

// ---- redisSet best-effort cache write now retries transient failures ----
describe('redisSet cache-write retry', () => {
  beforeEach(() => __setRedisStoreForTests(null)); // force the real fetch path

  it('retries a transient timeout and succeeds on the 2nd attempt', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      return { ok: true };
    };
    await __redisSetForTests('http://redis', 'tok', 'intelligence:market-implications:v1', { a: 1 }, 600);
    assert.equal(calls, 2, 'should retry once then succeed');
  });

  it('swallows the error after exhausting retries (best-effort) — 1 + 1 retry', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; throw new Error('ECONNRESET'); };
    await assert.doesNotReject(() => __redisSetForTests('http://redis', 'tok', 'k', { a: 1 }, 600));
    assert.equal(calls, 2, 'withRetry(1) => 2 total attempts');
  });

  it('does not retry a non-retryable 4xx', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return { ok: false, status: 400 }; };
    await __redisSetForTests('http://redis', 'tok', 'k', { a: 1 }, 600);
    assert.equal(calls, 1, '4xx is nonRetryable → bail immediately');
  });

  it('retries a 503 then succeeds', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return calls === 1 ? { ok: false, status: 503 } : { ok: true }; };
    await __redisSetForTests('http://redis', 'tok', 'k', { a: 1 }, 600);
    assert.equal(calls, 2, '5xx is retryable');
  });

  it('sends the standard User-Agent header on cache writes', async () => {
    let seenHeaders = null;
    globalThis.fetch = async (_url, init) => {
      seenHeaders = init.headers;
      return { ok: true };
    };
    await __redisSetForTests('http://redis', 'tok', 'k', { a: 1 }, 600);
    assert.equal(seenHeaders?.['User-Agent'], CHROME_UA);
  });
});

// ---- LLM provider retry budget bumped 2 -> 3 (=4 attempts) ----
describe('forecast LLM provider retries', () => {
  const OLD_KEY = process.env.OPENROUTER_API_KEY;
  beforeEach(() => { process.env.OPENROUTER_API_KEY = 'test-key'; });
  afterEach(() => { if (OLD_KEY === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = OLD_KEY; });

  it('survives 3 consecutive transport failures then succeeds (proves maxRetries>=3)', async () => {
    let calls = 0;
    __setForecastLlmTransportForTests({
      fetch: async () => {
        calls += 1;
        if (calls <= 3) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } });
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'A valid forecast LLM response over twenty chars.' } }], model: 'test-model' }) };
      },
    });
    const res = await __callForecastLlmForTests('sys', 'user', { providerOrder: ['openrouter'], stage: 'default', retryDelayMs: 1 });
    assert.ok(res && res.text, 'should succeed on the 4th attempt');
    assert.equal(calls, 4, '1 initial + 3 retries');
  });

  it('gives up after 4 attempts when the provider never recovers', async () => {
    let calls = 0;
    __setForecastLlmTransportForTests({ fetch: async () => { calls += 1; throw new Error('fetch failed'); } });
    const res = await __callForecastLlmForTests('sys', 'user', { providerOrder: ['openrouter'], stage: 'default', retryDelayMs: 1 });
    assert.equal(res, null, 'exhausted provider returns null');
    assert.equal(calls, 4, '1 initial + 3 retries');
  });
});

// ---- scenario stage re-calls the LLM once on a validation_failed (0 scenarios) ----
describe('resolveScenarioLlmResult validation retry', () => {
  const predictions = [
    makePrediction('conflict', 'Middle East', 'Escalation risk: Iran', 0.7, 0.6, '7d', [{ type: 'cii', value: 'Iran CII 85', weight: 0.4 }]),
  ];
  const validCasePayload = JSON.stringify([{ index: 0, baseCase: 'This is a base case narrative well over twenty characters long.' }]);

  it('retries once when the first response validates to zero, then accepts the valid one (and logs the retry)', async () => {
    let calls = 0;
    const logs = [];
    const origLog = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    try {
      __setForecastLlmCallOverrideForTests(async () => {
        calls += 1;
        return { text: calls === 1 ? '[]' : validCasePayload, model: 'm', provider: 'p' };
      });
      const out = await resolveScenarioLlmResult(predictions, {});
      assert.equal(calls, 2, 'empty first response triggers exactly one retry');
      assert.ok(out.result, 'returns a usable result');
      assert.equal(out.validCases.length, 1, 'second response validated');
    } finally {
      console.log = origLog;
    }
    assert.ok(logs.some((l) => l.includes('validation retry')), 'emits a log line when the retry fires');
  });

  it('stops after the bounded retry when every response is empty (returns last)', async () => {
    let calls = 0;
    __setForecastLlmCallOverrideForTests(async () => { calls += 1; return { text: '[]', model: 'm', provider: 'p' }; });
    const out = await resolveScenarioLlmResult(predictions, {});
    assert.equal(calls, 2, 'default 1 retry => 2 total attempts, no infinite loop');
    assert.ok(out.result, 'still returns the last (empty) LLM result for downstream logging');
    assert.equal(out.valid.length + out.validCases.length, 0);
  });

  it('does not retry when the first response is already valid', async () => {
    let calls = 0;
    __setForecastLlmCallOverrideForTests(async () => { calls += 1; return { text: validCasePayload, model: 'm', provider: 'p' }; });
    const out = await resolveScenarioLlmResult(predictions, {});
    assert.equal(calls, 1, 'valid first response => no retry');
    assert.equal(out.validCases.length, 1);
  });

  it('tries a fallback provider after the primary validates to zero narratives', async () => {
    const oldGroqKey = process.env.GROQ_API_KEY;
    const oldOpenRouterKey = process.env.OPENROUTER_API_KEY;
    process.env.GROQ_API_KEY = 'groq-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-key';
    const providers = [];
    try {
      __setForecastLlmTransportForTests({
        fetch: async (url) => {
          const provider = url.includes('groq.com') ? 'groq' : 'openrouter';
          providers.push(provider);
          return {
            ok: true,
            json: async () => ({
              model: `${provider}-model`,
              choices: [{
                message: {
                  content: provider === 'groq'
                    ? 'The provider returned a semantically empty JSON payload: []'
                    : validCasePayload,
                },
              }],
            }),
          };
        },
      });
      const out = await resolveScenarioLlmResult(predictions, { providerOrder: ['groq', 'openrouter'], retryDelayMs: 1 });
      assert.deepEqual(providers, ['groq', 'openrouter']);
      assert.equal(out.result.provider, 'openrouter');
      assert.equal(out.validCases.length, 1);
    } finally {
      if (oldGroqKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = oldGroqKey;
      if (oldOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldOpenRouterKey;
    }
  });
});
