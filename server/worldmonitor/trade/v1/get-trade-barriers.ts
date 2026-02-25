/**
 * RPC: getTradeBarriers -- WTO tariff barrier analysis
 *
 * Shows agricultural vs non-agricultural tariff gap and maximum duty rates
 * as indicators of sector-specific trade barriers.
 *
 * NOTE: The WTO ePing API (SPS/TBT notifications) is a separate subscription product.
 * This handler uses Timeseries API tariff data to surface sector-level trade barriers.
 */

declare const process: { env: Record<string, string | undefined> };

import type {
  ServerContext,
  GetTradeBarriersRequest,
  GetTradeBarriersResponse,
  TradeBarrier,
} from '../../../../src/generated/server/worldmonitor/trade/v1/service_server';

import { cachedFetchJson } from '../../../_shared/redis';
import { wtoFetch, WTO_MEMBER_CODES } from './_shared';

const REDIS_CACHE_TTL = 21600; // 6h — WTO data is annual, rarely changes

/** Major economies to query. */
const MAJOR_REPORTERS = ['840', '156', '276', '392', '826', '356', '076', '643', '410', '036', '124', '484', '250', '380', '528'];

/**
 * Validate a country code string — alphanumeric, max 10 chars.
 */
function isValidCountry(c: string): boolean {
  return /^[a-zA-Z0-9]{1,10}$/.test(c);
}

interface TariffRow {
  country: string;
  countryCode: string;
  indicator: string;
  year: number;
  value: number;
}

function parseRows(data: any): TariffRow[] {
  const dataset: any[] = Array.isArray(data) ? data : data?.Dataset ?? data?.dataset ?? [];
  const rows: TariffRow[] = [];

  for (const row of dataset) {
    const year = parseInt(row.Year ?? row.year ?? '0', 10);
    const value = parseFloat(row.Value ?? row.value ?? '');
    if (isNaN(year) || isNaN(value)) continue;

    const countryCode = String(row.ReportingEconomyCode ?? '');
    rows.push({
      country: WTO_MEMBER_CODES[countryCode] ?? String(row.ReportingEconomy ?? ''),
      countryCode,
      indicator: String(row.IndicatorCode ?? ''),
      year,
      value,
    });
  }

  return rows;
}

async function fetchBarriers(
  _countries: string[],
  limit: number,
): Promise<{ barriers: TradeBarrier[]; ok: boolean }> {
  const currentYear = new Date().getFullYear();
  const reporters = MAJOR_REPORTERS.join(',');

  // Fetch agricultural and non-agricultural tariffs in parallel
  const [agriData, nonAgriData] = await Promise.all([
    wtoFetch('/data', {
      i: 'TP_A_0160',
      r: reporters,
      ps: `${currentYear - 3}-${currentYear}`,
      fmt: 'json',
      mode: 'full',
      max: '500',
    }),
    wtoFetch('/data', {
      i: 'TP_A_0430',
      r: reporters,
      ps: `${currentYear - 3}-${currentYear}`,
      fmt: 'json',
      mode: 'full',
      max: '500',
    }),
  ]);

  if (!agriData && !nonAgriData) return { barriers: [], ok: false };

  const agriRows = agriData ? parseRows(agriData) : [];
  const nonAgriRows = nonAgriData ? parseRows(nonAgriData) : [];

  // Get most recent year per country for each indicator
  const latestAgri = new Map<string, TariffRow>();
  for (const row of agriRows) {
    const existing = latestAgri.get(row.countryCode);
    if (!existing || row.year > existing.year) {
      latestAgri.set(row.countryCode, row);
    }
  }

  const latestNonAgri = new Map<string, TariffRow>();
  for (const row of nonAgriRows) {
    const existing = latestNonAgri.get(row.countryCode);
    if (!existing || row.year > existing.year) {
      latestNonAgri.set(row.countryCode, row);
    }
  }

  // Build barriers: show countries where agricultural tariffs significantly exceed non-agricultural
  const barriers: TradeBarrier[] = [];
  const allCodes = new Set([...latestAgri.keys(), ...latestNonAgri.keys()]);

  for (const code of allCodes) {
    const agri = latestAgri.get(code);
    const nonAgri = latestNonAgri.get(code);
    if (!agri && !nonAgri) continue;

    const agriRate = agri?.value ?? 0;
    const nonAgriRate = nonAgri?.value ?? 0;
    const gap = agriRate - nonAgriRate;
    const country = agri?.country ?? nonAgri?.country ?? code;
    const year = String(agri?.year ?? nonAgri?.year ?? '');

    barriers.push({
      id: `${code}-tariff-gap-${year}`,
      notifyingCountry: country,
      title: `Agricultural tariff: ${agriRate.toFixed(1)}% vs Non-agricultural: ${nonAgriRate.toFixed(1)}% (gap: ${gap > 0 ? '+' : ''}${gap.toFixed(1)}pp)`,
      measureType: gap > 10 ? 'High agricultural protection' : gap > 5 ? 'Moderate agricultural protection' : 'Low tariff gap',
      productDescription: 'Agricultural vs Non-agricultural products',
      objective: gap > 0 ? 'Agricultural sector protection' : 'Uniform tariff structure',
      status: gap > 10 ? 'high' : gap > 5 ? 'moderate' : 'low',
      dateDistributed: year,
      sourceUrl: 'https://stats.wto.org',
    });
  }

  // Sort by gap (highest agricultural protection first)
  barriers.sort((a, b) => {
    const gapA = parseFloat(a.title.match(/gap: ([+-]?\d+\.?\d*)/)?.[1] ?? '0');
    const gapB = parseFloat(b.title.match(/gap: ([+-]?\d+\.?\d*)/)?.[1] ?? '0');
    return gapB - gapA;
  });

  return { barriers: barriers.slice(0, limit), ok: true };
}

export async function getTradeBarriers(
  _ctx: ServerContext,
  req: GetTradeBarriersRequest,
): Promise<GetTradeBarriersResponse> {
  try {
    const countries = (req.countries ?? []).filter(isValidCountry);
    const limit = Math.max(1, Math.min(req.limit > 0 ? req.limit : 50, 100));

    const cacheKey = `trade:barriers:v1:tariff-gap:${limit}`;
    const result = await cachedFetchJson<GetTradeBarriersResponse>(
      cacheKey,
      REDIS_CACHE_TTL,
      async () => {
        const { barriers, ok } = await fetchBarriers(countries, limit);
        if (!ok || barriers.length === 0) return null;
        return { barriers, fetchedAt: new Date().toISOString(), upstreamUnavailable: false };
      },
    );

    return result ?? { barriers: [], fetchedAt: new Date().toISOString(), upstreamUnavailable: true };
  } catch {
    return {
      barriers: [],
      fetchedAt: new Date().toISOString(),
      upstreamUnavailable: true,
    };
  }
}
