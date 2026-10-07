import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_ROLLING_WINDOW_DAYS } from '../scripts/_forecast-scorecard.mjs';
import { TOOL_REGISTRY, toolAccess } from '../api/mcp/registry/index.ts';
import { forecastReliability, forecastScorecardDescription } from '../api/mcp/registry/cache-tools.ts';
import { FORECAST_ACCURACY_AUDIT } from '../shared/forecast-accuracy-audit.js';
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

describe('published forecast reliability transport', () => {
  const row = (domain = 'energy', changes = {}) => ({ domain, count: 45, brier: 0.213, yesCount: 18, ...changes });
  // Pins the lifted state (#8990); the suite below pins what the tool serves while the audit switch is set.
  const project = (scorecard, predictions = full) => {
    const data = { predictions: structuredClone(predictions), scorecard, scorecardMeta: { fetchedAt: Date.now() } };
    const loaded = opening._postFilter(data, {}, paid).predictions.predictions.map(prediction => prediction.domain);
    return forecastReliability(data, loaded, null);
  };
  it('matches the website and producer window fallback for missing or invalid windows', () => {
    const website = readFileSync(new URL('../src/components/forecast-record.ts', import.meta.url), 'utf8');
    const websiteWindowDays = Number(website.match(/const DEFAULT_WINDOW_DAYS = (\d+);/)?.[1]);
    assert.equal(websiteWindowDays, DEFAULT_ROLLING_WINDOW_DAYS);
    for (const rollingWindowDays of [undefined, null, 0, -1, NaN, Infinity, '90']) {
      assert.equal(project({ schemaVersion: 2, publishedByDomain: [row()], rollingWindowDays }).windowDays, websiteWindowDays);
    }
    assert.equal(project({ schemaVersion: 2, publishedByDomain: [row()], rollingWindowDays: 90 }).windowDays, 90);
  });
  it('projects only loaded published domains with the website sample and base-rate rules', () => {
    const scorecard = { schemaVersion: 2, rollingWindowDays: 90, publishedByDomain: [row(), row('conflict'), row('bet_engine')], byDomain: [row('energy', { brier: 0.001 })], receipts: ['private'], skill: 0.99 };
    const reliability = project(scorecard);
    assert.deepEqual(reliability?.byDomain, [{ domain: 'energy', kind: 'measured', n: 45, brier: 0.213, yesShare: 0.4 }], 'loaded energy must carry its published reliability, never pooled/headline values');
    assert.equal(reliability.status, 'ready'); assert.equal(reliability.windowDays, 90);
    const many = { ...full, predictions: Array.from({ length: 50 }, (unusedValue, domainIndex) => ({ ...full.predictions[0], domain: 'domain-' + domainIndex })) };
    assert.equal(project({ ...scorecard, publishedByDomain: many.predictions.map(prediction => row(prediction.domain)) }, many).byDomain.length, 30, 'public reliability is bounded to the loaded thirty domains');
    for (const changes of [{ count: 29 }, { yesCount: 15.5 }, { yesCount: -1 }, { yesCount: 46 }, { brier: null }]) assert.equal(project({ ...scorecard, publishedByDomain: [row('energy', changes)] }).byDomain[0].kind, 'unmeasured');
    assert.equal(project({ ...scorecard, publishedByDomain: [row('energy', { count: 45.5 })] }).byDomain[0].kind, 'measured');
    assert.equal(project({ ...scorecard, publishedByDomain: [row(), row('energy', { brier: 0.3 })] }).byDomain[0].brier, 0.3);
    assert.deepEqual(project({ ...scorecard, publishedByDomain: [] }).byDomain, [{ domain: 'energy', kind: 'unmeasured', n: 0 }]);
    assert.equal(project(scorecard, { ...full, predictions: [{ ...full.predictions[0], domain: 'bet_engine' }] }).byDomain.length, 0);
  });
  it('validates raw health and schema before public field selection', () => {
    const good = { schemaVersion: 2, publishedByDomain: [row()] };
    for (const value of [null, {}, { ...good, schemaVersion: 1 }, { ...good, degraded: true }, { ...good, error: 'source_failure' }, { ...good, publishedByDomain: null }]) assert.equal(project(value)?.status, 'unavailable', 'unhealthy optional reliability must be explicit and non-null');
  });
});

describe('published forecast reliability under the accuracy audit (#8990)', () => {
  // A fixture, not the live switch, so lifting the switch keeps this branch tested for the next audit.
  const AUDIT = Object.freeze({ since: '2026-10-07', issue: 8990, reason: 'Fixture reason.' });
  const scorecard = { schemaVersion: 2, rollingWindowDays: 90, publishedByDomain: [{ domain: 'energy', count: 205, brier: 0.074, yesCount: 9 }] };
  const served = (card) => forecastReliability({ scorecard: card, scorecardMeta: { fetchedAt: Date.now() } }, ['energy'], AUDIT);
  it('serves no domain score, says why, and keeps the freshness clock', () => {
    const reliability = served(scorecard);
    assert.equal(reliability.status, 'unavailable');
    assert.deepEqual(reliability.byDomain, []);
    assert.deepEqual(reliability.underAudit, { since: '2026-10-07', issue: 8990, reason: 'Fixture reason.' });
    assert.equal(reliability.windowDays, 90);
    assert.equal(reliability.stale, false);
    assert.doesNotMatch(JSON.stringify(reliability), /0\.074|brier/i);
  });
  it('still says why when the scorecard itself is unhealthy', () => {
    assert.deepEqual(served(null).underAudit?.issue, 8990);
    assert.deepEqual(served({ ...scorecard, degraded: true }).underAudit?.issue, 8990);
  });
  it('declares underAudit in the reliability output schema', () => {
    const reliability = opening.outputSchema.properties.data.properties.reliability;
    assert.deepEqual(reliability.properties.underAudit.type, 'object');
    assert.deepEqual(Object.keys(reliability.properties.underAudit.properties).sort(), ['issue', 'reason', 'since']);
  });
  it('serves through the live switch', () => {
    const data = { predictions: structuredClone(full), scorecard, scorecardMeta: { fetchedAt: Date.now() } };
    const viaTool = opening._postFilter(structuredClone(data), {}, paid).reliability;
    const direct = forecastReliability(data, ['energy'], FORECAST_ACCURACY_AUDIT);
    assert.deepEqual({ ...viaTool, capturedAt: null }, { ...direct, capturedAt: null });
  });
  it('leads the scorecard tool description with the notice, inside the tools/list sentence budget', async () => {
    const { compressDescription, TOOL_DESCRIPTION_MAX_BYTES } = await import('../api/mcp.ts');
    const listed = compressDescription(forecastScorecardDescription(AUDIT), TOOL_DESCRIPTION_MAX_BYTES);
    assert.equal(listed, 'Under audit since 2026-10-07 (issue 8990): scores are unreliable and withdrawn while corrections are made.');
    assert.doesNotMatch(forecastScorecardDescription(null), /Under audit/);
    const scorecardTool = TOOL_REGISTRY.find(tool => tool.name === 'get_forecast_scorecard');
    assert.equal(scorecardTool.description, forecastScorecardDescription(FORECAST_ACCURACY_AUDIT));
  });
});
