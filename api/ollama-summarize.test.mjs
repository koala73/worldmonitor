/**
 * Tests for api/ollama-summarize.js endpoint
 * Validates response shape, fallback semantics, caching, and error handling.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import handler from './ollama-summarize.js';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_OLLAMA_URL = process.env.OLLAMA_API_URL;
const ORIGINAL_OLLAMA_MODEL = process.env.OLLAMA_MODEL;

function makeRequest(body = {}, origin = 'https://tauri.localhost') {
  const headers = new Headers();
  headers.set('origin', origin);
  headers.set('content-type', 'application/json');
  const encoded = JSON.stringify(body);
  headers.set('content-length', String(Buffer.byteLength(encoded)));
  return new Request('https://worldmonitor.app/api/ollama-summarize', {
    method: 'POST',
    headers,
    body: encoded,
  });
}

function ollamaCompletionResponse(content, model = 'llama3.1:8b') {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
    usage: { total_tokens: 42 },
    model,
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test.afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_OLLAMA_URL !== undefined) {
    process.env.OLLAMA_API_URL = ORIGINAL_OLLAMA_URL;
  } else {
    delete process.env.OLLAMA_API_URL;
  }
  if (ORIGINAL_OLLAMA_MODEL !== undefined) {
    process.env.OLLAMA_MODEL = ORIGINAL_OLLAMA_MODEL;
  } else {
    delete process.env.OLLAMA_MODEL;
  }
});

test('returns fallback signal when OLLAMA_API_URL is not configured', async () => {
  delete process.env.OLLAMA_API_URL;

  const response = await handler(makeRequest({
    headlines: ['Test headline 1', 'Test headline 2'],
  }));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.fallback, true);
  assert.equal(body.skipped, true);
  assert.equal(body.summary, null);
});

test('returns summary with provider "ollama" on success', async () => {
  process.env.OLLAMA_API_URL = 'http://127.0.0.1:11434';
  process.env.OLLAMA_MODEL = 'llama3.1:8b';

  globalThis.fetch = async (url) => {
    const target = String(url);
    assert.equal(target.includes('/v1/chat/completions'), true, 'should call OpenAI-compatible endpoint');
    return ollamaCompletionResponse('Iran escalated tensions with new missile test in the Strait of Hormuz.');
  };

  const response = await handler(makeRequest({
    headlines: ['Iran tests new missile', 'Tensions rise in Strait of Hormuz'],
    mode: 'brief',
    variant: 'full',
    lang: 'en',
  }));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.provider, 'ollama');
  assert.equal(body.cached, false);
  assert.equal(typeof body.summary, 'string');
  assert.equal(body.summary.length > 10, true);
  assert.equal(typeof body.tokens, 'number');
  assert.equal(body.model, 'llama3.1:8b');
});

test('supports LM Studio style OpenAI base URL ending with /v1', async () => {
  process.env.OLLAMA_API_URL = 'http://127.0.0.1:1234/v1';
  process.env.OLLAMA_MODEL = 'qwen2.5-7b-instruct';

  globalThis.fetch = async (url) => {
    const target = String(url);
    assert.equal(target, 'http://127.0.0.1:1234/v1/chat/completions');
    return ollamaCompletionResponse('LM Studio endpoint responded successfully.', 'qwen2.5-7b-instruct');
  };

  const response = await handler(makeRequest({
    headlines: ['AI startup launches a new coding assistant'],
    mode: 'brief',
  }));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.provider, 'ollama');
  assert.equal(body.model, 'qwen2.5-7b-instruct');
});

test('returns fallback signal when Ollama API returns error', async () => {
  process.env.OLLAMA_API_URL = 'http://127.0.0.1:11434';

  globalThis.fetch = async () => {
    return new Response(JSON.stringify({ error: 'model not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };

  const response = await handler(makeRequest({
    headlines: ['Test headline 1', 'Test headline 2'],
  }));

  const body = await response.json();
  assert.equal(body.fallback, true);
  assert.equal(body.error, 'Ollama API error');
});

test('returns fallback signal when Ollama returns empty response', async () => {
  process.env.OLLAMA_API_URL = 'http://127.0.0.1:11434';

  globalThis.fetch = async () => {
    return new Response(JSON.stringify({
      choices: [{ message: { content: '' } }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const response = await handler(makeRequest({
    headlines: ['Test headline 1', 'Test headline 2'],
  }));

  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.fallback, true);
  assert.equal(body.error, 'Empty response');
});

test('uses reasoning field when content is empty', async () => {
  process.env.OLLAMA_API_URL = 'http://127.0.0.1:11434';

  globalThis.fetch = async () => {
    return new Response(JSON.stringify({
      choices: [{ message: { content: '', reasoning: 'Markets stabilized after central bank guidance.' } }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const response = await handler(makeRequest({
    headlines: ['Central bank signals no immediate rate hike'],
  }));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.provider, 'ollama');
  assert.equal(body.summary, 'Markets stabilized after central bank guidance.');
});

test('returns 400 when headlines array is missing', async () => {
  process.env.OLLAMA_API_URL = 'http://127.0.0.1:11434';

  const response = await handler(makeRequest({}));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, 'Headlines array required');
});

test('uses OLLAMA_MODEL env for model selection', async () => {
  process.env.OLLAMA_API_URL = 'http://127.0.0.1:11434';
  process.env.OLLAMA_MODEL = 'mistral:7b';

  let capturedModel = null;
  globalThis.fetch = async (url, init) => {
    const payload = JSON.parse(init.body);
    capturedModel = payload.model;
    return ollamaCompletionResponse('Summary of events.');
  };

  const response = await handler(makeRequest({
    headlines: ['Event A occurred', 'Event B followed'],
  }));

  assert.equal(response.status, 200);
  assert.equal(capturedModel, 'mistral:7b');
  const body = await response.json();
  assert.equal(body.model, 'mistral:7b');
});

test('falls back to default model when OLLAMA_MODEL not set', async () => {
  process.env.OLLAMA_API_URL = 'http://127.0.0.1:11434';
  delete process.env.OLLAMA_MODEL;

  let capturedModel = null;
  globalThis.fetch = async (url, init) => {
    const payload = JSON.parse(init.body);
    capturedModel = payload.model;
    return ollamaCompletionResponse('Summary.');
  };

  await handler(makeRequest({
    headlines: ['Event A', 'Event B'],
  }));

  assert.equal(capturedModel, 'llama3.1:8b');
});

test('returns fallback signal on network error (Ollama unreachable)', async () => {
  process.env.OLLAMA_API_URL = 'http://127.0.0.1:11434';

  globalThis.fetch = async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
  };

  const response = await handler(makeRequest({
    headlines: ['Test headline 1', 'Test headline 2'],
  }));

  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.fallback, true);
  assert.equal(body.errorType, 'Error');
});

test('handles translate mode correctly', async () => {
  process.env.OLLAMA_API_URL = 'http://127.0.0.1:11434';

  let capturedMessages = null;
  globalThis.fetch = async (url, init) => {
    const payload = JSON.parse(init.body);
    capturedMessages = payload.messages;
    return ollamaCompletionResponse('L\'Iran a testé un nouveau missile.');
  };

  const response = await handler(makeRequest({
    headlines: ['Iran tests new missile'],
    mode: 'translate',
    variant: 'fr',
  }));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body.summary, 'string');
  // System prompt should mention translation
  assert.equal(capturedMessages[0].content.includes('translator'), true);
  assert.equal(capturedMessages[1].content.includes('Translate to fr'), true);
});
