/**
 * RPC: getTradeBarriers -- WTO SPS/TBT barrier notifications
 * Fetches sanitary/phytosanitary and technical barrier notifications.
 */

declare const process: { env: Record<string, string | undefined> };

import type {
  ServerContext,
  GetTradeBarriersRequest,
  GetTradeBarriersResponse,
  TradeBarrier,
} from '../../../../src/generated/server/worldmonitor/trade/v1/service_server';

import { getCachedJson, setCachedJson } from '../../../_shared/redis';
import { wtoFetch, WTO_MEMBER_CODES } from './_shared';

const REDIS_CACHE_TTL = 21600; // 6h

/** Valid measure types for barrier queries. */
const VALID_MEASURE_TYPES = ['SPS', 'TBT', 'ALL'];

/**
 * Validate a country code string — alphanumeric, max 10 chars.
 */
function isValidCountry(c: string): boolean {
  return /^[a-zA-Z0-9]{1,10}$/.test(c);
}

/**
 * Transform a raw WTO data row into a TradeBarrier.
 */
function toBarrier(row: any): TradeBarrier | null {
  if (!row) return null;
  return {
    id: String(row.id ?? row.Id ?? row.DocumentSymbol ?? ''),
    notifyingCountry:
      WTO_MEMBER_CODES[String(row.ReportingEconomyCode ?? row.reportingEconomyCode ?? '')] ??
      String(row.ReportingEconomy ?? row.reportingEconomy ?? row.Member ?? ''),
    title: String(row.Title ?? row.title ?? row.Value ?? row.value ?? ''),
    measureType: String(row.IndicatorCategory ?? row.indicatorCategory ?? row.Indicator ?? ''),
    productDescription: String(row.ProductOrSector ?? row.productOrSector ?? ''),
    objective: String(row.Objective ?? row.objective ?? ''),
    status: String(row.ValueFlag ?? row.valueFlag ?? row.Status ?? 'notified'),
    dateDistributed: String(row.Year ?? row.year ?? row.DateDistributed ?? ''),
    sourceUrl: 'https://www.wto.org',
  };
}

async function fetchBarriers(
  countries: string[],
  measureType: string,
  limit: number,
): Promise<{ barriers: TradeBarrier[]; ok: boolean }> {
  // Determine indicator code based on measure type
  const indicator = measureType === 'SPS' ? 'SPS' : measureType === 'TBT' ? 'TBT' : 'SPS,TBT';

  const params: Record<string, string> = {
    i: indicator,
    r: countries.length > 0 ? countries.join(',') : '000',
    ps: 'all',
    max: String(limit),
    fmt: 'json',
    mode: 'full',
  };

  const data = await wtoFetch('/data', params);
  if (!data) return { barriers: [], ok: false };

  const dataset: any[] = Array.isArray(data) ? data : data?.Dataset ?? data?.dataset ?? [];
  const barriers = dataset
    .map(toBarrier)
    .filter((b): b is TradeBarrier => b !== null)
    .slice(0, limit);

  return { barriers, ok: true };
}

export async function getTradeBarriers(
  _ctx: ServerContext,
  req: GetTradeBarriersRequest,
): Promise<GetTradeBarriersResponse> {
  try {
    // Input validation
    const countries = (req.countries ?? []).filter(isValidCountry);
    const measureType =
      VALID_MEASURE_TYPES.includes((req.measureType ?? '').toUpperCase())
        ? (req.measureType ?? '').toUpperCase()
        : 'ALL';
    const limit = Math.max(1, Math.min(req.limit > 0 ? req.limit : 50, 100));

    const cacheKey = `trade:barriers:v1:${countries.sort().join(',') || 'all'}:${measureType}:${limit}`;
    const cached = (await getCachedJson(cacheKey)) as GetTradeBarriersResponse | null;
    if (cached?.barriers?.length) return cached;

    const { barriers, ok } = await fetchBarriers(countries, measureType, limit);

    if (!ok) {
      return {
        barriers: cached?.barriers ?? [],
        fetchedAt: new Date().toISOString(),
        upstreamUnavailable: true,
      };
    }

    const result: GetTradeBarriersResponse = {
      barriers,
      fetchedAt: new Date().toISOString(),
      upstreamUnavailable: false,
    };

    if (barriers.length > 0) {
      setCachedJson(cacheKey, result, REDIS_CACHE_TTL).catch(() => {});
    }

    return result;
  } catch {
    return {
      barriers: [],
      fetchedAt: new Date().toISOString(),
      upstreamUnavailable: true,
    };
  }
}
