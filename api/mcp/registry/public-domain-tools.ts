import type { GetGoldIntelligenceResponse } from '../../../src/generated/server/worldmonitor/market/v1/service_server';
import { buildAuthHeaders } from '../auth';
import { assertToolFetchOk } from '../billing-denial';
import { fetchMcpDownstream } from '../downstream';
import type { ToolDef } from '../types';

const number = { type: 'number' };
const string = { type: 'string' };
const cotCategory = { type: 'object', properties: {
  longPositions: string, shortPositions: string, wowNetDelta: string, netPct: number, oiSharePct: number,
} };


export const PUBLIC_DOMAIN_TOOLS: ToolDef[] = [{
  name: 'get_gold_intelligence',
  title: 'Gold market intelligence',
  description: 'Return the seeded gold-market snapshot: precious-metal futures quotes, cross-currency gold prices, CFTC COT positioning, session returns and ranges, price drivers, ETF holdings and central-bank reserves when available. Prices are USD per troy ounce unless a cross-currency row states its currency; returns and changes are percentages; COT counts are decimal strings; ETF holdings are tonnes and AUM USD; reserves are tonnes. unavailable:true and missing enrichment blocks mark absent data, placeholder zero prices are not confirmed observations, and each enrichment carries its own observation date (updatedAt is not a freshness guarantee for every source). Takes no arguments. Requires a paid plan; one downstream fetch of seeded data, weight 2 on API plans. Read-only; no trade or research snapshot is created.',
  _outputBudgetBytes: 131072,
  inputSchema: { type: 'object', properties: {}, required: [] },
  outputSchema: { type: 'object', required: ['unavailable'], properties: {
    goldPrice: number, goldChangePct: number, goldSparkline: { type: 'array', items: number },
    silverPrice: number, platinumPrice: number, palladiumPrice: number,
    goldSilverRatio: number, goldPlatinumPremiumPct: number,
    crossCurrencyPrices: { type: 'array', items: { type: 'object', properties: { currency: string, flag: string, price: number } } },
    cot: { type: 'object', properties: { reportDate: string, nextReleaseDate: string, openInterest: string,
      managedMoney: cotCategory, producerSwap: cotCategory } },
    updatedAt: string, unavailable: { type: 'boolean' },
    session: { type: 'object', properties: { dayHigh: number, dayLow: number, prevClose: number } },
    returns: { type: 'object', properties: { w1: number, m1: number, ytd: number, y1: number } },
    range52w: { type: 'object', properties: { hi: number, lo: number, positionPct: number } },
    drivers: { type: 'array', items: { type: 'object', properties: {
      symbol: string, label: string, value: number, changePct: number, correlation30d: number,
    } } },
    etfFlows: { type: 'object', properties: {
      asOfDate: string, tonnes: number, aumUsd: number, nav: number, changeW1Tonnes: number,
      changeM1Tonnes: number, changeY1Tonnes: number, changeW1Pct: number, changeM1Pct: number,
      changeY1Pct: number, sparkline90d: { type: 'array', items: number },
    } },
    cbReserves: { type: 'object', properties: { asOfMonth: string, totalTonnes: number,
      topHolders: { type: 'array', items: { type: 'object', properties: { iso3: string, name: string, tonnes: number, pctOfReserves: number } } },
      topBuyers12m: { type: 'array', items: { type: 'object', properties: { iso3: string, name: string, deltaTonnes12m: number } } },
      topSellers12m: { type: 'array', items: { type: 'object', properties: { iso3: string, name: string, deltaTonnes12m: number } } },
    } },
  } },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _execute: async (_params, base, context, execution) => {
    const url = `${base}/api/market/v1/get-gold-intelligence`;
    const auth = await buildAuthHeaders(context, 'GET', url, null);
    const response = await fetchMcpDownstream(url, {
      headers: { ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' }, signal: AbortSignal.timeout(25_000),
    }, execution);
    await assertToolFetchOk(response, 'get_gold_intelligence', { preserveBackoff: true });
    return await response.json() as GetGoldIntelligenceResponse;
  },
  _apiPaths: ['GET /api/market/v1/get-gold-intelligence'],
}];
