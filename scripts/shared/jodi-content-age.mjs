export const MAX_JODI_CONTENT_AGE_MONTHS = 6;

function readPath(value, path) {
  return path.split('.').reduce((current, part) => {
    if (current == null || typeof current !== 'object') return undefined;
    return current[part];
  }, value);
}

/**
 * Return true when at least one public-profile measurement is present.
 * Zero is a valid observation; null, undefined, and non-finite values are not.
 */
export function hasFiniteMeasurementAtPaths(value, paths) {
  return paths.some((path) => {
    const measurement = readPath(value, path);
    return typeof measurement === 'number' && Number.isFinite(measurement);
  });
}

function parseMonthIndex(dataMonth) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(dataMonth ?? '');
  if (!match) return null;
  return Number(match[1]) * 12 + Number(match[2]) - 1;
}

/**
 * Validate China presence, source month, and usable measurements independently
 * of the seeder fetch timestamp. Zero is a valid measurement.
 */
export function assessChinaJodiCoverage(records, now, hasMeasurements) {
  const china = Array.isArray(records) ? records.find((record) => record?.iso2 === 'CN') : null;
  if (!china) {
    return { ok: false, reason: 'china-missing', dataMonth: null, ageMonths: null };
  }

  const sourceMonth = parseMonthIndex(china.dataMonth);
  const currentMonth = now instanceof Date && Number.isFinite(now.getTime())
    ? now.getUTCFullYear() * 12 + now.getUTCMonth()
    : null;
  if (sourceMonth == null || currentMonth == null || sourceMonth > currentMonth) {
    return { ok: false, reason: 'china-invalid-month', dataMonth: china.dataMonth ?? null, ageMonths: null };
  }

  const ageMonths = currentMonth - sourceMonth;
  if (ageMonths > MAX_JODI_CONTENT_AGE_MONTHS) {
    return { ok: false, reason: 'china-stale', dataMonth: china.dataMonth, ageMonths };
  }
  if (!hasMeasurements(china)) {
    return { ok: false, reason: 'china-no-measurements', dataMonth: china.dataMonth, ageMonths };
  }

  return { ok: true, reason: null, dataMonth: china.dataMonth, ageMonths };
}
