/**
 * RPC: getEnergyCapacity -- EIA Open Data API v2
 * Installed generation capacity data (solar, wind, coal) aggregated to US national totals.
 */

declare const process: { env: Record<string, string | undefined> };

import type {
  ServerContext,
  GetEnergyCapacityRequest,
  GetEnergyCapacityResponse,
  EnergyCapacitySeries,
  EnergyCapacityYear,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { CHROME_UA } from '../../../_shared/constants';
import { cachedFetchJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'economic:capacity:v1';
const REDIS_CACHE_TTL = 86400; // 24h — annual data barely changes
const DEFAULT_YEARS = 20;

interface CapacitySource {
  code: string;
  name: string;
}

const EIA_CAPACITY_SOURCES: CapacitySource[] = [
  { code: 'SUN', name: 'Solar' },
  { code: 'WND', name: 'Wind' },
  { code: 'COL', name: 'Coal' },
];

// Coal sub-type codes used when the aggregate COL code returns no data
const COAL_SUBTYPES = ['BIT', 'SUB', 'LIG', 'RC'];

interface EiaCapabilityRow {
  period?: string;
  stateid?: string;
  capability?: number;
  'capability-units'?: string;
}

/**
 * Fetch installed generation capacity from EIA state electricity profiles.
 * Returns a Map of year -> total US capacity in MW for the given source code.
 */
async function fetchCapacityForSource(
  sourceCode: string,
  apiKey: string,
  startYear: number,
): Promise<Map<number, number>> {
  const params = new URLSearchParams({
    api_key: apiKey,
    'data[]': 'capability',
    frequency: 'annual',
    'facets[energysourceid][]': sourceCode,
    'sort[0][column]': 'period',
    'sort[0][direction]': 'desc',
    length: '5000',
    start: String(startYear),
  });

  const url = `https://api.eia.gov/v2/electricity/state-electricity-profiles/capability/data/?${params}`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) return new Map();

  const data = await response.json() as {
    response?: { data?: EiaCapabilityRow[] };
  };

  const rows = data.response?.data;
  if (!rows || rows.length === 0) return new Map();

  // Aggregate state-level data to national totals by year
  const yearTotals = new Map<number, number>();
  for (const row of rows) {
    if (row.period == null || row.capability == null) continue;
    const year = parseInt(row.period, 10);
    if (isNaN(year)) continue;
    const mw = typeof row.capability === 'number' ? row.capability : parseFloat(String(row.capability));
    if (!Number.isFinite(mw)) continue;
    yearTotals.set(year, (yearTotals.get(year) ?? 0) + mw);
  }

  return yearTotals;
}

/**
 * Fetch coal capacity with fallback to specific sub-type codes.
 * EIA capability endpoint may use BIT/SUB/LIG/RC instead of aggregate COL.
 */
async function fetchCoalCapacity(
  apiKey: string,
  startYear: number,
): Promise<Map<number, number>> {
  // Try aggregate COL first
  const colResult = await fetchCapacityForSource('COL', apiKey, startYear);
  if (colResult.size > 0) return colResult;

  // Fallback: fetch individual coal sub-types and merge
  const subResults = await Promise.all(
    COAL_SUBTYPES.map(code => fetchCapacityForSource(code, apiKey, startYear)),
  );

  const merged = new Map<number, number>();
  for (const subMap of subResults) {
    for (const [year, mw] of subMap) {
      merged.set(year, (merged.get(year) ?? 0) + mw);
    }
  }

  return merged;
}

export async function getEnergyCapacity(
  _ctx: ServerContext,
  req: GetEnergyCapacityRequest,
): Promise<GetEnergyCapacityResponse> {
  try {
    const apiKey = process.env.EIA_API_KEY;
    if (!apiKey) return { series: [] };

    const years = req.years > 0 ? req.years : DEFAULT_YEARS;
    const currentYear = new Date().getFullYear();
    const startYear = currentYear - years;

    // Determine which sources to fetch
    const requestedSources = req.energySources.length > 0
      ? EIA_CAPACITY_SOURCES.filter(s => req.energySources.includes(s.code))
      : EIA_CAPACITY_SOURCES;

    if (requestedSources.length === 0) return { series: [] };

    // Build cache key from sorted source list + years
    const sourceKey = requestedSources.map(s => s.code).sort().join(',');
    const cacheKey = `${REDIS_CACHE_KEY}:${sourceKey}:${years}`;

    const result = await cachedFetchJson<GetEnergyCapacityResponse>(cacheKey, REDIS_CACHE_TTL, async () => {
      // Fetch capacity for each source
      const seriesResults: EnergyCapacitySeries[] = [];

      for (const source of requestedSources) {
        try {
          const yearTotals = source.code === 'COL'
            ? await fetchCoalCapacity(apiKey, startYear)
            : await fetchCapacityForSource(source.code, apiKey, startYear);

          // Convert to sorted array (oldest first)
          const dataPoints: EnergyCapacityYear[] = Array.from(yearTotals.entries())
            .sort(([a], [b]) => a - b)
            .map(([year, mw]) => ({ year, capacityMw: mw }));

          seriesResults.push({
            energySource: source.code,
            name: source.name,
            data: dataPoints,
          });
        } catch {
          // Individual source failure: include empty series
          seriesResults.push({
            energySource: source.code,
            name: source.name,
            data: [],
          });
        }
      }

      const hasData = seriesResults.some(s => s.data.length > 0);
      return hasData ? { series: seriesResults } : null;
    });

    return result || { series: [] };
  } catch {
    return { series: [] };
  }
}
