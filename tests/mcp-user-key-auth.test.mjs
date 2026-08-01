// #4859 — /mcp must accept customer-issued wm_ API keys (Convex userApiKeys)
// on X-WorldMonitor-Key, with the owner's mcpAccess entitlement gating data
// methods exactly like the Pro OAuth path (a user_key context must NEVER
// bypass the entitlement pre-check — see the #4859 fix-design comment).
// #4860 — a rejecting validateProMcpToken must surface a structured 503,
// never escape mcpHandler as a raw 500.
import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  BASE_URL,
  HMAC_SECRET,
  makeProDeps,
  proReq,
  callBody,
} from './helpers/mcp-pro-deps.mjs';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

// Canonical dashboard key shape (wm_ + 40 hex) — NOT in WORLDMONITOR_VALID_KEYS.
const USER_KEY = `wm_${'ab12'.repeat(10)}`;
const USER_KEY_USER_ID = 'user_apiplan_abc';
const ENV_KEY = 'wm_env_operator_key_999';

/** Deps bundle where USER_KEY resolves to USER_KEY_USER_ID (api_starter-like owner). */
function makeUserKeyDeps(overrides = {}) {
  return makeProDeps({
    validateUserApiKey: async (key) => (key === USER_KEY ? { userId: USER_KEY_USER_ID } : null),
    getEntitlements: async () => ({
      planKey: 'api_starter',
      features: { tier: 2, mcpAccess: true },
      validUntil: Date.now() + 86_400_000,
    }),
    ...overrides,
  });
}

function userKeyReq(body, headers = {}) {
  return new Request(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-WorldMonitor-Key': USER_KEY,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('api/mcp — user API keys on /mcp (#4859) + pre-check hardening (#4860)', () => {
  let mcpHandler;

  beforeEach(async () => {
    process.env.WORLDMONITOR_VALID_KEYS = ENV_KEY;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
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

  // ── #4860 — runProPreChecks must not let a validateProMcpToken rejection escape ──

  it('#4860: validateProMcpToken rejects → structured 503 -32603, not a thrown-through 500', async () => {
    const { deps } = makeProDeps({
      validateProMcpToken: async () => { throw new Error('redis exploded'); },
    });
    const res = await mcpHandler(proReq('POST', callBody('describe_tool', { tool_name: 'get_market_data' })), deps);
    assert.equal(res.status, 503, 'must fail closed with a retryable 503');
    assert.ok(res.headers.get('Retry-After'), 'transient failure must carry Retry-After');
    const body = await res.json();
    assert.equal(body.error?.code, -32603);
  });

  // ── #4859 — user keys accepted, entitlement-gated ──

  it('happy: valid user key + mcpAccess entitlement → describe_tool 200', async () => {
    const { deps, pipe } = makeUserKeyDeps();
    const res = await mcpHandler(userKeyReq(callBody('describe_tool', { tool_name: 'get_market_data' })), deps);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.result?.content?.[0]?.text?.includes('get_market_data'));
    assert.equal(pipe.count, 0, 'describe_tool is quota-exempt for user keys too');
  });

  it('happy: valid user key, data tool → 200 and daily quota reserved (counter at 1)', async () => {
    const { deps, pipe } = makeUserKeyDeps();
    process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'stub';
    globalThis.fetch = async () => new Response(JSON.stringify({ result: JSON.stringify({ ok: 1 }) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const res = await mcpHandler(userKeyReq(callBody('get_market_data')), deps);
    assert.equal(res.status, 200);
    assert.equal(pipe.count, 1, 'user_key tools/call must consume the daily quota (no unmetered cache-tool loophole)');
  });

  it('cap: user key with 50 calls today → 51st rejected 429 -32029, counter back at 50', async () => {
    const { deps, pipe } = makeUserKeyDeps({ pipelineOpts: { initialCount: 50 } });
    const res = await mcpHandler(userKeyReq(callBody('get_market_data')), deps);
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body.error?.code, -32029);
    assert.equal(pipe.count, 50);
  });

  it('entitlement gate: valid user key whose owner is free/no-mcpAccess → tools/call 401, tools/list still 200', async () => {
    const { deps } = makeUserKeyDeps({
      getEntitlements: async () => ({ planKey: 'free', features: { tier: 0, mcpAccess: false }, validUntil: 0 }),
    });
    const call = await mcpHandler(userKeyReq(callBody('describe_tool', { tool_name: 'get_market_data' })), deps);
    assert.equal(call.status, 401, 'lapsed owner must not reach any tools/call');
    const callBodyJson = await call.json();
    assert.equal(callBodyJson.error?.code, -32001);
    assert.match(callBodyJson.error?.message ?? '', /Subscription not active/);

    const list = await mcpHandler(userKeyReq({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), deps);
    assert.equal(list.status, 200, 'metadata discovery stays available (symmetric with the pro path)');
  });

  it('entitlement gate: getEntitlements throws for a user key → 401 fail-closed', async () => {
    const { deps } = makeUserKeyDeps({
      getEntitlements: async () => { throw new Error('convex down'); },
    });
    const res = await mcpHandler(userKeyReq(callBody('describe_tool', { tool_name: 'get_market_data' })), deps);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error?.code, -32001);
  });

  it('unknown wm_ key (not env, not a user key) → 401 -32001 Invalid API key', async () => {
    const { deps } = makeUserKeyDeps();
    const res = await mcpHandler(userKeyReq(callBody('describe_tool', { tool_name: 'get_market_data' }), { 'X-WorldMonitor-Key': 'wm_totally_unknown_key' }), deps);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error?.code, -32001);
    assert.match(body.error?.message ?? '', /Invalid API key/);
  });

  it('rotating unknown wm_ keys are bounded before the Convex-backed resolver', async () => {
    const order = [];
    let guardCalls = 0;
    const { deps } = makeUserKeyDeps({
      guardUserApiKeyValidation: async () => {
        order.push('guard');
        guardCalls += 1;
        return guardCalls < 3
          ? null
          : new Response(JSON.stringify({ error: 'Too many requests' }), {
            status: 429,
            headers: { 'Retry-After': '17', 'X-RateLimit-Limit': '60' },
          });
      },
      validateUserApiKey: async () => {
        order.push('validate');
        return null;
      },
    });

    const first = await mcpHandler(userKeyReq(
      callBody('describe_tool', { tool_name: 'get_market_data' }),
      { 'X-WorldMonitor-Key': 'wm_rotating_guess_1' },
    ), deps);
    const second = await mcpHandler(userKeyReq(
      callBody('describe_tool', { tool_name: 'get_market_data' }),
      { 'X-WorldMonitor-Key': 'wm_rotating_guess_2' },
    ), deps);
    const blocked = await mcpHandler(userKeyReq(
      callBody('describe_tool', { tool_name: 'get_market_data' }),
      { 'X-WorldMonitor-Key': 'wm_rotating_guess_3' },
    ), deps);

    assert.equal(first.status, 401);
    assert.equal(second.status, 401);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('Cache-Control'), 'no-store');
    assert.equal(blocked.headers.get('Retry-After'), '17');
    assert.equal((await blocked.json()).error?.code, -32029);
    assert.deepEqual(order, ['guard', 'validate', 'guard', 'validate', 'guard']);
  });

  it('validateUserApiKey dep throws → 503 (auth backend transient, mirrors bearer-resolve)', async () => {
    const { deps } = makeUserKeyDeps({
      validateUserApiKey: async () => { throw new Error('redis down'); },
    });
    const res = await mcpHandler(userKeyReq(callBody('describe_tool', { tool_name: 'get_market_data' })), deps);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error?.code, -32603);
  });

  it('env allowlist key still authenticates without touching the user-key resolver', async () => {
    let userKeyCalls = 0;
    const { deps } = makeUserKeyDeps({
      validateUserApiKey: async () => { userKeyCalls += 1; return null; },
    });
    const res = await mcpHandler(userKeyReq(callBody('describe_tool', { tool_name: 'get_market_data' }), { 'X-WorldMonitor-Key': ENV_KEY }), deps);
    assert.equal(res.status, 200);
    assert.equal(userKeyCalls, 0, 'env-key hit must short-circuit before the Convex-backed resolver');
  });

  it('_execute downstream fetch carries the user key header, never internal-HMAC headers', async () => {
    const { deps } = makeUserKeyDeps();
    const captured = [];
    globalThis.fetch = async (url, init) => {
      captured.push(new Request(url, init));
      return new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    await mcpHandler(userKeyReq(callBody('get_country_risk', { country_code: 'US' })), deps);
    // Filter to the sibling REST fetch: an earlier test in this file may have
    // instantiated the module-memoized Upstash rate limiter, whose Redis POST
    // is also captured here and legitimately carries no key header.
    const apiFetches = captured.filter((r) => new URL(r.url).pathname.startsWith('/api/'));
    assert.ok(apiFetches.length > 0, 'RPC tool must fetch the downstream REST endpoint');
    for (const dsReq of apiFetches) {
      assert.equal(dsReq.headers.get('x-worldmonitor-key'), USER_KEY, 'downstream must authenticate as the key owner');
      assert.equal(dsReq.headers.get('x-wm-mcp-internal'), null, 'internal HMAC headers are pro-context only');
    }
  });
});
