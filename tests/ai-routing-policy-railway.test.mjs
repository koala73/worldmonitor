// The Railway jobs that put one user's data into an LLM prompt (AI alert
// impact, personalised digest prose) must honour that user's AI routing
// policy. These tests drive the real llm-chain, the real relay impact path and
// the real digest synthesis with fetch stubbed, and read every outgoing host.
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, it } from 'node:test';

const require = createRequire(import.meta.url);

// The relay's delivery SDKs live in scripts/node_modules on Railway; this suite
// never reaches them, so stub them like the other relay suites do.
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, ...rest) {
  if (request === 'resend') return { Resend: class {} };
  if (request === 'convex/browser') return { ConvexHttpClient: class { async query() {} } };
  return originalLoad.call(this, request, parent, ...rest);
};

const ENV = {
  AI_IMPACT_ENABLED: '1',
  CONVEX_URL: 'https://convex.example.cloud',
  CONVEX_SITE_URL: 'https://convex.example.test',
  CONVEX_NOTIFICATION_RELAY_SECRET: 'relay-delivery-secret',
  UPSTASH_REDIS_REST_URL: 'https://redis.example.test',
  UPSTASH_REDIS_REST_TOKEN: 'redis-token',
  OPENROUTER_API_KEY: 'or-test-key',
  ANTHROPIC_API_KEY: 'sk-ant-test',
};
const originalEnv = Object.fromEntries(
  [...Object.keys(ENV), 'OLLAMA_API_URL', 'ANTHROPIC_MODEL'].map((k) => [k, process.env[k]]),
);
// Module-level constants in the relay and user-context read env at require time.
Object.assign(process.env, ENV);
delete process.env.OLLAMA_API_URL;

const { callLLM } = require('../scripts/lib/llm-chain.cjs');
const {
  createAiRoutingPolicyResolver,
  withAiRoutingPolicy,
  aiRoutingCacheSuffix,
} = require('../scripts/lib/ai-routing-policy.cjs');
const { generateEventImpact } = require('../scripts/notification-relay.cjs');
const { runSynthesisWithFallback } = await import('../scripts/lib/digest-orchestration-helpers.mjs');

const originalFetch = globalThis.fetch;
const RESTRICTED = { kind: 'restricted', allowedProviders: ['anthropic'] };

/** Records every request; answers Convex, Upstash, Anthropic and OpenRouter. */
function stubFetch({ policies = {}, anthropicStatus = 200, text = 'Direct impact on your NVDA position.' } = {}) {
  const llmHosts = [];
  const llmBodies = [];
  const redisPaths = [];
  const convexCalls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const raw = init.body ?? (input instanceof Request ? await input.clone().text() : undefined);
    let body = null;
    try { body = raw ? JSON.parse(String(raw)) : null; } catch { body = null; }
    const auth = init.headers instanceof Headers ? init.headers.get('authorization') : init.headers?.Authorization;

    if (url.host === 'convex.example.test') {
      convexCalls.push({ path: url.pathname, auth, body });
      if (url.pathname === '/relay/ai-routing-policy') {
        const answer = policies[body?.userId] ?? { status: 200, policy: null };
        return new Response(JSON.stringify({ policy: answer.policy ?? null }), { status: answer.status });
      }
      if (url.pathname === '/relay/user-preferences') {
        return new Response(JSON.stringify({ 'wm-market-watchlist-v1': [{ symbol: 'NVDA' }] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }
    if (url.host === 'redis.example.test') {
      redisPaths.push(decodeURIComponent(url.pathname));
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    }
    llmHosts.push(url.host);
    llmBodies.push(body);
    if (url.host === 'api.anthropic.com') {
      if (anthropicStatus !== 200) {
        return new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }), {
          status: anthropicStatus, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: body?.model,
        content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 30, output_tokens: 9 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: text }, finish_reason: 'stop' }],
      usage: { total_tokens: 12, prompt_tokens: 10, completion_tokens: 2 },
    }), { status: 200 });
  };
  return { llmHosts, llmBodies, redisPaths, convexCalls };
}

const EVENT = { eventType: 'rss_alert', severity: 'high', payload: { title: 'Chip export controls widened', source: 'Reuters' } };

describe('AI routing policy on Railway jobs', () => {
  beforeEach(() => {
    Object.assign(process.env, ENV);
    delete process.env.ANTHROPIC_MODEL;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Restore the process env for whatever runs after this file.
  process.on('exit', () => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe('llm-chain', () => {
    it('never reaches anthropic from the default chain', async () => {
      const { llmHosts } = stubFetch();
      assert.ok(await callLLM('sys', 'user'));
      assert.deepEqual(llmHosts, ['openrouter.ai']);
    });

    it('sends an allowlisted anthropic call as a Messages API request', async () => {
      const { llmHosts, llmBodies } = stubFetch({ text: 'Answer' });
      const out = await callLLM('sys', 'user', { maxTokens: 200, temperature: 0.4, allowedProviders: ['anthropic'] });
      assert.equal(out, 'Answer');
      assert.deepEqual(llmHosts, ['api.anthropic.com']);
      const body = llmBodies[0];
      assert.equal(body.model, 'claude-opus-5-5');
      assert.equal(body.system, 'sys');
      assert.equal('temperature' in body, false);
      assert.deepEqual(body.output_config, { effort: 'low' });
      assert.equal(body.fallbacks, 'default');
      assert.ok(body.max_tokens > 200);
    });

    it('reaches no provider for an empty or unknown allowlist', async () => {
      const { llmHosts } = stubFetch();
      assert.equal(await callLLM('sys', 'user', { allowedProviders: [] }), null);
      assert.equal(await callLLM('sys', 'user', { allowedProviders: ['not-a-provider'] }), null);
      assert.deepEqual(llmHosts, []);
    });

    it('falls back in policy order, not array order', async () => {
      const { llmHosts } = stubFetch({ anthropicStatus: 529 });
      assert.ok(await callLLM('sys', 'user', { allowedProviders: ['anthropic', 'openrouter'] }));
      assert.deepEqual(llmHosts, ['api.anthropic.com', 'openrouter.ai']);
    });
  });

  describe('policy resolver', () => {
    it('skips the lookup for callers with no user id', async () => {
      const { convexCalls } = stubFetch();
      const resolve = createAiRoutingPolicyResolver({ siteUrl: ENV.CONVEX_SITE_URL, secret: 's' });
      assert.deepEqual(await resolve(null), { kind: 'default' });
      assert.equal(convexCalls.length, 0);
    });

    it('authenticates with the delivery secret and caches a confirmed answer', async () => {
      const { convexCalls } = stubFetch({ policies: { u1: { status: 200, policy: { allowedProviders: ['anthropic'] } } } });
      const resolve = createAiRoutingPolicyResolver({ siteUrl: ENV.CONVEX_SITE_URL, secret: 'relay-delivery-secret' });
      assert.deepEqual(await resolve('u1'), RESTRICTED);
      assert.deepEqual(await resolve('u1'), RESTRICTED);
      assert.equal(convexCalls.length, 1);
      assert.equal(convexCalls[0].auth, 'Bearer relay-delivery-secret');
      assert.deepEqual(convexCalls[0].body, { userId: 'u1' });
    });

    it('fails closed, without caching, when Convex cannot answer', async () => {
      const { convexCalls } = stubFetch({ policies: { u1: { status: 503 } } });
      const resolve = createAiRoutingPolicyResolver({ siteUrl: ENV.CONVEX_SITE_URL, secret: 's' });
      assert.deepEqual(await resolve('u1'), { kind: 'unavailable' });
      assert.deepEqual(await resolve('u1'), { kind: 'unavailable' });
      assert.equal(convexCalls.length, 2);
    });

    it('fails closed when not configured', async () => {
      stubFetch();
      const resolve = createAiRoutingPolicyResolver({ siteUrl: '', secret: '' });
      assert.deepEqual(await resolve('u1'), { kind: 'unavailable' });
    });

    it('wraps deps so calls use the policy list and caches use its namespace', async () => {
      const calls = [];
      const keys = [];
      const deps = {
        callLLM: async (_s, _u, opts) => { calls.push(opts.allowedProviders); return null; },
        cacheGet: async (k) => { keys.push(k); return null; },
        cacheSet: async (k) => { keys.push(k); },
      };
      assert.equal(withAiRoutingPolicy(deps, { kind: 'default' }), deps);
      const wrapped = withAiRoutingPolicy(deps, RESTRICTED);
      await wrapped.callLLM('s', 'u', { allowedProviders: ['openrouter'] });
      await wrapped.cacheGet('k');
      assert.deepEqual(calls, [['anthropic']]);
      assert.deepEqual(keys, ['k:ai=anthropic']);
      const blocked = withAiRoutingPolicy(deps, { kind: 'unavailable' });
      await blocked.callLLM('s', 'u', {});
      assert.deepEqual(calls.at(-1), []);
      assert.equal(aiRoutingCacheSuffix({ kind: 'unavailable' }), ':ai=none');
    });
  });

  describe('notification relay AI impact', () => {
    it('sends a restricted user\'s profile only to Anthropic and caches it apart', async () => {
      const { llmHosts, redisPaths } = stubFetch({
        policies: { 'user-restricted': { status: 200, policy: { allowedProviders: ['anthropic'] } } },
      });
      const impact = await generateEventImpact(EVENT, { userId: 'user-restricted', variant: 'full' });
      assert.equal(impact, 'Direct impact on your NVDA position.');
      assert.deepEqual(llmHosts, ['api.anthropic.com']);
      const impactKeys = redisPaths.filter((p) => p.includes('impact:ai:'));
      assert.ok(impactKeys.length >= 2, impactKeys.join(','));
      assert.ok(impactKeys.every((p) => p.includes(':ai=anthropic')), impactKeys.join(','));
    });

    it('keeps an unrestricted user on the default chain and shared key', async () => {
      const { llmHosts, redisPaths } = stubFetch();
      await generateEventImpact(EVENT, { userId: 'user-open', variant: 'full' });
      assert.deepEqual(llmHosts, ['openrouter.ai']);
      assert.ok(redisPaths.filter((p) => p.includes('impact:ai:')).every((p) => !p.includes(':ai=')));
    });

    it('sends nothing when the policy cannot be verified', async () => {
      const { llmHosts } = stubFetch({ policies: { 'user-unknown': { status: 500 } } });
      assert.equal(await generateEventImpact(EVENT, { userId: 'user-unknown', variant: 'full' }), null);
      assert.deepEqual(llmHosts, []);
    });
  });

  describe('digest prose', () => {
    it('routes both personalised synthesis levels through the policy', async () => {
      const calls = [];
      const keys = [];
      const deps = {
        callLLM: async (_s, _u, opts) => { calls.push(opts.allowedProviders); return null; },
        cacheGet: async (k) => { keys.push(k); return null; },
        cacheSet: async (k) => { keys.push(k); },
      };
      const stories = [{ headline: 'Chip export controls widened', threatLevel: 'high', category: 'Economic', country: 'US', source: 'Reuters' }];
      const result = await runSynthesisWithFallback(
        'user-restricted', stories, 'all', { profile: 'Watchlist: NVDA', greeting: 'Good morning' },
        withAiRoutingPolicy(deps, RESTRICTED),
      );
      assert.equal(result.level, 3);
      assert.deepEqual(calls, [['anthropic'], ['anthropic']]);
      assert.ok(keys.length >= 2);
      assert.ok(keys.every((k) => k.startsWith('brief:llm:digest:') && k.endsWith(':ai=anthropic')), keys.join(','));
    });
  });
});

describe('digest seeder wiring', () => {
  it('hands personalised synthesis the user-scoped, policy-wrapped deps', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../scripts/seed-digest-notifications.mjs', import.meta.url), 'utf8');
    const call = src.match(/runSynthesisWithFallback\(\s*userId,[\s\S]*?\n\s*\(level, kind, err\)/);
    assert.ok(call, 'expected the runSynthesisWithFallback call in seed-digest-notifications.mjs');
    assert.match(call[0], /withAiRoutingPolicy\(briefLlmDeps, await resolveAiRoutingPolicy\(userId\)\)/);
  });
});
