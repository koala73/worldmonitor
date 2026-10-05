import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { HMAC_SECRET, makeProDeps, proReq, callBody } from './helpers/mcp-pro-deps.mjs';
import { admitNewsPanel, admitCountryPanel, authorizePanelRead } from '../api/mcp/panel-requests.ts';
import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';
import { CHOKEPOINT_THREAT_LEVELS } from '../shared/chokepoint-threat-levels.js';
import { EIA_OIL_TRANSIT_CHOKEPOINTS } from '../scripts/chokepoint-eia-baselines.mjs';
import { PORTWATCH_CONTENT_FRESHNESS_ACTIVATION_KEY } from '../api/_content-freshness.js';
import { executeChokepointPanelRead } from '../api/mcp/dispatch.ts';
import { dailyCounterKey } from '../server/_shared/pro-mcp-token.ts';

const originalFetch = globalThis.fetch, OriginalDate = Date, originalEnv = { ...process.env };
const context = { kind: 'pro', userId: 'user_pro_xyz', mcpTokenId: 'k57mcptokenid' };
const budget = { allowance: 'mcp', limit: 50 }, start = Date.UTC(2026, 9, 5, 10, 1, 0, 250);
const tool = TOOL_REGISTRY.find(tool => tool.name === 'get_chokepoint_status');
const keys = [...tool._cacheKeys, ...tool._freshnessChecks.map(check => check.key)];
const labels = ['transit-summaries', 'chokepoint_transits', '_countries', 'chokepoint-baselines', 'ref', 'chokepoint-flows'];
const transitNames = ['Strait of Hormuz', 'Suez Canal', 'Malacca Strait', 'Bab el-Mandeb Strait', 'Panama Canal', 'Taiwan Strait', 'South China Sea', 'Black Sea', 'Cape of Good Hope', 'Gibraltar Strait', 'Bosporus Strait', 'Korea Strait', 'Dover Strait', 'Kerch Strait', 'Lombok Strait'];

describe('Chokepoint closed paid admission', () => {
  let handler, now, sources, commands, activation, advanceOnSource;
  const payload = () => {
    const data = {
      [keys[0]]: { fetchedAt: now, summaries: Object.fromEntries(Object.keys(CHOKEPOINT_THREAT_LEVELS).map(id => [id, { todayTotal: 12, todayTanker: 4, todayCargo: 6, todayOther: 2, wowChangePct: 3, dataAvailable: true, riskLevel: 'normal', riskSummary: 'UNVERIFIED', riskReportAction: 'UNVERIFIED' }])) },
      [keys[1]]: { fetchedAt: now, transits: Object.fromEntries(transitNames.map(name => [name, { total: 12, tanker: 4, cargo: 6, other: 2, available: true }])) },
      [keys[2]]: ['CN', 'HK', ...Array.from({ length: 26 * 26 }, (_, i) => String.fromCharCode(65 + Math.floor(i / 26), 65 + i % 26)).filter(id => !['CN', 'HK'].includes(id)).slice(0, 172)],
      [keys[3]]: { source: 'EIA World Oil Transit Chokepoints', referenceYear: 2023, updatedAt: new Date(now).toISOString(), chokepoints: structuredClone(EIA_OIL_TRANSIT_CHOKEPOINTS) },
      [keys[4]]: Object.fromEntries(Array.from({ length: 28 }, (_, i) => [`cp-${i}`, { portId: `cp-${i}`, portName: `Reference ${i}`, fullName: `Reference ${i}`, lat: 20, lon: 30, vesselCountTanker: 12, shareMaritimeImport: .2, shareMaritimeExport: .1, industries: ['energy'] }])),
      [keys[5]]: Object.fromEntries(EIA_OIL_TRANSIT_CHOKEPOINTS.map(row => [row.relayId, { currentMbd: row.mbd, baselineMbd: row.mbd, flowRatio: 1, disrupted: false, source: 'portwatch-counts', hazardAlertLevel: null, hazardAlertName: null }])),
    };
    for (const [index, count] of [13, 15, 174, 7, 28, 7].entries()) data[keys[index + 6]] = { fetchedAt: now, recordCount: count };
    data[keys[8]].contentFreshness = { budgetMinutes: 14400, assessedAt: now, coveredCount: 174, freshCount: 174, staleCount: 0, unknownCount: 0, criticalCountries: ['CN', 'HK'], criticalFreshCount: 2, criticalStaleCountries: [], criticalMissingCountries: 0, criticalOldestObservedAt: now - 60000 };
    return data;
  };
  const invoke = async (bundle, args = {}, name = 'get_chokepoint_status') => {
    const response = await handler(proReq('POST', callBody(name, args)), bundle.deps);
    return { response, body: await response.json() };
  };
  const value = result => result.body.result?.structuredContent.projection ?? result.body.result?.structuredContent;
  const cache = bundle => [...bundle.pipe.store].filter(([key]) => key.includes(':data:'));
  beforeEach(async () => {
    now = start; commands = []; activation = 1; advanceOnSource = null;
    globalThis.Date = class extends OriginalDate { constructor(...args) { if (args.length) super(...args); else super(now); } static now() { return now; } };
    Object.assign(process.env, { MCP_INTERNAL_HMAC_SECRET: HMAC_SECRET, MCP_TELEMETRY: 'false', USAGE_TELEMETRY: 'false', UPSTASH_REDIS_REST_URL: 'https://chokepoint-admission-fixture.invalid', UPSTASH_REDIS_REST_TOKEN: 'fixture-no-credential' });
    sources = payload();
    globalThis.fetch = async (url, options) => {
      const address = new URL(String(url)); assert.equal(address.origin, 'https://chokepoint-admission-fixture.invalid');
      if (address.pathname === '/pipeline') {
        const rows = JSON.parse(options.body); assert.deepEqual(rows, [['EXISTS', PORTWATCH_CONTENT_FRESHNESS_ACTIVATION_KEY]]); commands.push(...rows);
        return Response.json(activation === null ? [{ error: 'fixture unavailable' }] : [{ result: activation }]);
      }
      const key = decodeURIComponent(address.pathname.slice(5)); assert.ok(keys.includes(key), key); commands.push(['GET', key]);
      if (advanceOnSource) { now = advanceOnSource; advanceOnSource = null; }
      const result = sources[key]; if (result instanceof Error) throw result;
      return Response.json({ result: result == null ? null : JSON.stringify(result) });
    };
    handler = (await import('../api/mcp.ts')).mcpHandler;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch; globalThis.Date = OriginalDate;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });
  it('opens once and reuses normalized effective subset without more fixed source commands', async () => {
    const bundle = makeProDeps(); const first = await invoke(bundle, { dataset: ['REF', 'chokepoint-baselines', 'bad'], limit: 1 });
    await invoke(bundle, { dataset: ['chokepoint-baselines', 'ref'], limit: 0 });
    assert.equal(bundle.pipe.count, 1); assert.equal(commands.length, 13);
    assert.equal(value(first).panelRequest.panel, 'chokepoints'); assert.equal(first.body.result._meta['worldmonitor/usage'].remaining, 49);
    const full = value(await invoke(bundle, { dataset: ['ref', 'chokepoint-baselines'], limit: 0, jmespath: '@' })); assert.equal(full.data['chokepoint-baselines'].chokepoints.length, 7);
    assert.equal(commands.length, 13);
    await invoke(bundle, { dataset: 'ref', summary: true }); assert.equal(bundle.pipe.count, 1); assert.equal(commands.length, 26, 'changed subset may acquire all13 commands');
    const original = JSON.parse(cache(bundle)[0][1]); assert.equal(original.value.data._countries.length, 174);
  });
  it('retains full-first filters, limit0, canonical map fallback and prose suppression', async () => {
    const bundle = makeProDeps(); const first = value(await invoke(bundle, { chokepoint: 'HORMUZ', dataset: ['transit-summaries', 'chokepoint-flows'], limit: 1 }));
    assert.deepEqual(Object.keys(first.data['transit-summaries'].summaries), ['hormuz_strait']);
    assert.equal(first.data['transit-summaries'].summaries.hormuz_strait.riskSummary, '');
    assert.equal(first.data['transit-summaries'].summaries.hormuz_strait.riskReportAction, '');
    assert.equal(value(await invoke(bundle, { chokepoint: 'hormuz', dataset: ['chokepoint-flows', 'transit-summaries'], jmespath: '@' })).data['transit-summaries'].summaries.hormuz_strait.riskSummary, '');
    assert.equal(commands.length, 13);
    const fallback = value(await invoke(bundle, { chokepoint: 'absent', dataset: ['transit-summaries', 'chokepoint-baselines'], limit: 0 }));
    assert.equal(Object.keys(fallback.data['transit-summaries'].summaries).length, 13); assert.deepEqual(fallback.data['chokepoint-baselines'].chokepoints, []);
    const all = value(await invoke(bundle, { dataset: ['bad'], limit: 0 })); assert.deepEqual(Object.keys(all.data), labels); assert.equal(all.data._countries.length, 174);
  });
  it('isolates healthy static subset from sparse AIS and refuses vacuous unknown-only completeness', async () => {
    const bundle = makeProDeps(); sources[keys[0]].summaries.suez.dataAvailable = false; sources[keys[0]].summaries.suez.todayTotal = null; sources[keys[6]].recordCount = 12;
    sources[keys[1]].transits['Suez Canal'].available = false;
    await invoke(bundle, { dataset: ['chokepoint-baselines'] }); await invoke(bundle, { dataset: ['chokepoint-baselines'] }); assert.equal(commands.length, 13);
    const partial = value(await invoke(bundle, { dataset: ['transit-summaries'] })); assert.equal(partial.data['transit-summaries'].summaries.suez.todayTotal, null);
    await invoke(bundle, { dataset: ['transit-summaries'] }); assert.equal(commands.length, 39); assert.equal(cache(bundle).length, 1);
    await invoke(bundle, { dataset: ['bad'] }); await invoke(bundle, { dataset: ['bad'] }); assert.equal(commands.length, 65); assert.equal(bundle.pipe.count, 1);
    sources = payload(); await invoke(bundle, { dataset: ['transit-summaries'] }); await invoke(bundle, { dataset: ['transit-summaries'] }); assert.equal(commands.length, 78);
  });
  it('uses each source own selected rows and preserves legitimate partial flow/unknown source', async () => {
    const bundle = makeProDeps(); sources[keys[5]] = Object.fromEntries(Object.entries(sources[keys[5]]).slice(0, 3)); sources[keys[11]].recordCount = 3;
    await invoke(bundle, { dataset: ['chokepoint-flows'], chokepoint: 'hormuz' }); await invoke(bundle, { dataset: ['chokepoint-flows'], chokepoint: 'HORMUZ' }); assert.equal(commands.length, 13);
    const missing = value(await invoke(bundle, { dataset: ['chokepoint-flows'], chokepoint: 'lombok' })); assert.equal(Object.keys(missing.data['chokepoint-flows']).length, 3);
    await invoke(bundle, { dataset: ['chokepoint-flows'], chokepoint: 'lombok' }); assert.equal(commands.length, 39);
    sources[keys[5]].hormuz_strait.source = 'undeclared';
    const unknown = value(await invoke(bundle, { dataset: ['chokepoint-flows'], chokepoint: 'hormuz', refresh: true, request_id: '550e8400-e29b-41d4-a716-446655440000' })); assert.equal(unknown.data['chokepoint-flows'].hormuz_strait.source, 'FLOW_SOURCE_UNSPECIFIED');
    assert.equal(bundle.pipe.count, 2);
  });
  it('opens one UUID refresh and closes owner/tool/family/expiry controls', async () => {
    const bundle = makeProDeps(); const token = value(await invoke(bundle, { dataset: ['ref'] })).panelRequest.token;
    const request_id = '550E8400-E29B-41D4-A716-446655440000'; const fresh = value(await invoke(bundle, { refresh: true, request_id, dataset: ['ref'] })).panelRequest;
    assert.equal(value(await invoke(bundle, { refresh: true, request_id: request_id.toLowerCase(), dataset: ['ref'] })).panelRequest.token, fresh.token); assert.equal(bundle.pipe.count, 2); assert.equal(commands.length, 26);
    const news = await admitNewsPanel(context, budget, bundle.pipe.pipeline, {}), country = await admitCountryPanel(context, budget, bundle.pipe.pipeline, { country_code: 'US' });
    for (const receipt of ['forged', news.token, country.token]) assert.equal((await invoke(bundle, { panel_request: receipt })).body.error.code, -32602);
    await assert.rejects(authorizePanelRead({ ...context, userId: 'other' }, bundle.pipe.pipeline, 'get_chokepoint_status', {}, token));
    await assert.rejects(authorizePanelRead(context, bundle.pipe.pipeline, 'get_news_intelligence', {}, token));
    assert.equal((await invoke(bundle, { panel_request: token, source: 'portwatch-counts' })).body.error.code, -32602);
    assert.equal((await invoke(bundle, { panel_request: token, refresh: true, request_id })).body.error.code, -32602);
    now = Date.parse(fresh.expiresAt); assert.equal((await invoke(bundle, { panel_request: fresh.token })).body.error.code, -32602); assert.equal(commands.length, 26);
  });
  for (const [label, dataset, mutate, flag] of [
    ['missing selected summary', 'transit-summaries', () => { sources[keys[0]] = null; }, 'freshnessUnknown'],
    ['old summary publication', 'transit-summaries', () => { sources[keys[0]].fetchedAt -= 1800000; }, 'stale'],
    ['future summary publication', 'transit-summaries', () => { sources[keys[0]].fetchedAt += 1; }, 'freshnessUnknown'],
    ['raw source error', 'ref', () => { sources[keys[4]] = { _seed: { state: 'ERROR', fetchedAt: now }, data: sources[keys[4]] }; }, 'stale'],
    ['old raw publication', 'ref', () => { sources[keys[4]] = { _seed: { state: 'OK', fetchedAt: now - 14 * 86400000 }, data: sources[keys[4]] }; }, 'stale'],
    ['failed selected metadata', 'ref', () => { sources[keys[10]].sourceState = 'degraded'; }, 'stale'],
    ['metadata error status', 'ref', () => { sources[keys[10]].status = 'error'; }, 'stale'],
    ['raw publication unassessed', 'ref', () => { sources[keys[4]] = { _seed: { state: 'OK', fetchedAt: now + 1 }, data: sources[keys[4]] }; }, 'freshnessUnknown'],
    ['raw coverage contradiction', 'ref', () => { sources[keys[4]] = { _seed: { state: 'OK', fetchedAt: now, recordCount: 0 }, data: sources[keys[4]] }; }, 'freshnessUnknown'],
    ['unknown selected metadata', 'ref', () => { sources[keys[10]] = null; }, 'freshnessUnknown'],
    ['future selected metadata', 'ref', () => { sources[keys[10]].fetchedAt += 1; }, 'freshnessUnknown'],
    ['malformed references', 'ref', () => { sources[keys[4]]['cp-0'] = null; }, null],
    ['empty no-match baseline', 'chokepoint-baselines', () => { sources[keys[3]].chokepoints = []; }, null],
    ['unassessed content', '_countries', () => { delete sources[keys[8]].contentFreshness; }, 'freshnessUnknown'],
    ['content inclusive age boundary', '_countries', () => { sources[keys[8]].contentFreshness.criticalOldestObservedAt = now - 10 * 86400000; }, 'stale'],
    ['unknown activation', '_countries', () => { activation = null; }, 'activationUnknown'],
    ['incomplete index', '_countries', () => { sources[keys[2]].pop(); }, null],
  ]) it(`keeps ${label} retryable under one allocation`, async () => {
    const bundle = makeProDeps(); mutate(); const initial = await invoke(bundle, { dataset: [dataset] }); assert.equal(initial.body.error, undefined); if (flag) assert.equal(value(initial)[flag], true);
    assert.equal(cache(bundle).length, 0); sources = payload(); activation = 1; await invoke(bundle, { dataset: [dataset] }); await invoke(bundle, { dataset: [dataset] }); assert.equal(commands.length, 26); assert.equal(bundle.pipe.count, 1);
  });
  it('validates untruncated countries before default view cap and ages cached content after lookup', async () => {
    const bundle = makeProDeps(); sources[keys[8]].contentFreshness.criticalOldestObservedAt = now - 10 * 86400000 + 1500;
    assert.equal(value(await invoke(bundle, { dataset: ['_countries'] })).data._countries.length, 30);
    assert.equal(value(await invoke(bundle, { dataset: '_countries', limit: 0 })).data._countries.length, 174); assert.equal(commands.length, 13);
    assert.equal(JSON.parse(cache(bundle)[0][1]).reuseUntil, start + 1500);
    now += 1500; sources = payload(); await invoke(bundle, { dataset: ['_countries'] }); assert.equal(commands.length, 26); assert.equal(bundle.pipe.count, 1);
    const short = makeProDeps(); sources = payload(); sources[keys[10]].fetchedAt = now - 14 * 86400000 + 999; await invoke(short, { dataset: ['ref'] }); assert.equal(cache(short).length, 0);
    const elapsed = makeProDeps(); sources = payload(); sources[keys[10]].fetchedAt = now - 14 * 86400000 + 500; advanceOnSource = now + 501; await invoke(elapsed, { dataset: ['ref'] }); assert.equal(cache(elapsed).length, 0);
  });
  it('bounds actual uncached executions, retains rights/revocation and fails quota closed', async () => {
    const bundle = makeProDeps(); sources[keys[4]]['cp-0'] = null;
    const token = value(await invoke(bundle, { dataset: ['ref'] })).panelRequest.token;
    for (let i = 1; i < 64; i++) assert.equal((await invoke(bundle, { panel_request: token, dataset: ['ref'] })).body.error, undefined);
    assert.equal((await invoke(bundle, { panel_request: token, dataset: ['ref'] })).response.status, 429);
    assert.equal(commands.length, 64 * 13); assert.equal(bundle.pipe.count, 1);
    bundle.deps.getEntitlements = async () => ({ features: { tier: 1, mcpAccess: false } }); assert.equal((await invoke(bundle, { panel_request: token })).response.status, 403);
    bundle.deps.validateProMcpToken = async () => null; assert.equal((await invoke(bundle, { panel_request: token })).response.status, 401);
    assert.equal((await invoke(makeProDeps({ pipelineOpts: { initialCount: 50 } }))).response.status, 429);
    assert.equal((await invoke(makeProDeps({ pipelineOpts: { throwOnEval: true } }))).response.status, 503);
    assert.equal(commands.length, 64 * 13);
  });
  it('rejects expired and malformed wrappers after lookup and checks SET deadline again', async () => {
    const bundle = makeProDeps(); await invoke(bundle, { dataset: ['ref'] }); const [key, raw] = cache(bundle)[0];
    for (const invalid of ['not-json', JSON.stringify({ ...JSON.parse(raw), extra: true }), JSON.stringify({ ...JSON.parse(raw), reuseUntil: now })]) {
      bundle.pipe.store.set(key, invalid); await invoke(bundle, { dataset: ['ref'] });
    }
    assert.equal(commands.length, 52); assert.equal(bundle.pipe.count, 1);
    const deadline = makeProDeps(); sources = payload(); sources[keys[10]].fetchedAt = now - 14 * 86400000 + 1500;
    const first = value(await invoke(deadline, { dataset: ['ref'] })); const reader = await authorizePanelRead(context, deadline.pipe.pipeline, 'get_chokepoint_status', { dataset: ['ref'] }, first.panelRequest.token);
    const read = await executeChokepointPanelRead({ dataset: ['ref'] }); deadline.pipe.store.delete(cache(deadline)[0][0]);
    now += 1500; await reader.saveChokepoints(read); assert.equal(cache(deadline).length, 0);

  });
  it('preserves both output and wrapped cache budgets without extra allocations', async () => {
    const bundle = makeProDeps(); sources[keys[4]]['cp-0'].description = '界'.repeat(180000);
    const projected = await invoke(bundle, { dataset: ['ref'], jmespath: 'data.ref.*.portName' }); assert.equal(projected.body.error, undefined); assert.equal(cache(bundle).length, 0);
    await invoke(bundle, { dataset: ['ref'], jmespath: 'data.ref.*.portName' }); assert.equal(commands.length, 26); assert.equal(bundle.pipe.count, 1);
    sources = payload(); sources[keys[4]]['cp-0'].description = '界'.repeat(50000);
    const oversized = await invoke(bundle, { dataset: ['ref'] }); assert.equal(value(oversized)._budget_exceeded, true); assert.equal(value(oversized).budget_bytes, 131072); assert.equal(bundle.pipe.count, 1);
  });
  it('retains healthy and partial API/free complete JSON', async () => {
    const rows = [];
    for (const plan of ['api', 'free']) for (const partial of [false, true]) {
      sources = payload(); if (partial) { sources[keys[0]].summaries.suez.dataAvailable = false; sources[keys[0]].summaries.suez.todayTotal = null; sources[keys[6]].recordCount = 12; sources[keys[5]] = Object.fromEntries(Object.entries(sources[keys[5]]).slice(0, 3)); sources[keys[11]].recordCount = 3; }
      const getEntitlements = async () => plan === 'api' ? { planKey: 'api-starter', features: { tier: 1, mcpAccess: true, apiAccess: true, planLimits: { apiCallsPerDay: 1000, mcpCallsPerDay: 'shared-api-budget' } }, validUntil: now + 86400000 } : { planKey: 'free', features: { tier: 0, mcpAccess: false }, validUntil: now + 86400000 };
      const bundle = makeProDeps({ getEntitlements });
      for (const args of [{}, { chokepoint: 'hormuz', dataset: ['transit-summaries', 'chokepoint-flows'], limit: 0 }, { summary: true, jmespath: '@' }]) rows.push({ plan, partial, args, body: (await invoke(bundle, args)).body });
      assert.equal(bundle.pipe.count, 3);

    }
    assert.equal(JSON.stringify(rows), readFileSync(new URL('./fixtures/mcp-chokepoint-api-free-parent.json', import.meta.url), 'utf8'));
  });
  it('denies API/free paid controls before source reads or reservation', async () => {
    for (const plan of ['api', 'free']) {
      const getEntitlements = async () => plan === 'api' ? { planKey: 'api-starter', features: { tier: 1, mcpAccess: true, apiAccess: true, planLimits: { apiCallsPerDay: 1000, mcpCallsPerDay: 'shared-api-budget' } }, validUntil: now + 86400000 } : { planKey: 'free', features: { tier: 0, mcpAccess: false }, validUntil: now + 86400000 };
      const bundle = makeProDeps({ getEntitlements });
      for (const args of [{ refresh: true, request_id: '550e8400-e29b-41d4-a716-446655440000' }, { request_id: '550e8400-e29b-41d4-a716-446655440000' }, { panel_request: 'forged' }]) assert.equal((await invoke(bundle, args)).body.error.code, -32602);
      assert.equal(bundle.pipe.count, 0); assert.equal(commands.length, 0);
    }
  });
  it('reads current receipt usage without allocating and omits unknown counter', async () => {
    const bundle = makeProDeps(); const token = value(await invoke(bundle, { dataset: ['ref'] })).panelRequest.token;
    const key = dailyCounterKey(context.userId, new Date(now)), pipeline = bundle.deps.redisPipeline; let counter = '2', reads = 0;
    bundle.deps.redisPipeline = async (rows, ...options) => { if (rows.length === 1 && rows[0][0] === 'GET' && rows[0][1] === key) { reads++; return [{ result: counter }]; } return pipeline(rows, ...options); };
    assert.equal((await invoke(bundle, { panel_request: token, dataset: ['ref'] })).body.result._meta['worldmonitor/usage'].remaining, 48); counter = null;
    assert.equal((await invoke(bundle, { panel_request: token, dataset: ['ref'] })).body.result._meta?.['worldmonitor/usage'], undefined); await invoke(bundle, { panel_request: 'forged' }); assert.equal(reads, 2); assert.equal(commands.length, 13); assert.equal(bundle.pipe.count, 1);
  });
});
