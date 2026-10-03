import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Ratelimit } from '@upstash/ratelimit';
import { HMAC_SECRET, PRO_USER_ID, callBody, makeProDeps, proReq } from './helpers/mcp-pro-deps.mjs';

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
    assert.equal(pipe.count, 1);
    assert.equal(fetched.length, 1);
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
  it('does not let forged or country-mismatched tokens escape the user burst', async () => {
    const { deps } = makeProDeps();
    const receipt = await open(deps);
    counts.set(userBucket, 60);
    for (const args of [energy('forged'), { ...energy(receipt.token), arguments: { country_code: 'FR' } }]) {
      const denied = await invoke(deps, 'get_country_brief_section', args);
      assert.equal(denied.body.error?.code, -32029);
    }
    assert.equal(fetched.length, 0);
    assert.ok(!calls.some(call => call.key.includes(':pro-panel:')));
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
