export type CalibrationState = 'single-publisher' | 'corroborated';
export type CalibrationEventState = CalibrationState | 'other';
export type CalibrationHorizonId = '24h' | '7d';

export interface CalibrationEvent {
  readonly kind: 'f' | 's';
  readonly storyId: string;
  readonly state: CalibrationEventState;
  readonly at: number;
}

export interface CalibrationOutcome {
  same: number;
  changed: number;
  other: number;
}

export interface CalibrationCohort {
  n: number;
  '24h': CalibrationOutcome;
  '7d': CalibrationOutcome;
}

export interface CalibrationDayRecord {
  day: string;
  version: number;
  incomplete: boolean;
  cohorts: Record<CalibrationState, CalibrationCohort>;
}

export interface CalibrationTableRow {
  state: CalibrationState;
  horizon: CalibrationHorizonId;
  n: number;
  same: number;
  changed: number;
  other: number;
}

export interface CalibrationTableMonth {
  month: string;
  cohortDays: number;
  excludedDays: number;
  firstDay: string;
  lastDay: string;
  rows: CalibrationTableRow[];
}

export interface CalibrationTable {
  generatedAt: number;
  definitionsVersion: number;
  lowNThreshold: number;
  factCheckStatus: string;
  factCheckNote: string;
  months: CalibrationTableMonth[];
}

export declare const CALIBRATION_STATES: readonly CalibrationState[];
export declare const CALIBRATION_OTHER: 'other';
export declare const CALIBRATION_HORIZONS: readonly { readonly id: CalibrationHorizonId; readonly ms: number }[];
export declare const CALIBRATION_DEFINITIONS_VERSION: number;
export declare const CALIBRATION_LOW_N: number;
export declare const CALIBRATION_MONTHS: number;
export declare const CALIBRATION_EVENTS_KEY_PREFIX: string;
export declare const CALIBRATION_EVENTS_TTL_S: number;
export declare const CALIBRATION_EVENTS_MAX: number;
export declare const CALIBRATION_DAY_KEY_PREFIX: string;
export declare const CALIBRATION_DAY_TTL_S: number;
export declare const CALIBRATION_SETTLE_MS: number;
export declare const CALIBRATION_FINALIZE_MAX_AGE_DAYS: number;
export declare const LABEL_CALIBRATION_KEY: string;
export declare const FACT_CHECK_STATUS: string;
export declare const FACT_CHECK_NOTE: string;

export declare function calibrationEventsKey(day: string): string;
export declare function calibrationDayKey(day: string): string;
export declare function utcDay(ms: number): string;
export declare function dayStartMs(day: string): number;
export declare function addDays(day: string, count: number): string;
export declare function encodeCalibrationEvent(event: CalibrationEvent): string | null;
export declare function parseCalibrationEvent(raw: unknown): CalibrationEvent | null;
export declare function calibrationStateOf(rawLabel: unknown, untrackedMarker: string): CalibrationEventState | null;
export declare function buildCohortDay(
  day: string,
  events: readonly (CalibrationEvent | null)[],
  options?: { incomplete?: boolean },
): CalibrationDayRecord;
export declare function parseCohortDay(raw: unknown): CalibrationDayRecord | null;
export declare function finalizableDays(nowMs: number): string[];
export declare function eventDaysFor(day: string): string[];
export declare function calibrationMonths(nowMs: number): string[];
export declare function calibrationTableDays(nowMs: number): string[];
export declare function buildCalibrationTable(
  records: readonly (CalibrationDayRecord | null)[],
  options: { generatedAt: number },
): CalibrationTable;
export declare function parseCalibrationTable(value: unknown): CalibrationTable | null;
