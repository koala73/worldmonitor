import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

// Ollama's /v1/chat/completions binds the body into a struct with no `think`
// field, so `think: false` is dropped and a reasoning model thinks anyway.
// `reasoning_effort: 'none'` is the field that endpoint reads.
const OLLAMA_CALL_SITES = [
  'server/_shared/llm.ts',
  'scripts/lib/llm-chain.cjs',
  'scripts/ais-relay.cjs',
  'scripts/seed-insights.mjs',
];

test('every Ollama provider config turns reasoning off with reasoning_effort', () => {
  for (const file of OLLAMA_CALL_SITES) {
    const source = readFileSync(resolve(root, file), 'utf8');
    assert.ok(!/\bthink:\s*false/.test(source), `${file} sends think, which Ollama ignores`);
    assert.match(source, /extraBody:\s*\{\s*reasoning_effort:\s*'none'\s*\}/, file);
  }
});

test('llm-chain sends reasoning_effort none to Ollama', async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.OLLAMA_API_URL;
  const bodies = [];
  process.env.OLLAMA_API_URL = 'http://127.0.0.1:11434';
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/v1/chat/completions')) bodies.push(JSON.parse(init.body));
    return Response.json({ choices: [{ message: { content: 'Eine neue Plattform.' }, finish_reason: 'stop' }] });
  };
  try {
    const { callLLM } = require('../scripts/lib/llm-chain.cjs');
    const text = await callLLM('Translate to German.', 'A new platform.', { allowedProviders: ['ollama'] });
    assert.equal(text, 'Eine neue Plattform.');
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].reasoning_effort, 'none');
    assert.equal('think' in bodies[0], false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.OLLAMA_API_URL;
    else process.env.OLLAMA_API_URL = originalUrl;
  }
});
