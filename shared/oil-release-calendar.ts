// EIA rechecked 2026-11-11: all 14 published rows match; last release 2026-11-12.
// CME reviewed 2026-11-10. Update when publishers revise their schedules.
// EIA: https://www.eia.gov/petroleum/supply/weekly/schedule.php
// Keys are the NEW observation's week-ending date; values include the ET offset.
export const EIA_RELEASE_SHIFTS: Readonly<Record<string, string>> = {
  '2024-12-27': '2025-01-02T11:00:00-05:00',
  '2025-01-17': '2025-01-23T12:00:00-05:00',
  '2025-02-14': '2025-02-20T12:00:00-05:00',
  '2025-05-23': '2025-05-29T12:00:00-04:00',
  '2025-08-29': '2025-09-04T12:00:00-04:00',
  '2025-10-10': '2025-10-16T12:00:00-04:00',
  '2025-11-07': '2025-11-13T12:00:00-05:00',
  '2025-12-19': '2025-12-29T17:00:00-05:00',
  '2026-01-16': '2026-01-22T12:00:00-05:00',
  '2026-02-13': '2026-02-19T12:00:00-05:00',
  '2026-05-22': '2026-05-28T12:00:00-04:00',
  '2026-09-04': '2026-09-10T12:00:00-04:00',
  '2026-10-09': '2026-10-15T12:00:00-04:00',
  '2026-11-06': '2026-11-12T12:00:00-05:00',
};

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

// Derive horizons from the actual rows, so adding a year cannot leave a separate
// expiry constant behind. CME date-only entries use midnight UTC conservatively.
export function oilCalendarHorizons(now = Date.now()): Record<string, {
  lastDate: string; daysLeft: number; status: 'ok' | 'expiring' | 'expired';
}> {
  if (!Number.isFinite(now)) throw new Error('Invalid oil calendar check time');
  const ends = {
    eia: Math.max(...Object.values(EIA_RELEASE_SHIFTS).map(Date.parse)),
    cme: Math.max(...Object.keys(CME_ENERGY_CLOSES).map(Date.parse)),
  };
  return Object.fromEntries(Object.entries(ends).map(([name, end]) => {
    if (!Number.isFinite(end)) throw new Error(`Missing ${name} oil calendar horizon`);
    const daysLeft = Math.floor((end - now) / 86_400_000);
    return [name, {
      lastDate: new Date(end).toISOString(), daysLeft,
      status: now > end ? 'expired' : end - now <= 45 * 86_400_000 ? 'expiring' : 'ok',
    }];
  }));
}
