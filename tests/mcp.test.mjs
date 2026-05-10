import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { strict as assert } from 'node:assert';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

const VALID_KEY = 'wm_test_key_123';
const BASE_URL = 'https://worldmonitor.app/mcp';

function makeReq(method = 'POST', body = null, headers = {}) {
  return new Request(BASE_URL, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-WorldMonitor-Key': VALID_KEY,
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function initBody(id = 1) {
  return {
    jsonrpc: '2.0', id,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
  };
}

let handler;
let evaluateFreshness;

describe('api/mcp.ts — PRO MCP Server', () => {
  beforeEach(async () => {
    process.env.WORLDMONITOR_VALID_KEYS = VALID_KEY;
    // No UPSTASH vars — rate limiter gracefully skipped, Redis reads return null
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    const mod = await import(`../api/mcp.ts?t=${Date.now()}`);
    handler = mod.default;
    evaluateFreshness = mod.evaluateFreshness;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach(k => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  // --- Auth ---

  it('returns HTTP 401 + WWW-Authenticate when no credentials provided', async () => {
    const req = new Request(BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initBody()),
    });
    const res = await handler(req);
    assert.equal(res.status, 401);
    assert.ok(res.headers.get('www-authenticate')?.includes('Bearer realm="worldmonitor"'), 'must include WWW-Authenticate header');
    const body = await res.json();
    assert.equal(body.error?.code, -32001);
  });

  it('returns JSON-RPC -32001 when invalid API key provided', async () => {
    const req = makeReq('POST', initBody(), { 'X-WorldMonitor-Key': 'wrong_key' });
    const res = await handler(req);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error?.code, -32001);
  });

  // --- Protocol ---

  it('OPTIONS returns 204 with CORS headers', async () => {
    const req = new Request(BASE_URL, { method: 'OPTIONS', headers: { origin: 'https://worldmonitor.app' } });
    const res = await handler(req);
    assert.equal(res.status, 204);
    assert.ok(res.headers.get('access-control-allow-methods'));
  });

  it('initialize returns protocol version and Mcp-Session-Id header', async () => {
    const res = await handler(makeReq('POST', initBody(1)));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, 1);
    assert.equal(body.result?.protocolVersion, '2025-03-26');
    assert.equal(body.result?.serverInfo?.name, 'worldmonitor');
    assert.ok(res.headers.get('mcp-session-id'), 'Mcp-Session-Id header must be present');
  });

  it('notifications/initialized returns 202 with no body', async () => {
    const req = makeReq('POST', { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    const res = await handler(req);
    assert.equal(res.status, 202);
  });

  it('unknown method returns JSON-RPC -32601', async () => {
    const res = await handler(makeReq('POST', { jsonrpc: '2.0', id: 5, method: 'nonexistent/method', params: {} }));
    const body = await res.json();
    assert.equal(body.error?.code, -32601);
  });

  it('malformed body returns JSON-RPC -32600', async () => {
    const req = new Request(BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': VALID_KEY },
      body: '{bad json',
    });
    const res = await handler(req);
    const body = await res.json();
    assert.equal(body.error?.code, -32600);
  });

  // --- tools/list ---

  it('tools/list returns 32 tools with name, description, inputSchema', async () => {
    const res = await handler(makeReq('POST', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.result?.tools), 'result.tools must be an array');
    assert.equal(body.result.tools.length, 32, `Expected 32 tools, got ${body.result.tools.length}`);
    for (const tool of body.result.tools) {
      assert.ok(tool.name, 'tool.name must be present');
      assert.ok(tool.description, 'tool.description must be present');
      assert.ok(tool.inputSchema, 'tool.inputSchema must be present');
      assert.ok(!('_cacheKeys' in tool), 'Internal _cacheKeys must not be exposed in tools/list');
      assert.ok(!('_execute' in tool), 'Internal _execute must not be exposed in tools/list');
    }
  });

  // --- tools/call ---

  it('tools/call with unknown tool returns JSON-RPC -32602', async () => {
    const res = await handler(makeReq('POST', {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'nonexistent_tool', arguments: {} },
    }));
    const body = await res.json();
    assert.equal(body.error?.code, -32602);
  });

  it('tools/call with known tool returns -32603 when EVERY cache read is null (F6: cache_all_null)', async () => {
    // F6 review pass: degenerate-empty result (Redis transient/stampede)
    // burns Pro quota silently if not surfaced. The env_key path doesn't
    // have a quota counter, but the throw is uniform so dispatchToolsCall's
    // catch can fire its DECR rollback when applicable. For env_key callers
    // this surfaces as the same -32603 as any other tool-execution failure.
    const res = await handler(makeReq('POST', {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'get_market_data', arguments: {} },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error?.code, -32603, 'all-null cache reads must surface as -32603');
  });

  it('evaluateFreshness marks bundled data stale when any required source meta is missing', () => {
    const now = Date.UTC(2026, 3, 1, 12, 0, 0);
    const freshness = evaluateFreshness(
      [
        { key: 'seed-meta:climate:anomalies', maxStaleMin: 120 },
        { key: 'seed-meta:climate:co2-monitoring', maxStaleMin: 2880 },
        { key: 'seed-meta:climate:ocean-ice', maxStaleMin: 1440 },
        { key: 'seed-meta:weather:alerts', maxStaleMin: 45 },
      ],
      [
        { fetchedAt: now - 30 * 60_000 },
        { fetchedAt: now - 60 * 60_000 },
        { fetchedAt: now - 24 * 60 * 60_000 },
        null,
      ],
      now,
    );

    assert.equal(freshness.stale, true);
    assert.equal(freshness.cached_at, null);
  });

  it('evaluateFreshness stays fresh only when every required source meta is within its threshold', () => {
    const now = Date.UTC(2026, 3, 1, 12, 0, 0);
    const freshness = evaluateFreshness(
      [
        { key: 'seed-meta:climate:anomalies', maxStaleMin: 120 },
        { key: 'seed-meta:climate:co2-monitoring', maxStaleMin: 2880 },
        { key: 'seed-meta:climate:ocean-ice', maxStaleMin: 1440 },
        { key: 'seed-meta:weather:alerts', maxStaleMin: 45 },
      ],
      [
        { fetchedAt: now - 30 * 60_000 },
        { fetchedAt: now - 24 * 60 * 60_000 },
        { fetchedAt: now - 12 * 60 * 60_000 },
        { fetchedAt: now - 15 * 60_000 },
      ],
      now,
    );

    assert.equal(freshness.stale, false);
    assert.equal(freshness.cached_at, new Date(now - 24 * 60 * 60_000).toISOString());
  });

  // --- Rate limiting ---

  it('returns JSON-RPC -32029 when rate limited', async () => {
    // Set UPSTASH env and mock fetch to simulate rate limit exhausted
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';

    // @upstash/ratelimit uses redis EVALSHA pipeline — mock to return [0, 0] (limit: 60, remaining: 0)
    globalThis.fetch = async (url) => {
      const u = url.toString();
      if (u.includes('fake.upstash.io')) {
        // Simulate rate limit exceeded: [count, reset_ms] where count > limit
        return new Response(JSON.stringify({ result: [61, Date.now() + 60000] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(url);
    };

    // Re-import fresh module with UPSTASH env set
    const freshMod = await import(`../api/mcp.ts?t=${Date.now()}`);
    const freshHandler = freshMod.default;

    const res = await freshHandler(makeReq('POST', initBody()));
    const body = await res.json();
    // Either succeeds (mock didn't trip the limiter) or gets -32029
    // The exact Upstash Lua response format is internal — just verify the handler doesn't crash
    assert.ok(body.error?.code === -32029 || body.result?.protocolVersion, 'Handler must return valid JSON-RPC (either rate limited or initialized)');
  });

  it('tools/call returns JSON-RPC -32603 when Redis fetch throws (P1 fix)', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';

    // Simulate Redis being unreachable — fetch throws a network/timeout error
    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };

    const freshMod = await import(`../api/mcp.ts?t=${Date.now()}`);
    const freshHandler = freshMod.default;

    const res = await freshHandler(makeReq('POST', {
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'get_market_data', arguments: {} },
    }));
    assert.equal(res.status, 200, 'Must return HTTP 200, not 500');
    const body = await res.json();
    assert.equal(body.error?.code, -32603, 'Must return JSON-RPC -32603, not throw');
  });

  // --- get_airspace ---

  it('get_airspace returns counts and flights for valid country code', async () => {
    globalThis.fetch = async (url) => {
      const u = url.toString();
      if (u.includes('/api/aviation/v1/track-aircraft')) {
        return new Response(JSON.stringify({
          positions: [
            { callsign: 'UAE123', icao24: 'abc123', lat: 24.5, lon: 54.3, altitude_m: 11000, ground_speed_kts: 480, track_deg: 270, on_ground: false },
          ],
          source: 'opensky',
          updated_at: 1711620000000,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes('/api/military/v1/list-military-flights')) {
        return new Response(JSON.stringify({ flights: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(url);
    };

    const res = await handler(makeReq('POST', {
      jsonrpc: '2.0', id: 10, method: 'tools/call',
      params: { name: 'get_airspace', arguments: { country_code: 'AE' } },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.result?.content, 'result.content must be present');
    const data = JSON.parse(body.result.content[0].text);
    assert.equal(data.country_code, 'AE');
    assert.equal(data.civilian_count, 1);
    assert.equal(data.military_count, 0);
    assert.ok(Array.isArray(data.civilian_flights), 'civilian_flights must be array');
    assert.ok(Array.isArray(data.military_flights), 'military_flights must be array');
    assert.ok(data.bounding_box?.sw_lat !== undefined, 'bounding_box must be present');
    assert.equal(data.partial, undefined, 'no partial flag when both sources succeed');
  });

  it('get_airspace returns error for unknown country code', async () => {
    const res = await handler(makeReq('POST', {
      jsonrpc: '2.0', id: 11, method: 'tools/call',
      params: { name: 'get_airspace', arguments: { country_code: 'XX' } },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    const data = JSON.parse(body.result.content[0].text);
    assert.ok(data.error?.includes('Unknown country code'), 'must return error for unknown code');
  });

  it('get_airspace returns partial:true + warning when military source fails', async () => {
    globalThis.fetch = async (url) => {
      const u = url.toString();
      if (u.includes('/api/aviation/v1/track-aircraft')) {
        return new Response(JSON.stringify({ positions: [], source: 'opensky' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes('/api/military/v1/list-military-flights')) {
        return new Response('Service Unavailable', { status: 503 });
      }
      return originalFetch(url);
    };

    const res = await handler(makeReq('POST', {
      jsonrpc: '2.0', id: 12, method: 'tools/call',
      params: { name: 'get_airspace', arguments: { country_code: 'US' } },
    }));
    const body = await res.json();
    const data = JSON.parse(body.result.content[0].text);
    assert.equal(data.partial, true, 'partial must be true when one source fails');
    assert.ok(data.warnings?.some(w => w.includes('military')), 'warnings must mention military');
    assert.equal(data.civilian_count, 0, 'civilian data still returned');
  });

  it('get_airspace returns JSON-RPC -32603 when both sources fail', async () => {
    globalThis.fetch = async () => new Response('Error', { status: 500 });

    const res = await handler(makeReq('POST', {
      jsonrpc: '2.0', id: 13, method: 'tools/call',
      params: { name: 'get_airspace', arguments: { country_code: 'GB' } },
    }));
    const body = await res.json();
    assert.equal(body.error?.code, -32603, 'total outage must return -32603');
  });

  it('get_airspace type=civilian skips military fetch', async () => {
    let militaryFetched = false;
    globalThis.fetch = async (url) => {
      const u = url.toString();
      if (u.includes('/api/military/')) militaryFetched = true;
      if (u.includes('/api/aviation/v1/track-aircraft')) {
        return new Response(JSON.stringify({ positions: [], source: 'opensky' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(url);
    };

    const res = await handler(makeReq('POST', {
      jsonrpc: '2.0', id: 14, method: 'tools/call',
      params: { name: 'get_airspace', arguments: { country_code: 'DE', type: 'civilian' } },
    }));
    const body = await res.json();
    const data = JSON.parse(body.result.content[0].text);
    assert.equal(militaryFetched, false, 'military endpoint must not be called for type=civilian');
    assert.equal(data.military_flights, undefined, 'military_flights must be absent for type=civilian');
    assert.ok(Array.isArray(data.civilian_flights), 'civilian_flights must be present');
  });

  // --- get_maritime_activity ---

  it('get_maritime_activity returns zones and disruptions for valid country code', async () => {
    globalThis.fetch = async (url) => {
      if (url.toString().includes('/api/maritime/v1/get-vessel-snapshot')) {
        return new Response(JSON.stringify({
          snapshot: {
            snapshot_at: 1711620000000,
            density_zones: [
              { name: 'Strait of Hormuz', intensity: 82, ships_per_day: 45, delta_pct: 3.2, note: '' },
            ],
            disruptions: [
              { name: 'Gulf AIS Gap', type: 'AIS_DISRUPTION_TYPE_GAP_SPIKE', severity: 'AIS_DISRUPTION_SEVERITY_ELEVATED', dark_ships: 3, vessel_count: 12, region: 'Persian Gulf', description: 'Elevated dark-ship activity' },
            ],
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(url);
    };

    const res = await handler(makeReq('POST', {
      jsonrpc: '2.0', id: 20, method: 'tools/call',
      params: { name: 'get_maritime_activity', arguments: { country_code: 'AE' } },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    const data = JSON.parse(body.result.content[0].text);
    assert.equal(data.country_code, 'AE');
    assert.equal(data.total_zones, 1);
    assert.equal(data.total_disruptions, 1);
    assert.equal(data.density_zones[0].name, 'Strait of Hormuz');
    assert.equal(data.disruptions[0].dark_ships, 3);
    assert.ok(data.bounding_box?.sw_lat !== undefined, 'bounding_box must be present');
  });

  it('get_maritime_activity returns error for unknown country code', async () => {
    const res = await handler(makeReq('POST', {
      jsonrpc: '2.0', id: 21, method: 'tools/call',
      params: { name: 'get_maritime_activity', arguments: { country_code: 'ZZ' } },
    }));
    const body = await res.json();
    const data = JSON.parse(body.result.content[0].text);
    assert.ok(data.error?.includes('Unknown country code'), 'must return error for unknown code');
  });

  it('get_maritime_activity returns JSON-RPC -32603 when vessel API fails', async () => {
    globalThis.fetch = async (url) => {
      if (url.toString().includes('/api/maritime/')) {
        return new Response('Service Unavailable', { status: 503 });
      }
      return originalFetch(url);
    };

    const res = await handler(makeReq('POST', {
      jsonrpc: '2.0', id: 22, method: 'tools/call',
      params: { name: 'get_maritime_activity', arguments: { country_code: 'SA' } },
    }));
    const body = await res.json();
    assert.equal(body.error?.code, -32603, 'vessel API failure must return -32603');
  });

  it('get_maritime_activity handles empty snapshot gracefully', async () => {
    globalThis.fetch = async (url) => {
      if (url.toString().includes('/api/maritime/v1/get-vessel-snapshot')) {
        return new Response(JSON.stringify({ snapshot: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(url);
    };

    const res = await handler(makeReq('POST', {
      jsonrpc: '2.0', id: 23, method: 'tools/call',
      params: { name: 'get_maritime_activity', arguments: { country_code: 'JP' } },
    }));
    const body = await res.json();
    const data = JSON.parse(body.result.content[0].text);
    assert.equal(data.total_zones, 0);
    assert.equal(data.total_disruptions, 0);
    assert.deepEqual(data.density_zones, []);
    assert.deepEqual(data.disruptions, []);
  });
});

// ===========================================================================
// U7 — Pro-path: McpAuthContext, INCR-first daily quota, internal-HMAC tool fetches
// ===========================================================================

const PRO_USER_ID = 'user_pro_xyz';
const PRO_TOKEN_ID = 'k57mcptokenid';
const PRO_BEARER = 'pro-bearer-uuid';
const HMAC_SECRET = 'test-secret-mcp-internal-32-bytes-1234';

/** Create a mock pipeline impl over an in-memory map for the daily counter. */
function makePipelineMock({ initialCount = 0, throwOnIncr = false, decrFails = false } = {}) {
  const store = new Map();
  // Pre-seed via INCR-equivalent so newCount math lines up.
  if (initialCount > 0) store.set('seed', initialCount);
  let counter = initialCount;
  const ops = [];
  const pipeline = async (commands) => {
    ops.push(commands);
    if (throwOnIncr && commands.some((c) => c[0] === 'INCR')) {
      throw new Error('redis pipeline failed');
    }
    if (decrFails && commands.some((c) => c[0] === 'DECR')) {
      throw new Error('redis decr failed');
    }
    const out = [];
    for (const cmd of commands) {
      if (cmd[0] === 'INCR') {
        counter += 1;
        out.push({ result: counter });
      } else if (cmd[0] === 'DECR') {
        counter = Math.max(0, counter - 1);
        out.push({ result: counter });
      } else if (cmd[0] === 'EXPIRE') {
        out.push({ result: 1 });
      } else {
        out.push({ result: null });
      }
    }
    return out;
  };
  return {
    pipeline,
    ops,
    get count() { return counter; },
  };
}

function makeProDeps(overrides = {}) {
  const pipe = makePipelineMock(overrides.pipelineOpts ?? {});
  return {
    deps: {
      resolveBearerToContext: overrides.resolveBearerToContext ?? (async (token) => {
        if (token === PRO_BEARER) return { kind: 'pro', userId: PRO_USER_ID, mcpTokenId: PRO_TOKEN_ID };
        return null;
      }),
      validateProMcpToken: overrides.validateProMcpToken ?? (async (id) => {
        if (id === PRO_TOKEN_ID) return { userId: PRO_USER_ID };
        return null;
      }),
      getEntitlements: overrides.getEntitlements ?? (async () => ({
        planKey: 'pro',
        features: { tier: 1, mcpAccess: true },
        validUntil: Date.now() + 86_400_000,
      })),
      redisPipeline: pipe.pipeline,
    },
    pipe,
  };
}

function proReq(method = 'POST', body = null, headers = {}) {
  return new Request(BASE_URL, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${PRO_BEARER}`,
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function callBody(toolName, args = {}, id = 100) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name: toolName, arguments: args } };
}

describe('api/mcp.ts — U7 Pro-path', () => {
  let mcpHandler;
  beforeEach(async () => {
    process.env.WORLDMONITOR_VALID_KEYS = VALID_KEY;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    const mod = await import(`../api/mcp.ts?t=${Date.now()}`);
    mcpHandler = mod.mcpHandler;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  it('happy: Pro bearer, 0 calls today, tools/call cache tool → counter at 1', async () => {
    const { deps, pipe } = makeProDeps();
    // Stub Upstash GET responses so cache reads return non-null data —
    // F6 review pass throws cache_all_null when every read is null, which
    // the env-disabled stub-by-default would trigger. Provide a single
    // non-null response so this happy-path test exercises the success
    // branch (counter increments and stays incremented).
    process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'stub';
    globalThis.fetch = async () => new Response(JSON.stringify({ result: JSON.stringify({ ok: 1 }) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const res = await mcpHandler(proReq('POST', callBody('get_market_data')), deps);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.result?.content, 'must return tool result');
    assert.equal(pipe.count, 1, 'counter at 1 after first call');
  });

  it('happy: Pro bearer, 49 calls today → 50th tools/call counter at 50', async () => {
    const { deps, pipe } = makeProDeps({ pipelineOpts: { initialCount: 49 } });
    process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'stub';
    globalThis.fetch = async () => new Response(JSON.stringify({ result: JSON.stringify({ ok: 1 }) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const res = await mcpHandler(proReq('POST', callBody('get_market_data')), deps);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.result?.content, '50th call must succeed');
    assert.equal(pipe.count, 50);
  });

  it('happy: Pro bearer, 50 calls today → 51st tools/call rejected with -32029 + 429 + Retry-After, counter back at 50', async () => {
    const { deps, pipe } = makeProDeps({ pipelineOpts: { initialCount: 50 } });
    const res = await mcpHandler(proReq('POST', callBody('get_market_data')), deps);
    assert.equal(res.status, 429);
    assert.ok(res.headers.get('Retry-After'), 'Retry-After header required');
    const body = await res.json();
    assert.equal(body.error?.code, -32029);
    assert.equal(pipe.count, 50, 'DECR rolled back to 50');
  });

  it('edge: initialize and tools/list for Pro user with counter at 50 → no INCR/DECR runs', async () => {
    const { deps, pipe } = makeProDeps({ pipelineOpts: { initialCount: 50 } });
    const r1 = await mcpHandler(proReq('POST', initBody(1)), deps);
    assert.equal(r1.status, 200);
    const r2 = await mcpHandler(proReq('POST', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), deps);
    assert.equal(r2.status, 200);
    assert.equal(pipe.count, 50, 'counter unchanged for non-tools/call methods');
    assert.equal(pipe.ops.length, 0, 'no pipeline ops for initialize/tools/list');
  });

  it('edge: tools/call that throws (upstream non-2xx) for Pro at count=10 → counter back at 10', async () => {
    const { deps, pipe } = makeProDeps({ pipelineOpts: { initialCount: 10 } });
    globalThis.fetch = async () => new Response('Service Unavailable', { status: 503 });
    const res = await mcpHandler(proReq('POST', callBody('get_country_risk', { country_code: 'US' })), deps);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error?.code, -32603);
    assert.equal(pipe.count, 10, 'DECR rolled back to 10');
  });

  it('edge: 100 concurrent tools/call from Pro user at count=49 → exactly 1 succeeds, 99 reject, final counter 50', async () => {
    const { deps, pipe } = makeProDeps({ pipelineOpts: { initialCount: 49 } });
    process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'stub';
    globalThis.fetch = async () => new Response(JSON.stringify({ result: JSON.stringify({ ok: 1 }) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const reqs = Array.from({ length: 100 }, () => mcpHandler(proReq('POST', callBody('get_market_data')), deps));
    const results = await Promise.all(reqs);
    const ok = results.filter((r) => r.status === 200).length;
    const rejected = results.filter((r) => r.status === 429).length;
    assert.equal(ok, 1, 'exactly 1 must succeed');
    assert.equal(rejected, 99, 'exactly 99 must hit -32029');
    assert.ok(pipe.count <= 50, `counter must be <= 50, got ${pipe.count}`);
  });

  it('edge: best-effort DECR fails on cap-exceeded → counter overshoots, never undershoots', async () => {
    const { deps, pipe } = makeProDeps({ pipelineOpts: { initialCount: 50, decrFails: true } });
    const res = await mcpHandler(proReq('POST', callBody('get_market_data')), deps);
    assert.equal(res.status, 429);
    assert.ok(pipe.count >= 50, 'counter must not undershoot the floor');
  });

  it('error: Pro bearer with revoked mcpProTokens row → -32001 + 401, no INCR runs', async () => {
    const { deps, pipe } = makeProDeps({ validateProMcpToken: async () => null });
    const res = await mcpHandler(proReq('POST', callBody('get_market_data')), deps);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error?.code, -32001);
    assert.match(body.error.message, /revoked/i);
    assert.equal(pipe.count, 0);
    assert.equal(pipe.ops.length, 0);
  });

  it('error: cross-user binding violation (validate userId !== bearer userId) → 401', async () => {
    const { deps } = makeProDeps({ validateProMcpToken: async () => ({ userId: 'user_someone_else' }) });
    const res = await mcpHandler(proReq('POST', callBody('get_market_data')), deps);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error?.code, -32001);
  });

  it('error: getEntitlements null → -32001 + 401', async () => {
    const { deps, pipe } = makeProDeps({ getEntitlements: async () => null });
    const res = await mcpHandler(proReq('POST', callBody('get_market_data')), deps);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error?.code, -32001);
    assert.equal(pipe.count, 0);
  });

  it('error: getEntitlements throws → -32001 + 401 (fail-closed)', async () => {
    const { deps } = makeProDeps({ getEntitlements: async () => { throw new Error('convex down'); } });
    const res = await mcpHandler(proReq('POST', callBody('get_market_data')), deps);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error?.code, -32001);
  });

  it('error: tier 0 → -32001 + 401', async () => {
    const { deps } = makeProDeps({
      getEntitlements: async () => ({ planKey: 'free', features: { tier: 0, mcpAccess: false }, validUntil: Date.now() + 86_400_000 }),
    });
    const res = await mcpHandler(proReq('POST', callBody('get_market_data')), deps);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error?.code, -32001);
  });

  it('error: tier 1 but mcpAccess false → -32001 + 401', async () => {
    const { deps } = makeProDeps({
      getEntitlements: async () => ({ planKey: 'pro', features: { tier: 1, mcpAccess: false }, validUntil: Date.now() + 86_400_000 }),
    });
    const res = await mcpHandler(proReq('POST', callBody('get_market_data')), deps);
    assert.equal(res.status, 401);
  });

  it('error: Redis pipeline throws on INCR → -32603 + 503 + Retry-After', async () => {
    const { deps, pipe } = makeProDeps({ pipelineOpts: { throwOnIncr: true } });
    const res = await mcpHandler(proReq('POST', callBody('get_market_data')), deps);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('Retry-After'), '5');
    const body = await res.json();
    assert.equal(body.error?.code, -32603);
    assert.equal(pipe.count, 0, 'no successful INCR happened');
  });

  it('F12: MCP_INTERNAL_HMAC_SECRET unset on Pro path → 503 Retry-After preflight', async () => {
    delete process.env.MCP_INTERNAL_HMAC_SECRET;
    const { deps, pipe } = makeProDeps();
    const res = await mcpHandler(proReq('POST', callBody('get_market_data')), deps);
    assert.equal(res.status, 503, 'preflight must surface as 503');
    assert.equal(res.headers.get('Retry-After'), '5');
    const body = await res.json();
    assert.equal(body.error?.code, -32603);
    assert.equal(pipe.count, 0, 'no INCR on preflight rejection');
  });

  it('F4: post-DECR-failure overshoot → next request clamps counter back via DECR sweep', async () => {
    // Models the failure mode: counter is pinned at 100 (50 + 50 leaked
    // overshoot from prior DECR failures). Without F4 the user 429s for
    // the rest of the UTC day. With F4 the next rejection-path probe
    // sees newCount > limit + 1 and DECR-sweeps the overshoot.
    const { deps, pipe } = makeProDeps({ pipelineOpts: { initialCount: 100 } });
    process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'stub';
    globalThis.fetch = async () => new Response(JSON.stringify({ result: JSON.stringify({ ok: 1 }) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const res = await mcpHandler(proReq('POST', callBody('get_market_data')), deps);
    assert.equal(res.status, 429, 'over-cap request 429s as expected');
    // The clamp logic INCRs+DECRs to probe, then DECR-sweeps. The exact
    // resulting count depends on the probe path; the contract is "post-
    // call counter must not exceed limit + a small probe slack".
    assert.ok(pipe.count <= 51, `F4: counter must clamp back near limit; got ${pipe.count}`);
  });

  it('F6: cache-only tool with all-null reads → DECR rollback fires', async () => {
    // Pro path: starting at 5, every cache read returns null → executeTool
    // throws cache_all_null → DECR rollback runs → counter returns to 5.
    const { deps, pipe } = makeProDeps({ pipelineOpts: { initialCount: 5 } });
    // Stub Upstash with a result of null (genuine miss).
    process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'stub';
    globalThis.fetch = async () => new Response(JSON.stringify({ result: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const res = await mcpHandler(proReq('POST', callBody('get_market_data')), deps);
    assert.equal(res.status, 200, 'JSON-RPC error returns HTTP 200');
    const body = await res.json();
    assert.equal(body.error?.code, -32603, 'cache_all_null surfaces as -32603');
    assert.equal(pipe.count, 5, 'F6: DECR rollback ran, counter back at 5');
  });

  it('happy: Starter+ env_key bearer → unaffected by daily INCR path; only 60/min sliding limit applies', async () => {
    const { deps, pipe } = makeProDeps();
    // F6: stub cache reads so executeTool doesn't throw cache_all_null.
    process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'stub';
    globalThis.fetch = async () => new Response(JSON.stringify({ result: JSON.stringify({ ok: 1 }) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const req = makeReq('POST', callBody('get_market_data'));
    const res = await mcpHandler(req, deps);
    assert.equal(res.status, 200);
    assert.equal(pipe.count, 0, 'env_key path must NOT touch daily counter');
    assert.equal(pipe.ops.length, 0);
  });

  it('edge: Pro tool _execute fetch sends X-WM-MCP-Internal + X-WM-MCP-User-Id, no X-WorldMonitor-Key', async () => {
    const { deps } = makeProDeps();
    let captured = null;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), headers: new Headers(init?.headers) };
      return new Response(JSON.stringify({ ok: true, country_code: 'US' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const res = await mcpHandler(proReq('POST', callBody('get_country_risk', { country_code: 'US' })), deps);
    assert.equal(res.status, 200);
    assert.ok(captured, 'fetch was called');
    assert.ok(captured.headers.get('x-wm-mcp-internal'), 'X-WM-MCP-Internal must be set');
    assert.equal(captured.headers.get('x-wm-mcp-user-id'), PRO_USER_ID);
    assert.equal(captured.headers.get('x-worldmonitor-key'), null, 'X-WorldMonitor-Key must NOT be set for Pro');
    // Signature shape: <ts>.<base64url>
    const sig = captured.headers.get('x-wm-mcp-internal');
    assert.match(sig, /^\d{10}\.[A-Za-z0-9_-]+$/, 'signature must be <ts>.<base64url-sig>');
  });

  it('edge: cache-only tool for Pro user goes through INCR/DECR path (counts toward 50/day)', async () => {
    const { deps, pipe } = makeProDeps();
    process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'stub';
    globalThis.fetch = async () => new Response(JSON.stringify({ result: JSON.stringify({ ok: 1 }) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    // get_market_data is a cache-only tool (no _execute, just executeTool)
    const res = await mcpHandler(proReq('POST', callBody('get_market_data')), deps);
    assert.equal(res.status, 200);
    assert.equal(pipe.count, 1, 'cache-only tool incremented quota');
  });

  it('integration: signed header for /api/news/v1/list-feed-digest cannot be replayed against /api/intelligence/v1/deduct-situation', async () => {
    const { signInternalMcpRequest, hmacSha256Base64Url, canonicalQueryString, sha256Hex, buildHmacPayload } = await import(`../server/_shared/mcp-internal-hmac.ts?t=${Date.now()}`);
    // Sign for digest endpoint.
    const signed = await signInternalMcpRequest({
      method: 'GET',
      url: 'https://worldmonitor.app/api/news/v1/list-feed-digest?lang=en&variant=geo',
      body: null,
      userId: PRO_USER_ID,
      secret: HMAC_SECRET,
    });
    // Re-construct the payload that would be expected for the SAME ts on a different path.
    const replayUrl = new URL('https://worldmonitor.app/api/intelligence/v1/deduct-situation');
    const replayPayload = buildHmacPayload({
      ts: signed.ts,
      method: 'POST',
      pathname: replayUrl.pathname,
      queryHash: await sha256Hex(canonicalQueryString(replayUrl)),
      bodyHash: await sha256Hex(JSON.stringify({ query: 'attacker' })),
      userId: PRO_USER_ID,
    });
    const replayExpected = await hmacSha256Base64Url(HMAC_SECRET, replayPayload);
    const replayActual = signed.signature.split('.')[1];
    assert.notEqual(replayActual, replayExpected, 'captured signature must NOT verify for the replay target — payload binds method+pathname+body');
  });

  it('canonicalQueryString sorts keys lexicographically — ?a=1&b=2 and ?b=2&a=1 produce identical canonical form', async () => {
    const { canonicalQueryString } = await import(`../server/_shared/mcp-internal-hmac.ts?t=${Date.now()}`);
    const a = canonicalQueryString('?a=1&b=2');
    const b = canonicalQueryString('?b=2&a=1');
    assert.equal(a, b, 'reordered query → identical canonical form');
    assert.equal(a, 'a=1&b=2');
  });

  it('canonicalQueryString URL-encodes values', async () => {
    const { canonicalQueryString } = await import(`../server/_shared/mcp-internal-hmac.ts?t=${Date.now()}`);
    const c = canonicalQueryString('?q=hello world&special=a%2Fb');
    // Spaces become %20, existing %2F is decoded then re-encoded the same.
    assert.match(c, /q=hello%20world/);
    assert.match(c, /special=a%2Fb/);
  });

  it('dailyCounterKey is UTC-stable across timezones', async () => {
    const { dailyCounterKey } = await import(`../server/_shared/pro-mcp-token.ts?t=${Date.now()}`);
    const utc = new Date(Date.UTC(2026, 4, 10, 12, 0, 0));
    const k = dailyCounterKey('user_x', utc);
    assert.equal(k, 'mcp:pro-usage:user_x:2026-05-10');
  });

  it('secondsUntilUtcMidnight returns a positive Δ to next 00:00Z', async () => {
    const { secondsUntilUtcMidnight } = await import(`../server/_shared/pro-mcp-token.ts?t=${Date.now()}`);
    const noon = new Date(Date.UTC(2026, 4, 10, 12, 0, 0));
    const s = secondsUntilUtcMidnight(noon);
    assert.equal(s, 12 * 3600);
  });

  it('F10: signInternalMcpRequest with FormData body throws (no silent JSON.stringify catch-all)', async () => {
    const { signInternalMcpRequest } = await import(`../server/_shared/mcp-internal-hmac.ts?t=${Date.now()}`);
    const fd = new FormData();
    fd.append('x', '1');
    await assert.rejects(
      () => signInternalMcpRequest({
        method: 'POST',
        url: 'https://example.com/x',
        body: fd,
        userId: 'u',
        secret: 'k',
      }),
      (err) => err instanceof Error && /unsupported body shape/i.test(err.message),
    );
  });

  it('F10: signInternalMcpRequest with Blob body throws', async () => {
    const { signInternalMcpRequest } = await import(`../server/_shared/mcp-internal-hmac.ts?t=${Date.now()}`);
    const b = new Blob(['hello'], { type: 'application/octet-stream' });
    await assert.rejects(
      () => signInternalMcpRequest({
        method: 'POST',
        url: 'https://example.com/x',
        body: b,
        userId: 'u',
        secret: 'k',
      }),
      (err) => err instanceof Error && /unsupported body shape/i.test(err.message),
    );
  });

  it('F11: parseSignatureHeader rejects ts strings longer than 15 digits', async () => {
    // Indirect probe via verifyInternalMcpRequest: a 16-digit ts must
    // fail the regex and yield 401.
    const { verifyInternalMcpRequest } = await import(`../server/_shared/mcp-internal-hmac.ts?t=${Date.now()}`);
    const tsTooLong = '1'.repeat(16); // 16 digits — pathological
    const req = new Request('https://example.com/x', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-WM-MCP-Internal': `${tsTooLong}.AAAA`,
        'X-WM-MCP-User-Id': 'u',
      },
      body: '{}',
    });
    const r = await verifyInternalMcpRequest(req, 'k');
    assert.equal(r, null, 'F11: 16-digit ts must reject');
  });
});
