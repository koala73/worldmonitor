import type { GetFredSeriesBatchResponse } from '@/generated/client/worldmonitor/economic/v1/service_client';

export interface FredSeries {
  id: string;
  name: string;
  value: number | null;
  previousValue: number | null;
  change: number | null;
  changePercent: number | null;
  date: string;
  unit: string;
  observations: Array<{ date: string; value: number }>;
}

interface FredConfig {
  id: string;
  name: string;
  unit: string;
  precision: number;
  scaleDivisor?: number;
}

export const FRED_SERIES: FredConfig[] = [
  { id: 'VIXCLS', name: 'VIX', unit: '', precision: 2 },
  { id: 'BAMLH0A0HYM2', name: 'HY Spread', unit: '%', precision: 2 },
  { id: 'ICSA', name: 'Jobless Claims', unit: '', precision: 0 },
  { id: 'MORTGAGE30US', name: '30Y Mortgage', unit: '%', precision: 2 },
  { id: 'FEDFUNDS', name: 'Fed Funds Rate', unit: '%', precision: 2 },
  { id: 'T10Y2Y', name: '10Y-2Y Spread', unit: '%', precision: 2 },
  // FRED publishes M2SL in billions and WALCL in millions of U.S. dollars.
  { id: 'M2SL', name: 'M2 Supply', unit: '$T', precision: 1, scaleDivisor: 1000 },
  { id: 'UNRATE', name: 'Unemployment', unit: '%', precision: 1 },
  { id: 'CPIAUCSL', name: 'CPI Index', unit: '', precision: 1 },
  { id: 'DGS10', name: '10Y Treasury', unit: '%', precision: 2 },
  { id: 'WALCL', name: 'Fed Total Assets', unit: '$T', precision: 3, scaleDivisor: 1_000_000 },
];

function toDisplayValue(value: number, config: FredConfig): number {
  return value / (config.scaleDivisor ?? 1);
}

function roundValue(value: number, precision: number): number {
  return Number(value.toFixed(precision));
}

export function toFredSeries(results: GetFredSeriesBatchResponse['results']): FredSeries[] {
  const out: FredSeries[] = [];
  for (const config of FRED_SERIES) {
    const series = results[config.id];
    if (!series) continue;
    const obs = series.observations;
    if (!obs || obs.length === 0) continue;

    if (obs.length >= 2) {
      const latest = obs[obs.length - 1]!;
      const previous = obs[obs.length - 2]!;
      const latestDisplayValue = toDisplayValue(latest.value, config);
      const previousDisplayValue = toDisplayValue(previous.value, config);
      const change = latestDisplayValue - previousDisplayValue;
      const changePercent = previous.value !== 0
        ? ((latest.value - previous.value) / previous.value) * 100
        : null;

      out.push({
        id: config.id, name: config.name,
        value: roundValue(latestDisplayValue, config.precision),
        previousValue: roundValue(previousDisplayValue, config.precision),
        change: roundValue(change, config.precision),
        changePercent: changePercent !== null ? Number(changePercent.toFixed(2)) : null,
        date: latest.date, unit: config.unit,
        observations: obs.slice(-30).map(o => ({ date: o.date, value: toDisplayValue(o.value, config) })),
      });
    } else {
      const latest = obs[0]!;
      const displayValue = toDisplayValue(latest.value, config);
      out.push({
        id: config.id, name: config.name,
        value: roundValue(displayValue, config.precision),
        previousValue: null, change: null, changePercent: null,
        date: latest.date, unit: config.unit,
        observations: obs.map(o => ({ date: o.date, value: toDisplayValue(o.value, config) })),
      });
    }
  }
  return out;
}
