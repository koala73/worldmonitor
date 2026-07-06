// #4866 — /mcp emits wm_api_usage RequestEvents so MCP auth rejections,
// quota hits, and successes are visible in Axiom (they were fully invisible
// during the #4859 diagnosis: no gateway pass-through, no log drain).
import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  BASE_URL,
  HMAC_SECRET,
  PRO_BEARER,
  makeProDeps,
  proReq,
  callBody,
} from './helpers/mcp-pro-deps.mjs';

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

  it('pro bearer with lapsed entitlement emits tier_403 attributed to the userId', async () => {
    const { deps } = makeProDeps({
      getEntitlements: async () => ({ planKey: 'free', features: { tier: 0, mcpAccess: false }, validUntil: 0 }),
    });
    const events = captureAxiom();
    const { ctx, settle } = makeCtx();
    const res = await mcpHandler(proReq('POST', callBody('describe_tool', { tool_name: 'get_market_data' })), deps, ctx);
    assert.equal(res.status, 401);
    await settle();
    assert.equal(events.length, 1);
    const ev = events[0];
    assert.equal(ev.reason, 'tier_403');
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
});
