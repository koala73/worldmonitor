import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HMAC_SECRET, callBody, makeProDeps, proReq } from './helpers/mcp-pro-deps.mjs';
import { admitCountryPanel, authorizePanelRead, PANEL_READ_LIMIT } from '../api/mcp/panel-requests.ts';
import { countryActivityQueries } from '../shared/country-activity-query.ts';
import { envPrefix } from '../server/_shared/pro-mcp-token.ts';

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
      await read.save({ countryCode: 'US', brief: 'Controlled assessment', headlines: [] });
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
    for (const [name, args] of [
      ['get_country_brief_section', { section: 'energy', arguments: { country_code: 'UA' } }],
      ['get_country_brief_section', { section: 'flows', arguments: { reporter_code: '156' } }],
      ['get_country_brief_section', { section: 'flows', arguments: { reporter_code: '840' } }],
      ['get_country_brief_section', { section: 'production', arguments: { commodity: 'copper', iso2: 'CN' } }],
      ['get_country_brief_section', { section: 'markets', arguments: { category: 'country:UA', page_size: 5 } }],
      ['get_country_brief_section', { section: 'china', arguments: {} }],
      ['get_country_brief', { country_code: 'US', framework: 'Custom' }],
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
    await snapshot.save({ data: { earthquakes: { earthquakes: [] }, events: { events: [] } } });
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
    globalThis.fetch = async url => {
      fetched.push(String(url));
      assert.ok(String(url).startsWith('https://market-seed.invalid/get/'), 'curated cache only');
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
  it('shares one allocation across opens and filters, while refresh retries share their original allocation', async () => {
    const { deps, pipe } = makeProDeps();
    const first = await invoke(deps, { symbols: ['AAPL'], asset_class: ['equity'] });
    const receipt = first.body.result.structuredContent.panelRequest;
    assert.equal(receipt?.panel, 'markets');
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
  it('rejects invalid filters, refresh controls and foreign receipts before quota or source work', async () => {
    const { deps, pipe } = makeProDeps();
    for (const args of [{ unknown: true }, { symbols: 'AAPL' }, { symbols: [1] }, { asset_class: ['forex'] }, { limit: -1 }, { limit: 1.5 }, { refresh: true }, { refresh: true, request_id: 'bad' }]) {
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
});
