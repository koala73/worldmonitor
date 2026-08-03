import { afterEach, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { mcpHandler } from '../api/mcp.ts';
import { createMcpToolExecutionContext } from '../api/mcp/downstream.ts';
import {
  HMAC_SECRET,
  PRO_BEARER,
  PRO_TOKEN_ID,
  PRO_USER_ID,
  callBody,
  makePipelineMock,
} from './helpers/mcp-pro-deps.mjs';

const REDIS_URL = 'https://fake.upstash.io';
const REDIS_KEY_PATH = '/get/news%3Ainsights%3Av1';
const ENV_KEY = 'operator_test_key_world_brief';
const USER_KEY = 'wm_test_user_key_world_brief';
const USER_ID = 'user_key_world_brief';
const SECRET_QUERY = 'SECRET_QUERY_SENTINEL_5514';
const SECRET_COOKIE = 'SECRET_COOKIE_SENTINEL_5514';
const SECRET_GEO_CONTEXT = 'SECRET_GEO_CONTEXT_SENTINEL_5514';

const HOSTS = [
  { url: 'https://worldmonitor.app/mcp', hostClass: 'apex' },
  { url: 'https://www.worldmonitor.app/mcp', hostClass: 'www' },
  { url: 'https://api.worldmonitor.app/api/mcp', hostClass: 'canonical_api' },
  { url: 'https://tech.worldmonitor.app/mcp', hostClass: 'variant' },
  { url: 'https://finance.worldmonitor.app/mcp', hostClass: 'variant' },
  { url: 'https://commodity.worldmonitor.app/mcp', hostClass: 'variant' },
  { url: 'https://happy.worldmonitor.app/mcp', hostClass: 'variant' },
  { url: 'https://energy.worldmonitor.app/mcp', hostClass: 'variant' },
];

const AUTH_CASES = [
  {
    kind: 'env_key',
    headers: { 'X-WorldMonitor-Key': ENV_KEY },
  },
  {
    kind: 'user_key',
    headers: { 'X-WorldMonitor-Key': USER_KEY },
  },
  {
    kind: 'pro',
    headers: { Authorization: `Bearer ${PRO_BEARER}` },
  },
];

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

function makeDeps() {
  const pipe = makePipelineMock();
  return {
    resolveBearerToContext: async (token) => (
      token === PRO_BEARER
        ? { kind: 'pro', userId: PRO_USER_ID, mcpTokenId: PRO_TOKEN_ID }
        : null
    ),
    validateProMcpToken: async (tokenId) => (
      tokenId === PRO_TOKEN_ID ? { userId: PRO_USER_ID } : null
    ),
    getEntitlements: async () => ({
      planKey: 'pro',
      features: { tier: 1, mcpAccess: true, apiAccess: true },
      validUntil: Date.now() + 86_400_000,
    }),
    validateUserApiKey: async (key) => (
      key === USER_KEY ? { userId: USER_ID } : null
    ),
    guardUserApiKeyValidation: async () => null,
    redisPipeline: pipe.pipeline,
  };
}

function requestFor(url, headers, id = 1) {
  const target = new URL(url);
  target.searchParams.set('sensitive', SECRET_QUERY);
  return new Request(target, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `wm_session=${SECRET_COOKIE}`,
      ...headers,
    },
    body: JSON.stringify(callBody('get_world_brief', {
      geo_context: SECRET_GEO_CONTEXT,
    }, id)),
  });
}

function canonicalWorldBriefResponse() {
  const generatedAt = new Date().toISOString();
  return new Response(JSON.stringify({
    result: JSON.stringify({
      worldBrief: 'Canonical seeded world brief [1].',
      briefStoryLines: [{ n: 1, text: 'Canonical seeded world brief [1].' }],
      worldBriefSources: [{
        title: 'Canonical seeded headline',
        source: 'Example Wire',
        url: 'https://example.com/canonical-seeded-headline',
        publishedAt: '2026-08-03T00:00:00.000Z',
      }],
      briefProvider: 'seed-provider',
      briefModel: 'seed-model',
      status: 'ok',
      topStories: [{ primaryTitle: 'Canonical seeded headline' }],
      generatedAt,
    }),
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  process.env.WORLDMONITOR_VALID_KEYS = ENV_KEY;
  process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
  process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_redis_token';
  process.env.MCP_TELEMETRY = 'true';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
  Object.keys(process.env).forEach((key) => {
    if (!(key in originalEnv)) delete process.env[key];
  });
  Object.assign(process.env, originalEnv);
});

describe('get_world_brief canonical sibling routing', () => {
  it('preserves non-production origins without exposing them in telemetry tags', () => {
    const cases = [
      {
        url: 'http://localhost:4173/mcp',
        hostClass: 'local',
        origin: 'http://localhost:4173',
      },
      {
        url: 'https://worldmonitor-feature.vercel.app/mcp',
        hostClass: 'vercel_preview',
        origin: 'https://worldmonitor-feature.vercel.app',
      },
      {
        url: 'https://self-hosted.example/mcp',
        hostClass: 'other',
        origin: 'https://self-hosted.example',
      },
    ];

    for (const testCase of cases) {
      const execution = createMcpToolExecutionContext(testCase.url);
      assert.equal(execution.inboundHostClass, testCase.hostClass);
      assert.equal(execution.downstreamOrigin, testCase.origin);
      assert.equal(execution.downstreamOriginTag, testCase.hostClass);
    }
  });

  it('reads the same seeded snapshot for every supported production host and auth kind', async () => {
    const captured = [];
    const fetchCalls = [];
    console.log = (line) => captured.push(line);

    globalThis.fetch = async (input, init = {}) => {
      const call = {
        url: String(input),
        method: init.method ?? 'GET',
        headers: new Headers(init.headers),
        body: typeof init.body === 'string' ? init.body : '',
      };
      fetchCalls.push(call);
      if (call.url === `${REDIS_URL}${REDIS_KEY_PATH}`) return canonicalWorldBriefResponse();
      throw new Error(`Unexpected downstream URL: ${call.url}`);
    };

    const deps = makeDeps();
    let id = 100;
    for (const host of HOSTS) {
      for (const auth of AUTH_CASES) {
        const beforeFetch = fetchCalls.length;
        const beforeTelemetry = captured.length;
        const response = await mcpHandler(requestFor(host.url, auth.headers, id++), deps);
        assert.equal(response.status, 200, `${host.url} ${auth.kind}: transport status`);
        const rpc = await response.json();
        assert.equal(
          JSON.parse(rpc.result.content[0].text).summary,
          'Canonical seeded world brief [1].',
          `${host.url} ${auth.kind}: valid caller receives a brief`,
        );

        const calls = fetchCalls.slice(beforeFetch);
        assert.equal(
          calls.filter((call) => call.url === `${REDIS_URL}${REDIS_KEY_PATH}`).length,
          1,
          `${host.url} ${auth.kind}: one canonical cache read`,
        );
        assert.equal(
          calls.filter((call) => call.url.includes('/api/news/')).length,
          0,
          `${host.url} ${auth.kind}: no live news downstream call`,
        );

        const downstream = captured.slice(beforeTelemetry).filter((line) => (
          line
          && typeof line === 'object'
          && !Array.isArray(line)
          && line.tag === 'mcp.downstream'
        ));
        assert.deepEqual(downstream, [], `${host.url} ${auth.kind}: no live downstream calls`);
      }
    }

    const serialized = JSON.stringify(captured);
    for (const secret of [ENV_KEY, USER_KEY, SECRET_QUERY, SECRET_COOKIE, SECRET_GEO_CONTEXT]) {
      assert.doesNotMatch(serialized, new RegExp(secret), `telemetry must not leak ${secret}`);
    }
  });

  it('surfaces a canonical cache outage as a retryable source-unavailable error', async () => {
    const captured = [];
    console.log = (line) => captured.push(line);
    console.warn = () => {};
    globalThis.fetch = async (input) => {
      assert.equal(String(input), `${REDIS_URL}${REDIS_KEY_PATH}`);
      return new Response(JSON.stringify({ result: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const response = await mcpHandler(
      requestFor('https://www.worldmonitor.app/mcp', AUTH_CASES[1].headers, 300),
      makeDeps(),
    );
    assert.equal(response.status, 200);
    const rpc = await response.json();
    assert.equal(rpc.error?.code, -32003);
    assert.equal(rpc.error?.data?.retryable, true);
    assert.deepEqual(rpc.error?.data?.unavailable_inputs, ['news:insights:v1']);
    assert.deepEqual(rpc.error?.data?.failed_inputs, []);
    assert.doesNotMatch(JSON.stringify(captured), new RegExp(SECRET_QUERY));
    assert.doesNotMatch(JSON.stringify(captured), new RegExp(SECRET_COOKIE));
    assert.doesNotMatch(JSON.stringify(captured), new RegExp(SECRET_GEO_CONTEXT));
  });
});
