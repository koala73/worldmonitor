// FRED macro/rates bet templates (Phase 2 / #5525 — the independence slice:
// no market price exists to copy, so this is the structurally credible proof
// of derived calibration).
//
// Source feeds: `economic:fred:v1:<SERIES>:0` (exact, `:0`-suffixed — the
// resolution allowlist is an exact-match Set; seed-economy.mjs writes these
// keys with shape `{series:{observations:[{date,value},...]}}` per #5098).
// FRED marks missing values with '.' — observations must be filtered to
// finite numerics. Monthly observations are dated the FIRST of the reference
// month and publish ~2 weeks after the month ends, so deadlines carry the
// calendar-derived settlement graces in _forecast-resolution-eval.mjs (KTD4).

import { FRED_SERIES } from './_fred-series.mjs';

// Flat-week floor so a no-move series still yields a non-trivial threshold.
const MIN_MOVE_FRACTION = 0.005;

// Series list + derived keys live in _fred-series.mjs (shared with the eval's
// cadence-grace sets); re-exported here so template consumers keep one import.
export { FRED_SERIES, FRED_FEED_KEYS } from './_fred-series.mjs';

// Latest finite observations, ascending by date. Pure.
export function finiteObservations(feed) {
  const observations = feed?.series?.observations;
  if (!Array.isArray(observations)) return [];
  return observations
    .map((o) => ({ date: o?.date, value: Number(o?.value) }))
    .filter((o) => o.date && Number.isFinite(o.value));
}

function buildSeriesTemplate({ series, feedKey, subject, unit, horizonMs }) {
  return {
    id: `macro:${series}`,
    feedKey,
    domain: 'macro',

    extractMetric(feed) {
      const obs = finiteObservations(feed);
      const latest = obs[obs.length - 1];
      const previous = obs[obs.length - 2];
      // Rates/indices are strictly positive; a 0/negative read is a broken
      // feed (and a zero baseline would mint a guaranteed-YES bet).
      if (!latest || !(latest.value > 0)) return null;
      return {
        subject,
        metricName: series,
        value: latest.value,
        previous: previous && Number.isFinite(previous.value) ? previous.value : null,
        unit,
        asOf: latest.date,
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
      const wantUp = lastMove >= 0;
      const threshold = round(wantUp ? value + magnitude : value - magnitude);
      return {
        kind: 'hard',
        metricKey: `${feedKey}|value(metric==${series})`,
        operator: 'crosses',
        threshold,
        baselineValue: round(value),
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
      return series === 'FEDFUNDS' || series === 'UNRATE' ? 0.7 : 0.6;
    },
  };
}

export const MACRO_BET_TEMPLATES = FRED_SERIES.map(buildSeriesTemplate);

function buildQuestion(metric, wantUp, threshold, deadlineMs) {
  const dir = wantUp ? 'rise to at least' : 'fall to at most';
  return `Will ${metric.subject} ${dir} ${threshold} ${metric.unit} by ${isoDate(deadlineMs)}?`;
}

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function capitalize(text) {
  const s = String(text || '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function round(value) {
  if (!Number.isFinite(value)) return value;
  return Math.round(value * 1_000_000) / 1_000_000;
}
