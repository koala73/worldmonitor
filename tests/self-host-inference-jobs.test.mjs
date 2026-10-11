import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { buildGenericLlmProvider, isGenericLlmSelected } from '../scripts/shared/generic-llm-provider.mjs';
import { callLLM as callBrief } from '../scripts/lib/llm-chain.cjs';
import { generateWhyMatters, generateStoryDescription, generateDigestProse } from '../scripts/lib/brief-llm.mjs';
import { embedBatch, EmbeddingProviderError } from '../scripts/lib/brief-embedding.mjs';

const envNames = [
  'LLM_PROVIDER', 'LLM_TOOL_PROVIDER', 'LLM_REASONING_PROVIDER', 'LLM_API_URL',
  'LLM_API_KEY', 'LLM_API_AUTH_TYPE', 'LLM_MODEL', 'OPENROUTER_API_KEY',
  'OLLAMA_API_URL', 'LLM_EMBEDDING_API_URL', 'LLM_EMBEDDING_MODEL', 'USAGE_TELEMETRY',
];
const savedEnv = new Map(envNames.map((name) => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
const endpoint = 'http://127.0.0.1:4043/openai/v1/chat/completions';
const prose = 'This threatens shipping through the Strait of Hormuz, raising insurance costs and delaying oil deliveries.';

beforeEach(() => {
  for (const name of envNames) delete process.env[name];
  Object.assign(process.env, {
    LLM_PROVIDER: 'generic', LLM_API_URL: endpoint, LLM_API_KEY: 'local-test-key',
    LLM_API_AUTH_TYPE: 'x-bf-vk', LLM_MODEL: 'local/test-model',
    // A local failure must not silently consume a configured cloud credential.
    OPENROUTER_API_KEY: 'cloud-test-key', USAGE_TELEMETRY: '0',
  });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const jobs = [
  ['insights', async () => (await import('../scripts/seed-insights.mjs')).callLLM('Oil shipping faces disruption', { retryDelayMs: 0 })],
  ['regional narrative', async () => (await import('../scripts/regional-snapshot/narrative.mjs')).callLlmDefault({ systemPrompt: 'System', userPrompt: 'Evidence' }, { retryDelayMs: 0 })],
  ['regional weekly brief', async () => (await import('../scripts/regional-snapshot/weekly-brief.mjs')).callLlmDefault({ systemPrompt: 'System', userPrompt: 'Evidence' })],
  ['brief prose', () => callBrief('System', 'Evidence', { allowedProviders: ['generic'] })],
];

for (const [name, run] of jobs) {
  test(`${name} sends the configured model and raw Bifrost virtual key`, async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return Response.json({ choices: [{ message: { content: prose } }], model: 'local/actual-model' });
    };
    const result = await run();
    assert.ok(result);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, endpoint);
    assert.equal(calls[0].init.headers['x-bf-vk'], 'local-test-key');
    assert.equal(calls[0].init.headers.Authorization, undefined);
    assert.equal(JSON.parse(calls[0].init.body).model, 'local/test-model');
  });

  test(`${name} keeps a failed generic request local`, async () => {
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(url);
      return new Response('', { status: 401 });
    };
    assert.equal(await run(), null);
    assert.ok(urls.length > 0);
    assert.ok(urls.every((url) => url === endpoint));
  });

  test(`${name} rejects invalid generic authentication without a request`, async () => {
    process.env.LLM_API_AUTH_TYPE = 'unknown';
    globalThis.fetch = () => assert.fail('Invalid configuration must not send a credential');
    assert.equal(await run(), null);
  });
}

test('generic selection honors explicit job settings and preserves hosted defaults', () => {
  assert.equal(isGenericLlmSelected({ OPENROUTER_API_KEY: 'cloud' }), false);
  assert.equal(isGenericLlmSelected({ LLM_REASONING_PROVIDER: 'generic', OPENROUTER_API_KEY: 'cloud' }), true);
  assert.equal(isGenericLlmSelected({ LLM_TOOL_PROVIDER: 'generic', OPENROUTER_API_KEY: 'cloud' }), true);
  assert.equal(isGenericLlmSelected({ LLM_API_URL: endpoint }), true);
  assert.equal(buildGenericLlmProvider({ LLM_API_URL: endpoint }), null);
  const provider = buildGenericLlmProvider({ LLM_API_URL: endpoint, LLM_API_KEY: 'bearer-key', LLM_MODEL: 'local/model' });
  assert.equal(provider.headers().Authorization, 'Bearer bearer-key');
});

const story = {
  category: 'Diplomacy', country: 'IR', threatLevel: 'critical', source: 'Reuters',
  headline: 'Iran threatens to close Strait of Hormuz',
  description: 'Iran threatens to close Strait of Hormuz, disrupting oil shipping.',
};

test('brief generation avoids the hosted analyst and partitions the model cache', async () => {
  const cache = new Map();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return Response.json({ choices: [{ message: { content: prose } }] });
  };
  const deps = {
    callLLM: callBrief,
    callAnalystWhyMatters: () => assert.fail('Local mode must not call the hosted analyst'),
    cacheGet: async (key) => cache.get(key),
    cacheSet: async (key, value) => { cache.set(key, value); },
  };
  assert.equal(await generateWhyMatters(story, deps), prose);
  assert.equal(await generateWhyMatters(story, deps), prose);
  assert.equal(calls.length, 1);
  process.env.LLM_MODEL = 'local/second-model';
  assert.equal(await generateWhyMatters(story, deps), prose);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.model, 'local/second-model');
  assert.equal(cache.size, 2);
  assert.ok([...cache.keys()].every((key) => key.includes(':generic:') && !key.includes('local-test-key')));
});

test('description and digest pass only generic to their transport', async () => {
  const options = [];
  const deps = {
    callLLM: async (_system, _user, opts) => { options.push(opts); return null; },
    cacheGet: async () => null, cacheSet: async () => {},
  };
  await generateStoryDescription(story, deps);
  await generateDigestProse('local-operator', [story], 'medium', deps);
  assert.equal(options.length, 2);
  for (const opts of options) {
    assert.deepEqual(opts.allowedProviders, ['generic']);
    assert.deepEqual(opts.modelOverrides, { generic: 'local/test-model' });
  }
});

test('generic embeddings use Bifrost and keep different vector spaces in separate caches', async () => {
  process.env.LLM_EMBEDDING_API_URL = 'http://127.0.0.1:4043/openai/v1/embeddings';
  process.env.LLM_EMBEDDING_MODEL = 'local/embedding-model';
  const cache = new Map();
  const calls = [];
  const deps = {
    redisPipeline: async (commands) => commands.map(([command, key, value]) => {
      if (command === 'SET') { cache.set(key, value); return { result: 'OK' }; }
      return { result: cache.get(key) ?? null };
    }),
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return Response.json({ data: [{ index: 0, embedding: Array(512).fill(calls.length) }] });
    },
  };
  const first = await embedBatch(['shipping disruption'], deps);
  assert.deepEqual(await embedBatch(['shipping disruption'], deps), first);
  assert.equal(calls.length, 1);
  process.env.LLM_EMBEDDING_MODEL = 'local/second-embedding-model';
  const second = await embedBatch(['shipping disruption'], deps);
  assert.notDeepEqual(second, first);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, process.env.LLM_EMBEDDING_API_URL);
  assert.equal(calls[0].init.headers['x-bf-vk'], 'local-test-key');
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[0].body.model, 'local/embedding-model');
  assert.equal(calls[0].body.dimensions, 512);
  assert.equal(cache.size, 2);
});

test('missing local embeddings never fall back to OpenRouter', async () => {
  await assert.rejects(embedBatch(['shipping disruption'], {
    fetch: () => assert.fail('No embedding request is allowed without local configuration'),
    redisPipeline: () => assert.fail('Invalid embedding configuration must not read a foreign vector space'),
  }), EmbeddingProviderError);
});
