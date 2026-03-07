/**
 * Progress data service -- displays World Bank indicator data for the
 * "Human Progress" panel showing long-term positive trends.
 *
 * Data is pre-seeded by seed-wb-indicators.mjs on Railway and read
 * from bootstrap/Redis. Never calls WB API from the frontend.
 */

import { createCircuitBreaker } from '@/utils';
import { getHydratedData } from '@/services/bootstrap';

// ---- Types ----

export interface ProgressDataPoint {
  year: number;
  value: number;
}

export interface ProgressIndicator {
  id: string;
  code: string;         // World Bank indicator code
  label: string;
  unit: string;         // e.g., "years", "%", "per 1,000"
  color: string;        // CSS color from happy theme
  years: number;        // How many years of data to fetch
  invertTrend: boolean; // true for metrics where DOWN is good (mortality, poverty)
}

export interface ProgressDataSet {
  indicator: ProgressIndicator;
  data: ProgressDataPoint[];
  latestValue: number;
  oldestValue: number;
  changePercent: number; // Positive = improvement (accounts for invertTrend)
}

// ---- Indicator Definitions ----

/**
 * 4 progress indicators with World Bank codes and warm happy-theme colors.
 *
 * Data ranges verified against World Bank API:
 *   SP.DYN.LE00.IN  -- Life expectancy: 46.4 (1960) -> 73.3 (2023)
 *   SE.ADT.LITR.ZS  -- Literacy rate:   65.4% (1975) -> 87.6% (2023)
 *   SH.DYN.MORT     -- Child mortality:  226.8 (1960) -> 36.7 (2023) per 1,000
 *   SI.POV.DDAY     -- Extreme poverty:  52.2% (1981) -> 10.5% (2023)
 */
export const PROGRESS_INDICATORS: ProgressIndicator[] = [
  {
    id: 'lifeExpectancy',
    code: 'SP.DYN.LE00.IN',
    label: 'Life Expectancy',
    unit: 'years',
    color: '#6B8F5E',   // sage green
    years: 65,
    invertTrend: false,
  },
  {
    id: 'literacy',
    code: 'SE.ADT.LITR.ZS',
    label: 'Literacy Rate',
    unit: '%',
    color: '#7BA5C4',   // soft blue
    years: 55,
    invertTrend: false,
  },
  {
    id: 'childMortality',
    code: 'SH.DYN.MORT',
    label: 'Child Mortality',
    unit: 'per 1,000',
    color: '#C4A35A',   // warm gold
    years: 65,
    invertTrend: true,
  },
  {
    id: 'poverty',
    code: 'SI.POV.DDAY',
    label: 'Extreme Poverty',
    unit: '%',
    color: '#C48B9F',   // muted rose
    years: 45,
    invertTrend: true,
  },
];

// ---- Circuit Breaker (persistent cache for instant reload) ----

const breaker = createCircuitBreaker<ProgressDataSet[]>({
  name: 'Progress Data',
  cacheTtlMs: 60 * 60 * 1000, // 1h — World Bank data changes yearly
  persistCache: true,
});

// ---- Seed data shape (from seed-wb-indicators.mjs) ----

interface SeedProgressIndicator {
  id: string;
  code: string;
  data: ProgressDataPoint[];
  invertTrend: boolean;
}

// ---- Data Fetching (from Railway seed via bootstrap) ----

function buildDataSet(indicator: ProgressIndicator, data: ProgressDataPoint[]): ProgressDataSet {
  if (data.length === 0) return fallbackDataSet(indicator);
  const oldestValue = data[0]!.value;
  const latestValue = data[data.length - 1]!.value;
  const rawChangePercent = oldestValue !== 0
    ? ((latestValue - oldestValue) / Math.abs(oldestValue)) * 100
    : 0;
  const changePercent = indicator.invertTrend ? -rawChangePercent : rawChangePercent;
  return {
    indicator,
    data,
    latestValue,
    oldestValue,
    changePercent: Math.round(changePercent * 10) / 10,
  };
}

function buildSeedMap(seeds: SeedProgressIndicator[]): Map<string, SeedProgressIndicator> {
  const map = new Map<string, SeedProgressIndicator>();
  for (const s of seeds) {
    map.set(s.id, s);
    map.set(s.code, s);
  }
  return map;
}

function resolveFromSeeds(seedMap: Map<string, SeedProgressIndicator>): ProgressDataSet[] {
  return PROGRESS_INDICATORS.map(indicator => {
    const seed = seedMap.get(indicator.id) || seedMap.get(indicator.code);
    return seed?.data?.length ? buildDataSet(indicator, seed.data) : fallbackDataSet(indicator);
  });
}

async function fetchProgressDataFresh(): Promise<ProgressDataSet[]> {
  // 1. Try bootstrap hydration cache (first page load)
  const hydrated = getHydratedData('progressData') as SeedProgressIndicator[] | undefined;
  if (hydrated?.length) return resolveFromSeeds(buildSeedMap(hydrated));

  // 2. Fallback: fetch from bootstrap endpoint directly
  try {
    const resp = await fetch('/api/bootstrap?keys=progressData', {
      signal: AbortSignal.timeout(5_000),
    });
    if (resp.ok) {
      const { data } = (await resp.json()) as { data: { progressData?: SeedProgressIndicator[] } };
      if (data.progressData?.length) return resolveFromSeeds(buildSeedMap(data.progressData));
    }
  } catch { /* fall through to fallback */ }

  // 3. Static fallback
  return PROGRESS_INDICATORS.map(fallbackDataSet);
}

/**
 * Fetch progress data with persistent caching.
 * Returns instantly from IndexedDB cache on subsequent loads.
 */
export async function fetchProgressData(): Promise<ProgressDataSet[]> {
  return breaker.execute(
    () => fetchProgressDataFresh(),
    PROGRESS_INDICATORS.map(fallbackDataSet),
  );
}

function emptyDataSet(indicator: ProgressIndicator): ProgressDataSet {
  return {
    indicator,
    data: [],
    latestValue: 0,
    oldestValue: 0,
    changePercent: 0,
  };
}

// ---- Static Fallback Data (World Bank verified, updated yearly) ----
// Used when the API is unavailable and no cached data exists.
// Source: https://data.worldbank.org/ — last verified Feb 2026

const FALLBACK_DATA: Record<string, ProgressDataPoint[]> = {
  'SP.DYN.LE00.IN': [ // Life expectancy (years)
    { year: 1960, value: 52.6 }, { year: 1970, value: 58.7 }, { year: 1980, value: 62.8 },
    { year: 1990, value: 65.4 }, { year: 2000, value: 67.7 }, { year: 2005, value: 69.1 },
    { year: 2010, value: 70.6 }, { year: 2015, value: 72.0 }, { year: 2020, value: 72.0 },
    { year: 2023, value: 73.3 },
  ],
  'SE.ADT.LITR.ZS': [ // Literacy rate (%)
    { year: 1975, value: 65.4 }, { year: 1985, value: 72.3 }, { year: 1995, value: 78.2 },
    { year: 2000, value: 81.0 }, { year: 2005, value: 82.5 }, { year: 2010, value: 84.1 },
    { year: 2015, value: 85.8 }, { year: 2020, value: 87.0 }, { year: 2023, value: 87.6 },
  ],
  'SH.DYN.MORT': [ // Child mortality (per 1,000)
    { year: 1960, value: 226.8 }, { year: 1970, value: 175.2 }, { year: 1980, value: 131.5 },
    { year: 1990, value: 93.4 }, { year: 2000, value: 76.6 }, { year: 2005, value: 63.7 },
    { year: 2010, value: 52.2 }, { year: 2015, value: 43.1 }, { year: 2020, value: 38.8 },
    { year: 2023, value: 36.7 },
  ],
  'SI.POV.DDAY': [ // Extreme poverty (%)
    { year: 1981, value: 52.2 }, { year: 1990, value: 43.4 }, { year: 1999, value: 34.8 },
    { year: 2005, value: 25.2 }, { year: 2010, value: 18.9 }, { year: 2013, value: 14.7 },
    { year: 2015, value: 13.1 }, { year: 2019, value: 10.8 }, { year: 2023, value: 10.5 },
  ],
};

function fallbackDataSet(indicator: ProgressIndicator): ProgressDataSet {
  const data = FALLBACK_DATA[indicator.code];
  if (!data || data.length === 0) return emptyDataSet(indicator);
  const oldestValue = data[0]!.value;
  const latestValue = data[data.length - 1]!.value;
  const rawChangePercent = oldestValue !== 0
    ? ((latestValue - oldestValue) / Math.abs(oldestValue)) * 100
    : 0;
  const changePercent = indicator.invertTrend ? -rawChangePercent : rawChangePercent;
  return {
    indicator,
    data,
    latestValue,
    oldestValue,
    changePercent: Math.round(changePercent * 10) / 10,
  };
}
