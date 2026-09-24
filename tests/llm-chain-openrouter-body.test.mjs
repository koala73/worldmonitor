// The request body scripts/lib/llm-chain.cjs sends on its paid `openrouter` entry.
//
// The server transport (server/_shared/llm.ts) has always sent OpenRouter the provider
// routing that keeps inference off China-hosted backends, and turned DeepSeek V4's
// default reasoning off for utility calls. The seeder chain sent neither, which was
// harmless while every caller ran Gemini on it. The email brief moving to DeepSeek
// (#4944 U4) makes both load-bearing: without them the brief's prose could be served
// by DeepSeek's own API and spend its max_tokens on hidden reasoning.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { callLLM } from '../scripts/lib/llm-chain.cjs';
import { OPENROUTER_PROVIDER_ROUTING } from '../scripts/lib/llm-model-policy.cjs';

const ENV_KEYS = ['USAGE_TELEMETRY', 'OPENROUTER_API_KEY', 'OLLAMA_API_URL', 'GROQ_API_KEY'];
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

async function openrouterBody(model) {
  delete process.env.USAGE_TELEMETRY;
  delete process.env.OLLAMA_API_URL;
  delete process.env.GROQ_API_KEY;
  process.env.OPENROUTER_API_KEY = 'or-test';
  const bodies = [];
  global.fetch = async (url, init = {}) => {
    assert.match(String(url), /openrouter\.ai/);
    bodies.push(JSON.parse(String(init.body)));
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'prose' }, finish_reason: 'stop' }], usage: {} }) };
  };
  const text = await callLLM('system', 'user', {
    allowedProviders: ['openrouter'],
    ...(model ? { modelOverrides: { openrouter: model } } : {}),
  });
  assert.equal(text, 'prose');
  assert.equal(bodies.length, 1);
  return bodies[0];
}

test('DeepSeek V4 Flash on the paid entry is routed off China-hosted providers with reasoning off', async () => {
  const body = await openrouterBody('deepseek/deepseek-v4-flash');
  assert.equal(body.model, 'deepseek/deepseek-v4-flash');
  assert.deepEqual(body.provider, OPENROUTER_PROVIDER_ROUTING);
  assert.ok(body.provider.ignore.includes('deepseek'), 'the DeepSeek-hosted API must be blocked');
  assert.deepEqual(body.reasoning, { enabled: false });
});

test('a DeepSeek V4 Flash point release gets the same body', async () => {
  const body = await openrouterBody('deepseek/deepseek-v4.1-flash');
  assert.deepEqual(body.reasoning, { enabled: false });
  assert.deepEqual(body.provider, OPENROUTER_PROVIDER_ROUTING);
});

// Gemini keeps the routing but gets no `reasoning` field: gemini-3.8-flash rejects
// `reasoning.enabled=false` outright (#4944 bakeoff, 2026-09-21), so the flag is only
// sent to the model family measured to need it.
test('a Gemini model is routed but its reasoning setting is left alone', async () => {
  const body = await openrouterBody('google/gemini-3.5-flash-lite');
  assert.deepEqual(body.provider, OPENROUTER_PROVIDER_ROUTING);
  assert.equal('reasoning' in body, false);
});

test('the un-overridden chain default is routed too', async () => {
  const body = await openrouterBody(undefined);
  assert.equal(body.model, 'google/gemini-2.5-flash');
  assert.deepEqual(body.provider, OPENROUTER_PROVIDER_ROUTING);
  assert.equal('reasoning' in body, false);
});
