import { CME_ENERGY_CLOSES, EIA_RELEASE_SHIFTS } from './oil-release-calendar';

const DAY_MS = 86_400_000;
const FUTURES_MAX_AGE_MS = 30 * 60_000;
// The petroleum bundle refreshes daily. Allow one refresh after the next release.
const EIA_RELEASE_GRACE_MS = DAY_MS;

const futuresSession = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: 'numeric', minute: '2-digit', hourCycle: 'h23',
});

function isFuturesTradingTime(time: number): boolean {
  const parts = Object.fromEntries(futuresSession.formatToParts(time).map(part => [part.type, part.value]));
  const day = parts.weekday;
  const hour = Number(parts.hour);
  if (day === 'Sat' || (day === 'Fri' && hour >= 17) || (day === 'Sun' && hour < 18)) return false;
  if (hour === 17) return false;
  const localDate = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  // An evening open belongs to the following trade date. A full holiday has no
  // preceding evening session, while an early halt can reopen at 18:00 ET.
  const tradeDate = new Date(localDate + (hour >= 18 ? DAY_MS : 0)).toISOString().slice(0, 10);
  const close = CME_ENERGY_CLOSES[tradeDate] ?? 17 * 60;
  return close !== 0 && (hour >= 18 || hour * 60 + Number(parts.minute) < close);
}

function nextEiaRelease(priceAt: number): number {
  const nextWeek = new Date(Math.floor(priceAt / DAY_MS) * DAY_MS + 7 * DAY_MS);
  const shift = EIA_RELEASE_SHIFTS[nextWeek.toISOString().slice(0, 10)];
  if (shift) return Date.parse(shift);
  // Regular release: Wednesday after the next week ends, at 10:30 ET.
  const releaseDay = nextWeek.getTime() + ((3 - nextWeek.getUTCDay() + 7) % 7) * DAY_MS;
  const candidate = releaseDay + (10 * 60 + 30) * 60_000;
  const parts = Object.fromEntries(futuresSession.formatToParts(candidate).map(part => [part.type, part.value]));
  const localTime = Number(parts.hour) * 60 + Number(parts.minute);
  return candidate + (10 * 60 + 30 - localTime) * 60_000;
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
    stale: isStaleOilPrice(priceAt, Infinity, now)
      || now > nextEiaRelease(priceAt!) + EIA_RELEASE_GRACE_MS,
  };
}

export function oilTapeMaxAgeMs(priceBasis: string | undefined, now = Date.now()): number {
  if (priceBasis === 'spot') return 4 * DAY_MS;
  if (priceBasis !== 'futures') return FUTURES_MAX_AGE_MS;
  let cutoff = now - FUTURES_MAX_AGE_MS;
  const trading = isFuturesTradingTime(now);
  if (trading && isFuturesTradingTime(cutoff)) return FUTURES_MAX_AGE_MS;
  if (!trading) cutoff = now;

  // Preserve the closing quote through scheduled breaks/holidays and a restart
  // grace. All calendar boundaries are on a quarter hour, including early halts.
  while (!isFuturesTradingTime(cutoff - 1)) {
    cutoff = Math.floor((cutoff - 1) / (15 * 60_000)) * (15 * 60_000);
  }
  return now - cutoff + FUTURES_MAX_AGE_MS;
}

export function isCrudeOilTicker(symbol: string): boolean {
  return symbol === 'BZ=F' || symbol === 'CL=F';
}
