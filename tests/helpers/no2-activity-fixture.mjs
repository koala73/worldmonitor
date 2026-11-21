import {
  NO2_ACTIVITY_METHOD,
  NO2_ACTIVITY_METHOD_VERSION,
  NO2_REGIONS,
  signalFor,
} from '../../scripts/shared/no2-activity.mjs';

const DAY_MS = 86_400_000;

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function window(windowEnd, meanNo2MolM2, validDays = 40) {
  const endMs = Date.parse(`${windowEnd}T00:00:00Z`);
  return {
    windowStart: isoDate(endMs - (NO2_ACTIVITY_METHOD.windowDays - 1) * DAY_MS),
    windowEnd,
    validDays,
    maskedDays: 0,
    meanNo2MolM2,
    meanValidFraction: validDays === 0 ? null : 0.55,
  };
}

function shiftYear(date, years) {
  return `${Number(date.slice(0, 4)) - years}${date.slice(4)}`;
}

/**
 * A dataset the seeder would publish for every registered region. `changes`
 * maps region id to its year-over-year percent change; every other region
 * gets `defaultChange`. A null change excludes the region as
 * `insufficient_valid_days`; the string 'pending' excludes it as
 * `baseline_backfill_pending`.
 */
export function no2ActivityDataset({
  generatedAt = '2026-10-26T06:10:00.000Z',
  windowEnd = '2026-10-23',
  changes = {},
  defaultChange = 2,
} = {}) {
  const method = NO2_ACTIVITY_METHOD;
  const year = Number(windowEnd.slice(0, 4));
  const baselineMean = 1.1e-4;
  const regions = {};
  for (const definition of NO2_REGIONS) {
    const change = Object.hasOwn(changes, definition.id) ? changes[definition.id] : defaultChange;
    const pending = change === 'pending';
    const years = pending ? [] : Array.from({ length: method.baselineYears }, (_, index) => ({
      year: year - index - 1,
      ...window(shiftYear(windowEnd, index + 1), baselineMean),
    }));
    const eligible = typeof change === 'number';
    regions[definition.id] = {
      id: definition.id,
      kind: definition.kind,
      label: definition.label,
      countryCode: definition.countryCode,
      bbox: [...definition.bbox],
      resolutionDegrees: definition.resolutionDegrees,
      current: eligible ? window(windowEnd, baselineMean * (1 + change / 100)) : window(windowEnd, null, 0),
      baseline: { years, meanNo2MolM2: pending ? null : baselineMean },
      series: {
        refreshedAt: pending ? null : generatedAt,
        days: pending ? 60 : 1460,
        firstDate: pending ? shiftYear(windowEnd, 0).replace(/-\d\d-\d\d$/, '-08-29') : shiftYear(windowEnd, 4),
        lastDate: windowEnd,
        backfilledYears: pending ? [] : [year - 3, year - 2, year - 1, year],
      },
      changePercent: eligible ? change : null,
      ...(eligible ? signalFor(change, method) : { signalValue: null, direction: null }),
      exclusion: eligible ? null : pending ? 'baseline_backfill_pending' : 'insufficient_valid_days',
    };
  }
  return {
    methodVersion: NO2_ACTIVITY_METHOD_VERSION,
    generatedAt,
    method: JSON.parse(JSON.stringify(method)),
    source: {
      publisherId: 'publisher:copernicus-sentinel-5p',
      dataset: 'sentinel-5p-l2',
      band: 'NO2',
      unit: 'mol/m2',
      attribution: 'Contains modified Copernicus Sentinel data 2023-2026',
      requestCount: 289,
      processingUnitsSpent: 148.2,
    },
    regions,
  };
}
