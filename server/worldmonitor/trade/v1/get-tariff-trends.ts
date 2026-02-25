/**
 * RPC: getTariffTrends -- WTO applied tariff trend data
 * Fetches MFN simple average applied tariff rates over time.
 *
 * NOTE: Tariff indicators (TP_A_*) do NOT have a partner dimension.
 * The `partnerCountry` request field is accepted but not sent to the API.
 */

declare const process: { env: Record<string, string | undefined> };

import type {
  ServerContext,
  GetTariffTrendsRequest,
  GetTariffTrendsResponse,
  TariffDataPoint,
} from '../../../../src/generated/server/worldmonitor/trade/v1/service_server';

import { getCachedJson, setCachedJson } from '../../../_shared/redis';
import { wtoFetch, WTO_MEMBER_CODES, TP_A_0010 } from './_shared';

const REDIS_CACHE_TTL = 21600; // 6h

/**
 * Validate a country/sector code string — alphanumeric, max 10 chars.
 */
function isValidCode(c: string): boolean {
  return /^[a-zA-Z0-9]{1,10}$/.test(c);
}

/**
 * Transform a raw WTO data row into a TariffDataPoint.
 */
function toDataPoint(row: any, reporter: string, partner: string): TariffDataPoint | null {
  if (!row) return null;
  const year = parseInt(row.Year ?? row.year ?? row.Period ?? '', 10);
  const tariffRate = parseFloat(row.Value ?? row.value ?? '');
  if (isNaN(year) || isNaN(tariffRate)) return null;

  return {
    reportingCountry:
      WTO_MEMBER_CODES[reporter] ?? String(row.ReportingEconomy ?? row.reportingEconomy ?? reporter),
    partnerCountry:
      WTO_MEMBER_CODES[partner] ?? String(row.PartnerEconomy ?? row.partnerEconomy ?? (partner || 'World')),
    productSector: String(row.ProductOrSector ?? row.productOrSector ?? 'All products'),
    year,
    tariffRate: Math.round(tariffRate * 100) / 100,
    boundRate: parseFloat(row.BoundRate ?? row.boundRate ?? '0') || 0,
    indicatorCode: String(row.IndicatorCode ?? row.indicatorCode ?? TP_A_0010),
  };
}

async function fetchTariffTrends(
  reporter: string,
  partner: string,
  _productSector: string,
  years: number,
): Promise<{ datapoints: TariffDataPoint[]; ok: boolean }> {
  const currentYear = new Date().getFullYear();
  const startYear = currentYear - years;

  // Tariff indicators do NOT support the partner (p) parameter.
  const params: Record<string, string> = {
    i: TP_A_0010,
    r: reporter,
    ps: `${startYear}-${currentYear}`,
    fmt: 'json',
    mode: 'full',
    max: '500',
  };

  const data = await wtoFetch('/data', params);
  if (!data) return { datapoints: [], ok: false };

  const dataset: any[] = Array.isArray(data) ? data : data?.Dataset ?? data?.dataset ?? [];
  const datapoints = dataset
    .map((row) => toDataPoint(row, reporter, partner || '000'))
    .filter((d): d is TariffDataPoint => d !== null)
    .sort((a, b) => a.year - b.year);

  return { datapoints, ok: true };
}

export async function getTariffTrends(
  _ctx: ServerContext,
  req: GetTariffTrendsRequest,
): Promise<GetTariffTrendsResponse> {
  try {
    // Input validation
    const reporter = isValidCode(req.reportingCountry) ? req.reportingCountry : '840';
    const partner = isValidCode(req.partnerCountry) ? req.partnerCountry : '000';
    const productSector = isValidCode(req.productSector) ? req.productSector : '';
    const years = Math.max(1, Math.min(req.years > 0 ? req.years : 10, 30));

    const cacheKey = `trade:tariffs:v1:${reporter}:${productSector || 'all'}:${years}`;
    const cached = (await getCachedJson(cacheKey)) as GetTariffTrendsResponse | null;
    if (cached?.datapoints?.length) return cached;

    const { datapoints, ok } = await fetchTariffTrends(reporter, partner, productSector, years);

    if (!ok) {
      return {
        datapoints: cached?.datapoints ?? [],
        fetchedAt: new Date().toISOString(),
        upstreamUnavailable: true,
      };
    }

    const result: GetTariffTrendsResponse = {
      datapoints,
      fetchedAt: new Date().toISOString(),
      upstreamUnavailable: false,
    };

    if (datapoints.length > 0) {
      setCachedJson(cacheKey, result, REDIS_CACHE_TTL).catch(() => {});
    }

    return result;
  } catch {
    return {
      datapoints: [],
      fetchedAt: new Date().toISOString(),
      upstreamUnavailable: true,
    };
  }
}
