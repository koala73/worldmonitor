/**
 * Renewable energy data service -- displays World Bank renewable electricity
 * indicator (EG.ELC.RNEW.ZS) for global + regional breakdown.
 *
 * Data is pre-seeded by seed-wb-indicators.mjs on Railway and read
 * from bootstrap/Redis. Never calls WB API from the frontend.
 *
 * EIA installed capacity (solar, wind, coal) still uses the RPC
 * endpoint since it's a different data source (not World Bank).
 */

import { fetchEnergyCapacityRpc } from '@/services/economic';
import { createCircuitBreaker } from '@/utils';
import { getHydratedData } from '@/services/bootstrap';
import { toApiUrl } from '@/services/runtime';

// ---- Types ----

export interface RegionRenewableData {
  code: string;       // World Bank region code (e.g., "1W", "EAS")
  name: string;       // Human-readable name (e.g., "World", "East Asia & Pacific")
  percentage: number;  // Latest renewable electricity % value
  year: number;       // Year of latest data point
}

export interface RenewableEnergyData {
  globalPercentage: number;          // Latest global renewable electricity %
  globalYear: number;                // Year of latest global data
  historicalData: Array<{ year: number; value: number }>;  // Global time-series
  regions: RegionRenewableData[];    // Regional breakdown
}

// ---- Default / Empty ----

// Static fallback when seed data is unavailable and no cache exists.
// Source: https://data.worldbank.org/indicator/EG.ELC.RNEW.ZS — last verified Feb 2026
const FALLBACK_DATA: RenewableEnergyData = {
  globalPercentage: 29.6,
  globalYear: 2022,
  historicalData: [
    { year: 1990, value: 19.8 }, { year: 1995, value: 19.2 }, { year: 2000, value: 18.6 },
    { year: 2005, value: 18.0 }, { year: 2010, value: 20.3 }, { year: 2012, value: 21.6 },
    { year: 2014, value: 22.6 }, { year: 2016, value: 24.0 }, { year: 2018, value: 25.7 },
    { year: 2020, value: 28.2 }, { year: 2021, value: 28.7 }, { year: 2022, value: 29.6 },
  ],
  regions: [
    { code: 'LCN', name: 'Latin America & Caribbean', percentage: 58.1, year: 2022 },
    { code: 'SSF', name: 'Sub-Saharan Africa', percentage: 47.2, year: 2022 },
    { code: 'ECS', name: 'Europe & Central Asia', percentage: 35.8, year: 2022 },
    { code: 'SAS', name: 'South Asia', percentage: 22.1, year: 2022 },
    { code: 'EAS', name: 'East Asia & Pacific', percentage: 21.9, year: 2022 },
    { code: 'NAC', name: 'North America', percentage: 21.5, year: 2022 },
    { code: 'MEA', name: 'Middle East & N. Africa', percentage: 5.3, year: 2022 },
  ],
};

// ---- Circuit Breaker (persistent cache for instant reload) ----

const renewableBreaker = createCircuitBreaker<RenewableEnergyData>({
  name: 'Renewable Energy',
  cacheTtlMs: 60 * 60 * 1000, // 1h — World Bank data changes yearly
  persistCache: true,
});

const capacityBreaker = createCircuitBreaker<CapacitySeries[]>({
  name: 'Energy Capacity',
  cacheTtlMs: 60 * 60 * 1000,
  persistCache: true,
});

// ---- Data Fetching (from Railway seed via bootstrap) ----

async function fetchRenewableEnergyDataFresh(): Promise<RenewableEnergyData> {
  // 1. Try bootstrap hydration cache (first page load)
  const hydrated = getHydratedData('renewableEnergy') as RenewableEnergyData | undefined;
  if (hydrated?.historicalData?.length) return hydrated;

  // 2. Fallback: fetch from bootstrap endpoint directly
  try {
    const resp = await fetch(toApiUrl('/api/bootstrap?keys=renewableEnergy'), {
      signal: AbortSignal.timeout(5_000),
    });
    if (resp.ok) {
      const { data } = (await resp.json()) as { data: { renewableEnergy?: RenewableEnergyData } };
      if (data.renewableEnergy?.historicalData?.length) return data.renewableEnergy;
    }
  } catch { /* fall through */ }

  // 3. Static fallback
  return FALLBACK_DATA;
}

/**
 * Fetch renewable energy data with persistent caching.
 * Returns instantly from IndexedDB cache on subsequent loads.
 */
export async function fetchRenewableEnergyData(): Promise<RenewableEnergyData> {
  return renewableBreaker.execute(() => fetchRenewableEnergyDataFresh(), FALLBACK_DATA);
}

// ========================================================================
// EIA Installed Capacity (solar, wind, coal)
// ========================================================================

export interface CapacityDataPoint {
  year: number;
  capacityMw: number;
}

export interface CapacitySeries {
  source: string;   // 'SUN', 'WND', 'COL'
  name: string;     // 'Solar', 'Wind', 'Coal'
  data: CapacityDataPoint[];
}

/**
 * Fetch installed generation capacity for solar, wind, and coal from EIA.
 * Returns typed CapacitySeries[] ready for panel rendering.
 * Gracefully degrades: on failure returns empty array.
 */
export async function fetchEnergyCapacity(): Promise<CapacitySeries[]> {
  return capacityBreaker.execute(async () => {
    const resp = await fetchEnergyCapacityRpc(['SUN', 'WND', 'COL'], 25);
    return resp.series.map(s => ({
      source: s.energySource,
      name: s.name,
      data: s.data.map(d => ({ year: d.year, capacityMw: d.capacityMw })),
    }));
  }, []);
}
