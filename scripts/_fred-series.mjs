// Canonical FRED bet-series registry (#5525 — single source of truth).
//
// The macro bet templates (_bet-templates-macro.mjs) and the eval's
// calendar-grace key sets (_forecast-resolution-eval.mjs) both derive from
// this list, so adding or re-cadencing a series is a one-file change plus the
// _forecast-resolution.mjs allowlist entry (kept as deliberate string
// literals per that file's copy-not-import rule; the existing allowlist test
// in bet-templates-macro.test.mjs locks it against drift).
//
// Pure data, zero imports — safe to import from side-effect-sensitive
// modules and pure evaluators alike.

const DAY_MS = 24 * 60 * 60 * 1000;

export const FRED_SERIES = [
  {
    series: 'FEDFUNDS',
    feedKey: 'economic:fred:v1:FEDFUNDS:0',
    subject: 'the effective federal funds rate',
    unit: '%',
    cadence: 'monthly',
    horizonMs: 35 * DAY_MS,
  },
  {
    series: 'UNRATE',
    feedKey: 'economic:fred:v1:UNRATE:0',
    subject: 'the US unemployment rate',
    unit: '%',
    cadence: 'monthly',
    horizonMs: 35 * DAY_MS,
  },
  {
    series: 'CPIAUCSL',
    feedKey: 'economic:fred:v1:CPIAUCSL:0',
    subject: 'the US CPI index (CPIAUCSL)',
    unit: 'index points',
    cadence: 'monthly',
    horizonMs: 35 * DAY_MS,
  },
  {
    series: 'DGS10',
    feedKey: 'economic:fred:v1:DGS10:0',
    subject: 'the 10-year US Treasury yield',
    unit: '%',
    cadence: 'daily',
    horizonMs: 7 * DAY_MS,
  },
];

export const FRED_FEED_KEYS = FRED_SERIES.map((s) => s.feedKey);
export const FRED_MONTHLY_FEED_KEYS = new Set(FRED_SERIES.filter((s) => s.cadence === 'monthly').map((s) => s.feedKey));
export const FRED_DAILY_FEED_KEYS = new Set(FRED_SERIES.filter((s) => s.cadence === 'daily').map((s) => s.feedKey));
