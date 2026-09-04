const METHODOLOGY_VERSION = 'physical-divergence-v2';
const METAL_ORDER = Object.freeze(['gold', 'silver']);
const STATES = Object.freeze(['ok', 'insufficient_history', 'stale_input', 'missing_input']);
const NON_OK_STATE_PRIORITY = Object.freeze(['missing_input', 'stale_input', 'insufficient_history']);

const REASONS = Object.freeze({
  currentPremiumMissing: 'current_premium_missing',
  evaluationClockInvalid: 'evaluation_clock_invalid',
  physicalPrintInvalid: 'physical_print_invalid',
  paperSnapshotInvalid: 'paper_snapshot_invalid',
  fxSnapshotInvalid: 'fx_snapshot_invalid',
  physicalPrintInFuture: 'physical_print_in_future',
  physicalPrintStale: 'physical_print_older_than_12_calendar_days',
  paperSnapshotInFuture: 'paper_snapshot_in_future',
  paperSnapshotStale: 'paper_snapshot_older_than_36_hours',
  fxSnapshotInFuture: 'fx_snapshot_in_future',
  fxSnapshotStale: 'fx_snapshot_older_than_60_hours',
  historyPointsInsufficient: 'history_points_below_60',
  historyWindowNotAligned: 'history_window_not_aligned',
  historyValuesInvalid: 'history_values_invalid',
  snapshotUnavailable: 'divergence_snapshot_unavailable',
  methodologyUnsupported: 'divergence_methodology_unsupported',
});

const MISSING_REASONS = Object.freeze([
  REASONS.physicalPrintInvalid,
  REASONS.paperSnapshotInvalid,
  REASONS.fxSnapshotInvalid,
  REASONS.physicalPrintInFuture,
  REASONS.paperSnapshotInFuture,
  REASONS.fxSnapshotInFuture,
]);
const STALE_REASONS = Object.freeze([
  REASONS.physicalPrintStale,
  REASONS.paperSnapshotStale,
  REASONS.fxSnapshotStale,
]);
const STORED_READING_REASONS_BY_STATE = Object.freeze({
  ok: Object.freeze(['']),
  insufficient_history: Object.freeze([REASONS.historyPointsInsufficient]),
  stale_input: STALE_REASONS,
  missing_input: Object.freeze([
    REASONS.currentPremiumMissing,
    REASONS.evaluationClockInvalid,
    ...MISSING_REASONS,
    REASONS.historyWindowNotAligned,
    REASONS.historyValuesInvalid,
  ]),
});
const RPC_FALLBACK_REASONS = Object.freeze([
  REASONS.snapshotUnavailable,
  REASONS.methodologyUnsupported,
]);
const READING_REASON_VALUES = Object.freeze([
  ...STORED_READING_REASONS_BY_STATE.ok,
  ...STORED_READING_REASONS_BY_STATE.insufficient_history,
  ...STORED_READING_REASONS_BY_STATE.stale_input,
  ...STORED_READING_REASONS_BY_STATE.missing_input,
  ...RPC_FALLBACK_REASONS,
]);
const COMPOSITE_MEMBER_REASONS = Object.freeze(NON_OK_STATE_PRIORITY.flatMap((state) => (
  METAL_ORDER.map((metal) => `member_not_ok:${metal}:${state}`)
)));
const COMPOSITE_REASON_VALUES = Object.freeze(['', ...RPC_FALLBACK_REASONS, ...COMPOSITE_MEMBER_REASONS]);

function pattern(values) {
  return `^(?:${values.join('|')})$`;
}

export const PHYSICAL_DIVERGENCE_CONTRACT = Object.freeze({
  methodologyVersion: METHODOLOGY_VERSION,
  metalOrder: METAL_ORDER,
  metals: Object.freeze({
    gold: Object.freeze({
      physicalSymbol: 'SHAU',
      physicalUnit: 'gram',
      paperSymbol: 'GC=F',
      weight: 0.7,
      absoluteFloors: Object.freeze({ elevated: 1, stressed: 3, extreme: 5 }),
      historyKey: 'market:physical-premium-history:v1:gold',
    }),
    silver: Object.freeze({
      physicalSymbol: 'SHAG',
      physicalUnit: 'kilogram',
      paperSymbol: 'SI=F',
      weight: 0.3,
      absoluteFloors: Object.freeze({ elevated: 5, stressed: 10, extreme: 20 }),
      historyKey: 'market:physical-premium-history:v1:silver',
    }),
  }),
  states: STATES,
  nonOkStatePriority: NON_OK_STATE_PRIORITY,
  regimes: Object.freeze(['normal', 'elevated', 'stressed', 'extreme']),
  trends: Object.freeze(['widening', 'stable', 'narrowing']),
  history: Object.freeze({ retainedPoints: 750, windowPoints: 250, minimumPoints: 60 }),
  freshness: Object.freeze({
    physicalStaleAfterCalendarDays: 12,
    paperMaxAgeMs: 36 * 60 * 60 * 1000,
    fxMaxAgeMs: 60 * 60 * 60 * 1000,
    missingReasons: MISSING_REASONS,
    staleReasons: STALE_REASONS,
  }),
  reasons: REASONS,
  storedReadingReasonsByState: STORED_READING_REASONS_BY_STATE,
  rpcFallbackReasons: RPC_FALLBACK_REASONS,
  readingReasonValues: READING_REASON_VALUES,
  compositeReasonValues: COMPOSITE_REASON_VALUES,
  readingReasonPattern: pattern(READING_REASON_VALUES),
  compositeReasonPattern: pattern(COMPOSITE_REASON_VALUES),
});

export function physicalDivergenceStateForFreshnessReason(reason) {
  if (MISSING_REASONS.includes(reason)) return 'missing_input';
  if (STALE_REASONS.includes(reason)) return 'stale_input';
  throw new TypeError(`Unknown physical divergence freshness reason: ${String(reason)}`);
}

export function isPhysicalDivergenceStoredReadingReason(state, reason) {
  return STORED_READING_REASONS_BY_STATE[state]?.includes(reason) === true;
}

export function isPhysicalDivergenceStoredCompositeReason(state, reason) {
  if (state === 'ok') return reason === '';
  return NON_OK_STATE_PRIORITY.includes(state)
    && COMPOSITE_MEMBER_REASONS.includes(reason)
    && reason.endsWith(`:${state}`);
}

export function buildPhysicalStressComposite(readings) {
  const values = Array.isArray(readings) ? readings : [];
  const byMetal = new Map();
  for (const reading of values) {
    if (!METAL_ORDER.includes(reading?.metal)) {
      throw new TypeError(`Unsupported physical divergence metal: ${String(reading?.metal)}`);
    }
    if (byMetal.has(reading.metal)) {
      throw new TypeError(`Physical divergence composite repeats a metal: ${reading.metal}`);
    }
    if (!STATES.includes(reading.state)) {
      throw new TypeError(`Unknown physical divergence state: ${String(reading.state)}`);
    }
    byMetal.set(reading.metal, reading);
  }
  const weights = METAL_ORDER.map((metal) => ({
    metal,
    weight: PHYSICAL_DIVERGENCE_CONTRACT.metals[metal].weight,
    methodologyVersion: METHODOLOGY_VERSION,
  }));
  for (const metal of METAL_ORDER) {
    if (!byMetal.has(metal)) {
      return {
        state: 'missing_input',
        reason: `member_not_ok:${metal}:missing_input`,
        index: null,
        weights,
        methodologyVersion: METHODOLOGY_VERSION,
      };
    }
  }
  for (const state of NON_OK_STATE_PRIORITY) {
    for (const metal of METAL_ORDER) {
      if (byMetal.get(metal).state === state) {
        return {
          state,
          reason: `member_not_ok:${metal}:${state}`,
          index: null,
          weights,
          methodologyVersion: METHODOLOGY_VERSION,
        };
      }
    }
  }
  for (const metal of METAL_ORDER) {
    if (!Number.isFinite(byMetal.get(metal).index)) {
      throw new TypeError(`Ok physical divergence reading has an invalid index: ${metal}`);
    }
  }
  const index = METAL_ORDER.reduce((sum, metal) => (
    sum + byMetal.get(metal).index * PHYSICAL_DIVERGENCE_CONTRACT.metals[metal].weight
  ), 0);
  return {
    state: 'ok',
    reason: '',
    index: Math.round((index + Number.EPSILON) * 100) / 100,
    weights,
    methodologyVersion: METHODOLOGY_VERSION,
  };
}
