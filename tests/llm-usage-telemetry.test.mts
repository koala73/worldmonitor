// LLM usage telemetry (#4895): every callLlm provider attempt emits an
// `llm_call` event (provider, model, stage, tokens, duration, fallback index)
// through the existing wm_api_usage Axiom pipeline. Before this, llm.ts
// returned `tokens` and nobody recorded it — spend attribution required
// forensic duration_ms inference.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { callLlm } from '../server/_shared/llm.ts';

const ENV_KEYS = [
  'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_API_URL', 'LLM_API_URL', 'LLM_API_KEY',
  'USAGE_TELEMETRY', 'AXIOM_API_TOKEN',
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k] as string;
  }
});

interface CapturedIngest {
  events: Array<Record<string, unknown>>;
}

function installFetchMock(opts: {
  openrouterStatus?: number;
  openrouterFinishReason?: string;
  captured: CapturedIngest;
}) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if ((init?.method || 'GET') === 'GET') {
      return new Response('', { status: 200 });
    }
    if (url.includes('api.axiom.co')) {
      opts.captured.events.push(...JSON.parse(String(init?.body || '[]')));
      return new Response('{}', { status: 200 });
    }
    if (url.includes('api.groq.com')) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'groq answer' } }],
        model: 'llama-3.3-70b-versatile',
        usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
      }), { status: 200 });
    }
    if (url.includes('openrouter.ai')) {
      if (opts.openrouterStatus && opts.openrouterStatus !== 200) {
        return new Response('openrouter down', { status: opts.openrouterStatus });
      }
      return new Response(JSON.stringify({
        choices: [{
          message: { content: 'openrouter answer' },
          ...(opts.openrouterFinishReason ? { finish_reason: opts.openrouterFinishReason } : {}),
        }],
        model: 'deepseek/deepseek-v4-flash',
        usage: { prompt_tokens: 130, completion_tokens: 55, total_tokens: 185 },
      }), { status: 200 });
    }
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;
}

function baseEnv() {
  process.env.GROQ_API_KEY = 'groq-test-key';
  process.env.OPENROUTER_API_KEY = 'or-test-key';
  process.env.USAGE_TELEMETRY = '1';
  process.env.AXIOM_API_TOKEN = 'axiom-test-token';
  delete process.env.OLLAMA_API_URL;
  delete process.env.LLM_API_URL;
  delete process.env.LLM_API_KEY;
}

describe('llm usage telemetry', () => {
  it('emits one llm_call event for a first-provider success', async () => {
    baseEnv();
    const captured: CapturedIngest = { events: [] };
    installFetchMock({ captured });

    const result = await callLlm({
      messages: [
        { role: 'system', content: 'sys prompt' },
        { role: 'user', content: 'user prompt' },
      ],
      stage: 'test-stage',
    });

    assert.equal(result?.content, 'openrouter answer');
    assert.equal(captured.events.length, 1, 'exactly one event for one attempt');
    const ev = captured.events[0];
    assert.equal(ev.event_type, 'llm_call');
    assert.equal(ev.provider, 'openrouter');
    assert.equal(ev.stage, 'test-stage');
    assert.equal(ev.ok, true);
    assert.equal(ev.tokens_total, 185);
    assert.equal(ev.tokens_prompt, 130);
    assert.equal(ev.tokens_completion, 55);
    assert.equal(ev.fallback_index, 0);
    assert.equal(typeof ev.duration_ms, 'number');
    assert.ok((ev.prompt_chars as number) > 0, 'prompt size must be recorded');
    assert.ok(typeof ev.model === 'string' && (ev.model as string).length > 0);
  });

  it('records the failed attempt AND the fallback success', async () => {
    baseEnv();
    const captured: CapturedIngest = { events: [] };
    installFetchMock({ openrouterStatus: 500, captured });

    const result = await callLlm({
      messages: [{ role: 'user', content: 'user prompt' }],
      stage: 'test-stage',
    });

    assert.equal(result?.content, 'groq answer');
    assert.equal(captured.events.length, 2, 'failed attempt + fallback must both be visible');
    const [fail, ok] = captured.events;
    assert.equal(fail.provider, 'openrouter');
    assert.equal(fail.ok, false);
    assert.equal(fail.reason, 'http_500');
    assert.equal(fail.fallback_index, 0);
    assert.equal(ok.provider, 'groq');
    assert.equal(ok.ok, true);
    assert.equal(ok.fallback_index, 1);
    assert.equal(ok.tokens_total, 160);
  });

  it('records an opted-in length rejection before the fallback success', async () => {
    baseEnv();
    const captured: CapturedIngest = { events: [] };
    installFetchMock({ openrouterFinishReason: 'length', captured });

    const result = await callLlm({
      messages: [{ role: 'user', content: 'user prompt' }],
      stage: 'brief-why-matters-test',
      retryOnLengthLimit: true,
    });

    assert.equal(result?.content, 'groq answer');
    assert.equal(captured.events.length, 2);
    const [lengthReject, fallbackSuccess] = captured.events;
    assert.equal(lengthReject.provider, 'openrouter');
    assert.equal(lengthReject.ok, false);
    assert.equal(lengthReject.reason, 'length');
    assert.equal(lengthReject.tokens_completion, 55);
    assert.equal(fallbackSuccess.provider, 'groq');
    assert.equal(fallbackSuccess.ok, true);
  });

  it('emits nothing when USAGE_TELEMETRY is off', async () => {
    baseEnv();
    delete process.env.USAGE_TELEMETRY;
    const captured: CapturedIngest = { events: [] };
    installFetchMock({ captured });

    const result = await callLlm({
      messages: [{ role: 'user', content: 'user prompt' }],
      stage: 'test-stage',
    });

    assert.equal(result?.content, 'openrouter answer');
    assert.equal(captured.events.length, 0, 'telemetry must be opt-in');
  });

  it('defaults the stage to "unknown" for untagged callers', async () => {
    baseEnv();
    const captured: CapturedIngest = { events: [] };
    installFetchMock({ captured });

    await callLlm({ messages: [{ role: 'user', content: 'user prompt' }] });

    assert.equal(captured.events.length, 1);
    assert.equal(captured.events[0].stage, 'unknown');
  });
});
