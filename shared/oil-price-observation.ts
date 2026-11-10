const DAY_MS = 86_400_000;
// EIA reports a week ending Friday with a release lag of several days.
export const EIA_WEEKLY_SPOT_MAX_AGE_MS = 10 * DAY_MS;

export function isStaleOilPrice(priceAt: number | undefined, maxAgeMs: number, now = Date.now()): boolean {
  return priceAt == null || !Number.isFinite(priceAt) || priceAt <= 0
    || priceAt > now || now - priceAt > maxAgeMs;
}

export function eiaWeeklySpotProvenance(priceAt: number | undefined, now = Date.now()) {
  return {
    priceSource: 'EIA',
    priceBasis: 'spot',
    frequency: 'weekly',
    stale: isStaleOilPrice(priceAt, EIA_WEEKLY_SPOT_MAX_AGE_MS, now),
  };
}

export function oilTapeMaxAgeMs(priceBasis: string | undefined): number {
  return priceBasis === 'spot' ? 4 * DAY_MS : 30 * 60_000;
}

export function isCrudeOilTicker(symbol: string): boolean {
  return symbol === 'BZ=F' || symbol === 'CL=F';
}
