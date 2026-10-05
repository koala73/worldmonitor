import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_REGISTRY, toolAccess } from '../api/mcp/registry/index.ts';
import { compactForecastDashboardPayload } from '../scripts/_forecast-dashboard.mjs';
import { HMAC_SECRET, callBody, makeProDeps, proReq } from './helpers/mcp-pro-deps.mjs';

const opening = TOOL_REGISTRY.find(tool => tool.name === 'get_forecast_predictions');
const detail = TOOL_REGISTRY.find(tool => tool.name === 'get_forecast_case');
const generation = 1791113000000;
const full = { generatedAt: generation, predictions: Array.from({ length: 20 }, (_, i) => ({
  id: `case-${i}`, title: `Controlled forecast ${i}`, domain: 'energy', region: 'Europe', probability: i === 0 ? null : 0.4,
  scenario: 'Original executive view', signals: [{ value: 'Original signal' }],
  caseFile: { baseCase: `${i}:` + 'Original original evidence. '.repeat(450), supportingEvidence: [{ summary: 'Original observation', weight: 0.8 }] },
})) };
const paid = { inboundHostClass: 'apex', downstreamOrigin: 'https://worldmonitor.app', downstreamOriginTag: 'test', panelScope: 'forecasts' };

describe('bounded forecast list and original case transport', () => {
  it('preserves the website compact list and every case identity inside the opening budget', () => {
    assert.ok(Buffer.byteLength(JSON.stringify({ data: { predictions: full } })) > opening._outputBudgetBytes, 'controlled full dossiers exceed the existing response budget');
    const input = structuredClone({ predictions: full });
    const result = opening._postFilter(input, {}, paid);
    assert.deepEqual(result.predictions, compactForecastDashboardPayload(full));
    assert.ok(Buffer.byteLength(JSON.stringify({ data: result })) < opening._outputBudgetBytes);
    assert.equal(result.predictions.predictions.length, 20);
    assert.equal(result.predictions.predictions[0].probability, null);
    assert.deepEqual(full.predictions[0].caseFile.supportingEvidence, [{ summary: 'Original observation', weight: 0.8 }]);
  });
  it('keeps original complete dossier contracts for ordinary API callers', () => {
    const result = opening._postFilter(structuredClone({ predictions: full }), {});
    assert.deepEqual(result.predictions, full);
  });
  it('preserves bounded source notices through paid compact openings and signed replay', async t => {
    const originalFetch = globalThis.fetch;
    const originalEnv = { ...process.env };
    t.after(() => {
      globalThis.fetch = originalFetch;
      for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
      Object.assign(process.env, originalEnv);
    });
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
    process.env.UPSTASH_REDIS_REST_URL = 'https://forecast-notices-fixture.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'controlled-fixture-token';
    const source = { ...full, degraded: true, stale: true, error: 'upstream_unavailable', internalTrace: 'unused'.repeat(30000) };
    globalThis.fetch = async url => {
      const parsed = new URL(url);
      assert.equal(parsed.hostname, 'forecast-notices-fixture.test');
      if (!parsed.pathname.startsWith('/get/')) return Response.json({ result: [9999, 10000] });
      const key = decodeURIComponent(parsed.pathname.slice('/get/'.length));
      assert.ok(['forecast:predictions:v2', 'seed-meta:forecast:predictions'].includes(key), key);
      return Response.json({ result: JSON.stringify(key === 'forecast:predictions:v2' ? source : { fetchedAt: Date.now() }) });
    };
    const { mcpHandler } = await import('../api/mcp.ts');
    const { deps, pipe } = makeProDeps();
    const invoke = async args => {
      const response = await mcpHandler(proReq('POST', callBody('get_forecast_predictions', args)), deps);
      return (await response.json()).result;
    };
    const result = await invoke({});
    const node = result.structuredContent.data.predictions;
    assert.equal(result.structuredContent.panelRequest.panel, 'forecasts');
    assert.equal(result.structuredContent.stale, false);
    assert.equal(node.degraded, true);
    assert.equal(node.stale, true);
    assert.equal(node.error, source.error);
    assert.equal('internalTrace' in node, false);
    assert.ok(node.predictions.every(row => row.hasCaseFile && !('caseFile' in row)));
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= opening._outputBudgetBytes);
    const replay = await invoke({ panel_request: result.structuredContent.panelRequest.token });
    assert.deepEqual(replay.structuredContent.data.predictions, node);
    assert.equal(pipe.count, 1);
    const oversized = opening._postFilter({ predictions: { ...source, error: 'x'.repeat(150000) } }, {}, paid);
    assert.equal(oversized.predictions.error, 'x'.repeat(1200));
    assert.ok(Buffer.byteLength(JSON.stringify({ data: oversized })) < opening._outputBudgetBytes);
  });
  it('advertises the original-case reader as subscription-only', () => {
    assert.equal(toolAccess(detail), 'subscription');
  });
  it('returns exactly one unchanged original case and rejects a different generation', () => {
    assert.ok(detail, 'original ID-selected reader must be registered');
    const args = { forecast_id: 'case-19', generated_at: String(generation) };
    const result = detail._postFilter(structuredClone({ predictions: full }), args, paid);
    assert.deepEqual(Object.keys(result), ['forecastCase']);
    assert.equal(result.forecastCase.status, 'ready');
    assert.deepEqual(result.forecastCase.forecast, full.predictions[19]);
    assert.ok(Buffer.byteLength(JSON.stringify({ data: result })) < detail._outputBudgetBytes);
    const changed = detail._postFilter({ predictions: { ...full, generatedAt: generation + 1 } }, args, paid);
    assert.equal(changed.forecastCase.status, 'generation_changed');
    assert.equal(changed.forecastCase.forecast, null);
  });
  it('distinguishes missing cases and unavailable source without returning the feed', () => {
    assert.ok(detail);
    assert.throws(() => detail._postFilter({ predictions: full }, { forecast_id: 'case-19', generated_at: String(generation) }));
    const args = { forecast_id: 'absent', generated_at: String(generation) };
    assert.deepEqual(detail._postFilter({ predictions: full }, args, paid).forecastCase, { status: 'missing', generatedAt: generation, forecast: null });
    assert.equal(detail._postFilter({ predictions: null }, args, paid).forecastCase.status, 'unavailable');
    assert.equal(detail._postFilter({ predictions: { generatedAt: generation, predictions: null } }, args, paid).forecastCase.status, 'unavailable');
    for (const bad of [{ ...args, forecast_id: '' }, { ...args, generated_at: '' }, { ...args, arbitrary: true }]) assert.throws(() => detail._postFilter({ predictions: full }, bad, paid));
  });
});
