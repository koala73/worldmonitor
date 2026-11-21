/** Live sources are polled on a minutes-scale cadence. A retained seed never extends this clock. */
export const GRID_CLOCK_MAX_AGE_MS = 60 * 60 * 1000;

export const GRID_CLOCK_REGIONS = {
  CA: { name: 'California', fips: '06', slug: 'california' },
  TN: { name: 'Tennessee', fips: '47', slug: 'tennessee' },
  TX: { name: 'Texas', fips: '48', slug: 'texas' },
  FL: { name: 'Florida', fips: '12', slug: 'florida' },
  NY: { name: 'New York', fips: '36', slug: 'new-york' },
  WA: { name: 'Washington', fips: '53', slug: 'washington' },
};

const isText = value => typeof value === 'string' && value.trim().length > 0;
const isTime = value => Number.isSafeInteger(value) && value > 0 && value <= 8.64e15;
const isCount = value => value === null || (Number.isSafeInteger(value) && value >= 0);
const isKind = value => ['grid', 'weather', 'space-weather'].includes(value);
const isFresh = (time, now) => isTime(time) && time <= now && now - time <= GRID_CLOCK_MAX_AGE_MS;

function hasPublisher(value) {
  if (!value || !isText(value.sourceName) || !isText(value.sourceUrl)) return false;
  try {
    const url = new URL(value.sourceUrl);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isPoint(value) {
  return hasPublisher(value) && isTime(value.observedAt)
    && isCount(value.customersOut) && isCount(value.customersTracked)
    && (value.customersTracked === null || value.customersOut === null || value.customersOut <= value.customersTracked)
    && isText(value.coverageKey) && isText(value.coverageLabel)
    && (value.partial === undefined || typeof value.partial === 'boolean')
    && (value.detail === undefined || isText(value.detail))
    && (value.impact === undefined || ['disrupted', 'recovering', 'restored'].includes(value.impact))
    && (value.peakLoadRestoredPct === undefined
      || (Number.isFinite(value.peakLoadRestoredPct) && value.peakLoadRestoredPct >= 0 && value.peakLoadRestoredPct <= 100));
}

function isWarning(value) {
  return hasPublisher(value) && isText(value.title) && isKind(value.kind)
    && isTime(value.issuedAt) && isTime(value.expiresAt) && value.expiresAt > value.issuedAt;
}

function isWarningSource(value) {
  if (!hasPublisher(value) || !isKind(value.kind)) return false;
  if (value.status === 'available') return isTime(value.checkedAt);
  return ['unavailable', 'not_monitored'].includes(value.status) && value.checkedAt === null;
}

/** The wire carries explicit nulls so an omitted or malformed observation cannot become zero. */
export function isGridClockSnapshot(value) {
  if (!Array.isArray(value?.regions)) return false;
  // Accept the original snapshot while the worker and browser roll out separately.
  // Remove the two-state form when the v1 cache is retired.
  const expectedCodes = value.regions.length === 2 ? ['CA', 'TN'] : Object.keys(GRID_CLOCK_REGIONS);
  if (value.regions.length !== expectedCodes.length) return false;
  const codes = new Set();
  for (const region of value.regions) {
    if (!region || !expectedCodes.includes(region.code) || codes.has(region.code)) return false;
    if (region.current !== null && !isPoint(region.current)) return false;
    if (!Array.isArray(region.history) || !region.history.every(isPoint)) return false;
    if (region.lastImpactGapAt != null && !isTime(region.lastImpactGapAt)) return false;
    if (!Array.isArray(region.warnings) || !region.warnings.every(isWarning)) return false;
    if (region.recentWarnings !== undefined && !(Array.isArray(region.recentWarnings) && region.recentWarnings.every(isWarning))) return false;
    if (!Array.isArray(region.warningSources) || !region.warningSources.every(isWarningSource)) return false;
    if (region.warningsCheckedAt !== null && !isTime(region.warningsCheckedAt)) return false;
    codes.add(region.code);
  }
  return true;
}

function previousObservation(history, current, lastGap) {
  // Compare only the immediately preceding report. A coverage change or an explicit
  // unknown in between two numeric readings breaks the series.
  let previous = null;
  for (const point of history) {
    if (point.observedAt < current.observedAt && (!previous || point.observedAt > previous.observedAt)) {
      previous = point;
    }
  }
  if (!previous || previous.partial || current.partial || (lastGap != null && lastGap >= previous.observedAt)
      || current.observedAt - previous.observedAt > GRID_CLOCK_MAX_AGE_MS
      || previous.customersOut === null || previous.coverageKey !== current.coverageKey
      || previous.sourceName !== current.sourceName || previous.customersTracked !== current.customersTracked) return null;
  return previous;
}

function impactPhase(current) {
  if (!current) return null;
  if (current.impact) return current.impact;
  if (current.peakLoadRestoredPct > 0 && current.peakLoadRestoredPct < 100) return 'recovering';
  if (current.customersOut > 0) return 'disrupted';
  return null;
}

export function deriveGridClock(region, now = Date.now()) {
  const { current, history, warnings, warningSources } = region;
  const observed = current && current.observedAt <= now ? current : null;
  const freshness = !observed ? 'unavailable' : isFresh(observed.observedAt, now) ? 'fresh' : 'stale';
  const monitored = warningSources.filter(source => source.status !== 'not_monitored');
  const verified = monitored.filter(source => source.status === 'available' && isFresh(source.checkedAt, now));
  const warningsFresh = isFresh(region.warningsCheckedAt, now) && verified.length > 0 && verified.length === monitored.length;
  const activeWarnings = warnings.filter(warning => warning.issuedAt <= now && now < warning.expiresAt
    && verified.some(source => source.kind === warning.kind && source.sourceName === warning.sourceName
      && source.checkedAt >= warning.issuedAt));
  const fresh = freshness === 'fresh' ? observed : null;
  const previous = fresh && fresh.customersOut !== null ? previousObservation(history, fresh, region.lastImpactGapAt) : null;
  let phase = impactPhase(fresh);
  if (!phase) {
    if (activeWarnings.length) phase = 'watch';
    else if (fresh?.customersOut === 0 && !fresh.partial && warningsFresh) phase = 'monitoring';
    else phase = 'unknown';
  }
  return {
    phase, freshness, warningsFresh, activeWarnings,
    changeCustomers: previous ? fresh.customersOut - previous.customersOut : null,
    comparisonAt: previous?.observedAt ?? null,
  };
}
