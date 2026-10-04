import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { HMAC_SECRET, makeProDeps, proReq, callBody } from './helpers/mcp-pro-deps.mjs';
import { admitNewsPanel, admitCountryPanel, authorizePanelRead } from '../api/mcp/panel-requests.ts';
import { INTEL_TOPIC_IDS } from '../shared/intelligence-snapshots.js';
import { writeFileSync, readFileSync } from 'node:fs';

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
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
    now = start; Date.now = () => now; fetched = []; advanceOnSource = null;
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
    globalThis.fetch = originalFetch; Date.now = originalNow;
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
});
