import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { HMAC_SECRET, makeProDeps, proReq, callBody } from './helpers/mcp-pro-deps.mjs';
import { admitNewsPanel, authorizePanelRead } from '../api/mcp/panel-requests.ts';
import { dailyCounterKey } from '../server/_shared/pro-mcp-token.ts';

const originalFetch = globalThis.fetch, OriginalDate = Date, originalEnv = { ...process.env };
const context = { kind: 'pro', userId: 'user_pro_xyz', mcpTokenId: 'k57mcptokenid' };
const start = Date.UTC(2026, 9, 5, 10, 1, 0, 250), budget = { allowance: 'mcp', limit: 50 };

describe('World Brief closed paid admission', () => {
  let handler, now, seed, calls, status, advance;
  const payload = () => ({
    worldBrief: 'First claim [1]. Second claim [2].', generatedAt: new Date(now - 60000).toISOString(), status: 'ok', briefProvider: '', briefModel: '',
    topStories: [{ primaryTitle: 'First headline', primarySource: 'Reuters', primaryLink: 'https://example.com/first', sourceCount: -1.5, uniqueSourceCount: 2.5, corroborationSourceCount: -2, sourceTier: 1.5, sources: ['Reuters', 'AP'] }],
    worldBriefSources: [{ title: 'First source', source: 'Reuters', url: '' }, { title: 'Second source', source: 'AP', url: 'https://example.com/second' }],
  });
  const invoke = async (bundle, args = {}, name = 'get_world_brief') => {
    const response = await handler(proReq('POST', callBody(name, args)), bundle.deps);
    return { response, body: await response.json() };
  };
  const value = result => result.body.result?.structuredContent.projection ?? result.body.result?.structuredContent;
  const cache = bundle => [...bundle.pipe.store].filter(([key]) => key.includes(':data:'));
  beforeEach(async () => {
    now = start; calls = []; status = 200; advance = null;
    globalThis.Date = class extends OriginalDate { constructor(...args) { if (args.length) super(...args); else super(now); } static now() { return now; } };
    Object.assign(process.env, { MCP_INTERNAL_HMAC_SECRET: HMAC_SECRET, MCP_TELEMETRY: 'false', USAGE_TELEMETRY: 'false' });
    delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
    seed = payload();
    globalThis.fetch = async (input, options) => {
      const url = new URL(String(input)); assert.equal(url.origin, 'https://api.worldmonitor.app');
      assert.equal(url.pathname, '/api/infrastructure/v1/get-bootstrap-data'); assert.equal(url.search, '?keys=insights');
      assert.ok(options.headers['User-Agent']); assert.ok(options.signal); calls.push({ url: url.href, method: options.method ?? 'GET' });
      if (advance !== null) { now = advance; advance = null; }
      return Response.json({ data: { insights: JSON.stringify(seed) }, missing: [] }, { status });
    };
    handler = (await import('../api/mcp.ts')).mcpHandler;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch; globalThis.Date = OriginalDate;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });
  it('opens once and reuses ignored global context and projection with the bare original intact', async () => {
    const bundle = makeProDeps(); const first = value(await invoke(bundle));
    const repeat = value(await invoke(bundle, { geo_context: 'different region' }));
    for (const summary of [true, false]) assert.equal(value(await invoke(bundle, { summary })).brief, seed.worldBrief);
    const projected = value(await invoke(bundle, { jmespath: 'headlines' }));
    assert.equal(bundle.pipe.count, 1); assert.equal(calls.length, 1); assert.deepEqual(projected, first.headlines);
    assert.equal(first.panelRequest.panel, 'world-brief'); assert.equal(repeat.brief, seed.worldBrief);
    assert.equal(first.sources.length, 2); assert.equal(first.headlines.length, 1); assert.equal(first.sources[0].url, '');
    assert.equal(first.topStories[0].sourceCount, -1.5); assert.equal(first.topStories[0].corroborationSourceCount, -2);
    const original = JSON.parse(cache(bundle)[0][1]).value;
    assert.equal(original.panelRequest, undefined); assert.equal(original.usage, undefined); assert.equal(original.provider, '');
  });
  it('refreshes once per normalized UUID and isolates signed tool, owner, expiry and selector scopes', async () => {
    const bundle = makeProDeps(), token = value(await invoke(bundle)).panelRequest.token;
    const request_id = '550E8400-E29B-41D4-A716-446655440000';
    const refreshed = value(await invoke(bundle, { refresh: true, request_id })).panelRequest;
    assert.equal(value(await invoke(bundle, { refresh: true, request_id: request_id.toLowerCase() })).panelRequest.token, refreshed.token);
    assert.equal(bundle.pipe.count, 2); assert.equal(calls.length, 2);
    const news = await admitNewsPanel(context, budget, bundle.pipe.pipeline, {});
    for (const args of [{ panel_request: 'forged' }, { panel_request: news.token }, { panel_request: token, refresh: true, request_id }, { panel_request: token, source: 'private' }, { refresh: true }, { geo_context: 5 }]) assert.equal((await invoke(bundle, args)).body.error.code, -32602);
    await assert.rejects(authorizePanelRead({ ...context, userId: 'other' }, bundle.pipe.pipeline, 'get_world_brief', {}, token));
    await assert.rejects(authorizePanelRead(context, bundle.pipe.pipeline, 'get_news_intelligence', {}, token));
    now = Date.parse(refreshed.expiresAt); assert.equal((await invoke(bundle, { panel_request: refreshed.token })).body.error.code, -32602);
    assert.equal(calls.length, 2);
  });
  for (const [label, mutate] of [
    ['stale last-known-good', () => { seed.generatedAt = new Date(now - 90 * 60000).toISOString(); }],
    ['exact fresh deadline', () => { seed.generatedAt = new Date(now - 60 * 60000).toISOString(); }],
    ['future source', () => { seed.generatedAt = new Date(now + 1).toISOString(); }],
    ['invalid source clock', () => { seed.generatedAt = 'bad'; }],
    ['missing source clock', () => { delete seed.generatedAt; }],
    ['three-hour source', () => { seed.generatedAt = new Date(now - 180 * 60000).toISOString(); }],
    ['failed producer', () => { seed.status = 'error'; }],
    ['gateway failure', () => { status = 503; }],
  ]) it(`retries ${label} and recovers without another allocation`, async () => {
    const bundle = makeProDeps(); mutate(); await invoke(bundle); assert.equal(cache(bundle).length, 0);
    seed = payload(); status = 200; await invoke(bundle); await invoke(bundle);
    assert.equal(bundle.pipe.count, 1); assert.equal(calls.length, 2);
  });
  it('serves stale originals unchanged through just below three hours without retaining them', async () => {
    const bundle = makeProDeps(); seed.generatedAt = new Date(now - 180 * 60000 + 1).toISOString();
    const stale = value(await invoke(bundle)); assert.equal(stale.stale, true); assert.equal(stale.brief, seed.worldBrief);
    await invoke(bundle); assert.equal(calls.length, 2); assert.equal(bundle.pipe.count, 1); assert.equal(cache(bundle).length, 0);
  });
  it('updates rounded age, rejects source deadline overreach and checks elapsed lookups', async () => {
    const bundle = makeProDeps(); seed.generatedAt = new Date(now - 59800).toISOString();
    const first = value(await invoke(bundle)); now += 30200;
    assert.equal(value(await invoke(bundle, { panel_request: first.panelRequest.token })).ageMinutes, 2); assert.equal(calls.length, 1);
    const [key, raw] = cache(bundle)[0], wrapper = JSON.parse(raw);
    wrapper.value.generatedAt = new Date(now - 3600000 + 500).toISOString(); wrapper.reuseUntil = now + 501;
    bundle.pipe.store.set(key, JSON.stringify(wrapper)); await invoke(bundle, { panel_request: first.panelRequest.token }); assert.equal(calls.length, 2);
    const [newKey, newRaw] = cache(bundle)[0]; const valid = JSON.parse(newRaw); valid.value.generatedAt = new Date(now - 3600000 + 500).toISOString(); valid.reuseUntil = now + 500; bundle.pipe.store.set(newKey, JSON.stringify(valid));
    const pipeline = bundle.deps.redisPipeline; bundle.deps.redisPipeline = async (rows, ...args) => { const result = await pipeline(rows, ...args); if (rows.some(row => row[0] === 'GET' && row[1] === newKey)) now += 500; return result; };
    await invoke(bundle, { panel_request: first.panelRequest.token }); assert.equal(calls.length, 3);
  });
  it('does not store subsecond or expired source deadlines and tolerates optional SET failure', async () => {
    const short = makeProDeps(); seed.generatedAt = new Date(now - 3600000 + 999).toISOString(); await invoke(short); assert.equal(cache(short).length, 0);
    const elapsed = makeProDeps(); seed.generatedAt = new Date(now - 3600000 + 500).toISOString(); advance = now + 501; const old = value(await invoke(elapsed)); assert.equal(old.stale, true); assert.equal(cache(elapsed).length, 0);
    seed = payload(); const failed = makeProDeps(); const pipeline = failed.deps.redisPipeline;
    failed.deps.redisPipeline = async (rows, ...args) => { if (rows.some(row => row[0] === 'SET')) throw new Error('optional cache unavailable'); return pipeline(rows, ...args); };
    assert.equal((await invoke(failed)).body.error, undefined); assert.equal(cache(failed).length, 0);
  });
  it('rechecks save time, caps retained originals at admission expiry and resets across UTC midnight', async () => {
    const bundle = makeProDeps(); const first = value(await invoke(bundle));
    const [key, raw] = cache(bundle)[0], wrapper = JSON.parse(raw);
    assert.equal(wrapper.reuseUntil, Date.parse(first.panelRequest.expiresAt));
    const reader = await authorizePanelRead(context, bundle.pipe.pipeline, 'get_world_brief', {}, first.panelRequest.token);
    bundle.pipe.store.delete(key); now = wrapper.reuseUntil;
    await reader.saveWorldBrief(wrapper.value); assert.equal(cache(bundle).length, 0);
    now = Date.UTC(2026, 9, 5, 23, 59, 59, 250); seed = payload();
    const late = makeProDeps(); const last = value(await invoke(late));
    assert.equal(Date.parse(last.panelRequest.expiresAt), Date.UTC(2026, 9, 6)); assert.equal(cache(late).length, 0);
    now = Date.UTC(2026, 9, 6); seed = payload();
    assert.equal((await invoke(late, { panel_request: last.panelRequest.token })).body.error.code, -32602);
    await invoke(late); assert.equal(late.pipe.count, 2);
    const wrapper2 = JSON.parse(cache(late)[0][1]); wrapper2.reuseUntil = Date.parse(value(await invoke(late)).panelRequest.expiresAt) + 1;
    late.pipe.store.set(cache(late)[0][0], JSON.stringify(wrapper2)); await invoke(late); assert.equal(calls.length, 4);
  });
  it('rejects malformed persisted wire fields without changing the accepted semantic evidence', async () => {
    const bundle = makeProDeps(); await invoke(bundle); const [key, raw] = cache(bundle)[0];
    for (const mutation of [
      x => { x.extra = true; }, x => { x.value.summary = 'different'; }, x => { x.value.topStories[0].title = 'different'; },
      x => { x.value.sources[0].url = 7; }, x => { x.value.topStories[0].sources = [3]; }, x => { x.value.topStories[0].publishers[0].tier = {}; },
      x => { x.reuseUntil = Date.parse(x.value.generatedAt) + 3600001; }, x => { x.reuseUntil = now; }, x => { x.value.stale = true; },
    ]) { const invalid = JSON.parse(raw); mutation(invalid); bundle.pipe.store.set(key, JSON.stringify(invalid)); await invoke(bundle); }
    bundle.pipe.store.set(key, 'not-json'); await invoke(bundle); assert.equal(calls.length, 11); assert.equal(bundle.pipe.count, 1);
  });
  it('retains private originals before wire limits and selective projection while bounding private bytes', async () => {
    const bundle = makeProDeps(); seed.worldBrief = '界'.repeat(25000);
    const large = value(await invoke(bundle)); assert.equal(large._budget_exceeded, true); assert.equal(large.budget_bytes, 65536);
    assert.deepEqual(value(await invoke(bundle, { jmespath: 'headlines' })), ['First headline']); assert.equal(calls.length, 1); assert.equal(bundle.pipe.count, 1);
    const huge = makeProDeps(); seed.worldBrief = '界'.repeat(180000);
    await invoke(huge, { jmespath: 'headlines' }); await invoke(huge, { jmespath: 'headlines' }); assert.equal(cache(huge).length, 0); assert.equal(calls.length, 3); assert.equal(huge.pipe.count, 1);
  });
  it('bounds uncached work and denies revoked, locked or exhausted admissions before acquisition', async () => {
    const bundle = makeProDeps(); seed.status = 'error'; await invoke(bundle);
    for (let i = 1; i < 64; i++) await invoke(bundle);
    assert.equal((await invoke(bundle)).response.status, 429); assert.equal(calls.length, 64); assert.equal(bundle.pipe.count, 1);
    bundle.deps.getEntitlements = async () => ({ features: { tier: 1, mcpAccess: false } }); assert.equal((await invoke(bundle)).response.status, 403);
    bundle.deps.validateProMcpToken = async () => null; assert.equal((await invoke(bundle)).response.status, 401);
    assert.equal((await invoke(makeProDeps({ pipelineOpts: { initialCount: 50 } }))).response.status, 429);
    assert.equal((await invoke(makeProDeps({ pipelineOpts: { throwOnEval: true } }))).response.status, 503); assert.equal(calls.length, 64);
  });
  it('reads explicit receipt current usage without reservation and omits unknown counters', async () => {
    const bundle = makeProDeps(), token = value(await invoke(bundle)).panelRequest.token;
    const key = dailyCounterKey(context.userId, new Date(now)), pipeline = bundle.deps.redisPipeline; let counter = '3', reads = 0;
    bundle.deps.redisPipeline = async (rows, ...args) => { if (rows.length === 1 && rows[0][0] === 'GET' && rows[0][1] === key) { reads++; return [{ result: counter }]; } return pipeline(rows, ...args); };
    assert.equal((await invoke(bundle, { panel_request: token })).body.result._meta['worldmonitor/usage'].remaining, 47);
    counter = null; assert.equal((await invoke(bundle, { panel_request: token })).body.result._meta?.['worldmonitor/usage'], undefined);
    await invoke(bundle, { panel_request: 'forged' }); assert.equal(reads, 2); assert.equal(calls.length, 1); assert.equal(bundle.pipe.count, 1);
  });
  it('preserves ordinary API/free healthy, stale and unavailable complete responses and ignored legacy context', async () => {
    const rows = [];
    for (const plan of ['api', 'free']) for (const state of ['healthy', 'stale', 'error']) {
      seed = payload(); if (state === 'stale') seed.generatedAt = new Date(now - 90 * 60000).toISOString(); if (state === 'error') seed.status = 'error';
      const getEntitlements = async () => plan === 'api' ? { planKey: 'api-starter', features: { tier: 1, mcpAccess: true, apiAccess: true, planLimits: { apiCallsPerDay: 1000, mcpCallsPerDay: 'shared-api-budget' } }, validUntil: now + 86400000 } : { planKey: 'free', features: { tier: 0, mcpAccess: false }, validUntil: now + 86400000 };
      const bundle = makeProDeps({ getEntitlements });
      for (const args of [{}, { geo_context: { legacy: true } }, { jmespath: 'headlines' }]) rows.push({ plan, state, args, body: (await invoke(bundle, args)).body });
      assert.equal(bundle.pipe.count, plan === 'api' ? 6 : 0);
    }
    assert.equal(JSON.stringify(rows), readFileSync(new URL('./fixtures/mcp-world-brief-api-free-parent.json', import.meta.url), 'utf8'));
  });
  it('denies API paid controls and preserves free upgrade denial without gateway work', async () => {
    {
      const getEntitlements = async () => ({ planKey: 'api-starter', features: { tier: 1, mcpAccess: true, apiAccess: true, planLimits: { apiCallsPerDay: 1000, mcpCallsPerDay: 'shared-api-budget' } }, validUntil: now + 86400000 });
      const bundle = makeProDeps({ getEntitlements });
      for (const args of [{ refresh: true, request_id: '550e8400-e29b-41d4-a716-446655440000' }, { request_id: '550e8400-e29b-41d4-a716-446655440000' }, { panel_request: 'forged' }]) assert.equal((await invoke(bundle, args)).body.error.code, -32602);
      assert.equal(bundle.pipe.count, 0);
    }
    const free = makeProDeps({ getEntitlements: async () => ({ planKey: 'free', features: { tier: 0, mcpAccess: false }, validUntil: now + 86400000 }) });
    assert.equal((await invoke(free, { refresh: true })).response.status, 403); assert.equal(free.pipe.count, 0);
    assert.equal(calls.length, 0);
  });
  it('keeps the ordinary operator route outside paid admission', async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'world-brief-fixture-operator';
    const bundle = makeProDeps();
    for (const args of [{}, { geo_context: 17 }]) {
      const request = new Request('https://worldmonitor.app/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': process.env.WORLDMONITOR_VALID_KEYS }, body: JSON.stringify(callBody('get_world_brief', args)) });
      const body = await (await handler(request, bundle.deps)).json(); assert.equal(body.error, undefined);
      assert.equal(body.result.structuredContent.panelRequest, undefined);
    }
    assert.equal(calls.length, 2); assert.equal(bundle.pipe.count, 0); assert.equal(cache(bundle).length, 0);
  });
});
