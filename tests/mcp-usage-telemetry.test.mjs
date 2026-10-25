// #4866 — /mcp emits wm_api_usage RequestEvents so MCP auth rejections,
// quota hits, and successes are visible in Axiom (they were fully invisible
// during the #4859 diagnosis: no gateway pass-through, no log drain).
import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  ANON_DISCOVERY_URL,
  BASE_URL,
  HMAC_SECRET,
  PRO_BEARER,
  makeProDeps,
  proReq,
  callBody,
} from './helpers/mcp-pro-deps.mjs';

function resourceReadBody(uri = 'worldmonitor://countries/de/risk', id = 100) {
  return { jsonrpc: '2.0', id, method: 'resources/read', params: { uri } };
}

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

const USER_KEY = `wm_${'cd34'.repeat(10)}`;
const USER_KEY_USER_ID = 'user_apiplan_xyz';

function makeCtx() {
  const pending = [];
  return {
    ctx: { waitUntil: (p) => pending.push(p) },
    settle: () => Promise.allSettled(pending),
  };
}

function captureAxiom() {
  const events = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes('axiom.co')) {
      for (const ev of JSON.parse(init.body)) events.push(ev);
      return new Response('{}', { status: 200 });
    }
    return new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return events;
}

describe('api/mcp — usage telemetry (#4866)', () => {
  let mcpHandler;

  beforeEach(async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'wm_env_key_1';
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
    process.env.USAGE_TELEMETRY = '1';
    process.env.AXIOM_API_TOKEN = 'stub-token';
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

  for (const [status, retryAfter, reason] of [[429, '60', 'rate_limit_429'], [503, '5', 'rate_limit_degraded']]) {
    it(`Google Dates downstream ${status} preserves backoff and usage through MCP dispatch`, async () => {
      const { deps } = makeProDeps();
      const events = captureAxiom();
      const transport = globalThis.fetch;
      globalThis.fetch = async (url, init) => String(url).includes('/api/aviation/v1/search-google-dates')
        ? new Response(JSON.stringify({ error: 'private upstream detail' }), { status, headers: { 'Retry-After': retryAfter } })
        : transport(url, init);
      const { ctx, settle } = makeCtx();
      const res = await mcpHandler(proReq('POST', callBody('search_flight_prices_by_date', {
        origin: 'DXB', destination: 'LHR', start_date: '2026-10-01', end_date: '2026-10-31',
      })), deps, ctx);
      assert.equal(res.status, status);
      assert.equal(res.headers.get('Retry-After'), retryAfter);
      assert.equal(res.headers.get('Cache-Control'), 'no-store');
      const payload = await res.json();
      assert.equal(payload.error.code, status === 429 ? -32029 : -32603);
      assert.ok(!JSON.stringify(payload).includes('private upstream detail'));
      await settle();
      assert.equal(events.length, 1);
      assert.equal(events[0].status, status);
      assert.equal(events[0].reason, reason);
    });
  }

  it('anonymous tools/list emits an ok request event with origin_kind mcp', async () => {
    const { deps } = makeProDeps();
    const events = captureAxiom();
    const { ctx, settle } = makeCtx();
    const res = await mcpHandler(
      new Request(BASE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) }),
      deps,
      ctx,
    );
    assert.equal(res.status, 200);
    await settle();
    assert.equal(events.length, 1, 'exactly one request event per POST');
    const ev = events[0];
    assert.equal(ev.event_type, 'request');
    assert.equal(ev.route, '/mcp');
    assert.equal(ev.domain, 'mcp');
    assert.equal(ev.origin_kind, 'mcp');
    assert.equal(ev.method, 'POST');
    assert.equal(ev.status, 200);
    assert.equal(ev.auth_kind, 'anon');
    assert.equal(ev.reason, 'ok');
    assert.equal(ev.rpc_method, 'tools/list');
    assert.equal(ev.tool_name, null);
    // jsonResponse now advertises Content-Length, so a non-streamed JSON-RPC
    // success must land a real byte count — never the pre-#8403 fake zero.
    assert.equal(typeof ev.res_bytes, 'number');
    assert.ok(ev.res_bytes > 0);
  });

  // 2026-10-23: 17% of /mcp POSTs were refused for MCP-Protocol-Version, and
  // whether they carried 2025-11-25 (a handshake revision we could add) or
  // 2026-07-28 (dual-era probes that fall back by design) was unknowable
  // because the header value was never recorded.
  it('records the requested MCP-Protocol-Version, bounded to known revisions', async () => {
    const { deps } = makeProDeps();
    const events = captureAxiom();
    const { ctx, settle } = makeCtx();
    const post = (version, body) => mcpHandler(new Request(BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(version === null ? {} : { 'MCP-Protocol-Version': version }) },
      body: JSON.stringify(body),
    }), deps, ctx);
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
    const init = { jsonrpc: '2.0', id: 2, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } };
    const cases = [
      ['2025-06-18', list, 200, '2025-06-18'],
      ['2026-07-28', list, 400, '2026-07-28'],
      ['2025-11-25', init, 401, '2025-11-25'],
      ['2099-01-01', list, 400, 'other'],
      ['not-a-version', list, 400, 'other'],
      [null, list, 200, null],
    ];
    for (const [version, body, status] of cases) {
      const res = await post(version, body);
      assert.equal(res.status, status, String(version));
      await res.text();
    }
    await settle();
    assert.deepEqual(events.map((e) => e.mcp_protocol_version), cases.map((c) => c[3]));
    assert.equal(events[1].reason, 'unsupported_protocol_version');
  });

  // MCP 2026-07-28 rollout (R14): rows split by era, the new methods are named,
  // and each modern rejection has its own reason. Header values never land.
  it('records the era, the modern methods and a distinct reason per modern rejection', async () => {
    const MODERN = '2026-07-28';
    const meta = (overrides = {}) => ({
      'io.modelcontextprotocol/protocolVersion': MODERN,
      'io.modelcontextprotocol/clientCapabilities': {},
      ...overrides,
    });
    const body = (id, method, params = {}, metaOverrides = {}) => ({
      jsonrpc: '2.0', id, method, params: { ...params, _meta: meta(metaOverrides) },
    });
    const modernHeaders = (method, extra = {}) => ({
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${PRO_BEARER}`, 'MCP-Protocol-Version': MODERN, 'Mcp-Method': method, ...extra,
    });
    const run = async (flag, cases) => {
      if (flag === null) delete process.env.MCP_PROTOCOL_2026_07_28;
      else process.env.MCP_PROTOCOL_2026_07_28 = flag;
      const mod = await import(`../api/mcp.ts?t=${Date.now()}-${Math.random()}`);
      const { deps } = makeProDeps();
      const events = captureAxiom();
      const { ctx, settle } = makeCtx();
      for (const [payload, headers] of cases) {
        const res = await mod.mcpHandler(new Request(BASE_URL, { method: 'POST', headers, body: JSON.stringify(payload) }), deps, ctx);
        await res.text();
      }
      await settle();
      return events;
    };

    const on = await run('on', [
      [body(1, 'tools/list'), modernHeaders('tools/list')],
      [body(2, 'server/discover'), modernHeaders('server/discover')],
      [body(3, 'tools/list'), modernHeaders('tools/call')],
      [body(4, 'tools/list', {}, { 'io.modelcontextprotocol/clientCapabilities': null }), modernHeaders('tools/list')],
      [body(5, 'tools/list', {}, { 'io.modelcontextprotocol/protocolVersion': '2027-01-01' }), modernHeaders('tools/list', { 'MCP-Protocol-Version': '2027-01-01' })],
      [body(6, 'tools/call', { name: 'get_sources', arguments: {} }), modernHeaders('tools/call', { 'Mcp-Name': 'secret-header-value' })],
      [{ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }, { 'Content-Type': 'application/json', Authorization: `Bearer ${PRO_BEARER}` }],
      [body(9, 'ping'), modernHeaders('ping')],
      [body(10, 'subscriptions/listen', { notifications: {} }), modernHeaders('subscriptions/listen', { Accept: 'application/json' })],
    ]);
    assert.deepEqual(on.map((e) => e.mcp_era), ['modern', 'modern', 'modern', 'modern', 'modern', 'modern', 'legacy', 'modern', 'modern']);
    assert.equal(on[0].reason, 'ok');
    assert.equal(on[1].rpc_method, 'server/discover');
    assert.equal(on[2].reason, 'header_mismatch');
    assert.equal(on[3].reason, 'invalid_request_meta');
    assert.equal(on[4].reason, 'unsupported_protocol_version');
    assert.equal(on[5].reason, 'header_mismatch');
    assert.doesNotMatch(JSON.stringify(on), /secret-header-value/);
    // A removed method is a 404, and a listen without SSE in Accept a 406:
    // neither may land as a served 'ok' row.
    assert.deepEqual([on[7].status, on[7].reason], [404, 'unknown_route']);
    assert.deepEqual([on[8].status, on[8].reason], [406, 'malformed_request']);

    // Flag off: an enveloped request is served as legacy.
    const off = await run(null, [[body(8, 'tools/list'), { 'Content-Type': 'application/json', Authorization: `Bearer ${PRO_BEARER}` }]]);
    assert.equal(off[0].mcp_era, 'legacy');
    delete process.env.MCP_PROTOCOL_2026_07_28;
  });

  it('invalid wm_ key on tools/call emits status 401 reason auth_401 (the #4859 symptom, now visible)', async () => {
    const { deps } = makeProDeps();
    const events = captureAxiom();
    const { ctx, settle } = makeCtx();
    const res = await mcpHandler(
      new Request(BASE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': 'wm_bogus_key' }, body: JSON.stringify(callBody('describe_tool', { tool_name: 'get_market_data' })) }),
      deps,
      ctx,
    );
    assert.equal(res.status, 401);
    await settle();
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 401);
    assert.equal(events[0].reason, 'auth_401');
    assert.equal(events[0].auth_kind, 'anon');
  });

  it('pro bearer with a RETRYABLE billing state emits tier_403 attributed to the userId', async () => {
    // Fixture is deliberately a retryable marker rather than a confirmed lapse:
    // since #6716 a CONFIRMED lapse means billing attempts are over and the
    // account falls to the free tier (covered below), while an unverifiable
    // read still denies. Keeping this case on the retryable marker preserves
    // what the test is actually for — attribution on a tier denial.
    const { deps } = makeProDeps({
      getEntitlements: async () => ({
        planKey: 'free',
        features: { tier: 0, mcpAccess: false },
        validUntil: 0,
        billingStatus: 'renewal_verification_failed',
      }),
    });
    const events = captureAxiom();
    const { ctx, settle } = makeCtx();
    const res = await mcpHandler(proReq('POST', callBody('describe_tool', { tool_name: 'get_market_data' })), deps, ctx);
    assert.notEqual(res.status, 200);
    await settle();
    assert.equal(events.length, 1);
    const ev = events[0];
    assert.equal(ev.auth_kind, 'mcp_oauth');
    assert.equal(ev.customer_id, 'user_pro_xyz');
  });

  it('pro bearer with a CONFIRMED lapse is served on the free tier, still attributed (#6716)', async () => {
    // A churned account is a free account: the request succeeds, and the
    // telemetry must still name the user so the funnel can count them.
    const { deps } = makeProDeps({
      getEntitlements: async () => ({
        planKey: 'free',
        features: { tier: 0, mcpAccess: false },
        validUntil: 0,
        billingStatus: 'subscription_lapsed',
      }),
    });
    const events = captureAxiom();
    const { ctx, settle } = makeCtx();
    const res = await mcpHandler(proReq('POST', callBody('describe_tool', { tool_name: 'get_market_data' })), deps, ctx);
    assert.equal(res.status, 200);
    await settle();
    assert.equal(events.length, 1);
    const ev = events[0];
    assert.equal(ev.auth_kind, 'mcp_oauth');
    assert.equal(ev.customer_id, 'user_pro_xyz');
  });

  it('user_key describe_tool success attributes the key owner', async () => {
    const { deps } = makeProDeps({
      validateUserApiKey: async (k) => (k === USER_KEY ? { userId: USER_KEY_USER_ID } : null),
      getEntitlements: async () => ({ planKey: 'api_starter', features: { tier: 2, mcpAccess: true }, validUntil: Date.now() + 86_400_000 }),
    });
    const events = captureAxiom();
    const { ctx, settle } = makeCtx();
    const res = await mcpHandler(
      new Request(BASE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': USER_KEY }, body: JSON.stringify(callBody('describe_tool', { tool_name: 'get_market_data' })) }),
      deps,
      ctx,
    );
    assert.equal(res.status, 200);
    await settle();
    assert.equal(events.length, 1);
    const ev = events[0];
    assert.equal(ev.reason, 'ok');
    assert.equal(ev.auth_kind, 'user_api_key');
    assert.equal(ev.customer_id, USER_KEY_USER_ID);
  });

  it('pro bearer quota cap emits rate_limit_429', async () => {
    const { deps } = makeProDeps({ pipelineOpts: { initialCount: 50 } });
    const events = captureAxiom();
    const { ctx, settle } = makeCtx();
    const res = await mcpHandler(proReq('POST', callBody('get_market_data')), deps, ctx);
    assert.equal(res.status, 429);
    await settle();
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, 'rate_limit_429');
    assert.equal(events[0].status, 429);
  });

  it('OPTIONS preflight emits nothing', async () => {
    const { deps } = makeProDeps();
    const events = captureAxiom();
    const { ctx, settle } = makeCtx();
    await mcpHandler(new Request(BASE_URL, { method: 'OPTIONS' }), deps, ctx);
    await settle();
    assert.equal(events.length, 0);
  });

  it('USAGE_TELEMETRY off emits nothing', async () => {
    process.env.USAGE_TELEMETRY = '0';
    const { deps } = makeProDeps();
    const events = captureAxiom();
    const { ctx, settle } = makeCtx();
    await mcpHandler(proReq('POST', callBody('describe_tool', { tool_name: 'get_market_data' })), deps, ctx);
    await settle();
    assert.equal(events.length, 0);
  });

  it('resources/read mid-call billing 503 classifies as billing_verification_503, not rate_limit_degraded', async () => {
    // #7269: resources/read used to drop X-Billing-Verification, so the handler
    // classified 503 as dispatch → rate_limit_degraded. The marker must reach
    // the outer classifier so Axiom records billing_verification_503.
    const { deps } = makeProDeps();
    const events = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('axiom.co')) {
        for (const ev of JSON.parse(init.body)) events.push(ev);
        return new Response('{}', { status: 200 });
      }
      return new Response(
        JSON.stringify({ error: 'Unable to verify API access', code: 'entitlement_verification_unavailable' }),
        {
          status: 503,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'Retry-After': '5',
            'X-Billing-Verification': 'entitlement_verification_unavailable',
          },
        },
      );
    };
    const { ctx, settle } = makeCtx();
    const res = await mcpHandler(proReq('POST', resourceReadBody()), deps, ctx);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('X-Billing-Verification'), 'entitlement_verification_unavailable');
    await settle();
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 503);
    assert.equal(events[0].reason, 'billing_verification_503');
    assert.ok(events[0].tool_error_kind, 'a template read records the outcome of the tool it ran');
    assert.equal(events[0].tool_result_bytes, 0);
  });

  it('resources/read mid-call confirmed-lapse 403 classifies as billing/tier_403', async () => {
    // #7269: without the billing marker, a 403 is recorded as an ordinary
    // precheck tier_403. The phase is still 'billing' so incidents stay
    // distinguishable from status-only precheck denials.
    const { deps } = makeProDeps();
    const events = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('axiom.co')) {
        for (const ev of JSON.parse(init.body)) events.push(ev);
        return new Response('{}', { status: 200 });
      }
      return new Response(
        JSON.stringify({ error: 'Subscription lapsed', code: 'subscription_lapsed' }),
        {
          status: 403,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Billing-Verification': 'subscription_lapsed',
          },
        },
      );
    };
    const { ctx, settle } = makeCtx();
    const res = await mcpHandler(proReq('POST', resourceReadBody()), deps, ctx);
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('X-Billing-Verification'), 'subscription_lapsed');
    await settle();
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 403);
    assert.equal(events[0].reason, 'tier_403');
  });

  it('emission failure never breaks the response (Axiom down)', async () => {
    const { deps } = makeProDeps();
    globalThis.fetch = async (url) => {
      if (String(url).includes('axiom.co')) throw new Error('axiom exploded');
      return new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const { ctx, settle } = makeCtx();
    const res = await mcpHandler(proReq('POST', callBody('describe_tool', { tool_name: 'get_market_data' })), deps, ctx);
    assert.equal(res.status, 200);
    await settle();
  });

  // #8403 — JSON-RPC method + tool name must be queryable, and missing
  // Content-Length must not be recorded as a genuine zero-byte response.
  it('tools/call records rpc_method and a registry-bounded tool_name (#8403)', async () => {
    const { deps } = makeProDeps();
    const events = captureAxiom();
    const { ctx, settle } = makeCtx();
    const res = await mcpHandler(proReq('POST', callBody('describe_tool', { tool_name: 'get_market_data' })), deps, ctx);
    assert.equal(res.status, 200);
    await settle();
    assert.equal(events.length, 1);
    assert.equal(events[0].rpc_method, 'tools/call');
    assert.equal(events[0].tool_name, 'describe_tool');
    assert.equal(events[0].method, 'POST', 'HTTP method stays on method');
  });

  it('initialize / tools/list / tools/call are distinguishable by rpc_method (#8403)', async () => {
    const { deps } = makeProDeps();
    const events = captureAxiom();
    const { ctx, settle } = makeCtx();

    const listRes = await mcpHandler(
      new Request(BASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
      deps,
      ctx,
    );
    assert.equal(listRes.status, 200);

    const initRes = await mcpHandler(
      new Request(ANON_DISCOVERY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } },
        }),
      }),
      deps,
      ctx,
    );
    assert.equal(initRes.status, 200);

    const callRes = await mcpHandler(proReq('POST', callBody('describe_tool', { tool_name: 'get_market_data' })), deps, ctx);
    assert.equal(callRes.status, 200);

    await settle();
    const methods = events.map((e) => e.rpc_method).sort();
    assert.deepEqual(methods, ['initialize', 'tools/call', 'tools/list']);
    assert.equal(events.find((e) => e.rpc_method === 'tools/list')?.tool_name, null);
    assert.equal(events.find((e) => e.rpc_method === 'initialize')?.tool_name, null);
  });

  it('unregistered tools/call name is not echoed into tool_name (#8403 cardinality)', async () => {
    const { deps } = makeProDeps();
    const events = captureAxiom();
    const { ctx, settle } = makeCtx();
    const res = await mcpHandler(
      proReq('POST', callBody('totally_fake_tool_xyz', {})),
      deps,
      ctx,
    );
    // Dispatch may 200 with a JSON-RPC tool-not-found, or refuse — either way
    // the usage row must not invent cardinality from client input.
    assert.ok(res.status === 200 || res.status >= 400);
    await settle();
    assert.equal(events.length, 1);
    assert.equal(events[0].rpc_method, 'tools/call');
    assert.equal(events[0].tool_name, null);
  });

  it('unknown JSON-RPC method collapses to _unregistered (#8403 cardinality)', async () => {
    const { deps } = makeProDeps();
    const events = captureAxiom();
    const { ctx, settle } = makeCtx();
    const res = await mcpHandler(
      new Request(BASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 99,
          method: `invented.method.${'x'.repeat(200)}`,
          params: {},
        }),
      }),
      deps,
      ctx,
    );
    assert.ok(res.status === 200 || res.status >= 400);
    await settle();
    assert.equal(events.length, 1);
    assert.equal(events[0].rpc_method, '_unregistered');
    assert.equal(events[0].tool_name, null);
  });

  it('response without Content-Length does not record res_bytes: 0 (#8403)', async () => {
    const { emitMcpRequestEvent, createMcpUsage } = await import('../api/mcp/usage.ts');
    const events = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('axiom.co')) {
        for (const ev of JSON.parse(init.body)) events.push(ev);
        return new Response('{}', { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };
    const pending = [];
    const ctx = { waitUntil: (p) => pending.push(p) };
    const usage = createMcpUsage();
    usage.rpcMethod = 'tools/list';
    const body = '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}';
    // Chunked/streamed MCP responses omit Content-Length; Number(null)===0 was
    // the defect — unknown size must be null/absent, never a fake zero.
    const res = new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(res.headers.get('content-length'), null);
    emitMcpRequestEvent(
      new Request(BASE_URL, { method: 'POST', body: '{}' }),
      res,
      usage,
      12,
      ctx,
    );
    await Promise.allSettled(pending);
    assert.equal(events.length, 1);
    assert.equal(events[0].res_bytes, null);
    assert.notEqual(events[0].res_bytes, 0);
  });

  it('Content-Length when present is recorded as res_bytes (#8403)', async () => {
    const { emitMcpRequestEvent, createMcpUsage } = await import('../api/mcp/usage.ts');
    const events = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('axiom.co')) {
        for (const ev of JSON.parse(init.body)) events.push(ev);
        return new Response('{}', { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };
    const pending = [];
    const ctx = { waitUntil: (p) => pending.push(p) };
    const usage = createMcpUsage();
    const body = '{"ok":true}';
    const res = new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(new TextEncoder().encode(body).byteLength),
      },
    });
    emitMcpRequestEvent(
      new Request(BASE_URL, { method: 'POST', body: '{}' }),
      res,
      usage,
      5,
      ctx,
    );
    await Promise.allSettled(pending);
    assert.equal(events.length, 1);
    assert.equal(events[0].res_bytes, new TextEncoder().encode(body).byteLength);
  });

  it('/api/mcp pathname emits the same rpc_method fields as /mcp (#8403)', async () => {
    const { deps } = makeProDeps();
    const events = captureAxiom();
    const { ctx, settle } = makeCtx();
    const res = await mcpHandler(
      new Request('https://worldmonitor.app/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
      deps,
      ctx,
    );
    assert.equal(res.status, 200);
    await settle();
    assert.equal(events.length, 1);
    assert.equal(events[0].route, '/api/mcp');
    assert.equal(events[0].rpc_method, 'tools/list');
    assert.equal(events[0].tool_name, null);
  });
});

// #9431 — demand for tools we do not serve, and the outcome of tools that ran,
// land on the same wm_api_usage row as rpc_method/tool_name.
describe('api/mcp — requested_tool and tool outcome on wm_api_usage (#9431)', () => {
  let mcpHandler;
  let toolcallLines;
  let origLog;
  let origWarn;
  let origError;

  const MARKET_KEYS = {
    'market:stocks-bootstrap:v1': { quotes: [{ symbol: 'AAPL', price: 100 }] },
    'market:crypto:v1': { quotes: [] },
    'seed-meta:market:stocks': { fetchedAt: Date.now() - 60_000, recordCount: 1 },
  };

  beforeEach(async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'wm_env_key_1';
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'true';
    process.env.USAGE_TELEMETRY = '1';
    process.env.AXIOM_API_TOKEN = 'stub-token';
    const mod = await import(`../api/mcp.ts?t=${Date.now()}`);
    mcpHandler = mod.mcpHandler;
    toolcallLines = [];
    origLog = console.log;
    origWarn = console.warn;
    origError = console.error;
    console.log = (line) => {
      if (line && typeof line === 'object' && line.tag === 'mcp.toolcall') toolcallLines.push(line);
    };
    console.warn = () => {};
    console.error = () => {};
  });

  afterEach(() => {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  // Axiom sink plus an Upstash stub: `hit` serves MARKET_KEYS, `miss` reads
  // every key back absent so get_market_data throws cache_all_null.
  function captureAxiomWithCache(mode = 'hit') {
    const events = [];
    globalThis.fetch = async (url, init) => {
      const href = String(url);
      if (href.includes('axiom.co')) {
        for (const ev of JSON.parse(init.body)) events.push(ev);
        return new Response('{}', { status: 200 });
      }
      if (href.includes('/get/')) {
        const hit = mode === 'hit'
          ? Object.entries(MARKET_KEYS).find(([k]) => href.includes(`/get/${encodeURIComponent(k)}`))
          : undefined;
        return new Response(JSON.stringify(hit ? { result: JSON.stringify(hit[1]) } : {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    return events;
  }

  async function oneRow(req, mode) {
    const { deps } = makeProDeps();
    const events = captureAxiomWithCache(mode);
    const { ctx, settle } = makeCtx();
    const res = await mcpHandler(req, deps, ctx);
    const text = await res.text();
    await settle();
    assert.equal(events.length, 1, 'exactly one request event per POST');
    return { res, text, row: events[0] };
  }

  const rawCall = (name, args = {}) => ({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } });
  const anonReq = (body) => new Request(BASE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  function assertNoToolOutcome(row) {
    assert.equal(row.tool_error_kind, null);
    assert.equal(row.tool_result_bytes, null);
    assert.equal(row.tool_jmespath, null);
  }

  it('authenticated tools/call of an unserved tool records requested_tool, keeps tool_name null', async () => {
    const { res, text, row } = await oneRow(proReq('POST', callBody('get_vessel_track', { mmsi: '123456789' })));
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(text).error.code, -32602, 'the caller still gets Unknown tool');
    assert.ok(!JSON.stringify(row).includes('123456789'), 'arguments never reach the row');
    assert.equal(row.rpc_method, 'tools/call');
    assert.equal(row.tool_name, null);
    assert.equal(row.requested_tool, 'get_vessel_track');
    assertNoToolOutcome(row);
    assert.equal(toolcallLines.length, 0, 'no tool ran, so no mcp.toolcall line');
  });

  it('operator env-key callers are authenticated and also record requested_tool', async () => {
    const { row } = await oneRow(new Request(BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': 'wm_env_key_1' },
      body: JSON.stringify(rawCall('get_vessel_track')),
    }));
    assert.equal(row.auth_kind, 'enterprise_api_key');
    assert.equal(row.requested_tool, 'get_vessel_track');
  });

  it('describe_tool of an unserved tool records requested_tool; of a served tool records none', async () => {
    const miss = await oneRow(proReq('POST', callBody('describe_tool', { tool_name: 'get_vessel_track' })));
    assert.equal(miss.row.tool_name, 'describe_tool');
    assert.equal(miss.row.requested_tool, 'get_vessel_track');

    const hit = await oneRow(proReq('POST', callBody('describe_tool', { tool_name: 'get_market_data' })));
    assert.equal(hit.row.tool_name, 'describe_tool');
    assert.equal(hit.row.requested_tool, null);
  });

  it('describe_tool keeps its unknown_tool response unchanged', async () => {
    const { text } = await oneRow(proReq('POST', callBody('describe_tool', { tool_name: 'get_vessel_track' })));
    const body = JSON.parse(text);
    assert.equal(body.result.structuredContent.error, 'unknown_tool');
    assert.equal(body.result.structuredContent.requested, 'get_vessel_track');
  });

  it('anonymous tools/call of an unserved tool never writes requested_tool (#8403 cardinality bound)', async () => {
    const { row } = await oneRow(anonReq(rawCall('get_vessel_track')));
    assert.equal(row.auth_kind, 'anon');
    assert.equal(row.rpc_method, 'tools/call');
    assert.equal(row.requested_tool, null);
  });

  for (const [label, name, expected] of [
    ['SQL-ish text', 'DROP TABLE;', '<invalid>'],
    ['a 65-character name', `a${'b'.repeat(64)}`, '<invalid>'],
    ['a non-string object', { evil: 'payload' }, '<invalid>'],
    ['padded mixed case', '  Get_Vessel_Track ', 'get_vessel_track'],
    ['a 64-character name', `a${'b'.repeat(63)}`, `a${'b'.repeat(63)}`],
  ]) {
    it(`tools/call with ${label} records ${expected === '<invalid>' ? 'the <invalid> bucket' : 'the sanitized name'}`, async () => {
      const { row } = await oneRow(proReq('POST', rawCall(name)));
      assert.equal(row.tool_name, null);
      assert.equal(row.requested_tool, expected);
      assert.ok(!JSON.stringify(row).includes('payload'), 'no request content reaches the row');
    });
  }

  it('describe_tool with a malformed tool_name records the <invalid> bucket', async () => {
    const { row } = await oneRow(proReq('POST', callBody('describe_tool', { tool_name: 'DROP TABLE;' })));
    assert.equal(row.requested_tool, '<invalid>');
  });

  it('a name on a non-tools/call method is not recorded', async () => {
    const { row } = await oneRow(proReq('POST', { jsonrpc: '2.0', id: 8, method: 'prompts/get', params: { name: 'get_vessel_track' } }));
    assert.equal(row.rpc_method, 'prompts/get');
    assert.equal(row.requested_tool, null);
  });

  it('a successful cache tool call mirrors its mcp.toolcall line', async () => {
    const { res, row } = await oneRow(proReq('POST', callBody('get_market_data')));
    assert.equal(res.status, 200);
    assert.equal(toolcallLines.length, 1);
    const [line] = toolcallLines;
    assert.equal(line.ok, true);
    assert.equal(row.tool_name, 'get_market_data');
    assert.equal(row.requested_tool, null);
    assert.equal(row.tool_error_kind, null);
    assert.ok(row.tool_result_bytes > 0);
    assert.equal(row.tool_result_bytes, line.bytes_pre_jmespath);
    assert.equal(row.tool_jmespath, false);
  });

  it('a projected tool call records tool_jmespath true and the pre-projection size', async () => {
    const { row } = await oneRow(proReq('POST', callBody('get_market_data', { jmespath: 'data' })));
    const [line] = toolcallLines;
    assert.equal(line.jmespath_used, true);
    assert.equal(row.tool_jmespath, true);
    assert.equal(row.tool_result_bytes, line.bytes_pre_jmespath);
    assert.ok(row.tool_result_bytes > line.bytes_post_jmespath, 'pre-projection size, not the projected one');
  });

  it('the tool outcome is recorded even with MCP_TELEMETRY off', async () => {
    process.env.MCP_TELEMETRY = 'false';
    const { row } = await oneRow(proReq('POST', callBody('get_market_data', { jmespath: 'data' })));
    assert.equal(toolcallLines.length, 0, 'console line stays gated');
    assert.equal(row.tool_jmespath, true);
    assert.ok(row.tool_result_bytes > 0);
  });

  it('a failing tool call records the same error kind as its mcp.toolcall line', async () => {
    const { res, row } = await oneRow(proReq('POST', callBody('get_market_data')), 'miss');
    assert.equal(res.status, 200);
    assert.equal(toolcallLines.length, 1);
    const [line] = toolcallLines;
    assert.equal(line.ok, false);
    assert.equal(line.error_kind, 'server_error');
    assert.equal(row.tool_error_kind, line.error_kind);
    assert.equal(row.tool_result_bytes, line.bytes_pre_jmespath);
    assert.equal(row.tool_jmespath, false);
  });

  it('REST rows built without the MCP fields carry the four keys as null', async () => {
    const { buildRequestEvent } = await import('../server/_shared/usage.ts');
    const ev = buildRequestEvent({
      requestId: 'req_1', domain: 'market', route: '/api/market/v1/list', method: 'GET', status: 200,
      durationMs: 1, reqBytes: 0, resBytes: 10, customerId: null, principalId: null, authKind: 'anon',
      tier: 0, planKey: null, country: null, ipCity: null, ipRegion: null, executionRegion: null,
      executionPlane: 'vercel-edge', originKind: null, cacheTier: null, ip: null, userAgent: null,
      uaHash: null, referer: null, acceptLanguage: null, host: null, sentryTraceId: null, reason: 'ok',
    });
    for (const key of ['requested_tool', 'tool_error_kind', 'tool_result_bytes', 'tool_jmespath']) {
      assert.ok(key in ev, `${key} is present on every row`);
      assert.equal(ev[key], null);
    }
  });
});
