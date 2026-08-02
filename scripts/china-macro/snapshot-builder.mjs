import {
  CHINA_MACRO_REQUIRED_SERIES,
  CHINA_MACRO_SCHEMA_VERSION,
  CHINA_MACRO_SERIES_IDS,
} from '../_china-macro-contract.mjs';

const PILLARS = [
  'activity',
  'investment_property',
  'credit_liquidity',
  'external_pressure',
  'trade',
];

export function buildChinaMacroPillars(observations) {
  return PILLARS.map((pillar) => {
    const candidates = observations.filter((observation) => observation.pillar === pillar);
    const comparable = candidates.filter((observation) => (
      Number.isFinite(observation.value)
      && !observation.stale
      && observation.direction !== 'unavailable'
    ));
    const comparisonFrames = new Set(comparable.map((observation) => (
      `${observation.observationPeriod}|${observation.periodKind}|${observation.comparisonBasis}`
    )));
    const directions = [...new Set(comparable.map((observation) => observation.direction))];
    const comparableFrame = comparisonFrames.size <= 1;
    return {
      pillar,
      direction: comparableFrame && directions.length === 1 ? directions[0] : 'unavailable',
      reason: !comparableFrame
        ? 'INCOMPARABLE_PERIOD_OR_BASIS'
        : directions.length === 0
        ? 'NO_AVAILABLE_OFFICIAL_OBSERVATION'
        : directions.length === 1
          ? 'CONSISTENT_AVAILABLE_OBSERVATIONS'
          : 'MIXED_OFFICIAL_SIGNALS',
      observationIds: candidates.map((observation) => observation.seriesId),
    };
  });
}

export function buildChinaMacroSnapshot({
  observations,
  sourceDecisions,
  generatedAt = new Date().toISOString(),
  transportLastSuccessAt,
}) {
  const seriesOrder = new Map(CHINA_MACRO_SERIES_IDS.map((seriesId, index) => [seriesId, index]));
  observations = [...observations].sort((left, right) => (
    (seriesOrder.get(left.seriesId) ?? Number.MAX_SAFE_INTEGER)
    - (seriesOrder.get(right.seriesId) ?? Number.MAX_SAFE_INTEGER)
  ));
  const launchReady = CHINA_MACRO_REQUIRED_SERIES.every((seriesId) => {
    const observation = observations.find((item) => item.seriesId === seriesId);
    return observation
      && Number.isFinite(observation.value)
      && !observation.stale
      && !observation.unavailableReason
      && observation.provenance
      && typeof observation.provenance === 'object'
      && !Array.isArray(observation.provenance);
  });
  const requiredDates = CHINA_MACRO_REQUIRED_SERIES
    .map((seriesId) => observations.find((item) => item.seriesId === seriesId)?.observationPeriod)
    .filter(Boolean)
    .sort();
  const hasUnavailable = observations.some((observation) => !Number.isFinite(observation.value));
  const requiredTransportTimes = CHINA_MACRO_REQUIRED_SERIES
    .map((seriesId) => {
      const observation = observations.find((item) => item.seriesId === seriesId);
      return observation?.provenance
        ?.claims?.transport_freshness?.value?.lastSuccessAt
        || observation?.retrievalTime;
    })
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort();
  return {
    schemaVersion: CHINA_MACRO_SCHEMA_VERSION,
    countryCode: 'CN',
    generatedAt,
    transportLastSuccessAt: transportLastSuccessAt || requiredTransportTimes[0] || '',
    status: launchReady
      ? (hasUnavailable ? 'degraded' : 'ready')
      : (observations.some((observation) => Number.isFinite(observation.value)) ? 'degraded' : 'unavailable'),
    launchReady,
    contentObservationDate: launchReady && requiredDates.length === CHINA_MACRO_REQUIRED_SERIES.length
      ? requiredDates[0]
      : '',
    latestObservationDate: requiredDates.at(-1) || '',
    observations,
    pillars: buildChinaMacroPillars(observations),
    sourceDecisions,
  };
}
