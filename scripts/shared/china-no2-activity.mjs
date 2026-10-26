// The reviewed Sentinel-5P NO2 activity contract shared by the Railway seeder
// (scripts/seed-china-no2-activity.mjs) and the China activity nowcast reader
// (server/worldmonitor/economic/v1/get-china-activity-nowcast.ts). Keeping the
// region registry, the method constants, and the payload validator in one
// module means the reader cannot drift from the producer: a payload is an
// activity observation only when it carries exactly this method.

export const CHINA_NO2_ACTIVITY_KEY = 'economic:china:no2-activity:v1';
export const CHINA_NO2_ACTIVITY_SEED_META_KEY = 'seed-meta:economic:china-no2-activity';
export const CHINA_NO2_ACTIVITY_ACTIVATION_KEY = 'seed-activated:economic:china-no2-activity';
export const CHINA_NO2_ACTIVITY_METHOD_VERSION = 'china-no2-activity/v1';
export const CHINA_NO2_ACTIVITY_SOURCE_VERSION = 'cdse-sentinel-hub-statistics-s5p-no2-v1';
export const CHINA_NO2_ATTRIBUTION_PREFIX = 'Contains modified Copernicus Sentinel data';

/**
 * Measured on 2026-10-26 against the CDSE Statistical API (owner probe):
 * - `minQa` omitted returns the same valid counts as `minQa: 75`, so the
 *   documented NO2 default holds; it is set explicitly anyway.
 * - NRTI granules are not retained for prior years (0 days returned for the
 *   2024 and 2025 windows) while OFFL is, so every window uses OFFL and the
 *   current window ends `windowEndLagDays` before the run (OFFL latency
 *   measured at 2 days).
 * - Year-over-year noise between two years with equal annual means:
 *   56-day windows, daily valid fraction >= 0.2, mean of daily means, Lunar New
 *   Year windows masked: |change| median 5-9%, sd 7-9% per region. The dead
 *   band sits above the single-region p75 so one cloudy region cannot fake a
 *   move; the composite median over regions and the three-year baseline
 *   lower it further.
 */
export const CHINA_NO2_ACTIVITY_METHOD = Object.freeze({
  windowDays: 56,
  windowEndLagDays: 3,
  minValidFraction: 0.2,
  minValidDays: 14,
  baselineYears: 3,
  minBaselineYears: 2,
  minRegions: 2,
  deadBandPercent: 10,
  timeliness: 'OFFL',
  minQa: 75,
  resolutionDegrees: 0.05,
  holidayMask: Object.freeze({ daysBefore: 7, daysAfter: 14 }),
});

/**
 * Industrial clusters whose tropospheric NO2 column tracks heavy industry and
 * power demand. Rectangles over administrative clusters: Jing-Jin-Ji and
 * Shandong overlap over Jinan-Zibo, which the equal-weight composite median
 * cannot double count. Four regions keep the daily budget at 16 Statistical
 * API requests (about 18 processing units) against the 30,000/month quotas.
 */
export const CHINA_NO2_REGIONS = Object.freeze([
  Object.freeze({
    id: 'jing-jin-ji',
    label: 'Jing-Jin-Ji (Beijing, Tianjin, Hebei)',
    bbox: Object.freeze([114, 36, 119, 41]),
  }),
  Object.freeze({
    id: 'yangtze-river-delta',
    label: 'Yangtze River Delta (Shanghai, southern Jiangsu, northern Zhejiang)',
    bbox: Object.freeze([118.5, 30, 122, 32.5]),
  }),
  Object.freeze({
    id: 'pearl-river-delta',
    label: 'Pearl River Delta (Guangdong manufacturing belt)',
    bbox: Object.freeze([112.5, 21.5, 115, 24]),
  }),
  Object.freeze({
    id: 'shandong',
    label: 'Shandong (Jinan, Zibo, Weifang, Qingdao)',
    bbox: Object.freeze([116.5, 34.5, 122.5, 38]),
  }),
]);

/** Chinese New Year (first day of the lunar year), UTC calendar dates. */
export const LUNAR_NEW_YEAR_DATES = Object.freeze({
  2018: '2018-02-16',
  2019: '2019-02-05',
  2020: '2020-01-25',
  2021: '2021-02-12',
  2022: '2022-02-01',
  2023: '2023-01-22',
  2024: '2024-02-10',
  2025: '2025-01-29',
  2026: '2026-02-17',
  2027: '2027-02-06',
  2028: '2028-01-26',
  2029: '2029-02-13',
  2030: '2030-02-03',
});

export const CHINA_NO2_REGION_EXCLUSIONS = Object.freeze([
  'request_failed',
  'insufficient_valid_days',
  'insufficient_baseline_years',
]);

export const CHINA_NO2_COMPOSITE_EXCLUSIONS = Object.freeze([
  'insufficient_regions',
]);

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MS_PER_DAY = 86_400_000;

function dateMs(isoDate) {
  if (!ISO_DATE.test(isoDate)) return Number.NaN;
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  // Date.parse normalizes an impossible day such as 02-30 into March; only a
  // date that round-trips is a calendar date.
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === isoDate ? ms : Number.NaN;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * True when the UTC calendar date falls inside the holiday mask around that
 * year's Lunar New Year. Days inside the mask are dropped from every window,
 * current and baseline, so a holiday that moves between years cannot read as
 * an activity change. Years outside the table are never masked.
 */
export function isLunarNewYearHoliday(isoDate, method = CHINA_NO2_ACTIVITY_METHOD) {
  const ms = dateMs(isoDate);
  if (!Number.isFinite(ms)) return false;
  const year = Number(isoDate.slice(0, 4));
  const newYear = LUNAR_NEW_YEAR_DATES[year];
  if (!newYear) return false;
  const newYearMs = dateMs(newYear);
  return ms >= newYearMs - method.holidayMask.daysBefore * MS_PER_DAY
    && ms <= newYearMs + method.holidayMask.daysAfter * MS_PER_DAY;
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isCount = (value) => Number.isInteger(value) && value >= 0;
const isIsoDate = (value) => typeof value === 'string' && Number.isFinite(dateMs(value));
const isInstant = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));

function isWindow(value) {
  return isRecord(value)
    && isIsoDate(value.windowStart)
    && isIsoDate(value.windowEnd)
    && dateMs(value.windowStart) <= dateMs(value.windowEnd)
    && isCount(value.validDays)
    && isCount(value.maskedDays)
    && (value.meanNo2MolM2 === null || (isFiniteNumber(value.meanNo2MolM2) && value.meanNo2MolM2 >= 0))
    && (value.meanValidFraction === null
      || (isFiniteNumber(value.meanValidFraction) && value.meanValidFraction >= 0 && value.meanValidFraction <= 1))
    && (value.validDays === 0) === (value.meanNo2MolM2 === null);
}

function isBaselineYear(value) {
  return isWindow(value) && Number.isInteger(value.year) && value.year >= 2018;
}

function isRegion(value, definition) {
  if (!isRecord(value) || value.id !== definition.id || value.label !== definition.label) return false;
  if (!Array.isArray(value.bbox) || value.bbox.length !== 4
    || value.bbox.some((edge, index) => edge !== definition.bbox[index])) return false;
  if (!isWindow(value.current)) return false;
  if (!isRecord(value.baseline) || !Array.isArray(value.baseline.years)
    || !value.baseline.years.every(isBaselineYear)
    || !(value.baseline.meanNo2MolM2 === null
      || (isFiniteNumber(value.baseline.meanNo2MolM2) && value.baseline.meanNo2MolM2 > 0))) return false;
  if (value.exclusion === null) {
    return isFiniteNumber(value.changePercent);
  }
  return CHINA_NO2_REGION_EXCLUSIONS.includes(value.exclusion) && value.changePercent === null;
}

function isComposite(value, regions, method) {
  if (!isRecord(value) || !Array.isArray(value.regionIds)) return false;
  const eligible = regions.filter((region) => region.exclusion === null);
  if (value.regionIds.length !== eligible.length
    || value.regionIds.some((id, index) => id !== eligible[index].id)) return false;
  if (value.exclusion === null) {
    return isFiniteNumber(value.changePercent)
      && isFiniteNumber(value.signalValue)
      && value.regionIds.length >= method.minRegions
      && value.changePercent === median(eligible.map((region) => region.changePercent))
      && (Math.abs(value.changePercent) < method.deadBandPercent
        ? value.signalValue === 0
        : value.signalValue === value.changePercent);
  }
  return CHINA_NO2_COMPOSITE_EXCLUSIONS.includes(value.exclusion)
    && value.changePercent === null
    && value.signalValue === null
    && value.regionIds.length < method.minRegions;
}

function sameMethod(value, method) {
  return isRecord(value)
    && isRecord(value.holidayMask)
    && Object.keys(method).every((key) => (key === 'holidayMask'
      ? value.holidayMask.daysBefore === method.holidayMask.daysBefore
        && value.holidayMask.daysAfter === method.holidayMask.daysAfter
      : value[key] === method[key]))
    && Object.keys(value).length === Object.keys(method).length;
}

function isSource(value) {
  return isRecord(value)
    && value.publisherId === 'publisher:copernicus-sentinel-5p'
    && value.dataset === 'sentinel-5p-l2'
    && value.band === 'NO2'
    && value.unit === 'mol/m2'
    && typeof value.attribution === 'string'
    && value.attribution.startsWith(CHINA_NO2_ATTRIBUTION_PREFIX)
    && isCount(value.requestCount)
    && isFiniteNumber(value.processingUnitsSpent)
    && value.processingUnitsSpent >= 0;
}

/**
 * The published payload is an activity observation only when it carries the
 * reviewed method verbatim, every registered region in registry order, and a
 * composite that agrees with its regions. Anything else reads as unusable:
 * the seeder refuses to publish it and the nowcast refuses to consume it.
 */
export function validateChinaNo2ActivityPayload(value, method = CHINA_NO2_ACTIVITY_METHOD) {
  if (!isRecord(value)) return false;
  if (value.methodVersion !== CHINA_NO2_ACTIVITY_METHOD_VERSION) return false;
  if (!isInstant(value.generatedAt)) return false;
  if (!sameMethod(value.method, method)) return false;
  if (!isSource(value.source)) return false;
  if (!Array.isArray(value.regions) || value.regions.length !== CHINA_NO2_REGIONS.length) return false;
  if (!value.regions.every((region, index) => isRegion(region, CHINA_NO2_REGIONS[index]))) return false;
  if (!isComposite(value.composite, value.regions, method)) return false;
  const generatedAtMs = Date.parse(value.generatedAt);
  return value.regions.every((region) => dateMs(region.current.windowEnd) + MS_PER_DAY <= generatedAtMs);
}
