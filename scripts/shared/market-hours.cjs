'use strict';

/**
 * US equity (NYSE/Nasdaq) market-hours helper — shared by CommonJS relays
 * (ais-relay.cjs) and ESM seeders (seed-market-quotes.mjs). Static
 * `module.exports = { ... }` so Node ESM named imports work
 * (`import { getUsEquitySession } from './shared/market-hours.cjs'`).
 *
 * Sessions in America/New_York (DST-correct via Intl.formatToParts — no
 * manual offset math), boundaries: pre 04:00–09:30, regular 09:30–16:00,
 * post 16:00–20:00; early-close days end regular at 13:00 with post
 * 13:00–17:00; weekends and full NYSE holidays are 'closed' all day.
 *
 * Server-side TypeScript twin: getUsEquitySessionAt() in
 * server/worldmonitor/market/v1/analyze-stock.ts (server code must not
 * import this .cjs — Vercel bundling). tests/market-hours.test.mjs
 * cross-checks both implementations on the same fixtures.
 */

const ET_PARTS_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

const SHANGHAI_WEEKDAY_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  weekday: 'short',
});

function etParts(date) {
  const out = {};
  for (const part of ET_PARTS_FMT.formatToParts(date)) out[part.type] = part.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    weekday: out.weekday, // 'Sun'..'Sat'
    minutes: Number(out.hour) * 60 + Number(out.minute),
  };
}

// Day-of-week (0=Sun) for a pure calendar date — UTC arithmetic is
// timezone-free, so it's safe for calendar math on ET dates.
function dow(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function nthWeekday(year, month, weekday, n) {
  const first = dow(year, month, 1);
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}

function lastWeekdayOfMonth(year, month, weekday) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return lastDay - ((dow(year, month, lastDay) - weekday + 7) % 7);
}

function addDays(year, month, day, delta) {
  const d = new Date(Date.UTC(year, month - 1, day + delta));
  return { month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// Anonymous Gregorian computus (Meeus/Jones/Butcher) — Easter Sunday.
function easterSunday(year) {
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
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

// Standard NYSE observance shift: Sat → preceding Fri, Sun → following Mon.
function observed(year, month, day) {
  const w = dow(year, month, day);
  if (w === 6) return addDays(year, month, day, -1);
  if (w === 0) return addDays(year, month, day, 1);
  return { month, day };
}

const dayKey = (month, day) => month * 100 + day;

const _holidayCache = new Map();

function fullHolidays(year) {
  let set = _holidayCache.get(year);
  if (set) return set;
  set = new Set();
  // New Year's Day — NYSE exception to the Sat→Fri shift: when Jan 1 falls
  // on Saturday the exchange stays OPEN the preceding Friday (Dec 31).
  const newYearDow = dow(year, 1, 1);
  if (newYearDow === 0) set.add(dayKey(1, 2));
  else if (newYearDow !== 6) set.add(dayKey(1, 1));
  set.add(dayKey(1, nthWeekday(year, 1, 1, 3)));   // MLK — 3rd Mon Jan
  set.add(dayKey(2, nthWeekday(year, 2, 1, 3)));   // Presidents — 3rd Mon Feb
  const easter = easterSunday(year);
  const gf = addDays(year, easter.month, easter.day, -2); // Good Friday
  set.add(dayKey(gf.month, gf.day));
  set.add(dayKey(5, lastWeekdayOfMonth(year, 5, 1))); // Memorial — last Mon May
  const jt = observed(year, 6, 19);
  set.add(dayKey(jt.month, jt.day));               // Juneteenth
  const ind = observed(year, 7, 4);
  set.add(dayKey(ind.month, ind.day));             // Independence Day
  set.add(dayKey(9, nthWeekday(year, 9, 1, 1)));   // Labor — 1st Mon Sep
  set.add(dayKey(11, nthWeekday(year, 11, 4, 4))); // Thanksgiving — 4th Thu Nov
  const xmas = observed(year, 12, 25);
  set.add(dayKey(xmas.month, xmas.day));           // Christmas
  _holidayCache.set(year, set);
  return set;
}

function isFullHoliday(year, month, day) {
  return fullHolidays(year).has(dayKey(month, day));
}

// Early-close (13:00 ET) days: Jul 3 and Dec 24 when they land on a trading
// weekday, plus the day after Thanksgiving. When Jul 4 / Dec 25 fall on
// Saturday the preceding Friday is the observed FULL holiday, so the
// isFullHoliday check below correctly suppresses the early-close rule.
function isEarlyCloseDay(year, month, day) {
  const w = dow(year, month, day);
  if (w === 0 || w === 6 || isFullHoliday(year, month, day)) return false;
  if (month === 7 && day === 3) return true;
  if (month === 12 && day === 24) return true;
  if (month === 11 && day === nthWeekday(year, 11, 4, 4) + 1) return true;
  return false;
}

// Session boundaries, minutes from ET midnight:
// pre 04:00 · open 09:30 · close 16:00 · post end 20:00
// early close 13:00 · early post end 17:00
const PRE_START = 4 * 60;
const REGULAR_START = 9 * 60 + 30;
const REGULAR_END = 16 * 60;
const POST_END = 20 * 60;
const EARLY_CLOSE = 13 * 60;
const EARLY_POST_END = 17 * 60;

/** @returns {'regular'|'pre'|'post'|'closed'} US equity session at `date`. */
function getUsEquitySession(date = new Date()) {
  const p = etParts(date);
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return 'closed';
  if (isFullHoliday(p.year, p.month, p.day)) return 'closed';
  const early = isEarlyCloseDay(p.year, p.month, p.day);
  const closeMin = early ? EARLY_CLOSE : REGULAR_END;
  const postEndMin = early ? EARLY_POST_END : POST_END;
  const m = p.minutes;
  if (m >= PRE_START && m < REGULAR_START) return 'pre';
  if (m >= REGULAR_START && m < closeMin) return 'regular';
  if (m >= closeMin && m < postEndMin) return 'post';
  return 'closed';
}

function isUsEquityMarketOpen(date = new Date()) {
  return getUsEquitySession(date) === 'regular';
}

// True when the ET calendar day has ANY US session (weekday, not a full
// holiday). Seeders whose symbol lists mix US and non-US equities (the NSE
// symbols in shared/stocks.json trade 09:15–15:30 IST — deep inside the US
// weekday-overnight 'closed' window) gate on THIS rather than on
// session === 'closed', so overnight fetches keep the non-US quotes live;
// the quota win is the fully-dead days (weekends + US holidays).
function isUsEquityTradingDay(date = new Date()) {
  const p = etParts(date);
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return false;
  return !isFullHoliday(p.year, p.month, p.day);
}

// The shared stock basket spans the US, India, mainland China, and Hong Kong.
// A full NYSE holiday cannot suppress Asian weekday refreshes, so the mixed
// seeder only skips when both the US and Shanghai calendars are on dead days.
function isMultiMarketEquityTradingDay(date = new Date()) {
  if (isUsEquityTradingDay(date)) return true;
  const shanghaiWeekday = SHANGHAI_WEEKDAY_FMT.format(date);
  return shanghaiWeekday !== 'Sat' && shanghaiWeekday !== 'Sun';
}

module.exports = {
  getUsEquitySession,
  isUsEquityMarketOpen,
  isUsEquityTradingDay,
  isMultiMarketEquityTradingDay,
};
