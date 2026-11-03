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
  it('distinguishes unavailable cache, backoff and billing', async () => {
    globalThis.fetch = async () => new Response(null, { status: 503 });
    await assert.rejects(call('get_gold_intelligence'));
    globalThis.fetch = async () => new Response(null, { status: 429, headers: { 'Retry-After': '12' } });
    await assert.rejects(call('get_gold_intelligence'), e => e.name === 'ToolBackoffError' && e.retryAfter === '12');
    globalThis.fetch = async () => new Response(null, { status: 403, headers: { 'X-Billing-Verification': 'subscription_lapsed' } });
    await assert.rejects(call('get_gold_intelligence'), e => e.name === 'BillingDenialError');
  });
  it('advertises source-shaped schemas, read-only subscription access and standard downstream weight', () => {
    const ajv = new Ajv2020({ strict: true, strictRequired: false, allowUnionTypes: true, validateFormats: false });
    const t = tool('get_gold_intelligence');
    const validate = ajv.compile(buildPublicTool(t, { compressDescriptions: true }).outputSchema.anyOf[0]);
    assert.ok(validate(gold), JSON.stringify(validate.errors));
    assert.equal(toolAccess(t), 'subscription'); assert.equal(toolWeight(t), 2);
    assert.equal(t.annotations.readOnlyHint, true);
  });
  it('dispatches real MCP calls and denies missing credentials', async () => {
    const oldKeys = process.env.WORLDMONITOR_VALID_KEYS;
    process.env.WORLDMONITOR_VALID_KEYS = 'wm_public_fixture';
    try {
      globalThis.fetch = async () => Response.json(gold);
      const request = key => new Request('https://worldmonitor.app/mcp', { method: 'POST', headers: {
        'Content-Type': 'application/json', ...(key ? { 'X-WorldMonitor-Key': key } : {}),
      }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_gold_intelligence', arguments: {} } }) });
      const result = (await (await handler(request('wm_public_fixture'))).json()).result;
      assert.notEqual(result.isError, true); assert.deepEqual(result.structuredContent, gold);
      assert.equal((await handler(request())).status, 401);
    } finally { if (oldKeys === undefined) delete process.env.WORLDMONITOR_VALID_KEYS; else process.env.WORLDMONITOR_VALID_KEYS = oldKeys; }
  });
  it('reads the real gold producer through the MCP adapter', async () => {
    const keys = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'VERCEL_ENV'];
    const env = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    process.env.UPSTASH_REDIS_REST_URL = 'https://stub-upstash.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'stub'; process.env.VERCEL_ENV = 'production';
    const store = new Map([
      ['market:commodities-bootstrap:v1', { quotes: [{ symbol: 'GC=F', price: 3200, change: 1, sparkline: [] }, { symbol: 'SI=F', price: 40, change: 0, sparkline: [] }] }],
    ]);
    try {
      const { getGoldIntelligence } = await import('../server/worldmonitor/market/v1/get-gold-intelligence.ts');
      globalThis.fetch = async input => {
        const url = new URL(String(input));
        if (url.hostname === 'stub-upstash.test') {
          const key = decodeURIComponent(url.pathname.replace(/^\/get\//, ''));
          return Response.json({ result: store.has(key) ? JSON.stringify(store.get(key)) : null });
        }
        if (url.pathname.endsWith('/get-gold-intelligence')) return Response.json(await getGoldIntelligence({}, {}));
        assert.fail(url.href);
      };
      const g = await call('get_gold_intelligence');
      assert.equal(g.goldSilverRatio, 80); assert.equal(g.unavailable, false); assert.equal(g.etfFlows, undefined);
      const ajv = new Ajv2020({ strict: true, strictRequired: false, allowUnionTypes: true, validateFormats: false });
      const validate = ajv.compile(buildPublicTool(tool('get_gold_intelligence'), { compressDescriptions: true }).outputSchema.anyOf[0]);
      assert.ok(validate(g), JSON.stringify(validate.errors));
    } finally { for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  });
});
