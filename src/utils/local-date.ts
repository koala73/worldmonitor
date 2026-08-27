/**
 * Local-time `YYYY-MM-DD` calendar-day key.
 *
 * `date.toISOString().slice(0, 10)` is UTC-based: for a user at UTC-10 at
 * 20:00 local it yields *tomorrow*, and for UTC+13 it yields a stale day.
 * Anywhere a UTC slice fed a fetch window whose events are rendered in the
 * user's locale, the window silently dropped or padded local days. Use this
 * helper so day-key boundaries match what the user sees.
 */
export function localYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addLocalDays(date: Date, days: number): Date {
  const shifted = new Date(date);
  shifted.setDate(shifted.getDate() + days);
  return shifted;
}
