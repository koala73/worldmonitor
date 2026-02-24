/**
 * Progress data service -- fetches World Bank indicator data for the
 * "Human Progress" panel showing long-term positive trends.
 *
 * Uses the existing getIndicatorData() RPC from the economic service
 * (World Bank API via sebuf proxy). All 4 indicators use country code
 * "1W" (World aggregate).
 *
 * papaparse is installed for potential OWID CSV fallback but is NOT
 * used in the primary flow -- World Bank covers all 4 indicators.
 */

import { getIndicatorData } from '@/services/economic';
import { createCircuitBreaker } from '@/utils';

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

// ---- Data Fetching ----

async function fetchProgressDataFresh(): Promise<ProgressDataSet[]> {
  const results = await Promise.all(
    PROGRESS_INDICATORS.map(async (indicator): Promise<ProgressDataSet> => {
      try {
        const response = await getIndicatorData(indicator.code, {
          countries: ['1W'],
          years: indicator.years,
        });

        const countryData = response.byCountry['WLD'];
        if (!countryData || countryData.values.length === 0) {
          return emptyDataSet(indicator);
        }

        const data: ProgressDataPoint[] = countryData.values
          .filter(v => v.value != null && Number.isFinite(v.value))
          .map(v => ({
            year: parseInt(v.year, 10),
            value: v.value,
          }))
          .filter(d => !isNaN(d.year))
          .sort((a, b) => a.year - b.year);

        if (data.length === 0) {
          return emptyDataSet(indicator);
        }

        const oldestValue = data[0]!.value;
        const latestValue = data[data.length - 1]!.value;

        const rawChangePercent = oldestValue !== 0
          ? ((latestValue - oldestValue) / Math.abs(oldestValue)) * 100
          : 0;
        const changePercent = indicator.invertTrend
          ? -rawChangePercent
          : rawChangePercent;

        return {
          indicator,
          data,
          latestValue,
          oldestValue,
          changePercent: Math.round(changePercent * 10) / 10,
        };
      } catch {
        return emptyDataSet(indicator);
      }
    }),
  );
  return results;
}

/**
 * Fetch progress data with persistent caching.
 * Returns instantly from IndexedDB cache on subsequent loads.
 */
export async function fetchProgressData(): Promise<ProgressDataSet[]> {
  return breaker.execute(
    () => fetchProgressDataFresh(),
    PROGRESS_INDICATORS.map(emptyDataSet),
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
