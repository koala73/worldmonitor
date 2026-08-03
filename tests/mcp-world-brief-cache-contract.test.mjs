import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';
import { McpSourceUnavailableError } from '../api/mcp/source-unavailable.ts';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';

const REDIS_URL = 'https://fake.upstash.io';
const REDIS_KEY = 'news:insights:v1';
const REDIS_KEY_PATH = '/get/news%3Ainsights%3Av1';
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function worldBriefTool() {
  const tool = TOOL_REGISTRY.find((candidate) => candidate.name === 'get_world_brief');
  assert.ok(tool, 'get_world_brief must be registered');
  assert.equal(typeof tool._execute, 'function', 'get_world_brief must remain callable');
  return tool;
}

function canonicalInsights() {
  return {
    worldBrief: 'Corroborated global lead [1].',
    briefStoryLines: [{ n: 1, text: 'Corroborated global lead [1].' }],
    worldBriefSources: [{
      title: 'Corroborated global headline',
      source: 'Example Wire',
      url: 'https://example.com/corroborated-global-headline',
      publishedAt: '2026-08-03T14:00:00.000Z',
    }],
    briefProvider: 'seed-provider',
    briefModel: 'seed-model',
    status: 'ok',
    topStories: [{
      primaryTitle: 'Corroborated global headline',
      primarySource: 'Example Wire',
      primaryLink: 'https://example.com/corroborated-global-headline',
      pubDate: '2026-08-03T14:00:00.000Z',
    }],
    generatedAt: new Date().toISOString(),
  };
}

function configureRedis({ value, includeUngatedLiveFallback = false, redisReadError = false }) {
  process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  const calls = [];
  const redis = createRedisFetch({ [REDIS_KEY]: value });

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);

    if (redisReadError && url === `${REDIS_URL}${REDIS_KEY_PATH}`) {
      return new Response('redis unavailable', { status: 503 });
    }

    if (includeUngatedLiveFallback && url.endsWith('/api/news/v1/list-feed-digest?variant=full&lang=en')) {
      return new Response(JSON.stringify({
        categories: { world: { items: [{ title: 'Live fallback headline', snippet: 'Live fallback body.' }] } },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (includeUngatedLiveFallback && url.endsWith('/api/news/v1/summarize-article')) {
      return new Response(JSON.stringify({ summary: 'UNGATED live fallback that the dashboard would reject.' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return redis.fetchImpl(input, init);
  };

  return calls;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.keys(process.env).forEach((key) => {
    if (!(key in originalEnv)) delete process.env[key];
  });
  Object.assign(process.env, originalEnv);
});

describe('get_world_brief canonical seeded contract (#6112)', () => {
  it('returns the dashboard seeded brief and never calls the live digest or summarizer', async () => {
    const payload = canonicalInsights();
    const calls = configureRedis({ value: payload, includeUngatedLiveFallback: true });

    const result = await worldBriefTool()._execute(
      { geo_context: 'Middle East tensions' },
      'https://worldmonitor.app',
      { kind: 'env_key', apiKey: 'wm_test_key_world_brief' },
    );

    assert.equal(result.brief, payload.worldBrief);
    assert.equal(result.summary, payload.worldBrief);
    assert.deepEqual(result.headlines, ['Corroborated global headline']);
    assert.equal(result.provider, payload.briefProvider);
    assert.equal(result.model, payload.briefModel);
    assert.equal(result.generatedAt, payload.generatedAt);
    assert.deepEqual(result.sources, payload.worldBriefSources);
    assert.deepEqual(result.briefStoryLines, payload.briefStoryLines);
    assert.equal(result.status, 'ok');
    assert.deepEqual(calls, [`${REDIS_URL}${REDIS_KEY_PATH}`]);
  });

  it('normalizes numeric citation dates to the declared source schema', async () => {
    const payload = canonicalInsights();
    payload.worldBriefSources[0].publishedAt = Date.parse(payload.worldBriefSources[0].publishedAt);
    const calls = configureRedis({ value: payload });

    const result = await worldBriefTool()._execute(
      {},
      'https://worldmonitor.app',
      { kind: 'env_key', apiKey: 'wm_test_key_world_brief' },
    );

    assert.equal(result.sources[0].publishedAt, '2026-08-03T14:00:00.000Z');
    assert.deepEqual(calls, [`${REDIS_URL}${REDIS_KEY_PATH}`]);
  });

  it('fails closed on a canonical cache miss instead of returning an ungated live summary', async () => {
    const calls = configureRedis({ value: null, includeUngatedLiveFallback: true });

    await assert.rejects(
      () => worldBriefTool()._execute(
        {},
        'https://worldmonitor.app',
        { kind: 'env_key', apiKey: 'wm_test_key_world_brief' },
      ),
      (error) => {
        assert.ok(error instanceof McpSourceUnavailableError);
        assert.deepEqual(error.unavailableInputs, ['news:insights:v1']);
        assert.deepEqual(error.failedInputs, []);
        return true;
      },
    );

    assert.equal(
      calls.some((url) => url.includes('/api/news/v1/list-feed-digest') || url.includes('/api/news/v1/summarize-article')),
      false,
      'a missing gated snapshot must not trigger the old live path',
    );
  });

  it('fails closed when a cache hit does not satisfy the dashboard snapshot contract', async () => {
    const calls = configureRedis({
      value: {
        worldBrief: 'Partial payload that must not escape.',
        briefProvider: '',
        briefModel: '',
        briefStoryLines: ['not-a-story-line'],
        worldBriefSources: ['not-a-source'],
        topStories: [{ primaryTitle: 'Valid-looking headline' }],
        generatedAt: new Date().toISOString(),
        status: 'ok',
      },
      includeUngatedLiveFallback: true,
    });

    await assert.rejects(
      () => worldBriefTool()._execute(
        {},
        'https://worldmonitor.app',
        { kind: 'env_key', apiKey: 'wm_test_key_world_brief' },
      ),
      (error) => {
        assert.ok(error instanceof McpSourceUnavailableError);
        assert.deepEqual(error.unavailableInputs, ['news:insights:v1']);
        assert.deepEqual(error.failedInputs, ['news:insights:v1']);
        return true;
      },
    );

    assert.equal(
      calls.some((url) => url.includes('/api/news/v1/list-feed-digest') || url.includes('/api/news/v1/summarize-article')),
      false,
      'an invalid gated snapshot must not trigger the old live path',
    );
  });

  it('fails closed when the canonical snapshot is older than the dashboard freshness window', async () => {
    const calls = configureRedis({
      value: {
        ...canonicalInsights(),
        generatedAt: new Date(Date.now() - (60 * 60 * 1000 + 1)).toISOString(),
      },
      includeUngatedLiveFallback: true,
    });

    await assert.rejects(
      () => worldBriefTool()._execute(
        {},
        'https://worldmonitor.app',
        { kind: 'env_key', apiKey: 'wm_test_key_world_brief' },
      ),
      (error) => {
        assert.ok(error instanceof McpSourceUnavailableError);
        assert.deepEqual(error.unavailableInputs, ['news:insights:v1']);
        assert.deepEqual(error.failedInputs, ['news:insights:v1']);
        return true;
      },
    );

    assert.equal(
      calls.some((url) => url.includes('/api/news/v1/list-feed-digest') || url.includes('/api/news/v1/summarize-article')),
      false,
      'a stale gated snapshot must not trigger the old live path',
    );
  });

  it('fails closed when generatedAt is in the future', async () => {
    const calls = configureRedis({
      value: {
        ...canonicalInsights(),
        generatedAt: new Date(Date.now() + 1_000).toISOString(),
      },
    });

    await assert.rejects(
      () => worldBriefTool()._execute(
        {},
        'https://worldmonitor.app',
        { kind: 'env_key', apiKey: 'wm_test_key_world_brief' },
      ),
      (error) => {
        assert.ok(error instanceof McpSourceUnavailableError);
        assert.deepEqual(error.unavailableInputs, ['news:insights:v1']);
        assert.deepEqual(error.failedInputs, ['news:insights:v1']);
        return true;
      },
    );

    assert.deepEqual(calls, [`${REDIS_URL}${REDIS_KEY_PATH}`]);
  });

  it('preserves a fresh legacy snapshot when optional brief metadata is absent', async () => {
    const { briefStoryLines, worldBriefSources, ...payload } = canonicalInsights();
    const calls = configureRedis({ value: payload });

    const result = await worldBriefTool()._execute(
      {},
      'https://worldmonitor.app',
      { kind: 'env_key', apiKey: 'wm_test_key_world_brief' },
    );

    assert.equal(result.brief, payload.worldBrief);
    assert.deepEqual(result.briefStoryLines, []);
    assert.deepEqual(result.sources, []);
    assert.deepEqual(calls, [`${REDIS_URL}${REDIS_KEY_PATH}`]);
  });

  it('preserves a valid degraded canonical snapshot without using the live path', async () => {
    const payload = {
      ...canonicalInsights(),
      worldBrief: '',
      briefProvider: '',
      briefModel: '',
      briefStoryLines: [],
      worldBriefSources: [],
      status: 'degraded',
      topStories: [{ primaryTitle: 'Degraded canonical headline' }],
    };
    const calls = configureRedis({ value: payload, includeUngatedLiveFallback: true });

    const result = await worldBriefTool()._execute(
      {},
      'https://worldmonitor.app',
      { kind: 'env_key', apiKey: 'wm_test_key_world_brief' },
    );

    assert.equal(result.status, 'degraded');
    assert.equal(result.brief, payload.worldBrief);
    assert.deepEqual(result.sources, payload.worldBriefSources);
    assert.deepEqual(calls, [`${REDIS_URL}${REDIS_KEY_PATH}`]);
  });

  it('rejects a degraded snapshot that omits worldBrief instead of returning undefined', async () => {
    const payload = {
      ...canonicalInsights(),
      status: 'degraded',
      briefProvider: '',
      briefModel: '',
      briefStoryLines: [],
      worldBriefSources: [],
      topStories: [{ primaryTitle: 'Degraded canonical headline' }],
    };
    delete payload.worldBrief;
    const calls = configureRedis({ value: payload });

    await assert.rejects(
      () => worldBriefTool()._execute(
        {},
        'https://worldmonitor.app',
        { kind: 'env_key', apiKey: 'wm_test_key_world_brief' },
      ),
      (error) => {
        assert.ok(error instanceof McpSourceUnavailableError);
        assert.deepEqual(error.unavailableInputs, ['news:insights:v1']);
        assert.deepEqual(error.failedInputs, ['news:insights:v1']);
        return true;
      },
    );

    assert.deepEqual(calls, [`${REDIS_URL}${REDIS_KEY_PATH}`]);
  });

  it('distinguishes a Redis read error from a genuine cache miss', async () => {
    const calls = configureRedis({ value: canonicalInsights(), redisReadError: true });

    await assert.rejects(
      () => worldBriefTool()._execute(
        {},
        'https://worldmonitor.app',
        { kind: 'env_key', apiKey: 'wm_test_key_world_brief' },
      ),
      (error) => {
        assert.ok(error instanceof McpSourceUnavailableError);
        assert.deepEqual(error.unavailableInputs, ['news:insights:v1']);
        assert.deepEqual(error.failedInputs, ['news:insights:v1']);
        return true;
      },
    );

    assert.deepEqual(calls, [`${REDIS_URL}${REDIS_KEY_PATH}`]);
  });
});
