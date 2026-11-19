/**
 * `GasSensitivity.modelBasis` values the browser renders. Mirrors GAS_MODEL_BASIS
 * in server/worldmonitor/intelligence/v1/_shock-compute.ts; tests/gas-model-basis.test.mts
 * checks that the two agree. Any other value is an outdated or unknown model.
 */
export const MEASURED_LNG_BASIS = 'comtrade_lng_origin_share';
export const ZERO_LNG_BASIS = 'observed_zero_lng_imports';
export const ASSUMED_ROUTE_BASIS = 'assumed_route_sensitivity';

export const SUPPORTED_GAS_MODEL_BASES: ReadonlySet<string> = new Set([MEASURED_LNG_BASIS, ZERO_LNG_BASIS, ASSUMED_ROUTE_BASIS]);

/** "2025-02 to 2026-01" for a monthly window, "2025 annual" for a calendar year. */
export function lngWindowLabel(b: { basis: string; fromMonth: string; toMonth: string }): string {
  if (b.basis === 'comtrade_annual') return `${b.fromMonth.slice(0, 4)} annual`;
  return b.fromMonth === b.toMonth ? b.fromMonth : `${b.fromMonth} to ${b.toMonth}`;
}

/** A share as a one-decimal percent, with "<0.1" for small nonzero values. */
export function lngSharePct(share: number): string {
  const v = share * 100;
  return v > 0 && v < 0.1 ? '<0.1' : v.toFixed(1);
}
