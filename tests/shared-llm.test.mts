import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { callLlm } from '../server/_shared/llm.ts';

const originalFetch = globalThis.fetch;
const originalGroqApiKey = process.env.GROQ_API_KEY;
const originalOpenRouterApiKey = process.env.OPENROUTER_API_KEY;
const originalOllamaApiUrl = process.env.OLLAMA_API_URL;
const originalLlmApiUrl = process.env.LLM_API_URL;
const originalLlmApiKey = process.env.LLM_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;

  if (originalGroqApiKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = originalGroqApiKey;

  if (originalOpenRouterApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalOpenRouterApiKey;

  if (originalOllamaApiUrl === undefined) delete process.env.OLLAMA_API_URL;
  else process.env.OLLAMA_API_URL = originalOllamaApiUrl;

  if (originalLlmApiUrl === undefined) delete process.env.LLM_API_URL;
  else process.env.LLM_API_URL = originalLlmApiUrl;

  if (originalLlmApiKey === undefined) delete process.env.LLM_API_KEY;
  else process.env.LLM_API_KEY = originalLlmApiKey;
});

describe('callLlm', () => {
  it('preserves the default provider order', async () => {
    process.env.GROQ_API_KEY = 'groq-test-key';
    process.env.OPENROUTER_API_KEY = 'or-test-key';
    delete process.env.OLLAMA_API_URL;
    delete process.env.LLM_API_URL;
    delete process.env.LLM_API_KEY;

    const postUrls: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if ((init?.method || 'GET') === 'GET') {
        return new Response('', { status: 200 });
      }

      postUrls.push(url);
      if (url.includes('api.groq.com')) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'groq response' } }],
          usage: { total_tokens: 42 },
        }), { status: 200 });
      }

      return new Response(JSON.stringify({
        choices: [{ message: { content: 'openrouter response' } }],
        usage: { total_tokens: 99 },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await callLlm({
      messages: [{ role: 'user', content: 'Summarize the setup.' }],
    });

    assert.ok(result);
    assert.equal(result.provider, 'groq');
    assert.equal(result.model, 'llama-3.1-8b-instant');
    assert.deepEqual(postUrls.filter(url => url.includes('/chat/completions')), [
      'https://api.groq.com/openai/v1/chat/completions',
    ]);
  });

  it('supports explicitly bypassing groq with a stronger model override', async () => {
    process.env.GROQ_API_KEY = 'groq-test-key';
    process.env.OPENROUTER_API_KEY = 'or-test-key';
    delete process.env.OLLAMA_API_URL;
    delete process.env.LLM_API_URL;
    delete process.env.LLM_API_KEY;

    const postBodies: Array<{ url: string; body: Record<string, unknown> }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if ((init?.method || 'GET') === 'GET') {
        return new Response('', { status: 200 });
      }

      const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
      postBodies.push({ url, body });

      if (url.includes('api.groq.com')) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'groq response' } }],
          usage: { total_tokens: 12 },
        }), { status: 200 });
      }

      return new Response(JSON.stringify({
        choices: [{ message: { content: 'openrouter response' } }],
        usage: { total_tokens: 64 },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await callLlm({
      messages: [{ role: 'user', content: 'Use the better model.' }],
      providerOrder: ['openrouter'],
      modelOverrides: {
        openrouter: 'google/gemini-2.5-pro',
      },
    });

    assert.ok(result);
    assert.equal(result.provider, 'openrouter');
    assert.equal(result.model, 'google/gemini-2.5-pro');
    assert.equal(postBodies.length, 1);
    assert.equal(postBodies[0]?.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(postBodies[0]?.body.model, 'google/gemini-2.5-pro');
  });

  it('falls back within an explicit provider order when the upper model fails', async () => {
    process.env.GROQ_API_KEY = 'groq-test-key';
    process.env.OPENROUTER_API_KEY = 'or-test-key';
    delete process.env.OLLAMA_API_URL;
    delete process.env.LLM_API_URL;
    delete process.env.LLM_API_KEY;

    const postUrls: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if ((init?.method || 'GET') === 'GET') {
        return new Response('', { status: 200 });
      }

      postUrls.push(url);
      if (url.includes('openrouter.ai')) {
        return new Response('upstream error', { status: 503 });
      }

      return new Response(JSON.stringify({
        choices: [{ message: { content: 'groq fallback response' } }],
        usage: { total_tokens: 21 },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await callLlm({
      messages: [{ role: 'user', content: 'Try the stronger model first.' }],
      providerOrder: ['openrouter', 'groq'],
      modelOverrides: {
        openrouter: 'google/gemini-2.5-pro',
      },
    });

    assert.ok(result);
    assert.equal(result.provider, 'groq');
    assert.equal(result.model, 'llama-3.1-8b-instant');
    assert.deepEqual(postUrls.filter(url => url.includes('/chat/completions')), [
      'https://openrouter.ai/api/v1/chat/completions',
      'https://api.groq.com/openai/v1/chat/completions',
    ]);
  });
});
