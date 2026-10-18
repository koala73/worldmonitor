import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HMAC_SECRET, callBody, makeProDeps, proReq } from './helpers/mcp-pro-deps.mjs';
import { admitNewsPanel, admitCountryPanel, admitMarketPanel, authorizePanelRead } from '../api/mcp/panel-requests.ts';
import { dailyCounterKey } from '../server/_shared/pro-mcp-token.ts';

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const originalEnv = { ...process.env };
const context = { kind: 'pro', userId: 'user_pro_xyz', mcpTokenId: 'k57mcptokenid' };
const budget = { allowance: 'mcp', limit: 50 };
const sourceKeys = ['seismology:earthquakes:v1', 'wildfire:fires:v1', 'natural:events:v1', 'seed-meta:seismology:earthquakes'];
const start = Date.UTC(2026, 9, 5, 10, 1, 0, 250);

describe('Natural Disasters paid admission and original source deadlines', () => {
  let handler, fetched, sources, meta, now, advanceOnSource;
  const seeded = (data, fetchedAt = now) => ({ _seed: { fetchedAt, state: 'OK' }, data });
  const payload = () => ({
    [sourceKeys[0]]: seeded({ earthquakes: [{ id: 'low', magnitude: 4.5 }, { id: 'high', magnitude: 6 }] }),
    [sourceKeys[1]]: seeded({ fireDetections: [{ id: 'fire1' }, { id: 'fire2' }], _firmsState: 'ok', _firmsPartial: false, _cwfisState: 'ok', _bcState: 'ok' }),
    [sourceKeys[2]]: seeded({ fetchedAt: now, events: [{ id: 'eonet', magnitude: 5, closed: false }, { id: 'gdacs', magnitude: 2, closed: true }], westernPacific: { dataAvailable: true }, hkoWarnings: { dataAvailable: true } }),
  });
  const invoke = async (deps, args = {}, name = 'get_natural_disasters') => {
    const response = await handler(proReq('POST', callBody(name, args)), deps);
    return { response, body: await response.json() };
  };
  const envelope = result => result.body.result.structuredContent;
  const fixture = (options = {}) => {
    const bundle = makeProDeps(options);
    const pipeline = bundle.pipe.pipeline;
    const expiry = new Map();
    const expiringPipeline = async (commands, ...args) => {
      for (const command of commands) if (command[0] === 'GET' && expiry.has(command[1]) && expiry.get(command[1]) <= now) bundle.pipe.store.delete(command[1]);
      const result = await pipeline(commands, ...args);
      for (const command of commands) if (command[0] === 'SET' && command[3] === 'EX') expiry.set(command[1], now + Number(command[4]) * 1000);
      return result;
    };
    bundle.pipe.pipeline = expiringPipeline; bundle.deps.redisPipeline = expiringPipeline;
    return bundle;
  };
  const news = async bundle => admitNewsPanel(context, budget, bundle.pipe.pipeline, {});
  const cachedEntries = bundle => [...bundle.pipe.store].filter(([key]) => key.includes(':data:'));
  beforeEach(async () => {
    now = start; Date.now = () => now;
    Object.assign(process.env, { MCP_INTERNAL_HMAC_SECRET: HMAC_SECRET, MCP_TELEMETRY: 'false', UPSTASH_REDIS_REST_URL: 'https://disaster-fixture.invalid', UPSTASH_REDIS_REST_TOKEN: 'fixture-no-credential' });
    fetched = []; sources = payload(); meta = { fetchedAt: now, sourceState: 'ok' }; advanceOnSource = null;
    globalThis.fetch = async url => {
      const address = new URL(String(url));
      assert.equal(address.origin, 'https://disaster-fixture.invalid', 'no real network or provider call');
      const key = decodeURIComponent(address.pathname.slice(5)); assert.ok(sourceKeys.includes(key), key); fetched.push(key);
      if (advanceOnSource) { now = advanceOnSource; advanceOnSource = null; }
      const value = key === sourceKeys[3] ? meta : sources[key];
      if (value instanceof Error) throw value;
      return Response.json({ result: value === undefined || value === null ? null : JSON.stringify(value) });
    };
    handler = (await import('../api/mcp.ts')).mcpHandler;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch; Date.now = originalNow;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  it('opens once, reuses normalized filters and stores the canonical original before summary or projection', async () => {
    const bundle = fixture();
    const first = await invoke(bundle.deps); await invoke(bundle.deps);
    assert.equal(bundle.pipe.count, 1, 'one meaningful opening allocation');
    const token = envelope(first).panelRequest.token;
    assert.equal(envelope(first).panelRequest.panel, 'disasters');
    assert.equal(first.body.result._meta['worldmonitor/usage'].remaining, 49);
    assert.equal(fetched.length, 4);
    const summary = await invoke(bundle.deps, { panel_request: token, summary: true });
    assert.equal(envelope(summary).projection.data.earthquakes.earthquakes.count, 2);
    const whole = await invoke(bundle.deps, { panel_request: token, jmespath: '@' });
    assert.equal(envelope(whole).projection.data.events.events.length, 2);
    const original = JSON.parse(cachedEntries(bundle)[0][1]);
    assert.equal(original.value.data.events.events.length, 2); assert.equal(typeof original.reuseUntil, 'number');
    assert.equal(fetched.length, 4);
    await invoke(bundle.deps, { dataset: ['other', 'earthquakes', 'other'], min_magnitude: 5 });
    await invoke(bundle.deps, { dataset: ['earthquakes', 'other'], min_magnitude: 5, limit: 30, panel_request: token });
    assert.equal(fetched.length, 8, 'new filters use one additional logical execution');
    assert.equal(bundle.pipe.count, 1);
    for (const [limit, expected] of [[0, 2], [-2, 2], [1.9, 1], [0.5, 0]]) {
      assert.equal(envelope(await invoke(bundle.deps, { limit, panel_request: token })).data.earthquakes.earthquakes.length, expected);
    }
    assert.equal(bundle.pipe.count, 1);
  });
  it('keeps news scope exact and standalone refresh UUID retries stable', async () => {
    const bundle = fixture(); const receipt = await news(bundle);
    for (const limit of [100, 20, 1]) {
      const args = { dataset: ['other'], limit, panel_request: receipt.token };
      await invoke(bundle.deps, args); await invoke(bundle.deps, { ...args, summary: true });
    }
    assert.equal(fetched.length, 12); assert.equal(bundle.pipe.count, 1);
    for (const args of [{}, { dataset: ['other'], limit: 0 }, { dataset: ['other'], limit: 20, active_only: false }, { dataset: ['other', 'other'], limit: 20 }]) {
      assert.equal((await invoke(bundle.deps, { ...args, panel_request: receipt.token })).body.error?.code, -32602);
    }
    const request_id = '550E8400-E29B-41D4-A716-446655440000';
    const fresh = envelope(await invoke(bundle.deps, { refresh: true, request_id })).panelRequest;
    assert.equal(envelope(await invoke(bundle.deps, { refresh: true, request_id: request_id.toLowerCase() })).panelRequest.token, fresh.token);
    assert.equal(bundle.pipe.count, 2);
    assert.equal((await invoke(bundle.deps, { panel_request: fresh.token, refresh: true, request_id })).body.error?.code, -32602);
  });
  it('rejects paid invalid fields and cross-family/owner/expired/removed receipts before source reads', async () => {
    const bundle = fixture();
    for (const args of [{ dataset: 'other' }, { dataset: ['wrong'] }, { min_magnitude: '2' }, { active_only: 'true' }, { limit: '2' }, { refresh: true }, { request_id: 'bad' }, { extra: true }]) {
      assert.equal((await invoke(bundle.deps, args)).body.error?.code, -32602, JSON.stringify(args));
    }
    assert.equal(bundle.pipe.count, 0); assert.equal(fetched.length, 0);
    const first = envelope(await invoke(bundle.deps)).panelRequest;
    const country = await admitCountryPanel(context, budget, bundle.pipe.pipeline, { country_code: 'US' });
    const market = await admitMarketPanel(context, budget, bundle.pipe.pipeline, {});
    for (const panel_request of ['forged', country.token, market.token]) assert.equal((await invoke(bundle.deps, { panel_request })).body.error?.code, -32602);
    await assert.rejects(authorizePanelRead({ ...context, userId: 'foreign' }, bundle.pipe.pipeline, 'get_natural_disasters', {}, first.token));
    await assert.rejects(authorizePanelRead(context, bundle.pipe.pipeline, 'get_market_data', {}, first.token));
    now = Date.parse(first.expiresAt);
    assert.equal((await invoke(bundle.deps, { panel_request: first.token })).body.error?.code, -32602); now = start;
    for (const key of bundle.pipe.store.keys()) if (key.includes(':disasters:disasters:') && !key.includes(':data:')) bundle.pipe.store.delete(key);
    assert.equal((await invoke(bundle.deps, { panel_request: first.token })).response.status, 503);
    assert.equal(fetched.length, 4);
  });
  for (const [label, mutate, dataset] of [
    ['missing fire list', () => { sources[sourceKeys[1]].data = {}; }, ['wildfires']],
    ['malformed fire row', () => { sources[sourceKeys[1]].data.fireDetections.push(null); }, ['wildfires']],
    ['Canadian failure', () => { sources[sourceKeys[1]].data._cwfisState = 'failed'; }, ['wildfires']],
    ['partial FIRMS', () => { sources[sourceKeys[1]].data._firmsPartial = true; }, ['wildfires']],
    ['BC error', () => { sources[sourceKeys[1]].data._bcErrorCode = 'BC_WILDFIRE_SOURCE_FAILED'; }, ['wildfires']],
    ['public unavailable', () => { sources[sourceKeys[1]].data.upstreamUnavailable = true; }, ['wildfires']],
    ['western Pacific unavailable', () => { sources[sourceKeys[2]].data.westernPacific.dataAvailable = false; }, ['other']],
    ['blocked regional preflight', () => { sources[sourceKeys[2]].data.westernPacific.sourceDecisions = [{ source: 'JMA RSMC Tokyo', status: 'blocked', reason: 'EXPERIMENTAL_CAP_NOT_OPERATIONAL', requestCount: 0 }]; }, ['other']],
    ['HKO unavailable', () => { sources[sourceKeys[2]].data.hkoWarnings.dataAvailable = false; }, ['other']],
    ['seismology source degraded', () => { meta.sourceState = 'degraded'; meta.errorCode = 'EARTHQUAKE_UPSTREAM_INCOMPLETE'; }, ['earthquakes']],
    ['missing seismology metadata', () => { meta = null; }, ['other']],
    ['seismology failed sources', () => { meta.failedSources = ['nrcan']; }, ['earthquakes']],
    ['malformed retained indexes', () => { sources[sourceKeys[2]].data.eonetRetention = { retainedUntil: now + 5000, eventIndexes: [9] }; }, ['other']],
    ['failed source read', () => { sources[sourceKeys[1]] = new Error('controlled'); }, ['wildfires']],
    ['future publication', () => { sources[sourceKeys[1]]._seed.fetchedAt += 1; }, ['wildfires']],
    ['legacy unknown clock', () => { sources[sourceKeys[1]] = sources[sourceKeys[1]].data; }, ['wildfires']],
  ]) {
    it(`keeps ${label} readable but retryable in the same news admission`, async () => {
      const bundle = fixture(); const receipt = await news(bundle); mutate();
      const args = { dataset, limit: 20, panel_request: receipt.token };
      const first = await invoke(bundle.deps, args); assert.equal(first.body.error, undefined);
      sources = payload(); meta = { fetchedAt: now, sourceState: 'ok' };
      const recovered = await invoke(bundle.deps, args); assert.equal(recovered.body.error, undefined);
      assert.equal(fetched.length, 8, 'nonreusable observations must not pin recovery');
      await invoke(bundle.deps, args); assert.equal(fetched.length, 8); assert.equal(bundle.pipe.count, 1);
    });
  }
  it('does not let an unrequested failed source hide filtering or prevent healthy requested reuse', async () => {
    const bundle = fixture(); sources[sourceKeys[1]] = new Error('unused fire source');
    const first = await invoke(bundle.deps, { dataset: ['earthquakes'], min_magnitude: 5 });
    assert.deepEqual(envelope(first).data.earthquakes.earthquakes.map(row => row.id), ['high']);
    const token = envelope(first).panelRequest.token;
    await invoke(bundle.deps, { dataset: ['earthquakes'], min_magnitude: 5, panel_request: token });
    assert.equal(fetched.length, 4); assert.equal(bundle.pipe.count, 1);
  });
  it('narrows healthy lists independently when a requested different list contains a malformed row', async () => {
    const bundle = fixture(); sources[sourceKeys[1]].data.fireDetections.push(null);
    const first = await invoke(bundle.deps, { min_magnitude: 5, active_only: true, limit: 1 });
    assert.deepEqual(envelope(first).data.earthquakes.earthquakes.map(row => row.id), ['high']);
    assert.deepEqual(envelope(first).data.events.events.map(row => row.id), ['eonet']);
    assert.deepEqual(envelope(first).data.fires.fireDetections, sources[sourceKeys[1]].data.fireDetections);
    await invoke(bundle.deps, { min_magnitude: 5, active_only: true, limit: 1, panel_request: envelope(first).panelRequest.token });
    assert.equal(fetched.length, 8); assert.equal(bundle.pipe.count, 1);
  });
  for (const expired of [false, true]) {
    it(`projects ${expired ? 'expired' : 'active'} retained EONET events despite a malformed neighbor and preserves recovery`, async () => {
      const bundle = fixture(); const receipt = await news(bundle);
      sources[sourceKeys[2]].data.events.push(null);
      sources[sourceKeys[2]].data.eonetRetention = { retainedUntil: now + (expired ? -1 : 5_000), eventIndexes: [0] };
      const args = { dataset: ['other'], limit: 20, panel_request: receipt.token };
      const first = await invoke(bundle.deps, args);
      assert.equal(first.body.error, undefined);
      assert.deepEqual(envelope(first).data.events.events, expired
        ? [{ id: 'gdacs', magnitude: 2, closed: true }, null]
        : sources[sourceKeys[2]].data.events);
      assert.equal(Object.hasOwn(envelope(first).data.events, 'eonetRetention'), false, 'private retention must not escape the projection');
      assert.equal(cachedEntries(bundle).length, 0, 'malformed neighbors remain retryable');
      sources = payload();
      const recovered = await invoke(bundle.deps, args);
      assert.deepEqual(envelope(recovered).data.events.events.map(row => row.id), ['eonet', 'gdacs']);
      assert.equal(fetched.length, 8);
      await invoke(bundle.deps, args);
      assert.equal(fetched.length, 8, 'healthy recovery replays without another source read');
      assert.equal(bundle.pipe.count, 1);
    });
  }
  it('rechecks the original EONET deadline after lookup and does not extend it with rounded cache TTL', async () => {
    const bundle = fixture(); const receipt = await news(bundle);
    const retainedUntil = start + 2_550;
    sources[sourceKeys[2]].data.eonetRetention = { retainedUntil, eventIndexes: [0] };
    const args = { dataset: ['other'], limit: 20, panel_request: receipt.token };
    await invoke(bundle.deps, args);
    const set = bundle.pipe.ops.flat().find(command => command[0] === 'SET' && command[1].includes(':data:'));
    assert.equal(Number(set[4]), 2, 'floor remaining TTL rather than round beyond original deadline');
    now = retainedUntil;
    const next = await invoke(bundle.deps, args);
    assert.deepEqual(envelope(next).data.events.events.map(row => row.id), ['gdacs']);
    assert.equal(fetched.length, 8); assert.equal(bundle.pipe.count, 1);
  });
  it('rechecks source age during read, cached lookup and delayed writes', async () => {
    const bundle = fixture(); const receipt = await news(bundle);
    const deadline = start + 2_000;
    meta.fetchedAt = deadline - 30 * 60_000;
    const args = { dataset: ['other'], limit: 20, panel_request: receipt.token };
    await invoke(bundle.deps, args);
    const original = bundle.deps.redisPipeline;
    bundle.deps.redisPipeline = async (commands, ...options) => {
      const result = await original(commands, ...options);
      if (commands.some(command => command[0] === 'GET' && String(command[1]).includes(':data:'))) now = deadline + 1;
      return result;
    };
    const aged = await invoke(bundle.deps, args); assert.equal(envelope(aged).stale, true);
    assert.equal(fetched.length, 8);
    bundle.deps.redisPipeline = original; now = start; meta = { fetchedAt: start, sourceState: 'ok' };
    advanceOnSource = start + 31 * 60_000;
    const other = fixture(); await news(other); now = start;
    await invoke(other.deps, { dataset: ['other'], limit: 20 });
    assert.equal(cachedEntries(other).length, 0, 'read completion cannot extend original source age');
  });
  it('treats legacy and malformed cached entries as misses without changing the allocation', async () => {
    const bundle = fixture(); const receipt = await news(bundle);
    const args = { dataset: ['other'], limit: 20, panel_request: receipt.token };
    await invoke(bundle.deps, args);
    const [key, raw] = cachedEntries(bundle)[0]; const wrapper = JSON.parse(raw);
    for (const value of [wrapper.value, { value: wrapper.value, reuseUntil: 'future' }, { value: wrapper.value, reuseUntil: now }, { value: null, reuseUntil: now + 1000 }, { value: { ...wrapper.value, data: {} }, reuseUntil: now + 1000 }]) {
      bundle.pipe.store.set(key, JSON.stringify(value)); const before = fetched.length;
      await invoke(bundle.deps, args); assert.equal(fetched.length, before + 4);
    }
    bundle.pipe.store.set(key, 'not-json');
    const before = fetched.length; await invoke(bundle.deps, args); assert.equal(fetched.length, before + 4);
    assert.equal(bundle.pipe.count, 1);
  });
  it('declines subsecond saves and delayed writes cannot extend source reuse', async () => {
    const bundle = fixture(); const receipt = await news(bundle);
    const args = { dataset: ['wildfires'], limit: 20, panel_request: receipt.token };
    sources[sourceKeys[1]]._seed.fetchedAt = now - 7_200_000 + 999;
    await invoke(bundle.deps, args); assert.equal(cachedEntries(bundle).length, 0);
    await invoke(bundle.deps, args); assert.equal(fetched.length, 8);
    const deadline = now + 2_550;
    sources[sourceKeys[1]]._seed.fetchedAt = deadline - 7_200_000;
    const pipeline = bundle.deps.redisPipeline;
    let delay = true;
    bundle.deps.redisPipeline = async (commands, ...options) => {
      if (delay && commands.some(command => command[0] === 'SET' && String(command[1]).includes(':data:'))) { now = deadline + 1; delay = false; }
      return pipeline(commands, ...options);
    };
    await invoke(bundle.deps, args); assert.equal(cachedEntries(bundle).length, 1, 'delayed optional write retains an absolute expiry');
    await invoke(bundle.deps, args); assert.equal(fetched.length, 16, 'delayed cache record is not a reusable snapshot');
    assert.equal(bundle.pipe.count, 1);
  });
  it('counts wrapper bytes in the optional cache budget and forbids a generic save bypass', async () => {
    const bundle = fixture(); const receipt = await news(bundle);
    const read = await authorizePanelRead(context, bundle.pipe.pipeline, 'get_natural_disasters', { dataset: ['earthquakes'], limit: 20 }, receipt.token);
    const value = { cached_at: new Date(now).toISOString(), stale: false, data: { earthquakes: { earthquakes: [] } }, padding: '' };
    value.padding = 'x'.repeat(524288 - Buffer.byteLength(JSON.stringify(value)));
    assert.equal(Buffer.byteLength(JSON.stringify(value)), 524288);
    await read.save(value); assert.equal(cachedEntries(bundle).length, 0);
    await read.saveNaturalDisasters({ value, reuseUntil: now + 10_000 }); assert.equal(cachedEntries(bundle).length, 0, 'wrapper overhead must not escape the cache budget');
    value.padding = value.padding.slice(0, -100);
    await read.saveNaturalDisasters({ value, reuseUntil: now + 10_000 }); assert.equal(cachedEntries(bundle).length, 1);
    assert.ok(Buffer.byteLength(cachedEntries(bundle)[0][1]) <= 524288);
  });
  it('caps durable uncached work at 64 and preserves quota, revocation and entitlement controls', async () => {
    const bundle = fixture(); const first = await invoke(bundle.deps); const token = envelope(first).panelRequest.token;
    for (let index = 1; index < 64; index++) assert.equal((await invoke(bundle.deps, { min_magnitude: index, panel_request: token })).body.error, undefined);
    assert.equal((await invoke(bundle.deps, { min_magnitude: 100, panel_request: token })).response.status, 429);
    assert.equal(fetched.length, 64 * 4); assert.equal(bundle.pipe.count, 1);
    assert.equal((await invoke(bundle.deps, { panel_request: token })).body.error, undefined);
    bundle.deps.getEntitlements = async () => ({ features: { tier: 1, mcpAccess: false } });
    assert.equal((await invoke(bundle.deps, { panel_request: token })).response.status, 403);
    bundle.deps.validateProMcpToken = async () => null;
    assert.equal((await invoke(bundle.deps, { panel_request: token })).response.status, 401);
    assert.equal((await invoke(fixture({ pipelineOpts: { initialCount: 50 } }).deps)).response.status, 429);
    assert.equal((await invoke(fixture({ pipelineOpts: { throwOnEval: true } }).deps)).response.status, 503);
    assert.equal(fetched.length, 64 * 4);
  });
  it('shows independently read current usage only after authorization and omits unknown counters', async () => {
    const bundle = fixture(); const token = envelope(await invoke(bundle.deps)).panelRequest.token;
    const key = dailyCounterKey(context.userId, new Date(now)); const pipeline = bundle.deps.redisPipeline;
    let counter = '2'; let reads = 0;
    bundle.deps.redisPipeline = async (commands, ...options) => {
      if (commands.length === 1 && commands[0][0] === 'GET' && commands[0][1] === key) { reads++; return [{ result: counter }]; }
      return pipeline(commands, ...options);
    };
    assert.equal((await invoke(bundle.deps, { panel_request: token })).body.result._meta['worldmonitor/usage'].remaining, 48);
    counter = null;
    assert.equal((await invoke(bundle.deps, { panel_request: token })).body.result._meta?.['worldmonitor/usage'], undefined);
    await invoke(bundle.deps, { panel_request: 'forged' }); assert.equal(reads, 2); assert.equal(fetched.length, 4); assert.equal(bundle.pipe.count, 1);
  });
  it('preserves healthy API/free coercions and ordinary per-call counters but rejects new paid controls', async () => {
    for (const entitlement of [
      { planKey: 'api-starter', features: { tier: 1, mcpAccess: true, apiAccess: true, planLimits: { apiCallsPerDay: 1000, mcpCallsPerDay: 'shared-api-budget' } }, validUntil: now + 86400000 },
      { planKey: 'free', features: { tier: 0, mcpAccess: false }, validUntil: now + 86400000 },
    ]) {
      const bundle = fixture({ getEntitlements: async () => entitlement });
      const first = await invoke(bundle.deps, { dataset: 'WILDFIRES', limit: '1', active_only: 'true', extra: true });
      assert.equal(first.body.error, undefined); assert.equal(envelope(first).panelRequest, undefined);
      assert.equal(envelope(first).data.fires.fireDetections.length, 1);
      await invoke(bundle.deps, { dataset: 'WILDFIRES', limit: '1', active_only: 'true' }); assert.equal(bundle.pipe.count, 2);
      for (const args of [{ refresh: false }, { request_id: crypto.randomUUID() }, { panel_request: 'forged' }]) assert.equal((await invoke(bundle.deps, args)).body.error?.code, -32602);
      assert.equal(bundle.pipe.count, 2);
    }
  });
});
