import { afterEach, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  MCP_DOWNSTREAM_TELEMETRY_KEYS,
  mcpHandler,
} from '../api/mcp.ts';
import { createMcpToolExecutionContext } from '../api/mcp/downstream.ts';
import { verifyInternalMcpRequest } from '../server/_shared/mcp-internal-hmac.ts';
import {
  HMAC_SECRET,
  PRO_BEARER,
  PRO_TOKEN_ID,
  PRO_USER_ID,
  callBody,
  makePipelineMock,
} from './helpers/mcp-pro-deps.mjs';

const CANONICAL_API_ORIGIN = 'https://api.worldmonitor.app';
const ENV_KEY = 'operator_test_key_world_brief';
const USER_KEY = 'wm_test_user_key_world_brief';
const USER_ID = 'user_key_world_brief';
const SECRET_QUERY = 'SECRET_QUERY_SENTINEL_5514';
const SECRET_COOKIE = 'SECRET_COOKIE_SENTINEL_5514';
const SECRET_GEO_CONTEXT = 'SECRET_GEO_CONTEXT_SENTINEL_5514';
const SECRET_RESPONSE_DETAIL = 'SECRET_RESPONSE_DETAIL_SENTINEL_5514';

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

function digestResponse() {
  return new Response(JSON.stringify({
    categories: {
      world: {
        items: [{
          title: 'World brief routing regression headline',
          snippet: 'Grounding body for the issue 5514 regression.',
          source: 'Example Wire',
          link: 'https://example.com/world-brief-routing',
          publishedAt: '2026-07-23T00:00:00.000Z',
        }],
      },
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function downstreamEvents(captured) {
  return captured.filter((line) => (
    line
    && typeof line === 'object'
    && !Array.isArray(line)
    && line.tag === 'mcp.downstream'
  ));
}

beforeEach(() => {
  process.env.WORLDMONITOR_VALID_KEYS = ENV_KEY;
  process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
  process.env.MCP_TELEMETRY = 'true';
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
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

  it('uses the canonical API origin for every supported production host and auth kind', async () => {
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
      const { pathname } = new URL(call.url);
      if (pathname === '/api/news/v1/list-feed-digest') return digestResponse();
      if (pathname === '/api/news/v1/summarize-article') {
        return new Response(JSON.stringify({ summary: 'Canonical world brief.' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected downstream URL: ${call.url}`);
    };

    const deps = makeDeps();
    let id = 100;
    for (const host of HOSTS) {
      for (const auth of AUTH_CASES) {
        const beforeFetch = fetchCalls.length;
        const beforeTelemetry = downstreamEvents(captured).length;
        const response = await mcpHandler(requestFor(host.url, auth.headers, id++), deps);
        assert.equal(response.status, 200, `${host.url} ${auth.kind}: transport status`);
        const rpc = await response.json();
        assert.equal(
          JSON.parse(rpc.result.content[0].text).summary,
          'Canonical world brief.',
          `${host.url} ${auth.kind}: valid caller receives a brief`,
        );

        const calls = fetchCalls.slice(beforeFetch);
        assert.equal(calls.length, 2, `${host.url} ${auth.kind}: digest + summarize`);
        for (const call of calls) {
          assert.equal(new URL(call.url).origin, CANONICAL_API_ORIGIN);
        }

        const events = downstreamEvents(captured).slice(beforeTelemetry);
        assert.equal(events.length, 2, `${host.url} ${auth.kind}: one event per downstream call`);
        assert.deepEqual(
          events.map((event) => event.downstream_operation),
          ['list-feed-digest', 'summarize-article'],
        );
        for (const event of events) {
          assert.equal(event.auth_kind, auth.kind);
          assert.equal(event.inbound_host_class, host.hostClass);
          assert.equal(event.downstream_origin, CANONICAL_API_ORIGIN);
          assert.equal(event.status, 200);
          assert.equal(event.ok, true);
          assert.equal(event.error_code, null);
          assert.equal(event.response_marker, 'json');
          const offending = Object.keys(event).filter(
            (key) => !MCP_DOWNSTREAM_TELEMETRY_KEYS.includes(key),
          );
          assert.deepEqual(offending, [], `unauthorized mcp.downstream keys: ${offending}`);
        }

        if (auth.kind === 'pro') {
          for (const call of calls) {
            assert.ok(call.headers.get('x-wm-mcp-internal'), `${call.url}: Pro signature`);
            const signedRequest = new Request(call.url, {
              method: call.method,
              headers: call.headers,
              body: call.method === 'GET' ? undefined : call.body,
            });
            assert.ok(
              await verifyInternalMcpRequest(signedRequest, HMAC_SECRET),
              `${call.url}: HMAC must bind the exact canonical method/URL/body`,
            );
          }
        } else {
          for (const call of calls) {
            const expectedKey = auth.kind === 'env_key' ? ENV_KEY : USER_KEY;
            assert.equal(call.headers.get('x-worldmonitor-key'), expectedKey);
          }
        }
      }
    }

    const serialized = JSON.stringify(captured);
    for (const secret of [ENV_KEY, USER_KEY, SECRET_QUERY, SECRET_COOKIE, SECRET_GEO_CONTEXT]) {
      assert.doesNotMatch(serialized, new RegExp(secret), `telemetry must not leak ${secret}`);
    }
  });

  it('classifies reproduced 401/405 responses without logging response bodies', async () => {
    const scenarios = [
      {
        name: 'invalid internal signature',
        auth: AUTH_CASES[2],
        response: () => new Response(JSON.stringify({
          error: 'invalid_internal_mcp_signature',
          detail: SECRET_RESPONSE_DETAIL,
        }), { status: 401, headers: { 'Content-Type': 'application/json' } }),
        errorCode: 'invalid_internal_mcp_signature',
        marker: 'json_error',
        status: 401,
      },
      {
        name: 'invalid raw API key',
        auth: AUTH_CASES[0],
        response: () => new Response(JSON.stringify({
          error: 'Invalid API key',
          detail: SECRET_RESPONSE_DETAIL,
        }), { status: 401, headers: { 'Content-Type': 'application/json' } }),
        errorCode: 'invalid_api_key',
        marker: 'json_error',
        status: 401,
      },
      {
        name: 'other gateway entitlement outcome',
        auth: AUTH_CASES[2],
        response: () => new Response(JSON.stringify({
          error: 'insufficient_entitlement',
          detail: SECRET_RESPONSE_DETAIL,
        }), { status: 401, headers: { 'Content-Type': 'application/json' } }),
        errorCode: 'insufficient_entitlement',
        marker: 'json_error',
        status: 401,
      },
      {
        name: 'method mismatch route',
        auth: AUTH_CASES[0],
        response: () => new Response(
          `<html><body>Method not allowed ${SECRET_RESPONSE_DETAIL}</body></html>`,
          {
            status: 405,
            headers: { 'Content-Type': 'text/html', Allow: 'GET' },
          },
        ),
        errorCode: 'method_not_allowed',
        marker: 'method_not_allowed',
        status: 405,
      },
    ];

    for (const [index, scenario] of scenarios.entries()) {
      const captured = [];
      console.log = (line) => captured.push(line);
      console.warn = () => {};
      console.error = () => {};
      globalThis.fetch = async (input) => {
        const { pathname } = new URL(String(input));
        if (pathname === '/api/news/v1/list-feed-digest') return digestResponse();
        if (pathname === '/api/news/v1/summarize-article') return scenario.response();
        throw new Error(`Unexpected downstream URL: ${input}`);
      };

      const response = await mcpHandler(
        requestFor('https://tech.worldmonitor.app/mcp', scenario.auth.headers, 200 + index),
        makeDeps(),
      );
      assert.equal(response.status, 200, `${scenario.name}: JSON-RPC tool failure status`);
      const rpc = await response.json();
      assert.equal(rpc.error?.code, -32603, `${scenario.name}: internal tool failure contract`);

      const event = downstreamEvents(captured).find(
        (candidate) => candidate.downstream_operation === 'summarize-article',
      );
      assert.ok(event, `${scenario.name}: summarize telemetry`);
      assert.equal(event.auth_kind, scenario.auth.kind);
      assert.equal(event.inbound_host_class, 'variant');
      assert.equal(event.downstream_origin, CANONICAL_API_ORIGIN);
      assert.equal(event.status, scenario.status);
      assert.equal(event.ok, false);
      assert.equal(event.error_code, scenario.errorCode);
      assert.equal(event.response_marker, scenario.marker);

      const serialized = JSON.stringify(captured);
      assert.doesNotMatch(serialized, new RegExp(SECRET_RESPONSE_DETAIL));
      assert.doesNotMatch(serialized, new RegExp(SECRET_QUERY));
      assert.doesNotMatch(serialized, new RegExp(SECRET_COOKIE));
      assert.doesNotMatch(serialized, new RegExp(SECRET_GEO_CONTEXT));
    }
  });

  it('preserves a genuine billing denial as a typed actionable response', async () => {
    const captured = [];
    console.log = (line) => captured.push(line);
    console.warn = () => {};
    globalThis.fetch = async (input) => {
      const { pathname } = new URL(String(input));
      if (pathname === '/api/news/v1/list-feed-digest') return digestResponse();
      if (pathname === '/api/news/v1/summarize-article') {
        return new Response(JSON.stringify({
          error: 'Renewal verification pending',
          detail: SECRET_RESPONSE_DETAIL,
        }), {
          status: 503,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '17',
            'X-Billing-Verification': 'renewal_verification_pending',
          },
        });
      }
      throw new Error(`Unexpected downstream URL: ${input}`);
    };

    const response = await mcpHandler(
      requestFor('https://www.worldmonitor.app/mcp', AUTH_CASES[1].headers, 300),
      makeDeps(),
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Retry-After'), '17');
    assert.equal(
      response.headers.get('X-Billing-Verification'),
      'renewal_verification_pending',
    );
    const rpc = await response.json();
    assert.equal(rpc.error?.code, -32603);
    assert.equal(rpc.error?.data?.code, 'renewal_verification_pending');
    assert.match(rpc.error?.message ?? '', /Retry shortly/);

    const event = downstreamEvents(captured).find(
      (candidate) => candidate.downstream_operation === 'summarize-article',
    );
    assert.ok(event);
    assert.equal(event.status, 503);
    assert.equal(event.error_code, 'renewal_verification_pending');
    assert.equal(event.response_marker, 'billing_verification');
    assert.doesNotMatch(JSON.stringify(captured), new RegExp(SECRET_RESPONSE_DETAIL));
  });
});
