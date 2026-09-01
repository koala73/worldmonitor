import {
  isPhysicalDivergenceDate,
  isPhysicalDivergenceInstant,
  physicalDivergenceStaleReason,
} from '../shared/physical-divergence-staleness.js';
import {
  PHYSICAL_DIVERGENCE_CONTRACT,
  buildPhysicalStressComposite,
  physicalDivergenceStateForFreshnessReason,
} from '../shared/physical-divergence-contract.js';

export const METHODOLOGY_VERSION = PHYSICAL_DIVERGENCE_CONTRACT.methodologyVersion;
export const HISTORY_LIMIT = PHYSICAL_DIVERGENCE_CONTRACT.history.retainedPoints;
export const TRAILING_WINDOW_POINTS = PHYSICAL_DIVERGENCE_CONTRACT.history.windowPoints;
export const MIN_HISTORY_POINTS = PHYSICAL_DIVERGENCE_CONTRACT.history.minimumPoints;
// Two times the daily physical-print cadence prevents a repeated transition on the next seed run.
export const TRANSITION_COOLDOWN_MS = 48 * 60 * 60 * 1000;

const METAL_METHODOLOGY = PHYSICAL_DIVERGENCE_CONTRACT.metals;

const REGIME_RANK = Object.freeze({ normal: 0, elevated: 1, stressed: 2, extreme: 3 });
// Index floors stay ordered with absoluteStressIndex band tops. Absolute extreme alone
// publishes 100; a relative-only extreme floors at 90 so it cannot saturate the scale
// (#7423). Absolute stressed maps into [70, 90), so no stressed reading can outscore any
// extreme reading.
const REGIME_INDEX_FLOOR = Object.freeze({ normal: 0, elevated: 45, stressed: 70, extreme: 90 });

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isoDate(value) {
  return isPhysicalDivergenceDate(value);
}

function isoInstant(value) {
  return isPhysicalDivergenceInstant(value);
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

function percentileRank(current, values) {
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

  // #6448: "Percentile-only classification is forbidden ... historical percentile refines
  // WITHIN the floors." `premiumPct > 0` is a SIGN test, not a magnitude test, and a
  // percentile over a rolling window makes any new high the maximum reading regardless of
  // size — so a 0.05% gold premium (20x under the 1% elevated floor) scored percentile 100
  // and classified `extreme` with index 100/100 against a calm, discounted window.
  //
  // The gate is a magnitude floor at half the `elevated` floor rather than the elevated
  // floor itself: gating at `elevated` would make the 80th-percentile tier unreachable
  // (anything clearing it is already `elevated` absolutely), collapsing a documented
  // three-tier ladder to two. Half keeps all three tiers live while still requiring a
  // premium of real size before relative history can speak.
  const relativeFloor = floors.elevated / 2;
  const clearsRelativeFloor = premiumPct >= relativeFloor;
  let relative = 'normal';
  if (clearsRelativeFloor && percentile >= 99) relative = 'extreme';
  else if (clearsRelativeFloor && percentile >= 95) relative = 'stressed';
  else if (clearsRelativeFloor && percentile >= 80) relative = 'elevated';
  return higherRegime(absolute, relative);
}

function absoluteStressIndex(metal, premiumPct) {
  const floors = METAL_METHODOLOGY[metal].absoluteFloors;
  // Band tops are 45 / 70 / 90 so they nest under REGIME_INDEX_FLOOR and leave 100 reserved
  // for clearing the absolute extreme premium floor. Relative escalation uses the floor
  // table; absolute magnitude never publishes past 90 until that absolute extreme clears.
  if (premiumPct <= 0) return 0;
  if (premiumPct < floors.elevated) return (premiumPct / floors.elevated) * 45;
  if (premiumPct < floors.stressed) {
    return 45 + ((premiumPct - floors.elevated) / (floors.stressed - floors.elevated)) * 25;
  }
  if (premiumPct < floors.extreme) {
    // Span stops short of 20 so the open top stays below 90 after the published
    // two-decimal round (a full *20 approaches 90 and rounds up to the extreme floor).
    return 70 + ((premiumPct - floors.stressed) / (floors.extreme - floors.stressed)) * 19.99;
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
  const contract = METAL_METHODOLOGY[metal];
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
      physicalSymbol: contract.physicalSymbol,
      physicalAsOf: isoDate(current?.physical?.asOf) ? current.physical.asOf : '',
      paperSource: typeof current?.paper?.source === 'string' ? current.paper.source : '',
      paperSymbol: contract.paperSymbol,
      paperAsOf: isoInstant(current?.paper?.asOf) ? current.paper.asOf : '',
      fxSource: typeof fx?.source === 'string' ? fx.source : '',
      fxPair: typeof fx?.pair === 'string' ? fx.pair : '',
      fxAsOf: isoInstant(fx?.asOf) ? fx.asOf : '',
      historyKey: contract.historyKey,
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
    return nonOkReading(base, 'missing_input', PHYSICAL_DIVERGENCE_CONTRACT.reasons.currentPremiumMissing);
  }
  if (!Number.isFinite(nowMs)) {
    return nonOkReading(base, 'missing_input', PHYSICAL_DIVERGENCE_CONTRACT.reasons.evaluationClockInvalid);
  }
  const staleReason = physicalDivergenceStaleReason({
    physicalAsOf: current.physical.asOf,
    paperAsOf: current.paper.asOf,
    fxAsOf: fx.asOf,
  }, nowMs);
  if (staleReason) {
    return nonOkReading(base, physicalDivergenceStateForFreshnessReason(staleReason), staleReason);
  }
  if (window.length < MIN_HISTORY_POINTS) {
    return nonOkReading(base, 'insufficient_history', PHYSICAL_DIVERGENCE_CONTRACT.reasons.historyPointsInsufficient);
  }
  // delta5d/delta20d index the window POSITIONALLY, which is only the true 5- and 20-print
  // delta when the current print is the newest stored one. The window is sorted by date, so
  // a print older than what is already stored (a re-published SGE row, a --sha/--env replay)
  // would silently shift both offsets while the reading still reported `ok`. Fail closed
  // instead of publishing a quietly wrong trend.
  if (window[0].date !== current.physical.asOf) {
    return nonOkReading(base, 'missing_input', PHYSICAL_DIVERGENCE_CONTRACT.reasons.historyWindowNotAligned);
  }

  const values = window.map((entry) => entry.premiumPct);
  const percentile = percentileRank(current.premiumPct, values);
  if (percentile == null) {
    return nonOkReading(base, 'missing_input', PHYSICAL_DIVERGENCE_CONTRACT.reasons.historyValuesInvalid);
  }
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

export { buildPhysicalStressComposite };

export function createPhysicalPremiumTransition({
  previous,
  next,
  nowMs = Date.now(),
  lastEmittedAtMs,
  lastEmittedRegime = null,
}) {
  if (!next || next.state !== 'ok' || !next.regime || !previous || previous.state !== 'ok' || !previous.regime) {
    return null;
  }
  if (previous.metal !== next.metal || previous.regime === next.regime) return null;
  // The cooldown suppresses a REPEAT of an already-emitted transition, never a move to a
  // regime we have not announced. `previous` is the last PUBLISHED snapshot, which advances
  // even on a suppressed run — so a bare time gate here would drop a genuinely new regime
  // change permanently rather than defer it (T0 normal->elevated emitted; T0+30h
  // elevated->stressed suppressed; T0+54h the regimes match and it never fires).
  //
  // Two guards, matching this repo's own cooldown model in
  // scripts/lib/digest-cooldown-decision.mjs: suppression is keyed to the last DELIVERED
  // state, and a severity escalation is a universal re-allow trigger. Alertmanager works the
  // same way — notifications repeat only when nothing has changed since the last group.
  // Inside the window we announce only an ESCALATION beyond the worst regime already
  // announced; repeats and de-escalations wait for the window to clear. A transition to a
  // regime strictly worse than the last emitted one is never dropped.
  const withinCooldown = finite(lastEmittedAtMs) && nowMs - lastEmittedAtMs < TRANSITION_COOLDOWN_MS;
  const lastRank = REGIME_RANK[lastEmittedRegime];
  const suppressed = withinCooldown
    && finite(lastRank)
    && REGIME_RANK[next.regime] <= lastRank;
  if (suppressed) return null;
  return {
    id: `physical-premium:${next.metal}:${previous.regime}-${next.regime}:${nowMs}`,
    metal: next.metal,
    fromRegime: previous.regime,
    toRegime: next.regime,
    detectedAt: nowMs,
    methodologyVersion: METHODOLOGY_VERSION,
  };
}
