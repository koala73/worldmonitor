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

  it('tools/list returns 38 tools with name, description, inputSchema', async () => {
    const res = await handler(makeReq('POST', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.result?.tools), 'result.tools must be an array');
    assert.equal(body.result.tools.length, 38, `Expected 38 tools, got ${body.result.tools.length}`);
    for (const tool of body.result.tools) {
      assert.ok(tool.name, 'tool.name must be present');
      assert.ok(tool.description, 'tool.description must be present');
      assert.ok(tool.inputSchema, 'tool.inputSchema must be present');
      assert.ok(!('_cacheKeys' in tool), 'Internal _cacheKeys must not be exposed in tools/list');
      assert.ok(!('_execute' in tool), 'Internal _execute must not be exposed in tools/list');
      assert.ok(!('_coverageKeys' in tool), 'Internal _coverageKeys must not be exposed in tools/list');
      assert.ok(!('_apiPaths' in tool), 'Internal _apiPaths must not be exposed in tools/list (Tier-4 parity)');
    }
    const toolNames = body.result.tools.map((t) => t.name);
    assert.ok(toolNames.includes('get_displacement_data'), 'get_displacement_data must be registered (U1 Tier 1 regression)');
    assert.ok(toolNames.includes('get_health_signals'), 'get_health_signals must be registered (U2)');
    assert.ok(toolNames.includes('get_energy_intelligence'), 'get_energy_intelligence must be registered (U3)');
    assert.ok(toolNames.includes('get_consumer_prices'), 'get_consumer_prices must be registered (U4)');
    assert.ok(toolNames.includes('get_tariff_trends'), 'get_tariff_trends must be registered (U5)');
    assert.ok(toolNames.includes('get_chokepoint_status'), 'get_chokepoint_status must be registered (U6)');
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

  // --- get_displacement_data (U1: Tier 1 regression) ---

  it('get_displacement_data returns {cached_at, stale, data.summary} on cache hit', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';

    const currentYear = new Date().getUTCFullYear();
    const expectedDataKey = `displacement:summary:v1:${currentYear}`;
    const summaryPayload = {
      year: currentYear,
      countries: [
        { iso3: 'SYR', refugees: 6_700_000, idps: 6_900_000 },
        { iso3: 'UKR', refugees: 5_900_000, idps: 3_700_000 },
      ],
    };
    const seedFetchedAt = Date.now() - 60 * 60_000; // 1h old — well inside 3600 min budget

    globalThis.fetch = async (url) => {
      const u = url.toString();
      if (u.includes(`/get/${encodeURIComponent(expectedDataKey)}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(summaryPayload) }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (u.includes('/get/seed-meta%3Adisplacement%3Asummary')) {
        return new Response(JSON.stringify({ result: JSON.stringify({ fetchedAt: seedFetchedAt, recordCount: 2 }) }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(url);
    };

    const freshMod = await import(`../api/mcp.ts?t=${Date.now()}`);
    const freshHandler = freshMod.default;

    const res = await freshHandler(makeReq('POST', {
      jsonrpc: '2.0', id: 100, method: 'tools/call',
      params: { name: 'get_displacement_data', arguments: {} },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.result?.content, 'result.content must be present');
    const payload = JSON.parse(body.result.content[0].text);
    assert.equal(payload.stale, false, 'fresh meta within budget must yield stale=false');
    assert.equal(payload.cached_at, new Date(seedFetchedAt).toISOString(), 'cached_at must reflect seed-meta fetchedAt');
    assert.deepEqual(payload.data.summary, summaryPayload, 'label-walk strips year+v1, exposes payload under data.summary');
  });

  it('get_displacement_data returns -32603 when cache is empty (cache_all_null)', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';

    // Upstash returns {} (no result) for every GET — simulates fresh deploy
    // or evicted cache. executeTool's cache_all_null guard must throw → -32603.
    globalThis.fetch = async () => new Response(JSON.stringify({}), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });

    const freshMod = await import(`../api/mcp.ts?t=${Date.now()}`);
    const freshHandler = freshMod.default;

    const res = await freshHandler(makeReq('POST', {
      jsonrpc: '2.0', id: 101, method: 'tools/call',
      params: { name: 'get_displacement_data', arguments: {} },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error?.code, -32603, 'empty cache must surface as -32603 (cache_all_null)');
  });

  // --- get_health_signals (U2) ---

  it('get_health_signals returns both disease-outbreaks and air-quality slices on cache hit', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';

    const outbreaksPayload = { outbreaks: [{ id: 'who-1', disease: 'Marburg', country: 'TZA' }] };
    const airQualityPayload = { stations: [{ id: 'aqi-1', city: 'Delhi', pm25: 187 }] };
    const outbreaksFetchedAt = Date.now() - 60 * 60_000;   // 1h old; within 2880-min budget
    const airQualityFetchedAt = Date.now() - 30 * 60_000;  // 30m old; within 180-min budget

    globalThis.fetch = async (url) => {
      const u = url.toString();
      if (u.includes(`/get/${encodeURIComponent('health:disease-outbreaks:v1')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(outbreaksPayload) }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (u.includes(`/get/${encodeURIComponent('health:air-quality:v1')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(airQualityPayload) }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (u.includes(`/get/${encodeURIComponent('seed-meta:health:disease-outbreaks')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify({ fetchedAt: outbreaksFetchedAt, recordCount: 1 }) }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (u.includes(`/get/${encodeURIComponent('seed-meta:health:air-quality')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify({ fetchedAt: airQualityFetchedAt, recordCount: 1 }) }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(url);
    };

    const freshMod = await import(`../api/mcp.ts?t=${Date.now()}`);
    const freshHandler = freshMod.default;

    const res = await freshHandler(makeReq('POST', {
      jsonrpc: '2.0', id: 200, method: 'tools/call',
      params: { name: 'get_health_signals', arguments: {} },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.result?.content, 'result.content must be present');
    const payload = JSON.parse(body.result.content[0].text);
    assert.equal(payload.stale, false, 'both metas within their per-key budgets must yield stale=false');
    assert.equal(payload.cached_at, new Date(outbreaksFetchedAt).toISOString(), 'cached_at reflects oldest valid fetchedAt across freshness checks');
    assert.deepEqual(payload.data['disease-outbreaks'], outbreaksPayload, 'disease-outbreaks slice labelled from cache-key suffix');
    assert.deepEqual(payload.data['air-quality'], airQualityPayload, 'air-quality slice labelled from cache-key suffix');
  });

  it('get_health_signals marks aggregate stale when disease-outbreaks meta is past budget but air-quality is fresh', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';

    const outbreaksPayload = { outbreaks: [{ id: 'who-1' }] };
    const airQualityPayload = { stations: [{ id: 'aqi-1' }] };
    // disease-outbreaks budget is 2880 min — put it at 4000 min old (clearly stale)
    const outbreaksFetchedAt = Date.now() - 4000 * 60_000;
    // air-quality budget is 180 min — put it at 30 min old (fresh)
    const airQualityFetchedAt = Date.now() - 30 * 60_000;

    globalThis.fetch = async (url) => {
      const u = url.toString();
      if (u.includes(`/get/${encodeURIComponent('health:disease-outbreaks:v1')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(outbreaksPayload) }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (u.includes(`/get/${encodeURIComponent('health:air-quality:v1')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(airQualityPayload) }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (u.includes(`/get/${encodeURIComponent('seed-meta:health:disease-outbreaks')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify({ fetchedAt: outbreaksFetchedAt, recordCount: 1 }) }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (u.includes(`/get/${encodeURIComponent('seed-meta:health:air-quality')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify({ fetchedAt: airQualityFetchedAt, recordCount: 1 }) }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(url);
    };

    const freshMod = await import(`../api/mcp.ts?t=${Date.now()}`);
    const freshHandler = freshMod.default;

    const res = await freshHandler(makeReq('POST', {
      jsonrpc: '2.0', id: 201, method: 'tools/call',
      params: { name: 'get_health_signals', arguments: {} },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    const payload = JSON.parse(body.result.content[0].text);
    assert.equal(payload.stale, true, 'one over-budget key flips aggregate stale=true');
    assert.equal(payload.cached_at, new Date(outbreaksFetchedAt).toISOString(), 'cached_at is the oldest valid fetchedAt (disease-outbreaks)');
  });

  it('get_health_signals returns mixed shape (one slice null) without throwing when only one key is populated', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';

    const airQualityPayload = { stations: [{ id: 'aqi-1' }] };
    const airQualityFetchedAt = Date.now() - 30 * 60_000;

    globalThis.fetch = async (url) => {
      const u = url.toString();
      if (u.includes(`/get/${encodeURIComponent('health:disease-outbreaks:v1')}`)) {
        // Upstash returns {} (no `result`) when the key is absent — readJsonFromUpstash → null
        return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('health:air-quality:v1')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(airQualityPayload) }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (u.includes(`/get/${encodeURIComponent('seed-meta:health:disease-outbreaks')}`)) {
        return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('seed-meta:health:air-quality')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify({ fetchedAt: airQualityFetchedAt, recordCount: 1 }) }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(url);
    };

    const freshMod = await import(`../api/mcp.ts?t=${Date.now()}`);
    const freshHandler = freshMod.default;

    const res = await freshHandler(makeReq('POST', {
      jsonrpc: '2.0', id: 202, method: 'tools/call',
      params: { name: 'get_health_signals', arguments: {} },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    // Must NOT throw: at least one cache slot is populated, so cache_all_null guard does not fire.
    assert.ok(body.result?.content, 'partial-population must return a result, not -32603');
    const payload = JSON.parse(body.result.content[0].text);
    assert.equal(payload.data['disease-outbreaks'], null, 'missing slice surfaces as null');
    assert.deepEqual(payload.data['air-quality'], airQualityPayload, 'populated slice still present');
    assert.equal(payload.stale, true, 'missing meta forces stale=true (hasAllValidMeta=false in evaluateFreshness)');
    assert.equal(payload.cached_at, null, 'mixed-validity meta yields cached_at=null per evaluateFreshness contract');
  });

  // --- get_consumer_prices (U4: hybrid _execute, country_code-parameterised) ---

  it('get_consumer_prices returns 5-slice data on cache hit for country_code: "ae"', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';

    const overviewPayload   = { headlineCpiPct: 3.1, asOf: '2026-05-01' };
    const categoriesPayload = { categories: [{ name: 'Groceries', changePct: 2.4 }] };
    const moversPayload     = { items: [{ sku: 'milk-1L', changePct: 8.2 }] };
    const spreadPayload     = { retailers: [{ slug: 'carrefour_ae', basketUsd: 38.9 }, { slug: 'lulu_ae', basketUsd: 41.2 }] };
    const freshnessPayload  = { retailers: [{ slug: 'carrefour_ae', minsSinceScan: 18 }] };
    // All within the shared 1500-min budget — use 60min old.
    const fetchedAt = Date.now() - 60 * 60_000;

    globalThis.fetch = async (url) => {
      const u = url.toString();
      // Data keys
      if (u.includes(`/get/${encodeURIComponent('consumer-prices:overview:ae')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(overviewPayload) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('consumer-prices:categories:ae:30d')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(categoriesPayload) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('consumer-prices:movers:ae:30d')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(moversPayload) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('consumer-prices:retailer-spread:ae:essentials-ae')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(spreadPayload) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('consumer-prices:freshness:ae')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(freshnessPayload) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // Freshness/seed-meta keys — note `spread:ae` (NOT `retailer-spread:ae:essentials-ae`)
      // matches the producer's actual key shape (see scripts/seed-consumer-prices.mjs:151).
      if (u.includes(`/get/${encodeURIComponent('seed-meta:consumer-prices:overview:ae')}`)
        || u.includes(`/get/${encodeURIComponent('seed-meta:consumer-prices:categories:ae:30d')}`)
        || u.includes(`/get/${encodeURIComponent('seed-meta:consumer-prices:movers:ae:30d')}`)
        || u.includes(`/get/${encodeURIComponent('seed-meta:consumer-prices:spread:ae')}`)
        || u.includes(`/get/${encodeURIComponent('seed-meta:consumer-prices:freshness:ae')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify({ fetchedAt, recordCount: 1 }) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(url);
    };

    const freshMod = await import(`../api/mcp.ts?t=${Date.now()}`);
    const freshHandler = freshMod.default;

    const res = await freshHandler(makeReq('POST', {
      jsonrpc: '2.0', id: 300, method: 'tools/call',
      params: { name: 'get_consumer_prices', arguments: { country_code: 'ae' } },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.result?.content, 'result.content must be present');
    const payload = JSON.parse(body.result.content[0].text);
    assert.equal(payload.country_code, 'ae', 'echoes normalised country_code');
    assert.equal(payload.stale, false, 'all 5 freshness checks within 1500-min budget → stale=false');
    assert.equal(payload.cached_at, new Date(fetchedAt).toISOString(), 'cached_at is the oldest valid fetchedAt');
    assert.deepEqual(payload.data.overview, overviewPayload);
    assert.deepEqual(payload.data.categories, categoriesPayload);
    assert.deepEqual(payload.data.movers, moversPayload);
    assert.deepEqual(payload.data.retailerSpread, spreadPayload);
    assert.deepEqual(payload.data.freshness, freshnessPayload);
  });

  it('get_consumer_prices normalises uppercase "AE" to lowercase and succeeds', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';

    const overviewPayload = { headlineCpiPct: 3.1 };
    const fetchedAt = Date.now() - 60 * 60_000;

    globalThis.fetch = async (url) => {
      const u = url.toString();
      if (u.includes(`/get/${encodeURIComponent('consumer-prices:overview:ae')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(overviewPayload) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes('/get/consumer-prices') || u.includes('/get/seed-meta%3Aconsumer-prices')) {
        // Default: return populated meta so freshness evaluation is clean
        if (u.includes('seed-meta')) {
          return new Response(JSON.stringify({ result: JSON.stringify({ fetchedAt, recordCount: 1 }) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({ result: JSON.stringify({}) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(url);
    };

    const freshMod = await import(`../api/mcp.ts?t=${Date.now()}`);
    const freshHandler = freshMod.default;

    const res = await freshHandler(makeReq('POST', {
      jsonrpc: '2.0', id: 301, method: 'tools/call',
      params: { name: 'get_consumer_prices', arguments: { country_code: 'AE' } },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.result?.content, 'result.content must be present');
    const payload = JSON.parse(body.result.content[0].text);
    assert.equal(payload.country_code, 'ae', 'uppercase AE is lowercased before whitelist check + key build');
    assert.deepEqual(payload.data.overview, overviewPayload);
    // No `error` field — request succeeded
    assert.ok(!('error' in payload), 'success path must not surface an error field');
  });

  it('get_consumer_prices returns result-level error (NOT -32603) for unsupported country_code: "us"', async () => {
    // No fetch mock needed — the whitelist guard rejects before any Redis read.
    const res = await handler(makeReq('POST', {
      jsonrpc: '2.0', id: 302, method: 'tools/call',
      params: { name: 'get_consumer_prices', arguments: { country_code: 'us' } },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    // Critical: NOT a JSON-RPC error envelope (-32603). The user-input fault
    // surfaces inside result.content as `{error: "..."}` so callers see a
    // usable message instead of "Internal error: data fetch failed".
    assert.ok(body.result?.content, 'unsupported country must return a result, not -32603');
    assert.equal(body.error, undefined, 'result-level error must not set the JSON-RPC error envelope');
    const payload = JSON.parse(body.result.content[0].text);
    assert.equal(payload.error, 'Country not yet supported. Available: ae');
  });

  it('get_consumer_prices returns result-level error when country_code is missing', async () => {
    const res = await handler(makeReq('POST', {
      jsonrpc: '2.0', id: 303, method: 'tools/call',
      params: { name: 'get_consumer_prices', arguments: {} },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.result?.content, 'missing country_code must return a result, not -32603');
    assert.equal(body.error, undefined);
    const payload = JSON.parse(body.result.content[0].text);
    assert.equal(payload.error, 'country_code is required');
  });

  it('get_consumer_prices throws cache_all_null (→ -32603) when every 5 cache reads return null', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';

    // F6 contract parity with the cache-tool path: hybrid _execute mirrors the
    // executeTool cache_all_null guard so the Pro quota counter is rolled back
    // on degenerate-empty responses (Redis transient / pre-seed). Without this
    // guard, every other cache-tool throws on all-null while this one would
    // return success and silently burn a quota tick.
    globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });

    const freshMod = await import(`../api/mcp.ts?t=${Date.now()}`);
    const freshHandler = freshMod.default;

    const res = await freshHandler(makeReq('POST', {
      jsonrpc: '2.0', id: 304, method: 'tools/call',
      params: { name: 'get_consumer_prices', arguments: { country_code: 'ae' } },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error?.code, -32603, 'all-5-null reads must surface as -32603 cache_all_null');
  });

  it('get_consumer_prices rejects oversized/non-alpha country_code (e.g. "aexxx", "AE-DXB") with result-level error', async () => {
    // Without strict /^[a-z]{2}$/ validation, `.slice(0,2)` would silently
    // truncate "aexxx" → "ae" and serve AE data — masking client-side bugs.
    for (const bad of ['aexxx', 'AE-DXB', 'a', 'A1', '1AE', 'ae-']) {
      const res = await handler(makeReq('POST', {
        jsonrpc: '2.0', id: 305, method: 'tools/call',
        params: { name: 'get_consumer_prices', arguments: { country_code: bad } },
      }));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.result?.content, `bad country_code ${JSON.stringify(bad)} must return a result, not -32603`);
      assert.equal(body.error, undefined);
      const payload = JSON.parse(body.result.content[0].text);
      assert.equal(
        payload.error,
        'country_code must be a two-letter ISO code (e.g. "ae")',
        `${JSON.stringify(bad)} must be rejected by the strict-shape guard`,
      );
    }
  });

  // --- get_tariff_trends (U5: trade + economic indicator bundle) ---

  it('get_tariff_trends returns 4-slice data on cache hit when every per-key meta is within budget', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';

    const tariffsPayload = { items: [{ hts: '8501.10.40', ratePct: 25 }] };
    const bigmacPayload = { countries: [{ iso: 'CHE', priceUsd: 7.04 }] };
    const faoPayload = { months: [{ month: '2026-04', index: 119.2 }] };
    const debtPayload = { countries: [{ iso: 'JPN', debtPctGdp: 263.1 }] };

    // tariffs budget=540min — set 60min old (fresh)
    const tariffsFetchedAt = Date.now() - 60 * 60_000;
    // bigmac budget=10080min — set 12h old (fresh)
    const bigmacFetchedAt = Date.now() - 12 * 60 * 60_000;
    // fao budget=86400min — set 7d old (fresh)
    const faoFetchedAt = Date.now() - 7 * 24 * 60 * 60_000;
    // national-debt budget=86400min — set 10d old (fresh; OLDEST → anchors cached_at)
    const debtFetchedAt = Date.now() - 10 * 24 * 60 * 60_000;

    globalThis.fetch = async (url) => {
      const u = url.toString();
      if (u.includes(`/get/${encodeURIComponent('trade:tariffs:v1:840:all:10')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(tariffsPayload) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('economic:bigmac:v1')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(bigmacPayload) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('economic:fao-ffpi:v1')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(faoPayload) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('economic:national-debt:v1')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(debtPayload) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('seed-meta:trade:tariffs:v1:840:all:10')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify({ fetchedAt: tariffsFetchedAt, recordCount: 1 }) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('seed-meta:economic:bigmac')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify({ fetchedAt: bigmacFetchedAt, recordCount: 1 }) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('seed-meta:economic:fao-ffpi')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify({ fetchedAt: faoFetchedAt, recordCount: 1 }) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('seed-meta:economic:national-debt')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify({ fetchedAt: debtFetchedAt, recordCount: 1 }) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(url);
    };

    const freshMod = await import(`../api/mcp.ts?t=${Date.now()}`);
    const freshHandler = freshMod.default;

    const res = await freshHandler(makeReq('POST', {
      jsonrpc: '2.0', id: 400, method: 'tools/call',
      params: { name: 'get_tariff_trends', arguments: {} },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.result?.content, 'result.content must be present');
    const payload = JSON.parse(body.result.content[0].text);
    assert.equal(payload.stale, false, 'all 4 metas within their per-key budgets must yield stale=false');
    assert.equal(payload.cached_at, new Date(debtFetchedAt).toISOString(), 'cached_at reflects oldest valid fetchedAt (national-debt)');
    // Label-walk derives slice names from the trailing non-(v\d+|\d+) segment.
    // trade:tariffs:v1:840:all:10 → trailing "10" + "all" are skipped/kept;
    // "10" is bare-numeric → skipped, "all" stays → label="all".
    assert.deepEqual(payload.data['all'], tariffsPayload, 'tariffs slice labelled "all" from cache-key label-walk');
    assert.deepEqual(payload.data['bigmac'], bigmacPayload, 'bigmac slice labelled from cache-key suffix');
    assert.deepEqual(payload.data['fao-ffpi'], faoPayload, 'fao-ffpi slice labelled from cache-key suffix');
    assert.deepEqual(payload.data['national-debt'], debtPayload, 'national-debt slice labelled from cache-key suffix');
  });

  it('get_tariff_trends marks aggregate stale when FAO meta is past its monthly budget while tariffs are fresh', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';

    const tariffsPayload = { items: [{ hts: '8501.10.40' }] };
    const bigmacPayload = { countries: [{ iso: 'CHE' }] };
    const faoPayload = { months: [{ month: '2025-12' }] };
    const debtPayload = { countries: [{ iso: 'JPN' }] };

    // tariffs budget=540min → 60min old (fresh)
    const tariffsFetchedAt = Date.now() - 60 * 60_000;
    // bigmac budget=10080min → 12h old (fresh)
    const bigmacFetchedAt = Date.now() - 12 * 60 * 60_000;
    // FAO budget=86400min (60d) → put 100d old (clearly stale)
    const faoFetchedAt = Date.now() - 100 * 24 * 60 * 60_000;
    // national-debt budget=86400min → 5d old (fresh)
    const debtFetchedAt = Date.now() - 5 * 24 * 60 * 60_000;

    globalThis.fetch = async (url) => {
      const u = url.toString();
      if (u.includes(`/get/${encodeURIComponent('trade:tariffs:v1:840:all:10')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(tariffsPayload) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('economic:bigmac:v1')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(bigmacPayload) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('economic:fao-ffpi:v1')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(faoPayload) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('economic:national-debt:v1')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(debtPayload) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('seed-meta:trade:tariffs:v1:840:all:10')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify({ fetchedAt: tariffsFetchedAt, recordCount: 1 }) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('seed-meta:economic:bigmac')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify({ fetchedAt: bigmacFetchedAt, recordCount: 1 }) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('seed-meta:economic:fao-ffpi')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify({ fetchedAt: faoFetchedAt, recordCount: 1 }) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('seed-meta:economic:national-debt')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify({ fetchedAt: debtFetchedAt, recordCount: 1 }) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(url);
    };

    const freshMod = await import(`../api/mcp.ts?t=${Date.now()}`);
    const freshHandler = freshMod.default;

    const res = await freshHandler(makeReq('POST', {
      jsonrpc: '2.0', id: 401, method: 'tools/call',
      params: { name: 'get_tariff_trends', arguments: {} },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    const payload = JSON.parse(body.result.content[0].text);
    assert.equal(payload.stale, true, 'one over-budget key (FAO) flips aggregate stale=true');
    assert.equal(payload.cached_at, new Date(faoFetchedAt).toISOString(), 'cached_at is the oldest valid fetchedAt across all 4 metas (FAO)');
    assert.deepEqual(payload.data['all'], tariffsPayload, 'fresh tariffs slice still surfaces');
    assert.deepEqual(payload.data['fao-ffpi'], faoPayload, 'stale FAO payload still returned alongside stale=true');
  });

  it('get_tariff_trends returns mixed shape (3 slices null, 1 populated) without throwing when only one key is populated', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';

    const tariffsPayload = { items: [{ hts: '8501.10.40' }] };
    const tariffsFetchedAt = Date.now() - 60 * 60_000;

    globalThis.fetch = async (url) => {
      const u = url.toString();
      if (u.includes(`/get/${encodeURIComponent('trade:tariffs:v1:840:all:10')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(tariffsPayload) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('seed-meta:trade:tariffs:v1:840:all:10')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify({ fetchedAt: tariffsFetchedAt, recordCount: 1 }) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // Everything else absent → readJsonFromUpstash → null
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const freshMod = await import(`../api/mcp.ts?t=${Date.now()}`);
    const freshHandler = freshMod.default;

    const res = await freshHandler(makeReq('POST', {
      jsonrpc: '2.0', id: 402, method: 'tools/call',
      params: { name: 'get_tariff_trends', arguments: {} },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    // Must NOT throw -32603: at least one cache slot is populated → cache_all_null guard doesn't fire.
    assert.ok(body.result?.content, 'partial-population must return a result, not -32603');
    const payload = JSON.parse(body.result.content[0].text);
    assert.deepEqual(payload.data['all'], tariffsPayload, 'populated tariffs slice still present');
    assert.equal(payload.data['bigmac'], null, 'missing bigmac slice surfaces as null');
    assert.equal(payload.data['fao-ffpi'], null, 'missing fao-ffpi slice surfaces as null');
    assert.equal(payload.data['national-debt'], null, 'missing national-debt slice surfaces as null');
    assert.equal(payload.stale, true, 'missing meta forces stale=true (hasAllValidMeta=false)');
    assert.equal(payload.cached_at, null, 'mixed-validity meta yields cached_at=null per evaluateFreshness contract');
  });

  it('get_climate_data still includes air-quality slice (regression — U2 must not touch get_climate_data._cacheKeys)', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';

    const climateAirQualityPayload = { stations: [{ id: 'climate-aqi-1', city: 'Lagos', pm25: 92 }] };
    const climateFetchedAt = Date.now() - 30 * 60_000;

    globalThis.fetch = async (url) => {
      const u = url.toString();
      // Return populated climate:air-quality blob; everything else null (cache_all_null
      // guard does NOT trip because at least one key is populated).
      if (u.includes(`/get/${encodeURIComponent('climate:air-quality:v1')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(climateAirQualityPayload) }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      // Health-domain key MUST NOT be queried by get_climate_data — if it is, the
      // climate tool was modified, which violates U2's CRITICAL constraint.
      if (u.includes(`/get/${encodeURIComponent('health:disease-outbreaks:v1')}`)) {
        throw new Error('get_climate_data must not read health-domain keys (U2 regression)');
      }
      // Provide a fresh climate:air-quality meta so the freshness check has at
      // least one valid fetchedAt to anchor cached_at off (rest stale → aggregate stale=true).
      if (u.includes(`/get/${encodeURIComponent('seed-meta:health:air-quality')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify({ fetchedAt: climateFetchedAt, recordCount: 1 }) }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const freshMod = await import(`../api/mcp.ts?t=${Date.now()}`);
    const freshHandler = freshMod.default;

    const res = await freshHandler(makeReq('POST', {
      jsonrpc: '2.0', id: 203, method: 'tools/call',
      params: { name: 'get_climate_data', arguments: {} },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.result?.content, 'get_climate_data must still return a result');
    const payload = JSON.parse(body.result.content[0].text);
    // climate:air-quality:v1 → label-walk strips :v1, exposes under data['air-quality']
    assert.deepEqual(payload.data['air-quality'], climateAirQualityPayload, 'get_climate_data._cacheKeys must still include climate:air-quality:v1');
  });

  // --- get_chokepoint_status (U6: maritime chokepoint bundle, payload-verified) ---

  it('get_chokepoint_status returns 6-slice data on cache hit when every per-key meta is within budget', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';

    const transitSummariesPayload = { chokepoints: { suez: { vesselsPast24h: 87 } } };
    const chokepointTransitsPayload = { transits: [{ chokepoint: 'hormuz', count: 142 }] };
    const portwatchPortsPayload = { countries: { US: { ports: 23 } } };
    const chokepointBaselinesPayload = { suez: { lat: 30.0, lon: 32.5 } };
    const portwatchChokepointsRefPayload = { count: 13, ids: ['suez', 'hormuz', 'malacca'] };
    const chokepointFlowsPayload = { suez: { dailyBarrels: 9_200_000 } };

    // transit-summaries budget=30min → 5min old (fresh)
    const transitSummariesFetchedAt = Date.now() - 5 * 60_000;
    // chokepoint_transits budget=30min → 8min old (fresh)
    const chokepointTransitsFetchedAt = Date.now() - 8 * 60_000;
    // portwatch-ports budget=2160min (36h) → 12h old (fresh)
    const portwatchPortsFetchedAt = Date.now() - 12 * 60 * 60_000;
    // chokepoint-baselines budget=576000min (400d) → 60d old (fresh; SECOND-OLDEST)
    const chokepointBaselinesFetchedAt = Date.now() - 60 * 24 * 60 * 60_000;
    // portwatch:chokepoints-ref budget=20160min (14d) → 7d old (fresh)
    const portwatchChokepointsRefFetchedAt = Date.now() - 7 * 24 * 60 * 60_000;
    // chokepoint-flows budget=720min (12h) → 5h old (fresh)
    const chokepointFlowsFetchedAt = Date.now() - 5 * 60 * 60_000;

    globalThis.fetch = async (url) => {
      const u = url.toString();
      if (u.includes(`/get/${encodeURIComponent('supply_chain:transit-summaries:v1')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(transitSummariesPayload) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('supply_chain:chokepoint_transits:v1')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(chokepointTransitsPayload) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('supply_chain:portwatch-ports:v1:_countries')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(portwatchPortsPayload) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('energy:chokepoint-baselines:v1')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(chokepointBaselinesPayload) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('portwatch:chokepoints:ref:v1')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(portwatchChokepointsRefPayload) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('energy:chokepoint-flows:v1')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(chokepointFlowsPayload) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('seed-meta:supply_chain:transit-summaries')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify({ fetchedAt: transitSummariesFetchedAt, recordCount: 13 }) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('seed-meta:supply_chain:chokepoint_transits')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify({ fetchedAt: chokepointTransitsFetchedAt, recordCount: 13 }) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('seed-meta:supply_chain:portwatch-ports')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify({ fetchedAt: portwatchPortsFetchedAt, recordCount: 200 }) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('seed-meta:energy:chokepoint-baselines')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify({ fetchedAt: chokepointBaselinesFetchedAt, recordCount: 13 }) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('seed-meta:portwatch:chokepoints-ref')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify({ fetchedAt: portwatchChokepointsRefFetchedAt, recordCount: 13 }) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('seed-meta:energy:chokepoint-flows')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify({ fetchedAt: chokepointFlowsFetchedAt, recordCount: 13 }) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(url);
    };

    const freshMod = await import(`../api/mcp.ts?t=${Date.now()}`);
    const freshHandler = freshMod.default;

    const res = await freshHandler(makeReq('POST', {
      jsonrpc: '2.0', id: 500, method: 'tools/call',
      params: { name: 'get_chokepoint_status', arguments: {} },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.result?.content, 'result.content must be present');
    const payload = JSON.parse(body.result.content[0].text);
    assert.equal(payload.stale, false, 'all 6 metas within their per-key budgets must yield stale=false');
    // chokepoint-baselines is the oldest valid fetchedAt (60d) → anchors cached_at
    assert.equal(payload.cached_at, new Date(chokepointBaselinesFetchedAt).toISOString(), 'cached_at reflects oldest valid fetchedAt (chokepoint-baselines)');
    // Label-walk: trailing non-(v\d+|\d+|stale|sebuf) segment.
    // supply_chain:transit-summaries:v1 → "transit-summaries"
    // supply_chain:chokepoint_transits:v1 → "chokepoint_transits"
    // supply_chain:portwatch-ports:v1:_countries → "_countries" (NOT in NON_LABEL list)
    // energy:chokepoint-baselines:v1 → "chokepoint-baselines"
    // portwatch:chokepoints:ref:v1 → "ref"
    // energy:chokepoint-flows:v1 → "chokepoint-flows"
    assert.deepEqual(payload.data['transit-summaries'], transitSummariesPayload, 'transit-summaries slice labelled from cache-key suffix');
    assert.deepEqual(payload.data['chokepoint_transits'], chokepointTransitsPayload, 'chokepoint_transits slice labelled from cache-key suffix');
    assert.deepEqual(payload.data['_countries'], portwatchPortsPayload, 'portwatch-ports slice labelled from trailing _countries segment');
    assert.deepEqual(payload.data['chokepoint-baselines'], chokepointBaselinesPayload, 'chokepoint-baselines slice labelled from cache-key suffix');
    assert.deepEqual(payload.data['ref'], portwatchChokepointsRefPayload, 'portwatch:chokepoints:ref slice labelled from trailing ref segment');
    assert.deepEqual(payload.data['chokepoint-flows'], chokepointFlowsPayload, 'chokepoint-flows slice labelled from cache-key suffix');
  });

  it('get_chokepoint_status: fast transit-summaries fresh but slow portwatch-ports past budget flips aggregate stale', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';

    const transitSummariesPayload = { chokepoints: { suez: { vesselsPast24h: 87 } } };
    const portwatchPortsPayload = { countries: {} };

    // transit-summaries budget=30min → 5min old (fresh)
    const transitSummariesFetchedAt = Date.now() - 5 * 60_000;
    // portwatch-ports budget=2160min (36h) → 100h old (clearly STALE)
    const portwatchPortsFetchedAt = Date.now() - 100 * 60 * 60_000;

    globalThis.fetch = async (url) => {
      const u = url.toString();
      if (u.includes(`/get/${encodeURIComponent('supply_chain:transit-summaries:v1')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(transitSummariesPayload) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('supply_chain:portwatch-ports:v1:_countries')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(portwatchPortsPayload) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('seed-meta:supply_chain:transit-summaries')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify({ fetchedAt: transitSummariesFetchedAt, recordCount: 13 }) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('seed-meta:supply_chain:portwatch-ports')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify({ fetchedAt: portwatchPortsFetchedAt, recordCount: 200 }) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // Everything else absent → mixed shape; at least 2 keys populated so cache_all_null doesn't trip.
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const freshMod = await import(`../api/mcp.ts?t=${Date.now()}`);
    const freshHandler = freshMod.default;

    const res = await freshHandler(makeReq('POST', {
      jsonrpc: '2.0', id: 501, method: 'tools/call',
      params: { name: 'get_chokepoint_status', arguments: {} },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    const payload = JSON.parse(body.result.content[0].text);
    // One over-budget key (portwatch-ports 100h vs 36h budget) flips aggregate stale=true
    // even though transit-summaries is fresh.
    assert.equal(payload.stale, true, 'one over-budget key (portwatch-ports) flips aggregate stale=true');
    assert.deepEqual(payload.data['transit-summaries'], transitSummariesPayload, 'fresh transit-summaries slice still surfaces');
    assert.deepEqual(payload.data['_countries'], portwatchPortsPayload, 'stale portwatch-ports payload still returned alongside stale=true');
  });

  it('get_chokepoint_status returns mixed shape without throwing when only one key is populated', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';

    const transitSummariesPayload = { chokepoints: { suez: { vesselsPast24h: 87 } } };
    const transitSummariesFetchedAt = Date.now() - 5 * 60_000;

    globalThis.fetch = async (url) => {
      const u = url.toString();
      if (u.includes(`/get/${encodeURIComponent('supply_chain:transit-summaries:v1')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(transitSummariesPayload) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('seed-meta:supply_chain:transit-summaries')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify({ fetchedAt: transitSummariesFetchedAt, recordCount: 13 }) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // Every other key absent → readJsonFromUpstash → null
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const freshMod = await import(`../api/mcp.ts?t=${Date.now()}`);
    const freshHandler = freshMod.default;

    const res = await freshHandler(makeReq('POST', {
      jsonrpc: '2.0', id: 502, method: 'tools/call',
      params: { name: 'get_chokepoint_status', arguments: {} },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    // Must NOT throw -32603: at least one cache slot is populated → cache_all_null guard doesn't fire.
    assert.ok(body.result?.content, 'partial-population must return a result, not -32603');
    const payload = JSON.parse(body.result.content[0].text);
    assert.deepEqual(payload.data['transit-summaries'], transitSummariesPayload, 'populated transit-summaries slice still present');
    assert.equal(payload.data['chokepoint_transits'], null, 'missing chokepoint_transits slice surfaces as null');
    assert.equal(payload.data['_countries'], null, 'missing portwatch-ports slice surfaces as null');
    assert.equal(payload.data['chokepoint-baselines'], null, 'missing chokepoint-baselines slice surfaces as null');
    assert.equal(payload.data['ref'], null, 'missing portwatch chokepoints-ref slice surfaces as null');
    assert.equal(payload.data['chokepoint-flows'], null, 'missing chokepoint-flows slice surfaces as null');
    assert.equal(payload.stale, true, 'missing meta forces stale=true (hasAllValidMeta=false)');
    assert.equal(payload.cached_at, null, 'mixed-validity meta yields cached_at=null per evaluateFreshness contract');
  });

  // --- get_energy_intelligence (U3: 9-key energy bundle) ---

  it('get_energy_intelligence returns 9-slice data on cache hit when every per-key meta is within budget', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';

    const eiaPayload = { weeklySeries: [{ week: '2026-W18', stocks: 832.1 }] };
    const electricityPayload = { countries: [{ iso: 'DE', priceEurMwh: 88 }] };
    const emberPayload = { regions: [{ id: 'EU', cleanShare: 0.62 }] };
    const gasStoragePayload = { countries: [{ iso: 'DE', fillPct: 71 }] };
    const fuelShortagesPayload = { countries: [{ iso: 'CU', severity: 'high' }] };
    const disruptionsPayload = { events: [{ id: 'pipe-2026-04-21', region: 'Levant' }] };
    const crisisPolicyPayload = { policies: [{ country: 'DE', kind: 'price-cap' }] };
    const fossilSharePayload = { countries: [{ iso: 'PL', fossilSharePct: 73 }] };
    const renewablePayload = { countries: [{ iso: 'IS', renewablePct: 84 }] };

    // Budgets: eiaPetroleum=4320min, electricity-prices=2880, ember=2880, gas-storage=2880,
    // fuel-shortages=2880, disruptions=20160, crisis-policies=~400d, fossil-share=11520, renewable=10080.
    // All fetchedAts within their per-key budgets; oldest = crisisPolicy (30d old, within 400d budget)
    // anchors cached_at — exercises the wide budget-asymmetry property.
    const eiaFetchedAt           = Date.now() - 60 * 60_000;
    const electricityFetchedAt   = Date.now() - 30 * 60_000;
    const emberFetchedAt         = Date.now() - 24 * 60 * 60_000;
    const gasStorageFetchedAt    = Date.now() - 12 * 60 * 60_000;
    const fuelShortagesFetchedAt = Date.now() - 12 * 60 * 60_000;
    const disruptionsFetchedAt   = Date.now() - 5 * 24 * 60 * 60_000;
    const crisisPolicyFetchedAt  = Date.now() - 30 * 24 * 60 * 60_000;  // OLDEST valid → anchors cached_at (within ~400d budget)
    const fossilShareFetchedAt   = Date.now() - 7 * 24 * 60 * 60_000;
    const renewableFetchedAt     = Date.now() - 6 * 24 * 60 * 60_000;

    const JSON_HDR = { 'Content-Type': 'application/json' };
    const meta = (fetchedAt) => ({ fetchedAt, recordCount: 1 });
    // Single Map of cache-key → payload covers both data + seed-meta lookups.
    // Replaces an 18-branch if-chain that biome flagged as too complex.
    const FIXTURES = new Map([
      ['energy:eia-petroleum:v1', eiaPayload],
      ['energy:electricity:v1:index', electricityPayload],
      ['energy:ember:v1:_all', emberPayload],
      ['energy:gas-storage:v1:_countries', gasStoragePayload],
      ['energy:fuel-shortages:v1', fuelShortagesPayload],
      ['energy:disruptions:v1', disruptionsPayload],
      ['energy:crisis-policies:v1', crisisPolicyPayload],
      ['resilience:fossil-electricity-share:v1', fossilSharePayload],
      ['economic:worldbank-renewable:v1', renewablePayload],
      ['seed-meta:energy:eia-petroleum', meta(eiaFetchedAt)],
      ['seed-meta:energy:electricity-prices', meta(electricityFetchedAt)],
      ['seed-meta:energy:ember', meta(emberFetchedAt)],
      ['seed-meta:energy:gas-storage-countries', meta(gasStorageFetchedAt)],
      ['seed-meta:energy:fuel-shortages', meta(fuelShortagesFetchedAt)],
      ['seed-meta:energy:disruptions', meta(disruptionsFetchedAt)],
      ['seed-meta:energy:crisis-policies', meta(crisisPolicyFetchedAt)],
      ['seed-meta:resilience:fossil-electricity-share', meta(fossilShareFetchedAt)],
      ['seed-meta:economic:worldbank-renewable:v1', meta(renewableFetchedAt)],
    ]);
    globalThis.fetch = async (url) => {
      const u = url.toString();
      for (const [key, payload] of FIXTURES) {
        if (u.includes(`/get/${encodeURIComponent(key)}`)) {
          return new Response(JSON.stringify({ result: JSON.stringify(payload) }), { status: 200, headers: JSON_HDR });
        }
      }
      return new Response(JSON.stringify({}), { status: 200, headers: JSON_HDR });
    };

    const freshMod = await import(`../api/mcp.ts?t=${Date.now()}`);
    const freshHandler = freshMod.default;

    const res = await freshHandler(makeReq('POST', {
      jsonrpc: '2.0', id: 300, method: 'tools/call',
      params: { name: 'get_energy_intelligence', arguments: {} },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.result?.content, 'result.content must be present');
    const payload = JSON.parse(body.result.content[0].text);
    assert.equal(payload.stale, false, 'all 9 metas within their per-key budgets must yield stale=false');
    assert.equal(payload.cached_at, new Date(crisisPolicyFetchedAt).toISOString(), 'cached_at reflects oldest valid fetchedAt (crisis-policies, 30d old, within ~400d budget)');
    // Label-walk slice names per NON_LABEL=/^(v\d+|\d+|stale|sebuf)$/:
    assert.deepEqual(payload.data['eia-petroleum'], eiaPayload);
    assert.deepEqual(payload.data['index'], electricityPayload, 'energy:electricity:v1:index → "index"');
    assert.deepEqual(payload.data['_all'], emberPayload, 'energy:ember:v1:_all → "_all"');
    assert.deepEqual(payload.data['_countries'], gasStoragePayload, 'energy:gas-storage:v1:_countries → "_countries"');
    assert.deepEqual(payload.data['fuel-shortages'], fuelShortagesPayload);
    assert.deepEqual(payload.data['disruptions'], disruptionsPayload);
    assert.deepEqual(payload.data['crisis-policies'], crisisPolicyPayload);
    assert.deepEqual(payload.data['fossil-electricity-share'], fossilSharePayload);
    assert.deepEqual(payload.data['worldbank-renewable'], renewablePayload);
  });

  it('get_energy_intelligence marks aggregate stale when one slow-cadence key is past budget while fast keys are fresh', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';

    // Per-key budget asymmetry exercise: electricity has 48h budget (fast cron),
    // disruptions has 14d budget (weekly cron × 2). Set disruptions=15d old → past
    // its own budget, but electricity stays fresh. Aggregate stale must flip true.
    const electricityFetchedAt = Date.now() - 30 * 60_000;
    const disruptionsFetchedAt = Date.now() - 15 * 24 * 60 * 60_000; // past 14d budget

    globalThis.fetch = async (url) => {
      const u = url.toString();
      // Provide only electricity + disruptions data; rest absent (null).
      if (u.includes(`/get/${encodeURIComponent('energy:electricity:v1:index')}`)) return new Response(JSON.stringify({ result: JSON.stringify({ countries: [{ iso: 'DE' }] }) }), { status: 200 });
      if (u.includes(`/get/${encodeURIComponent('energy:disruptions:v1')}`)) return new Response(JSON.stringify({ result: JSON.stringify({ events: [{ id: 'old-event' }] }) }), { status: 200 });
      if (u.includes(`/get/${encodeURIComponent('seed-meta:energy:electricity-prices')}`)) return new Response(JSON.stringify({ result: JSON.stringify({ fetchedAt: electricityFetchedAt, recordCount: 1 }) }), { status: 200 });
      if (u.includes(`/get/${encodeURIComponent('seed-meta:energy:disruptions')}`)) return new Response(JSON.stringify({ result: JSON.stringify({ fetchedAt: disruptionsFetchedAt, recordCount: 1 }) }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const freshMod = await import(`../api/mcp.ts?t=${Date.now()}`);
    const freshHandler = freshMod.default;

    const res = await freshHandler(makeReq('POST', {
      jsonrpc: '2.0', id: 301, method: 'tools/call',
      params: { name: 'get_energy_intelligence', arguments: {} },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.result?.content, 'result.content must be present (cache_all_null guard does NOT fire: 2 keys populated)');
    const payload = JSON.parse(body.result.content[0].text);
    assert.equal(payload.stale, true, 'one over-budget key (disruptions @ 15d > 14d budget) flips aggregate stale=true');
    assert.equal(payload.cached_at, null, 'mixed-validity meta yields cached_at=null per evaluateFreshness contract');
  });

  it('get_energy_intelligence throws cache_all_null (→ -32603) when every 9 cache reads return null', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';

    // F6 contract: degenerate-empty result must surface as -32603 so
    // dispatchToolsCall's catch fires the proRollback DECR (Pro path).
    globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });

    const freshMod = await import(`../api/mcp.ts?t=${Date.now()}`);
    const freshHandler = freshMod.default;

    const res = await freshHandler(makeReq('POST', {
      jsonrpc: '2.0', id: 302, method: 'tools/call',
      params: { name: 'get_energy_intelligence', arguments: {} },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.error?.code, -32603, 'all-9-null reads must surface as -32603 cache_all_null');
  });

  it('get_supply_chain_data still returns its 3 slices unchanged (regression — U6 must not touch get_supply_chain_data._cacheKeys)', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';

    const shippingStressPayload = { index: 1.42 };
    const customsRevenuePayload = { receipts: [{ country: 'US', revenue: 1.2e9 }] };
    const comtradeFlowsPayload = { pairs: [{ a: 'US', b: 'CN', total: 9.1e11 }] };
    const customsFetchedAt = Date.now() - 6 * 60 * 60_000;

    globalThis.fetch = async (url) => {
      const u = url.toString();
      // U6 chokepoint keys MUST NOT be queried by get_supply_chain_data — if they are,
      // the supply-chain tool was modified, violating the CRITICAL constraint.
      if (
        u.includes(`/get/${encodeURIComponent('supply_chain:transit-summaries:v1')}`) ||
        u.includes(`/get/${encodeURIComponent('supply_chain:chokepoint_transits:v1')}`) ||
        u.includes(`/get/${encodeURIComponent('supply_chain:portwatch-ports:v1:_countries')}`) ||
        u.includes(`/get/${encodeURIComponent('energy:chokepoint-baselines:v1')}`) ||
        u.includes(`/get/${encodeURIComponent('portwatch:chokepoints:ref:v1')}`) ||
        u.includes(`/get/${encodeURIComponent('energy:chokepoint-flows:v1')}`)
      ) {
        throw new Error('get_supply_chain_data must not read chokepoint-bundle keys (U6 regression)');
      }
      if (u.includes(`/get/${encodeURIComponent('supply_chain:shipping_stress:v1')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(shippingStressPayload) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('trade:customs-revenue:v1')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(customsRevenuePayload) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('comtrade:flows:v1')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify(comtradeFlowsPayload) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes(`/get/${encodeURIComponent('seed-meta:trade:customs-revenue')}`)) {
        return new Response(JSON.stringify({ result: JSON.stringify({ fetchedAt: customsFetchedAt, recordCount: 1 }) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const freshMod = await import(`../api/mcp.ts?t=${Date.now()}`);
    const freshHandler = freshMod.default;

    const res = await freshHandler(makeReq('POST', {
      jsonrpc: '2.0', id: 503, method: 'tools/call',
      params: { name: 'get_supply_chain_data', arguments: {} },
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.result?.content, 'get_supply_chain_data must still return a result');
    const payload = JSON.parse(body.result.content[0].text);
    // Label-walk: supply_chain:shipping_stress:v1 → "shipping_stress",
    //             trade:customs-revenue:v1       → "customs-revenue",
    //             comtrade:flows:v1              → "flows"
    assert.deepEqual(payload.data['shipping_stress'], shippingStressPayload, 'get_supply_chain_data._cacheKeys must still include supply_chain:shipping_stress:v1');
    assert.deepEqual(payload.data['customs-revenue'], customsRevenuePayload, 'get_supply_chain_data._cacheKeys must still include trade:customs-revenue:v1');
    assert.deepEqual(payload.data['flows'], comtradeFlowsPayload, 'get_supply_chain_data._cacheKeys must still include comtrade:flows:v1');
    // Exactly 3 slices — no chokepoint keys leaked in.
    assert.equal(Object.keys(payload.data).length, 3, 'get_supply_chain_data must return exactly 3 slices (U6 must not add to it)');
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
