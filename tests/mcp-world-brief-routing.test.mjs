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

function insightsResponse(overrides = {}) {
  return new Response(JSON.stringify({
    data: {
      insights: JSON.stringify({
        worldBrief: 'Seeded grounded world brief.',
        briefStoryLines: [{ n: 1, text: 'Seeded grounded world brief.' }],
        worldBriefSources: [{
          title: 'World brief routing regression headline',
          source: 'Example Wire',
          url: 'https://example.com/world-brief-routing',
          publishedAt: '2026-07-23T00:00:00.000Z',
        }],
        briefProvider: 'seeded-provider',
        briefModel: 'seeded-model',
        generatedAt: new Date().toISOString(),
        status: 'ok',
        topStories: [{ primaryTitle: 'World brief routing regression headline' }],
        ...overrides,
      }),
    },
    missing: [],
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

describe('get_world_brief seeded brief routing', () => {
  it('authenticates a local loopback self-fetch with the sidecar token', async () => {
    // #6538: on self-host the bootstrap hop targets the sidecar's own global
    // auth gate. The MCP key authenticates the client; this internal hop must
    // present the per-session LOCAL_API_TOKEN the process already holds.
    process.env.LOCAL_API_TOKEN = 'local-sidecar-token';
    const fetchCalls = [];

    globalThis.fetch = async (input, init = {}) => {
      fetchCalls.push({ url: String(input), headers: new Headers(init.headers) });
      const { pathname } = new URL(String(input));
      if (pathname === '/api/infrastructure/v1/get-bootstrap-data') return insightsResponse();
      throw new Error(`Unexpected downstream URL: ${input}`);
    };

    const response = await mcpHandler(new Request('http://127.0.0.1:43123/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-WorldMonitor-Key': ENV_KEY,
      },
      body: JSON.stringify(callBody('get_world_brief', {})),
    }), makeDeps());

    assert.equal(response.status, 200);
    assert.equal(fetchCalls.length, 1);
    assert.equal(
      fetchCalls[0].headers.get('X-WorldMonitor-Local-Token'),
      'local-sidecar-token',
      'the internal bootstrap fetch must carry the sidecar token on loopback',
    );
    const body = await response.json();
    assert.match(body.result.content[0].text, /Seeded grounded world brief\./);
  });

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
      if (pathname === '/api/infrastructure/v1/get-bootstrap-data') return insightsResponse();
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
          'Seeded grounded world brief.',
          `${host.url} ${auth.kind}: valid caller receives a brief`,
        );

        const calls = fetchCalls.slice(beforeFetch);
        assert.equal(calls.length, 1, `${host.url} ${auth.kind}: shared insights read only`);
        for (const call of calls) {
          assert.equal(new URL(call.url).origin, CANONICAL_API_ORIGIN);
          assert.equal(new URL(call.url).pathname, '/api/infrastructure/v1/get-bootstrap-data');
          assert.equal(new URL(call.url).search, '?keys=insights');
        }

        const events = downstreamEvents(captured).slice(beforeTelemetry);
        assert.equal(events.length, 1, `${host.url} ${auth.kind}: one event per downstream call`);
        assert.deepEqual(
          events.map((event) => event.downstream_operation),
          ['bootstrap-insights'],
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

  // WORLDMONITOR-YJ: hourly scheduled agents hit "Seeded world brief
  // unavailable" but the alarm could not say WHICH acceptance gate rejected
  // the snapshot — a stale producer (>60min degraded seeder window) and a
  // schema bug need opposite responses. The thrown message must name the
  // bounded rejection reason; the client-facing RPC error stays generic.
  it('names the rejection reason when the seeded snapshot is rejected', async () => {
    // `stale snapshot` is deliberately NOT in this list any more: age alone is
    // no longer a rejection. The producer preserves last-known-good when
    // synthesis fails, and throwing that away 60 minutes later handed Pro
    // callers a hard error while a complete brief sat in Redis for another two
    // hours (WORLDMONITOR-YJ). It is now served with stale:true — asserted by
    // the sibling case below and by tests/mcp-world-brief-stale-lkg.test.mjs.
    // Every reason that remains means the payload is absent or BROKEN, not
    // merely old — including a future timestamp, which is corruption rather
    // than staleness and leaves no trustworthy clock to report an age against.
    const scenarios = [
      {
        name: 'producer degraded status',
        overrides: { status: 'degraded' },
        reason: 'status-not-ok',
      },
      {
        name: 'future generatedAt',
        overrides: { generatedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
        reason: 'future-generated-at',
      },
      {
        name: 'no headlines',
        overrides: { topStories: [{ notATitle: true }] },
        reason: 'no-headlines',
      },
    ];

    const deps = makeDeps();
    let id = 700;
    for (const scenario of scenarios) {
      const warned = [];
      console.warn = (...args) => warned.push(args);
      globalThis.fetch = async (input) => {
        const { pathname } = new URL(String(input));
        if (pathname === '/api/infrastructure/v1/get-bootstrap-data') {
          return insightsResponse(scenario.overrides);
        }
        throw new Error(`Unexpected downstream URL: ${input}`);
      };

      const response = await mcpHandler(
        requestFor('https://api.worldmonitor.app/api/mcp', AUTH_CASES[0].headers, id++),
        deps,
      );
      assert.equal(response.status, 200, `${scenario.name}: transport status`);
      const rpc = await response.json();
      assert.equal(rpc.error?.code, -32003, `${scenario.name}: source-unavailable RPC code`);
      assert.deepEqual(
        rpc.error.data.unavailable_inputs,
        ['news:insights:v1'],
        `${scenario.name}: unavailable inputs`,
      );
      // The reason is operator-facing only — it must NOT leak into the
      // client-facing RPC message, which stays a stable generic string.
      assert.equal(rpc.error.message, 'Required data inputs are unavailable');

      const outageWarning = warned.find((args) => (
        args.some((arg) => arg instanceof Error && /Seeded world brief unavailable/.test(arg.message))
      ));
      assert.ok(outageWarning, `${scenario.name}: expected a tool-execution warning`);
      const outageError = outageWarning.find((arg) => arg instanceof Error);
      assert.equal(
        outageError.message,
        `Seeded world brief unavailable (${scenario.reason})`,
        `${scenario.name}: reason named in the operator-facing message`,
      );
    }
  });

  it('serves a stale snapshot instead of rejecting it (WORLDMONITOR-YJ)', async () => {
    // The counterpart to the scenario removed above: the SAME 2-hour-old
    // snapshot that used to produce reason `stale-snapshot` now returns the
    // brief, flagged. Kept in this suite so the routing contract still covers
    // staleness — from the serving side rather than the rejecting side.
    const deps = makeDeps();
    globalThis.fetch = async (input) => {
      const { pathname } = new URL(String(input));
      if (pathname === '/api/infrastructure/v1/get-bootstrap-data') {
        return insightsResponse({
          generatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        });
      }
      throw new Error(`Unexpected downstream URL: ${input}`);
    };

    const response = await mcpHandler(
      requestFor('https://api.worldmonitor.app/api/mcp', AUTH_CASES[0].headers, 760),
      deps,
    );
    assert.equal(response.status, 200, 'transport status');
    const rpc = await response.json();
    assert.equal(rpc.error, undefined, `must not raise: ${JSON.stringify(rpc.error ?? {})}`);
    const payload = JSON.parse(rpc.result.content[0].text);
    assert.ok(payload.brief, 'the brief itself is served');
    assert.equal(payload.stale, true, 'flagged as stale');
    assert.ok(payload.ageMinutes >= 118, `ageMinutes should be ~120, got ${payload.ageMinutes}`);
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
        if (pathname === '/api/infrastructure/v1/get-bootstrap-data') return scenario.response();
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
        (candidate) => candidate.downstream_operation === 'bootstrap-insights',
      );
      assert.ok(event, `${scenario.name}: bootstrap telemetry`);
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
      if (pathname === '/api/infrastructure/v1/get-bootstrap-data') {
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
      (candidate) => candidate.downstream_operation === 'bootstrap-insights',
    );
    assert.ok(event);
    assert.equal(event.status, 503);
    assert.equal(event.error_code, 'renewal_verification_pending');
    assert.equal(event.response_marker, 'billing_verification');
    assert.doesNotMatch(JSON.stringify(captured), new RegExp(SECRET_RESPONSE_DETAIL));
  });
});
