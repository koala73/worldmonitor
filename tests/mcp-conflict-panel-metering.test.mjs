import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HMAC_SECRET, callBody, makeProDeps, proReq } from './helpers/mcp-pro-deps.mjs';
import { authorizePanelRead, admitConflictPanel, admitMarketPanel } from '../api/mcp/panel-requests.ts';
import { dailyCounterKey } from '../server/_shared/pro-mcp-token.ts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const context = { kind: 'pro', userId: 'user_pro_xyz', mcpTokenId: 'k57mcptokenid' };
const budget = { allowance: 'mcp', limit: 50 };
const sourceKeys = ['conflict:ucdp-events:v1', 'unrest:events:v1', 'risk:scores:sebuf:stale:v8', 'seed-meta:conflict:ucdp-events', 'seed-meta:unrest:events'];
const iran = (process.env.IRAN_EVENTS_ENABLED ?? 'false').toLowerCase() === 'true';
const readCount = iran ? 6 : 5;

describe('signed Conflict Events panel through the protected MCP handler', () => {
  let handler;
  let fetched;
  let sources;
  let ucdpMeta;
  let unrestMeta;
  const payload = () => ({
    'conflict:ucdp-events:v1': { candidateVersion: '26.0.9', events: [
      { id: 'fr1', country: 'France', deathsBest: 2, sourceOriginal: 'original report' },
      { id: 'fr2', country: 'France', deathsBest: 0 },
      { id: 'de1', country: 'Germany', deathsBest: 5 },
    ] },
    'unrest:events:v1': { events: [{ country: 'France', fatalities: 3 }, { country: 'Germany' }] },
    'risk:scores:sebuf:stale:v8': { ciiScores: [{ region: 'FR', score: 12 }, { region: 'DE', score: 7 }] },
    'conflict:iran-events:v1': { events: [{ id: 'iran1', country: 'Iran' }] },
  });
  const invoke = async (deps, args = {}, name = 'get_conflict_events') => {
    const response = await handler(proReq('POST', callBody(name, args)), deps);
    return { response, body: await response.json() };
  };
  const envelope = result => result.body.result.structuredContent;
  beforeEach(async () => {
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
    process.env.UPSTASH_REDIS_REST_URL = 'https://conflict-fixture.invalid';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'controlled-token';
    fetched = [];
    sources = payload();
    ucdpMeta = { fetchedAt: Date.now(), candidateVersion: '26.0.9', candidateComplete: true, annualFailedPages: 0 };
    unrestMeta = { fetchedAt: Date.now() };
    globalThis.fetch = async url => {
      const key = decodeURIComponent(new URL(String(url)).pathname.slice(5));
      assert.ok([...sourceKeys, 'conflict:iran-events:v1'].includes(key), key);
      fetched.push(key);
      const value = key === 'seed-meta:conflict:ucdp-events' ? ucdpMeta
        : key === 'seed-meta:unrest:events' ? unrestMeta : sources[key];
      if (value instanceof Error) throw value;
      return Response.json({ result: value === undefined || value === null ? null : JSON.stringify(value) });
    };
    handler = (await import('../api/mcp.ts')).mcpHandler;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  it('opens once and replays normalized country/default filters with only the fixed source keys', async () => {
    const { deps, pipe } = makeProDeps();
    const first = await invoke(deps);
    await invoke(deps);
    assert.equal(pipe.count, 1, 'exact repeated opening reuses one meaningful allocation');
    assert.equal(envelope(first).panelRequest?.panel, 'conflicts');
    const token = envelope(first).panelRequest.token;
    assert.equal(first.body.result._meta['worldmonitor/usage'].remaining, 49);
    assert.equal(fetched.length, readCount);
    await invoke(deps, { country: ' ', limit: 30, panel_request: token });
    assert.equal(fetched.length, readCount);
    const france = await invoke(deps, { country: ' FRANCE ', min_fatalities: 1 });
    assert.deepEqual(envelope(france).data['ucdp-events'].events.map(row => row.id), ['fr1']);
    assert.equal(envelope(france).data.events.events.length, 1);
    assert.equal(envelope(france).data.scores.ciiScores.length, 0);
    if (iran) assert.equal(envelope(france).data['iran-events'].events.length, 1, 'Iran remains unfiltered by country/fatality');
    await invoke(deps, { country: 'france', min_fatalities: 1, limit: 30, panel_request: token });
    assert.equal(fetched.length, 2 * readCount);
    assert.equal(pipe.count, 1);
    assert.deepEqual([...new Set(fetched)].sort(), [...sourceKeys, ...(iran ? ['conflict:iran-events:v1'] : [])].sort());
    for (const [limit, expected] of [[0, 2], [-1, 2], [1.9, 1], [0.5, 0]]) {
      assert.equal(envelope(await invoke(deps, { country: 'France', limit, panel_request: token })).data['ucdp-events'].events.length, expected);
    }
    assert.equal(pipe.count, 1);
  });
  it('preserves actual UCDP metadata without inventing missing or malformed observation fields', async () => {
    const { deps } = makeProDeps();
    assert.deepEqual(envelope(await invoke(deps)).conflict_source, { ucdp: ucdpMeta });
    ucdpMeta = { fetchedAt: Date.now(), candidateVersion: null, candidateComplete: 'true', annualFailedPages: '0' };
    const value = envelope(await invoke(deps, { country: 'France' }));
    assert.deepEqual(value.conflict_source, { ucdp: { fetchedAt: ucdpMeta.fetchedAt, candidateVersion: null } });
  });
  it('saves originals before summary, whole-envelope projection and full-output fitting', async () => {
    const { deps, pipe } = makeProDeps();
    sources['conflict:ucdp-events:v1'].events = Array.from({ length: 160 }, (_, index) => ({ id: `event${index}`, country: 'France', sourceOriginal: 'x'.repeat(1800) }));
    const first = await invoke(deps, { limit: 0 });
    const token = envelope(first).panelRequest.token;
    assert.equal(envelope(first).data.partial, true);
    assert.ok(envelope(first).data['ucdp-events'].events.length < 160);
    const summary = await invoke(deps, { limit: 0, summary: true, panel_request: token });
    assert.equal(envelope(summary).projection.data['ucdp-events'].events.count, 160);
    const projected = await invoke(deps, { limit: 0, jmespath: "length(data.\"ucdp-events\".events)", panel_request: token });
    assert.equal(envelope(projected).projection, 160);
    assert.equal(fetched.length, readCount);
    assert.equal(pipe.count, 1);
    const whole = await invoke(deps, { country: 'France', limit: 2, jmespath: '@', panel_request: token });
    assert.equal(envelope(whole).projection.data['ucdp-events'].events.length, 2);
  });
  it('charges explicit UUID refresh once, preserves expiry and rejects invalid controls before work', async () => {
    const { deps, pipe } = makeProDeps();
    for (const args of [{ country: [] }, { min_fatalities: '1' }, { limit: '2' }, { extra: true }, { refresh: true }, { request_id: 'bad' }]) {
      assert.equal((await invoke(deps, args)).body.error?.code, -32602, JSON.stringify(args));
    }
    assert.equal(pipe.count, 0);
    assert.equal(fetched.length, 0);
    const request_id = '550E8400-E29B-41D4-A716-446655440000';
    const first = await invoke(deps, { refresh: true, request_id });
    const receipt = envelope(first).panelRequest;
    const retry = await invoke(deps, { refresh: true, request_id: request_id.toLowerCase() });
    assert.equal(envelope(retry).panelRequest.token, receipt.token);
    assert.equal(envelope(retry).panelRequest.expiresAt, receipt.expiresAt);
    assert.equal(fetched.length, readCount);
    assert.equal(pipe.count, 1);
    assert.equal((await invoke(deps, { panel_request: receipt.token, refresh: true, request_id })).body.error?.code, -32602);
    await invoke(deps, { refresh: true, request_id: crypto.randomUUID() });
    assert.equal(pipe.count, 2);
  });
  for (const [label, mutate] of [
    ['missing original unrest bucket', () => { sources['unrest:events:v1'] = null; }],
    ['malformed original excluded row', () => { sources['conflict:ucdp-events:v1'].events.push(null); }],
    ['malformed original scores', () => { sources['risk:scores:sebuf:stale:v8'].ciiScores = {}; }],
    ['malformed source completeness', () => { sources['conflict:ucdp-events:v1'].candidateComplete = 'true'; }],
    ['malformed source failed-pages', () => { sources['conflict:ucdp-events:v1'].annualFailedPages = '0'; }],
    ['malformed original unrest row', () => { sources['unrest:events:v1'].events.push(false); }],
    ['failed data read', () => { sources['unrest:events:v1'] = new Error('controlled read failure'); }],
    ['partial annual pages', () => { ucdpMeta.annualFailedPages = 2; }],
    ['partial candidate', () => { ucdpMeta.candidateComplete = false; }],
    ['missing completeness', () => { delete ucdpMeta.annualFailedPages; }],
    ['mismatched versions', () => { ucdpMeta.candidateVersion = '26.0.8'; }],
    ['annual-only unknown candidate', () => { ucdpMeta.candidateVersion = null; ucdpMeta.candidateComplete = false; sources['conflict:ucdp-events:v1'].candidateVersion = null; }],
    ['stale source', () => { ucdpMeta.fetchedAt -= 40 * 60000; }],
    ['unknown source metadata', () => { ucdpMeta = null; }],
    ['failed metadata read', () => { ucdpMeta = new Error('fixture failure'); }],
    ['structured degraded source', () => { sources['unrest:events:v1'].degraded = true; }],
  ]) {
    it(`retries ${label} under the original admission and replays only after recovery`, async () => {
      const { deps, pipe } = makeProDeps();
      mutate();
      const first = await invoke(deps, { country: 'France', min_fatalities: 1 });
      const token = envelope(first).panelRequest.token;
      sources = payload();
      ucdpMeta = { fetchedAt: Date.now(), candidateVersion: '26.0.9', candidateComplete: true, annualFailedPages: 0 };
      const recovered = await invoke(deps, { country: 'france', min_fatalities: 1, panel_request: token });
      assert.equal(envelope(recovered).data['ucdp-events'].events[0].id, 'fr1');
      assert.equal(fetched.length, readCount * 2);
      await invoke(deps, { country: 'France', min_fatalities: 1, panel_request: token });
      assert.equal(fetched.length, readCount * 2);
      assert.equal(pipe.count, 1);
    });
  }
  for (const [label, mutate] of [
    ['degraded scores', () => { sources['risk:scores:sebuf:stale:v8'].degraded = true; }],
    ['missing unrest', () => { sources['unrest:events:v1'] = null; }],
    ['malformed unrelated scores row', () => { sources['risk:scores:sebuf:stale:v8'].ciiScores.push(null); }],
  ]) {
    it(`still narrows usable events when ${label} makes the original noncacheable`, async () => {
      const { deps, pipe } = makeProDeps();
      mutate();
      const first = await invoke(deps, { country: 'France', min_fatalities: 1, limit: 1 });
      assert.deepEqual(envelope(first).data['ucdp-events'].events.map(row => row.id), ['fr1']);
      const token = envelope(first).panelRequest.token;
      await invoke(deps, { country: 'France', min_fatalities: 1, limit: 1, panel_request: token });
      assert.equal(fetched.length, 2 * readCount, 'partial source stays retryable after narrowing healthy collections');
      assert.equal(pipe.count, 1);
    });
  }
  it('keeps malformed original event evidence while independently filtering other usable collections', async () => {
    const { deps } = makeProDeps();
    sources['conflict:ucdp-events:v1'].events.push(null);
    const first = await invoke(deps, { country: 'France', min_fatalities: 1, limit: 1 });
    assert.deepEqual(envelope(first).data['ucdp-events'].events, sources['conflict:ucdp-events:v1'].events);
    assert.deepEqual(envelope(first).data.events.events, [{ country: 'France', fatalities: 3 }]);
    assert.deepEqual(envelope(first).data.scores.ciiScores, []);
  });
  it('replays authoritative filtered empty while keeping omitted threshold distinct from zero', async () => {
    const { deps, pipe } = makeProDeps();
    const token = envelope(await invoke(deps, { country: 'absent' })).panelRequest.token;
    await invoke(deps, { country: 'absent', panel_request: token });
    assert.equal(fetched.length, readCount);
    await invoke(deps, { country: 'absent', min_fatalities: 0, panel_request: token });
    assert.equal(fetched.length, readCount * 2);
    assert.equal(pipe.count, 1);
  });
  it('denies forged, cross-family, owner, scope, expired and revoked receipts before source or counter work', async () => {
    const { deps, pipe } = makeProDeps();
    const receipt = envelope(await invoke(deps)).panelRequest;
    const foreign = await admitMarketPanel(context, budget, pipe.pipeline, {});
    for (const panel_request of ['forged', foreign.token]) assert.equal((await invoke(deps, { panel_request })).body.error?.code, -32602);
    await assert.rejects(authorizePanelRead({ ...context, userId: 'foreign' }, pipe.pipeline, 'get_conflict_events', {}, receipt.token));
    await assert.rejects(authorizePanelRead(context, pipe.pipeline, 'get_prediction_markets', {}, receipt.token));
    await assert.rejects(authorizePanelRead(context, pipe.pipeline, 'get_conflict_events', {}, receipt.token, Date.parse(receipt.expiresAt)));
    assert.equal((await invoke(deps, { panel_request: receipt.token, dataset: 'all' })).body.error?.code, -32602);
    deps.validateProMcpToken = async () => null;
    assert.equal((await invoke(deps, { panel_request: receipt.token })).response.status, 401);
    assert.equal(fetched.length, readCount);
  });
  it('caps uncached execution at 64 while healthy cache replay stays allowed', async () => {
    const { deps, pipe } = makeProDeps();
    const token = envelope(await invoke(deps)).panelRequest.token;
    for (let index = 1; index < 64; index++) assert.equal((await invoke(deps, { country: `case${index}`, panel_request: token })).body.error, undefined);
    assert.equal((await invoke(deps, { country: 'last', panel_request: token })).response.status, 429);
    assert.equal(fetched.length, 64 * readCount);
    assert.equal((await invoke(deps, { panel_request: token })).body.error, undefined);
    assert.equal(pipe.count, 1);
  });
  it('reads a current counter only after authorization and omits unknown usage without source reads', async () => {
    const { deps, pipe } = makeProDeps();
    const token = envelope(await invoke(deps)).panelRequest.token;
    const key = dailyCounterKey(context.userId);
    const original = deps.redisPipeline;
    let reads = 0;
    let counter = '2';
    deps.redisPipeline = async (commands, ...options) => {
      if (commands.length === 1 && commands[0][0] === 'GET' && commands[0][1] === key) { reads++; return [{ result: counter }]; }
      return original(commands, ...options);
    };
    assert.equal((await invoke(deps, { panel_request: token })).body.result._meta['worldmonitor/usage'].remaining, 48);
    counter = null;
    const unknown = await invoke(deps, { panel_request: token });
    assert.equal(unknown.body.result._meta?.['worldmonitor/usage'], undefined);
    assert.equal(envelope(unknown).data['ucdp-events'].events.length, 3);
    await invoke(deps, { panel_request: 'forged' });
    assert.equal(reads, 2);
    assert.equal(fetched.length, readCount);
    assert.equal(pipe.count, 1);
  });
  it('shares owner admission through the verified user-key door and fails closed on lost entitlement', async () => {
    const { deps, pipe } = makeProDeps({ resolveBearerToContext: async () => ({ kind: 'user_key', userId: context.userId }) });
    const first = await invoke(deps);
    await invoke(deps, { panel_request: envelope(first).panelRequest.token });
    assert.equal(pipe.count, 1);
    assert.equal(fetched.length, readCount);
    deps.getEntitlements = async () => ({ features: { tier: 1, mcpAccess: false } });
    const before = pipe.ops.length;
    assert.equal((await invoke(deps, { panel_request: envelope(first).panelRequest.token })).response.status, 403);
    assert.equal(pipe.ops.length, before);
    assert.equal(fetched.length, readCount);
  });
  it('retains explicit refresh expiry and rejects removed markers, exhausted allowances and backend failure without source work', async () => {
    const now = Date.UTC(2026, 9, 5, 23, 59);
    const { deps, pipe } = makeProDeps();
    const request_id = crypto.randomUUID();
    const receipt = await admitConflictPanel(context, budget, pipe.pipeline, { refresh: true, request_id }, now);
    const replay = await admitConflictPanel(context, budget, pipe.pipeline, { refresh: true, request_id }, now + 10_000);
    assert.equal(receipt.token, replay.token);
    assert.equal(Date.parse(receipt.expiresAt), Date.UTC(2026, 9, 6));
    const current = envelope(await invoke(deps)).panelRequest;
    for (const key of pipe.store.keys()) if (key.includes(':conflicts:conflicts:') && !key.includes(':data:')) pipe.store.delete(key);
    assert.equal((await invoke(deps, { panel_request: current.token })).response.status, 503);
    const count = fetched.length;
    const exhausted = makeProDeps({ pipelineOpts: { initialCount: 50 } });
    assert.equal((await invoke(exhausted.deps)).response.status, 429);
    const unavailable = makeProDeps({ pipelineOpts: { throwOnEval: true } });
    assert.equal((await invoke(unavailable.deps)).response.status, 503);
    assert.equal(fetched.length, count);
  });
  it('keeps healthy API and free legacy filters and ordinary per-call charging while rejecting paid controls', async () => {
    for (const entitlement of [
      { planKey: 'api-starter', features: { tier: 1, mcpAccess: true, apiAccess: true, planLimits: { apiCallsPerDay: 1000, mcpCallsPerDay: 'shared-api-budget' } }, validUntil: Date.now() + 86400000 },
      { planKey: 'free', features: { tier: 0, mcpAccess: false }, validUntil: Date.now() + 86400000 },
    ]) {
      const { deps, pipe } = makeProDeps({ getEntitlements: async () => entitlement });
      const first = await invoke(deps, { country: 'France', min_fatalities: '1', limit: 1.9, extra: true });
      assert.equal(first.body.error, undefined);
      assert.equal(envelope(first).panelRequest, undefined);
      assert.equal(envelope(first).data['ucdp-events'].events.length, 1);
      assert.deepEqual(envelope(first).conflict_source, { ucdp: ucdpMeta });
      await invoke(deps, { limit: -1 });
      assert.equal(pipe.count, 2);
      for (const args of [{ refresh: false }, { request_id: crypto.randomUUID() }, { panel_request: 'forged' }]) assert.equal((await invoke(deps, args)).body.error?.code, -32602);
      assert.equal(pipe.count, 2);
    }
  });
});
