/**
 * RPC: getTradeRestrictions -- WTO tariff-based trade restriction overview
 *
 * Shows countries with highest applied tariff rates as a proxy for trade restrictiveness.
 * Uses MFN simple average tariffs across all products, agricultural, and non-agricultural sectors.
 *
 * NOTE: The WTO Quantitative Restrictions (QR) API is a separate subscription product.
 * This handler uses the Timeseries API tariff data as an available proxy for trade barriers.
 */

declare const process: { env: Record<string, string | undefined> };

import type {
  ServerContext,
  GetTradeRestrictionsRequest,
  GetTradeRestrictionsResponse,
  TradeRestriction,
} from '../../../../src/generated/server/worldmonitor/trade/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';
import { wtoFetch, WTO_MEMBER_CODES } from './_shared';

const REDIS_CACHE_KEY = 'trade:restrictions:v1';
const REDIS_CACHE_TTL = 21600; // 6h — WTO data is annual, rarely changes

/** Major economies to query for tariff data. */
const MAJOR_REPORTERS = ['840', '156', '276', '392', '826', '356', '076', '643', '410', '036', '124', '484', '250', '380', '528'];

/**
 * Transform a raw WTO tariff row into a TradeRestriction (tariff-as-barrier view).
 */
function toRestriction(row: any): TradeRestriction | null {
  if (!row) return null;
  const value = parseFloat(row.Value ?? row.value ?? '');
  if (isNaN(value)) return null;

  const reporterCode = String(row.ReportingEconomyCode ?? row.reportingEconomyCode ?? '');
  const year = String(row.Year ?? row.year ?? row.Period ?? '');
  const indicator = String(row.Indicator ?? row.indicator ?? row.IndicatorCode ?? '');

  return {
    id: `${reporterCode}-${year}-${row.IndicatorCode ?? ''}`,
    reportingCountry: WTO_MEMBER_CODES[reporterCode] ?? String(row.ReportingEconomy ?? row.reportingEconomy ?? ''),
    affectedCountry: 'All trading partners',
    productSector: indicator.includes('agricultural')
      ? (indicator.includes('non-') ? 'Non-agricultural products' : 'Agricultural products')
      : 'All products',
    measureType: 'MFN Applied Tariff',
    description: `Average tariff rate: ${value.toFixed(1)}%`,
    status: value > 10 ? 'high' : value > 5 ? 'moderate' : 'low',
    notifiedAt: year,
    sourceUrl: 'https://stats.wto.org',
  };
}

async function fetchRestrictions(
  _countries: string[],
  limit: number,
): Promise<{ restrictions: TradeRestriction[]; ok: boolean }> {
  const currentYear = new Date().getFullYear();

  // Fetch all-products tariff for major economies (most recent years)
  const params: Record<string, string> = {
    i: 'TP_A_0010',
    r: MAJOR_REPORTERS.join(','),
    ps: `${currentYear - 3}-${currentYear}`,
    fmt: 'json',
    mode: 'full',
    max: String(limit * 3),
  };

  const data = await wtoFetch('/data', params);
  if (!data) return { restrictions: [], ok: false };

  const dataset: any[] = Array.isArray(data) ? data : data?.Dataset ?? data?.dataset ?? [];

  // Keep only the most recent year per country
  const latestByCountry = new Map<string, any>();
  for (const row of dataset) {
    const code = String(row.ReportingEconomyCode ?? '');
    const year = parseInt(row.Year ?? row.year ?? '0', 10);
    const existing = latestByCountry.get(code);
    if (!existing || year > parseInt(existing.Year ?? existing.year ?? '0', 10)) {
      latestByCountry.set(code, row);
    }
  }

  const restrictions = Array.from(latestByCountry.values())
    .map(toRestriction)
    .filter((r): r is TradeRestriction => r !== null)
    .sort((a, b) => {
      // Sort by tariff rate descending (extract from description)
      const rateA = parseFloat(a.description.match(/[\d.]+/)?.[0] ?? '0');
      const rateB = parseFloat(b.description.match(/[\d.]+/)?.[0] ?? '0');
      return rateB - rateA;
    })
    .slice(0, limit);

  return { restrictions, ok: true };
}

export async function getTradeRestrictions(
  _ctx: ServerContext,
  req: GetTradeRestrictionsRequest,
): Promise<GetTradeRestrictionsResponse> {
  try {
    const limit = Math.max(1, Math.min(req.limit > 0 ? req.limit : 50, 100));

    const cacheKey = `${REDIS_CACHE_KEY}:tariff-overview:${limit}`;
    const result = await cachedFetchJson<GetTradeRestrictionsResponse>(
      cacheKey,
      REDIS_CACHE_TTL,
      async () => {
        const { restrictions, ok } = await fetchRestrictions([], limit);
        if (!ok || restrictions.length === 0) return null;
        return { restrictions, fetchedAt: new Date().toISOString(), upstreamUnavailable: false };
      },
    );

    return result ?? { restrictions: [], fetchedAt: new Date().toISOString(), upstreamUnavailable: true };
  } catch {
    return {
      restrictions: [],
      fetchedAt: new Date().toISOString(),
      upstreamUnavailable: true,
    };
  }
}
