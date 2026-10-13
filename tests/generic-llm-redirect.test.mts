import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { afterEach, beforeEach, test } from 'node:test';

import { callLlm, callLlmTool, callLlmReasoning, callLlmReasoningStream } from '../server/_shared/llm.ts';
import { __testing__ as llmHealth } from '../server/_shared/llm-health.ts';
import { summarizeArticle } from '../server/worldmonitor/news/v1/summarize-article.ts';
import { callLLM as callInsights } from '../scripts/seed-insights.mjs';
import { callForecastLLM } from '../scripts/seed-forecasts.mjs';
import { callLlmDefault as callNarrative } from '../scripts/regional-snapshot/narrative.mjs';
import { callLlmDefault as callWeeklyBrief } from '../scripts/regional-snapshot/weekly-brief.mjs';
import { callLLM as callBrief } from '../scripts/lib/llm-chain.cjs';
import { embedBatch, EmbeddingProviderError } from '../scripts/lib/brief-embedding.mjs';
import { createGenericWidgetClient } from '../scripts/lib/widget-llm-client.cjs';
import { buildGenericLlmProvider, isGenericLlmSelected } from '../scripts/shared/generic-llm-provider.mjs';

const originalFetch = globalThis.fetch;
const prompt = 'Synthetic private shipping observation for redirect isolation';
const virtualKey = 'redirect-fixture-virtual-key';
const operatorKey = 'redirect-fixture-operator-key';
const envNames = [
  'LLM_PROVIDER', 'LLM_TOOL_PROVIDER', 'LLM_REASONING_PROVIDER', 'LLM_REASONING_MODEL',
  'LLM_API_URL', 'LLM_API_KEY', 'LLM_API_AUTH_TYPE', 'LLM_MODEL',
  'LLM_EMBEDDING_API_URL', 'LLM_EMBEDDING_MODEL', 'OPENROUTER_API_KEY',
  'OLLAMA_API_URL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'WORLDMONITOR_VALID_KEYS', 'USAGE_TELEMETRY',
];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  for (const name of envNames) delete process.env[name];
  Object.assign(process.env, {
    LLM_PROVIDER: 'generic', LLM_API_KEY: virtualKey, LLM_API_AUTH_TYPE: 'x-bf-vk',
    LLM_MODEL: 'local/redirect-fixture', LLM_EMBEDDING_MODEL: 'local/embedding-fixture',
    OPENROUTER_API_KEY: 'cloud-fixture-key-must-not-be-used',
    WORLDMONITOR_VALID_KEYS: operatorKey, USAGE_TELEMETRY: '0',
  });
  llmHealth.reset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  llmHealth.reset();
});

type CapturedRequest = { headers: http.IncomingHttpHeaders; body: string };

async function listen(server: http.Server) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function capture(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return { headers: request.headers, body: Buffer.concat(chunks).toString('utf8') };
}

// Both origins are real HTTP servers. A mocked fetch alone would not reveal
// that native fetch forwards custom authentication headers and POST bodies on 307.
async function redirectFixture() {
  const accepted: CapturedRequest[] = [];
  const leaked: CapturedRequest[] = [];
  const destination = http.createServer(async (req, res) => {
    leaked.push(await capture(req));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: 'Unexpected redirected completion with synthetic shipping details.' } }],
      data: [{ index: 0, embedding: Array(512).fill(1) }],
    }));
  });
  const destinationOrigin = await listen(destination);
  const source = http.createServer(async (req, res) => {
    if (req.method === 'GET') { res.end('healthy'); return; }
    accepted.push(await capture(req));
    res.writeHead(307, { Location: `${destinationOrigin}/capture` });
    res.end();
  });
  const sourceOrigin = await listen(source);
  return {
    sourceOrigin, destinationOrigin, accepted, leaked,
    async close() {
      await Promise.all([source, destination].map(server => new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      })));
    },
  };
}

const messages = [{ role: 'user' as const, content: prompt }];
const runs: Array<[string, () => Promise<unknown>, (result: unknown) => void]> = [
  ['shared utility', () => callLlm({ messages }), result => assert.equal(result, null)],
  ['shared tools', () => callLlmTool({ messages }), result => assert.equal(result, null)],
  ['shared reasoning', () => callLlmReasoning({ messages }), result => assert.equal(result, null)],
  ['shared streaming', () => new Response(callLlmReasoningStream({ messages })).text(), result => {
    assert.doesNotMatch(String(result), /Unexpected redirected completion/);
  }],
  ['article summaries', () => summarizeArticle({
    request: new Request('http://localhost/api/news/v1/summarize-article', { headers: { 'X-WorldMonitor-Key': operatorKey } }),
    pathParams: {}, headers: {},
  }, { provider: 'openrouter', headlines: [prompt], mode: 'brief', geoContext: '', variant: 'full', lang: 'en', systemAppend: '', bodies: [] }), result => {
    assert.equal((result as { status: string }).status, 'SUMMARIZE_STATUS_ERROR');
  }],
  ['insights', () => callInsights(prompt, { retryDelayMs: 0 }), result => assert.equal(result, null)],
  ['forecasts', () => callForecastLLM('System', prompt, { maxRetries: 0 }), result => assert.equal(result, null)],
  ['regional narrative', () => callNarrative({ systemPrompt: 'System', userPrompt: prompt }, { retryDelayMs: 0 }), result => assert.equal(result, null)],
  ['regional weekly brief', () => callWeeklyBrief({ systemPrompt: 'System', userPrompt: prompt }), result => assert.equal(result, null)],
  ['brief prose', () => callBrief('System', prompt), result => assert.equal(result, null)],
  ['embeddings', () => embedBatch([prompt], { redisPipeline: async commands => commands.map(() => ({ result: null })) }), result => {
    assert.ok(result instanceof EmbeddingProviderError);
  }],
  ['widget tool model', () => createGenericWidgetClient().messages.create({ messages, max_tokens: 100 }), result => {
    assert.ok(result instanceof TypeError);
  }],
  ['relay classification', async () => {
    const relay = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
    const extract = (name: string) => {
      const match = relay.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
      assert.ok(match);
      return match[0];
    };
    const context = vm.createContext({
      http, https, Buffer, URL, process, console,
      buildGenericLlmProvider, isGenericLlmSelected,
      CLASSIFY_SYSTEM_PROMPT: 'Classify synthetic news.',
      CLASSIFY_LLM_PROVIDERS: [{ name: 'openrouter', envKey: 'OPENROUTER_API_KEY' }],
    });
    vm.runInContext(['classifyFetchLlmSingle', 'getClassifyLlmProviders', 'classifyFetchLlm'].map(extract).join('\n'), context);
    return context.classifyFetchLlm([prompt]);
  }, result => assert.equal(result, null)],
];

for (const [name, run, verifyResult] of runs) {
  test(`${name} never forwards the virtual key or prompt to an HTTP 307 destination`, async t => {
    const fixture = await redirectFixture();
    t.after(() => fixture.close());
    process.env.LLM_API_URL = `${fixture.sourceOrigin}/v1/chat/completions`;
    process.env.LLM_EMBEDDING_API_URL = `${fixture.sourceOrigin}/v1/embeddings`;
    const unexpectedOrigins: string[] = [];
    // Prevent any unrelated configured service from receiving the test prompt.
    // Redirect handling still happens inside real fetch and reaches the sink
    // if the production request follows the redirect instead of rejecting it.
    globalThis.fetch = async (input, init) => {
      const origin = new URL(input instanceof Request ? input.url : String(input)).origin;
      if (![fixture.sourceOrigin, fixture.destinationOrigin].includes(origin)) {
        unexpectedOrigins.push(origin);
        throw new Error('Unexpected nonfixture request');
      }
      return originalFetch(input, init);
    };
    const result = await run().catch(error => error);
    assert.ok(fixture.accepted.length > 0, 'The test must exercise a real model request');
    for (const request of fixture.accepted) {
      assert.equal(request.headers['x-bf-vk'], virtualKey);
      assert.ok(request.body.includes(prompt), 'The original request must contain the private prompt');
    }
    assert.deepEqual(fixture.leaked, [], 'The redirected origin must receive neither credentials nor prompt');
    assert.deepEqual(unexpectedOrigins, [], 'No cloud fallback is permitted');
    verifyResult(result);
  });
}
