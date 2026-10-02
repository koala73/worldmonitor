import type { GetGoldIntelligenceResponse } from '../../../src/generated/server/worldmonitor/market/v1/service_server';
import type { ListInternetTrafficAnomaliesResponse, ListInternetDdosAttacksResponse } from '../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';
import { COUNTRY_ARG_HINT, requireCountryCode } from '../_country-args';
import { buildAuthHeaders } from '../auth';
import { assertToolFetchOk, RpcValidationError } from '../billing-denial';
import { fetchMcpDownstream } from '../downstream';
import type { ToolDef } from '../types';

const number = { type: 'number' };
const string = { type: 'string' };
const cotCategory = { type: 'object', properties: {
  longPositions: string, shortPositions: string, wowNetDelta: string, netPct: number, oiSharePct: number,
} };
const ddosShare = { type: 'object', properties: { label: string, percentage: number } };
const INTERNET_PATHS = {
  traffic: '/api/infrastructure/v1/list-internet-traffic-anomalies',
  ddos: '/api/infrastructure/v1/list-internet-ddos-attacks',
} as const;

export const PUBLIC_DOMAIN_TOOLS: ToolDef[] = [{
  name: 'get_gold_intelligence',
  description: 'Read seeded gold intelligence: precious-metal futures quotes, cross-currency gold prices, COT positioning, session/returns/range, drivers, ETF holdings and central-bank reserves when available. Prices are USD per troy ounce unless a cross-currency row states its currency; returns/changes are percentages. Preserve unavailable: true and missing enrichment; placeholder zero prices are not confirmed zero observations. COT counts are decimal strings, ETF holdings tonnes/AUM USD, central-bank reserves tonnes. Each enrichment has its own observation date; updatedAt does not establish freshness of all sources. No trade or research snapshot is created.',
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
}, {
  name: 'get_internet_activity',
  description: 'Read Cloudflare Radar seeded traffic anomalies or global DDoS summaries. Traffic accepts optional country and returns at most limit matching anomalies (default 30, max 100); totalCount remains the upstream global count before filtering. DDoS protocol/vector percentages and target countries are global for dateRangeStart..dateRangeEnd and cannot be filtered by country. Each returned list is capped independently; truncated means at least one list was cut. Traffic timestamps are epoch milliseconds; endDate 0 means ongoing. A missing cache returns an error, while a valid empty list means no recorded rows. No load time is presented as source freshness.',
  _outputBudgetBytes: 131072,
  inputSchema: { type: 'object', properties: {
    dataset: { type: 'string', enum: Object.keys(INTERNET_PATHS) },
    country: { type: 'string', description: `Traffic only. ${COUNTRY_ARG_HINT}` },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
  }, required: ['dataset'] },
  outputSchema: { type: 'object', required: ['dataset', 'data', 'truncated'], properties: {
    dataset: { type: 'string', enum: Object.keys(INTERNET_PATHS) }, truncated: { type: 'boolean' },
    data: { type: 'object', properties: {
      anomalies: { type: 'array', items: { type: 'object', properties: {
        uuid: string, type: string, status: string, startDate: number, endDate: number,
        asn: string, asnName: string, locationCode: string, locationName: string, latitude: number, longitude: number,
      } } }, totalCount: { type: 'integer' },
      protocol: { type: 'array', items: ddosShare }, vector: { type: 'array', items: ddosShare },
      dateRangeStart: string, dateRangeEnd: string,
      topTargetLocations: { type: 'array', items: { type: 'object', properties: {
        countryCode: string, countryName: string, percentage: number, latitude: number, longitude: number,
      } } },
    } },
  } },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _execute: async (params, base, context, execution) => {
    const invalid = (field: string, description: string): never => { throw new RpcValidationError('get_internet_activity', [{ field, description }]); };
    if (typeof params.dataset !== 'string' || !Object.prototype.hasOwnProperty.call(INTERNET_PATHS, params.dataset)) invalid('dataset', 'Select traffic or ddos.');
    const dataset = params.dataset as keyof typeof INTERNET_PATHS;
    if (dataset === 'ddos' && params.country !== undefined) invalid('country', 'DDoS summaries are global; country filtering is only supported for traffic.');
    const country = params.country === undefined ? undefined : requireCountryCode(params.country, 'get_internet_activity', 'country');
    const limit = params.limit ?? 30;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) invalid('limit', 'Expected an integer from 1 through 100.');
    const url = `${base}${INTERNET_PATHS[dataset]}${country ? `?country=${country}` : ''}`;
    const auth = await buildAuthHeaders(context, 'GET', url, null);
    const response = await fetchMcpDownstream(url, {
      headers: { ...auth, 'User-Agent': 'worldmonitor-mcp-edge/1.0' }, signal: AbortSignal.timeout(25_000),
    }, execution);
    await assertToolFetchOk(response, 'get_internet_activity', { preserveBackoff: true });
    let truncated = false;
    const cap = <T>(rows: T[]): T[] => { if (rows.length > (limit as number)) truncated = true; return rows.slice(0, limit as number); };
    if (dataset === 'traffic') {
      const data = await response.json() as ListInternetTrafficAnomaliesResponse;
      return { dataset, data: { ...data, anomalies: cap(data.anomalies) }, truncated };
    }
    const data = await response.json() as ListInternetDdosAttacksResponse;
    return { dataset, data: { ...data, protocol: cap(data.protocol), vector: cap(data.vector), topTargetLocations: cap(data.topTargetLocations) }, truncated };
  },
  _apiPaths: Object.values(INTERNET_PATHS).map(path => `GET ${path}`),
}];
