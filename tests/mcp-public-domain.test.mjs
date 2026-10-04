import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import handler from '../api/mcp.ts';
import { TOOL_REGISTRY, buildPublicTool, toolAccess, toolWeight } from '../api/mcp/registry/index.ts';

const previousFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = previousFetch; });
const tool = name => { const found = TOOL_REGISTRY.find(t => t.name === name); assert.ok(found, name); return found; };
const call = (name, args = {}) => tool(name)._execute(args, 'https://worldmonitor.app', { kind: 'env_key', apiKey: 'wm_public_fixture' });
const gold = { goldPrice: 2100, goldChangePct: -1, goldSparkline: [0, 2100], silverPrice: 0,
  platinumPrice: 950, palladiumPrice: 1000, crossCurrencyPrices: [], drivers: [], updatedAt: '', unavailable: false,
  cot: { openInterest: '9007199254740993', reportDate: '2026-09-22', nextReleaseDate: '2026-09-29',
    managedMoney: { longPositions: '9007199254740993', shortPositions: '0', wowNetDelta: '-42', netPct: 0, oiSharePct: 10 } },
  etfFlows: { asOfDate: '2026-09-30', tonnes: 100, aumUsd: 10, nav: 2, changeW1Tonnes: 0,
    changeM1Tonnes: -1, changeY1Tonnes: 2, changeW1Pct: 0, changeM1Pct: -1, changeY1Pct: 2, sparkline90d: [] } };
const anomaly = { uuid: 'a', type: 'ANOMALY', status: 'ONGOING', startDate: 1, endDate: 0,
  asn: '', asnName: '', locationCode: 'DE', locationName: 'Germany', latitude: 50, longitude: 10 };
const ddos = { protocol: [{ label: 'UDP', percentage: 0 }], vector: [], topTargetLocations: [],
  dateRangeStart: '2026-09-23', dateRangeEnd: '2026-09-30' };

describe('public domain MCP tools', () => {
  it('preserves gold precision, optional enrichment and availability through a fixed authenticated GET', async () => {
    globalThis.fetch = async (input, init) => {
      assert.equal(new URL(String(input)).pathname, '/api/market/v1/get-gold-intelligence');
      assert.equal(init.headers['X-WorldMonitor-Key'], 'wm_public_fixture');
      return Response.json(gold);
    };
    assert.deepEqual(await call('get_gold_intelligence'), gold);
    globalThis.fetch = async () => Response.json({ ...gold, unavailable: true, goldPrice: 0 });
    assert.equal((await call('get_gold_intelligence')).unavailable, true);
  });
  it('normalizes traffic countries, bounds matching rows and retains the global total', async () => {
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      assert.equal(url.pathname, '/api/infrastructure/v1/list-internet-traffic-anomalies');
      assert.deepEqual(Object.fromEntries(url.searchParams), { country: 'DE' });
      return Response.json({ anomalies: [anomaly, { ...anomaly, uuid: 'b' }], totalCount: 15 });
    };
    assert.deepEqual(await call('get_internet_activity', { dataset: 'traffic', country: 'Germany', limit: 1 }),
      { dataset: 'traffic', data: { anomalies: [anomaly], totalCount: 15 }, truncated: true });
  });
  it('keeps global DDoS percentages and observation dates with independent list caps', async () => {
    globalThis.fetch = async input => {
      assert.equal(new URL(String(input)).pathname, '/api/infrastructure/v1/list-internet-ddos-attacks');
      assert.equal(new URL(String(input)).search, '');
      return Response.json({ ...ddos, vector: [{ label: 'a', percentage: 5 }, { label: 'b', percentage: 4 }] });
    };
    assert.deepEqual(await call('get_internet_activity', { dataset: 'ddos', limit: 1 }),
      { dataset: 'ddos', data: { ...ddos, vector: [{ label: 'a', percentage: 5 }] }, truncated: true });
  });
  it('preserves valid empty traffic and distinguishes unavailable cache/backoff/billing', async () => {
    globalThis.fetch = async () => Response.json({ anomalies: [], totalCount: 0 });
    assert.deepEqual(await call('get_internet_activity', { dataset: 'traffic' }),
      { dataset: 'traffic', data: { anomalies: [], totalCount: 0 }, truncated: false });
    for (const name of ['get_gold_intelligence', 'get_internet_activity']) {
      const args = name === 'get_internet_activity' ? { dataset: 'traffic' } : {};
      globalThis.fetch = async () => new Response(null, { status: 503 });
      await assert.rejects(call(name, args));
      globalThis.fetch = async () => new Response(null, { status: 429, headers: { 'Retry-After': '12' } });
      await assert.rejects(call(name, args), e => e.name === 'ToolBackoffError' && e.retryAfter === '12');
      globalThis.fetch = async () => new Response(null, { status: 403, headers: { 'X-Billing-Verification': 'subscription_lapsed' } });
      await assert.rejects(call(name, args), e => e.name === 'BillingDenialError');
    }
  });
  it('rejects unknown/mode-specific selections and invalid limits before fetching', async () => {
    globalThis.fetch = async () => assert.fail('must not fetch');
    for (const args of [{}, { dataset: 'other' }, { dataset: 'ddos', country: 'DE' },
      { dataset: 'traffic', country: 'unknown country' }, ...[0, 101, 1.5, '3'].map(limit => ({ dataset: 'traffic', limit }))]) {
      await assert.rejects(call('get_internet_activity', args), e => e.name === 'RpcValidationError');
    }
  });
  it('advertises source-shaped schemas, read-only subscription access and standard downstream weight', () => {
    const ajv = new Ajv2020({ strict: true, strictRequired: false, allowUnionTypes: true, validateFormats: false });
    for (const [name, value] of [['get_gold_intelligence', gold], ['get_internet_activity', { dataset: 'ddos', data: ddos, truncated: false }],
      ['get_internet_activity', { dataset: 'traffic', data: { anomalies: [anomaly], totalCount: 1 }, truncated: false }]]) {
      const t = tool(name); const validate = ajv.compile(buildPublicTool(t, { compressDescriptions: true }).outputSchema.anyOf[0]);
      assert.ok(validate(value), JSON.stringify(validate.errors));
      assert.equal(toolAccess(t), 'subscription'); assert.equal(toolWeight(t), 2);
      assert.equal(t.annotations.readOnlyHint, true);
    }
  });
  it('dispatches real MCP calls and denies missing credentials', async () => {
    const oldKeys = process.env.WORLDMONITOR_VALID_KEYS;
    process.env.WORLDMONITOR_VALID_KEYS = 'wm_public_fixture';
    try {
      globalThis.fetch = async input => Response.json(String(input).includes('gold') ? gold : ddos);
      for (const [name, args, expected] of [['get_gold_intelligence', {}, gold],
        ['get_internet_activity', { dataset: 'ddos' }, { dataset: 'ddos', data: ddos, truncated: false }]]) {
        const request = key => new Request('https://worldmonitor.app/mcp', { method: 'POST', headers: {
          'Content-Type': 'application/json', ...(key ? { 'X-WorldMonitor-Key': key } : {}),
        }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
        const result = (await (await handler(request('wm_public_fixture'))).json()).result;
        assert.notEqual(result.isError, true); assert.deepEqual(result.structuredContent, expected);
        assert.equal((await handler(request())).status, 401);
      }
    } finally { if (oldKeys === undefined) delete process.env.WORLDMONITOR_VALID_KEYS; else process.env.WORLDMONITOR_VALID_KEYS = oldKeys; }
  });
  it('reads real gold and internet producers through the same MCP adapters', async () => {
    const keys = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'VERCEL_ENV'];
    const env = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    process.env.UPSTASH_REDIS_REST_URL = 'https://stub-upstash.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'stub'; process.env.VERCEL_ENV = 'production';
    const store = new Map([
      ['market:commodities-bootstrap:v1', { quotes: [{ symbol: 'GC=F', price: 3200, change: 1, sparkline: [] }, { symbol: 'SI=F', price: 40, change: 0, sparkline: [] }] }],
      ['cf:radar:traffic-anomalies:v1', { anomalies: [anomaly, { ...anomaly, uuid: 'b' }, { ...anomaly, uuid: 'c', locationCode: 'US' }] }],
      ['cf:radar:ddos:v1', ddos],
    ]);
    try {
      const { getGoldIntelligence } = await import('../server/worldmonitor/market/v1/get-gold-intelligence.ts');
      const { listInternetTrafficAnomalies } = await import('../server/worldmonitor/infrastructure/v1/list-traffic-anomalies.ts');
      const { listInternetDdosAttacks } = await import('../server/worldmonitor/infrastructure/v1/list-ddos-attacks.ts');
      globalThis.fetch = async input => {
        const url = new URL(String(input));
        if (url.hostname === 'stub-upstash.test') {
          const key = decodeURIComponent(url.pathname.replace(/^\/get\//, ''));
          return Response.json({ result: store.has(key) ? JSON.stringify(store.get(key)) : null });
        }
        if (url.pathname.endsWith('/get-gold-intelligence')) return Response.json(await getGoldIntelligence({}, {}));
        if (url.pathname.endsWith('/list-internet-traffic-anomalies')) return Response.json(await listInternetTrafficAnomalies({}, { country: url.searchParams.get('country') ?? '' }));
        if (url.pathname.endsWith('/list-internet-ddos-attacks')) return Response.json(await listInternetDdosAttacks({}, {}));
        assert.fail(url.href);
      };
      const g = await call('get_gold_intelligence');
      assert.equal(g.goldSilverRatio, 80); assert.equal(g.unavailable, false); assert.equal(g.etfFlows, undefined);
      const ajv = new Ajv2020({ strict: true, strictRequired: false, allowUnionTypes: true, validateFormats: false });
      const validate = ajv.compile(buildPublicTool(tool('get_gold_intelligence'), { compressDescriptions: true }).outputSchema.anyOf[0]);
      assert.ok(validate(g), JSON.stringify(validate.errors));
      const t = await call('get_internet_activity', { dataset: 'traffic', country: 'DEU', limit: 1 });
      assert.deepEqual(t, { dataset: 'traffic', data: { anomalies: [anomaly], totalCount: 3 }, truncated: true });
      assert.deepEqual((await call('get_internet_activity', { dataset: 'ddos' })).data, ddos);
      store.delete('cf:radar:ddos:v1');
      await assert.rejects(call('get_internet_activity', { dataset: 'ddos' }), e => e.statusCode === 503);
    } finally { for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  });
});
