// Anonymous strict-client conformance (#4937 regression net).
//
// THE INVARIANT: every capability the ANONYMOUS `initialize` advertises must
// be anonymously exercisable, and every response must be HTTP 200 with the
// request id echoed. This is exactly what a strict MCP SDK client (Claude
// Desktop, mcp-remote, the reference SDKs) does right after connecting: it
// reads `result.capabilities` and enumerates each advertised surface. A
// gated method answers HTTP 401 with JSON-RPC id:null — the SDK transport
// cannot correlate that to the pending request, the request dangles to the
// client's 30s timeout, and Claude Desktop marks the server unstable and
// refuses all subsequent tools/call (customer-hit via mcp-remote, #4937).
//
// DESIGN: the method list is DERIVED from the initialize response, not
// hardcoded. A future PR that advertises a new capability (say
// `completions`) without adding an anon-exercisability mapping here fails
// loudly with instructions — it cannot ship silently gated. The walk uses
// thrower-stub deps: the anonymous path must never touch auth/entitlement
// deps, so any leak surfaces as a -32603 instead of passing quietly.
//
// The auth WALL is asserted too: tools/call (data/quota) must stay 401 for
// anonymous callers. Public discovery and the gate are two halves of one
// contract — this suite locks both directions.

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { BASE_URL } from './helpers/mcp-pro-deps.mjs';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

// Capability key → the JSON-RPC methods an anonymous client may exercise for
// it. `null` marks capabilities that carry no client-callable method (e.g.
// `extensions` is a handshake signal, not a surface). A capability key
// missing from this map fails the walk with instructions.
const CAPABILITY_METHODS = {
  tools: ['tools/list'],
  prompts: ['prompts/list', 'prompts/get'],
  resources: ['resources/list', 'resources/templates/list', 'resources/read'],
  logging: ['logging/setLevel'],
  extensions: null,
};

describe('api/mcp.ts — anonymous strict-client conformance (#4937)', () => {
  let mcpHandler;
  let deps;

  beforeEach(async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.MCP_TELEMETRY = 'false';

    // Public-resource reads fetch upstream via globalThis.fetch (never via
    // deps); answer any GET with a minimal cache envelope so the walk stays
    // hermetic.
    globalThis.fetch = async () => new Response(
      JSON.stringify({ result: JSON.stringify({ ok: 1 }) }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

    const unreachable = (name) => async () => {
      throw new Error(`anonymous path must not touch deps.${name}`);
    };
    deps = {
      resolveBearerToContext: unreachable('resolveBearerToContext'),
      validateProMcpToken: unreachable('validateProMcpToken'),
      getEntitlements: unreachable('getEntitlements'),
      redisPipeline: unreachable('redisPipeline'),
    };

    const mod = await import(`../api/mcp.ts?t=${Date.now()}-anonconf`);
    mcpHandler = mod.mcpHandler;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  const anonReq = (body) => new Request(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  let nextId = 100;
  async function anonCall(method, params = {}) {
    const id = nextId++;
    const res = await mcpHandler(anonReq({ jsonrpc: '2.0', id, method, params }), deps);
    assert.equal(res.status, 200,
      `anonymous ${method} must answer HTTP 200 — a non-200 is uncorrelatable to the pending request and hangs strict SDK clients to their 30s timeout (#4937)`);
    assert.equal(res.headers.get('Cache-Control'), 'no-store',
      `anonymous ${method} must carry Cache-Control: no-store`);
    const body = await res.json();
    assert.equal(body.id, id,
      `anonymous ${method} response must echo the request id (got ${JSON.stringify(body.id)}) — id:null is uncorrelatable`);
    assert.equal(body.error, undefined,
      `anonymous ${method} must not error: ${JSON.stringify(body.error)}`);
    return body.result;
  }

  it('walks every capability advertised by the anonymous initialize, exercising each anonymously', async () => {
    // 1. Anonymous handshake: initialize (200 + id echo) then the
    //    notifications/initialized ack (202, no body) — the strict-client
    //    connect sequence.
    const initId = nextId++;
    const initRes = await mcpHandler(anonReq({
      jsonrpc: '2.0', id: initId, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'anon-conformance', version: '1.0' } },
    }), deps);
    assert.equal(initRes.status, 200, 'anonymous initialize must be public');
    const initBody = await initRes.json();
    assert.equal(initBody.id, initId, 'initialize must echo the request id');
    const capabilities = initBody.result?.capabilities;
    assert.ok(capabilities && typeof capabilities === 'object', 'initialize must advertise capabilities');

    const notifRes = await mcpHandler(anonReq({ jsonrpc: '2.0', method: 'notifications/initialized' }), deps);
    assert.equal(notifRes.status, 202, 'anonymous notifications/initialized must be accepted');

    // 2. ping is spec-mandated regardless of advertised capabilities — SDK
    //    keepalives hang identically to #4937 if it is gated.
    const pingResult = await anonCall('ping');
    assert.deepEqual(pingResult, {}, 'ping must return an empty result object');

    // 3. Derived capability walk. Every advertised key must have a mapping;
    //    every mapped method must succeed anonymously with the id echoed.
    for (const [capability, value] of Object.entries(capabilities)) {
      assert.ok(capability in CAPABILITY_METHODS,
        `capability "${capability}" (${JSON.stringify(value)}) is advertised on the ANONYMOUS initialize but has no ` +
        `anon-exercisability mapping in CAPABILITY_METHODS. Add the mapping AND make its methods anonymously ` +
        `servable (PUBLIC_MCP_METHODS in api/mcp/handler.ts) — an advertised-but-gated method hangs strict SDK ` +
        `clients and gets the server marked unstable (#4937).`);
      const methods = CAPABILITY_METHODS[capability];
      if (!methods) continue;

      for (const method of methods) {
        switch (method) {
          case 'tools/list': {
            const r = await anonCall('tools/list');
            assert.ok(Array.isArray(r.tools) && r.tools.length > 0, 'anonymous tools/list must expose the catalog');
            break;
          }
          case 'prompts/list': {
            const r = await anonCall('prompts/list');
            assert.ok(Array.isArray(r.prompts) && r.prompts.length > 0, 'anonymous prompts/list must expose the catalog');
            break;
          }
          case 'prompts/get': {
            // Every listed prompt must be anonymously gettable — a client that
            // can list but not get hangs one layer deeper.
            const { prompts } = await anonCall('prompts/list');
            for (const prompt of prompts) {
              const args = {};
              for (const a of prompt.arguments ?? []) {
                if (a.required) args[a.name] = 'DE';
              }
              const r = await anonCall('prompts/get', { name: prompt.name, arguments: args });
              assert.ok(Array.isArray(r.messages) && r.messages.length > 0,
                `anonymous prompts/get(${prompt.name}) must render the template`);
            }
            break;
          }
          case 'resources/list': {
            const r = await anonCall('resources/list');
            assert.ok(Array.isArray(r.resources) && r.resources.length > 0, 'anonymous resources/list must expose the catalog');
            break;
          }
          case 'resources/templates/list': {
            const r = await anonCall('resources/templates/list');
            assert.ok(Array.isArray(r.resourceTemplates), 'anonymous resources/templates/list must return the template array');
            break;
          }
          case 'resources/read': {
            // Every CONCRETE resource surfaced by resources/list is part of
            // the anonymous discovery contract (#4719): an anonymous
            // validator (orank) reads each one back.
            const { resources } = await anonCall('resources/list');
            for (const resource of resources) {
              const r = await anonCall('resources/read', { uri: resource.uri });
              assert.ok(Array.isArray(r.contents) && r.contents.length > 0,
                `anonymous resources/read(${resource.uri}) must return contents — it is surfaced by the anonymous resources/list`);
            }
            break;
          }
          case 'logging/setLevel': {
            const r = await anonCall('logging/setLevel', { level: 'info' });
            assert.deepEqual(r, {}, 'anonymous logging/setLevel must ack with an empty result');
            break;
          }
          default:
            assert.fail(`CAPABILITY_METHODS maps "${capability}" to unhandled method "${method}" — add a walk step for it`);
        }
      }
    }
  });

  it('keeps the auth wall: anonymous tools/call still 401s (public discovery must not leak data methods)', async () => {
    const res = await mcpHandler(anonReq({
      jsonrpc: '2.0', id: 999, method: 'tools/call',
      params: { name: 'get_market_data', arguments: {} },
    }), deps);
    assert.equal(res.status, 401, 'tools/call is a data/quota method — must stay gated for anonymous callers');
    const body = await res.json();
    assert.equal(body.error?.code, -32001);
  });
});
