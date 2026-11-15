import { SEASONAL_Z_ALERT } from '../scripts/shared/reservoir-seasonal.mjs';

/** A reservoir level is beyond its seasonal baseline at SEASONAL_Z_ALERT seasonal deviations. */
export function isBeyondSeasonalBaseline(seasonalZ: number | null | undefined): boolean {
  return seasonalZ != null && Number.isFinite(seasonalZ) && Math.abs(seasonalZ) >= SEASONAL_Z_ALERT;
}
