/**
 * Humanity Counters Service
 *
 * Provides per-second rate calculations for positive global metrics,
 * derived from annual UN/WHO/World Bank/UNESCO totals.
 * No API calls needed -- all data is hardcoded from published sources.
 *
 * Methodology: Annual total / seconds-in-year (31,536,000) = per-second rate.
 * Counter value = per-second rate * seconds elapsed since midnight UTC.
 * This is absolute-time based (not delta accumulation) to avoid drift.
 */

import { getLocale } from './i18n';

export interface CounterMetric {
  id: string;
  label: string;
  annualTotal: number;
  source: string;
  perSecondRate: number;
  icon: string;
  formatPrecision: number;
}

const SECONDS_PER_YEAR = 31_536_000;

export const COUNTER_METRICS: CounterMetric[] = [
  {
    id: 'births',
    label: 'Babies Born Today',
    annualTotal: 135_600_000, // UN Population Division World Population Prospects 2024
    source: 'UN Population Division',
    perSecondRate: 135_600_000 / SECONDS_PER_YEAR, // ~4.3/sec
    icon: '\u{1F476}', // baby emoji
    formatPrecision: 0,
  },
  {
    id: 'trees',
    label: 'Trees Planted Today',
    annualTotal: 15_300_000_000, // Global Forest Watch / FAO reforestation estimates
    source: 'Global Forest Watch / FAO',
    perSecondRate: 15_300_000_000 / SECONDS_PER_YEAR, // ~485/sec
    icon: '\u{1F333}', // tree emoji
    formatPrecision: 0,
  },
  {
    id: 'vaccines',
    label: 'Vaccines Administered Today',
    annualTotal: 4_600_000_000, // WHO / UNICEF WUENIC Global Immunization Coverage 2024
    source: 'WHO / UNICEF',
    perSecondRate: 4_600_000_000 / SECONDS_PER_YEAR, // ~146/sec
    icon: '\u{1F489}', // syringe emoji
    formatPrecision: 0,
  },
  {
    id: 'graduates',
    label: 'Students Graduated Today',
    annualTotal: 70_000_000, // UNESCO Institute for Statistics tertiary + secondary completions
    source: 'UNESCO Institute for Statistics',
    perSecondRate: 70_000_000 / SECONDS_PER_YEAR, // ~2.2/sec
    icon: '\u{1F393}', // graduation cap emoji
    formatPrecision: 0,
  },
  {
    id: 'books',
    label: 'Books Published Today',
    annualTotal: 2_200_000, // UNESCO / Bowker ISBN agencies global estimate
    source: 'UNESCO / Bowker',
    perSecondRate: 2_200_000 / SECONDS_PER_YEAR, // ~0.07/sec
    icon: '\u{1F4DA}', // books emoji
    formatPrecision: 0,
  },
  {
    id: 'renewable',
    label: 'Renewable MW Installed Today',
    annualTotal: 510_000, // IRENA 2024 renewable capacity additions in MW
    source: 'IRENA / IEA',
    perSecondRate: 510_000 / SECONDS_PER_YEAR, // ~0.016/sec
    icon: '\u{26A1}', // lightning emoji
    formatPrecision: 2,
  },
];

/**
 * Calculate the current counter value based on absolute time.
 * Returns the accumulated value since midnight UTC today.
 *
 * Uses absolute-time calculation (seconds since midnight * rate)
 * rather than delta accumulation to avoid drift across tabs/throttling.
 */
export function getCounterValue(metric: CounterMetric): number {
  const now = new Date();
  const midnightUTC = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const elapsedSeconds = (now.getTime() - midnightUTC.getTime()) / 1000;
  return metric.perSecondRate * elapsedSeconds;
}

/**
 * Format a counter value for display with locale-aware thousands separators.
 * Uses Intl.NumberFormat for clean formatting like "372,891" or "8.23".
 */
let _counterFmtLocale = '';
let _counterFmtPrecision = -1;
let _counterFmt: Intl.NumberFormat | null = null;

export function formatCounterValue(value: number, precision: number): string {
  const locale = getLocale();
  if (locale !== _counterFmtLocale || precision !== _counterFmtPrecision || !_counterFmt) {
    _counterFmtLocale = locale;
    _counterFmtPrecision = precision;
    _counterFmt = new Intl.NumberFormat(locale, {
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
    });
  }
  return _counterFmt.format(value);
}
