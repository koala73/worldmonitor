const DAY = 86_400_000;
const utc = (year: number, month: number, day: number) => Date.UTC(year, month - 1, day);

// EIA releases the Weekly Petroleum Status Report Wednesday 10:30 ET. A federal
// holiday on the Monday through Wednesday of that week moves it to Thursday 12:00 ET.
// https://www.eia.gov/petroleum/supply/weekly/schedule.php
// The rule has no expiry. Only publisher departures from it are listed here, keyed
// by the NEW observation's week-ending date, with the ET offset in the value.
export const EIA_RELEASE_OVERRIDES: Readonly<Record<string, string>> = {
  '2024-12-27': '2025-01-02T11:00:00-05:00',
  '2025-12-19': '2025-12-29T17:00:00-05:00',
};

function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  const first = new Date(utc(year, month, 1)).getUTCDay();
  return utc(year, month, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
}

function lastMonday(year: number, month: number): number {
  const last = utc(year, month + 1, 0);
  return last - ((new Date(last).getUTCDay() + 6) % 7) * DAY;
}

// A Saturday holiday is observed Friday and a Sunday holiday Monday.
function observed(time: number): number {
  const day = new Date(time).getUTCDay();
  return day === 6 ? time - DAY : day === 0 ? time + DAY : time;
}

export function usFederalHolidays(year: number): ReadonlySet<number> {
  return new Set([
    observed(utc(year, 1, 1)), observed(utc(year + 1, 1, 1)), observed(utc(year, 6, 19)),
    observed(utc(year, 7, 4)), observed(utc(year, 11, 11)), observed(utc(year, 12, 25)),
    nthWeekday(year, 1, 1, 3), nthWeekday(year, 2, 1, 3), lastMonday(year, 5),
    nthWeekday(year, 9, 1, 1), nthWeekday(year, 10, 1, 2), nthWeekday(year, 11, 4, 4),
  ]);
}

const easternClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hourCycle: 'h23',
});

// Convert an Eastern wall-clock time on a UTC calendar day to an instant, across DST.
export function easternWallTime(day: number, minutes: number): number {
  const candidate = day + minutes * 60_000;
  const parts = Object.fromEntries(easternClock.formatToParts(candidate).map(part => [part.type, part.value]));
  return candidate + (minutes - (Number(parts.hour) * 60 + Number(parts.minute))) * 60_000;
}

// First EIA release for a week ending on or after `weekEnding` (UTC midnight).
export function eiaReleaseFor(weekEnding: number): number {
  const override = EIA_RELEASE_OVERRIDES[new Date(weekEnding).toISOString().slice(0, 10)];
  if (override) return Date.parse(override);
  const wednesday = weekEnding + ((3 - new Date(weekEnding).getUTCDay() + 7) % 7) * DAY;
  const holidays = usFederalHolidays(new Date(wednesday).getUTCFullYear());
  const shifted = [0, 1, 2].some(back => holidays.has(wednesday - back * DAY));
  return shifted ? easternWallTime(wednesday + DAY, 12 * 60) : easternWallTime(wednesday, 10 * 60 + 30);
}

// CME Globex NYMEX energy, 2026–2027. Values are minutes after midnight EASTERN,
// not CME's Central time. Zero means no session, including the preceding evening.
// https://www.cmegroup.com/trading-hours.html (Energy, not equity or TAS hours).
// Unlisted dates use regular hours; exceptional closures require a table update.
export const CME_ENERGY_CLOSES: Readonly<Record<string, number>> = {
  '2026-01-01': 0,
  '2026-01-19': 14 * 60 + 30,
  '2026-02-16': 14 * 60 + 30,
  '2026-04-03': 0,
  '2026-05-25': 14 * 60 + 30,
  '2026-06-19': 13 * 60,
  '2026-07-03': 13 * 60,
  '2026-09-07': 14 * 60 + 30,
  '2026-11-26': 14 * 60 + 30,
  '2026-11-27': 14 * 60 + 45,
  '2026-12-24': 13 * 60 + 45,
  '2026-12-25': 0,
  '2027-01-01': 0,
  '2027-01-18': 14 * 60 + 30,
  '2027-02-15': 14 * 60 + 30,
  '2027-03-26': 0,
  '2027-05-31': 14 * 60 + 30,
  '2027-06-18': 13 * 60,
  '2027-07-05': 14 * 60 + 30,
  '2027-09-06': 14 * 60 + 30,
  '2027-11-25': 14 * 60 + 30,
  '2027-11-26': 14 * 60 + 45,
  '2027-12-24': 0,
};

// Only the CME table is hand-maintained. Derive its horizon from the rows so adding a
// year cannot leave a separate expiry constant behind. Date-only entries use midnight
// UTC conservatively.
export function oilCalendarHorizons(now = Date.now()): Record<string, {
  lastDate: string; daysLeft: number; status: 'ok' | 'expiring' | 'expired';
}> {
  if (!Number.isFinite(now)) throw new Error('Invalid oil calendar check time');
  const end = Math.max(...Object.keys(CME_ENERGY_CLOSES).map(Date.parse));
  if (!Number.isFinite(end)) throw new Error('Missing cme oil calendar horizon');
  return {
    cme: {
      lastDate: new Date(end).toISOString(), daysLeft: Math.floor((end - now) / DAY),
      status: now > end ? 'expired' : end - now <= 45 * DAY ? 'expiring' : 'ok',
    },
  };
}
