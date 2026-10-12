// @vitest-environment node

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { __testing__ as llmHealth } from '../_shared/llm-health';
import { summarizeArticle } from '../worldmonitor/news/v1/summarize-article';
import { getSummarizeArticleCache } from '../worldmonitor/news/v1/get-summarize-article-cache';
import { getCacheKey } from '../worldmonitor/news/v1/_shared';

const originalFetch = globalThis.fetch;
const operatorKey = 'summarize-local-operator-fixture';
const localUrl = 'http://127.0.0.1:4043/openai/v1/chat/completions';
const alternateUrl = 'http://127.0.0.1:4044/openai/v1/chat/completions';
const redisUrl = 'https://summary-redis.test';
const cloudUrl = 'https://openrouter.ai/api/v1/chat/completions';
const localModel = 'local/summary-fixture';

function context(authenticated = true) {
  const headers: Record<string, string> = authenticated ? { 'X-WorldMonitor-Key': operatorKey } : {};
  return { request: new Request('http://localhost:3000/api/news/v1/summarize-article', { headers }), pathParams: {}, headers };
}

function request(provider: string, headline = 'Synthetic transport observation for local provider validation') {
  return { provider, headlines: [headline], mode: 'brief', geoContext: '', variant: 'full', lang: 'en', systemAppend: '', bodies: [] };
}

function installUpstream({ fail = false, allowCloud = false, responseModel }: { fail?: boolean; allowCloud?: boolean; responseModel?: unknown } = {}) {
  const redis = new Map<string, string>();
  const completions: Array<{ url: string; model: string }> = [];
  const reads: string[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(`${redisUrl}/get/`)) {
      const key = decodeURIComponent(url.slice(`${redisUrl}/get/`.length));
      reads.push(key);
      return Response.json({ result: redis.get(key) ?? null });
    }
    if (url === `${redisUrl}/` && init?.method === 'POST') {
      const command = JSON.parse(String(init.body)) as string[];
      expect(command[0]).toBe('SET');
      redis.set(command[1]!, command[2]!);
      return Response.json({ result: 'OK' });
    }
    const allowed = [localUrl, alternateUrl, ...(allowCloud ? [cloudUrl] : [])];
    if ((init?.method || 'GET') === 'GET') {
      expect(allowed.map(value => new URL(value).origin)).toContain(new URL(url).origin);
      return new Response('');
    }
    expect(allowed).toContain(url);
    const body = JSON.parse(String(init?.body)) as { model: string };
    completions.push({ url, model: body.model });
    if (url !== cloudUrl) {
      const headers = new Headers(init?.headers);
      expect(headers.get('x-bf-vk')).toBe('bifrost-fixture-key');
      expect(headers.has('Authorization')).toBe(false);
    }
    return fail ? new Response('Synthetic local outage', { status: 503 }) : Response.json({
      model: responseModel,
      choices: [{ message: { content: `Transport observation summarized by ${body.model} for this synthetic fixture.` } }],
      usage: { total_tokens: 8 },
    });
  }) as typeof fetch;
  return { completions, reads };
}

beforeEach(() => {
  llmHealth.reset();
  vi.stubEnv('LLM_PROVIDER', 'generic');
  vi.stubEnv('LLM_TOOL_PROVIDER', '');
  vi.stubEnv('LLM_REASONING_PROVIDER', '');
  vi.stubEnv('LLM_API_URL', localUrl);
  vi.stubEnv('LLM_API_KEY', 'bifrost-fixture-key');
  vi.stubEnv('LLM_API_AUTH_TYPE', 'x-bf-vk');
  vi.stubEnv('LLM_MODEL', localModel);
  vi.stubEnv('OPENROUTER_API_KEY', 'retained-cloud-key-must-not-be-used');
  vi.stubEnv('OLLAMA_API_URL', 'http://127.0.0.1:11434');
  vi.stubEnv('WORLDMONITOR_VALID_KEYS', operatorKey);
  vi.stubEnv('UPSTASH_REDIS_REST_URL', redisUrl);
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'redis-fixture-token');
  vi.stubEnv('USAGE_TELEMETRY', '0');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  llmHealth.reset();
  vi.unstubAllEnvs();
});

describe('article summaries with an operator-selected provider', () => {
  for (const requested of ['openrouter', 'ollama']) {
    test(`uses Bifrost when the browser requests ${requested}`, async () => {
      const { completions } = installUpstream();
      const result = await summarizeArticle(context(), request(requested));
      expect(result).toMatchObject({ provider: 'generic', model: localModel, status: 'SUMMARIZE_STATUS_SUCCESS', fallback: false });
      expect(completions).toEqual([{ url: localUrl, model: localModel }]);
    });
  }

  test('returns the routed model for fresh and cached summaries while partitioning by the requested route', async () => {
    const responseModel = 'routed/free-summary-fixture';
    const { completions, reads } = installUpstream({ responseModel });
    const result = await summarizeArticle(context(), request('openrouter'));
    expect(result).toMatchObject({ provider: 'generic', model: responseModel, status: 'SUMMARIZE_STATUS_SUCCESS' });
    const cached = await summarizeArticle(context(), request('ollama'));
    expect(cached).toMatchObject({ provider: 'cache', model: responseModel });
    expect(completions).toEqual([{ url: localUrl, model: localModel }]);

    vi.stubEnv('LLM_MODEL', 'local/another-route-fixture');
    const changedRoute = await summarizeArticle(context(), request('openrouter'));
    expect(changedRoute).toMatchObject({ provider: 'generic', model: responseModel });
    expect(completions).toEqual([
      { url: localUrl, model: localModel },
      { url: localUrl, model: 'local/another-route-fixture' },
    ]);
    expect(new Set(reads).size).toBe(2);
  });

  test.each([undefined, '', '   ', 42])('falls back to the requested model for unusable response metadata (%s)', async responseModel => {
    installUpstream({ responseModel });
    const result = await summarizeArticle(context(), request('openrouter'));
    expect(result).toMatchObject({ provider: 'generic', model: localModel, status: 'SUMMARIZE_STATUS_SUCCESS' });
  });

  for (const [name, value] of [
    ['LLM_API_URL', ''], ['LLM_API_KEY', ''], ['LLM_API_AUTH_TYPE', 'invalid'], ['LLM_PROVIDER', 'unknown'],
  ]) {
    test(`fails closed with unavailable configuration: ${name}`, async () => {
      vi.stubEnv(name!, value!);
      globalThis.fetch = vi.fn(async () => { throw new Error('No upstream should be contacted'); }) as typeof fetch;
      const result = await summarizeArticle(context(), request('openrouter'));
      expect(result.status).toBe('SUMMARIZE_STATUS_SKIPPED');
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  }

  test('a local outage never falls back to the browser-requested cloud provider', async () => {
    const { completions } = installUpstream({ fail: true });
    const result = await summarizeArticle(context(), request('openrouter'));
    expect(result).toMatchObject({ provider: 'generic', status: 'SUMMARIZE_STATUS_ERROR', fallback: true });
    expect(completions).toEqual([{ url: localUrl, model: localModel }]);
  });

  test('operator configuration does not remove the existing authentication gate', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('Anonymous summary must not fetch'); }) as typeof fetch;
    const result = await summarizeArticle(context(false), request('openrouter'));
    expect(result).toMatchObject({ errorType: 'AuthError', status: 'SUMMARIZE_STATUS_ERROR' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test.each(['LLM_PROVIDER', 'LLM_TOOL_PROVIDER', 'LLM_REASONING_PROVIDER'])('partitions %s local summaries by backend and model while sharing browser fallback requests', async selector => {
    const { completions, reads } = installUpstream({ allowCloud: true });
    vi.stubEnv('LLM_PROVIDER', '');
    const cloud = await summarizeArticle(context(), request('openrouter'));
    expect(cloud.provider).toBe('openrouter');
    const sharedCacheKey = await getCacheKey(request('openrouter').headlines, 'brief', '', 'full', 'en', undefined, []);
    const shared = await getSummarizeArticleCache(context(false), { cacheKey: sharedCacheKey });
    expect(shared).toMatchObject({ provider: 'cache', summary: cloud.summary });

    vi.stubEnv(selector, 'generic');
    const beforeCacheShortcut = vi.mocked(globalThis.fetch).mock.calls.length;
    const bypassed = await getSummarizeArticleCache(context(false), { cacheKey: sharedCacheKey });
    expect(bypassed).toMatchObject({ summary: '', fallback: true });
    expect(globalThis.fetch).toHaveBeenCalledTimes(beforeCacheShortcut);
    const local = await summarizeArticle(context(), request('openrouter'));
    expect(local).toMatchObject({ provider: 'generic', model: localModel });
    const cached = await summarizeArticle(context(), request('ollama'));
    expect(cached).toMatchObject({ provider: 'cache', model: localModel });
    expect(completions).toHaveLength(2);

    vi.stubEnv('LLM_MODEL', 'local/different-summary-fixture');
    const changedModel = await summarizeArticle(context(), request('openrouter'));
    expect(changedModel).toMatchObject({ provider: 'generic', model: 'local/different-summary-fixture' });
    vi.stubEnv('LLM_API_URL', alternateUrl);
    const changedEndpoint = await summarizeArticle(context(), request('ollama'));
    expect(changedEndpoint.provider).toBe('generic');
    expect(completions).toHaveLength(4);
    expect(new Set(reads).size).toBe(4);
    expect(reads.join(' ')).not.toMatch(/bifrost-fixture-key|127\.0\.0\.1/);
  });
});
