const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const FUTURES_MAX_AGE_MS = 30 * 60_000;
// Weekly observations arrive the following week; allow the next release and holiday delays.
export const EIA_WEEKLY_SPOT_MAX_AGE_MS = 14 * DAY_MS;

const futuresSession = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hourCycle: 'h23',
});

function isFuturesTradingTime(time: number): boolean {
  const parts = futuresSession.formatToParts(time);
  const day = parts.find(part => part.type === 'weekday')?.value;
  const hour = Number(parts.find(part => part.type === 'hour')?.value);
  if (day === 'Sat' || (day === 'Fri' && hour >= 17) || (day === 'Sun' && hour < 18)) return false;
  return hour !== 17;
}

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

export function oilTapeMaxAgeMs(priceBasis: string | undefined, now = Date.now()): number {
  if (priceBasis === 'spot') return 4 * DAY_MS;
  if (priceBasis !== 'futures') return FUTURES_MAX_AGE_MS;
  let cutoff = now - FUTURES_MAX_AGE_MS;
  const trading = isFuturesTradingTime(now);
  if (trading && isFuturesTradingTime(cutoff)) return FUTURES_MAX_AGE_MS;
  if (!trading) cutoff = now;

  // NYMEX crude pauses at 17:00 ET and reopens at 18:00 ET, Sunday through Thursday.
  // Preserve the closing quote through the break and a 30-minute restart grace.
  while (!isFuturesTradingTime(cutoff - 1)) {
    cutoff = Math.floor((cutoff - 1) / HOUR_MS) * HOUR_MS;
  }
  return now - cutoff + FUTURES_MAX_AGE_MS;
}

export function isCrudeOilTicker(symbol: string): boolean {
  return symbol === 'BZ=F' || symbol === 'CL=F';
}
