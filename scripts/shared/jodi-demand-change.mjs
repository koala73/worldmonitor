/**
 * Period arithmetic and the published basis for the JODI oil demand change.
 *
 * Kept side-effect free so the spine seeder can pin the basis without importing
 * a seeder module (whose top-level env loading would run on import).
 */

// Monthly oil-product demand is strongly seasonal, so only a same-month
// year-over-year comparison is published as an activity-bearing change.
export const DEMAND_CHANGE_BASIS = 'year_over_year';

// The downstream nowcast consumes this as a percentage, while the component
// totals remain explicitly labelled in kbd for auditability.
export const DEMAND_CHANGE_UNIT = '% change';

export const DEMAND_CHANGE_LOOKBACK_MONTHS = 12;

// A national direction needs a real basket rather than one surviving product,
// and the bounded product catalogue currently has five secondary products.
export const MIN_DEMAND_CHANGE_PRODUCTS = 3;
export const MAX_DEMAND_CHANGE_PRODUCTS = 5;
export const MAX_DEMAND_CHANGE_PERCENT = 50;

/** Canonical parse of a JODI `YYYY-MM` observation period into a month ordinal. */
export function monthIndex(month) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month ?? '');
  return match ? Number(match[1]) * 12 + Number(match[2]) - 1 : null;
}

// `Date.UTC` silently remaps years 0-99 into the 1900s, so any month that is
// turned back into a calendar instant must first be proven to be in range.
const MIN_DATABLE_INDEX = 1900 * 12;
const MAX_DATABLE_INDEX = 2200 * 12 + 11;

function datableMonthIndex(month) {
  const index = monthIndex(month);
  return index !== null && index >= MIN_DATABLE_INDEX && index <= MAX_DATABLE_INDEX
    ? index
    : null;
}

export function shiftMonth(month, delta) {
  const index = datableMonthIndex(month);
  if (index === null) return null;
  const shifted = index + delta;
  if (shifted < MIN_DATABLE_INDEX || shifted > MAX_DATABLE_INDEX) return null;
  const year = Math.floor(shifted / 12);
  return `${year}-${String(shifted - year * 12 + 1).padStart(2, '0')}`;
}

/** Last instant of a `YYYY-MM` observation period, in UTC. */
export function monthPeriodEnd(month) {
  const index = datableMonthIndex(month);
  if (index === null) return null;
  const year = Math.floor(index / 12);
  // Date.UTC months are 0-based, so the 1-based month number is the next month.
  return new Date(Date.UTC(year, index - year * 12 + 1, 1) - 1).toISOString();
}
