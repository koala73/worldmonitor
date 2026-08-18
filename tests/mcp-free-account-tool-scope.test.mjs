/**
 * #6716 — which tools the free-account allowance actually covers, and what the
 * denial looks like when it does not.
 *
 * The load-bearing case is the first test: `server/gateway.ts` runs its own
 * `checkProMcpAccess` re-check that this feature deliberately does NOT relax,
 * so admitting a gateway-backed tool on the free path would charge one of five
 * daily slots and then hand the caller a gateway 401 it can never convert into
 * data. The refusal has to happen before the reservation.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { HMAC_SECRET, makeProDeps } from './helpers/mcp-pro-deps.mjs';

const FREE_ENT_ACTIVE = {
  planKey: 'free',
  features: { tier: 0, mcpAccess: false },
  validUntil: Date.now() + 86_400_000,
};

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
let mcpHandler;
let bust = 0;

beforeEach(async () => {
  process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
  process.env.MCP_TELEMETRY = 'false';
  bust += 1;
  ({ mcpHandler } = await import(`../api/mcp.ts?scope=${bust}-${Date.now()}`));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.keys(process.env).forEach((k) => {
    if (!(k in originalEnv)) delete process.env[k];
  });
  Object.assign(process.env, originalEnv);
});

function proReq(body) {
  return new Request('https://worldmonitor.app/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer pro-bearer-uuid' },
    body: JSON.stringify(body),
  });
}
const call = (name, args = {}) => ({
  jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
});

describe('free-account allowance — tool scope', () => {
  it('refuses a GATEWAY-BACKED tool with 403 upgrade-required and charges NO slot', async () => {
    const { deps, pipe } = makeProDeps({ getEntitlements: async () => FREE_ENT_ACTIVE });
    const res = await mcpHandler(proReq(call('get_country_risk', { country: 'FR' })), deps);
    assert.equal(res.status, 403, 'terminal-until-upgrade: not 401 (re-auth) and not 429 (retry)');
    const body = await res.json();
    assert.equal(body.error?.code, -32002);
    assert.equal(body.error?.data?.reason, 'upgrade-required');
    assert.ok(body.error?.data?.upgradeUrl, 'an agent needs somewhere to go');
    assert.equal(
      res.headers.get('WWW-Authenticate'),
      null,
      're-authenticating cannot fix a tier denial, so it must not be advertised',
    );
    // The whole point of the guard.
    assert.equal(pipe.count, 0, 'no free slot may be spent on a call the gateway will refuse');
  });

  it('still allows a CACHE-BACKED tool on the same entitlement', async () => {
    // Paired with the test above on purpose: without this one, a completely
    // broken free path would also produce a passing 403 assertion.
    const { deps, pipe } = makeProDeps({ getEntitlements: async () => FREE_ENT_ACTIVE });
    process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'stub';
    globalThis.fetch = async () => new Response(
      JSON.stringify({ result: JSON.stringify({ ok: 1 }) }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
    const res = await mcpHandler(proReq(call('get_market_data')), deps);
    assert.equal(res.status, 200);
    assert.ok(pipe.count >= 1, 'the cache-backed call is metered');
  });

  it('keeps describe_tool available — metadata is how an agent learns what it may call', async () => {
    const { deps, pipe } = makeProDeps({ getEntitlements: async () => FREE_ENT_ACTIVE });
    const res = await mcpHandler(proReq(call('describe_tool', { tool_name: 'get_market_data' })), deps);
    assert.equal(res.status, 200, 'describe_tool has an _execute but never reaches the gateway');
    assert.equal(pipe.count, 0, 'and stays quota-exempt');
  });

  it('a fully-entitled Pro caller still reaches gateway-backed tools', async () => {
    // Guards the blast radius of the refusal: it must key on the free-allowance
    // flag, not on the tool class alone.
    const { deps } = makeProDeps({
      getEntitlements: async () => ({
        planKey: 'pro',
        features: { tier: 1, mcpAccess: true, planLimits: { mcpCallsPerDay: 50 } },
        validUntil: Date.now() + 86_400_000,
      }),
    });
    globalThis.fetch = async () => new Response(
      JSON.stringify({ ok: true, data: {} }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
    const res = await mcpHandler(proReq(call('get_country_risk', { country: 'FR' })), deps);
    assert.notEqual(res.status, 403, 'a Pro caller must never see upgrade-required');
  });
});

describe('free-account allowance — denial envelopes', () => {
  it('an exhausted allowance is a QUOTA denial: -32029 at 429 with Retry-After', async () => {
    const { deps } = makeProDeps({
      getEntitlements: async () => FREE_ENT_ACTIVE,
      pipelineOpts: { initialCount: 5 },
    });
    const res = await mcpHandler(proReq(call('get_market_data')), deps);
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body.error?.code, -32029, 'the code the error catalog maps to "back off"');
    assert.equal(body.error?.data?.reason, 'allowance-exhausted');
    assert.ok(Number(res.headers.get('Retry-After')) > 0);
    // -32001/401 here would send an RFC-9728 client into an OAuth loop it can
    // never exit: re-auth succeeds, the retry 401s again, forever.
    assert.equal(res.headers.get('WWW-Authenticate'), null);
  });

  it('a credential-less gated call carries the structured no-account payload', async () => {
    // SERVER_INSTRUCTIONS promises agents `error.data` on unauthenticated gated
    // calls; this is the denial they actually hit first.
    const { deps } = makeProDeps({});
    const res = await mcpHandler(new Request('https://worldmonitor.app/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(call('get_market_data')),
    }), deps);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error?.code, -32001);
    assert.equal(body.error?.data?.reason, 'no-account');
    assert.ok(body.error?.data?.upgradeUrl);
    assert.ok(body.error?.data?.nextStep);
    // Every 401 on this surface carries the OAuth discovery pointer.
    assert.match(res.headers.get('WWW-Authenticate') ?? '', /resource_metadata=/);
  });
});
