import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mcpHandler } from '../api/mcp.ts';
import { HMAC_SECRET, callBody, makeProDeps, proReq } from './helpers/mcp-pro-deps.mjs';
import { TOOL_REGISTRY, toolAccess } from '../api/mcp/registry/index.ts';

const theaters = [{ theaterId: 'T1', theaterLabel: 'Original theater', stateKind: 'pressure', topPaths: [
  { pathId: 'P1', label: 'Original path', summary: 'Original assessment', confidence: null, keyActors: ['Actor'], keyActorRoles: ['Mediator'] },
], dominantReactions: ['Reaction'], stabilizers: ['Stabilizer'], invalidators: ['Invalidator'] }];
const completed = { found: true, runId: '1791113000000-original', schemaVersion: 'v1', theaterCount: 1, generatedAt: 1791113000000,
  note: '', error: '', theaterSummariesJson: JSON.stringify(theaters), processing: false, eligibleTheaterCount: 1, failedTheaterCount: 0,
  allTheatersFailed: false, completionStatus: 'completed' };

async function fixture(t, source = completed) {
  const oldFetch = globalThis.fetch;
  const oldEnv = { ...process.env };
  t.after(() => { globalThis.fetch = oldFetch; for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key]; Object.assign(process.env, oldEnv); });
  process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
  process.env.MCP_TELEMETRY = 'false';
  process.env.UPSTASH_REDIS_REST_URL = 'https://theaters-fixture.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  const requests = [];
  let current = source;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'theaters-fixture.test') {
      if (!parsed.pathname.startsWith('/get/')) return Response.json({ result: [9999, 10000] });
      const key = decodeURIComponent(parsed.pathname.slice(5));
      assert.ok(['forecast:predictions:v2', 'seed-meta:forecast:predictions'].includes(key), key);
      return Response.json({ result: JSON.stringify(key.startsWith('seed-meta:') ? { fetchedAt: Date.now() } : { generatedAt: 1791113000010, predictions: [] }) });
    }
    assert.equal(parsed.origin, 'https://api.worldmonitor.app');
    assert.equal(parsed.pathname, '/api/forecast/v1/get-simulation-outcome');
    assert.equal(parsed.search, '');
    assert.equal(init.method, 'GET');
    assert.ok(init.headers['X-WM-MCP-Internal']);
    requests.push({ url, init });
    return Response.json(current);
  };
  const { deps, pipe } = makeProDeps();
  const invoke = async (name, args = {}) => (await (await mcpHandler(proReq('POST', callBody(name, args)), deps)).json());
  const opening = await invoke('get_forecast_predictions');
  const token = opening.result.structuredContent.panelRequest.token;
  return { invoke, token, pipe, requests, setSource: value => { current = value; } };
}

describe('original forecast theater signed transport', () => {
  it('returns the complete latest original response and replays without another daily allocation or read', async t => {
    const f = await fixture(t);
    const reply = await f.invoke('get_forecast_theaters', { panel_request: f.token });
    assert.ok(reply.result, JSON.stringify(reply));
    assert.deepEqual(reply.result.structuredContent.data.forecastTheaters, { ...completed, status: 'ready' });
    assert.equal(f.requests.length, 1);
    assert.equal(f.pipe.count, 1);
    const reads = f.pipe.ops.flat().filter(c => c[0] === 'EVAL' && c[2] === 2).length;
    const replay = await f.invoke('get_forecast_theaters', { panel_request: f.token });
    assert.deepEqual(replay.result.structuredContent, reply.result.structuredContent);
    assert.equal(f.requests.length, 1);
    assert.equal(f.pipe.ops.flat().filter(c => c[0] === 'EVAL' && c[2] === 2).length, reads);
  });
  it('fails closed before fetching for missing or widened scope and tampered receipts', async t => {
    const f = await fixture(t);
    for (const args of [{}, { panel_request: f.token, run_id: completed.runId }, { panel_request: f.token, summary: true },
      { panel_request: f.token, jmespath: '*' }, { panel_request: f.token.slice(0, -1) + 'z' }]) {
      const reply = await f.invoke('get_forecast_theaters', args);
      assert.equal(reply.error?.code, -32602, JSON.stringify(reply));
    }
    assert.equal(f.requests.length, 0);
    assert.equal(f.pipe.count, 1);
  });
  it('keeps partial and legacy completion retryable without discarding original evidence', async t => {
    const partial = { ...completed, eligibleTheaterCount: 2, failedTheaterCount: 1, completionStatus: 'partial' };
    const f = await fixture(t, partial);
    const first = await f.invoke('get_forecast_theaters', { panel_request: f.token });
    assert.deepEqual(first.result.structuredContent.data.forecastTheaters, { ...partial, status: 'partial' });
    f.setSource({ ...completed, completionStatus: '' });
    assert.equal((await f.invoke('get_forecast_theaters', { panel_request: f.token })).result.structuredContent.data.forecastTheaters.status, 'unknown');
    f.setSource(completed);
    assert.equal((await f.invoke('get_forecast_theaters', { panel_request: f.token })).result.structuredContent.data.forecastTheaters.status, 'ready');
    assert.equal(f.requests.length, 3);
    assert.equal(f.pipe.count, 1);
  });
  it('rejects malformed nested evidence and inconsistent counts without caching or slicing', async t => {
    const f = await fixture(t);
    for (const bad of [{ ...completed, theaterCount: 2 }, { ...completed, failedTheaterCount: 1 }, { ...completed, completionStatus: '', allTheatersFailed: true },
      { ...completed, theaterSummariesJson: JSON.stringify([{ ...theaters[0], topPaths: Array(4).fill(theaters[0].topPaths[0]) }]) },
      { ...completed, theaterSummariesJson: JSON.stringify([{ ...theaters[0], invalidators: ['valid', 1] }]) }]) {
      f.setSource(bad);
      const reply = await f.invoke('get_forecast_theaters', { panel_request: f.token });
      assert.equal(reply.result.structuredContent.data.forecastTheaters.status, 'unavailable');
    }
    f.setSource(completed);
    assert.equal((await f.invoke('get_forecast_theaters', { panel_request: f.token })).result.structuredContent.data.forecastTheaters.status, 'ready');
    assert.equal(f.requests.length, 6);
  });
  it('shares the original 64 uncached-read limit with the opening and does not fetch after exhaustion', async t => {
    const f = await fixture(t, { ...completed, completionStatus: '' });
    const readsKey = [...f.pipe.store.keys()].find(k => k.endsWith(':reads'));
    f.pipe.store.set(readsKey, 63);
    assert.equal((await f.invoke('get_forecast_theaters', { panel_request: f.token })).result.structuredContent.data.forecastTheaters.status, 'unknown');
    assert.equal((await f.invoke('get_forecast_theaters', { panel_request: f.token })).error.code, -32029);
    assert.equal(f.requests.length, 1);
    assert.equal(f.pipe.count, 1);
  });
  it('distinguishes real empty, failed, missing and source error outcomes and permits manual recovery', async t => {
    const f = await fixture(t);
    const empty = { ...completed, theaterCount: 0, theaterSummariesJson: '', eligibleTheaterCount: 0, completionStatus: 'no_eligible_theaters' };
    const missing = { ...empty, found: false, runId: '', generatedAt: 0, completionStatus: '' };
    for (const [source, status] of [[{ ...empty, eligibleTheaterCount: 2, failedTheaterCount: 2, allTheatersFailed: true, completionStatus: 'all_theaters_failed' }, 'failed'],
      [missing, 'missing'], [{ ...missing, error: 'redis_unavailable' }, 'unavailable'], [{ ...missing, processing: true }, 'processing'], [empty, 'empty']]) {
      f.setSource(source);
      assert.deepEqual((await f.invoke('get_forecast_theaters', { panel_request: f.token })).result.structuredContent.data.forecastTheaters, { ...source, status });
    }
    assert.equal(f.requests.length, 5);
    assert.equal((await f.invoke('get_forecast_theaters', { panel_request: f.token })).result.structuredContent.data.forecastTheaters.status, 'empty');
    assert.equal(f.requests.length, 5, 'only explicit known empty coverage can replay');
    assert.equal(f.pipe.count, 1);
  });
  it('rejects over-budget and private payloads, then recovers without clipping original evidence', async t => {
    const f = await fixture(t, { ...completed, note: 'x'.repeat(140000) });
    assert.equal((await f.invoke('get_forecast_theaters', { panel_request: f.token })).result.structuredContent.data.forecastTheaters.error, 'theater_response_too_large');
    f.setSource({ ...completed, outcomeKey: 'private-artifact' });
    assert.equal((await f.invoke('get_forecast_theaters', { panel_request: f.token })).result.structuredContent.data.forecastTheaters.error, 'invalid_theater_response');
    f.setSource(completed);
    assert.deepEqual((await f.invoke('get_forecast_theaters', { panel_request: f.token })).result.structuredContent.data.forecastTheaters, { ...completed, status: 'ready' });
    assert.equal(f.requests.length, 3);
  });
  it('advertises a subscription reader with no run selector, UI opening or producer API', () => {
    const tool = TOOL_REGISTRY.find(tool => tool.name === 'get_forecast_theaters');
    assert.equal(toolAccess(tool), 'subscription');
    assert.deepEqual(tool.inputSchema.required, ['panel_request']);
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ['panel_request']);
    assert.deepEqual(tool._apiPaths, ['GET /api/forecast/v1/get-simulation-outcome']);
    assert.equal(tool._uiResourceUri, undefined);
  });
});
