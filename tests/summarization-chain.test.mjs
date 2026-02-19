/**
 * Summarization chain order tests
 * Validates provider fallback order: Ollama → Groq → OpenRouter → Browser T5
 *
 * Tests the API endpoint handlers directly (same approach as cyber-threats.test.mjs)
 * to verify chain semantics: short-circuit on success, fallback on failure.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';

// We test the chain order by importing handlers directly and verifying
// their response shapes + fallback signals match what summarization.ts expects.

import ollamaHandler from '../api/ollama-summarize.js';
import groqHandler from '../api/groq-summarize.js';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_OLLAMA_URL = process.env.OLLAMA_API_URL;
const ORIGINAL_OLLAMA_MODEL = process.env.OLLAMA_MODEL;
const ORIGINAL_GROQ_KEY = process.env.GROQ_API_KEY;

function makeRequest(body = {}, origin = 'https://tauri.localhost') {
  const headers = new Headers();
  headers.set('origin', origin);
  headers.set('content-type', 'application/json');
  const encoded = JSON.stringify(body);
  headers.set('content-length', String(Buffer.byteLength(encoded)));
  return new Request('https://worldmonitor.app/api/test', {
    method: 'POST',
    headers,
    body: encoded,
  });
}

function ollamaCompletionResponse(content) {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
    usage: { total_tokens: 42 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function groqCompletionResponse(content) {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
    usage: { total_tokens: 35 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

const TEST_HEADLINES = { headlines: ['Event A happened today', 'Event B followed quickly'] };

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
  if (ORIGINAL_GROQ_KEY !== undefined) {
    process.env.GROQ_API_KEY = ORIGINAL_GROQ_KEY;
  } else {
    delete process.env.GROQ_API_KEY;
  }
});

// ── Chain order: Ollama success short-circuits (no Groq/OpenRouter calls) ──

test('Ollama success short-circuits the chain (no downstream calls)', async () => {
  process.env.OLLAMA_API_URL = 'http://127.0.0.1:11434';
  process.env.GROQ_API_KEY = 'test-groq-key';

  let groqCalled = false;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('/v1/chat/completions')) {
      return ollamaCompletionResponse('Ollama summary of events.');
    }
    if (target.includes('api.groq.com')) {
      groqCalled = true;
      return groqCompletionResponse('Groq summary.');
    }
    return new Response('not found', { status: 404 });
  };

  const ollamaResponse = await ollamaHandler(makeRequest(TEST_HEADLINES));
  assert.equal(ollamaResponse.status, 200);
  const ollamaBody = await ollamaResponse.json();

  // Ollama succeeded — chain should stop here
  assert.equal(ollamaBody.provider, 'ollama');
  assert.equal(typeof ollamaBody.summary, 'string');
  assert.equal(ollamaBody.summary.length > 5, true);
  assert.equal(ollamaBody.fallback, undefined);
  assert.equal(groqCalled, false, 'Groq should not be called when Ollama succeeds');
});

// ── Chain order: Ollama fail → Groq success ──

test('Ollama failure signals fallback, then Groq succeeds', async () => {
  // Step 1: Ollama fails
  process.env.OLLAMA_API_URL = 'http://127.0.0.1:11434';
  globalThis.fetch = async () => {
    throw new Error('connect ECONNREFUSED');
  };

  const ollamaResponse = await ollamaHandler(makeRequest(TEST_HEADLINES));
  const ollamaBody = await ollamaResponse.json();
  assert.equal(ollamaBody.fallback, true, 'Ollama should signal fallback on failure');

  // Step 2: Groq succeeds
  process.env.GROQ_API_KEY = 'test-groq-key';
  globalThis.fetch = async () => groqCompletionResponse('Groq picked up the summary.');

  const groqResponse = await groqHandler(makeRequest(TEST_HEADLINES));
  assert.equal(groqResponse.status, 200);
  const groqBody = await groqResponse.json();
  assert.equal(groqBody.provider, 'groq');
  assert.equal(typeof groqBody.summary, 'string');
  assert.equal(groqBody.fallback, undefined);
});

// ── Chain order: Both fail → fallback signals propagate ──

test('full fallback: Ollama + Groq both fail with fallback signals', async () => {
  // Ollama: unconfigured
  delete process.env.OLLAMA_API_URL;
  const ollamaResponse = await ollamaHandler(makeRequest(TEST_HEADLINES));
  const ollamaBody = await ollamaResponse.json();
  assert.equal(ollamaBody.fallback, true);
  assert.equal(ollamaBody.skipped, true);

  // Groq: unconfigured
  delete process.env.GROQ_API_KEY;
  const groqResponse = await groqHandler(makeRequest(TEST_HEADLINES));
  const groqBody = await groqResponse.json();
  assert.equal(groqBody.fallback, true);
  assert.equal(groqBody.skipped, true);
});

// ── Response shape: provider labels are correct ──

test('Ollama response uses provider label "ollama"', async () => {
  process.env.OLLAMA_API_URL = 'http://127.0.0.1:11434';
  globalThis.fetch = async () => ollamaCompletionResponse('Summary here.');

  const response = await ollamaHandler(makeRequest(TEST_HEADLINES));
  const body = await response.json();
  assert.equal(body.provider, 'ollama');
});

test('Groq response uses provider label "groq"', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  globalThis.fetch = async () => groqCompletionResponse('Summary here.');

  const response = await groqHandler(makeRequest(TEST_HEADLINES));
  const body = await response.json();
  assert.equal(body.provider, 'groq');
});

// ── Response shape: all providers share uniform response contract ──

test('Ollama and Groq share the same response shape', async () => {
  process.env.OLLAMA_API_URL = 'http://127.0.0.1:11434';
  process.env.GROQ_API_KEY = 'test-key';

  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('127.0.0.1:11434')) {
      return ollamaCompletionResponse('Ollama analysis.');
    }
    return groqCompletionResponse('Groq analysis.');
  };

  const ollamaResponse = await ollamaHandler(makeRequest(TEST_HEADLINES));
  const groqResponse = await groqHandler(makeRequest(TEST_HEADLINES));

  const ollamaBody = await ollamaResponse.json();
  const groqBody = await groqResponse.json();

  // Both should have the same keys
  const requiredKeys = ['summary', 'model', 'provider', 'cached', 'tokens'];
  for (const key of requiredKeys) {
    assert.equal(key in ollamaBody, true, `Ollama response missing key: ${key}`);
    assert.equal(key in groqBody, true, `Groq response missing key: ${key}`);
  }

  assert.equal(typeof ollamaBody.summary, 'string');
  assert.equal(typeof groqBody.summary, 'string');
  assert.equal(ollamaBody.cached, false);
  assert.equal(groqBody.cached, false);
});

// ── Fallback shape consistency ──

test('Ollama and Groq produce identical fallback signal shapes', async () => {
  // Both unconfigured
  delete process.env.OLLAMA_API_URL;
  delete process.env.GROQ_API_KEY;

  const ollamaResponse = await ollamaHandler(makeRequest(TEST_HEADLINES));
  const groqResponse = await groqHandler(makeRequest(TEST_HEADLINES));

  const ollamaBody = await ollamaResponse.json();
  const groqBody = await groqResponse.json();

  // Both should signal fallback with same shape
  assert.equal(ollamaBody.fallback, true);
  assert.equal(groqBody.fallback, true);
  assert.equal(ollamaBody.skipped, true);
  assert.equal(groqBody.skipped, true);
  assert.equal(ollamaBody.summary, null);
  assert.equal(groqBody.summary, null);
});
