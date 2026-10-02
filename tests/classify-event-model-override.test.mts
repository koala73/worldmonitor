// classify_event must SEND the classification model, not merely mention it in source.
// Drives the real handler through the real callLlm with fetch stubbed, and reads the
// model out of each outgoing request body.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { classifyEvent } from '../server/worldmonitor/intelligence/v1/classify-event.ts';
import { __testing__ as llmHealth } from '../server/_shared/llm-health.ts';
import { GROQ_DEFAULT_MODEL } from '../scripts/_llm-model-timeouts.mjs';

const ENV_KEYS = [
  'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'OLLAMA_API_URL', 'LLM_API_URL', 'LLM_API_KEY',
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const originalFetch = globalThis.fetch;

function stubProviders(openRouterStatus: number) {
  const sent: Array<{ host: string; model: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes('/chat/completions')) return new Response('', { status: 200 });
    sent.push({ host: new URL(url).host, model: JSON.parse(String(init?.body)).model });
    if (url.includes('openrouter.ai') && openRouterStatus !== 200) return new Response('upstream error', { status: openRouterStatus });
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"level":"high","category":"conflict"}' }, finish_reason: 'stop' }],
      usage: { total_tokens: 12 },
    }), { status: 200 });
  }) as typeof fetch;
  return sent;
}

const ctx = () => ({ request: new Request('https://worldmonitor.app/api/intelligence/v1/classify-event'), pathParams: {}, headers: {} }) as never;

describe('classify_event sends the classification model', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.OPENROUTER_API_KEY = 'or-test-key';
    process.env.GROQ_API_KEY = 'groq-test-key';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    llmHealth.reset();
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it('asks OpenRouter for deepseek-v4.1-flash, not the shared Flash default', async () => {
    const sent = stubProviders(200);
    const res = await classifyEvent(ctx(), { title: 'Senate passes sanctions package', description: '', source: '', country: '' });
    assert.equal(res.classification?.subcategory, 'high');
    assert.deepEqual(sent, [{ host: 'openrouter.ai', model: 'deepseek/deepseek-v4.1-flash' }]);
  });

  it('does not push that model onto the fallback providers', async () => {
    const sent = stubProviders(503);
    const res = await classifyEvent(ctx(), { title: 'Senate passes sanctions package, fallback path', description: '', source: '', country: '' });
    assert.equal(res.classification?.subcategory, 'high');
    assert.equal(sent[0]?.model, 'deepseek/deepseek-v4.1-flash');
    const last = sent.at(-1);
    assert.equal(last?.host, 'api.groq.com');
    assert.equal(last?.model, GROQ_DEFAULT_MODEL);
    for (const s of sent.slice(1)) assert.notEqual(s.model, 'deepseek/deepseek-v4.1-flash', `${s.host} must keep its own model`);
  });
});
