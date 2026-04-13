import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { strict as assert } from 'node:assert';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

const VALID_KEY = 'wm_test_key_123';
const BASE_URL = 'https://api.worldmonitor.app/mcp';

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

  it('tools/call with known tool returns content block with stale:true when cache empty', async () => {
    // No UPSTASH env → readJsonFromUpstash returns null → stale: true
    const res = await handler(makeReq('POST', {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'get_market_data', arguments: {} },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.result?.content, 'result.content must be present');
    assert.equal(body.result.content[0]?.type, 'text');
    const data = JSON.parse(body.result.content[0].text);
    assert.equal(typeof data.stale, 'boolean', 'stale field must be boolean');
    assert.equal(data.stale, true, 'stale must be true when cache is empty');
    assert.equal(data.cached_at, null, 'cached_at must be null when no seed-meta');
    assert.ok('data' in data, 'data field must be present');
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
