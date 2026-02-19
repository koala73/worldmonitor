/**
 * Tests for api/_summarize-handler.js shared factory
 * Validates that the extracted shared logic (cache key, dedup, handler creation)
 * works identically to the original per-provider implementations.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createSummarizeHandler, getCacheKey, deduplicateHeadlines } from './_summarize-handler.js';

const ORIGINAL_FETCH = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

// ── getCacheKey ──

test('getCacheKey produces stable keys for same input', () => {
  const a = getCacheKey(['A', 'B'], 'brief', '', 'full', 'en');
  const b = getCacheKey(['A', 'B'], 'brief', '', 'full', 'en');
  assert.equal(a, b);
});

test('getCacheKey varies by mode', () => {
  const brief = getCacheKey(['A'], 'brief', '', 'full', 'en');
  const analysis = getCacheKey(['A'], 'analysis', '', 'full', 'en');
  assert.notEqual(brief, analysis);
});

test('getCacheKey varies by variant', () => {
  const full = getCacheKey(['A'], 'brief', '', 'full', 'en');
  const tech = getCacheKey(['A'], 'brief', '', 'tech', 'en');
  assert.notEqual(full, tech);
});

test('getCacheKey varies by lang', () => {
  const en = getCacheKey(['A'], 'brief', '', 'full', 'en');
  const fr = getCacheKey(['A'], 'brief', '', 'full', 'fr');
  assert.notEqual(en, fr);
});

test('getCacheKey includes geoContext hash', () => {
  const noGeo = getCacheKey(['A'], 'brief', '', 'full', 'en');
  const withGeo = getCacheKey(['A'], 'brief', 'Middle East tensions', 'full', 'en');
  assert.notEqual(noGeo, withGeo);
});

test('getCacheKey translate mode uses variant as target lang', () => {
  const key = getCacheKey(['A'], 'translate', '', 'fr', 'en');
  assert.equal(key.includes(':translate:fr:'), true);
});

// ── deduplicateHeadlines ──

test('deduplicateHeadlines removes near-duplicate headlines', () => {
  const headlines = [
    'Iran tests new missile in Strait of Hormuz',
    'Iran tests new missile near Strait of Hormuz region',
    'US Treasury announces new sanctions on Russia',
  ];
  const unique = deduplicateHeadlines(headlines);
  assert.equal(unique.length, 2);
  assert.equal(unique[0], headlines[0]);
  assert.equal(unique[1], headlines[2]);
});

test('deduplicateHeadlines keeps distinct headlines', () => {
  const headlines = [
    'SpaceX launches new Starship rocket',
    'Apple announces new AI features for iPhone',
    'Bitcoin surges past $100,000 milestone',
  ];
  const unique = deduplicateHeadlines(headlines);
  assert.equal(unique.length, 3);
});

// ── createSummarizeHandler ──

test('factory creates handler that returns fallback when credentials missing', async () => {
  const handler = createSummarizeHandler({
    name: 'test-provider',
    logTag: '[Test]',
    skipReason: 'TEST_KEY not configured',
    getCredentials: () => null,
  });

  const request = new Request('https://worldmonitor.app/api/test', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': '50',
    },
    body: JSON.stringify({ headlines: ['A', 'B'] }),
  });

  const response = await handler(request);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.fallback, true);
  assert.equal(body.skipped, true);
  assert.equal(body.reason, 'TEST_KEY not configured');
});

test('factory creates handler that calls provider API and returns summary', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: 'Test summary.' } }],
    usage: { total_tokens: 10 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  const handler = createSummarizeHandler({
    name: 'test-provider',
    logTag: '[Test]',
    skipReason: 'TEST_KEY not configured',
    getCredentials: () => ({
      apiUrl: 'https://test.example.com/v1/chat/completions',
      model: 'test-model',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test' },
    }),
  });

  const request = new Request('https://worldmonitor.app/api/test', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': '50',
      'origin': 'https://tauri.localhost',
    },
    body: JSON.stringify({ headlines: ['Event A', 'Event B'] }),
  });

  const response = await handler(request);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.provider, 'test-provider');
  assert.equal(body.summary, 'Test summary.');
  assert.equal(body.cached, false);
  assert.equal(body.model, 'test-model');
});

test('factory handler returns error message with correct provider name casing', async () => {
  globalThis.fetch = async () => new Response('Internal error', { status: 500 });

  const handler = createSummarizeHandler({
    name: 'myProvider',
    logTag: '[MyProvider]',
    skipReason: 'n/a',
    getCredentials: () => ({
      apiUrl: 'https://test.example.com/v1/chat/completions',
      model: 'test-model',
      headers: { 'Content-Type': 'application/json' },
    }),
  });

  const request = new Request('https://worldmonitor.app/api/test', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': '50',
      'origin': 'https://tauri.localhost',
    },
    body: JSON.stringify({ headlines: ['Event A', 'Event B'] }),
  });

  const response = await handler(request);
  const body = await response.json();
  assert.equal(body.fallback, true);
  assert.equal(body.error, 'MyProvider API error');
});

test('factory handler returns 405 for non-POST', async () => {
  const handler = createSummarizeHandler({
    name: 'test',
    logTag: '[Test]',
    skipReason: 'n/a',
    getCredentials: () => null,
  });

  const request = new Request('https://worldmonitor.app/api/test', { method: 'GET' });
  const response = await handler(request);
  assert.equal(response.status, 405);
});

test('factory handler returns 204 for OPTIONS', async () => {
  const handler = createSummarizeHandler({
    name: 'test',
    logTag: '[Test]',
    skipReason: 'n/a',
    getCredentials: () => null,
  });

  const request = new Request('https://worldmonitor.app/api/test', { method: 'OPTIONS' });
  const response = await handler(request);
  assert.equal(response.status, 204);
});
