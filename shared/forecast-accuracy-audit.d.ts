export interface ForecastAccuracyAudit {
  readonly since: string;
  readonly issue: number;
  readonly reason: string;
  /** Set on the standing audit only: it lifts once the headline is measurable. */
  readonly liftsWhenMeasurable?: boolean;
}

export type HeadlineFamilyGate = 'met' | 'short' | 'unknown';

export const STANDING_ACCURACY_AUDIT: ForecastAccuracyAudit;
export const FORECAST_ACCURACY_AUDIT_OVERRIDE: ForecastAccuracyAudit | null;
export function headlineFamilyGate(scorecard: unknown): HeadlineFamilyGate;
export function forecastAccuracyAudit(scorecard: unknown, override?: ForecastAccuracyAudit | null): ForecastAccuracyAudit | null;
