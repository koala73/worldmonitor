// FRED macro/rates bet templates (Phase 2 / #5238 U12).
//
// Source feeds: economic:fred:v1:{SERIES}:0 (exact-match allowlist per KTD4)
//   FEDFUNDS  — federal funds effective rate (monthly)
//   UNRATE    — US unemployment rate (monthly)
//   CPIAUCSL  — CPI all-urban (monthly)
//   DGS10     — 10-year treasury yield (daily)
//
// The FRED-independence slice is the non-market proof that the ensemble is a
// derived forecast, not market-price parroting (KTD3): there is no prediction-
// market price for DGS10 or UNRATE to copy.
//
// Data shape (KTD4 / #5098 P1 fix):
//   seed-economy.mjs writes { series: { seriesId, title, units, frequency,
//   observations: [{ date, value }] } } at key economic:fred:v1:{SERIES}:0.
//   The {series:{observations}} unwrap was previously silently killing all 10
//   FRED series (#5098). This module's extractFredObservations() is the fix.
//
// Calendar-derived grace (KTD4):
//   Monthly FRED observations are dated the 1st of the reference month and
//   published ~2 weeks after month end → ~45–70d lag from a mid-month deadline.
//   Grace = 75d for monthly series; 14d for DGS10 (daily).
//   The resolver's valueSettlementMaxLagMs() must be extended to honour this;
//   see _forecast-resolution-eval.mjs FRED_VALUE_SETTLEMENT_MAX_LAG_MS.
//
// Pure: templates are declarative; generateBets() drives them with injected feed + nowMs.

const DAY_MS = 24 * 60 * 60 * 1000;
const FRED_KEY_PREFIX = 'economic:fred:v1';

// Horizon: 45d for monthly (so the deadline lands after the latest obs publishes);
// 14d for daily DGS10 (short enough to stay current).
const MONTHLY_HORIZON_MS = 45 * DAY_MS;
const DAILY_HORIZON_MS = 14 * DAY_MS;

// Minimum move fraction to produce a non-trivial bet.
// 0.25% move: small enough for rate series (e.g. 5.33 → 5.34) to still generate bets.
const MIN_MOVE_FRACTION = 0.0025;

const FRED_SERIES = [
  {
    seriesId: 'FEDFUNDS',
    subject: 'the US federal funds effective rate',
    unit: '%',
    frequency: 'monthly',
    horizonMs: MONTHLY_HORIZON_MS,
  },
  {
    seriesId: 'UNRATE',
    subject: 'the US unemployment rate',
    unit: '%',
    frequency: 'monthly',
    horizonMs: MONTHLY_HORIZON_MS,
  },
  {
    seriesId: 'CPIAUCSL',
    subject: 'the US CPI (all urban consumers)',
    unit: 'index',
    frequency: 'monthly',
    horizonMs: MONTHLY_HORIZON_MS,
  },
  {
    seriesId: 'DGS10',
    subject: 'the 10-year US Treasury yield',
    unit: '%',
    frequency: 'daily',
    horizonMs: DAILY_HORIZON_MS,
  },
];

// ── Core: {series:{observations}} unwrap (KTD4 / #5098 P1 fix) ────────────
//
// seed-economy.mjs stores FRED series as { series: { seriesId, observations } }
// wrapped in the runSeed envelope. The `data` field holds the series object.
// This function extracts the observation array regardless of envelope depth.
export function extractFredObservations(feed) {
  // Unwrap runSeed envelope if present.
  const d = feed?.data ?? feed;
  // The stored shape is { series: { ..., observations: [...] } }.
  const obs = d?.series?.observations ?? d?.observations;
  return Array.isArray(obs) ? obs : null;
}

/**
 * Get the latest valid observation from the FRED series array.
 * FRED occasionally appends null/`.` sentinels at the end of the series —
 * scan backwards to find a real value.
 *
 * @param {Array} observations  [{date, value}] sorted oldest-first.
 * @returns {{value: number, date: string} | null}
 */
function latestObservation(observations) {
  if (!Array.isArray(observations)) return null;
  for (let i = observations.length - 1; i >= 0; i--) {
    const ob = observations[i];
    const v = Number(ob?.value);
    if (Number.isFinite(v) && typeof ob.date === 'string') return { value: v, date: ob.date };
  }
  return null;
}

/**
 * Get the observation immediately before `latest` (penultimate) for delta calculation.
 * @param {Array} observations
 * @param {string} latestDate The date to look before.
 * @returns {{value: number} | null}
 */
function previousObservation(observations, latestDate) {
  if (!Array.isArray(observations)) return null;
  let found = false;
  for (let i = observations.length - 1; i >= 0; i--) {
    const ob = observations[i];
    if (!found) {
      if (ob?.date === latestDate) found = true;
      continue;
    }
    const v = Number(ob?.value);
    if (Number.isFinite(v)) return { value: v, date: ob.date };
  }
  return null;
}

function buildFredTemplate({ seriesId, subject, unit, horizonMs }) {
  const feedKey = `${FRED_KEY_PREFIX}:${seriesId}:0`;

  return {
    id: `macro:fred-${seriesId.toLowerCase()}`,
    feedKey,
    domain: 'macro',

    extractMetric(feed) {
      const observations = extractFredObservations(feed);
      if (!observations) return null;

      const latest = latestObservation(observations);
      if (!latest) return null;

      const prev = previousObservation(observations, latest.date);
      return {
        seriesId,
        subject,
        unit,
        value: latest.value,
        date: latest.date,
        previous: prev ? prev.value : null,
        // Pass all observations for base-rate calculation (up to 24 months / 2yr).
        observations: observations.slice(-24).map((o) => Number(o.value)).filter(Number.isFinite),
      };
    },

    horizonPolicy({ nowMs }) {
      return nowMs + horizonMs;
    },

    buildResolutionSpec({ metric, deadlineMs }) {
      const { value, previous } = metric;
      const lastMove = Number.isFinite(previous) ? value - previous : 0;
      const floor = Math.abs(value) * MIN_MOVE_FRACTION;
      const magnitude = Math.max(Math.abs(lastMove), floor);
      if (!(magnitude > 0)) return null;

      // Direction: continuation of the latest observed move; default up on flat.
      const wantUp = lastMove >= 0;
      const threshold = round4(wantUp ? value + magnitude : value - magnitude);

      return {
        kind: 'hard',
        // metricKey uses the exact Redis key (KTD4: exact-match allowlist).
        metricKey: `${feedKey}|value(series==${seriesId})`,
        operator: 'crosses',
        threshold,
        baselineValue: round4(value),
        // at-deadline: resolver reads the feed's latest value after the deadline.
        // Grace is handled by FRED_VALUE_SETTLEMENT_MAX_LAG_MS in _forecast-resolution-eval.mjs.
        window: 'at-deadline',
        deadline: deadlineMs,
        sourceFeed: feedKey,
        question: buildQuestion(metric, wantUp, threshold, deadlineMs),
      };
    },

    buildQuestion({ spec }) {
      return spec.question;
    },

    buildTitle({ metric, spec }) {
      const dir = spec.threshold >= spec.baselineValue ? 'rise' : 'fall';
      return `${capitalize(metric.subject)}: ${dir} to ${spec.threshold} ${metric.unit}?`;
    },

    userValueScore() {
      // Rate/yield series are higher interest than index levels.
      return seriesId === 'FEDFUNDS' || seriesId === 'DGS10' ? 0.75 : 0.65;
    },
  };
}

function buildQuestion(metric, wantUp, threshold, deadlineMs) {
  const dir = wantUp ? 'rise to at least' : 'fall to at most';
  return `Will ${metric.subject} ${dir} ${threshold} ${metric.unit} by ${isoDate(deadlineMs)}?`;
}

export const MACRO_BET_TEMPLATES = FRED_SERIES.map(buildFredTemplate);

// Feed keys consumed by this module. The seeder adds these to BET_FEEDS.
export const MACRO_FEEDS = FRED_SERIES.map(({ seriesId }) => `${FRED_KEY_PREFIX}:${seriesId}:0`);

// ── Helpers ───────────────────────────────────────────────────────────────

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function capitalize(text) {
  const s = String(text || '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function round4(value) {
  if (!Number.isFinite(value)) return value;
  return Math.round(value * 10_000) / 10_000;
}
