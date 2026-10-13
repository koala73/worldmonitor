import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { callLlm, callLlmTool, callLlmReasoning, callLlmReasoningStream } from '../server/_shared/llm.ts';
import { __testing__ as llmHealth } from '../server/_shared/llm-health.ts';
import { summarizeArticle } from '../server/worldmonitor/news/v1/summarize-article.ts';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const endpoint = 'http://127.0.0.1:4043/openai/v1/chat/completions';
const answer = 'Local fixture report describes synthetic shipping observations.';
const operatorKey = 'synthetic-isolation-operator';
const prompt = 'Synthetic private local-only observation';
beforeEach(() => {
  for (const name of ['LLM_PROVIDER', 'LLM_TOOL_PROVIDER', 'LLM_REASONING_PROVIDER', 'OLLAMA_API_URL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[name];
  Object.assign(process.env, {
    LLM_API_URL: endpoint, LLM_API_KEY: 'synthetic-local-key', LLM_API_AUTH_TYPE: 'x-bf-vk',
    LLM_MODEL: 'local/fixture', OPENROUTER_API_KEY: 'synthetic-cloud-key-must-not-be-used',
    WORLDMONITOR_VALID_KEYS: operatorKey, USAGE_TELEMETRY: '0',
  });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  llmHealth.reset();
});

const messages = [{ role: 'user' as const, content: prompt }];
const paths = {
  utility: () => callLlm({ messages }),
  tools: () => callLlmTool({ messages }),
  reasoning: () => callLlmReasoning({ messages }),
  stream: () => new Response(callLlmReasoningStream({ messages })).text(),
  summary: () => summarizeArticle({
    request: new Request('http://localhost/api/news/v1/summarize-article', { headers: { 'X-WorldMonitor-Key': operatorKey } }), pathParams: {}, headers: {},
  }, { provider: 'openrouter', headlines: [prompt], mode: 'brief', geoContext: '', variant: 'full', lang: 'en', systemAppend: '', bodies: [] }),
};

for (const selector of ['LLM_PROVIDER', 'LLM_TOOL_PROVIDER', 'LLM_REASONING_PROVIDER']) {
  for (const state of ['healthy', 'missing-url', 'invalid-auth', 'unavailable', 'redirect']) {
    test(`${selector}=generic stays exclusive across Edge model paths when ${state}`, async () => {
      process.env[selector] = ' generic ';
      if (state === 'missing-url') delete process.env.LLM_API_URL;
      if (state === 'invalid-auth') process.env.LLM_API_AUTH_TYPE = 'invalid';
      const cloudRequests: string[] = [];
      for (const [name, run] of Object.entries(paths)) {
        llmHealth.reset();
        let localPosts = 0;
        globalThis.fetch = async (input, init) => {
          const url = String(input);
          if (new URL(url).origin !== new URL(endpoint).origin) {
            cloudRequests.push(url);
            throw new Error('Unexpected cloud request');
          }
          if ((init?.method || 'GET') === 'GET') return new Response('healthy');
          localPosts++;
          // Match the Edge runtime contract exercised by seed-contract-probe.
          if (!['follow', 'manual'].includes(init?.redirect || 'follow')) throw new TypeError('Unsupported Edge redirect mode');
          assert.equal(init?.redirect, 'manual');
          if (state === 'unavailable') return new Response('offline', { status: 503 });
          if (state === 'redirect') return new Response(null, { status: 307, headers: { Location: 'https://cloud.invalid/capture' } });
          const payload = JSON.parse(String(init?.body));
          return payload.stream
            ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\ndata: [DONE]\n\n`)
            : Response.json({ choices: [{ message: { content: answer } }] });
        };
        const result = await run();
        assert.deepEqual(cloudRequests, [], `${name} must not contact any cloud origin`);
        assert.equal(localPosts, ['missing-url', 'invalid-auth'].includes(state) ? 0 : 1, `${name} local attempts`);
        if (state === 'healthy') assert.ok(JSON.stringify(result).includes(answer), `${name} must work with supported Edge redirect modes`);
        else assert.ok(!JSON.stringify(result).includes(answer), `${name} must not accept a failed or redirected completion`);
      }
    });
  }
}
