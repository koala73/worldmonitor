import {
  CHINA_NO2_ACTIVITY_METHOD,
  CHINA_NO2_ACTIVITY_METHOD_VERSION,
  CHINA_NO2_REGIONS,
} from '../../scripts/shared/china-no2-activity.mjs';

const DAY_MS = 86_400_000;

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function window(windowEnd, meanNo2MolM2, validDays = 40) {
  const endMs = Date.parse(`${windowEnd}T00:00:00Z`);
  return {
    windowStart: isoDate(endMs - (CHINA_NO2_ACTIVITY_METHOD.windowDays - 1) * DAY_MS),
    windowEnd,
    validDays,
    maskedDays: 0,
    meanNo2MolM2,
    meanValidFraction: validDays === 0 ? null : 0.55,
  };
}

function shiftYear(windowEnd, years) {
  return `${Number(windowEnd.slice(0, 4)) - years}${windowEnd.slice(4)}`;
}

/**
 * A payload the seeder would publish for the registered regions. Every region
 * shares `windowEnd`; `changes` maps region id to its year-over-year percent
 * change (null excludes that region as `insufficient_valid_days`).
 */
export function chinaNo2ActivityPayload({
  generatedAt = '2026-10-26T06:10:00.000Z',
  windowEnd = '2026-10-23',
  changes = {
    'jing-jin-ji': 14.2,
    'yangtze-river-delta': 12.8,
    'pearl-river-delta': 9.1,
    shandong: 16.5,
  },
} = {}) {
  const method = CHINA_NO2_ACTIVITY_METHOD;
  const regions = CHINA_NO2_REGIONS.map((definition) => {
    const change = changes[definition.id] ?? null;
    const baselineMean = 1.1e-4;
    const years = Array.from({ length: method.baselineYears }, (_, index) => ({
      year: Number(windowEnd.slice(0, 4)) - index - 1,
      ...window(shiftYear(windowEnd, index + 1), baselineMean),
    }));
    return {
      id: definition.id,
      label: definition.label,
      bbox: [...definition.bbox],
      current: change === null
        ? window(windowEnd, null, 0)
        : window(windowEnd, baselineMean * (1 + change / 100)),
      baseline: { years, meanNo2MolM2: baselineMean },
      changePercent: change,
      exclusion: change === null ? 'insufficient_valid_days' : null,
    };
  });
  const eligible = regions.filter((region) => region.exclusion === null);
  const sorted = eligible.map((region) => region.changePercent).sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length === 0
    ? null
    : sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  const composite = eligible.length < method.minRegions
    ? { changePercent: null, signalValue: null, regionIds: eligible.map((region) => region.id), exclusion: 'insufficient_regions' }
    : {
      changePercent: median,
      signalValue: Math.abs(median) < method.deadBandPercent ? 0 : median,
      regionIds: eligible.map((region) => region.id),
      exclusion: null,
    };
  return {
    methodVersion: CHINA_NO2_ACTIVITY_METHOD_VERSION,
    generatedAt,
    method: { ...method, holidayMask: { ...method.holidayMask } },
    source: {
      publisherId: 'publisher:copernicus-sentinel-5p',
      dataset: 'sentinel-5p-l2',
      band: 'NO2',
      unit: 'mol/m2',
      attribution: 'Contains modified Copernicus Sentinel data 2023-2026',
      requestCount: 16,
      processingUnitsSpent: 17.9,
    },
    regions,
    composite,
  };
}
