// Energy bet templates (Phase 1 pilot / #5233 re-engine).
//
// Source feed: energy:eia-petroleum:v1, verified live shape
//   { wti, brent, production, inventory } each { current, previous, date, unit }
// Each metric becomes a directional "will the latest move continue?" bet with a
// concrete, resolvable threshold and a hard #4976 spec that reads back through
// the resolver as `energy:eia-petroleum:v1|value(metric==<name>)`.
//
// Pure: templates are declarative; generateBets (in _bet-templates.mjs) drives
// them with an injected feed snapshot + nowMs.

export const EIA_PETROLEUM_FEED = 'energy:eia-petroleum:v1';
const DAY_MS = 24 * 60 * 60 * 1000;
// Keep a weekly question horizon. Resolution has a separate, feed-aware grace
// because the report's observation date can trail its publication date.
const EIA_HORIZON_MS = 7 * DAY_MS;
// Floor the threshold move so a flat week (current==previous) still yields a
// non-trivial bet instead of "value >= current" (~coin-flip, uninformative).
const MIN_MOVE_FRACTION = 0.005;

// EIA petroleum figures are reported in thousand barrels (stocks) / thousand
// barrels per day (production); the feed leaves `unit` empty, so these
// fallbacks must match the raw magnitude (e.g. 411357 = 411M bbl = 411357 kbbl)
// — a fabricated "Mbbl" here would make the question absurd.
const METRICS = [
  { name: 'inventory', subject: 'US commercial crude oil inventories', fallbackUnit: 'kbbl' },
  { name: 'production', subject: 'US crude oil production', fallbackUnit: 'kbbl/d' },
  { name: 'wti', subject: 'the WTI crude oil price', fallbackUnit: 'USD/bbl' },
  { name: 'brent', subject: 'the Brent crude oil price', fallbackUnit: 'USD/bbl' },
];

function buildMetricTemplate({ name, subject, fallbackUnit }) {
  return {
    id: `energy:eia-${name}`,
    feedKey: EIA_PETROLEUM_FEED,
    domain: 'energy',

    extractMetric(feed) {
      const m = feed?.[name];
      const current = Number(m?.current);
      // EIA stocks/production/prices are strictly positive; a 0/negative
      // reading is a broken feed. Skip it — otherwise a zero baseline yields
      // magnitude 0 → threshold==baseline → `value >= 0` → a guaranteed-YES bet.
      if (!m || !Number.isFinite(current) || current <= 0) return null;
      const previous = Number(m?.previous);
      return {
        subject,
        metricName: name,
        value: current,
        previous: Number.isFinite(previous) ? previous : null,
        unit: m.unit || fallbackUnit,
        asOf: m.date || null,
      };
    },

    horizonPolicy({ nowMs }) {
      return nowMs + EIA_HORIZON_MS;
    },

    buildResolutionSpec({ metric, deadlineMs }) {
      const { value, previous } = metric;
      const lastMove = Number.isFinite(previous) ? value - previous : 0;
      const floor = Math.abs(value) * MIN_MOVE_FRACTION;
      const magnitude = Math.max(Math.abs(lastMove), floor);
      // Defense-in-depth against a degenerate (threshold==baseline) bet: a
      // non-positive magnitude has no resolvable YES criterion, so emit no bet.
      if (!(magnitude > 0)) return null;
      // Direction = continuation of the latest observed move (default up on a flat week).
      const wantUp = lastMove >= 0;
      const threshold = round(wantUp ? value + magnitude : value - magnitude);
      // operator 'crosses' is the resolver's direction-aware comparator: with
      // baselineValue<=threshold it resolves YES on value>=threshold, and with
      // baselineValue>threshold on value<=threshold — so the up/down direction
      // is carried by threshold-vs-baseline, matching the existing spec vocab.
      return {
        kind: 'hard',
        metricKey: `${EIA_PETROLEUM_FEED}|value(metric==${name})`,
        operator: 'crosses',
        threshold,
        baselineValue: round(value),
        // Read the metric AS OF the deadline (the resolver samples at/after it,
        // or falls back to the feed snapshot when resolving post-deadline).
        window: 'at-deadline',
        deadline: deadlineMs,
        sourceFeed: EIA_PETROLEUM_FEED,
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
      // Prices are higher-interest than raw stock levels; nudge accordingly.
      return name === 'wti' || name === 'brent' ? 0.75 : 0.6;
    },
  };
}

function buildQuestion(metric, wantUp, threshold, deadlineMs) {
  const dir = wantUp ? 'rise to at least' : 'fall to at most';
  return `Will ${metric.subject} ${dir} ${threshold} ${metric.unit} by ${isoDate(deadlineMs)}?`;
}

export const ENERGY_BET_TEMPLATES = METRICS.map(buildMetricTemplate);

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
