import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { HMAC_SECRET, makeProDeps, proReq, callBody } from './helpers/mcp-pro-deps.mjs';
import { admitNewsPanel, authorizePanelRead } from '../api/mcp/panel-requests.ts';
import { dailyCounterKey } from '../server/_shared/pro-mcp-token.ts';

const originalFetch = globalThis.fetch, OriginalDate = Date, originalEnv = { ...process.env };
const context = { kind: 'pro', userId: 'user_pro_xyz', mcpTokenId: 'k57mcptokenid' };
const start = Date.UTC(2026, 9, 5, 10, 1, 0, 250), budget = { allowance: 'mcp', limit: 50 };
const requestId = '550E8400-E29B-41D4-A716-446655440000';

describe('direct country paid original reuse', () => {
  let handler, now, calls, brief, digest, risk, briefStatus;
  const nativeBrief = () => ({ countryCode: 'US', countryName: 'United States', brief: 'Controlled assessment [1].', model: 'fixture-model', generatedAt: now - 60000, sources: [{ title: 'US trade evidence', source: 'Reuters', url: 'https://example.com/evidence', publishedAt: '2026-10-05T09:59:00Z' }], evidence: [{ id: 'macro', kind: 'macro', label: 'GDP', value: '2.3%', factText: 'Observed growth', asOf: '2026 Q2', url: 'https://example.com/macro' }] });
  const nativeDigest = () => ({ categories: { politics: { items: [{ title: 'United States trade talks', source: 'Reuters', link: 'https://example.com/grounding', publishedAt: '2026-10-05T09:58:00Z', corroborationCount: 2 }] } }, coverage: { state: 'complete', servedStale: false, attemptedAt: '2026-10-05T10:00:00Z' } });
  const nativeRisk = () => ({ countryCode: 'US', countryName: 'United States', advisoryLevel: '', sanctionsActive: false, sanctionsCount: 0, fetchedAt: now - 120000, upstreamUnavailable: false, cii: { region: 'US', combinedScore: 17, staticBaseline: 14, dynamicScore: -3, trend: 'TREND_DIRECTION_FALLING', components: { ciiContribution: 1, geoConvergence: 2, militaryActivity: 3, newsActivity: 4 }, computedAt: now - 120000, methodologyVersion: 'fixture-v1', eventMultiplier: 1, advisoryLevel: '', advisoryProvenance: 'live' } });
  const invoke = async (bundle, name = 'get_country_brief', args = { country_code: 'US' }, request) => {
    const response = await handler(request ?? proReq('POST', callBody(name, args)), bundle.deps);
    return { response, body: await response.json() };
  };
  const value = result => result.body.result?.structuredContent.projection ?? result.body.result?.structuredContent;
  const cache = bundle => [...bundle.pipe.store].filter(([key]) => key.includes(':data:'));
  beforeEach(async () => {
    now = start; calls = []; briefStatus = 200;
    globalThis.Date = class extends OriginalDate { constructor(...args) { if (args.length) super(...args); else super(now); } static now() { return now; } };
    Object.assign(process.env, { MCP_INTERNAL_HMAC_SECRET: HMAC_SECRET, MCP_TELEMETRY: 'false', USAGE_TELEMETRY: 'false' });
    delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
    brief = nativeBrief(); digest = nativeDigest(); risk = nativeRisk();
    globalThis.fetch = async (input, options = {}) => {
      const url = new URL(String(input)); assert.equal(url.origin, 'https://api.worldmonitor.app');
      assert.ok(options.headers['User-Agent']); assert.ok(options.signal);
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ path: url.pathname, search: url.search, method: options.method ?? 'GET', body });
      if (url.pathname === '/api/news/v1/list-feed-digest') return Response.json(digest);
      if (url.pathname === '/api/intelligence/v1/get-country-intel-brief') return Response.json(brief, { status: briefStatus });
      if (url.pathname === '/api/intelligence/v1/get-country-risk') return Response.json(risk);
      if (url.pathname === '/api/intelligence/v1/get-country-energy-profile') return Response.json({ countryCode: 'US', available: true });
      throw new Error(`Unexpected fixture fetch ${url.href}`);
    };
    handler = (await import('../api/mcp.ts')).mcpHandler;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch; globalThis.Date = OriginalDate;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });
  it('reuses exact originals across aliases, ignored summary and selective presentation', async () => {
    const bundle = makeProDeps(), first = value(await invoke(bundle));
    for (const country_code of ['USA', 'United States']) assert.equal(value(await invoke(bundle, 'get_country_brief', { country_code, summary: true })).brief, first.brief);
    assert.deepEqual(value(await invoke(bundle, 'get_country_brief', { country_code: 'US', jmespath: 'evidence' })), first.evidence);
    assert.equal(bundle.pipe.count, 1); assert.equal(calls.length, 2);
    assert.equal(first.panelRequest.countryCode, 'US');
    const original = JSON.parse(cache(bundle)[0][1]); assert.equal(original.panelRequest, undefined); assert.equal(original.usage, undefined);
    assert.equal(original.generatedAt, brief.generatedAt); assert.deepEqual(original.evidence, brief.evidence); assert.equal(original.sources[0].url, brief.sources[0].url);
    assert.equal(original.groundingStories[0].url, 'https://example.com/grounding');
  });
  it('shares the exact default assessment with the full opener in both directions', async () => {
    for (const directFirst of [true, false]) {
      const bundle = makeProDeps(); calls = [];
      let receipt;
      if (directFirst) receipt = value(await invoke(bundle)).panelRequest;
      const opened = value(await invoke(bundle, 'open_country_brief', { country_code: 'USA' })).panelRequest;
      receipt ??= opened;
      await invoke(bundle, 'get_country_brief', { country_code: 'United States', panel_request: receipt.token });
      await invoke(bundle, 'get_country_brief', { country_code: 'US', framework: '', allow_stale: false, summary: false });
      assert.equal(bundle.pipe.count, 1); assert.equal(calls.length, 2); assert.equal(cache(bundle).length, 1); assert.equal(opened.token, receipt.token);
    }
  });
  it('shares country admission with bare risk and fixed readers without aliasing their shapes', async () => {
    const bundle = makeProDeps(), first = value(await invoke(bundle, 'get_country_risk', { country_code: 'USA' }));
    assert.deepEqual(value(await invoke(bundle, 'get_country_risk', { country_code: 'United States', jmespath: 'cii' })), risk.cii);
    await invoke(bundle); await invoke(bundle, 'get_country_brief_section', { section: 'energy', arguments: { country_code: 'US' }, panel_request: first.panelRequest.token });
    const wrapped = value(await invoke(bundle, 'get_country_brief_section', { section: 'risk', arguments: { country_code: 'US' }, panel_request: first.panelRequest.token }));
    assert.equal(wrapped.state, 'ready'); assert.deepEqual(wrapped.value, risk);
    assert.equal(bundle.pipe.count, 1); assert.equal(calls.filter(x => x.path.endsWith('get-country-risk')).length, 2);
  });
  it('normalizes effective framework execution and identity without trimming or extra source dimensions', async () => {
    const bundle = makeProDeps(), prefix = ' Lens '.repeat(334).slice(0, 2000);
    for (const framework of [prefix + 'A', prefix + 'B', ' Custom ', 42]) await invoke(bundle, 'get_country_brief', { country_code: 'US', framework });
    for (const allow_stale of [false, 'true', true, true]) await invoke(bundle, 'get_country_brief', { country_code: 'US', allow_stale });
    const posts = calls.filter(x => x.method === 'POST');
    assert.equal(bundle.pipe.count, 1); assert.deepEqual(posts.map(x => x.body.framework), [prefix, ' Custom ', '42', '', '']);
    assert.ok(posts.every(x => !('force' in x.body) && !('refresh' in x.body)));
  });
  for (const [label, mutate] of [
    ['empty assessment', () => { brief.brief = ''; }], ['missing coverage', () => { delete digest.coverage; }],
    ['partial coverage', () => { digest.coverage.state = 'partial'; }], ['retained coverage', () => { digest.coverage.servedStale = true; }],
    ['failed coverage', () => { digest.coverage.state = 'error'; }], ['future generation', () => { brief.generatedAt = now + 1; }],
    ['invalid generation', () => { brief.generatedAt = 'bad'; }], ['wrong identity', () => { brief.countryCode = 'CN'; }],
    ['malformed evidence', () => { brief.evidence = [7]; }], ['failed gateway', () => { briefStatus = 503; }],
  ]) it(`retries ${label} without a second allocation and preserves healthy recovery`, async () => {
    const bundle = makeProDeps(); mutate(); await invoke(bundle); assert.equal(cache(bundle).length, 0);
    brief = nativeBrief(); digest = nativeDigest(); briefStatus = 200; await invoke(bundle); await invoke(bundle);
    assert.equal(bundle.pipe.count, 1); assert.equal(calls.length, 4);
  });
  it('does not require matching country news in a complete digest', async () => {
    const bundle = makeProDeps(); digest.categories = {};
    const first = value(await invoke(bundle)); assert.deepEqual(first.groundingStories, []);
    await invoke(bundle); assert.equal(calls.length, 2); assert.equal(bundle.pipe.count, 1);
  });
  it('rejects old malformed and retained default originals on the full receipt path', async () => {
    const bundle = makeProDeps(), token = value(await invoke(bundle, 'open_country_brief', { country_code: 'US' })).panelRequest.token;
    const reader = await authorizePanelRead(context, bundle.pipe.pipeline, 'get_country_brief', { country_code: 'US' }, token);
    await reader.save({ ...nativeBrief(), sources: [], groundingStories: [], digestCoverage: { state: 'complete', servedStale: false } });
    const [key, raw] = cache(bundle)[0];
    for (const mutate of [x => { x.brief = ''; }, x => { x.digestCoverage.servedStale = true; }, x => { delete x.digestCoverage; }, x => { x.countryCode = 'CN'; }, x => { x.evidence = [false]; }]) {
      const invalid = JSON.parse(raw); mutate(invalid); bundle.pipe.store.set(key, JSON.stringify(invalid));
      await invoke(bundle, 'get_country_brief', { country_code: 'USA', panel_request: token });
    }
    bundle.pipe.store.set(key, 'bad-json'); await invoke(bundle, 'get_country_brief', { country_code: 'US', panel_request: token });
    assert.equal(calls.length, 12); assert.equal(bundle.pipe.count, 1);
  });
  it('retries outage risk but reuses genuine untracked identity and native negative movement', async () => {
    const bundle = makeProDeps(); risk.upstreamUnavailable = true; delete risk.cii; risk.fetchedAt = 0;
    await invoke(bundle, 'get_country_risk'); assert.equal(cache(bundle).length, 0);
    risk.upstreamUnavailable = false; await invoke(bundle, 'get_country_risk'); await invoke(bundle, 'get_country_risk');
    assert.equal(calls.length, 2); assert.equal(bundle.pipe.count, 1);
    const fresh = makeProDeps(); risk = nativeRisk(); await invoke(fresh, 'get_country_risk');
    const [key, raw] = cache(fresh)[0]; const malformed = JSON.parse(raw); malformed.cii.components.newsActivity = 'unknown'; fresh.pipe.store.set(key, JSON.stringify(malformed));
    assert.equal(value(await invoke(fresh, 'get_country_risk')).cii.dynamicScore, -3); assert.equal(calls.length, 4);
  });
  it('refreshes exactly once per case-normalized UUID without forcing generation', async () => {
    const bundle = makeProDeps(), receipt = value(await invoke(bundle)).panelRequest;
    const refreshed = value(await invoke(bundle, 'get_country_risk', { country_code: 'US', refresh: true, request_id: requestId })).panelRequest;
    const repeat = value(await invoke(bundle, 'get_country_risk', { country_code: 'USA', refresh: true, request_id: requestId.toLowerCase() })).panelRequest;
    assert.equal(refreshed.token, repeat.token); assert.equal(bundle.pipe.count, 2); assert.equal(calls.length, 3);
    for (const args of [{ country_code: 'US', refresh: true }, { country_code: 'US', panel_request: receipt.token, refresh: true, request_id: requestId }, { country_code: 'US', source: 'private' }, { country_code: 'US', panel_request: 'forged' }]) assert.equal((await invoke(bundle, 'get_country_brief', args)).body.error.code, -32602);
    const news = await admitNewsPanel(context, budget, bundle.pipe.pipeline, {});
    assert.equal((await invoke(bundle, 'get_country_risk', { country_code: 'US', panel_request: news.token })).body.error.code, -32602);
    await assert.rejects(authorizePanelRead({ ...context, userId: 'other' }, bundle.pipe.pipeline, 'get_country_risk', { country_code: 'US' }, receipt.token));
    assert.equal((await invoke(bundle, 'get_country_risk', { country_code: 'CN', panel_request: receipt.token })).body.error.code, -32602);
    now = Date.parse(receipt.expiresAt); assert.equal((await invoke(bundle, 'get_country_risk', { country_code: 'US', panel_request: receipt.token })).body.error.code, -32602);
    assert.equal(calls.length, 3);
  });
  it('preserves read bounds and entitlement, token, counter and UTC denials before acquisition', async () => {
    const bundle = makeProDeps(); brief.brief = ''; for (let i = 0; i < 64; i++) await invoke(bundle);
    assert.equal((await invoke(bundle)).response.status, 429); assert.equal(calls.length, 128); assert.equal(bundle.pipe.count, 1);
    bundle.deps.getEntitlements = async () => ({ features: { tier: 1, mcpAccess: false } }); assert.equal((await invoke(bundle)).response.status, 403);
    bundle.deps.validateProMcpToken = async () => null; assert.equal((await invoke(bundle)).response.status, 401);
    assert.equal((await invoke(makeProDeps({ pipelineOpts: { initialCount: 50 } }))).response.status, 429);
    assert.equal((await invoke(makeProDeps({ pipelineOpts: { throwOnEval: true } }))).response.status, 503);
    brief = nativeBrief(); now = Date.UTC(2026, 9, 5, 23, 59, 0); brief = nativeBrief(); const late = makeProDeps(); const token = value(await invoke(late)).panelRequest.token;
    now = Date.UTC(2026, 9, 6); assert.equal((await invoke(late, 'get_country_brief', { country_code: 'US', panel_request: token })).body.error.code, -32602); brief = nativeBrief(); await invoke(late); assert.equal(late.pipe.count, 2);
  });
  it('returns current receipt allowance without extra reservation and keeps unknown unknown', async () => {
    const bundle = makeProDeps(), receipt = value(await invoke(bundle)).panelRequest;
    const key = dailyCounterKey(context.userId, new Date(now)), pipeline = bundle.deps.redisPipeline; let reads = 0, counter = '3';
    bundle.deps.redisPipeline = async (rows, ...args) => { if (rows.length === 1 && rows[0][0] === 'GET' && rows[0][1] === key) { reads++; return [{ result: counter }]; } return pipeline(rows, ...args); };
    assert.equal((await invoke(bundle, 'get_country_brief', { country_code: 'US', panel_request: receipt.token })).body.result._meta['worldmonitor/usage'].remaining, 47);
    counter = null; assert.equal((await invoke(bundle, 'get_country_risk', { country_code: 'US', panel_request: receipt.token })).body.result._meta?.['worldmonitor/usage'], undefined);
    assert.equal(reads, 2); assert.equal(bundle.pipe.count, 1);
  });
  it('keeps private and wire budgets while reusing originals before JMESPath', async () => {
    const bundle = makeProDeps(); brief.brief = '界'.repeat(25000); assert.equal(value(await invoke(bundle))._budget_exceeded, true);
    assert.deepEqual(value(await invoke(bundle, 'get_country_brief', { country_code: 'US', jmespath: 'evidence' })), brief.evidence); assert.equal(calls.length, 2); assert.equal(bundle.pipe.count, 1);
    const huge = makeProDeps(); brief.brief = '界'.repeat(180000); await invoke(huge); await invoke(huge); assert.equal(cache(huge).length, 0); assert.equal(calls.length, 6); assert.equal(huge.pipe.count, 1);
  });
  it('preserves complete reviewed-parent ordinary API, free and operator contracts', async () => {
    const rows = [];
    for (const plan of ['api', 'free', 'operator']) for (const name of ['get_country_brief', 'get_country_risk']) {
      const getEntitlements = async () => plan === 'api' ? { planKey: 'api-starter', features: { tier: 1, mcpAccess: true, apiAccess: true, planLimits: { apiCallsPerDay: 1000, mcpCallsPerDay: 'shared-api-budget' } }, validUntil: now + 86400000 } : { planKey: 'free', features: { tier: 0, mcpAccess: false }, validUntil: now + 86400000 };
      const bundle = makeProDeps({ getEntitlements }); process.env.WORLDMONITOR_VALID_KEYS = 'country-fixture-operator';
      for (const args of [{ country_code: 'USA' }, { country_code: 'United States', summary: true, framework: 42, allow_stale: 'true', ignored: 'legacy' }, { country_code: 'US', jmespath: name === 'get_country_brief' ? 'evidence' : 'cii' }]) {
        const request = plan === 'operator' ? proReq('POST', callBody(name, args), { Authorization: 'Bearer country-fixture-operator' }) : undefined;
        const result = await invoke(bundle, name, args, request); rows.push({ plan, name, args, status: result.response.status, body: result.body, count: bundle.pipe.count });
      }
    }
    assert.equal(JSON.stringify(rows), readFileSync(new URL('./fixtures/mcp-country-direct-api-free-parent.json', import.meta.url), 'utf8'));
  });
});
