import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HMAC_SECRET, callBody, makeProDeps, proReq } from './helpers/mcp-pro-deps.mjs';
import { admitCountryPanel, authorizePanelRead, PANEL_READ_LIMIT } from '../api/mcp/panel-requests.ts';
import { countryActivityQueries } from '../shared/country-activity-query.ts';
import { dailyCounterKey, envPrefix } from '../server/_shared/pro-mcp-token.ts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const context = { kind: 'pro', userId: 'user_pro_xyz', mcpTokenId: 'k57mcptokenid' };
const budget = { allowance: 'mcp', limit: 50 };
const energy = { section: 'energy', arguments: { country_code: 'US' } };
async function readPanel(...args) {
  const read = await authorizePanelRead(...args);
  await read.reserveUncachedRead();
  return read;
}
describe('paid country workflow through the MCP handler', () => {
  let handler;
  let fetched;
  beforeEach(async () => {
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
    fetched = [];
    globalThis.fetch = async url => {
      fetched.push(String(url));
      const parsed = new URL(url);
      return Response.json(parsed.pathname === '/api/bootstrap'
        ? { data: { [parsed.searchParams.get('keys')]: { available: true } }, missing: [] }
        : { countryCode: 'US', available: true });
    };
    handler = (await import('../api/mcp.ts')).mcpHandler;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });
  const invoke = async (deps, name, args) => {
    const response = await handler(proReq('POST', callBody(name, args)), deps);
    return { response, body: await response.json() };
  };
  it('charges concurrent opens once, includes internal loads, replays ready data and charges explicit refresh', async () => {
    const { deps, pipe } = makeProDeps();
    const opened = await Promise.all(Array.from({ length: 10 }, () => invoke(deps, 'open_country_brief', { country_code: 'US' })));
    assert.equal(pipe.count, 1);
    const receipt = opened[0].body.result.structuredContent.panelRequest;
    assert.equal(receipt.usage.remaining, 49);
    assert.equal(opened.filter(item => !item.body.result.structuredContent.panelRequest.reused).length, 1);
    const read = await invoke(deps, 'get_country_brief_section', { ...energy, panel_request: receipt.token });
    assert.equal(read.body.result.structuredContent.state, 'ready');
    await invoke(deps, 'get_country_brief_section', { panel_request: receipt.token, arguments: { country_code: 'US' }, section: 'energy' });
    assert.equal(fetched.length, 1);
    assert.equal(pipe.count, 1);
    const request_id = crypto.randomUUID();
    const refreshed = await invoke(deps, 'open_country_brief', { country_code: 'US', refresh: true, request_id });
    await invoke(deps, 'open_country_brief', { country_code: 'US', refresh: true, request_id });
    assert.equal(pipe.count, 2);
    assert.equal(refreshed.body.result.structuredContent.panelRequest.usage.remaining, 48);
    await invoke(deps, 'get_country_brief_section', { ...energy, panel_request: refreshed.body.result.structuredContent.panelRequest.token });
    assert.equal(fetched.length, 2);
  });
  it('preserves the deployed country token and paid marker namespace across the news extension', async () => {
    const { pipe } = makeProDeps();
    const now = Date.UTC(2026, 9, 2, 12);
    const grant = await admitCountryPanel(context, budget, pipe.pipeline, { country_code: 'US' }, now);
    const [country, window, expiry] = grant.token.split('.');
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(HMAC_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const bytes = await crypto.subtle.sign('HMAC', key, encoder.encode(`country-panel:${envPrefix()}:${context.userId}:${country}:${window}:${expiry}`));
    const signature = Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
    assert.equal(grant.token, `${country}.${window}.${expiry}.${signature}`);
    assert.ok(pipe.ops.flat().some(command => command[0] === 'EVAL' && String(command[5]).includes(`:country:US:${window}`)));
    await readPanel(context, pipe.pipeline, 'get_country_brief_section', energy, grant.token, now);
    assert.equal(pipe.count, 1);
  });
  it('includes a full country reader graph and ten exposure/dependency sectors in one charge', async () => {
    const { deps, pipe } = makeProDeps();
    const opened = await invoke(deps, 'open_country_brief', { country_code: 'US' });
    const token = opened.body.result.structuredContent.panelRequest.token;
    const readers = [
      ...['facts', 'energy', 'maritime', 'risk', 'stock', 'defense'].map(section => [section, { country_code: 'US' }]),
      ...['food', 'demographics', 'resilience', 'factors'].map(section => [section, { countryCode: 'US' }]),
      ...['products', 'commodities'].map(section => [section, { iso2: 'US' }]),
      ['markets', { category: 'country:US', page_size: 5 }],
      ['debt', {}], ['flows', { reporter_code: '842' }], ['tariffs', { reporting_country: '840' }],
      ['housing', { keys: 'bisDsr,bisPropertyResidential,bisPropertyCommercial' }],
      ['imf', { keys: 'imfMacro,imfGrowth,imfLabor,imfExternal' }],
      ['bypass', { chokepointId: 'hormuz' }],
      ['production', { commodity: 'copper', iso2: '', stage: '' }],
      ...['27', '84', '85', '87', '30', '72', '39', '29', '10', '62'].flatMap(hs2 => [['exposure', { iso2: 'US', hs2 }], ['dependency', { iso2: 'US', hs2 }]]),
    ];
    for (const [section, args] of readers) {
      const read = await invoke(deps, 'get_country_brief_section', { section, arguments: args, panel_request: token });
      assert.equal(read.body.result?.structuredContent?.state, 'ready', `included reader ${section}`);
    }
    assert.equal(fetched.length, readers.length + 5);
    assert.equal(pipe.count, 1);
    for (const name of ['get_country_brief', 'get_country_coverage']) {
      const read = await readPanel(context, pipe.pipeline, name, { country_code: 'US' }, token);
      await read.save({ countryCode: 'US', countryName: 'United States', brief: 'Controlled assessment', model: 'fixture', generatedAt: Date.now(), sources: [], groundingStories: [], digestCoverage: { state: 'complete', servedStale: false } });
      assert.equal((await readPanel(context, pipe.pipeline, name, { country_code: 'US' }, token)).cached.countryCode, 'US');
    }
    assert.equal(pipe.count, 1);
  });
  it('includes Atlas detail reads in one allocation and refuses another country or asset identity', async () => {
    const { deps, pipe } = makeProDeps();
    const opened = await invoke(deps, 'open_country_brief', { country_code: 'US' });
    const panel_request = opened.body.result.structuredContent.panelRequest.token;
    let foreign = false;
    let mismatched = false;
    globalThis.fetch = async url => {
      const parsed = new URL(url);
      fetched.push(String(url));
      assert.equal(parsed.searchParams.has('country_code'), false, 'host country binding is not sent to the RPC');
      const id = parsed.searchParams.get('pipelineId') ?? parsed.searchParams.get('facilityId') ?? parsed.searchParams.get('shortageId');
      const asset = { id: mismatched ? 'wrong' : id, country: foreign ? 'CN' : 'US', fromCountry: 'CA', toCountry: foreign ? 'CN' : 'US', transitCountries: [] };
      return Response.json({ pipeline: asset, facility: asset, shortage: asset, unavailable: false });
    };
    for (const [section, key] of [['pipelineDetail', 'pipelineId'], ['facilityDetail', 'facilityId'], ['shortageDetail', 'shortageId']]) {
      const args = { section, arguments: { country_code: 'US', [key]: 'controlled' }, panel_request };
      assert.equal((await invoke(deps, 'get_country_brief_section', args)).body.result?.structuredContent?.state, 'ready');
      const count = fetched.length;
      assert.equal((await invoke(deps, 'get_country_brief_section', { ...args, arguments: { ...args.arguments, country_code: 'CN' } })).body.error?.code, -32602);
      assert.equal(fetched.length, count);
      foreign = true;
      args.arguments[key] = 'foreign';
      assert.equal((await invoke(deps, 'get_country_brief_section', args)).body.result?.structuredContent?.state, 'unavailable');
      foreign = false; mismatched = true;
      args.arguments[key] = 'mismatch';
      assert.equal((await invoke(deps, 'get_country_brief_section', args)).body.result?.structuredContent?.state, 'unavailable');
      mismatched = false;
    }
    assert.equal(pipe.count, 1);
  });
  it('includes country flight, AIS and roster reads in one allocation and denies a different viewport', async () => {
    globalThis.fetch = async url => {
      fetched.push(String(url));
      const path = new URL(url).pathname;
      return Response.json(path.endsWith('list-military-flights') ? { flights: [{ id: 'controlled' }] }
        : path.endsWith('get-vessel-snapshot') ? { dataAvailable: true, snapshot: { snapshotAt: Date.now(), status: { connected: true } } }
          : { report: { vessels: [] } });
    };
    const { deps, pipe } = makeProDeps();
    const opened = await invoke(deps, 'open_country_brief', { country_code: 'US' });
    const panel_request = opened.body.result.structuredContent.panelRequest.token;
    const bounds = countryActivityQueries('US')[0];
    for (const section of ['flights', 'vessels', 'fleet']) {
      const args = section === 'flights' ? bounds : {};
      const read = await invoke(deps, 'get_country_brief_section', { section, arguments: args, panel_request });
      assert.equal(read.body.result?.structuredContent?.state, 'ready', section);
      assert.equal(pipe.count, 1);
    }
    const oversized = await invoke(deps, 'get_country_brief_section', { section: 'vessels', arguments: bounds, panel_request });
    assert.equal(oversized.body.error?.code, -32602);
    const fetchedBefore = fetched.length;
    const denied = await invoke(deps, 'get_country_brief_section', { section: 'flights', arguments: countryActivityQueries('CN')[0], panel_request });
    assert.equal(denied.body.error?.code, -32602);
    assert.equal(fetched.length, fetchedBefore);
    assert.equal(pipe.count, 1);
    for (const argumentsValue of [{ ...bounds, page_size: 1000 }, { ...bounds, operator: 'MILITARY_OPERATOR_USAF' }, { ...bounds, include_tankers: 'true' }]) {
      const rejected = await invoke(deps, 'get_country_brief_section', { section: 'flights', arguments: argumentsValue, panel_request });
      assert.equal(rejected.body.error?.code, -32602);
    }
  });
  it('accepts an empty completed flight continuation but rejects the provider failure sentinel', async () => {
    const { deps, pipe } = makeProDeps();
    const opened = await invoke(deps, 'open_country_brief', { country_code: 'US' });
    const panel_request = opened.body.result.structuredContent.panelRequest.token;
    const args = { section: 'flights', arguments: { ...countryActivityQueries('US')[0], cursor: '1' }, panel_request };
    globalThis.fetch = async () => Response.json({ flights: [], pagination: { nextCursor: '', totalCount: 1 } });
    assert.equal((await invoke(deps, 'get_country_brief_section', args)).body.result?.structuredContent?.state, 'ready');
    globalThis.fetch = async () => Response.json({ flights: [], pagination: { nextCursor: '', totalCount: 0 } });
    args.arguments.cursor = '2';
    assert.equal((await invoke(deps, 'get_country_brief_section', args)).body.result?.structuredContent?.state, 'unavailable');
    assert.equal(pipe.count, 1);
  });
  it('does not cache unavailable military observations within a paid country request', async () => {
    const { deps, pipe } = makeProDeps();
    const opened = await invoke(deps, 'open_country_brief', { country_code: 'US' });
    const panel_request = opened.body.result.structuredContent.panelRequest.token;
    globalThis.fetch = async url => { fetched.push(String(url)); return Response.json({ flights: [], dataAvailable: false }); };
    for (const section of ['flights', 'vessels', 'fleet']) {
      const argumentsValue = section === 'flights' ? countryActivityQueries('US')[0] : {};
      for (let i = 0; i < 2; i++) {
        const read = await invoke(deps, 'get_country_brief_section', { section, arguments: argumentsValue, panel_request });
        assert.equal(read.body.result?.structuredContent?.state, 'unavailable');
      }
    }
    assert.equal(fetched.length, 6);
    assert.equal(pipe.count, 1);
  });
  it('returns HTTP 429 with Retry-After at the read ceiling and does not fetch or charge again', async () => {
    const { deps, pipe } = makeProDeps();
    const opened = await invoke(deps, 'open_country_brief', { country_code: 'US' });
    const args = { ...energy, panel_request: opened.body.result.structuredContent.panelRequest.token };
    globalThis.fetch = async () => { fetched.push('outage'); return Response.json({ upstreamUnavailable: true }); };
    for (let i = 0; i < PANEL_READ_LIMIT; i++) await invoke(deps, 'get_country_brief_section', args);
    const denied = await invoke(deps, 'get_country_brief_section', args);
    assert.equal(denied.response.status, 429);
    assert.ok(Number(denied.response.headers.get('Retry-After')) > 0);
    assert.equal(fetched.length, PANEL_READ_LIMIT);
    assert.equal(pipe.count, 1);
  });
  it('permits an already paid request at the daily cap and denies a new refresh without dispatch', async () => {
    const { deps, pipe } = makeProDeps({ pipelineOpts: { initialCount: 49 } });
    const opened = await invoke(deps, 'open_country_brief', { country_code: 'US' });
    const token = opened.body.result.structuredContent.panelRequest.token;
    assert.equal((await invoke(deps, 'get_country_brief_section', { ...energy, panel_request: token })).response.status, 200);
    assert.equal((await invoke(deps, 'open_country_brief', { country_code: 'US' })).body.result.structuredContent.panelRequest.reused, true);
    const denied = await invoke(deps, 'open_country_brief', { country_code: 'US', refresh: true });
    assert.equal(denied.response.status, 429);
    assert.ok(denied.response.headers.get('Retry-After'));
    assert.equal(pipe.count, 50);
    assert.equal(fetched.length, 1);
  });
  it('retains current entitlement checks before returning a cached result', async () => {
    let revoked = false;
    const { deps } = makeProDeps({ getEntitlements: async () => ({ planKey: 'pro', features: { tier: 1, mcpAccess: !revoked }, validUntil: Date.now() + 86400000 }) });
    const opened = await invoke(deps, 'open_country_brief', { country_code: 'US' });
    const args = { ...energy, panel_request: opened.body.result.structuredContent.panelRequest.token };
    await invoke(deps, 'get_country_brief_section', args);
    revoked = true;
    const denied = await invoke(deps, 'get_country_brief_section', args);
    assert.equal(denied.response.status, 403);
    assert.equal(fetched.length, 1);
  });
  it('preserves weighted API billing and refuses panel tokens on API allowances', async () => {
    const { deps, pipe } = makeProDeps({ getEntitlements: async () => ({ planKey: 'api-starter', features: { tier: 1, mcpAccess: true, apiAccess: true, planLimits: { apiCallsPerDay: 1000, mcpCallsPerDay: 'shared-api-budget' } }, validUntil: Date.now() + 86400000 }) });
    const opened = await invoke(deps, 'open_country_brief', { country_code: 'US' });
    assert.equal(opened.body.result.structuredContent.panelRequest, undefined);
    await invoke(deps, 'get_country_brief_section', energy);
    assert.equal(pipe.count, 4);
    const denied = await invoke(deps, 'get_country_brief_section', { ...energy, panel_request: 'invalid' });
    assert.equal(denied.body.error.code, -32602);
    assert.equal(pipe.count, 4);
  });
  it('does not cache a failed section or refund its admitted work', async () => {
    const { deps, pipe } = makeProDeps();
    const opened = await invoke(deps, 'open_country_brief', { country_code: 'US' });
    const args = { ...energy, panel_request: opened.body.result.structuredContent.panelRequest.token };
    globalThis.fetch = async () => { fetched.push('failure'); return new Response('denied', { status: 403 }); };
    assert.equal((await invoke(deps, 'get_country_brief_section', args)).body.result.structuredContent.state, 'locked');
    await invoke(deps, 'get_country_brief_section', args);
    assert.equal(fetched.length, 2);
    assert.equal(pipe.count, 1);
    globalThis.fetch = async () => { fetched.push('outage'); return Response.json({ upstreamUnavailable: true }); };
    await invoke(deps, 'get_country_brief_section', args);
    await invoke(deps, 'get_country_brief_section', args);
    assert.equal(fetched.length, 4);
    const coverage = await readPanel(context, pipe.pipeline, 'get_country_coverage', { country_code: 'US' }, args.panel_request);
    await coverage.save({ countryCode: 'US', degraded: true });
    assert.equal((await readPanel(context, pipe.pipeline, 'get_country_coverage', { country_code: 'US' }, args.panel_request)).cached, undefined);
  });
  it('rejects another user, country, tool, custom assessment, reporter or forged signature before fetching', async () => {
    const { deps, pipe } = makeProDeps();
    const grant = await admitCountryPanel(context, budget, pipe.pipeline, { country_code: 'US' });
    const read = (ctx, name, args, token = grant.token) => readPanel(ctx, pipe.pipeline, name, args, token);
    await assert.rejects(read({ ...context, userId: 'other' }, 'get_country_brief_section', energy));
    await read(context, 'get_country_brief', { country_code: 'US', framework: 'Custom', allow_stale: true });
    for (const [name, args] of [
      ['get_country_brief_section', { section: 'energy', arguments: { country_code: 'UA' } }],
      ['get_country_brief_section', { section: 'flows', arguments: { reporter_code: '156' } }],
      ['get_country_brief_section', { section: 'flows', arguments: { reporter_code: '840' } }],
      ['get_country_brief_section', { section: 'production', arguments: { commodity: 'copper', iso2: 'CN' } }],
      ['get_country_brief_section', { section: 'markets', arguments: { category: 'country:UA', page_size: 5 } }],
      ['get_country_brief_section', { section: 'china', arguments: {} }],
      ['get_country_brief', { country_code: 'UA' }],
      ['get_country_coverage', { country_code: 'UA' }],
      ['get_market_data', {}],
    ]) await assert.rejects(read(context, name, args));
    await assert.rejects(read(context, 'get_country_brief_section', energy, grant.token.slice(0, -1) + (grant.token.endsWith('a') ? 'b' : 'a')));
    const invalid = await invoke(deps, 'get_country_brief_section', { ...energy, panel_request: 'forged' });
    assert.equal(invalid.body.error.code, -32602);
    assert.equal(pipe.count, 1);
    assert.equal(fetched.length, 0);
  });
  it('bounds failed retries, checks expiry, and fails closed when Redis cannot prove admission', async () => {
    const { pipe } = makeProDeps();
    const now = Date.UTC(2026, 9, 2, 12);
    const grant = await admitCountryPanel(context, budget, pipe.pipeline, { country_code: 'US' }, now);
    await assert.rejects(readPanel(context, pipe.pipeline, 'get_country_brief_section', energy, grant.token, Date.parse(grant.expiresAt)));
    for (let i = 0; i < PANEL_READ_LIMIT; i++) await readPanel(context, pipe.pipeline, 'get_country_brief_section', energy, grant.token, now);
    await assert.rejects(readPanel(context, pipe.pipeline, 'get_country_brief_section', energy, grant.token, now), error => error.code === 'reads');
    const outage = async () => { throw new Error('Redis outage'); };
    await assert.rejects(readPanel(context, outage, 'get_country_brief_section', energy, grant.token, now), error => error.code === 'backend');
    await assert.rejects(admitCountryPanel(context, budget, outage, { country_code: 'US' }, now), error => error.code === 'backend');
    assert.equal(fetched.length, 0);
  });
  it('reuses a still-valid preceding bucket but charges again after UTC reset', async () => {
    const { pipe } = makeProDeps();
    const now = Date.UTC(2026, 9, 2, 12, 4, 59);
    const first = await admitCountryPanel(context, budget, pipe.pipeline, { country_code: 'US' }, now);
    const repeat = await admitCountryPanel(context, budget, pipe.pipeline, { country_code: 'US' }, now + 2000);
    assert.equal(repeat.token, first.token);
    assert.equal(repeat.reused, true);
    assert.equal(pipe.count, 1);
    const midnight = Date.UTC(2026, 9, 3);
    const evening = await admitCountryPanel(context, budget, pipe.pipeline, { country_code: 'US' }, midnight - 1000);
    assert.equal(Date.parse(evening.expiresAt), midnight);
    const morning = await admitCountryPanel(context, budget, pipe.pipeline, { country_code: 'US' }, midnight + 1000);
    assert.equal(morning.reused, false);
    assert.equal(pipe.count, 3);
  });
  it('a refresh retry returns the original paid expiry and token without extending its lifetime', async () => {
    const { pipe } = makeProDeps();
    const now = Date.UTC(2026, 9, 2, 12);
    const args = { country_code: 'US', refresh: true, request_id: crypto.randomUUID() };
    const first = await admitCountryPanel(context, budget, pipe.pipeline, args, now);
    const retry = await admitCountryPanel(context, budget, pipe.pipeline, args, now + 60000);
    assert.equal(retry.token, first.token);
    assert.equal(retry.expiresAt, first.expiresAt);
    assert.equal(pipe.count, 1);
    await readPanel(context, pipe.pipeline, 'get_country_brief_section', energy, retry.token, now + 299999);
    await assert.rejects(readPanel(context, pipe.pipeline, 'get_country_brief_section', energy, retry.token, now + 300000), error => error.code === 'invalid');
  });
});

describe('one allocation per embedded panel', () => {
  let handler;
  let fetched;
  const invoke = async (deps, name, args = {}) => {
    const response = await handler(proReq('POST', callBody(name, args)), deps);
    return { response, body: await response.json() };
  };
  beforeEach(async () => {
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    fetched = [];
    globalThis.fetch = async url => {
      fetched.push(String(url));
      return Response.json({ categories: { world: { items: [] } }, coverage: { state: 'complete', servedStale: false }, generatedAt: 'controlled', brief: 'Controlled brief' });
    };
    handler = (await import('../api/mcp.ts')).mcpHandler;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });
  it('reserves one unit per registered panel root, even when its readers fan out or fail', async () => {
    const { TOOL_REGISTRY } = await import('../api/mcp/registry/index.ts');
    const roots = TOOL_REGISTRY.filter(tool => tool._uiResourceUri);
    assert.equal(roots.length, 12);
    for (const root of roots) {
      const { deps, pipe } = makeProDeps();
      const opened = await invoke(deps, root.name, ['open_country_brief', 'get_country_brief', 'get_country_risk'].includes(root.name) ? { country_code: 'US' } : {});
      assert.equal(pipe.count, 1, root.name);
      assert.notEqual(opened.response.status, 401, root.name);
      assert.notEqual(opened.response.status, 403, root.name);
      assert.notEqual(opened.response.status, 429, root.name);
      const shell = await handler(proReq('POST', { jsonrpc: '2.0', id: 101, method: 'resources/read', params: { uri: root._uiResourceUri } }), deps);
      await shell.json();
      assert.equal(pipe.count, 1, `${root.name} visual shell is uncharged`);
    }
  });
  it('shares a news snapshot across filtered opens, includes map loads and charges a retry-stable refresh once', async () => {
    const { deps, pipe } = makeProDeps();
    const first = await invoke(deps, 'open_news_dashboard', { map_layers: ['natural'] });
    const grant = first.body.result.structuredContent.panelRequest;
    assert.equal(grant.panel, 'news');
    assert.equal(grant.usage.remaining, 49);
    const second = await invoke(deps, 'open_news_dashboard', { country: 'US', query: 'trade' });
    assert.equal(pipe.count, 1);
    assert.equal(fetched.length, 1);
    assert.deepEqual(second.body.result.structuredContent.requestedView, { country: 'US', query: 'trade' });
    assert.equal(second.body.result.structuredContent.panelRequest.token, grant.token);
    const snapshot = await readPanel(context, pipe.pipeline, 'get_natural_disasters', { dataset: ['earthquakes', 'other'], limit: 100 }, grant.token);
    await snapshot.saveNaturalDisasters({
      value: { cached_at: new Date().toISOString(), stale: false, data: { earthquakes: { earthquakes: [] }, events: { events: [] } } },
      reuseUntil: Math.min(Date.now() + 60_000, Date.parse(grant.expiresAt)),
    });
    const loaded = await readPanel(context, pipe.pipeline, 'get_natural_disasters', { dataset: ['earthquakes', 'other'], limit: 100 }, grant.token);
    assert.deepEqual(loaded.cached.data.earthquakes.earthquakes, []);
    const result = await invoke(deps, 'get_natural_disasters', { dataset: ['earthquakes', 'other'], limit: 100, panel_request: grant.token });
    assert.deepEqual(result.body.result.structuredContent.data.earthquakes.earthquakes, []);
    assert.equal(pipe.count, 1);
    const request_id = crypto.randomUUID();
    const refresh = await invoke(deps, 'open_news_dashboard', { refresh: true, request_id });
    await invoke(deps, 'open_news_dashboard', { refresh: true, request_id });
    assert.equal(pipe.count, 2);
    assert.equal(fetched.length, 2);
    assert.equal(refresh.body.result.structuredContent.panelRequest.usage.remaining, 48);
    const fresh = await readPanel(context, pipe.pipeline, 'get_natural_disasters', { dataset: ['earthquakes', 'other'], limit: 100 }, refresh.body.result.structuredContent.panelRequest.token);
    assert.equal(fresh.cached, undefined);
  });
  it('reports the paid remaining allowance with a single-result panel', async () => {
    const { deps, pipe } = makeProDeps();
    const result = await invoke(deps, 'get_country_risk', { country_code: 'US' });
    assert.equal(result.body.result._meta['worldmonitor/usage'].remaining, 49);
    assert.equal(result.body.result._meta['worldmonitor/usage'].unit, 'requests');
    assert.match(result.body.result._meta['worldmonitor/usage'].resetsAt, /T00:00:00.000Z$/);
    assert.equal(pipe.count, 1);
  });
  it('keeps loaded data available at the cap but denies a new refresh before downstream work', async () => {
    const { deps, pipe } = makeProDeps({ pipelineOpts: { initialCount: 49 } });
    const first = await invoke(deps, 'open_news_dashboard');
    const grant = first.body.result.structuredContent.panelRequest;
    await invoke(deps, 'open_news_dashboard', { category: 'world' });
    await readPanel(context, pipe.pipeline, 'get_natural_disasters', { dataset: ['wildfires'], limit: 20 }, grant.token);
    const denied = await invoke(deps, 'open_news_dashboard', { refresh: true });
    assert.equal(denied.response.status, 429);
    assert.ok(denied.response.headers.get('Retry-After'));
    assert.equal(pipe.count, 50);
    assert.equal(fetched.length, 1);
  });
  it('rejects foreign-panel, user, arbitrary analysis and unbounded hazard access', async () => {
    const { deps, pipe } = makeProDeps();
    const news = (await invoke(deps, 'open_news_dashboard')).body.result.structuredContent.panelRequest;
    for (const [name, args] of [
      ['get_country_brief_section', energy], ['get_country_brief', { country_code: 'US' }],
      ['get_market_data', {}], ['analyze_news_headlines', { headlines: ['Controlled'] }],
      ['get_natural_disasters', { dataset: ['earthquakes'], limit: 0 }],
      ['get_natural_disasters', { dataset: ['earthquakes'], limit: 101 }],
      ['get_natural_disasters', { dataset: ['earthquakes'], limit: 20, active_only: true }],
      ['get_natural_disasters', { dataset: ['earthquakes', 'earthquakes'], limit: 20 }],
    ]) await assert.rejects(readPanel(context, pipe.pipeline, name, args, news.token));
    await assert.rejects(readPanel({ ...context, userId: 'other' }, pipe.pipeline, 'get_natural_disasters', { dataset: ['earthquakes'], limit: 20 }, news.token));
    const country = await admitCountryPanel(context, budget, pipe.pipeline, { country_code: 'US' });
    await assert.rejects(readPanel(context, pipe.pipeline, 'get_natural_disasters', { dataset: ['earthquakes'], limit: 20 }, country.token));
    assert.equal((await invoke(deps, 'open_news_dashboard', { panel_request: news.token, refresh: true })).body.error.code, -32602);
    assert.equal(pipe.count, 2);
    assert.equal(fetched.length, 1);
  });
  it('checks current entitlement before cache replay and does not reuse partial or failed news', async () => {
    let revoked = false;
    const { deps, pipe } = makeProDeps({ getEntitlements: async () => ({ planKey: 'pro', features: { tier: 1, mcpAccess: !revoked }, validUntil: Date.now() + 86400000 }) });
    await invoke(deps, 'open_news_dashboard');
    revoked = true;
    assert.equal((await invoke(deps, 'open_news_dashboard')).response.status, 403);
    assert.equal(fetched.length, 1);
    assert.equal(pipe.count, 1);
    revoked = false;
    const request_id = crypto.randomUUID();
    globalThis.fetch = async () => { fetched.push('partial'); return Response.json({ categories: {}, coverage: { state: 'partial' } }); };
    await invoke(deps, 'open_news_dashboard', { refresh: true, request_id });
    await invoke(deps, 'open_news_dashboard', { refresh: true, request_id });
    assert.equal(fetched.length, 3);
    assert.equal(pipe.count, 2);
  });
  it('preserves weighted API billing for news and hazard calls', async () => {
    const { deps, pipe } = makeProDeps({ getEntitlements: async () => ({ planKey: 'api-starter', features: { tier: 1, mcpAccess: true, apiAccess: true, planLimits: { apiCallsPerDay: 1000, mcpCallsPerDay: 'shared-api-budget' } }, validUntil: Date.now() + 86400000 }) });
    const first = await invoke(deps, 'open_news_dashboard');
    assert.equal(first.body.result.structuredContent.panelRequest, undefined);
    await invoke(deps, 'get_natural_disasters', { dataset: ['earthquakes'], limit: 20 });
    assert.equal(pipe.count, 3);
    assert.equal((await invoke(deps, 'get_natural_disasters', { dataset: ['earthquakes'], limit: 20, panel_request: 'forged' })).body.error.code, -32602);
    assert.equal(pipe.count, 3);
  });
});

describe('paid curated market panel through the MCP handler', () => {
  let handler;
  let fetched;
  let degraded;
  let sourceFailure;
  const invoke = async (deps, args = {}) => {
    const response = await handler(proReq('POST', callBody('get_market_data', args)), deps);
    return { response, body: await response.json() };
  };
  beforeEach(async () => {
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
    process.env.UPSTASH_REDIS_REST_URL = 'https://market-seed.invalid';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'controlled-token';
    fetched = [];
    degraded = false;
    sourceFailure = false;
    globalThis.fetch = async url => {
      assert.ok(String(url).startsWith('https://market-seed.invalid/get/'), 'curated cache only');
      if (!decodeURIComponent(String(url)).includes('market:')) return Response.json({ result: null });
      fetched.push(String(url));
      if (sourceFailure) throw new Error('controlled seed outage');
      if (decodeURIComponent(String(url)).includes('seed-meta:')) return Response.json({ result: JSON.stringify({ fetchedAt: Date.now() }) });
      return Response.json({ result: JSON.stringify({
        quotes: [{ symbol: 'AAPL', price: 100, change: 1 }, { symbol: 'MSFT', price: 200, change: 2 }],
        seededAt: new Date().toISOString(), rateLimited: degraded,
      }) });
    };
    handler = (await import('../api/mcp.ts')).mcpHandler;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });
  it('serves usable ordinary default market data within the dispatched text budget without changing its canonical snapshot', async testContext => {
    const now = 1787056200000;
    testContext.mock.timers.enable({ apis: ['Date'], now });
    const { readFileSync } = await import('node:fs');
    const { buildProducerBackedPhysicalComparisonFixture } = await import('./helpers/mcp-producer-fixtures.mjs');
    const { CACHE_TOOLS } = await import('../api/mcp/registry/cache-tools.ts');
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/jmespath-samples/fat-get-market-data.response.json', import.meta.url), 'utf8'));
    const physical = buildProducerBackedPhysicalComparisonFixture('ok');
    fixture.data['physical-premium'] = physical.premium;
    fixture.data['physical-divergence'] = physical.divergence;
    fixture.data.sectors.valuations = {"XLK": {"trailingPE": 20}, "XLF": {"trailingPE": 21}, "XLE": {"trailingPE": 22}, "XLV": {"trailingPE": 23}, "XLY": {"trailingPE": 24}, "XLI": {"trailingPE": 25}, "XLP": {"trailingPE": 26}, "XLU": {"trailingPE": 27}, "XLB": {"trailingPE": 28}, "XLRE": {"trailingPE": 29}, "XLC": {"trailingPE": 30}, "SMH": {"trailingPE": 31}};
    fixture.data.sectors.valuationCoverage = {"valuationCount": 12, "expectedValuationCount": 12, "currentValuationCount": 12, "sourceStatus": "ok", "source": "controlled_fixture", "fetchedAt": 1787056200000, "stale": false};
    const keyToSection = {"market:stocks-bootstrap:v1": "stocks-bootstrap", "market:commodities-bootstrap:v1": "commodities-bootstrap", "market:physical-premium:v1": "physical-premium", "market:physical-divergence:v1": "physical-divergence", "market:crypto:v1": "crypto", "market:sectors:v2": "sectors", "market:etf-flows:v1": "etf-flows", "market:gulf-quotes:v1": "gulf-quotes", "market:fear-greed:v1": "fear-greed"};
    const metadataKeys = ["seed-meta:market:stocks", "seed-meta:market:sectors"];
    const originalFetch = globalThis.fetch;
    const fixtureBefore = JSON.stringify(fixture);
    const reads = [];
    testContext.after(() => { globalThis.fetch = originalFetch; testContext.mock.timers.reset(); });
    const market = CACHE_TOOLS.find(tool => tool.name === 'get_market_data');
    assert.equal(typeof market?._postFilter, 'function');
    const expectedData = market._postFilter(structuredClone(fixture.data), { limit: 30 });
    assert.ok(expectedData['physical-divergence'], 'Healthy physical cohort must survive existing normalization');
    assert.equal(Object.hasOwn(expectedData['physical-divergence'], 'transitions'), false);
    for (const reading of expectedData['physical-divergence'].readings) assert.equal(reading.historyKey, reading.provenance.historyKey);
    globalThis.fetch = async (input, init) => {
      const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      const url = new URL(rawUrl);
      assert.equal(url.origin, 'https://market-seed.invalid');
      assert.ok(url.pathname.startsWith('/get/'));
      assert.equal(url.search, '');
      assert.equal((init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(), 'GET');
      assert.equal(init?.body, undefined);
      const key = decodeURIComponent(url.pathname.slice('/get/'.length));
      assert.ok(Object.hasOwn(keyToSection, key) || metadataKeys.includes(key), `Unplanned read ${key}`);
      reads.push(key);
      const value = metadataKeys.includes(key) ? { fetchedAt: now } : fixture.data[keyToSection[key]];
      assert.notEqual(value, undefined, `Missing controlled fixture ${key}`);
      return Response.json({ result: JSON.stringify(value) });
    };
    const { deps, pipe } = makeProDeps();
    const response = await handler(proReq('POST', callBody('get_market_data', {}, 100)), deps);
    const wire = await response.text();
    const body = JSON.parse(wire);
    assert.equal(response.status, 200);
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, 100);
    assert.equal(body.error, undefined);
    assert.equal(pipe.count, 1);
    assert.deepEqual(reads.slice().sort(), [...Object.keys(keyToSection), ...metadataKeys].sort());
    const stored = [...pipe.store].filter(([key]) => /:markets:.*:data:[a-f0-9]{64}$/.test(key));
    assert.equal(stored.length, 1, 'Healthy complete cohort must save its canonical original');
    const canonical = JSON.parse(stored[0][1]);
    assert.equal(canonical.stale, false);
    assert.equal(canonical.freshnessUnknown, undefined);
    assert.equal(canonical.transportCoverage, undefined);
    assert.equal(canonical.panelRequest, undefined);
    const lists = [['stocks-bootstrap','quotes'],['commodities-bootstrap','quotes'],['crypto','quotes'],['gulf-quotes','quotes'],['sectors','sectors'],['etf-flows','etfs']];
    for (const [section, list] of lists) assert.deepEqual(canonical.data[section][list], fixture.data[section][list].slice(0, 30));
    assert.deepEqual(canonical.data, expectedData);
    const savedSets = pipe.ops.flat().filter(cmd => cmd[0] === 'SET' && cmd[1] === stored[0][0]);
    assert.equal(savedSets.length, 1);
    assert.equal(savedSets[0][2], stored[0][1]);
    assert.equal(JSON.stringify(fixture), fixtureBefore);
    const value = body.result.structuredContent;
    const text = body.result.content[0].text;
    if (value._budget_exceeded === true) {
      assert.equal(value.budget_bytes, 131072);
      assert.ok(value.actual_bytes > 131072);
      testContext.diagnostic(JSON.stringify({ expectedCurrentFailure: 'actual dispatch budget replacement', actualBytes: value.actual_bytes, textBytes: Buffer.byteLength(text), outerWireBytes: Buffer.byteLength(wire), allocationCount: pipe.count, cacheReads: reads.length }));
    }
    assert.notEqual(value._budget_exceeded, true, 'Ordinary default must retain usable market data');
    assert.ok(Buffer.byteLength(text, 'utf8') <= 131072);
    assert.deepEqual(JSON.parse(text), value);
    assert.equal(value.transportCoverage.count_scope, 'post_filter_snapshot');
    for (const [section, list] of lists) {
      const originalRows = canonical.data[section][list], returnedRows = value.data[section][list];
      assert.ok(returnedRows.length > 0, section + ' retains useful whole rows');
      let lastOrdinal = -1;
      for (const row of returnedRows) {
        const ordinal = originalRows.findIndex(original => JSON.stringify(original) === JSON.stringify(row));
        assert.ok(ordinal > lastOrdinal, section + ' preserves whole original rows and series in source order');
        lastOrdinal = ordinal;
      }
      const coverage = value.transportCoverage.collections[section + '.' + list];
      assert.equal(coverage.original_count, originalRows.length);
      assert.equal(coverage.returned_count, returnedRows.length);
      assert.equal(coverage.omitted_count, originalRows.length - returnedRows.length);
    }
    for (const section of ['physical-premium', 'physical-divergence', 'fear-greed']) assert.deepEqual(value.data[section], canonical.data[section]);
    const snapshotValue = stored[0][1], readCount = reads.length;
    let reusedDefaultText;
    for (const args of [{}, { symbols: [], asset_class: [] }, { symbols: [' '] }, { jmespath: '' }, { jmespath: null }]) {
      const next = await (await handler(proReq('POST', callBody('get_market_data', args)), deps)).json();
      assert.equal(next.result.structuredContent._budget_exceeded, undefined);
      assert.equal(next.result.structuredContent.transportCoverage.count_scope, 'post_filter_snapshot');
      if (Object.keys(args).length === 0) reusedDefaultText = next.result.content[0].text;
      if (Object.hasOwn(args, 'jmespath')) assert.equal(next.result.content[0].text, reusedDefaultText, 'identity requests preserve fitted bytes and the reused signed receipt');
    }
    assert.equal(reads.length, readCount, 'normalized empty defaults reuse the saved canonical snapshot');
    for (const args of [{ limit: 30 }, { limit: 0 }, { summary: false }, { refresh: false }, { panel_request: value.panelRequest.token }]) {
      const beforeReads = reads.length;
      const next = await (await handler(proReq('POST', callBody('get_market_data', args)), deps)).json();
      assert.equal(next.result.structuredContent._budget_exceeded, true, JSON.stringify(args) + ' keeps the existing explicit response');
      if (args.panel_request) assert.equal(reads.length, beforeReads, 'the original reader reuses its snapshot without source reads');
    }
    const projectedCoverage = await (await handler(proReq('POST', callBody('get_market_data', { jmespath: 'transportCoverage' })), deps)).json();
    assert.equal(projectedCoverage.result.content[0].text, 'null', 'real projection bypasses default coverage presentation');
    assert.deepEqual(projectedCoverage.result.structuredContent, { projection: null });
    for (const args of [{ limit: 10 }, { limit: 1 }, { symbols: ['AAPL'] }, { asset_class: ['equity'] }, { summary: true }, { jmespath: 'data' }]) {
      const next = await (await handler(proReq('POST', callBody('get_market_data', args)), deps)).json();
      assert.equal(next.result.structuredContent.transportCoverage, undefined, 'explicit presentation is not fitted');
    }
    assert.equal(pipe.count, 1);
    assert.equal(pipe.store.get(stored[0][0]), snapshotValue);
  });
  it('shares one allocation across opens and filters, while refresh retries share their original allocation', async () => {
    const { deps, pipe } = makeProDeps();
    const first = await invoke(deps, { symbols: ['AAPL'], asset_class: ['equity'] });
    const receipt = first.body.result.structuredContent.panelRequest;
    assert.equal(receipt?.panel, 'markets');
    assert.equal(first.body.result._meta['worldmonitor/usage'].remaining, 49);
    assert.equal(pipe.count, 1);
    const next = await invoke(deps, { symbols: ['MSFT'], asset_class: ['equity'] });
    assert.equal(next.body.result.structuredContent.panelRequest.token, receipt.token);
    assert.equal(pipe.count, 1);
    assert.equal(next.body.result.structuredContent.data['stocks-bootstrap'].quotes[0].symbol, 'MSFT');
    const reads = fetched.length;
    await invoke(deps, { symbols: [' aapl ', 'AAPL'], asset_class: ['equity'], panel_request: receipt.token });
    assert.equal(fetched.length, reads);
    const request_id = crypto.randomUUID();
    const refreshed = await invoke(deps, { refresh: true, request_id, symbols: ['AAPL'], asset_class: ['equity'] });
    const replay = await invoke(deps, { refresh: true, request_id, symbols: ['AAPL'], asset_class: ['equity'] });
    assert.equal(pipe.count, 2);
    assert.equal(refreshed.body.result.structuredContent.panelRequest.token, replay.body.result.structuredContent.panelRequest.token);
    assert.equal(fetched.length, reads + 11);
  });
  it('caches the canonical result before summary and JMESPath presentation', async () => {
    const { deps, pipe } = makeProDeps();
    const summarized = await invoke(deps, { asset_class: ['equity'], summary: true });
    assert.equal(summarized.body.result.structuredContent.projection.data['stocks-bootstrap'].quotes.count, 2);
    const raw = await invoke(deps, { asset_class: ['equity'] });
    const token = raw.body.result.structuredContent.panelRequest.token;
    assert.equal(raw.body.result.structuredContent.data['stocks-bootstrap'].quotes.length, 2);
    const projected = await invoke(deps, { asset_class: ['equity'], panel_request: token, jmespath: 'data."stocks-bootstrap".quotes[*].symbol' });
    assert.deepEqual(projected.body.result.structuredContent, { projection: ['AAPL', 'MSFT'] });
    assert.equal(fetched.length, 11);
    assert.equal(pipe.count, 1);
  });
  it('reports current server allowance on authorized market receipt results without another allocation', async () => {
    const { deps, pipe } = makeProDeps();
    const key = dailyCounterKey(context.userId);
    const pipeline = deps.redisPipeline;
    let allowanceReads = 0;
    deps.redisPipeline = async (commands, ...options) => {
      if (commands.length === 1 && commands[0][0] === 'GET' && commands[0][1] === key) {
        allowanceReads++;
        return [{ result: String(pipe.count) }];
      }
      return pipeline(commands, ...options);
    };
    const opened = await invoke(deps, { asset_class: ['equity'] });
    const token = opened.body.result.structuredContent.panelRequest.token;
    const reads = fetched.length;
    const reused = await invoke(deps, { asset_class: ['equity'], panel_request: token });
    assert.equal(reused.body.result._meta?.['worldmonitor/usage']?.remaining, 49);
    assert.equal(allowanceReads, 1);
    assert.equal(pipe.count, 1);
    assert.equal(fetched.length, reads);
    await pipe.pipeline([['INCR', key]]);
    const projected = await invoke(deps, { asset_class: ['equity'], panel_request: token, jmespath: 'data."stocks-bootstrap".quotes[*].symbol' });
    assert.deepEqual(projected.body.result.structuredContent, { projection: ['AAPL', 'MSFT'] });
    assert.deepEqual(projected.body.result._meta['worldmonitor/usage'], {
      used: 2, limit: 50, remaining: 48,
      resetsAt: opened.body.result._meta['worldmonitor/usage'].resetsAt, unit: 'requests',
    });
    assert.equal(pipe.count, 2);
    assert.equal(fetched.length, reads);
    assert.equal(allowanceReads, 2);
    const resourceResponse = await handler(proReq('POST', {
      jsonrpc: '2.0', id: 987, method: 'resources/read', params: { uri: 'worldmonitor://account/mcp-allowance' },
    }), deps);
    const resource = await resourceResponse.json();
    const status = JSON.parse(resource.result.contents[0].text);
    assert.deepEqual(projected.body.result._meta['worldmonitor/usage'], {
      used: status.used, limit: status.limit, remaining: status.remaining, resetsAt: status.resetsAt, unit: 'requests',
    });
    assert.equal(allowanceReads, 3);
    assert.equal(pipe.count, 2);
  });
  it('omits unverified market receipt usage on missing or invalid counter replies without charging or repeating source work', async () => {
    const { deps, pipe } = makeProDeps();
    const key = dailyCounterKey(context.userId);
    const opened = await invoke(deps, { asset_class: ['equity'] });
    const token = opened.body.result.structuredContent.panelRequest.token;
    const pipeline = deps.redisPipeline;
    const reads = fetched.length;
    for (const [label, result] of [
      ['missing', [{ result: null }]], ['zero', [{ result: '0' }]], ['undefined', [{ result: undefined }]],
      ['negative', [{ result: '-1' }]], ['fractional', [{ result: '1.5' }]], ['blank', [{ result: ' ' }]],
      ['boolean', [{ result: true }]], ['unsafe integer', [{ result: '9007199254740992' }]],
      ['absent result', [{}]], ['empty pipeline', []], ['errored', [{ result: '1', error: 'outage' }]],
      ['transport unavailable', null],
    ]) {
      let allowanceReads = 0;
      deps.redisPipeline = async (commands, ...options) => {
        if (commands.length === 1 && commands[0][0] === 'GET' && commands[0][1] === key) {
          allowanceReads++;
          if (result === null) throw new Error('controlled outage');
          return result;
        }
        return pipeline(commands, ...options);
      };
      const response = await invoke(deps, { asset_class: ['equity'], panel_request: token });
      assert.equal(response.body.error, undefined, label);
      assert.equal(response.body.result.structuredContent.data['stocks-bootstrap'].quotes.length, 2, label);
      assert.equal(response.body.result._meta?.['worldmonitor/usage'], undefined, label);
      assert.equal(allowanceReads, 1, label);
      assert.equal(pipe.count, 1, label);
      assert.equal(fetched.length, reads, label);
    }
    let allowanceReads = 0;
    deps.redisPipeline = async (commands, ...options) => {
      if (commands.length === 1 && commands[0][0] === 'GET' && commands[0][1] === key) allowanceReads++;
      return pipeline(commands, ...options);
    };
    assert.equal((await invoke(deps, { asset_class: ['equity'], panel_request: 'forged' })).body.error?.code, -32602);
    assert.equal(allowanceReads, 0);
    assert.equal(pipe.count, 1);
  });
  it('accepts an uppercase refresh UUID and replays its lowercase spelling without another allocation', async () => {
    const { deps, pipe } = makeProDeps();
    const request_id = '550E8400-E29B-41D4-A716-446655440000';
    const first = await invoke(deps, { refresh: true, request_id, asset_class: ['equity'] });
    assert.equal(first.body.error, undefined);
    const second = await invoke(deps, { refresh: true, request_id: request_id.toLowerCase(), asset_class: ['equity'] });
    assert.equal(second.body.error, undefined);
    assert.equal(first.body.result.structuredContent.panelRequest.token, second.body.result.structuredContent.panelRequest.token);
    assert.equal(pipe.count, 1);
    assert.equal(fetched.length, 11);
  });
  it('canonicalizes refresh UUID identity for existing country and news admissions', async () => {
    const { pipe } = makeProDeps();
    const { admitNewsPanel } = await import('../api/mcp/panel-requests.ts');
    const request_id = '550E8400-E29B-41D4-A716-446655440000';
    const now = Date.UTC(2026, 9, 4, 12);
    for (const [admit, name, args, readArgs] of [
      [admitCountryPanel, 'get_country_brief_section', { country_code: 'US' }, energy],
      [admitNewsPanel, 'open_news_dashboard', {}, {}],
    ]) {
      const first = await admit(context, budget, pipe.pipeline, { ...args, refresh: true, request_id }, now);
      await readPanel(context, pipe.pipeline, name, readArgs, first.token, now);
      const replay = await admit(context, budget, pipe.pipeline, { ...args, refresh: true, request_id: request_id.toLowerCase() }, now + 60000);
      assert.equal(first.token, replay.token);
      assert.equal(first.expiresAt, replay.expiresAt);
    }
    assert.equal(pipe.count, 2);
    assert.equal(fetched.length, 0);
  });
  it('retains existing empty-symbol and numeric-limit filtering with canonical default reuse', async () => {
    const { deps, pipe } = makeProDeps();
    const first = await invoke(deps, { asset_class: ['equity'] });
    const token = first.body.result.structuredContent.panelRequest.token;
    for (const args of [{}, { limit: 30 }, { symbols: [] }, { symbols: [' ', ''] }]) {
      const result = await invoke(deps, { ...args, asset_class: ['equity'], panel_request: token });
      assert.equal(result.body.result.structuredContent.data['stocks-bootstrap'].quotes.length, 2);
    }
    assert.equal(fetched.length, 11);
    for (const [limit, expected] of [[-1, 2], [0, 2], [1.5, 1], [0.5, 0]]) {
      const result = await invoke(deps, { asset_class: ['equity'], limit, panel_request: token });
      assert.equal(result.body.result.structuredContent.data['stocks-bootstrap'].quotes.length, expected);
    }
    assert.equal(pipe.count, 1);
  });
  it('rejects invalid filters, refresh controls and foreign receipts before quota or source work', async () => {
    const { deps, pipe } = makeProDeps();
    for (const args of [{ unknown: true }, { symbols: 'AAPL' }, { symbols: [1] }, { asset_class: ['forex'] }, { limit: '1' }, { refresh: true }, { refresh: true, request_id: 'bad' }]) {
      assert.equal((await invoke(deps, args)).body.error?.code, -32602, JSON.stringify(args));
    }
    assert.equal(pipe.count, 0);
    assert.equal(fetched.length, 0);
    const first = await invoke(deps);
    const token = first.body.result.structuredContent.panelRequest.token;
    const reads = fetched.length;
    assert.equal((await invoke(deps, { panel_request: token, refresh: true, request_id: crypto.randomUUID() })).body.error?.code, -32602);
    const news = (await import('../api/mcp/panel-requests.ts')).admitNewsPanel;
    const grant = await news(context, budget, pipe.pipeline, {});
    assert.equal((await invoke(deps, { panel_request: grant.token })).body.error?.code, -32602);
    await assert.rejects(readPanel({ ...context, userId: 'other' }, pipe.pipeline, 'get_market_data', {}, token));
    await assert.rejects(readPanel(context, pipe.pipeline, 'open_news_dashboard', {}, token));
    await assert.rejects(readPanel(context, pipe.pipeline, 'get_market_quotes', { symbols: ['AAPL'] }, token));
    await assert.rejects(readPanel(context, pipe.pipeline, 'get_market_data', {}, token, Date.parse(first.body.result.structuredContent.panelRequest.expiresAt)));
    await assert.rejects(readPanel(context, async () => { throw new Error('outage'); }, 'get_market_data', {}, token), error => error.code === 'backend');
    assert.equal(fetched.length, reads);
    assert.equal(pipe.count, 2);
  });
  it('rechecks current rights on cache replay and preserves per-tool API billing', async () => {
    let revoked = false;
    const { deps, pipe } = makeProDeps({ getEntitlements: async () => ({ planKey: 'pro', features: { tier: 1, mcpAccess: !revoked }, validUntil: Date.now() + 86400000 }) });
    const opened = await invoke(deps);
    const token = opened.body.result.structuredContent.panelRequest.token;
    revoked = true;
    assert.equal((await invoke(deps, { panel_request: token })).response.status, 403);
    assert.equal(fetched.length, 11);
    assert.equal(pipe.count, 1);
    const api = makeProDeps({ getEntitlements: async () => ({ planKey: 'api-starter', features: { tier: 1, mcpAccess: true, apiAccess: true, planLimits: { apiCallsPerDay: 1000, mcpCallsPerDay: 'shared-api-budget' } }, validUntil: Date.now() + 86400000 }) });
    assert.equal((await invoke(api.deps)).body.result.structuredContent.panelRequest, undefined);
    await invoke(api.deps, { symbols: ['AAPL'] });
    assert.equal(api.pipe.count, 2);
    assert.equal((await invoke(api.deps, { panel_request: token })).body.error?.code, -32602);
    assert.equal((await invoke(api.deps, { unknown: true })).body.error?.code, -32602);
    assert.equal(api.pipe.count, 2);
  });
  it('retries degraded seed results within the same allocation and stops at the existing 64-read ceiling', async () => {
    const { deps, pipe } = makeProDeps();
    degraded = true;
    const opened = await invoke(deps, { asset_class: ['equity'] });
    const token = opened.body.result.structuredContent.panelRequest.token;
    await invoke(deps, { asset_class: ['equity'], panel_request: token });
    assert.equal(fetched.length, 22);
    degraded = false;
    const recovered = await invoke(deps, { asset_class: ['equity'], panel_request: token });
    assert.equal(recovered.body.result.structuredContent.data['stocks-bootstrap'].rateLimited, false);
    await invoke(deps, { asset_class: ['equity'], panel_request: token });
    assert.equal(fetched.length, 33);
    for (let i = 0; i < PANEL_READ_LIMIT - 3; i++) await readPanel(context, pipe.pipeline, 'get_market_data', { symbols: [`MISS${i}`] }, token);
    const denied = await invoke(deps, { symbols: ['LAST'], panel_request: token });
    assert.equal(denied.response.status, 429);
    assert.ok(denied.response.headers.get('Retry-After'));
    assert.equal(fetched.length, 33);
    assert.equal(pipe.count, 1);
  });
  it('keeps paid reads available at the daily cap and denies a new refresh before seed work', async () => {
    const { deps, pipe } = makeProDeps({ pipelineOpts: { initialCount: 49 } });
    const first = await invoke(deps, { symbols: ['AAPL'], asset_class: ['equity'] });
    const receipt = first.body.result.structuredContent.panelRequest;
    assert.equal(receipt.usage.remaining, 0);
    const next = await invoke(deps, { symbols: ['MSFT'], asset_class: ['equity'] });
    assert.equal(next.body.result.structuredContent.panelRequest.token, receipt.token);
    const count = fetched.length;
    const denied = await invoke(deps, { refresh: true, request_id: crypto.randomUUID() });
    assert.equal(denied.response.status, 429);
    assert.ok(denied.response.headers.get('Retry-After'));
    assert.equal(pipe.count, 50);
    assert.equal(fetched.length, count);
  });
  it('does not cache an execution error and can recover with the original paid receipt', async () => {
    const { deps, pipe } = makeProDeps();
    const { admitMarketPanel } = await import('../api/mcp/panel-requests.ts');
    const grant = await admitMarketPanel(context, budget, pipe.pipeline, {});
    sourceFailure = true;
    const failed = await invoke(deps, { asset_class: ['equity'], panel_request: grant.token });
    assert.equal(failed.body.error.code, -32003);
    sourceFailure = false;
    const recovered = await invoke(deps, { asset_class: ['equity'], panel_request: grant.token });
    assert.equal(recovered.body.result.structuredContent.data['stocks-bootstrap'].quotes.length, 2);
    await invoke(deps, { asset_class: ['equity'], panel_request: grant.token });
    assert.equal(pipe.count, 1);
    assert.equal(fetched.length, 22);
  });
  it('keeps incomplete and stale market seeds recoverable without changing refresh expiry on replay', async () => {
    const { pipe } = makeProDeps();
    const { admitMarketPanel } = await import('../api/mcp/panel-requests.ts');
    const now = Date.UTC(2026, 9, 4, 12);
    const args = { refresh: true, request_id: crypto.randomUUID() };
    const receipt = await admitMarketPanel(context, budget, pipe.pipeline, args, now);
    const replay = await admitMarketPanel(context, budget, pipe.pipeline, args, now + 60000);
    assert.equal(receipt.token, replay.token);
    assert.equal(receipt.expiresAt, replay.expiresAt);
    const read = await authorizePanelRead(context, pipe.pipeline, 'get_market_data', {}, receipt.token, now);
    for (const value of [
      { stale: true, data: { crypto: { quotes: [] } } },
      { stale: false, unreadable: ['crypto'], data: { crypto: { quotes: [] } } },
      { stale: false, data: { crypto: null } },
      { stale: false, data: { crypto: { unavailable: true } } },
      { stale: false, data: { 'stocks-bootstrap': { skipReason: 'SEED_UNAVAILABLE' } } },
      { stale: false, data: { sectors: { valuationCoverage: { sourceStatus: 'degraded' } } } },
    ]) {
      await read.save(value);
      assert.equal((await authorizePanelRead(context, pipe.pipeline, 'get_market_data', {}, receipt.token, now)).cached, undefined);
    }
    const ready = { stale: false, data: { crypto: { quotes: [] } } };
    await read.save(ready);
    assert.deepEqual((await authorizePanelRead(context, pipe.pipeline, 'get_market_data', {}, receipt.token, now)).cached, ready);
    assert.equal(pipe.count, 1);
    assert.equal(fetched.length, 0);
  });
});

describe('paid forecast panel admission', () => {
  let handler;
  let forecastTool;
  let previousExecute;
  beforeEach(async () => {
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
    handler = (await import('../api/mcp.ts')).mcpHandler;
    forecastTool = (await import('../api/mcp/registry/index.ts')).TOOL_REGISTRY.find(tool => tool.name === 'get_forecast_predictions');
    previousExecute = forecastTool._execute;
    forecastTool._execute = async (_args, _origin, _context, execution) => ({ data: { predictions: { generatedAt: '1720000000000', predictions: [{ id: 'controlled', title: 'Controlled forecast' }] } }, panelRequest: execution.panelRequest });
  });
  afterEach(() => {
    forecastTool._execute = previousExecute;
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });
  const invoke = async (deps, name, args = {}) => {
    const response = await handler(proReq('POST', callBody(name, args)), deps);
    return { response, body: await response.json() };
  };
  it('opens and replays compact forecasts under one signed allocation and charges explicit refresh once', async () => {
    const { deps, pipe } = makeProDeps();
    const first = await invoke(deps, 'get_forecast_predictions');
    const grant = first.body.result.structuredContent.panelRequest;
    assert.equal(grant?.panel, 'forecasts');
    assert.equal(grant.usage.remaining, 49);
    const second = await invoke(deps, 'get_forecast_predictions');
    assert.equal(second.body.result.structuredContent.panelRequest.token, grant.token);
    assert.equal(pipe.count, 1);
    const request_id = crypto.randomUUID();
    await invoke(deps, 'get_forecast_predictions', { refresh: true, request_id });
    await invoke(deps, 'get_forecast_predictions', { refresh: true, request_id });
    assert.equal(pipe.count, 2);
  });
  it('rejects invalid opening arguments before reservation', async () => {
    const { deps, pipe } = makeProDeps();
    for (const args of [{ limit: 0 }, { limit: 31 }, { unexpected: true }, { refresh: true }]) {
      const denied = await invoke(deps, 'get_forecast_predictions', args);
      assert.equal(denied.body.error?.code, -32602);
      assert.equal(pipe.count, 0);
    }
  });
  it('allows only fixed forecast list and exact case reads within the forecast scope', async () => {
    const { admitForecastPanel } = await import('../api/mcp/panel-requests.ts');
    assert.equal(typeof admitForecastPanel, 'function');
    const { pipe } = makeProDeps();
    const grant = await admitForecastPanel(context, budget, pipe.pipeline, {});
    const read = await readPanel(context, pipe.pipeline, 'get_forecast_case', { forecast_id: 'controlled', generated_at: '1720000000000' }, grant.token);
    await read.save({ data: { forecastCase: { status: 'ready', generatedAt: '1720000000000', forecast: { id: 'controlled' } } } });
    assert.deepEqual((await readPanel(context, pipe.pipeline, 'get_forecast_case', { generated_at: '1720000000000', forecast_id: 'controlled' }, grant.token)).cached, { data: { forecastCase: { status: 'ready', generatedAt: '1720000000000', forecast: { id: 'controlled' } } } });
    await readPanel(context, pipe.pipeline, 'get_forecast_predictions', { domain: 'energy', region: 'Europe', limit: 30 }, grant.token);
    for (const [name, args] of [
      ['get_forecast_predictions', { jmespath: 'data' }], ['get_forecast_predictions', { summary: true }],
      ['get_forecast_predictions', { limit: 0 }], ['get_forecast_predictions', { refresh: true }],
      ['get_forecast_case', { forecast_id: 'controlled', generated_at: '1720000000000', domain: 'energy' }],
      ['get_forecast_case', { forecast_id: '', generated_at: '1720000000000' }],
      ['get_forecast_case', { forecast_id: 'controlled', generated_at: '' }],
      ['get_market_data', {}], ['get_country_brief', { country_code: 'US' }],
    ]) await assert.rejects(readPanel(context, pipe.pipeline, name, args, grant.token));
    assert.equal(pipe.count, 1);
  });
  it('keeps forecast namespace distinct and enforces owner, expiry and the durable read limit', async () => {
    const { admitForecastPanel } = await import('../api/mcp/panel-requests.ts');
    const { pipe } = makeProDeps();
    const now = Date.UTC(2026, 9, 4, 12);
    const grant = await admitForecastPanel(context, budget, pipe.pipeline, {}, now);
    assert.match(grant.token, /^forecasts\.b\d+\.\d{13}\.[a-f0-9]{64}$/);
    assert.ok(pipe.ops.flat().some(command => command[0] === 'EVAL' && String(command[5]).includes(':forecasts:forecasts:')));
    const args = { forecast_id: 'controlled', generated_at: '1720000000000' };
    await assert.rejects(readPanel({ ...context, userId: 'other' }, pipe.pipeline, 'get_forecast_case', args, grant.token, now));
    await assert.rejects(readPanel(context, pipe.pipeline, 'get_forecast_case', args, grant.token, Date.parse(grant.expiresAt)));
    await assert.rejects(readPanel(context, pipe.pipeline, 'get_forecast_case', args, grant.token.slice(0, -1) + (grant.token.endsWith('a') ? 'b' : 'a'), now));
    const country = await admitCountryPanel(context, budget, pipe.pipeline, { country_code: 'US' }, now);
    await assert.rejects(readPanel(context, pipe.pipeline, 'get_forecast_case', args, country.token, now));
    const cached = await readPanel(context, pipe.pipeline, 'get_forecast_case', args, grant.token, now);
    await cached.save({ data: { forecastCase: { status: 'ready', generatedAt: '1720000000000', forecast: { id: 'controlled' } } } });
    for (let i = 1; i < PANEL_READ_LIMIT; i++) await readPanel(context, pipe.pipeline, 'get_forecast_case', { ...args, forecast_id: `case-${i}` }, grant.token, now);
    await assert.rejects(readPanel(context, pipe.pipeline, 'get_forecast_case', { ...args, forecast_id: 'new' }, grant.token, now), error => error.code === 'reads');
    assert.equal((await readPanel(context, pipe.pipeline, 'get_forecast_case', args, grant.token, now)).cached.data.forecastCase.forecast.id, 'controlled');
    assert.equal(pipe.count, 2);
  });
  it('does not grant forecast panels against API per-tool budgets', async () => {
    const { admitForecastPanel } = await import('../api/mcp/panel-requests.ts');
    const { pipe } = makeProDeps();
    await assert.rejects(admitForecastPanel(context, { allowance: 'api', limit: 1000 }, pipe.pipeline, {}));
    assert.equal(pipe.count, 0);
    const { deps, pipe: apiPipe } = makeProDeps({ getEntitlements: async () => ({ planKey: 'api-starter', features: { tier: 1, mcpAccess: true, apiAccess: true, planLimits: { apiCallsPerDay: 1000, mcpCallsPerDay: 'shared-api-budget' } }, validUntil: Date.now() + 86400000 }) });
    const first = await invoke(deps, 'get_forecast_predictions');
    const second = await invoke(deps, 'get_forecast_predictions');
    assert.equal(first.body.result.structuredContent.panelRequest, undefined);
    assert.equal(second.body.result.structuredContent.panelRequest, undefined);
    assert.equal(apiPipe.count, 2 * (await import('../api/mcp/registry/index.ts')).toolWeight(forecastTool));
  });
  it('refreshes opening notices while never storing receipts inside the replay snapshot', async () => {
    const { deps, pipe } = makeProDeps();
    const first = await invoke(deps, 'get_forecast_predictions');
    const grant = first.body.result.structuredContent.panelRequest;
    const cached = await authorizePanelRead(context, pipe.pipeline, 'get_forecast_predictions', {}, grant.token);
    assert.equal(cached.cached.panelRequest, undefined);
    await invoke(deps, 'open_country_brief', { country_code: 'US' });
    const reopened = await invoke(deps, 'get_forecast_predictions');
    assert.equal(reopened.body.result.structuredContent.panelRequest.usage.remaining, 48);
    assert.equal(reopened.body.result._meta['worldmonitor/usage'].remaining, 48);
    assert.equal(pipe.count, 2);
    const replayed = await invoke(deps, 'get_forecast_predictions', { panel_request: grant.token });
    assert.equal(replayed.body.result.structuredContent.panelRequest, undefined);
    assert.equal(pipe.count, 2);
    for (const args of [{ summary: true }, { jmespath: 'data' }, { refresh: true }]) {
      assert.equal((await invoke(deps, 'get_forecast_predictions', { ...args, panel_request: grant.token })).body.error?.code, -32602);
      assert.equal(pipe.count, 2);
    }
  });

});

describe('forecast panel transport through production cache reads', () => {
  let handler;
  let canonical;
  let sourceReads;
  const invoke = async (deps, name, args = {}) => {
    const response = await handler(proReq('POST', callBody(name, args)), deps);
    return { response, body: await response.json() };
  };
  beforeEach(async () => {
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
    process.env.UPSTASH_REDIS_REST_URL = 'https://forecast-fixture.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'controlled-fixture-token';
    canonical = {
      generatedAt: Date.now(),
      predictions: Array.from({ length: 14 }, (_, i) => ({
        id: `original-${i}`, title: `Original forecast ${i}`, domain: 'energy', region: 'Europe', probability: 0.4,
        scenario: 'Original scenario', caseFile: { baseCase: `${i}:` + 'original prose '.repeat(1200), actors: [{ name: `Original actor ${i}` }] },
      })),
    };
    sourceReads = [];
    globalThis.fetch = async url => {
      const parsed = new URL(url);
      assert.equal(parsed.hostname, 'forecast-fixture.test', 'controlled fixture must never fetch a real service');
      if (!parsed.pathname.startsWith('/get/')) return Response.json({ result: [9999, 10000] });
      const key = decodeURIComponent(parsed.pathname.slice('/get/'.length));
      sourceReads.push(key);
      assert.ok(['forecast:predictions:v2', 'seed-meta:forecast:predictions'].includes(key), key);
      return Response.json({ result: JSON.stringify(key === 'forecast:predictions:v2' ? canonical : { fetchedAt: Date.now() }) });
    };
    handler = (await import('../api/mcp.ts')).mcpHandler;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });
  it('opens every compact row within the fixed serialized output budget and reads one unchanged original case', async t => {
    assert.ok(Buffer.byteLength(JSON.stringify(canonical)) > 131072);
    const { deps, pipe } = makeProDeps();
    const first = await invoke(deps, 'get_forecast_predictions');
    const result = first.body.result;
    const openingBytes = Buffer.byteLength(JSON.stringify(result));
    assert.ok(openingBytes <= 131072);
    t.diagnostic(JSON.stringify({ originalBytes: Buffer.byteLength(JSON.stringify(canonical)), openingEnvelopeBytes: openingBytes, budgetBytes: 131072 }));
    assert.ok(Buffer.byteLength(result.content[0].text) <= 131072);
    assert.equal(result.structuredContent.data.predictions.predictions.length, 14);
    assert.ok(result.structuredContent.data.predictions.predictions.every(row => row.hasCaseFile && !('caseFile' in row)));
    const panel_request = result.structuredContent.panelRequest.token;
    const args = { forecast_id: 'original-0', generated_at: String(canonical.generatedAt), panel_request };
    const detail = await invoke(deps, 'get_forecast_case', args);
    assert.equal(detail.body.result?.structuredContent?.data?.forecastCase?.status, 'ready');
    assert.deepEqual(detail.body.result.structuredContent.data.forecastCase.forecast, canonical.predictions[0]);
    assert.equal('predictions' in detail.body.result.structuredContent.data, false);
    const reads = sourceReads.length;
    assert.deepEqual((await invoke(deps, 'get_forecast_case', args)).body.result.structuredContent.data.forecastCase.forecast, canonical.predictions[0]);
    assert.equal(sourceReads.length, reads);
    assert.equal(pipe.count, 1);
    const priorGeneration = String(canonical.generatedAt);
    canonical.generatedAt++;
    const changed = await invoke(deps, 'get_forecast_case', { forecast_id: 'original-1', generated_at: priorGeneration, panel_request });
    assert.equal(changed.body.result.structuredContent.data.forecastCase.status, 'generation_changed');
    assert.equal(changed.body.result.structuredContent.data.forecastCase.forecast, null);
    assert.equal(pipe.count, 1);
  });
  it('never lets a summary-first or JMESPath opening poison canonical compact reopening', async () => {
    for (const transform of [{ summary: true }, { jmespath: 'data.predictions.predictions[0]' }]) {
      const { deps, pipe } = makeProDeps();
      const transformed = await invoke(deps, 'get_forecast_predictions', transform);
      assert.ok('projection' in transformed.body.result.structuredContent);
      const reads = sourceReads.length;
      const ordinary = await invoke(deps, 'get_forecast_predictions');
      assert.equal(ordinary.body.result.structuredContent.data.predictions.predictions.length, 14);
      assert.ok(ordinary.body.result.structuredContent.data.predictions.predictions.every(row => row.hasCaseFile));
      assert.equal(sourceReads.length, reads);
      assert.equal(pipe.count, 1);
    }
  });
  it('retains one allocation when an original single case exceeds the response budget', async () => {
    canonical.predictions[0].caseFile.baseCase = 'oversized-original'.repeat(10000);
    const { deps, pipe } = makeProDeps();
    const first = await invoke(deps, 'get_forecast_predictions');
    const panel_request = first.body.result.structuredContent.panelRequest.token;
    const args = { forecast_id: 'original-0', generated_at: String(canonical.generatedAt), panel_request };
    const detail = await invoke(deps, 'get_forecast_case', args);
    assert.equal(detail.body.result?.structuredContent?._budget_exceeded, true);
    assert.equal(detail.body.result.structuredContent.budget_bytes, 131072);
    assert.ok(detail.body.result.structuredContent.actual_bytes > 131072);
    assert.equal(pipe.count, 1);
    const reads = sourceReads.length;
    assert.equal((await invoke(deps, 'get_forecast_case', args)).body.result.structuredContent._budget_exceeded, true);
    assert.equal(sourceReads.length, reads);
    assert.equal(pipe.count, 1);
    assert.equal(pipe.ops.flat().some(command => command[0] === 'DECR'), false);
  });
  it('preserves the original full forecast shape and weighted per-tool accounting for API plans', async () => {
    const { deps, pipe } = makeProDeps({ getEntitlements: async () => ({ planKey: 'api-starter', features: { tier: 1, mcpAccess: true, apiAccess: true, planLimits: { apiCallsPerDay: 1000, mcpCallsPerDay: 'shared-api-budget' } }, validUntil: Date.now() + 86400000 }) });
    const result = await invoke(deps, 'get_forecast_predictions', { limit: 1 });
    assert.deepEqual(result.body.result.structuredContent.data.predictions.predictions, [canonical.predictions[0]]);
    assert.equal(result.body.result.structuredContent.panelRequest, undefined);
    await invoke(deps, 'get_forecast_predictions', { limit: 1 });
    const { TOOL_REGISTRY, toolWeight } = await import('../api/mcp/registry/index.ts');
    assert.equal(pipe.count, 2 * toolWeight(TOOL_REGISTRY.find(tool => tool.name === 'get_forecast_predictions')));
    const beforeDenied = sourceReads.length;
    assert.equal((await invoke(deps, 'get_forecast_case', { forecast_id: 'original-0', generated_at: String(canonical.generatedAt) })).body.error.code, -32602);
    assert.equal(sourceReads.length, beforeDenied);
    assert.equal(pipe.count, 2 * toolWeight(TOOL_REGISTRY.find(tool => tool.name === 'get_forecast_predictions')));
  });
  it('recovers an unavailable opening under the same allocation and caches observed empty lists', async () => {
    const { deps, pipe } = makeProDeps();
    const original = canonical.predictions;
    canonical.predictions = null;
    const unavailable = await invoke(deps, 'get_forecast_predictions');
    const panel_request = unavailable.body.result.structuredContent.panelRequest.token;
    assert.equal(unavailable.body.result.structuredContent.data.predictions.predictions, null);
    const failedReads = sourceReads.length;
    canonical.predictions = original;
    const recovered = await invoke(deps, 'get_forecast_predictions', { panel_request });
    assert.equal(recovered.body.result.structuredContent.data.predictions.predictions.length, original.length);
    assert.ok(sourceReads.length > failedReads);
    assert.equal(pipe.count, 1);
    const recoveredReads = sourceReads.length;
    await invoke(deps, 'get_forecast_predictions', { panel_request });
    assert.equal(sourceReads.length, recoveredReads);
    const emptyAccount = makeProDeps();
    canonical.predictions = [];
    const empty = await invoke(emptyAccount.deps, 'get_forecast_predictions');
    assert.deepEqual(empty.body.result.structuredContent.data.predictions.predictions, []);
    const emptyReads = sourceReads.length;
    await invoke(emptyAccount.deps, 'get_forecast_predictions', { panel_request: empty.body.result.structuredContent.panelRequest.token });
    assert.equal(sourceReads.length, emptyReads);
    assert.equal(emptyAccount.pipe.count, 1);
  });
  it('recovers an unavailable original case on same-generation retry without another daily allocation', async () => {
    const { deps, pipe } = makeProDeps();
    const opened = await invoke(deps, 'get_forecast_predictions');
    const args = { forecast_id: 'original-0', generated_at: String(canonical.generatedAt), panel_request: opened.body.result.structuredContent.panelRequest.token };
    const original = canonical.predictions;
    canonical.predictions = null;
    const failed = await invoke(deps, 'get_forecast_case', args);
    assert.equal(failed.body.result.structuredContent.data.forecastCase.status, 'unavailable');
    const reads = sourceReads.length;
    canonical.predictions = original;
    const recovered = await invoke(deps, 'get_forecast_case', args);
    assert.equal(recovered.body.result.structuredContent.data.forecastCase.status, 'ready');
    assert.deepEqual(recovered.body.result.structuredContent.data.forecastCase.forecast, original[0]);
    assert.ok(sourceReads.length > reads);
    assert.equal(pipe.count, 1);
    const recoveredReads = sourceReads.length;
    await invoke(deps, 'get_forecast_case', args);
    assert.equal(sourceReads.length, recoveredReads);
    assert.equal(pipe.count, 1);
  });

});

describe('paid prediction panel through the MCP handler', () => {
  let handler;
  let fetched;
  let stale;
  let malformed;
  let missingMeta;
  let seedFailure;
  let oversized;
  let bootstrapOverride;
  const payload = () => ({
    geopolitical: [{ title: oversized ? 'US Election ' + 'x'.repeat(140000) : 'US Election', source: 'kalshi', yesPrice: 50 }, { title: 'World vote', source: 'polymarket', yesPrice: 30 }],
    tech: [{ title: 'AI launch', source: 'polymarket', yesPrice: 70 }, { title: 'AI research', source: 'polymarket', yesPrice: 20 }],
    finance: [{ title: 'US interest rate', source: 'kalshi', yesPrice: 40 }],
  });
  const invoke = async (deps, args = {}) => {
    const response = await handler(proReq('POST', callBody('get_prediction_markets', args)), deps);
    return { response, body: await response.json() };
  };
  const data = result => result.body.result.structuredContent.data['markets-bootstrap'];
  beforeEach(async () => {
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
    process.env.UPSTASH_REDIS_REST_URL = 'https://prediction-seed.invalid';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'controlled-token';
    fetched = []; stale = false; malformed = false; missingMeta = false; seedFailure = false; oversized = false; bootstrapOverride = undefined;
    globalThis.fetch = async url => {
      const key = decodeURIComponent(new URL(String(url)).pathname.slice(5));
      assert.ok(['prediction:markets-bootstrap:v1', 'seed-meta:prediction:markets'].includes(key), key);
      fetched.push(key);
      if (seedFailure) throw new Error('controlled outage');
      return Response.json({ result: key.startsWith('seed-meta:')
        ? missingMeta ? null : JSON.stringify({ fetchedAt: Date.now() - (stale ? 100 * 60000 : 0) })
        : JSON.stringify(bootstrapOverride ?? (malformed ? { tech: [] } : payload())) });
    };
    handler = (await import('../api/mcp.ts')).mcpHandler;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });
  it('opens once, narrows exact contracts and replays normalized filters with two fixed reads per uncached filter', async () => {
    const { deps, pipe } = makeProDeps();
    const first = await invoke(deps);
    const token = first.body.result.structuredContent.panelRequest?.token;
    assert.equal(first.body.result.structuredContent.panelRequest?.panel, 'predictions');
    assert.equal(first.body.result._meta['worldmonitor/usage'].remaining, 49);
    assert.equal(fetched.length, 2);
    const filtered = await invoke(deps, { category: ' GEOPOLITICAL ', query: ' US ELECTION ', source: 'KALSHI' });
    assert.deepEqual(data(filtered).geopolitical.map(row => row.title), ['US Election']);
    assert.deepEqual(data(filtered).tech, []);
    assert.equal(filtered.body.result.structuredContent.panelRequest.token, token);
    await invoke(deps, { source: ' kalshi ', query: 'us election', category: 'geopolitical', limit: 30, panel_request: token });
    assert.equal(fetched.length, 4);
    assert.equal(pipe.count, 1);
    await invoke(deps, { category: 'tech', source: 'kalshi', panel_request: token });
    const empty = await invoke(deps, { category: 'TECH', source: 'KALSHI', panel_request: token });
    assert.deepEqual(data(empty), { geopolitical: [], tech: [], finance: [] });
    assert.equal(fetched.length, 6);
    for (const [limit, expected] of [[0, 2], [-1, 2], [1.9, 1], [0.5, 0]]) {
      assert.equal(data(await invoke(deps, { category: 'tech', limit, panel_request: token })).tech.length, expected);
    }
    assert.equal(pipe.count, 1);
  });
  it('preserves originals before summary and whole-envelope projection', async () => {
    const { deps, pipe } = makeProDeps();
    const summary = await invoke(deps, { summary: true });
    assert.equal(summary.body.result.structuredContent.projection.data['markets-bootstrap'].tech.count, 2);
    const raw = await invoke(deps);
    assert.equal(data(raw).tech.length, 2);
    const projected = await invoke(deps, { jmespath: '@', panel_request: raw.body.result.structuredContent.panelRequest.token });
    assert.equal(projected.body.result.structuredContent.projection.data['markets-bootstrap'].tech.length, 2);
    assert.equal(pipe.count, 1);
    assert.equal(fetched.length, 2);
  });
  it('charges explicit refresh once across UUID case and retries, while denying invalid paid controls before work', async () => {
    const { deps, pipe } = makeProDeps();
    for (const args of [{ category: 'invalid' }, { source: 1 }, { query: [] }, { limit: '2' }, { extra: 1 }, { refresh: true }, { request_id: 'bad' }]) {
      assert.equal((await invoke(deps, args)).body.error?.code, -32602, JSON.stringify(args));
    }
    assert.equal(pipe.count, 0);
    assert.equal(fetched.length, 0);
    const request_id = '550E8400-E29B-41D4-A716-446655440000';
    const first = await invoke(deps, { refresh: true, request_id });
    const second = await invoke(deps, { refresh: true, request_id: request_id.toLowerCase() });
    const receipt = first.body.result.structuredContent.panelRequest;
    assert.equal(second.body.result.structuredContent.panelRequest.token, receipt.token);
    assert.equal(second.body.result.structuredContent.panelRequest.expiresAt, receipt.expiresAt);
    assert.equal(pipe.count, 1);
    assert.equal(fetched.length, 2);
    assert.equal((await invoke(deps, { panel_request: receipt.token, refresh: true, request_id })).body.error?.code, -32602);
    await invoke(deps, { refresh: true, request_id: crypto.randomUUID() });
    assert.equal(pipe.count, 2);
  });
  it('rejects cross-family, owner, revoked and expired receipts and bounds uncached work to 64', async () => {
    const { deps, pipe } = makeProDeps();
    const first = await invoke(deps);
    const token = first.body.result.structuredContent.panelRequest.token;
    await assert.rejects(readPanel(context, pipe.pipeline, 'get_market_data', {}, token));
    await assert.rejects(readPanel(context, pipe.pipeline, 'open_news_dashboard', {}, token));
    await assert.rejects(readPanel({ ...context, userId: 'foreign' }, pipe.pipeline, 'get_prediction_markets', {}, token));
    await assert.rejects(readPanel(context, pipe.pipeline, 'get_prediction_markets', {}, token, Date.parse(first.body.result.structuredContent.panelRequest.expiresAt)));
    const { admitMarketPanel } = await import('../api/mcp/panel-requests.ts');
    const foreign = await admitMarketPanel(context, budget, pipe.pipeline, {});
    assert.equal((await invoke(deps, { panel_request: foreign.token })).body.error?.code, -32602);
    for (let i = 1; i < 64; i++) assert.equal((await invoke(deps, { query: `case${i}`, panel_request: token })).body.error, undefined);
    const denied = await invoke(deps, { query: 'last', panel_request: token });
    assert.equal(denied.response.status, 429);
    assert.equal(fetched.length, 128);
    assert.equal((await invoke(deps, { panel_request: token })).body.error, undefined);
    deps.getEntitlements = async () => ({ features: { tier: 1, mcpAccess: false } });
    assert.equal((await invoke(deps, { panel_request: token })).response.status, 403);
  });
  for (const [pool, invalid, category, title, filters] of [
    ['geopolitical', undefined, 'tech', 'AI launch', { query: 'AI', source: 'polymarket', limit: 1.9 }],
    ['tech', undefined, 'geopolitical', 'US Election', { query: 'Election', source: 'kalshi', limit: 1 }],
    ['finance', undefined, 'tech', 'AI launch', {}],
    ['geopolitical', null, 'tech', 'AI launch', {}],
    ['tech', {}, 'geopolitical', 'US Election', {}],
    ['finance', 'unknown', 'tech', 'AI launch', { query: 'AI', source: 'polymarket', limit: 1 }],
  ]) {
    it(`recovers ${invalid === undefined ? 'missing' : 'malformed'} original ${pool} before selected ${category} normalization`, async () => {
      const { deps, pipe } = makeProDeps();
      bootstrapOverride = payload();
      bootstrapOverride[category] = [];
      if (invalid === undefined) delete bootstrapOverride[pool];
      else bootstrapOverride[pool] = invalid;
      const args = { category, ...filters };
      const first = await invoke(deps, args);
      const token = first.body.result.structuredContent.panelRequest.token;
      bootstrapOverride = undefined;
      const recovered = await invoke(deps, { ...args, panel_request: token });
      assert.equal(data(recovered)[category][0]?.title, title, 'repaired original source must rerun selected-category filters');
      assert.equal(fetched.length, 4, 'recovery reads the original bootstrap and metadata');
      assert.equal(pipe.count, 1, 'recovery reuses the opening allocation');
      await invoke(deps, { ...args, panel_request: token });
      assert.equal(fetched.length, 4, 'healthy recovered result replays');
    });
  }
  it('does not turn the original selected-category malformed seed into a cacheable empty', async () => {
    const { deps, pipe } = makeProDeps();
    malformed = true;
    const first = await invoke(deps, { category: 'tech' });
    const token = first.body.result.structuredContent.panelRequest.token;
    assert.equal(data(first).tech.length, 0);
    malformed = false;
    const recovered = await invoke(deps, { category: 'tech', panel_request: token });
    assert.deepEqual(data(recovered).tech.map(row => row.title), ['AI launch', 'AI research']);
    assert.equal(fetched.length, 4);
    assert.equal(pipe.count, 1);
  });
  it('retries stale, malformed, missing-freshness and failed sources without another allocation', async () => {
    const { deps, pipe } = makeProDeps();
    stale = true;
    const first = await invoke(deps);
    const token = first.body.result.structuredContent.panelRequest.token;
    await invoke(deps, { panel_request: token });
    assert.equal(fetched.length, 4);
    stale = false; malformed = true;
    await invoke(deps, { panel_request: token });
    await invoke(deps, { panel_request: token });
    assert.equal(fetched.length, 8);
    malformed = false; missingMeta = true;
    await invoke(deps, { panel_request: token });
    await invoke(deps, { panel_request: token });
    assert.equal(fetched.length, 12);
    missingMeta = false; seedFailure = true;
    assert.equal((await invoke(deps, { panel_request: token })).body.error?.code, -32003);
    seedFailure = false;
    assert.equal(data(await invoke(deps, { panel_request: token })).tech.length, 2);
    const reads = fetched.length;
    await invoke(deps, { panel_request: token });
    assert.equal(fetched.length, reads);
    assert.equal(pipe.count, 1);
  });
  it('reads current allowance only after receipt authorization and omits unknown counter notices', async () => {
    const { deps, pipe } = makeProDeps();
    const token = (await invoke(deps)).body.result.structuredContent.panelRequest.token;
    const key = dailyCounterKey(context.userId);
    const original = deps.redisPipeline;
    let reads = 0;
    let counter = '2';
    deps.redisPipeline = async (commands, ...options) => {
      if (commands.length === 1 && commands[0][0] === 'GET' && commands[0][1] === key) { reads++; return [{ result: counter }]; }
      return original(commands, ...options);
    };
    const current = await invoke(deps, { panel_request: token });
    assert.equal(current.body.result._meta['worldmonitor/usage'].remaining, 48);
    counter = null;
    const unknown = await invoke(deps, { panel_request: token });
    assert.equal(unknown.body.result._meta?.['worldmonitor/usage'], undefined);
    assert.equal(data(unknown).tech.length, 2);
    assert.equal((await invoke(deps, { panel_request: 'forged' })).body.error?.code, -32602);
    assert.equal(reads, 2);
    assert.equal(pipe.count, 1);
    assert.equal(fetched.length, 2);
  });
  it('narrows an oversized original under the same paid allocation without raising the output budget', async () => {
    const { deps, pipe } = makeProDeps();
    oversized = true;
    const first = await invoke(deps);
    assert.equal(first.body.result.structuredContent._budget_exceeded, true);
    assert.equal(first.body.result.structuredContent.budget_bytes, 131072);
    const narrow = await invoke(deps, { category: 'tech' });
    assert.equal(data(narrow).tech.length, 2);
    assert.equal(pipe.count, 1);
    assert.equal(fetched.length, 4);
  });
  it('keeps structured unavailable and unknown prediction data recoverable', async () => {
    const { pipe } = makeProDeps();
    const { admitPredictionPanel } = await import('../api/mcp/panel-requests.ts');
    const grant = await admitPredictionPanel(context, budget, pipe.pipeline, {});
    const reader = await authorizePanelRead(context, pipe.pipeline, 'get_prediction_markets', {}, grant.token);
    for (const value of [null, false, 0, 'unknown', []]) {
      await reader.save(value);
      assert.equal((await authorizePanelRead(context, pipe.pipeline, 'get_prediction_markets', {}, grant.token)).cached, undefined);
    }
    for (const bootstrap of [null, { tech: [] }, { geopolitical: [], tech: [], finance: [], unavailable: true }, { geopolitical: [], tech: [], finance: [], upstreamUnavailable: true }, { geopolitical: [], tech: [], finance: [], rateLimited: true }, { geopolitical: [], tech: [], finance: [], error: 'unavailable' }]) {
      await reader.save({ cached_at: new Date().toISOString(), stale: false, data: { 'markets-bootstrap': bootstrap } });
      assert.equal((await authorizePanelRead(context, pipe.pipeline, 'get_prediction_markets', {}, grant.token)).cached, undefined);
    }
    const ready = { cached_at: new Date().toISOString(), stale: false, data: { 'markets-bootstrap': { geopolitical: [], tech: [], finance: [] } } };
    await reader.save(ready);
    assert.deepEqual((await authorizePanelRead(context, pipe.pipeline, 'get_prediction_markets', {}, grant.token)).cached, ready);
    assert.equal(pipe.count, 1);
  });
  it('preserves ordinary API/free coercion and per-call charging but rejects paid controls before charge', async () => {
    for (const entitlement of [
      { planKey: 'api-starter', features: { tier: 1, mcpAccess: true, apiAccess: true, planLimits: { apiCallsPerDay: 1000, mcpCallsPerDay: 'shared-api-budget' } }, validUntil: Date.now() + 86400000 },
      { planKey: 'free', features: { tier: 0, mcpAccess: false }, validUntil: Date.now() + 86400000 },
    ]) {
      const { deps, pipe } = makeProDeps({ getEntitlements: async () => entitlement });
      const first = await invoke(deps, { source: 12, category: 'invalid', query: null, limit: -1, extra: true });
      assert.equal(first.body.error, undefined);
      assert.equal(first.body.result.structuredContent.panelRequest, undefined);
      assert.equal(data(first).tech.length, 2);
      await invoke(deps, { category: 'TECH', limit: 1.9 });
      assert.equal(pipe.count, 2);
      for (const args of [{ refresh: false }, { refresh: true, request_id: crypto.randomUUID() }, { request_id: crypto.randomUUID() }, { panel_request: 'forged' }]) {
        assert.equal((await invoke(deps, args)).body.error?.code, -32602);
      }
      assert.equal(pipe.count, 2);
    }
  });
  it('preserves malformed original pools without filter normalization on ordinary API and free connections', async () => {
    for (const entitlement of [
      { planKey: 'api-starter', features: { tier: 1, mcpAccess: true, apiAccess: true, planLimits: { apiCallsPerDay: 1000, mcpCallsPerDay: 'shared-api-budget' } }, validUntil: Date.now() + 86400000 },
      { planKey: 'free', features: { tier: 0, mcpAccess: false }, validUntil: Date.now() + 86400000 },
    ]) {
      const { deps, pipe } = makeProDeps({ getEntitlements: async () => entitlement });
      bootstrapOverride = { tech: payload().tech };
      const result = await invoke(deps, { category: 'finance', query: 'absent', source: 'kalshi', limit: 0.5 });
      assert.deepEqual(data(result), bootstrapOverride);
      assert.equal(result.body.result.structuredContent.panelRequest, undefined);
      assert.equal(pipe.count, 1);
    }
  });
});

describe('public forecast reliability cache and completed output', () => {
  const now = Date.parse('2026-10-07T00:00:00Z');
  const predictions = { generatedAt: now, predictions: [{ id: 'reliability-case', domain: 'energy', region: 'Europe', title: 'Controlled forecast', probability: 0.4 }] };
  const familyOutcomes = [{ forecastId: 'reliability-case', outcome: 'YES' }, { forecastId: 'reliability-case', outcome: 'VOID', voidReason: 'judge_disagreement' }];
  const scorecard = { schemaVersion: 2, rollingWindowDays: 90, publishedByDomain: [{ domain: 'energy', count: 45, brier: 0.213, yesCount: 18 }], familyOutcomes };
  const originals = new WeakMap();
  async function fixture(testContext, values) {
    if (!originals.has(testContext)) originals.set(testContext, { beforeFetch: globalThis.fetch, beforeEnv: { ...process.env }, beforeNow: Date.now });
    const { beforeFetch, beforeEnv, beforeNow } = originals.get(testContext);
    testContext.after(() => { globalThis.fetch = beforeFetch; Date.now = beforeNow; for (const key of Object.keys(process.env)) if (!(key in beforeEnv)) delete process.env[key]; Object.assign(process.env, beforeEnv); });
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET; process.env.MCP_TELEMETRY = 'false';
    process.env.UPSTASH_REDIS_REST_URL = 'https://forecast-reliability-fixture.test'; process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture-token';
    let clock = now; Date.now = () => clock;
    const reads = [];
    globalThis.fetch = async url => {
      const parsed = new URL(url); assert.equal(parsed.hostname, 'forecast-reliability-fixture.test');
      if (!parsed.pathname.startsWith('/get/')) return Response.json({ result: [9999, 10000] });
      const key = decodeURIComponent(parsed.pathname.slice(5)); reads.push(key);
      if (values[key] === 'unreadable') return new Response('not-json', { status: 200 });
      return Response.json({ result: values[key] == null ? null : JSON.stringify(values[key]) });
    };
    const { mcpHandler } = await import('../api/mcp.ts'); const { deps, pipe } = makeProDeps();
    const invoke = async args => { const body = await (await mcpHandler(proReq('POST', callBody('get_forecast_predictions', args)), deps)).json(); return body.result ?? { isError: true, error: body.error }; };
    return { invoke, pipe, reads, values, advance: ms => { clock += ms; } };
  }
  const values = () => ({ 'forecast:predictions:v2': predictions, 'seed-meta:forecast:predictions': { fetchedAt: now }, 'forecast:scorecard:v1': scorecard, 'seed-meta:forecast:scorecard': { fetchedAt: now } });
  it('uses four distinct production cache identities and preserves an optional outage in one signed replay', async testContext => {
    const fixtureContext = await fixture(testContext, { ...values(), 'forecast:scorecard:v1': 'unreadable' });
    const first = await fixtureContext.invoke({});
    assert.deepEqual([...new Set(fixtureContext.reads)].sort(), Object.keys(values()).sort(), 'opening must read predictions and independent optional scorecard data/meta');
    assert.equal(first.structuredContent.data.reliability.status, 'unavailable');
    assert.equal(Object.hasOwn(first.structuredContent.data, 'familyOutcomes'), false);
    assert.equal(first.structuredContent.stale, false, 'optional scorecard failure must not relabel fresh predictions');
    const readCount = fixtureContext.reads.length; const writes = fixtureContext.pipe.ops.flat().filter(operation => operation[0] === 'SET'); const replay = await fixtureContext.invoke({ panel_request: first.structuredContent.panelRequest.token });
    assert.deepEqual(replay.structuredContent.data.reliability, first.structuredContent.data.reliability);
    assert.deepEqual(fixtureContext.pipe.ops.flat().filter(operation => operation[0] === 'SET'), writes, 'replay must not rewrite the snapshot or extend its expiry');
    assert.equal(fixtureContext.reads.length, readCount); assert.equal(fixtureContext.pipe.count, 1);
  });
  it('saves public family history with the exact opening and replays without reads, allocation or expiry changes', async testContext => {
    const context = await fixture(testContext, values()); const first = await context.invoke({});
    assert.deepEqual(first.structuredContent.data.familyOutcomes, familyOutcomes);
    assert.deepEqual([...new Set(context.reads)].sort(), Object.keys(values()).sort());
    const count = context.reads.length; const writes = context.pipe.ops.flat().filter(op => op[0] === 'SET');
    context.values['forecast:scorecard:v1'] = { ...scorecard, familyOutcomes: [{ forecastId: 'reliability-case', outcome: 'NO' }] };
    context.values['forecast:predictions:v2'] = { ...predictions, predictions: [] }; context.advance(120000);
    const replay = await context.invoke({ panel_request: first.structuredContent.panelRequest.token });
    const { panelRequest, ...savedOpening } = first.structuredContent;
    assert.equal(panelRequest.panel, 'forecasts');
    assert.deepEqual(replay.structuredContent, savedOpening, 'saved full opening is exact; the existing replay contract omits the receipt');
    assert.equal(context.reads.length, count); assert.equal(context.pipe.count, 1);
    assert.deepEqual(context.pipe.ops.flat().filter(op => op[0] === 'SET'), writes, 'no snapshot rewrite or expiry extension');
  });
  it('admits a realistic 30-card five-window opening under the same fixed completed budget', async testContext => {
    const rows = Array.from({ length: 30 }, (unusedValue, forecastIndex) => ({ ...predictions.predictions[0], id: `family-${forecastIndex}` }));
    const history = rows.flatMap(row => Array.from({ length: 5 }, (unusedValue, windowIndex) => ({ forecastId: row.id, outcome: windowIndex % 2 ? 'VOID' : 'YES', ...(windowIndex % 2 ? { voidReason: 'judge_disagreement' } : {}) })));
    const context = await fixture(testContext, { ...values(), 'forecast:predictions:v2': { ...predictions, predictions: rows }, 'forecast:scorecard:v1': { ...scorecard, familyOutcomes: history } });
    const first = await context.invoke({}); assert.equal(first.isError, undefined); assert.equal(first.structuredContent._budget_exceeded, undefined);
    assert.equal(first.structuredContent.data.familyOutcomes.length, 150); assert.ok(Buffer.byteLength(JSON.stringify(first.structuredContent)) < 131072);
    assert.equal(context.pipe.count, 1); assert.deepEqual([...new Set(context.reads)].sort(), Object.keys(values()).sort());
  });
  it('rejects required missing/null/unreadable predictions despite healthy optional data, but accepts readable empty predictions', async testContext => {
    for (const bad of [null, 'unreadable', { _seed: { fetchedAt: now }, data: null }]) {
      const fixtureContext = await fixture(testContext, { ...values(), 'forecast:predictions:v2': bad }); const result = await fixtureContext.invoke({});
      assert.equal(result.isError, true, 'required prediction source must fail closed before healthy scorecard can mask it');
      assert.equal(fixtureContext.pipe.ops.flat().filter(operation => operation[0] === 'SET' && String(operation[1]).includes('snapshot')).length, 0);
    }
    const fixtureContext = await fixture(testContext, { ...values(), 'forecast:predictions:v2': { ...predictions, predictions: [] } });
    assert.deepEqual((await fixtureContext.invoke({})).structuredContent.data.predictions.predictions, []);
  });
  it('keeps the original 36-hour capture verdict across five-minute replay and reports unknown scorecard clocks', async testContext => {
    const fixtureContext = await fixture(testContext, { ...values(), 'seed-meta:forecast:scorecard': { fetchedAt: now - 36 * 3600000 + 60000 } });
    const first = await fixtureContext.invoke({}); const reliability = first.structuredContent.data.reliability;
    assert.equal(reliability?.stale, false, 'scorecard is still inside its own 36-hour clock');
    assert.equal(reliability.asOf, new Date(now - 36 * 3600000 + 60000).toISOString());
    assert.equal(reliability.capturedAt, new Date(now).toISOString());
    const count = fixtureContext.reads.length; fixtureContext.advance(120000); const replay = await fixtureContext.invoke({ panel_request: first.structuredContent.panelRequest.token });
    assert.deepEqual(replay.structuredContent.data.reliability, reliability); assert.equal(fixtureContext.reads.length, count); assert.equal(fixtureContext.pipe.count, 1);
    for (const meta of [null, { fetchedAt: 'bad' }, { fetchedAt: now + 60000 }, 'unreadable']) {
      const clockFixture = await fixture(testContext, { ...values(), 'seed-meta:forecast:scorecard': meta }); const next = await clockFixture.invoke({});
      assert.equal(next.structuredContent.data.reliability.freshnessUnknown, true); assert.equal(next.structuredContent.stale, false);
    }
    const clockFixture = await fixture(testContext, { ...values(), 'seed-meta:forecast:scorecard': { fetchedAt: now - 36 * 3600000 - 1 } });
    assert.equal((await clockFixture.invoke({})).structuredContent.data.reliability.stale, true);
  });
  it('checks completed UTF-8 public bytes including the signed receipt before saving 131072/131073 results', async testContext => {
    const fixtureContext = await fixture(testContext, values());
    const tool = (await import('../api/mcp/registry/index.ts')).TOOL_REGISTRY.find(entry => entry.name === 'get_forecast_predictions');
    const old = tool._execute; testContext.after(() => { tool._execute = old; });
    let target = 131072;
    tool._execute = async (unusedArguments, unusedOptions, unusedContext, execution) => {
      const value = { data: { predictions, familyOutcomes }, panelRequest: execution.panelRequest, notice: 'é', attribution: 'Fixture source', padding: '' };
      value.padding = 'x'.repeat(target - Buffer.byteLength(JSON.stringify(value)));
      assert.equal(Buffer.byteLength(JSON.stringify(value)), target); return value;
    };
    const first = await fixtureContext.invoke({}); assert.equal(first.structuredContent._budget_exceeded, undefined);
    assert.deepEqual(first.structuredContent.data.familyOutcomes, familyOutcomes);
    target = 131073; const before = fixtureContext.pipe.ops.flat().filter(operation => operation[0] === 'SET').length;
    const second = await fixtureContext.invoke({ refresh: true, request_id: 'ee947e6a-4a49-4f7d-9c44-0dc6cdd7c041' });
    assert.equal(second.structuredContent._budget_exceeded, true);
    assert.equal(fixtureContext.pipe.ops.flat().filter(operation => operation[0] === 'SET').length, before, 'oversized completed output must not save a public snapshot');
    const projected = await fixtureContext.invoke({ refresh: true, request_id: 'f4ef78a9-f2a6-4d45-90c5-89acd4d1aa55', jmespath: 'data.predictions' });
    assert.equal(projected.structuredContent._budget_exceeded, true, 'a selective reply must not admit an oversized full public snapshot');
    assert.equal(fixtureContext.pipe.ops.flat().filter(operation => operation[0] === 'SET').length, before, 'selective projection must not bypass the complete public snapshot limit');
    tool._execute = undefined;
    fixtureContext.values['forecast:predictions:v2'] = { ...predictions, predictions: [{ ...predictions.predictions[0], title: 'x'.repeat(140000) }] };
    const summarized = await fixtureContext.invoke({ refresh: true, request_id: 'c78df96e-604c-4c23-a635-fca8dbf50daa', summary: true });
    assert.equal(summarized.structuredContent._budget_exceeded, true, 'summary must not admit the oversized complete production cache document');
    assert.equal(fixtureContext.pipe.ops.flat().filter(operation => operation[0] === 'SET').length, before, 'summary must not save oversized full public predictions');
  });
});
