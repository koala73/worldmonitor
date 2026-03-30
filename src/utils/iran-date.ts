/**
 * Iran-specific date utilities: Jalali (Shamsi) calendar and Tehran timezone.
 * Only active on gantor.ir deployments; no-op elsewhere.
 */

// @ts-expect-error jalaali-js has no type declarations
import jalaali from 'jalaali-js';

const JALALI_MONTHS = [
  'Farvardin', 'Ordibehesht', 'Khordad',
  'Tir', 'Mordad', 'Shahrivar',
  'Mehr', 'Aban', 'Azar',
  'Dey', 'Bahman', 'Esfand',
];

let _isGantor: boolean | null = null;

/** True when running on a gantor.ir hostname. Result is cached. */
export function isGantorDeploy(): boolean {
  if (_isGantor !== null) return _isGantor;
  try {
    _isGantor = location.hostname.endsWith('gantor.ir');
  } catch {
    _isGantor = false;
  }
  return _isGantor;
}

interface JalaliResult { jy: number; jm: number; jd: number }

/** Convert a JS Date to Jalali year/month/day. */
export function toJalali(date: Date): JalaliResult {
  return jalaali.toJalaali(date) as JalaliResult;
}

/** Format a Date as a compact Jalali string: "1404/12/25". */
export function formatJalaliDate(date: Date): string {
  const { jy, jm, jd } = toJalali(date);
  return `${jy}/${String(jm).padStart(2, '0')}/${String(jd).padStart(2, '0')}`;
}

/** Format a Date as Jalali with month name: "25 Esfand 1404". */
export function formatJalaliDateLong(date: Date): string {
  const { jy, jm, jd } = toJalali(date);
  return `${jd} ${JALALI_MONTHS[jm - 1]} ${jy}`;
}

const tehranFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Tehran',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Format a Date as Tehran local time: "14:30 IRST". */
export function formatTehranTime(date: Date): string {
  return `${tehranFmt.format(date)} IRST`;
}

/**
 * For Gantor deploys, append a compact Jalali date + Tehran time
 * to the given relative time string (only for items older than 1 hour).
 *
 * Input:  relativeStr = "3 hours ago", date = some Date
 * Output: "3 hours ago · 1404/12/25 14:30 IRST"
 *
 * For non-Gantor deploys or recent items (< 1h), returns the original string.
 */
export function enhanceWithIranTime(relativeStr: string, date: Date): string {
  if (!isGantorDeploy()) return relativeStr;

  const diffMs = Date.now() - date.getTime();
  // Only add absolute Jalali+Tehran for items older than 1 hour
  if (diffMs < 3600_000) return relativeStr;

  return `${relativeStr} · ${formatJalaliDate(date)} ${formatTehranTime(date)}`;
}
