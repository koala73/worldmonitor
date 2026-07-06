// Seeder-side llm_call telemetry parity (#4944 U5, refs #4948).
//
// seed-forecasts already emits per-attempt llm_call events; seed-insights,
// the brief-llm injected chain (scripts/lib/llm-chain.cjs), and the
// regional-snapshot narrative/weekly-brief transports were dark on cost.
// They now emit the same events through scripts/lib/llm-telemetry.cjs,
// gated on USAGE_TELEMETRY=1 + AXIOM_API_TOKEN, best-effort (a telemetry
// failure must never fail the seed).

import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';

import { buildLlmCallEvent, emitLlmEvents, flushPendingLlmEvents } from '../scripts/lib/llm-telemetry.cjs';
import { callLLM } from '../scripts/lib/llm-chain.cjs';
import { callLlmDefault as callNarrativeLlm, __setNarrativeTransportForTests } from '../scripts/regional-snapshot/narrative.mjs';

const ENV_KEYS = ['USAGE_TELEMETRY', 'AXIOM_API_TOKEN', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_API_URL'];
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
  __setNarrativeTransportForTests(null);
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
  delete process.env.OLLAMA_API_URL;
}

function llmJson(content, usage = { total_tokens: 30, prompt_tokens: 20, completion_tokens: 10 }) {
  return { choices: [{ message: { content } }], usage };
}

test('llm-telemetry: buildLlmCallEvent mirrors the LlmCallEvent field shape', () => {
  const ev = buildLlmCallEvent({
    provider: 'openrouter', model: 'm', stage: 's', ok: false,
    durationMs: 12.6, tokensTotal: 3, tokensPrompt: 2, tokensCompletion: 1,
    promptChars: 40, maxTokens: 500, fallbackIndex: 1, reason: 'http_500',
  });
  assert.equal(ev.event_type, 'llm_call');
  assert.deepEqual(
    Object.keys(ev).sort(),
    ['_time', 'duration_ms', 'event_type', 'fallback_index', 'max_tokens', 'model', 'ok',
      'prompt_chars', 'provider', 'reason', 'stage', 'tokens_completion', 'tokens_prompt', 'tokens_total'].sort(),
  );
  assert.equal(ev.duration_ms, 13);
  assert.equal(ev.reason, 'http_500');
});

test('llm-chain: fallback emits one event per attempt with the caller stage', async () => {
  baseEnv();
  const captured = [];
  global.fetch = async (url, init = {}) => {
    const raw = String(url);
    if (raw.includes('api.axiom.co')) {
      captured.push(...JSON.parse(String(init.body || '[]')));
      return { ok: true, json: async () => ({}) };
    }
    if (raw.includes('api.groq.com')) {
      return { ok: false, status: 500, json: async () => ({}) };
    }
    if (raw.includes('openrouter.ai')) {
      return { ok: true, json: async () => llmJson('brief prose output') };
    }
    throw new Error(`unexpected fetch: ${raw}`);
  };

  const text = await callLLM('system', 'user prompt', { stage: 'brief-digest-cron' });
  assert.equal(text, 'brief prose output');
  assert.equal(captured.length, 2, 'failed groq attempt + openrouter success');
  const [fail, ok] = captured;
  assert.equal(fail.provider, 'groq');
  assert.equal(fail.ok, false);
  assert.equal(fail.reason, 'http_500');
  assert.equal(fail.fallback_index, 0);
  assert.equal(fail.stage, 'brief-digest-cron');
  assert.equal(ok.provider, 'openrouter');
  assert.equal(ok.ok, true);
  assert.equal(ok.fallback_index, 1);
  assert.equal(ok.tokens_total, 30);
  assert.ok(fail.prompt_chars > 0);
});

test('llm-chain: emits nothing when USAGE_TELEMETRY is off', async () => {
  baseEnv();
  delete process.env.USAGE_TELEMETRY;
  const captured = [];
  global.fetch = async (url, init = {}) => {
    const raw = String(url);
    if (raw.includes('api.axiom.co')) {
      captured.push(...JSON.parse(String(init.body || '[]')));
      return { ok: true, json: async () => ({}) };
    }
    return { ok: true, json: async () => llmJson('answer text here') };
  };

  const text = await callLLM('system', 'user prompt', {});
  assert.equal(text, 'answer text here');
  assert.equal(captured.length, 0, 'telemetry must stay opt-in');
});

test('flushPendingLlmEvents drains in-flight deliveries before an explicit exit', async () => {
  baseEnv();
  let delivered = false;
  let release;
  const gate = new Promise((r) => { release = r; });
  global.fetch = async (url) => {
    if (String(url).includes('api.axiom.co')) {
      await gate;
      delivered = true;
      return { ok: true, json: async () => ({}) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  // Fire-and-forget (what the transports do) — delivery is still in flight.
  void emitLlmEvents([buildLlmCallEvent({ provider: 'openrouter', model: 'm', stage: 's', ok: true, durationMs: 1 })]);
  assert.equal(delivered, false, 'delivery must still be pending');

  const flush = flushPendingLlmEvents();
  release();
  await flush;
  assert.equal(delivered, true, 'flush must drain the pending delivery');
});

test('llm-chain: a telemetry delivery failure never fails the call', async () => {
  baseEnv();
  global.fetch = async (url) => {
    const raw = String(url);
    if (raw.includes('api.axiom.co')) {
      throw new Error('axiom down');
    }
    return { ok: true, json: async () => llmJson('resilient output text') };
  };

  const text = await callLLM('system', 'user prompt', { stage: 'brief-whymatters-cron' });
  assert.equal(text, 'resilient output text', 'telemetry failure must not affect the result');
});

test('narrative: validate_reject and success attempts both reach the ingest', async () => {
  baseEnv();
  const captured = [];
  global.fetch = async (url, init = {}) => {
    const raw = String(url);
    if (raw.includes('api.axiom.co')) {
      captured.push(...JSON.parse(String(init.body || '[]')));
      return { ok: true, json: async () => ({}) };
    }
    throw new Error(`unexpected global fetch: ${raw}`);
  };
  // Provider transport is injected: groq answers but fails validation,
  // openrouter answers with the accepted payload.
  __setNarrativeTransportForTests({
    fetch: async (url) => {
      const raw = String(url);
      if (raw.includes('api.groq.com')) {
        return { ok: true, json: async () => llmJson('not-json narrative') };
      }
      return { ok: true, json: async () => llmJson('{"ok":true}') };
    },
  });

  const res = await callNarrativeLlm(
    { systemPrompt: 'sys', userPrompt: 'user' },
    { validate: (text) => text.startsWith('{') },
  );
  assert.ok(res);
  assert.equal(res.provider, 'openrouter');
  assert.equal(captured.length, 2);
  assert.equal(captured[0].stage, 'regional-narrative');
  assert.equal(captured[0].ok, false);
  assert.equal(captured[0].reason, 'validate_reject');
  assert.equal(captured[0].fallback_index, 0);
  assert.equal(captured[1].ok, true);
  assert.equal(captured[1].fallback_index, 1);
});
