import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';
import { compactForecastDashboardPayload } from '../scripts/_forecast-dashboard.mjs';

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
  it('returns exactly one unchanged original case and rejects a different generation', () => {
    assert.ok(detail, 'original ID-selected reader must be registered');
    const args = { forecast_id: 'case-19', generated_at: String(generation), panel_request: 'signed-test-receipt' };
    const result = detail._postFilter(structuredClone({ predictions: full }), args);
    assert.deepEqual(Object.keys(result), ['forecastCase']);
    assert.equal(result.forecastCase.status, 'ready');
    assert.deepEqual(result.forecastCase.forecast, full.predictions[19]);
    assert.ok(Buffer.byteLength(JSON.stringify({ data: result })) < detail._outputBudgetBytes);
    const changed = detail._postFilter({ predictions: { ...full, generatedAt: generation + 1 } }, args);
    assert.equal(changed.forecastCase.status, 'generation_changed');
    assert.equal(changed.forecastCase.forecast, null);
  });
  it('distinguishes missing cases and unavailable source without returning the feed', () => {
    assert.ok(detail);
    const args = { forecast_id: 'absent', generated_at: String(generation), panel_request: 'signed-test-receipt' };
    assert.deepEqual(detail._postFilter({ predictions: full }, args).forecastCase, { status: 'missing', generatedAt: generation, forecast: null });
    assert.equal(detail._postFilter({ predictions: null }, args).forecastCase.status, 'unavailable');
    assert.equal(detail._postFilter({ predictions: { generatedAt: generation, predictions: null } }, args).forecastCase.status, 'unavailable');
    for (const bad of [{ ...args, forecast_id: '' }, { ...args, generated_at: '' }, { ...args, panel_request: '' }]) assert.throws(() => detail._postFilter({ predictions: full }, bad));
  });
});
