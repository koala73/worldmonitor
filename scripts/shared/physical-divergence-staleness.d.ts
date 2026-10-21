export const PHYSICAL_DIVERGENCE_STALE_AFTER_CALENDAR_DAYS: 12;
export const PHYSICAL_DIVERGENCE_PAPER_MAX_AGE_MS: number;
export const PHYSICAL_DIVERGENCE_FX_MAX_AGE_MS: number;
export function isPhysicalDivergenceDate(value: unknown): value is string;
export function isPhysicalDivergenceInstant(value: unknown): value is string;
export function isPhysicalDivergencePrintFuture(value: string, nowMs: number): boolean;
export function isPhysicalDivergencePrintStale(value: string, nowMs: number): boolean;
export function physicalDivergenceStaleReason(
  clocks: { physicalAsOf: string; paperAsOf: string; fxAsOf: string },
  nowMs: number,
): string | null;
