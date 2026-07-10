// Seeder-side llm_call telemetry (#4895 follow-up, post-#4901 review P1).
//
// server/_shared/llm.ts emits llm_call events, but the forecast seeder has
// its own transport (callForecastLLM) — the cost-heavy stages
// (market_implications, combined, scenario, critical_signals) were invisible
// in wm_api_usage. callForecastLLM now emits the same per-ATTEMPT events:
// every retry and provider fallback re-sends the full prompt and gets its
// own fallback_index, with token usage captured when the provider returns it.

import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import {
  callForecastLLM,
  __setForecastLlmTransportForTests,
} from '../scripts/seed-forecasts.mjs';

const ENV_KEYS = ['USAGE_TELEMETRY', 'AXIOM_API_TOKEN', 'GROQ_API_KEY', 'OPENROUTER_API_KEY'];
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
  __setForecastLlmTransportForTests(null);
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

function baseEnv() {
  process.env.USAGE_TELEMETRY = '1';
  process.env.AXIOM_API_TOKEN = 'axiom-test-token';
  process.env.GROQ_API_KEY = 'groq-test';
  process.env.OPENROUTER_API_KEY = 'or-test';
}

function captureAxiom() {
  const captured = [];
  global.fetch = async (url, init = {}) => {
    if (String(url).includes('api.axiom.co')) {
      captured.push(...JSON.parse(String(init.body || '[]')));
      return { ok: true, json: async () => ({}) };
    }
    throw new Error(`unexpected global fetch: ${url}`);
  };
  return captured;
}

function llmResponse(body, status = 200) {
  return {
    ok: status === 200,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test('success on first attempt emits one ok event with token usage', async () => {
  baseEnv();
  const captured = captureAxiom();
  __setForecastLlmTransportForTests({
    fetch: async () => llmResponse({
      choices: [{ message: { content: 'a forecast narrative that is long enough' } }],
      model: 'google/gemini-2.5-flash',
      usage: { prompt_tokens: 900, completion_tokens: 300, total_tokens: 1200 },
    }),
  });

  const result = await callForecastLLM('system', 'user prompt', { stage: 'market_implications', providerOrder: ['openrouter'] });

  assert.ok(result?.text);
  assert.equal(captured.length, 1);
  const ev = captured[0];
  assert.equal(ev.event_type, 'llm_call');
  assert.equal(ev.stage, 'market_implications');
  assert.equal(ev.provider, 'openrouter');
  assert.equal(ev.ok, true);
  assert.equal(ev.fallback_index, 0);
  assert.equal(ev.tokens_total, 1200);
  assert.equal(ev.tokens_prompt, 900);
  assert.equal(ev.tokens_completion, 300);
  assert.ok(ev.prompt_chars > 0);
});

test('every retry attempt gets its own event and fallback_index', async () => {
  baseEnv();
  const captured = captureAxiom();
  let calls = 0;
  __setForecastLlmTransportForTests({
    fetch: async () => {
      calls += 1;
      if (calls === 1) return llmResponse({ error: 'transient' }, 500);
      return llmResponse({
        choices: [{ message: { content: 'a forecast narrative that is long enough' } }],
        model: 'google/gemini-2.5-flash',
        usage: { total_tokens: 100 },
      });
    },
  });

  const result = await callForecastLLM('system', 'user prompt', {
    stage: 'combined', providerOrder: ['openrouter'], retryDelayMs: 0,
  });

  assert.ok(result?.text);
  assert.equal(captured.length, 2, 'the failed retry attempt must be visible');
  assert.equal(captured[0].ok, false);
  assert.equal(captured[0].reason, 'http_500');
  assert.equal(captured[0].fallback_index, 0);
  assert.equal(captured[1].ok, true);
  assert.equal(captured[1].fallback_index, 1);
});

test('provider fallback chains keep incrementing the index', async () => {
  baseEnv();
  const captured = captureAxiom();
  __setForecastLlmTransportForTests({
    fetch: async (url) => {
      if (String(url).includes('api.groq.com')) return llmResponse({ error: 'down' }, 503);
      return llmResponse({
        choices: [{ message: { content: 'a forecast narrative that is long enough' } }],
        model: 'google/gemini-2.5-flash',
      });
    },
  });

  const result = await callForecastLLM('system', 'user prompt', {
    stage: 'scenario', providerOrder: ['groq', 'openrouter'], retryDelayMs: 0,
  });

  assert.ok(result?.text);
  assert.ok(captured.length >= 2, 'groq attempts + openrouter success must all be recorded');
  const last = captured[captured.length - 1];
  assert.equal(last.provider, 'openrouter');
  assert.equal(last.ok, true);
  for (const [i, ev] of captured.entries()) {
    assert.equal(ev.fallback_index, i, 'indexes must be strictly sequential across retries and providers');
    if (i < captured.length - 1) {
      assert.equal(ev.provider, 'groq');
      assert.equal(ev.ok, false);
    }
  }
});

test('telemetry is opt-in: no env → no Axiom traffic', async () => {
  baseEnv();
  delete process.env.USAGE_TELEMETRY;
  const captured = captureAxiom();
  __setForecastLlmTransportForTests({
    fetch: async () => llmResponse({
      choices: [{ message: { content: 'a forecast narrative that is long enough' } }],
    }),
  });

  const result = await callForecastLLM('system', 'user prompt', { stage: 'combined', providerOrder: ['openrouter'] });

  assert.ok(result?.text);
  assert.equal(captured.length, 0);
});
