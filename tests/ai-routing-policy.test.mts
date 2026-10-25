// A customer AI routing policy must decide where that customer's AI traffic
// goes. These tests drive the real handlers and the real llm.ts with fetch
// stubbed, and read the destination host out of every outgoing request.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { callLlm, callLlmReasoningStream, resolveProviderChain } from '../server/_shared/llm.ts';
import { aiRoutingCacheSuffix, getAiRoutingDecisionForUser, toLlmRoutingPolicy } from '../server/_shared/ai-routing-policy.ts';
import { toAnthropicMessages } from '../server/_shared/llm-anthropic.ts';
import { classifyEvent } from '../server/worldmonitor/intelligence/v1/classify-event.ts';
import { searchIntelHistory } from '../server/worldmonitor/intelligence/v1/search-intel-history.ts';
import { summarizeArticle } from '../server/worldmonitor/news/v1/summarize-article.ts';
import { __testing__ as llmHealth } from '../server/_shared/llm-health.ts';

const ENV_KEYS = [
  'OPENROUTER_API_KEY', 'OLLAMA_API_URL', 'LLM_API_URL', 'LLM_API_KEY', 'LLM_MODEL',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'ANTHROPIC_REASONING_MODEL',
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'CONVEX_SITE_URL', 'CONVEX_SERVER_SHARED_SECRET',
  'LLM_REASONING_PROVIDER', 'LLM_REASONING_MODEL',
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const originalFetch = globalThis.fetch;

const RESTRICTED_USER = 'user_restricted';
const OPEN_USER = 'user_open';
const CLASSIFY_JSON = '{"level":"high","category":"conflict"}';

interface Sent { host: string; path: string; body: Record<string, unknown> | null }

type PolicyAnswer = { status: number; policy?: unknown };

/**
 * Stubs every upstream: Convex policy lookups, Upstash (records keys read),
 * Anthropic Messages API, and OpenAI-compatible chat completions.
 */
function stubUpstreams(opts: {
  policies?: Record<string, PolicyAnswer>;
  completionText?: string;
  anthropicStatus?: number;
  anthropicUsage?: Record<string, unknown>;
  streamStopReason?: string;
} = {}) {
  const sent: Sent[] = [];
  const redisKeysRead: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const rawBody = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
    let body: Record<string, unknown> | null = null;
    try { body = rawBody ? JSON.parse(String(rawBody)) : null; } catch { body = null; }

    if (url.host === 'convex.example.test' && url.pathname === '/api/internal-ai-routing-policy') {
      const answer = opts.policies?.[String(body?.userId)] ?? { status: 200, policy: null };
      return new Response(JSON.stringify({ policy: answer.policy ?? null }), { status: answer.status });
    }
    if (url.host === 'redis.example.test') {
      if (url.pathname.startsWith('/get/')) redisKeysRead.push(decodeURIComponent(url.pathname.slice(5)));
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    }
    if (url.pathname === '/' || url.pathname === '') return new Response('', { status: 200 }); // reachability probe

    sent.push({ host: url.host, path: url.pathname, body });
    const text = opts.completionText ?? CLASSIFY_JSON;
    if (url.host === 'api.anthropic.com') {
      if (opts.anthropicStatus && opts.anthropicStatus !== 200) {
        return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'boom' } }), {
          status: opts.anthropicStatus,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (body?.stream) {
        const events = [
          ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: String(body.model), content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } }],
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'analyst' } }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ['message_delta', { type: 'message_delta', delta: { stop_reason: opts.streamStopReason ?? 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }],
          ['message_stop', { type: 'message_stop' }],
        ];
        const sse = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: body?.model,
        content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: opts.anthropicUsage ?? { input_tokens: 20, output_tokens: 8 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: text }, finish_reason: 'stop' }],
      usage: { total_tokens: 12, prompt_tokens: 10, completion_tokens: 2 },
    }), { status: 200 });
  }) as typeof fetch;
  return { sent, redisKeysRead };
}

function hosts(sent: Sent[]): string[] {
  return sent.map((s) => s.host);
}

const ctxFor = (path: string, userId?: string) => ({
  request: new Request(`https://worldmonitor.app${path}`, {
    headers: userId ? { 'x-user-id': userId } : {},
  }),
  pathParams: {},
  headers: {},
}) as never;

const ANTHROPIC_ONLY: PolicyAnswer = { status: 200, policy: { allowedProviders: ['anthropic'] } };

describe('AI routing policy', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.OPENROUTER_API_KEY = 'or-test-key';
    process.env.LLM_API_URL = 'https://llm.example.test/v1/chat/completions';
    process.env.LLM_API_KEY = 'generic-test-key';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.CONVEX_SITE_URL = 'https://convex.example.test';
    process.env.CONVEX_SERVER_SHARED_SECRET = 'shared-test-secret';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    llmHealth.reset();
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  describe('resolveProviderChain', () => {
    it('uses the allowlist as the whole chain, replacing the caller order', () => {
      assert.deepEqual(
        resolveProviderChain({ providerOrder: ['openrouter', 'generic'], routingPolicy: { allowedProviders: ['anthropic'] } }),
        ['anthropic'],
      );
    });

    it('never widens an empty or unknown allowlist to the default chain', () => {
      assert.deepEqual(resolveProviderChain({ routingPolicy: { allowedProviders: [] } }), []);
      assert.deepEqual(resolveProviderChain({ routingPolicy: { allowedProviders: ['not-a-provider'] } }), []);
    });

    it('keeps a forced provider only when the policy allows it', () => {
      const routingPolicy = { allowedProviders: ['anthropic', 'openrouter'] };
      assert.deepEqual(resolveProviderChain({ forcedProvider: 'openrouter', routingPolicy }), ['openrouter']);
      assert.deepEqual(resolveProviderChain({ forcedProvider: 'ollama', routingPolicy }), ['anthropic', 'openrouter']);
    });

    it('leaves anthropic out of the default chain', () => {
      assert.equal(resolveProviderChain({}).includes('anthropic'), false);
    });
  });

  describe('policy lookup', () => {
    it('treats callers with no user id as unrestricted without a lookup', async () => {
      const { sent } = stubUpstreams();
      assert.deepEqual(await getAiRoutingDecisionForUser(null), { kind: 'default' });
      assert.equal(sent.length, 0);
    });

    it('fails closed when Convex cannot answer for a signed-in caller', async () => {
      stubUpstreams({ policies: { [RESTRICTED_USER]: { status: 500 } } });
      const decision = await getAiRoutingDecisionForUser(RESTRICTED_USER);
      assert.deepEqual(decision, { kind: 'unavailable' });
      assert.deepEqual(toLlmRoutingPolicy(decision), { allowedProviders: [] });
    });

    it('fails closed when the lookup backend is not configured', async () => {
      delete process.env.CONVEX_SITE_URL;
      stubUpstreams();
      assert.deepEqual(await getAiRoutingDecisionForUser(RESTRICTED_USER), { kind: 'unavailable' });
    });

    it('fails closed on a malformed policy body', async () => {
      stubUpstreams({ policies: { [RESTRICTED_USER]: { status: 200, policy: { allowedProviders: 'anthropic' } } } });
      assert.deepEqual(await getAiRoutingDecisionForUser(RESTRICTED_USER), { kind: 'unavailable' });
    });

    it('gives unrestricted callers the existing cache namespace', () => {
      assert.equal(aiRoutingCacheSuffix({ kind: 'default' }), '');
      assert.equal(aiRoutingCacheSuffix({ kind: 'restricted', allowedProviders: ['anthropic'] }), ':ai=anthropic');
    });
  });

  describe('Anthropic adapter', () => {
    it('moves system messages to the top-level system field', () => {
      assert.deepEqual(toAnthropicMessages([
        { role: 'system', content: 'S1' },
        { role: 'user', content: 'U1' },
        { role: 'system', content: 'S2' },
      ]), { system: 'S1\n\nS2', messages: [{ role: 'user', content: 'U1' }] });
    });

    it('sends a Messages API request without temperature, with effort and refusal fallback', async () => {
      const { sent } = stubUpstreams({ completionText: 'An answer' });
      const result = await callLlm({
        messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'q' }],
        temperature: 0.3,
        maxTokens: 200,
        routingPolicy: { allowedProviders: ['anthropic'] },
      });
      assert.equal(result?.content, 'An answer');
      assert.equal(result?.provider, 'anthropic');
      assert.equal(result?.model, 'claude-opus-5-5');
      assert.equal(result?.tokens, 28);
      assert.equal(sent.length, 1);
      const body = sent[0]!.body!;
      assert.equal(sent[0]!.host, 'api.anthropic.com');
      assert.equal('temperature' in body, false);
      assert.equal(body.system, 'sys');
      assert.deepEqual(body.output_config, { effort: 'low' });
      assert.equal(body.fallbacks, 'default');
      assert.ok(Number(body.max_tokens) > 200, 'thinking headroom on top of the visible budget');
    });

    it('returns null instead of falling back when Anthropic fails', async () => {
      const { sent } = stubUpstreams({ anthropicStatus: 529 });
      const result = await callLlm({
        messages: [{ role: 'user', content: 'q' }],
        routingPolicy: { allowedProviders: ['anthropic'] },
      });
      assert.equal(result, null);
      assert.deepEqual(hosts(sent), ['api.anthropic.com']);
    });

    it('keeps the policy fallback order when it overrides a forced provider', async () => {
      const { sent } = stubUpstreams({ anthropicStatus: 529, completionText: 'From OpenRouter' });
      const result = await callLlm({
        messages: [{ role: 'user', content: 'q' }],
        provider: 'ollama',
        routingPolicy: { allowedProviders: ['anthropic', 'openrouter'] },
      });
      assert.equal(result?.provider, 'openrouter');
      assert.deepEqual(hosts(sent), ['api.anthropic.com', 'openrouter.ai']);
    });

    it('counts every billed attempt when the refusal fallback ran', async () => {
      stubUpstreams({
        completionText: 'An answer',
        anthropicUsage: {
          input_tokens: 20, output_tokens: 8,
          iterations: [
            { type: 'message', input_tokens: 20, output_tokens: 3 },
            { type: 'fallback_message', input_tokens: 20, output_tokens: 8 },
          ],
        },
      });
      const result = await callLlm({
        messages: [{ role: 'user', content: 'q' }],
        routingPolicy: { allowedProviders: ['anthropic'] },
      });
      assert.equal(result?.tokens, 51);
    });

    it('does not report a token-limited stream as done', async () => {
      stubUpstreams({ streamStopReason: 'max_tokens' });
      const stream = callLlmReasoningStream({
        messages: [{ role: 'user', content: 'hi' }],
        routingPolicy: { allowedProviders: ['anthropic'] },
      });
      const text = await new Response(stream).text();
      assert.match(text, /"delta":"Hello "/);
      assert.doesNotMatch(text, /"done":true/);
    });

    it('streams only from Anthropic under the policy', async () => {
      process.env.LLM_REASONING_PROVIDER = 'openrouter';
      const { sent } = stubUpstreams();
      const stream = callLlmReasoningStream({
        messages: [{ role: 'user', content: 'hi' }],
        routingPolicy: { allowedProviders: ['anthropic'] },
      });
      const text = await new Response(stream).text();
      assert.match(text, /"delta":"Hello "/);
      assert.match(text, /"delta":"analyst"/);
      assert.match(text, /"done":true/);
      assert.deepEqual(hosts(sent), ['api.anthropic.com']);
    });
  });

  describe('handlers', () => {
    it('classify_event: a restricted caller reaches only Anthropic and its own cache namespace', async () => {
      process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
      process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
      const { sent, redisKeysRead } = stubUpstreams({ policies: { [RESTRICTED_USER]: ANTHROPIC_ONLY } });
      const res = await classifyEvent(ctxFor('/api/intelligence/v1/classify-event', RESTRICTED_USER), {
        title: 'Senate passes sanctions package', description: '', source: '', country: '',
      });
      assert.equal(res.classification?.subcategory, 'high');
      assert.deepEqual(hosts(sent), ['api.anthropic.com']);
      const classifyKeys = redisKeysRead.filter((k) => k.includes('classify:sebuf:'));
      assert.ok(classifyKeys.length > 0);
      assert.ok(classifyKeys.every((k) => k.endsWith(':ai=anthropic')), classifyKeys.join(','));
    });

    it('classify_event: an unrestricted caller keeps the default chain and shared cache key', async () => {
      process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
      process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
      const { sent, redisKeysRead } = stubUpstreams();
      await classifyEvent(ctxFor('/api/intelligence/v1/classify-event', OPEN_USER), {
        title: 'Senate passes sanctions package', description: '', source: '', country: '',
      });
      assert.deepEqual(hosts(sent), ['openrouter.ai']);
      const classifyKeys = redisKeysRead.filter((k) => k.includes('classify:sebuf:'));
      assert.ok(classifyKeys.length > 0);
      assert.ok(classifyKeys.every((k) => !k.includes(':ai=')), classifyKeys.join(','));
    });

    it('classify_event: an unverifiable policy sends the text nowhere', async () => {
      const { sent } = stubUpstreams({ policies: { [RESTRICTED_USER]: { status: 503 } } });
      const res = await classifyEvent(ctxFor('/api/intelligence/v1/classify-event', RESTRICTED_USER), {
        title: 'Senate passes sanctions package', description: '', source: '', country: '',
      });
      assert.equal(res.classification, undefined);
      assert.deepEqual(sent, []);
    });

    it('summarize_article: the client-named provider is replaced by the allowed one', async () => {
      const { sent } = stubUpstreams({
        policies: { [RESTRICTED_USER]: ANTHROPIC_ONLY },
        completionText: 'Les sanctions ont été adoptées par le Sénat.',
      });
      const res = await summarizeArticle(ctxFor('/api/news/v1/summarize-article', RESTRICTED_USER), {
        provider: 'openrouter',
        headlines: ['Senate passes sanctions package'],
        mode: 'translate',
        geoContext: '',
        variant: 'fr',
        lang: 'en',
        systemAppend: '',
        bodies: [],
      } as never);
      assert.equal(res.provider, 'anthropic');
      assert.equal(res.status, 'SUMMARIZE_STATUS_SUCCESS');
      assert.deepEqual(hosts(sent), ['api.anthropic.com']);
    });

    it('summarize_article: an unrestricted caller cannot name the opt-in anthropic provider', async () => {
      const { sent } = stubUpstreams();
      const res = await summarizeArticle(ctxFor('/api/news/v1/summarize-article'), {
        provider: 'anthropic', headlines: ['Senate passes sanctions package'], mode: 'translate',
        geoContext: '', variant: 'fr', lang: 'en', systemAppend: '', bodies: [],
      } as never);
      assert.equal(res.status, 'SUMMARIZE_STATUS_SKIPPED');
      assert.deepEqual(sent, []);
    });

    it('summarize_article: a restricted caller falls back along the policy chain', async () => {
      const { sent } = stubUpstreams({
        policies: { [RESTRICTED_USER]: { status: 200, policy: { allowedProviders: ['anthropic', 'openrouter'] } } },
        anthropicStatus: 529,
        completionText: 'Les sanctions ont été adoptées par le Sénat.',
      });
      const res = await summarizeArticle(ctxFor('/api/news/v1/summarize-article', RESTRICTED_USER), {
        provider: 'ollama', headlines: ['Senate passes sanctions package'], mode: 'translate',
        geoContext: '', variant: 'fr', lang: 'en', systemAppend: '', bodies: [],
      } as never);
      assert.equal(res.status, 'SUMMARIZE_STATUS_SUCCESS');
      assert.equal(res.provider, 'openrouter');
      assert.deepEqual(hosts(sent), ['api.anthropic.com', 'openrouter.ai']);
    });

    it('search_intel_history: refuses instead of sending the query to OpenRouter embeddings', async () => {
      const { sent } = stubUpstreams({ policies: { [RESTRICTED_USER]: ANTHROPIC_ONLY } });
      await assert.rejects(
        searchIntelHistory(ctxFor('/api/intelligence/v1/search-intel-history', RESTRICTED_USER), {
          query: 'strait closure', domain: '', country: '', from: 0, to: 0, limit: 0,
        } as never),
        (err: Error & { statusCode?: number }) => err.name === 'ApiError' && err.statusCode === 403,
      );
      assert.deepEqual(sent, []);
    });
  });
});
