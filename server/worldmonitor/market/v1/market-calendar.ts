/**
 * US equities session calendar used by the stock adapter.
 *
 * This is deliberately an exchange-calendar calculation rather than a
 * "weekday means open" shortcut: it models the regular NYSE closures and the
 * common early-close sessions. The provider remains the authority for its own
 * exchange metadata; unknown/non-US listings are never forced through this
 * calendar by the caller.
 */

import type { MarketSession } from '../../../../src/generated/server/worldmonitor/market/v1/service_server';

type CalendarDate = { year: number; month: number; day: number };

export type UsEquityMarketState = {
  session: MarketSession;
  marketClosed: boolean;
  tradingDate: string;
  earlyClose: boolean;
  reason: string;
};

const NY_TIME_ZONE = 'America/New_York';

function nyParts(now: Date): Record<string, number> {
  const values = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  return Object.fromEntries(values
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, Number(part.value)]));
}

function utcDate({ year, month, day }: CalendarDate): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function formatDate(date: CalendarDate): string {
  return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

function observedFixedHoliday(year: number, month: number, day: number): string {
  const date = utcDate({ year, month, day });
  const weekDay = date.getUTCDay();
  if (weekDay === 6) date.setUTCDate(date.getUTCDate() - 1);
  if (weekDay === 0) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): string {
  const date = utcDate({ year, month, day: 1 });
  const offset = (weekday - date.getUTCDay() + 7) % 7;
  date.setUTCDate(1 + offset + ((nth - 1) * 7));
  return date.toISOString().slice(0, 10);
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number): string {
  const date = utcDate({ year, month: month + 1, day: 0 });
  const offset = (date.getUTCDay() - weekday + 7) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

function easterSunday(year: number): Date {
  // Meeus/Jones/Butcher Gregorian computus.
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  return utcDate({ year, month: Math.floor((h + l - 7 * m + 114) / 31), day: ((h + l - 7 * m + 114) % 31) + 1 });
}

function goodFriday(year: number): string {
  const date = easterSunday(year);
  date.setUTCDate(date.getUTCDate() - 2);
  return date.toISOString().slice(0, 10);
}

/** Normal NYSE full-day closures, with observed dates for fixed holidays. */
export function usEquityFullClosures(year: number): Set<string> {
  return new Set([
    observedFixedHoliday(year, 1, 1),
    nthWeekdayOfMonth(year, 1, 1, 3), // MLK Day
    nthWeekdayOfMonth(year, 2, 1, 3), // Presidents Day
    goodFriday(year),
    lastWeekdayOfMonth(year, 5, 1), // Memorial Day
    observedFixedHoliday(year, 6, 19),
    observedFixedHoliday(year, 7, 4),
    nthWeekdayOfMonth(year, 9, 1, 1), // Labor Day
    nthWeekdayOfMonth(year, 11, 4, 4), // Thanksgiving
    observedFixedHoliday(year, 12, 25),
  ]);
}

/** Scheduled early closes: day after Thanksgiving, Jul 3 and Christmas Eve when weekdays. */
export function isUsEquityEarlyClose(date: CalendarDate): boolean {
  const iso = formatDate(date);
  const weekday = utcDate(date).getUTCDay();
  const thanksgiving = nthWeekdayOfMonth(date.year, 11, 4, 4);
  const thanksgivingDate = new Date(`${thanksgiving}T00:00:00.000Z`);
  thanksgivingDate.setUTCDate(thanksgivingDate.getUTCDate() + 1);
  const blackFriday = thanksgivingDate.toISOString().slice(0, 10);
  if (iso === blackFriday) return true;
  if (date.month === 7 && date.day === 3 && weekday >= 1 && weekday <= 5) return true;
  return date.month === 12 && date.day === 24 && weekday >= 1 && weekday <= 5;
}

export function resolveUsEquityMarketState(now: Date = new Date()): UsEquityMarketState {
  const parts = nyParts(now);
  const date = { year: parts.year!, month: parts.month!, day: parts.day! };
  const iso = formatDate(date);
  const weekday = utcDate(date).getUTCDay();
  const minuteOfDay = (parts.hour! * 60) + parts.minute!;
  const fullClosures = usEquityFullClosures(date.year);

  if (weekday === 0 || weekday === 6) {
    return { session: 'MARKET_SESSION_CLOSED', marketClosed: true, tradingDate: iso, earlyClose: false, reason: 'weekend' };
  }
  if (fullClosures.has(iso)) {
    return { session: 'MARKET_SESSION_CLOSED', marketClosed: true, tradingDate: iso, earlyClose: false, reason: 'exchange holiday' };
  }

  const earlyClose = isUsEquityEarlyClose(date);
  const closeMinute = earlyClose ? 13 * 60 : 16 * 60;
  if (minuteOfDay < 4 * 60) {
    return { session: 'MARKET_SESSION_CLOSED', marketClosed: true, tradingDate: iso, earlyClose, reason: 'outside trading sessions' };
  }
  if (minuteOfDay < (9 * 60) + 30) {
    return { session: 'MARKET_SESSION_PRE', marketClosed: false, tradingDate: iso, earlyClose, reason: 'pre-market' };
  }
  if (minuteOfDay < closeMinute) {
    return { session: 'MARKET_SESSION_REGULAR', marketClosed: false, tradingDate: iso, earlyClose, reason: 'regular session' };
  }
  if (minuteOfDay < 20 * 60) {
    return { session: 'MARKET_SESSION_AFTER', marketClosed: false, tradingDate: iso, earlyClose, reason: 'after-hours' };
  }
  return { session: 'MARKET_SESSION_CLOSED', marketClosed: true, tradingDate: iso, earlyClose, reason: 'outside trading sessions' };
}
