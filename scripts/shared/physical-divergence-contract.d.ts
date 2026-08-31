export type PhysicalDivergenceMetal = 'gold' | 'silver';
export type PhysicalDivergenceState = 'ok' | 'insufficient_history' | 'stale_input' | 'missing_input';
export type PhysicalDivergenceNonOkState = Exclude<PhysicalDivergenceState, 'ok'>;
export type PhysicalDivergenceRegime = 'normal' | 'elevated' | 'stressed' | 'extreme';
export type PhysicalDivergenceTrend = 'widening' | 'stable' | 'narrowing';
export interface PhysicalDivergenceCompositeInput {
  metal: PhysicalDivergenceMetal;
  state: PhysicalDivergenceState;
  index: number | null;
}
export interface PhysicalDivergenceComposite {
  state: PhysicalDivergenceState;
  reason: string;
  index: number | null;
  weights: Array<{ metal: PhysicalDivergenceMetal; weight: number; methodologyVersion: string }>;
  methodologyVersion: string;
}
export const PHYSICAL_DIVERGENCE_CONTRACT: Readonly<{
  methodologyVersion: 'physical-divergence-v2';
  metalOrder: readonly ['gold', 'silver'];
  metals: Readonly<Record<PhysicalDivergenceMetal, Readonly<{
    physicalSymbol: 'SHAU' | 'SHAG';
    physicalUnit: 'gram' | 'kilogram';
    paperSymbol: 'GC=F' | 'SI=F';
    weight: number;
    absoluteFloors: Readonly<{ elevated: number; stressed: number; extreme: number }>;
    historyKey: string;
  }>>>;
  states: readonly PhysicalDivergenceState[];
  nonOkStatePriority: readonly PhysicalDivergenceNonOkState[];
  regimes: readonly PhysicalDivergenceRegime[];
  trends: readonly PhysicalDivergenceTrend[];
  history: Readonly<{ retainedPoints: 750; windowPoints: 250; minimumPoints: 60 }>;
  freshness: Readonly<{
    physicalStaleAfterCalendarDays: 12;
    paperMaxAgeMs: number;
    fxMaxAgeMs: number;
    missingReasons: readonly string[];
    staleReasons: readonly string[];
  }>;
  reasons: Readonly<{
    currentPremiumMissing: 'current_premium_missing';
    evaluationClockInvalid: 'evaluation_clock_invalid';
    physicalPrintInvalid: 'physical_print_invalid';
    paperSnapshotInvalid: 'paper_snapshot_invalid';
    fxSnapshotInvalid: 'fx_snapshot_invalid';
    physicalPrintInFuture: 'physical_print_in_future';
    physicalPrintStale: 'physical_print_older_than_12_calendar_days';
    paperSnapshotInFuture: 'paper_snapshot_in_future';
    paperSnapshotStale: 'paper_snapshot_older_than_36_hours';
    fxSnapshotInFuture: 'fx_snapshot_in_future';
    fxSnapshotStale: 'fx_snapshot_older_than_60_hours';
    historyPointsInsufficient: 'history_points_below_60';
    historyWindowNotAligned: 'history_window_not_aligned';
    historyValuesInvalid: 'history_values_invalid';
    snapshotUnavailable: 'divergence_snapshot_unavailable';
    methodologyUnsupported: 'divergence_methodology_unsupported';
  }>;
  storedReadingReasonsByState: Readonly<Record<PhysicalDivergenceState, readonly string[]>>;
  rpcFallbackReasons: readonly string[];
  readingReasonValues: readonly string[];
  compositeReasonValues: readonly string[];
  readingReasonPattern: string;
  compositeReasonPattern: string;
}>;
export function physicalDivergenceStateForFreshnessReason(reason: unknown): 'missing_input' | 'stale_input';
export function isPhysicalDivergenceStoredReadingReason(state: unknown, reason: unknown): boolean;
export function isPhysicalDivergenceStoredCompositeReason(state: unknown, reason: unknown): boolean;
export function buildPhysicalStressComposite(readings: readonly PhysicalDivergenceCompositeInput[]): PhysicalDivergenceComposite;
