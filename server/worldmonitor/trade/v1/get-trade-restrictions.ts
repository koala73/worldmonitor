/**
 * RPC: getTradeRestrictions -- WTO trade restriction/QR notifications
 * Fetches quantitative restriction and related trade measure data.
 */

declare const process: { env: Record<string, string | undefined> };

import type {
  ServerContext,
  GetTradeRestrictionsRequest,
  GetTradeRestrictionsResponse,
  TradeRestriction,
} from '../../../../src/generated/server/worldmonitor/trade/v1/service_server';

import { getCachedJson, setCachedJson } from '../../../_shared/redis';
import { wtoFetch, WTO_MEMBER_CODES } from './_shared';

const REDIS_CACHE_KEY = 'trade:restrictions:v1';
const REDIS_CACHE_TTL = 21600; // 6h

/**
 * Validate a country code string — alphanumeric, max 10 chars.
 */
function isValidCountry(c: string): boolean {
  return /^[a-zA-Z0-9]{1,10}$/.test(c);
}

/**
 * Transform a raw WTO data row into a TradeRestriction.
 */
function toRestriction(row: any): TradeRestriction | null {
  if (!row) return null;
  return {
    id: String(row.id ?? row.Id ?? ''),
    reportingCountry:
      WTO_MEMBER_CODES[String(row.ReportingEconomyCode ?? row.reportingEconomyCode ?? '')] ??
      String(row.ReportingEconomy ?? row.reportingEconomy ?? ''),
    affectedCountry:
      WTO_MEMBER_CODES[String(row.PartnerEconomyCode ?? row.partnerEconomyCode ?? '')] ??
      String(row.PartnerEconomy ?? row.partnerEconomy ?? ''),
    productSector: String(row.ProductOrSector ?? row.productOrSector ?? ''),
    measureType: String(row.IndicatorCategory ?? row.indicatorCategory ?? row.Indicator ?? ''),
    description: String(row.Value ?? row.value ?? ''),
    status: String(row.ValueFlag ?? row.valueFlag ?? 'active'),
    notifiedAt: String(row.Year ?? row.year ?? row.Period ?? ''),
    sourceUrl: 'https://www.wto.org',
  };
}

async function fetchRestrictions(
  countries: string[],
  limit: number,
): Promise<{ restrictions: TradeRestriction[]; ok: boolean }> {
  const params: Record<string, string> = {
    i: 'QR', // Quantitative restrictions indicator group
    r: countries.length > 0 ? countries.join(',') : '000',
    ps: 'all',
    max: String(limit),
    fmt: 'json',
    mode: 'full',
  };

  const data = await wtoFetch('/data', params);
  if (!data) return { restrictions: [], ok: false };

  const dataset: any[] = Array.isArray(data) ? data : data?.Dataset ?? data?.dataset ?? [];
  const restrictions = dataset
    .map(toRestriction)
    .filter((r): r is TradeRestriction => r !== null)
    .slice(0, limit);

  return { restrictions, ok: true };
}

export async function getTradeRestrictions(
  _ctx: ServerContext,
  req: GetTradeRestrictionsRequest,
): Promise<GetTradeRestrictionsResponse> {
  try {
    // Input validation
    const countries = (req.countries ?? []).filter(isValidCountry);
    const limit = Math.max(1, Math.min(req.limit > 0 ? req.limit : 50, 100));

    const cacheKey = `${REDIS_CACHE_KEY}:${countries.sort().join(',') || 'all'}:${limit}`;
    const cached = (await getCachedJson(cacheKey)) as GetTradeRestrictionsResponse | null;
    if (cached?.restrictions?.length) return cached;

    const { restrictions, ok } = await fetchRestrictions(countries, limit);

    if (!ok) {
      // Upstream unavailable — return stale cache or empty
      return {
        restrictions: cached?.restrictions ?? [],
        fetchedAt: new Date().toISOString(),
        upstreamUnavailable: true,
      };
    }

    const result: GetTradeRestrictionsResponse = {
      restrictions,
      fetchedAt: new Date().toISOString(),
      upstreamUnavailable: false,
    };

    if (restrictions.length > 0) {
      setCachedJson(cacheKey, result, REDIS_CACHE_TTL).catch(() => {});
    }

    return result;
  } catch {
    return {
      restrictions: [],
      fetchedAt: new Date().toISOString(),
      upstreamUnavailable: true,
    };
  }
}
