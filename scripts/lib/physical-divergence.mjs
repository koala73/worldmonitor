import { physicalDivergenceStaleReason } from '../shared/physical-divergence-staleness.js';

export const METHODOLOGY_VERSION = 'physical-divergence-v1';
export const HISTORY_LIMIT = 750;
export const TRAILING_WINDOW_POINTS = 250;
export const MIN_HISTORY_POINTS = 60;
// Two times the daily physical-print cadence prevents a repeated transition on the next seed run.
export const TRANSITION_COOLDOWN_MS = 48 * 60 * 60 * 1000;

export const METAL_METHODOLOGY = Object.freeze({
  gold: Object.freeze({
    weight: 0.7,
    absoluteFloors: Object.freeze({ elevated: 1, stressed: 3, extreme: 5 }),
  }),
  silver: Object.freeze({
    weight: 0.3,
    absoluteFloors: Object.freeze({ elevated: 5, stressed: 10, extreme: 20 }),
  }),
});

const REGIME_RANK = Object.freeze({ normal: 0, elevated: 1, stressed: 2, extreme: 3 });
const REGIME_INDEX_FLOOR = Object.freeze({ normal: 0, elevated: 50, stressed: 75, extreme: 100 });
const PROVENANCE_SYMBOLS = Object.freeze({
  gold: Object.freeze({ physical: 'SHAU', paper: 'GC=F' }),
  silver: Object.freeze({ physical: 'SHAG', paper: 'SI=F' }),
});

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().startsWith(value);
}

function isoInstant(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values.filter(finite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function robustZScore(current, values) {
  if (!finite(current) || !Array.isArray(values) || values.length === 0) return null;
  const center = median(values);
  if (center == null) return null;
  const mad = median(values.filter(finite).map((value) => Math.abs(value - center)));
  if (mad == null || mad === 0) return current === center ? 0 : null;
  return round(0.67448975 * (current - center) / mad, 6);
}

export function percentileRank(current, values) {
  const valid = Array.isArray(values) ? values.filter(finite) : [];
  if (!finite(current) || valid.length === 0) return null;
  const atOrBelow = valid.filter((value) => value <= current).length;
  return round((atOrBelow / valid.length) * 100, 2);
}

function higherRegime(left, right) {
  return REGIME_RANK[left] >= REGIME_RANK[right] ? left : right;
}

export function classifyPhysicalPremiumRegime(metal, premiumPct, percentile) {
  const methodology = METAL_METHODOLOGY[metal];
  if (!methodology || !finite(premiumPct) || !finite(percentile)) {
    throw new TypeError('Physical premium regime requires a supported metal and finite inputs');
  }
  const floors = methodology.absoluteFloors;
  let absolute = 'normal';
  if (premiumPct >= floors.extreme) absolute = 'extreme';
  else if (premiumPct >= floors.stressed) absolute = 'stressed';
  else if (premiumPct >= floors.elevated) absolute = 'elevated';

  let relative = 'normal';
  if (premiumPct > 0 && percentile >= 99) relative = 'extreme';
  else if (premiumPct > 0 && percentile >= 95) relative = 'stressed';
  else if (premiumPct > 0 && percentile >= 80) relative = 'elevated';
  return higherRegime(absolute, relative);
}

function absoluteStressIndex(metal, premiumPct) {
  const floors = METAL_METHODOLOGY[metal].absoluteFloors;
  if (premiumPct <= 0) return 0;
  if (premiumPct < floors.elevated) return (premiumPct / floors.elevated) * 50;
  if (premiumPct < floors.stressed) {
    return 50 + ((premiumPct - floors.elevated) / (floors.stressed - floors.elevated)) * 25;
  }
  if (premiumPct < floors.extreme) {
    return 75 + ((premiumPct - floors.stressed) / (floors.extreme - floors.stressed)) * 25;
  }
  return 100;
}

function trend(delta) {
  if (!finite(delta)) return null;
  if (delta > 0.01) return 'widening';
  if (delta < -0.01) return 'narrowing';
  return 'stable';
}

export function physicalPremiumHistoryPoint(premium) {
  if (
    !premium
    || !isoDate(premium.physical?.asOf)
    || !isoInstant(premium.paper?.asOf)
    || !finite(premium.premiumPct)
    || !finite(premium.premiumUsdPerOz)
  ) return null;
  return {
    date: premium.physical.asOf,
    premiumPct: premium.premiumPct,
    premiumUsdPerOz: premium.premiumUsdPerOz,
    physicalAsOf: premium.physical.asOf,
    paperAsOf: premium.paper.asOf,
    methodologyVersion: METHODOLOGY_VERSION,
  };
}

export function isPhysicalPremiumHistoryPoint(value) {
  return !!value
    && isoDate(value.date)
    && isoDate(value.physicalAsOf)
    && isoInstant(value.paperAsOf)
    && finite(value.premiumPct)
    && finite(value.premiumUsdPerOz)
    && value.methodologyVersion === METHODOLOGY_VERSION;
}

function readingBase(metal, current, historyPoints, fx) {
  const symbols = PROVENANCE_SYMBOLS[metal];
  return {
    metal,
    premiumPct: finite(current?.premiumPct) ? current.premiumPct : null,
    premiumUsdPerOz: finite(current?.premiumUsdPerOz) ? current.premiumUsdPerOz : null,
    physicalAsOf: isoDate(current?.physical?.asOf) ? current.physical.asOf : '',
    paperAsOf: isoInstant(current?.paper?.asOf) ? current.paper.asOf : '',
    historyPoints,
    historyWindowStart: '',
    historyWindowEnd: '',
    methodologyVersion: METHODOLOGY_VERSION,
    provenance: {
      physicalSource: typeof current?.physical?.source === 'string' ? current.physical.source : '',
      physicalSymbol: symbols.physical,
      physicalAsOf: isoDate(current?.physical?.asOf) ? current.physical.asOf : '',
      paperSource: typeof current?.paper?.source === 'string' ? current.paper.source : '',
      paperSymbol: symbols.paper,
      paperAsOf: isoInstant(current?.paper?.asOf) ? current.paper.asOf : '',
      fxSource: typeof fx?.source === 'string' ? fx.source : '',
      fxPair: typeof fx?.pair === 'string' ? fx.pair : '',
      fxAsOf: isoInstant(fx?.asOf) ? fx.asOf : '',
      historyKey: `market:physical-premium-history:v1:${metal}`,
      historyWindowPoints: TRAILING_WINDOW_POINTS,
      methodologyVersion: METHODOLOGY_VERSION,
    },
  };
}

function nonOkReading(base, state, reason) {
  return {
    ...base,
    state,
    reason,
    regime: null,
    percentile: null,
    robustZ: null,
    delta5d: null,
    delta20d: null,
    trend5d: null,
    trend20d: null,
    index: null,
  };
}

export function buildPhysicalDivergenceReading({ metal, current, history, fx, nowMs = Date.now() }) {
  if (!METAL_METHODOLOGY[metal]) throw new TypeError(`Unsupported physical premium metal: ${metal}`);
  const window = (Array.isArray(history) ? history : [])
    .filter(isPhysicalPremiumHistoryPoint)
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, TRAILING_WINDOW_POINTS);
  const base = readingBase(metal, current, window.length, fx);
  if (
    !current
    || !finite(current.premiumPct)
    || !finite(current.premiumUsdPerOz)
    || !isoDate(current.physical?.asOf)
    || !isoInstant(current.paper?.asOf)
    || fx?.source !== 'shared:fx-rates:v1'
    || fx?.pair !== 'CNY/USD'
    || !isoInstant(fx?.asOf)
  ) {
    return nonOkReading(base, 'missing_input', 'current_premium_missing');
  }
  if (!Number.isFinite(nowMs)) return nonOkReading(base, 'missing_input', 'evaluation_clock_invalid');
  const staleReason = physicalDivergenceStaleReason({
    physicalAsOf: current.physical.asOf,
    paperAsOf: current.paper.asOf,
    fxAsOf: fx.asOf,
  }, nowMs);
  if (staleReason === 'physical_print_in_future') {
    return nonOkReading(base, 'missing_input', staleReason);
  }
  if (staleReason) return nonOkReading(base, 'stale_input', staleReason);
  if (window.length < MIN_HISTORY_POINTS) {
    return nonOkReading(base, 'insufficient_history', 'history_points_below_60');
  }

  const values = window.map((entry) => entry.premiumPct);
  const percentile = percentileRank(current.premiumPct, values);
  if (percentile == null) return nonOkReading(base, 'missing_input', 'history_values_invalid');
  const regime = classifyPhysicalPremiumRegime(metal, current.premiumPct, percentile);
  const delta5d = round(current.premiumPct - window[5].premiumPct);
  const delta20d = round(current.premiumPct - window[20].premiumPct);
  const relativeFloor = REGIME_INDEX_FLOOR[regime];
  return {
    ...base,
    historyWindowStart: window.at(-1).date,
    historyWindowEnd: window[0].date,
    state: 'ok',
    reason: '',
    regime,
    percentile,
    robustZ: robustZScore(current.premiumPct, values),
    delta5d,
    delta20d,
    trend5d: trend(delta5d),
    trend20d: trend(delta20d),
    index: round(Math.max(absoluteStressIndex(metal, current.premiumPct), relativeFloor), 2),
  };
}

export function buildPhysicalStressComposite(readings) {
  const byMetal = new Map((Array.isArray(readings) ? readings : []).map((reading) => [reading?.metal, reading]));
  const weights = Object.entries(METAL_METHODOLOGY).map(([metal, methodology]) => ({
    metal,
    weight: methodology.weight,
    methodologyVersion: METHODOLOGY_VERSION,
  }));
  for (const metal of Object.keys(METAL_METHODOLOGY)) {
    const reading = byMetal.get(metal);
    if (!reading) {
      return {
        state: 'missing_input',
        reason: `member_not_ok:${metal}:missing_input`,
        index: null,
        weights,
        methodologyVersion: METHODOLOGY_VERSION,
      };
    }
    if (!['ok', 'insufficient_history', 'stale_input', 'missing_input'].includes(reading.state)) {
      throw new TypeError(`Unknown physical divergence state: ${reading.state}`);
    }
    if (reading.state !== 'ok' || !finite(reading.index)) {
      return {
        state: reading.state,
        reason: `member_not_ok:${metal}:${reading.state}`,
        index: null,
        weights,
        methodologyVersion: METHODOLOGY_VERSION,
      };
    }
  }
  const index = Object.entries(METAL_METHODOLOGY).reduce(
    (sum, [metal, config]) => sum + byMetal.get(metal).index * config.weight,
    0,
  );
  return {
    state: 'ok',
    reason: '',
    index: round(index, 2),
    weights,
    methodologyVersion: METHODOLOGY_VERSION,
  };
}

export function createPhysicalPremiumTransition({ previous, next, nowMs = Date.now(), lastEmittedAtMs }) {
  if (!next || next.state !== 'ok' || !next.regime || !previous || previous.state !== 'ok' || !previous.regime) {
    return null;
  }
  if (previous.metal !== next.metal || previous.regime === next.regime) return null;
  if (
    finite(lastEmittedAtMs)
    && nowMs - lastEmittedAtMs < TRANSITION_COOLDOWN_MS
  ) return null;
  return {
    id: `physical-premium:${next.metal}:${previous.regime}-${next.regime}:${nowMs}`,
    metal: next.metal,
    fromRegime: previous.regime,
    toRegime: next.regime,
    detectedAt: nowMs,
    methodologyVersion: METHODOLOGY_VERSION,
  };
}
