// Access matrix for the two original-forecast readers, get_forecast_case and
// get_forecast_theaters. Dedicated MCP allowances (Pro) read them under a
// signed forecasts panel_request; API allowances bill per tool call and cannot
// hold a panel, so they read without one at the tool's normal weight.
//
// | caller                        | panel_request | outcome                                     |
// |-------------------------------|---------------|---------------------------------------------|
// | keyless                       | any           | 401, no source read                         |
// | free account                  | any           | 403 upgrade-required, no slot               |
// | API allowance (key or OAuth)  | absent        | served, charged toolWeight                  |
// | API allowance                 | present       | -32602, no charge, no source read           |
// | Pro dedicated panel           | absent        | -32602 open a panel first, no charge        |
// | Pro dedicated panel           | valid         | served inside the panel allocation          |
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BASE_URL, HMAC_SECRET, callBody, makeProDeps, proReq } from './helpers/mcp-pro-deps.mjs';
import { TOOL_REGISTRY, toolWeight } from '../api/mcp/registry/index.ts';

const USER_KEY = `wm_${'cd34'.repeat(10)}`;
const API_ENTITLEMENT = { planKey: 'api_starter', features: { tier: 2, mcpAccess: true, apiAccess: true, planLimits: { apiCallsPerDay: 1000, mcpCallsPerDay: 'shared-api-budget' } }, validUntil: Date.now() + 86_400_000 };
const FREE_ENTITLEMENT = { planKey: 'free', features: { tier: 0, mcpAccess: false }, validUntil: Date.now() + 86_400_000 };
const generatedAt = 1791113000010;
const forecast = { id: 'original-0', title: 'Original forecast', domain: 'energy', region: 'Europe', probability: 0.4, caseFile: { baseCase: 'Original prose' } };
const theaters = { found: true, runId: '1791113000000-original', schemaVersion: 'v1', theaterCount: 1, generatedAt: 1791113000000,
  note: '', error: '', theaterSummariesJson: JSON.stringify([{ theaterId: 'T1', theaterLabel: 'Original theater', stateKind: 'pressure', topPaths: [
    { pathId: 'P1', label: 'Original path', summary: 'Original assessment', confidence: null, keyActors: ['Actor'] }],
  dominantReactions: ['Reaction'], stabilizers: ['Stabilizer'], invalidators: ['Invalidator'] }]),
  processing: false, eligibleTheaterCount: 1, failedTheaterCount: 0, allTheatersFailed: false, completionStatus: 'completed' };
const caseArgs = { forecast_id: 'original-0', generated_at: String(generatedAt) };
const weight = name => toolWeight(TOOL_REGISTRY.find(tool => tool.name === name));

function fixture(t) {
  const oldFetch = globalThis.fetch;
  const oldEnv = { ...process.env };
  t.after(() => { globalThis.fetch = oldFetch; for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key]; Object.assign(process.env, oldEnv); });
  process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
  process.env.MCP_TELEMETRY = 'false';
  process.env.UPSTASH_REDIS_REST_URL = 'https://forecast-access.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  const sourceReads = [];
  globalThis.fetch = async url => {
    const parsed = new URL(url);
    if (parsed.hostname === 'forecast-access.test') {
      if (!parsed.pathname.startsWith('/get/')) return Response.json({ result: [9999, 10000] });
      const key = decodeURIComponent(parsed.pathname.slice(5));
      assert.ok(['forecast:predictions:v2', 'seed-meta:forecast:predictions'].includes(key), key);
      if (key === 'forecast:predictions:v2') sourceReads.push(key);
      return Response.json({ result: JSON.stringify(key.startsWith('seed-meta:') ? { fetchedAt: Date.now() } : { generatedAt, predictions: [forecast] }) });
    }
    assert.equal(parsed.pathname, '/api/forecast/v1/get-simulation-outcome');
    sourceReads.push(parsed.pathname);
    return Response.json(theaters);
  };
  return { sourceReads };
}

async function call(deps, name, args, headers) {
  const { mcpHandler } = await import('../api/mcp.ts');
  const req = headers === undefined ? proReq('POST', callBody(name, args)) : new Request(BASE_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(callBody(name, args)),
  });
  const response = await mcpHandler(req, deps);
  return { status: response.status, body: await response.json() };
}

const apiCallers = [
  ['dashboard API key', () => makeProDeps({ validateUserApiKey: async key => (key === USER_KEY ? { userId: 'user_apiplan_abc' } : null), getEntitlements: async () => API_ENTITLEMENT }), { 'X-WorldMonitor-Key': USER_KEY }],
  ['OAuth on an API plan', () => makeProDeps({ getEntitlements: async () => API_ENTITLEMENT }), undefined],
];

describe('original forecast readers: access matrix', () => {
  it('keyless callers are refused before any source read', async t => {
    const f = fixture(t);
    const { deps } = makeProDeps();
    for (const [name, args] of [['get_forecast_case', caseArgs], ['get_forecast_theaters', {}]]) {
      const reply = await call(deps, name, args, {});
      assert.equal(reply.status, 401, JSON.stringify(reply.body));
    }
    assert.equal(f.sourceReads.length, 0);
  });

  it('free accounts are refused as subscription-only without spending a slot', async t => {
    const f = fixture(t);
    const { deps, pipe } = makeProDeps({ getEntitlements: async () => FREE_ENTITLEMENT });
    for (const [name, args] of [['get_forecast_case', caseArgs], ['get_forecast_theaters', {}], ['get_forecast_case', { ...caseArgs, panel_request: 'forecasts.b1.1.x' }]]) {
      const reply = await call(deps, name, args);
      assert.equal(reply.status, 403, JSON.stringify(reply.body));
      assert.equal(reply.body.error?.data?.reason, 'upgrade-required');
    }
    assert.equal(pipe.count, 0);
    assert.equal(f.sourceReads.length, 0);
  });

  for (const [label, makeDeps, headers] of apiCallers) {
    it(`API allowance via ${label} reads both tools without a panel_request at tool weight`, async t => {
      const f = fixture(t);
      const { deps, pipe } = makeDeps();
      const detail = await call(deps, 'get_forecast_case', caseArgs, headers);
      assert.equal(detail.body.error, undefined, JSON.stringify(detail.body));
      assert.equal(detail.body.result.isError, undefined, JSON.stringify(detail.body.result));
      assert.equal(detail.body.result.structuredContent.data.forecastCase.status, 'ready');
      assert.deepEqual(detail.body.result.structuredContent.data.forecastCase.forecast, forecast);
      assert.equal(pipe.count, weight('get_forecast_case'));

      const changed = await call(deps, 'get_forecast_case', { ...caseArgs, generated_at: String(generatedAt - 1) }, headers);
      assert.equal(changed.body.result.structuredContent.data.forecastCase.status, 'generation_changed');
      assert.equal(changed.body.result.structuredContent.data.forecastCase.forecast, null);

      const missing = await call(deps, 'get_forecast_case', { ...caseArgs, forecast_id: 'unknown' }, headers);
      assert.equal(missing.body.result.structuredContent.data.forecastCase.status, 'missing');

      const reply = await call(deps, 'get_forecast_theaters', {}, headers);
      assert.equal(reply.body.error, undefined, JSON.stringify(reply.body));
      assert.deepEqual(reply.body.result.structuredContent.data.forecastTheaters, { ...theaters, status: 'ready' });
      assert.equal(pipe.count, 3 * weight('get_forecast_case') + weight('get_forecast_theaters'));
      assert.equal(f.sourceReads.filter(read => read.startsWith('/api/')).length, 1);
    });

    it(`API allowance via ${label} still rejects a panel_request and widened arguments without charging`, async t => {
      const f = fixture(t);
      const { deps, pipe } = makeDeps();
      for (const [name, args] of [
        ['get_forecast_case', { ...caseArgs, panel_request: 'forecasts.b1.1.x' }],
        ['get_forecast_theaters', { panel_request: 'forecasts.b1.1.x' }],
        ['get_forecast_case', { forecast_id: 'original-0' }],
        ['get_forecast_case', { ...caseArgs, domain: 'energy' }],
        ['get_forecast_theaters', { run_id: theaters.runId }],
      ]) {
        const reply = await call(deps, name, args, headers);
        assert.equal(reply.body.error?.code ?? (reply.body.result?.isError ? 'tool-error' : 'ok'), -32602, `${name} ${JSON.stringify(args)} ${JSON.stringify(reply.body)}`);
      }
      assert.equal(f.sourceReads.filter(read => read.startsWith('/api/')).length, 0);
      assert.equal(pipe.count, 0);
    });
  }

  for (const [label, makeDeps, headers] of apiCallers) {
    it(`API allowance via ${label} applies the advertised jmespath projection to both readers`, async t => {
      const f = fixture(t);
      const { deps, pipe } = makeDeps();
      const detail = await call(deps, 'get_forecast_case', { ...caseArgs, jmespath: 'data.forecastCase.forecast.id' }, headers);
      assert.equal(detail.body.error, undefined, JSON.stringify(detail.body));
      assert.deepEqual(detail.body.result.structuredContent, { projection: forecast.id });
      const reply = await call(deps, 'get_forecast_theaters', { jmespath: 'data.forecastTheaters.status' }, headers);
      assert.equal(reply.body.error, undefined, JSON.stringify(reply.body));
      assert.deepEqual(reply.body.result.structuredContent, { projection: 'ready' });
      assert.equal(pipe.count, weight('get_forecast_case') + weight('get_forecast_theaters'));
      assert.equal(f.sourceReads.filter(read => read.startsWith('/api/')).length, 1);
    });
  }

  it('Pro dedicated panels apply jmespath to signed reads without poisoning the cached original', async t => {
    const f = fixture(t);
    const { deps, pipe } = makeProDeps();
    const opening = await call(deps, 'get_forecast_predictions', {});
    const panel_request = opening.body.result.structuredContent.panelRequest.token;
    const detail = await call(deps, 'get_forecast_case', { ...caseArgs, panel_request, jmespath: 'data.forecastCase.forecast.id' });
    assert.equal(detail.body.error, undefined, JSON.stringify(detail.body));
    assert.deepEqual(detail.body.result.structuredContent, { projection: forecast.id });
    const replay = await call(deps, 'get_forecast_case', { ...caseArgs, panel_request });
    assert.deepEqual(replay.body.result.structuredContent.data.forecastCase.forecast, forecast);
    const theaterReply = await call(deps, 'get_forecast_theaters', { panel_request, jmespath: 'data.forecastTheaters.status' });
    assert.equal(theaterReply.body.error, undefined, JSON.stringify(theaterReply.body));
    assert.deepEqual(theaterReply.body.result.structuredContent, { projection: 'ready' });
    const theaterReplay = await call(deps, 'get_forecast_theaters', { panel_request });
    assert.deepEqual(theaterReplay.body.result.structuredContent.data.forecastTheaters, { ...theaters, status: 'ready' });
    assert.equal(f.sourceReads.filter(read => read.startsWith('/api/')).length, 1, 'the projected read cached the original for replay');
    assert.equal(pipe.count, 1);
  });

  it('Pro dedicated panels still need the signed panel_request and read inside one allocation', async t => {
    const f = fixture(t);
    const { deps, pipe } = makeProDeps();
    for (const [name, args] of [['get_forecast_case', caseArgs], ['get_forecast_theaters', {}]]) {
      const denied = await call(deps, name, args);
      assert.equal(denied.body.error?.code, -32602);
      assert.match(denied.body.error.message, /Open a forecast panel/);
    }
    assert.equal(pipe.count, 0);
    assert.equal(f.sourceReads.length, 0);

    const opening = await call(deps, 'get_forecast_predictions', {});
    const panel_request = opening.body.result.structuredContent.panelRequest.token;
    const detail = await call(deps, 'get_forecast_case', { ...caseArgs, panel_request });
    assert.deepEqual(detail.body.result.structuredContent.data.forecastCase.forecast, forecast);
    const reply = await call(deps, 'get_forecast_theaters', { panel_request });
    assert.equal(reply.body.result.structuredContent.data.forecastTheaters.status, 'ready');
    assert.equal(pipe.count, 1);
  });

  it('advertises panel_request as optional and keeps the exact generation guard required', () => {
    const caseTool = TOOL_REGISTRY.find(tool => tool.name === 'get_forecast_case');
    assert.deepEqual(caseTool.inputSchema.required, ['forecast_id', 'generated_at']);
    assert.ok('panel_request' in caseTool.inputSchema.properties);
    const theaterTool = TOOL_REGISTRY.find(tool => tool.name === 'get_forecast_theaters');
    assert.deepEqual(theaterTool.inputSchema.required ?? [], []);
    assert.ok('panel_request' in theaterTool.inputSchema.properties);
    for (const tool of [caseTool, theaterTool]) {
      assert.equal(tool._subscriptionOnly, true);
      assert.doesNotMatch(tool.description, /\bget_[a-z_]+|\byou\b/i);
    }
  });
});
