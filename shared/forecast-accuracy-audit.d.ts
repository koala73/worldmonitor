export interface ForecastAccuracyAudit {
  readonly since: string;
  readonly issue: number;
  readonly reason: string;
}

export const FORECAST_ACCURACY_AUDIT: ForecastAccuracyAudit | null;
