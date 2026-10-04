import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { HMAC_SECRET, makeProDeps, proReq, callBody } from './helpers/mcp-pro-deps.mjs';
import { admitNewsPanel, admitCountryPanel, authorizePanelRead } from '../api/mcp/panel-requests.ts';
import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';
import { dailyCounterKey } from '../server/_shared/pro-mcp-token.ts';
import { INTEL_TOPIC_IDS } from '../shared/intelligence-snapshots.js';
import { writeFileSync, readFileSync } from 'node:fs';

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const OriginalDate = Date;
const originalEnv = { ...process.env };
const context = { kind: 'pro', userId: 'user_pro_xyz', mcpTokenId: 'k57mcptokenid' };
const budget = { allowance: 'mcp', limit: 50 };
const start = Date.UTC(2026, 9, 5, 10, 1, 0, 250);
const keys = ['news:insights:v1', 'intelligence:gdelt-intel:v1', 'intelligence:cross-source-signals:v1', 'intelligence:advisories-bootstrap:v1', 'seed-meta:news:insights', 'seed-meta:intelligence:gdelt-intel', 'seed-meta:intelligence:cross-source-signals'];

describe('News Intelligence closed paid admission', () => {
  let handler, now, sources, fetched, advanceOnSource;
  const payload = () => ({
    [keys[0]]: { status: 'ok', generatedAt: new Date(now).toISOString(), topStories: [
      { primaryTitle: 'US trade talks', primarySource: 'Reuters', countryCode: 'US', category: 'economy', isAlert: true, effectiveImportanceScore: 88 },
      { primaryTitle: 'Japan cyber update', primarySource: 'AP', countryCode: 'JP', category: 'cyber', isAlert: false, effectiveImportanceScore: 70 },
    ] },
    [keys[1]]: { topics: INTEL_TOPIC_IDS.map(id => ({ id, articles: [{ title: `${id} report`, url: 'https://example.com/report', source: 'fixture', date: new Date(now).toISOString(), image: '', language: 'en', tone: 0 }], fetchedAt: new Date(now).toISOString() })) },
    [keys[2]]: { signals: [], evaluatedAt: now, compositeCount: 0 },
    [keys[3]]: { fetchedAt: new Date(now).toISOString(), byCountry: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`C${i}`, 'info'])), advisories: [{ title: 'Travel advice', link: 'https://example.com/advisory', source: 'fixture', sourceCountry: 'US', country: 'US', pubDate: new Date(now).toISOString(), level: 'info' }] },
    [keys[4]]: { fetchedAt: now, recordCount: 2 },
    [keys[5]]: { fetchedAt: now, recordCount: 6, maxContentAgeMin: 45, newestItemAt: now, oldestItemAt: now },
    [keys[6]]: { fetchedAt: now, recordCount: 0 },
  });
  const invoke = async (bundle, args = {}, name = 'get_news_intelligence') => {
    const response = await handler(proReq('POST', callBody(name, args)), bundle.deps);
    return { response, body: await response.json() };
  };
  const value = result => result.body.result.structuredContent.projection ?? result.body.result.structuredContent;
  const cache = bundle => [...bundle.pipe.store].filter(([key]) => key.includes(':data:'));
  beforeEach(async () => {
    now = start;
    globalThis.Date = class extends OriginalDate {
      constructor(...args) { if (args.length) super(...args); else super(now); }
      static now() { return now; }
    }; fetched = []; advanceOnSource = null;
    Object.assign(process.env, { MCP_INTERNAL_HMAC_SECRET: HMAC_SECRET, MCP_TELEMETRY: 'false', USAGE_TELEMETRY: 'false', UPSTASH_REDIS_REST_URL: 'https://intelligence-fixture.invalid', UPSTASH_REDIS_REST_TOKEN: 'fixture-no-credential' });
    sources = payload();
    globalThis.fetch = async url => {
      const address = new URL(String(url)); assert.equal(address.origin, 'https://intelligence-fixture.invalid');
      const key = decodeURIComponent(address.pathname.slice(5)); assert.ok(keys.includes(key), key); fetched.push(key);
      if (advanceOnSource) { now = advanceOnSource; advanceOnSource = null; }
      const result = sources[key]; if (result instanceof Error) throw result;
      return Response.json({ result: result == null ? null : JSON.stringify(result) });
    };
    handler = (await import('../api/mcp.ts')).mcpHandler;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch; globalThis.Date = OriginalDate; Date.now = originalNow;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });
  it('opens once and filters canonical originals without seven more source reads', async () => {
    const bundle = makeProDeps(); const first = await invoke(bundle); await invoke(bundle);
    assert.equal(bundle.pipe.count, 1, 'one allocation for opening/repeat'); assert.equal(fetched.length, 7);
    const receipt = value(first).panelRequest; assert.equal(receipt.panel, 'news-intelligence');
    assert.equal(first.body.result._meta['worldmonitor/usage'].remaining, 49);
    for (const [args, titles] of [[{ country: 'USA' }, ['US trade talks']], [{ category: 'CYBER' }, ['Japan cyber update']], [{ query: 'trade', min_importance: '80', alerts_only: 'true', limit: 0 }, ['US trade talks']], [{ limit: 1.9 }, ['US trade talks']]]) {
      assert.deepEqual(value(await invoke(bundle, args)).data.insights.topStories.map(row => row.primaryTitle), titles);
    }
    assert.equal(value(await invoke(bundle, { summary: true })).data.insights.topStories.count, 2);
    assert.equal(value(await invoke(bundle, { jmespath: '@' })).data.insights.topStories.length, 2);
    assert.equal(value(await invoke(bundle, { summary: true, jmespath: '@' })).data.insights.topStories.count, 2);
    assert.equal(fetched.length, 7); assert.equal(bundle.pipe.count, 1);
    const original = JSON.parse(cache(bundle)[0][1]); assert.equal(original.value.data.insights.topStories.length, 2); assert.equal(typeof original.reuseUntil, 'number');
  });
  it('opens one UUID refresh and uses a closed owner-bound receipt', async () => {
    const bundle = makeProDeps(); const receipt = value(await invoke(bundle)).panelRequest;
    const request_id = '550E8400-E29B-41D4-A716-446655440000';
    const fresh = value(await invoke(bundle, { refresh: true, request_id })).panelRequest;
    assert.equal(value(await invoke(bundle, { refresh: true, request_id: request_id.toLowerCase() })).panelRequest.token, fresh.token);
    assert.equal(bundle.pipe.count, 2); assert.equal(fetched.length, 14);
    assert.equal((await invoke(bundle, { panel_request: fresh.token, refresh: true, request_id })).body.error.code, -32602);
    const news = await admitNewsPanel(context, budget, bundle.pipe.pipeline, {});
    const country = await admitCountryPanel(context, budget, bundle.pipe.pipeline, { country_code: 'US' });
    for (const token of ['forged', news.token, country.token]) assert.equal((await invoke(bundle, { panel_request: token })).body.error.code, -32602);
    await assert.rejects(authorizePanelRead({ ...context, userId: 'other' }, bundle.pipe.pipeline, 'get_news_intelligence', {}, receipt.token));
    await assert.rejects(authorizePanelRead(context, bundle.pipe.pipeline, 'open_news_dashboard', {}, receipt.token));
    now = Date.parse(receipt.expiresAt); assert.equal((await invoke(bundle, { panel_request: receipt.token })).body.error.code, -32602);
    assert.equal(fetched.length, 14);
  });
  for (const [label, mutate] of [
    ['missing Insights', () => { sources[keys[0]] = null; }],
    ['old Insights generation', () => { sources[keys[0]].generatedAt = new Date(now - 3_600_000).toISOString(); }],
    ['future Insights generation', () => { sources[keys[0]].generatedAt = new Date(now + 1).toISOString(); }],
    ['degraded Insights', () => { sources[keys[0]].status = 'degraded'; }],
    ['empty Insights', () => { sources[keys[0]].topStories = []; }],
    ['missing cross-source evaluation', () => { delete sources[keys[2]].evaluatedAt; }],
    ['old cross-source evaluation', () => { sources[keys[2]].evaluatedAt -= 3_600_000; }],
    ['contradictory metadata count', () => { sources[keys[4]].recordCount = 0; }],
    ['source error object', () => { sources[keys[0]].error = { reason: 'unavailable' }; }],
    ['malformed signal', () => { sources[keys[2]].signals = [null]; }],
    ['missing GDELT topic', () => { sources[keys[1]].topics.pop(); }],
    ['old content', () => { sources[keys[5]].newestItemAt -= 7_200_000; }],
    ['unassessed content', () => { delete sources[keys[5]].maxContentAgeMin; }],
    ['future metadata', () => { sources[keys[4]].fetchedAt += 1; }],
    ['metadata failure', () => { sources[keys[4]] = new Error('fixture'); }],
    ['malformed advisories', () => { sources[keys[3]].advisories = [null]; }],
    ['empty advisory bootstrap', () => { sources[keys[3]].advisories = []; sources[keys[3]].byCountry = {}; }],
    ['advisory unavailable', () => { sources[keys[3]].dataAvailable = false; }],
  ]) it(`keeps ${label} retryable without a second opening`, async () => {
    const bundle = makeProDeps(); mutate(); const initial = await invoke(bundle); assert.equal(initial.body.error, undefined);
    assert.equal(cache(bundle).length, 0); sources = payload(); await invoke(bundle); await invoke(bundle);
    assert.equal(fetched.length, 14); assert.equal(bundle.pipe.count, 1);
  });
  it('uses each source deadline and rejects expiry after Redis lookup and before cache SET', async () => {
    const bundle = makeProDeps(); sources[keys[4]].fetchedAt = now - 1_800_000 + 1500;
    await invoke(bundle); const entry = JSON.parse(cache(bundle)[0][1]); assert.equal(entry.reuseUntil, start + 1500);
    now += 1500; sources = payload(); await invoke(bundle); assert.equal(fetched.length, 14); assert.equal(bundle.pipe.count, 1);
    const short = makeProDeps(); sources = payload(); sources[keys[4]].fetchedAt = now - 1_800_000 + 999;
    await invoke(short); assert.equal(cache(short).length, 0);
    const elapsed = makeProDeps(); sources = payload(); sources[keys[4]].fetchedAt = now - 1_800_000 + 500;
    advanceOnSource = now + 501; await invoke(elapsed); assert.equal(cache(elapsed).length, 0);
  });
  it('retains ordinary API/free complete JSON', async () => {
    const rows = [];
    for (const plan of ['api', 'free']) {
      const getEntitlements = async () => plan === 'api'
        ? { planKey: 'api-starter', features: { tier: 1, mcpAccess: true, apiAccess: true, planLimits: { apiCallsPerDay: 1000, mcpCallsPerDay: 'shared-api-budget' } }, validUntil: now + 86400000 }
        : { planKey: 'free', features: { tier: 0, mcpAccess: false }, validUntil: now + 86400000 };
      const bundle = makeProDeps({ getEntitlements });
      for (const args of [{}, { country: 'US', min_importance: '80', alerts_only: 'true', limit: 0 }, { summary: true, jmespath: '@' }]) rows.push({ plan, args, body: (await invoke(bundle, args)).body });
      assert.equal(bundle.pipe.count, 3);
    }
    if (process.env.NEWS_INTELLIGENCE_CAPTURE) writeFileSync(process.env.NEWS_INTELLIGENCE_CAPTURE, JSON.stringify(rows));
    if (process.env.NEWS_INTELLIGENCE_COMPARE) assert.equal(JSON.stringify(rows), readFileSync(process.env.NEWS_INTELLIGENCE_COMPARE, 'utf8'));
  });
  it('rejects API/free refresh and receipt controls before reservation', async () => {
    for (const plan of ['api', 'free']) {
      const getEntitlements = async () => plan === 'api'
        ? { planKey: 'api-starter', features: { tier: 1, mcpAccess: true, apiAccess: true, planLimits: { apiCallsPerDay: 1000, mcpCallsPerDay: 'shared-api-budget' } }, validUntil: now + 86400000 }
        : { planKey: 'free', features: { tier: 0, mcpAccess: false }, validUntil: now + 86400000 };
      const bundle = makeProDeps({ getEntitlements });
      for (const args of [{ refresh: true, request_id: '550e8400-e29b-41d4-a716-446655440000' }, { request_id: '550e8400-e29b-41d4-a716-446655440000' }, { panel_request: 'forged' }]) assert.equal((await invoke(bundle, args)).body.error.code, -32602);
      assert.equal(bundle.pipe.count, 0); assert.equal(fetched.length, 0);
    }
  });
  it('reports current independently read usage only after receipt authorization', async () => {
    const bundle = makeProDeps(); const token = value(await invoke(bundle)).panelRequest.token;
    const key = dailyCounterKey(context.userId, new Date(now)); const pipeline = bundle.deps.redisPipeline;
    let counter = '2'; let reads = 0;
    bundle.deps.redisPipeline = async (commands, ...options) => {
      if (commands.length === 1 && commands[0][0] === 'GET' && commands[0][1] === key) { reads++; return [{ result: counter }]; }
      return pipeline(commands, ...options);
    };
    assert.equal((await invoke(bundle, { panel_request: token })).body.result._meta['worldmonitor/usage'].remaining, 48);
    counter = null;
    assert.equal((await invoke(bundle, { panel_request: token })).body.result._meta?.['worldmonitor/usage'], undefined);
    await invoke(bundle, { panel_request: 'forged' }); assert.equal(reads, 2); assert.equal(fetched.length, 7); assert.equal(bundle.pipe.count, 1);
  });
  it('retains rights, revocation, quota and the 64 uncached execution limit', async () => {
    const bundle = makeProDeps(); sources[keys[0]].status = 'degraded';
    const token = value(await invoke(bundle)).panelRequest.token;
    for (let i = 1; i < 64; i++) assert.equal((await invoke(bundle, { panel_request: token })).body.error, undefined);
    assert.equal((await invoke(bundle, { panel_request: token })).response.status, 429);
    assert.equal(fetched.length, 64 * 7); assert.equal(bundle.pipe.count, 1);
    bundle.deps.getEntitlements = async () => ({ features: { tier: 1, mcpAccess: false } });
    assert.equal((await invoke(bundle, { panel_request: token })).response.status, 403);
    bundle.deps.validateProMcpToken = async () => null;
    assert.equal((await invoke(bundle, { panel_request: token })).response.status, 401);
    assert.equal((await invoke(makeProDeps({ pipelineOpts: { initialCount: 50 } }))).response.status, 429);
    assert.equal((await invoke(makeProDeps({ pipelineOpts: { throwOnEval: true } }))).response.status, 503);
    assert.equal(fetched.length, 64 * 7);
  });
  it('validates source envelopes, cache wrappers and the wrapped 512KiB boundary', async () => {
    const bundle = makeProDeps(); const opened = value(await invoke(bundle)); const token = opened.panelRequest.token;
    const reader = await authorizePanelRead(context, bundle.pipe.pipeline, 'get_news_intelligence', {}, token);
    const [key, raw] = cache(bundle)[0]; const original = JSON.parse(raw);
    for (const invalid of ['invalid json', JSON.stringify({ ...original, reuseUntil: now }), JSON.stringify({ ...original, extra: true }), JSON.stringify({ ...original, value: { ...original.value, data: { ...original.value.data, insights: null } } })]) {
      bundle.pipe.store.set(key, invalid); await invoke(bundle, { panel_request: token });
    }
    assert.equal(fetched.length, 35); assert.equal(bundle.pipe.count, 1);
    bundle.pipe.store.delete(key);
    const { panelRequest: _receipt, ...originalValue } = opened;
    originalValue.padding = 'x'.repeat(524288 - Buffer.byteLength(JSON.stringify(originalValue)));
    await reader.saveNewsIntelligence({ value: originalValue, reuseUntil: now + 10_000 }); assert.equal(cache(bundle).length, 0);
    originalValue.padding = originalValue.padding.slice(0, -100);
    await reader.saveNewsIntelligence({ value: originalValue, reuseUntil: now + 10_000 }); assert.equal(cache(bundle).length, 1);
    assert.ok(Buffer.byteLength(cache(bundle)[0][1]) <= 524288);
    bundle.pipe.store.delete(key); sources[keys[0]] = { _seed: { fetchedAt: now - 1_800_000, state: 'OK' }, data: sources[keys[0]] };
    await invoke(bundle, { panel_request: token }); assert.equal(cache(bundle).length, 0);
  });
  it('does not reuse a wrapper whose deadline passed during the two-key lookup', async () => {
    const bundle = makeProDeps(); sources[keys[4]].fetchedAt = now - 1_800_000 + 1500;
    const token = value(await invoke(bundle)).panelRequest.token; const pipeline = bundle.deps.redisPipeline;
    sources = payload();
    bundle.deps.redisPipeline = async (commands, ...options) => {
      const result = await pipeline(commands, ...options);
      if (commands.length === 2 && commands.every(command => command[0] === 'GET')) now += 1500;
      return result;
    };
    await invoke(bundle, { panel_request: token }); assert.equal(fetched.length, 14); assert.equal(bundle.pipe.count, 1);
  });
  for (const [index, age] of [[4, 30], [5, 45], [6, 60]]) it(`bounds reuse by metadata source ${index}`, async () => {
    const bundle = makeProDeps(); sources[keys[index]].fetchedAt = now - age * 60_000 + 2000;
    await invoke(bundle); assert.equal(JSON.parse(cache(bundle)[0][1]).reuseUntil, now + 2000);
  });
  it('bounds reuse by actual GDELT content and shared Insights generation', async () => {
    for (const source of ['content', 'generation']) {
      const bundle = makeProDeps(); sources = payload();
      if (source === 'content') sources[keys[5]].newestItemAt = now - 45.5 * 60_000 + 2000;
      else sources[keys[0]].generatedAt = new Date(now - 3_600_000 + 2000).toISOString();
      await invoke(bundle); assert.equal(JSON.parse(cache(bundle)[0][1]).reuseUntil, now + 2000);
    }
  });

  it('preserves ordinary and deferred presentation pristine fallback on an unexpected filter failure', async () => {
    const tool = TOOL_REGISTRY.find(tool => tool.name === 'get_news_intelligence');
    const original = tool._postFilter;
    try {
      tool._postFilter = data => { data.insights.topStories.pop(); throw new Error('controlled filter failure'); };
      const paid = makeProDeps(); const first = await invoke(paid);
      assert.equal(value(first).data.insights.topStories.length, 2);
      assert.equal(value(await invoke(paid, { category: 'cyber' })).data.insights.topStories.length, 2);
      const api = makeProDeps({ getEntitlements: async () => ({ planKey: 'api-starter', features: { tier: 1, mcpAccess: true, apiAccess: true, planLimits: { apiCallsPerDay: 1000, mcpCallsPerDay: 'shared-api-budget' } }, validUntil: now + 86400000 }) });
      assert.equal(value(await invoke(api)).data.insights.topStories.length, 2);
      assert.equal(fetched.length, 14); assert.equal(paid.pipe.count, 1);
    } finally { tool._postFilter = original; }
  });

  it('retains the public 128KiB output budget without another admission on retry', async () => {
    const bundle = makeProDeps(); sources[keys[0]].padding = 'x'.repeat(140000);
    const first = await invoke(bundle); assert.equal(first.body.result.structuredContent._budget_exceeded, true); assert.equal(first.body.result.structuredContent.budget_bytes, 131072);
    await invoke(bundle); assert.equal(bundle.pipe.count, 1); assert.equal(fetched.length, 7);
  });

  for (const [age, stale] of [[3_599_999, false], [3_600_000, true], [3_600_001, true]]) it(`discloses cross-source evaluation age ${age} and recovers the same admission`, async () => {
    const bundle = makeProDeps(); sources[keys[2]].evaluatedAt = now - age;
    const first = value(await invoke(bundle));
    assert.equal(first.stale, stale, 'paid source evaluation age must match the existing 60-minute reuse deadline');
    assert.equal(first.freshnessUnknown, undefined, 'a known evaluation age is not unknown');
    assert.equal(cache(bundle).length, 0, 'expired or subsecond originals are not saved');
    sources = payload();
    const recovered = value(await invoke(bundle));
    assert.equal(recovered.stale, false); assert.equal(recovered.freshnessUnknown, undefined);
    assert.equal(cache(bundle).length, 1); await invoke(bundle);
    assert.equal(fetched.length, 14); assert.equal(bundle.pipe.count, 1);
    for (const plan of ['api', 'free']) {
      sources[keys[2]].evaluatedAt = now - 3_600_001;
      const getEntitlements = async () => plan === 'api'
        ? { planKey: 'api-starter', features: { tier: 1, mcpAccess: true, apiAccess: true, planLimits: { apiCallsPerDay: 1000, mcpCallsPerDay: 'shared-api-budget' } }, validUntil: now + 86400000 }
        : { planKey: 'free', features: { tier: 0, mcpAccess: false }, validUntil: now + 86400000 };
      const ordinary = makeProDeps({ getEntitlements }); const result = value(await invoke(ordinary));
      assert.equal(result.stale, false); assert.equal(result.freshnessUnknown, undefined); assert.equal(ordinary.pipe.count, 1);
    }
  });

  for (const [age, stale] of [[1_799_999, false], [1_800_000, true], [1_800_001, true]]) it(`discloses original seed publication age ${age} and recovers`, async () => {
    const bundle = makeProDeps(); sources[keys[0]] = { _seed: { fetchedAt: now - age, state: 'OK' }, data: sources[keys[0]] };
    const first = value(await invoke(bundle)); assert.equal(first.stale, stale); assert.equal(first.freshnessUnknown, undefined);
    assert.equal(cache(bundle).length, 0);
    sources = payload(); const recovered = value(await invoke(bundle));
    assert.equal(recovered.stale, false); assert.equal(recovered.freshnessUnknown, undefined); await invoke(bundle);
    assert.equal(cache(bundle).length, 1); assert.equal(fetched.length, 14); assert.equal(bundle.pipe.count, 1);
  });
  for (const [seed, stale, unknown] of [
    [{ fetchedAt: start, state: 'ERROR', failedDatasets: ['cyber'], errorReason: 'gdelt_429' }, true, undefined],
    [{ fetchedAt: start, state: 'UNKNOWN_STATE' }, false, true],
    [{ fetchedAt: start + 1, state: 'OK' }, false, true],
  ]) it(`discloses seed evidence ${seed.state}/${seed.fetchedAt} without leaking private metadata`, async () => {
    const bundle = makeProDeps(); sources[keys[1]] = { _seed: seed, data: sources[keys[1]] };
    const first = value(await invoke(bundle)); assert.equal(first.stale, stale); assert.equal(first.freshnessUnknown, unknown);
    assert.equal(first.data['gdelt-intel']._seed, undefined); assert.equal(cache(bundle).length, 0);
    sources = payload(); const recovered = value(await invoke(bundle));
    assert.equal(recovered.stale, false); assert.equal(recovered.freshnessUnknown, undefined); await invoke(bundle);
    assert.equal(cache(bundle).length, 1); assert.equal(fetched.length, 14); assert.equal(bundle.pipe.count, 1);
  });

  for (const [label, failure] of [['sourceState', { sourceState: 'degraded' }], ['failedSources', { failedSources: ['fixture-provider'] }]]) it(`discloses failed metadata ${label} and recovers`, async () => {
    const bundle = makeProDeps(); Object.assign(sources[keys[4]], failure);
    const first = value(await invoke(bundle)); assert.equal(first.stale, true); assert.equal(first.freshnessUnknown, undefined);
    assert.equal(cache(bundle).length, 0); assert.equal(first.data.insights.sourceState, undefined);
    sources = payload(); const recovered = value(await invoke(bundle));
    assert.equal(recovered.stale, false); assert.equal(recovered.freshnessUnknown, undefined); await invoke(bundle);
    assert.equal(cache(bundle).length, 1); assert.equal(fetched.length, 14); assert.equal(bundle.pipe.count, 1);
  });

  it('marks stale Insights generation and unassessed GDELT clocks explicitly, then recovers the same admission', async () => {
    for (const source of ['Insights', 'GDELT']) {
      const bundle = makeProDeps(); sources = payload();
      if (source === 'Insights') sources[keys[0]].generatedAt = new Date(now - 3_600_000).toISOString();
      else delete sources[keys[5]].maxContentAgeMin;
      const initial = value(await invoke(bundle));
      if (source === 'Insights') assert.equal(initial.stale, true, 'fresh metadata cannot hide proven stale generation');
      else assert.equal(initial.freshnessUnknown, true, 'absent content assessment cannot report assessed fresh');
      assert.equal(cache(bundle).length, 0); sources = payload();
      const recovered = value(await invoke(bundle)); assert.equal(recovered.stale, false); assert.equal(recovered.freshnessUnknown, undefined);
      await invoke(bundle); assert.equal(fetched.length, source === 'Insights' ? 14 : 28); assert.equal(bundle.pipe.count, 1);
    }
  });

});
