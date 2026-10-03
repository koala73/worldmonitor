import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Ratelimit } from '@upstash/ratelimit';
import { HMAC_SECRET, PRO_USER_ID, callBody, makeProDeps, proReq } from './helpers/mcp-pro-deps.mjs';
import { admitCountryPanel, admitNewsPanel } from '../api/mcp/panel-requests.ts';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const originalWindow = Ratelimit.slidingWindow;
const userBucket = `rl:mcp:pro-min:pro-user:${PRO_USER_ID}`;
let counts;
let calls;
let handler;
let fetched;

before(async () => {
  process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
  process.env.MCP_TELEMETRY = 'false';
  process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'stub-token';
  Ratelimit.slidingWindow = (tokens, window) => () => ({
    async limit(_ctx, key) {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      calls.push({ key, tokens, window });
      return { success: count <= tokens, limit: tokens, remaining: Math.max(0, tokens - count), reset: Date.now() + 60_000, pending: Promise.resolve() };
    },
  });
  globalThis.fetch = async url => {
    fetched.push(String(url));
    if (String(url).startsWith('https://stub.upstash.invalid/get/')) return Response.json({ result: JSON.stringify({ earthquakes: [], fireDetections: [], events: [], seededAt: new Date().toISOString() }) });
    return Response.json({ countryCode: 'US', available: true });
  };
  handler = (await import('../api/mcp.ts')).mcpHandler;
});
beforeEach(() => { counts = new Map(); calls = []; fetched = []; });
after(() => {
  Ratelimit.slidingWindow = originalWindow;
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});
async function invoke(deps, name, args) {
  const response = await handler(proReq('POST', callBody(name, args)), deps);
  return { response, body: await response.json() };
}
async function open(deps) {
  const result = await invoke(deps, 'open_country_brief', { country_code: 'US' });
  assert.equal(result.body.error, undefined);
  return result.body.result.structuredContent.panelRequest;
}
const energy = token => ({ section: 'energy', arguments: { country_code: 'US' }, panel_request: token });

describe('bounded panel reads with an enabled minute limiter', () => {
  it('completes paid internal reads after the ordinary user burst is spent', async () => {
    const { deps, pipe } = makeProDeps();
    const receipt = await open(deps);
    assert.equal(counts.get(userBucket), 1);
    counts.set(userBucket, 60);
    const result = await invoke(deps, 'get_country_brief_section', energy(receipt.token));
    assert.equal(result.body.error, undefined);
    assert.equal(result.body.result.structuredContent.state, 'ready');
    assert.equal(counts.get(userBucket), 60);
    assert.equal(pipe.count, 1);
    assert.equal(calls.at(-1).tokens, 64);
    assert.match(calls.at(-1).key, /:pro-panel:/);
    assert.ok(!calls.at(-1).key.includes(receipt.token));
  });
  it('bounds cached replay too, without spending new daily allocations', async () => {
    const { deps, pipe } = makeProDeps();
    const receipt = await open(deps);
    for (let i = 0; i < 64; i++) {
      const result = await invoke(deps, 'get_country_brief_section', energy(receipt.token));
      assert.equal(result.body.error, undefined, `read ${i + 1}`);
    }
    assert.equal(fetched.length, 1);
    const denied = await invoke(deps, 'get_country_brief_section', energy(receipt.token));
    assert.equal(denied.body.error?.code, -32029);
    assert.match(denied.body.error.message, /per minute per panel/);
    assert.equal(denied.response.headers.get('X-RateLimit-Limit'), '64');
    assert.equal(denied.response.headers.get('X-RateLimit-Remaining'), '0');
    assert.equal(pipe.count, 1);
    assert.equal(fetched.length, 1);
  });
  it('records a dispatched JSON-RPC burst denial as a limit event', async () => {
    const { deps } = makeProDeps();
    const receipt = await open(deps);
    await invoke(deps, 'get_country_brief_section', energy(receipt.token));
    const panelBucket = calls.at(-1).key;
    counts.set(panelBucket, 64);
    const events = [];
    const pending = [];
    const transport = globalThis.fetch;
    process.env.USAGE_TELEMETRY = '1';
    process.env.AXIOM_API_TOKEN = 'stub-token';
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('axiom.co')) {
        events.push(...JSON.parse(init.body));
        return Response.json({});
      }
      return transport(url, init);
    };
    try {
      const response = await handler(proReq('POST', callBody('get_country_brief_section', energy(receipt.token))), deps, { waitUntil: promise => pending.push(promise) });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).error.code, -32029);
      await Promise.all(pending);
      assert.equal(events.length, 1);
      assert.equal(events[0].reason, 'rate_limit_429');
      assert.equal(events[0].tool_name, 'get_country_brief_section');
    } finally {
      globalThis.fetch = transport;
      delete process.env.USAGE_TELEMETRY;
      delete process.env.AXIOM_API_TOKEN;
    }
  });
  it('keeps ordinary openings and tool calls on the plan user burst', async () => {
    const { deps, pipe } = makeProDeps();
    counts.set(userBucket, 60);
    const opening = await invoke(deps, 'open_country_brief', { country_code: 'US' });
    assert.equal(opening.body.error?.code, -32029);
    const ordinary = await invoke(deps, 'get_country_brief_section', { section: 'energy', arguments: { country_code: 'US' } });
    assert.equal(ordinary.body.error?.code, -32029);
    assert.equal(pipe.count, 0);
    assert.equal(fetched.length, 0);
    assert.ok(calls.every(call => call.key === userBucket && call.tokens === 60));
  });
  it('spends the resource-read minute limit once before delegated tool dispatch', async () => {
    const { deps } = makeProDeps();
    const response = await handler(proReq('POST', { jsonrpc: '2.0', id: 100, method: 'resources/read', params: { uri: 'worldmonitor://countries/us/risk' } }), deps);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).error, undefined);
    assert.equal(counts.get(userBucket), 1);
  });
  it('does not let forged or country-mismatched tokens escape the user burst', async () => {
    const { deps } = makeProDeps();
    const receipt = await open(deps);
    counts.set(userBucket, 60);
    const expired = receipt.token.split('.');
    expired[2] = String(Date.now() - 1);
    for (const args of [energy('forged'), energy(expired.join('.')), { ...energy(receipt.token), arguments: { country_code: 'FR' } }]) {
      const denied = await invoke(deps, 'get_country_brief_section', args);
      assert.equal(denied.body.error?.code, -32029);
    }
    assert.equal(fetched.length, 0);
    assert.ok(!calls.some(call => call.key.includes(':pro-panel:')));
  });
  it('rejects another owner\'s valid signed receipt without a panel burst bucket', async () => {
    const { deps, pipe } = makeProDeps();
    const receipt = await admitCountryPanel({ kind: 'pro', userId: 'other-user', mcpTokenId: 'other-token' }, { allowance: 'mcp', limit: 50 }, pipe.pipeline, { country_code: 'US' });
    const denied = await invoke(deps, 'get_country_brief_section', energy(receipt.token));
    assert.equal(denied.body.error?.code, -32602);
    assert.equal(counts.get(userBucket), 1);
    assert.equal(fetched.length, 0);
    assert.ok(!calls.some(call => call.key.includes(':pro-panel:')));
  });
  it('uses the same bounded read bucket for an admitted news map snapshot', async () => {
    const { deps, pipe } = makeProDeps();
    const receipt = await admitNewsPanel({ kind: 'pro', userId: PRO_USER_ID, mcpTokenId: 'k57mcptokenid' }, { allowance: 'mcp', limit: 50 }, pipe.pipeline, {});
    counts.set(userBucket, 60);
    const result = await invoke(deps, 'get_natural_disasters', { dataset: ['earthquakes'], limit: 20, panel_request: receipt.token });
    assert.equal(result.body.error, undefined);
    assert.equal(counts.get(userBucket), 60);
    assert.equal(calls.at(-1).tokens, 64);
    assert.match(calls.at(-1).key, /:pro-panel:/);
    assert.equal(pipe.count, 1);
  });
  it('keeps API-plan reads on their account burst even with a valid panel token', async () => {
    const { deps, pipe } = makeProDeps({ getEntitlements: async () => ({ planKey: 'api_starter', features: { tier: 1, mcpAccess: true, planLimits: { mcpCallsPerDay: 'shared-api-budget', apiRequestsPerDay: 1000, mcpBurstRequestsPerMinute: 60 } }, validUntil: Date.now() + 86400000 }) });
    const receipt = await admitCountryPanel({ kind: 'pro', userId: PRO_USER_ID, mcpTokenId: 'k57mcptokenid' }, { allowance: 'mcp', limit: 50 }, pipe.pipeline, { country_code: 'US' });
    counts.set(userBucket, 60);
    const denied = await invoke(deps, 'get_country_brief_section', energy(receipt.token));
    assert.equal(denied.body.error?.code, -32029);
    assert.ok(!calls.some(call => call.key.includes(':pro-panel:')));
    assert.equal(fetched.length, 0);
  });
  it('rejects unknown tools with a token under the ordinary user burst', async () => {
    const { deps } = makeProDeps();
    const receipt = await open(deps);
    counts.set(userBucket, 60);
    const denied = await invoke(deps, 'not_a_tool', { panel_request: receipt.token });
    assert.equal(denied.body.error?.code, -32029);
    assert.equal(fetched.length, 0);
  });
  it('retains revocation checks before replaying paid data', async () => {
    let revoked = false;
    const { deps } = makeProDeps({ getEntitlements: async () => ({ planKey: 'pro', features: { tier: 1, mcpAccess: !revoked }, validUntil: Date.now() + 86400000 }) });
    const receipt = await open(deps);
    assert.equal((await invoke(deps, 'get_country_brief_section', energy(receipt.token))).body.error, undefined);
    revoked = true;
    const denied = await invoke(deps, 'get_country_brief_section', energy(receipt.token));
    assert.equal(denied.response.status, 403);
    assert.equal(fetched.length, 1);
  });
});
