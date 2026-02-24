/**
 * Renewable energy data service -- fetches World Bank renewable electricity
 * indicator (EG.ELC.RNEW.ZS) for global + regional breakdown.
 *
 * Uses the existing getIndicatorData() RPC from the economic service
 * (World Bank API via sebuf proxy).
 *
 * World Bank indicator EG.ELC.RNEW.ZS ("Renewable electricity output as %
 * of total electricity output") is sourced FROM IEA Energy Statistics
 * (SE4ALL Global Tracking Framework). This fulfills the ENERGY-03
 * requirement for IEA-sourced data without needing IEA's paid API.
 */

import { getIndicatorData, fetchEnergyCapacityRpc } from '@/services/economic';
import { createCircuitBreaker } from '@/utils';

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

// ---- Constants ----

// World Bank indicator for renewable electricity output as % of total
const INDICATOR_CODE = 'EG.ELC.RNEW.ZS';

// World Bank region codes for breakdown
const REGIONS: Array<{ code: string; name: string }> = [
  { code: '1W', name: 'World' },
  { code: 'EAS', name: 'East Asia & Pacific' },
  { code: 'ECS', name: 'Europe & Central Asia' },
  { code: 'LCN', name: 'Latin America & Caribbean' },
  { code: 'MEA', name: 'Middle East & N. Africa' },
  { code: 'NAC', name: 'North America' },
  { code: 'SAS', name: 'South Asia' },
  { code: 'SSF', name: 'Sub-Saharan Africa' },
];

// ---- Default / Empty ----

const EMPTY_DATA: RenewableEnergyData = {
  globalPercentage: 0,
  globalYear: 0,
  historicalData: [],
  regions: [],
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

// ---- Data Fetching ----

async function fetchRenewableEnergyDataFresh(): Promise<RenewableEnergyData> {
  try {
    const response = await getIndicatorData(INDICATOR_CODE, {
      countries: REGIONS.map(r => r.code),
      years: 35,
    });

    // --- Extract global (World = "WLD") data ---
    // World Bank API returns countryiso3code "WLD" for world aggregate (request code "1W").
    const worldData = response.byCountry['WLD'];
    if (!worldData || worldData.values.length === 0) {
      return EMPTY_DATA;
    }

    // Build historical time-series, filtering out null/NaN values
    const historicalData = worldData.values
      .filter(v => v.value != null && Number.isFinite(v.value))
      .map(v => ({
        year: parseInt(v.year, 10),
        value: v.value,
      }))
      .filter(d => !isNaN(d.year))
      .sort((a, b) => a.year - b.year);

    if (historicalData.length === 0) {
      return EMPTY_DATA;
    }

    const latest = historicalData[historicalData.length - 1]!;
    const globalPercentage = latest.value;
    const globalYear = latest.year;

    // --- Extract regional breakdown ---
    const regions: RegionRenewableData[] = [];

    for (const region of REGIONS) {
      // Skip "World" -- it's already in globalPercentage
      if (region.code === '1W' || region.code === 'WLD') continue;

      try {
        const countryData = response.byCountry[region.code];
        if (!countryData || countryData.values.length === 0) continue;

        // Find the most recent non-null value
        const validValues = countryData.values
          .filter(v => v.value != null && Number.isFinite(v.value))
          .map(v => ({
            year: parseInt(v.year, 10),
            value: v.value,
          }))
          .filter(d => !isNaN(d.year))
          .sort((a, b) => a.year - b.year);

        if (validValues.length === 0) continue;

        const latestRegion = validValues[validValues.length - 1]!;
        regions.push({
          code: region.code,
          name: region.name,
          percentage: latestRegion.value,
          year: latestRegion.year,
        });
      } catch {
        // Individual region failure: skip that region (don't crash the whole fetch)
        continue;
      }
    }

    // Sort regions by percentage descending (highest renewable % first)
    regions.sort((a, b) => b.percentage - a.percentage);

    return {
      globalPercentage,
      globalYear,
      historicalData,
      regions,
    };
  } catch {
    return EMPTY_DATA;
  }
}

/**
 * Fetch renewable energy data with persistent caching.
 * Returns instantly from IndexedDB cache on subsequent loads.
 */
export async function fetchRenewableEnergyData(): Promise<RenewableEnergyData> {
  return renewableBreaker.execute(() => fetchRenewableEnergyDataFresh(), EMPTY_DATA);
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
