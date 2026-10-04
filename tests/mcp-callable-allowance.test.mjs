import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mcpHandler } from '../api/mcp/handler.ts';
import Ajv2020 from 'ajv/dist/2020.js';
import { SHARED_API_BUDGET } from '../api/mcp/quota.ts';
import { apiKeyDailyKey } from '../server/_shared/api-key-rate-limit.ts';
import { envPrefix } from '../server/_shared/pro-mcp-token.ts';
import { TOOL_REGISTRY, toolAccess, buildPublicTool, isQuotaExemptMetadataTool } from '../api/mcp/registry/index.ts';
import { dailyCounterKey } from '../server/_shared/pro-mcp-token.ts';
import { READ_FREE_ACCOUNT_ALLOWANCE_SCRIPT } from '../shared/free-account-allowance-scripts.mjs';
import { BASE_URL, HMAC_SECRET, PRO_USER_ID, makeProDeps, proReq, callBody } from './helpers/mcp-pro-deps.mjs';

const originalEnv = { ...process.env };
beforeEach(() => {
  process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
  process.env.MCP_TELEMETRY = 'false';
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});
const allowanceCall = args => callBody('get_mcp_allowance', args);
const resourceCall = { jsonrpc: '2.0', id: 301, method: 'resources/read', params: { uri: 'worldmonitor://account/mcp-allowance' } };

function fixture({ free = false, raw = '50', limit = 50, kind = 'pro' } = {}) {
  const observed = [];
  const { deps, pipe } = makeProDeps({
    ...(kind === 'user_key' ? { resolveBearerToContext: async () => ({ kind, userId: PRO_USER_ID }) } : {}),
    getEntitlements: async () => ({ planKey: free ? 'free' : 'pro', features: { tier: free ? 0 : 1, mcpAccess: !free, planLimits: { mcpCallsPerDay: free ? 0 : limit } }, validUntil: Date.now() + 86400000 }),
  });
  deps.redisPipeline = async commands => {
    observed.push(...commands);
    return commands.map(() => ({ result: raw }));
  };
  return { deps, pipe, observed };
}

async function invoke(deps, body) {
  const response = await mcpHandler(proReq('POST', body), deps);
  return { response, body: await response.json() };
}

describe('callable authenticated allowance', () => {
  it('advertises an exact read-only account tool without selectors, cache summary or anonymous access', async () => {
    const tool = TOOL_REGISTRY.find(entry => entry.name === 'get_mcp_allowance');
    assert.ok(tool);
    assert.equal(toolAccess(tool), 'free-account');
    assert.equal(tool._freeTier, undefined);
    assert.deepEqual(tool.inputSchema.properties, {});
    assert.deepEqual(tool._apiPaths, []);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(isQuotaExemptMetadataTool({ ...tool, name: 'get_mcp_allowance_extra' }), false);
    const { deps } = fixture();
    const result = await invoke(deps, callBody('describe_tool', { tool_name: tool.name }));
    const described = JSON.parse(result.body.result.content[0].text);
    assert.equal(described.name, tool.name);
    assert.equal(described.inputSchema.properties.summary, undefined);
    assert.equal(described.outputSchema.anyOf[0].properties.sharedWithRestApi.type, 'boolean');
    const listed = await invoke(deps, { jsonrpc: '2.0', id: 302, method: 'tools/list', params: { verbose: true } });
    const advertised = listed.body.result.tools.find(entry => entry.name === tool.name);
    assert.equal(advertised._meta['worldmonitor/access'], 'free-account');
    assert.deepEqual(advertised.outputSchema, described.outputSchema);
  });

  for (const kind of ['pro', 'user_key']) {
    for (const entry of [
      { label: 'exhausted paid', raw: '50', limit: 50 },
      { label: 'first paid', raw: null, limit: 50 },
      { label: 'zero paid', raw: '3', limit: 0 },
      { label: 'unlimited paid', raw: '61', limit: null },
      { label: 'exhausted free', free: true, raw: ['5', '3', -2] },
      { label: 'first free', free: true, raw: [null, null, -2] },
    ]) it(`matches resource status without reservation for ${kind} ${entry.label}`, async () => {
      const { deps, observed } = fixture({ ...entry, kind });
      const resource = await invoke(deps, resourceCall);
      const called = await invoke(deps, allowanceCall({}));
      assert.equal(called.body.error, undefined);
      const status = JSON.parse(called.body.result.content[0].text);
      assert.deepEqual(status, JSON.parse(resource.body.result.contents[0].text));
      assert.deepEqual(called.body.result.structuredContent, status);
      const tool = TOOL_REGISTRY.find(entry => entry.name === 'get_mcp_allowance');
      const ajv = new Ajv2020({ allowUnionTypes: true, strict: true, strictRequired: false, validateFormats: false });
      const validate = ajv.compile(buildPublicTool(tool, { compressDescriptions: false }).outputSchema);
      assert.equal(validate(status), true, JSON.stringify(validate.errors));
      assert.match(called.response.headers.get('Cache-Control'), /no-store/);
      assert.equal(observed.length, 2);
      if (entry.free) assert.ok(observed.every(command => command[0] === 'EVAL' && command[1] === READ_FREE_ACCOUNT_ALLOWANCE_SCRIPT));
      else assert.deepEqual(observed, [['GET', dailyCounterKey(PRO_USER_ID)], ['GET', dailyCounterKey(PRO_USER_ID)]]);
    });
  }

  it('keeps enforced API REST sharing and shadow counter selection exact for both credential doors', async () => {
    for (const kind of ['pro', 'user_key']) for (const enforce of [false, true]) {
      process.env.API_RATE_LIMIT_ENFORCE = String(enforce);
      const { deps, observed } = fixture({ kind });
      deps.getEntitlements = async () => ({ planKey: 'api_starter', features: { tier: 2, mcpAccess: true, planLimits: { mcpCallsPerDay: SHARED_API_BUDGET, apiRequestsPerDay: 1000 } }, validUntil: Date.now() + 86400000 });
      const called = await invoke(deps, allowanceCall({}));
      const resource = await invoke(deps, resourceCall);
      const status = called.body.result.structuredContent;
      assert.deepEqual(status, JSON.parse(resource.body.result.contents[0].text));
      assert.equal(status.limit, 1000);
      assert.equal(status.sharedWithRestApi, enforce);
      assert.deepEqual(observed, [
        ['GET', enforce ? `${envPrefix()}${apiKeyDailyKey(PRO_USER_ID)}` : dailyCounterKey(PRO_USER_ID)],
        ['GET', enforce ? `${envPrefix()}${apiKeyDailyKey(PRO_USER_ID)}` : dailyCounterKey(PRO_USER_ID)],
      ]);
    }
  });

  it('never converts impossible free snapshots into successful numeric status', async () => {
    for (const raw of [[], ['1', null, -2], ['0', '1', 60000], [null, null, 60000], ['1', '1', -1], ['bad', '1', -2], [undefined, undefined, -2]]) {
      const { deps, observed } = fixture({ free: true, raw });
      const called = await invoke(deps, allowanceCall({}));
      assert.equal(called.body.error?.code, -32603, JSON.stringify(raw));
      assert.equal(called.body.result, undefined);
      assert.equal(observed.length, 1);
      assert.equal(observed[0][1], READ_FREE_ACCOUNT_ALLOWANCE_SCRIPT);
    }
  });

  it('rejects panel receipts, account selectors and extra arguments before any counter operation', async () => {
    for (const args of [{ panel_request: 'forged' }, { panel_request: null }, { account: 'another-owner' }, { userId: 'another-owner' }, { summary: true }]) {
      const { deps, observed } = fixture();
      const called = await invoke(deps, allowanceCall(args));
      assert.equal(called.body.error?.code, -32602, JSON.stringify(args));
      assert.equal(observed.length, 0);
    }
  });

  it('keeps projection and failure semantics on the normal tool path', async () => {
    const { deps } = fixture({ raw: '7' });
    const projected = await invoke(deps, allowanceCall({ jmespath: 'remaining' }));
    assert.equal(JSON.parse(projected.body.result.content[0].text), 43);
    assert.equal(projected.body.result.structuredContent.projection, 43);
    for (const result of [null, [], [{}], [{ result: 'bad' }], [{ result: 1, error: 'outage' }]]) {
      deps.redisPipeline = async () => result;
      const called = await invoke(deps, allowanceCall({}));
      assert.equal(called.body.error?.code, -32603, JSON.stringify(result));
      assert.equal(called.body.result, undefined);
    }
    deps.redisPipeline = async () => { throw new Error('Redis unavailable'); };
    assert.equal((await invoke(deps, allowanceCall({}))).body.error?.code, -32603);
  });

  it('rejects anonymous, operator, revoked and mismatched owners before counter reads', async () => {
    const { deps, observed } = fixture();
    const anonymous = await mcpHandler(new Request(BASE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(allowanceCall({})) }), deps);
    assert.equal(anonymous.status, 401);
    for (const overrides of [
      { resolveBearerToContext: async () => ({ kind: 'env_key', apiKey: 'operator-key' }) },
      { validateProMcpToken: async () => null },
      { validateProMcpToken: async () => ({ userId: 'other-owner' }) },
      { getEntitlements: async () => null },
    ]) {
      const next = makeProDeps(overrides).deps;
      next.redisPipeline = deps.redisPipeline;
      const denied = await invoke(next, allowanceCall({}));
      assert.ok(denied.body.error);
      assert.equal(observed.length, 0);
    }
  });
});
