import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { callLlm, callLlmReasoning } from '../server/_shared/llm.ts';

const originalFetch = globalThis.fetch;
const originalGroqApiKey = process.env.GROQ_API_KEY;
const originalOpenRouterApiKey = process.env.OPENROUTER_API_KEY;
const originalOllamaApiUrl = process.env.OLLAMA_API_URL;
const originalLlmApiUrl = process.env.LLM_API_URL;
const originalLlmApiKey = process.env.LLM_API_KEY;
const originalLlmReasoningProvider = process.env.LLM_REASONING_PROVIDER;
const originalLlmReasoningModel = process.env.LLM_REASONING_MODEL;

afterEach(() => {
  globalThis.fetch = originalFetch;

  if (originalLlmReasoningProvider === undefined) delete process.env.LLM_REASONING_PROVIDER;
  else process.env.LLM_REASONING_PROVIDER = originalLlmReasoningProvider;

  if (originalLlmReasoningModel === undefined) delete process.env.LLM_REASONING_MODEL;
  else process.env.LLM_REASONING_MODEL = originalLlmReasoningModel;

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
  it('excludes China-hosted providers and sorts by throughput on every OpenRouter call', async () => {
    process.env.OPENROUTER_API_KEY = 'or-test-key';
    delete process.env.GROQ_API_KEY;
    delete process.env.OLLAMA_API_URL;
    delete process.env.LLM_API_URL;
    delete process.env.LLM_API_KEY;

    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method || 'GET') === 'GET') return new Response('', { status: 200 });
      bodies.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 5 } }), { status: 200 });
    }) as typeof fetch;

    // Utility (reasoning off) AND reasoning-on must both carry the exclusion.
    await callLlm({ messages: [{ role: 'user', content: 'x' }] });
    await callLlm({ messages: [{ role: 'user', content: 'y' }], enableReasoning: true });

    for (const b of bodies) {
      const prov = b.provider as { ignore?: string[]; sort?: string } | undefined;
      assert.ok(prov, 'every OpenRouter body must carry provider routing');
      assert.equal(prov.sort, 'throughput');
      // Lowercase OpenRouter provider SLUGS (verified via GET /providers) —
      // display-name casing is silently ignored by OpenRouter (#4993 review).
      for (const cn of ['baidu', 'alibaba', 'deepseek', 'siliconflow', 'streamlake', 'novita']) {
        assert.ok(prov.ignore?.includes(cn), `China provider slug ${cn} must be excluded`);
        assert.equal(cn, cn.toLowerCase(), 'slug must be lowercase to match OpenRouter');
      }
    }
    // reasoning-off body still disables reasoning; reasoning-on omits it.
    assert.deepEqual(bodies[0]?.reasoning, { enabled: false });
    assert.equal('reasoning' in (bodies[1] ?? {}), false);
  });

  it('preserves the default provider order (openrouter-first since #4944)', async () => {
    process.env.GROQ_API_KEY = 'groq-test-key';
    process.env.OPENROUTER_API_KEY = 'or-test-key';
    delete process.env.OLLAMA_API_URL;
    delete process.env.LLM_API_URL;
    delete process.env.LLM_API_KEY;

    const postUrls: string[] = [];
    const postBodies: Array<Record<string, unknown>> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if ((init?.method || 'GET') === 'GET') {
        return new Response('', { status: 200 });
      }

      postUrls.push(url);
      postBodies.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>);
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
    assert.equal(result.provider, 'openrouter');
    assert.equal(result.model, 'deepseek/deepseek-v4-flash');
    assert.deepEqual(postUrls.filter(url => url.includes('/chat/completions')), [
      'https://openrouter.ai/api/v1/chat/completions',
    ]);
    // Utility calls must not pay reasoning tokens on hybrid-reasoning models.
    assert.deepEqual(postBodies[0]?.reasoning, { enabled: false });
  });

  it('omits the reasoning-off body when the reasoning profile opts in', async () => {
    process.env.OPENROUTER_API_KEY = 'or-test-key';
    delete process.env.GROQ_API_KEY;
    delete process.env.OLLAMA_API_URL;
    delete process.env.LLM_API_URL;
    delete process.env.LLM_API_KEY;

    const postBodies: Array<Record<string, unknown>> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method || 'GET') === 'GET') {
        return new Response('', { status: 200 });
      }
      postBodies.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>);
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'reasoning-tier response' } }],
        usage: { total_tokens: 7 },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await callLlm({
      messages: [{ role: 'user', content: 'Reason about the setup.' }],
      enableReasoning: true,
    });

    assert.ok(result);
    assert.equal(result.provider, 'openrouter');
    assert.equal(postBodies.length, 1);
    // Opt-in leaves the model's own reasoning default in effect.
    assert.equal('reasoning' in (postBodies[0] ?? {}), false);
  });

  it('callLlmReasoning honors enableReasoning:false to disable reasoning on the reasoning-tier model (#4983)', async () => {
    process.env.OPENROUTER_API_KEY = 'or-test-key';
    process.env.LLM_REASONING_PROVIDER = 'openrouter';
    process.env.LLM_REASONING_MODEL = 'deepseek/deepseek-v4-pro';
    delete process.env.GROQ_API_KEY;
    delete process.env.OLLAMA_API_URL;
    delete process.env.LLM_API_URL;
    delete process.env.LLM_API_KEY;

    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method || 'GET') === 'GET') return new Response('', { status: 200 });
      bodies.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>);
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Closure would choke a fifth of seaborne crude.' } }],
        usage: { total_tokens: 30 },
      }), { status: 200 });
    }) as typeof fetch;

    // Short-stage caller opts OUT of reasoning: the tiny max_tokens budget
    // must go to the answer, not hidden reasoning tokens (the #4983 bug).
    const off = await callLlmReasoning({
      messages: [{ role: 'user', content: 'Why does this matter?' }],
      maxTokens: 260,
      enableReasoning: false,
    });
    assert.ok(off);
    assert.equal(off.model, 'deepseek/deepseek-v4-pro', 'still uses the reasoning-tier model');
    assert.deepEqual(bodies[0]?.reasoning, { enabled: false }, 'reasoning must be disabled on the wire');

    // Default (no override) keeps reasoning on for genuinely analytical stages.
    bodies.length = 0;
    const on = await callLlmReasoning({
      messages: [{ role: 'user', content: 'Deduce the situation.' }],
      maxTokens: 1500,
    });
    assert.ok(on);
    assert.equal('reasoning' in (bodies[0] ?? {}), false, 'default leaves reasoning on (no disable body)');
    // LLM_REASONING_* are restored by the shared afterEach (snapshot-based),
    // which runs even if an assertion above throws — no manual cleanup here.
  });

  it('ignores DeepSeek reasoning message fields and serves content untouched', async () => {
    process.env.OPENROUTER_API_KEY = 'or-test-key';
    delete process.env.GROQ_API_KEY;
    delete process.env.OLLAMA_API_URL;
    delete process.env.LLM_API_URL;
    delete process.env.LLM_API_KEY;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method || 'GET') === 'GET') {
        return new Response('', { status: 200 });
      }
      // Live-captured DeepSeek V4 shape (2026-07-06): reasoning arrives as
      // separate message fields, never inline tags; content stays clean.
      return new Response(JSON.stringify({
        choices: [{ message: {
          role: 'assistant',
          content: 'Paris',
          reasoning: 'We need to reply with exactly one word.',
          reasoning_details: [{ type: 'reasoning.text', text: 'We need to reply.' }],
        } }],
        usage: { total_tokens: 30, prompt_tokens: 14, completion_tokens: 16 },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await callLlm({
      messages: [{ role: 'user', content: 'Capital of France, one word.' }],
      enableReasoning: true,
    });

    assert.ok(result);
    assert.equal(result.content, 'Paris');
  });

  it('falls through when a provider returns only reasoning with empty content', async () => {
    process.env.OPENROUTER_API_KEY = 'or-test-key';
    process.env.GROQ_API_KEY = 'groq-test-key';
    delete process.env.OLLAMA_API_URL;
    delete process.env.LLM_API_URL;
    delete process.env.LLM_API_KEY;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if ((init?.method || 'GET') === 'GET') {
        return new Response('', { status: 200 });
      }
      if (url.includes('openrouter.ai')) {
        // Degenerate case: model burned its budget on reasoning, empty content.
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '', reasoning: 'endless deliberation…' } }],
          usage: { total_tokens: 60, prompt_tokens: 14, completion_tokens: 46 },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'groq fallback answer' } }],
        usage: { total_tokens: 20 },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await callLlm({
      messages: [{ role: 'user', content: 'Answer briefly.' }],
    });

    assert.ok(result);
    assert.equal(result.provider, 'groq');
    assert.equal(result.content, 'groq fallback answer');
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
    assert.deepEqual(postBodies[0]?.body.reasoning, { enabled: false });
  });

  it('logs a bounded error-body slice on non-stream provider failure', async () => {
    process.env.OPENROUTER_API_KEY = 'or-test-key';
    process.env.GROQ_API_KEY = 'groq-test-key';
    delete process.env.OLLAMA_API_URL;
    delete process.env.LLM_API_URL;
    delete process.env.LLM_API_KEY;

    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')); };

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if ((init?.method || 'GET') === 'GET') {
        return new Response('', { status: 200 });
      }
      if (url.includes('openrouter.ai')) {
        return new Response(JSON.stringify({ error: { message: 'This model is not available in your region' } }), { status: 403 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'groq fallback' } }],
        usage: { total_tokens: 5 },
      }), { status: 200 });
    }) as typeof fetch;

    try {
      const result = await callLlm({ messages: [{ role: 'user', content: 'hi' }] });
      assert.ok(result);
      assert.equal(result.provider, 'groq');
      const errLine = warns.find((w) => w.includes('HTTP 403'));
      assert.ok(errLine, 'a 403 warn line must be emitted');
      assert.ok(errLine.includes('not available in your region'), 'the error body must be visible in the log');
    } finally {
      console.warn = originalWarn;
    }
  });

  it('reads at most the cap from an oversized/never-ending error body before falling back', async () => {
    process.env.OPENROUTER_API_KEY = 'or-test-key';
    process.env.GROQ_API_KEY = 'groq-test-key';
    delete process.env.OLLAMA_API_URL;
    delete process.env.LLM_API_URL;
    delete process.env.LLM_API_KEY;

    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')); };

    let cancelled = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if ((init?.method || 'GET') === 'GET') {
        return new Response('', { status: 200 });
      }
      if (url.includes('openrouter.ai')) {
        // First chunk exceeds the cap; a second read would hang forever.
        // The bounded reader must stop after chunk one and cancel — if it
        // tried to consume the full body (resp.text()), this test hangs.
        const enc = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!cancelled) {
              controller.enqueue(enc.encode(`REGION_BLOCK ${'x'.repeat(4000)}`));
            }
            // Never close: subsequent pulls stall until cancel.
            return new Promise(() => { /* hang */ });
          },
          cancel() { cancelled = true; },
        });
        return new Response(body, { status: 403 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'groq fallback' } }],
        usage: { total_tokens: 5 },
      }), { status: 200 });
    }) as typeof fetch;

    try {
      const result = await callLlm({ messages: [{ role: 'user', content: 'hi' }] });
      assert.ok(result, 'fallback must complete despite the never-ending error body');
      assert.equal(result.provider, 'groq');
      const errLine = warns.find((w) => w.includes('HTTP 403'));
      assert.ok(errLine, 'a 403 warn line must be emitted');
      assert.ok(errLine.includes('REGION_BLOCK'), 'the leading body slice must be visible');
      const bodyPart = errLine.slice(errLine.indexOf('body=') + 5);
      assert.ok(bodyPart.length <= 300, `logged body must be capped at 300 chars, got ${bodyPart.length}`);
      assert.ok(cancelled, 'the error-body stream must be cancelled after the bounded read');
    } finally {
      console.warn = originalWarn;
    }
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
    assert.equal(result.model, 'llama-3.3-70b-versatile');
    assert.deepEqual(postUrls.filter(url => url.includes('/chat/completions')), [
      'https://openrouter.ai/api/v1/chat/completions',
      'https://api.groq.com/openai/v1/chat/completions',
    ]);
  });
});
