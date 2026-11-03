const SOURCES = ['SDN', 'CONSOLIDATED', 'sema-ca'];
const SOURCE_VERSION = 'ofac-sls-advanced-xml+sema-ca-json-v4';
const POPULATION = 'top-12-first-iso2-display-v1';
export const MAX_COUNTRY_SANCTIONS_BYTES = 4096;
const DATE_MAX = 8640000000000000;
const RETAIN_MS = 48 * 3600000;
const MAX_STALE_MS = 720 * 60000;
const count = value => Number.isSafeInteger(value) && value >= 0;
const clock = value => Number.isSafeInteger(value) && value > 0 && value <= DATE_MAX;
const epoch = value => typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) && clock(Number(value));
const vintage = value => value === '0' || epoch(value);
const keys = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const byteLength = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export function projectCountrySanctions(snapshot, countryCode, readAt = Date.now()) {
  if (typeof countryCode !== 'string' || !/^[A-Z]{2}$/.test(countryCode) || countryCode === 'XX') {
    throw new TypeError('A normalized country ISO2 code is required');
  }
  const unavailable = reason => ({
    countryCode, state: 'unavailable', partial: true,
    sanctionsDesignations: null, sanctionsNewDesignations: null, reason,
  });
  const bounded = value => byteLength(value) <= MAX_COUNTRY_SANCTIONS_BYTES
    ? value : unavailable('Country sanctions envelope too large');
  if (!snapshot || !epoch(snapshot.fetchedAt) || !vintage(snapshot.datasetDate)
    || Number(snapshot.datasetDate) > Number(snapshot.fetchedAt)
    || !Array.isArray(snapshot.countries) || snapshot.countries.length > 12
    || !count(snapshot.totalCount) || !count(snapshot.newEntryCount)
    || snapshot.newEntryCount > snapshot.totalCount) return unavailable('Invalid producer snapshot');

  const metadata = snapshot._state;
  if (!keys(metadata, ['schemaVersion', 'sourceVersion', 'population', 'cohort', 'comparison', 'sourceHealth'])
    || metadata.schemaVersion !== 1 || metadata.sourceVersion !== SOURCE_VERSION || metadata.population !== POPULATION
    || !keys(metadata.cohort, ['computationAt', 'datasetDate', 'totalCount', 'newEntryCount'])
    || metadata.cohort.computationAt !== snapshot.fetchedAt || metadata.cohort.datasetDate !== snapshot.datasetDate
    || metadata.cohort.totalCount !== snapshot.totalCount || metadata.cohort.newEntryCount !== snapshot.newEntryCount
    || !keys(metadata.comparison, ['kind', 'from', 'to']) || metadata.comparison.to !== snapshot.fetchedAt
    || !keys(metadata.sourceHealth, SOURCES)) return unavailable('Invalid canonical metadata');
  const comparison = metadata.comparison;
  const at = Number(snapshot.fetchedAt);
  const knownWindow = comparison.kind === 'id-set-difference';
  if (knownWindow ? !epoch(comparison.from) || Number(comparison.from) >= at
    : !['window-unavailable', 'baseline-unavailable'].includes(comparison.kind) || comparison.from !== null) {
    return unavailable('Invalid comparison descriptor');
  }

  const sourceHealth = {};
  for (const sourceName of SOURCES) {
    const health = metadata.sourceHealth[sourceName];
    if (!keys(health, ['status', 'lastAttemptAt', 'lastSuccessAt', 'retainedUntil', 'publishedAt',
      'recordCount', 'errorCode', 'quarantinedCount'])
      || !['ok', 'retained', 'unavailable'].includes(health.status)
      || health.lastAttemptAt !== at || !count(health.recordCount)
      || !(health.quarantinedCount === null || count(health.quarantinedCount))
      || health.errorCode !== (health.status === 'ok' ? null
        : sourceName === 'sema-ca' ? 'SEMA_INGEST_FAILED' : 'OFAC_INGEST_FAILED')) {
      return unavailable('Missing source evidence');
    }
    if (health.status === 'unavailable') {
      if (health.lastSuccessAt !== null || health.retainedUntil !== null
        || health.publishedAt !== null || health.recordCount !== 0
        || health.quarantinedCount !== null) return unavailable('Invalid unavailable source');
    } else if (!clock(health.lastSuccessAt) || health.lastSuccessAt > at
      || !clock(health.retainedUntil) || health.retainedUntil !== health.lastSuccessAt + RETAIN_MS
      || at >= health.retainedUntil || !count(health.publishedAt) || health.publishedAt > health.lastSuccessAt
      || health.recordCount === 0 || (health.status === 'ok'
        && (health.lastSuccessAt !== at || !count(health.quarantinedCount)))) {
      return unavailable('Invalid original source clocks');
    }
    sourceHealth[sourceName] = { ...health };
  }
  const publishedAt = Math.max(0, ...SOURCES.map(name => sourceHealth[name].publishedAt ?? 0));
  const sourcePopulation = SOURCES.reduce((total, name) =>
    total + Math.min(sourceHealth[name].recordCount, Number.MAX_SAFE_INTEGER - total), 0);
  if (Number(snapshot.datasetDate) !== publishedAt || snapshot.totalCount > sourcePopulation) {
    return unavailable('Contradictory source cohort');
  }
  if (byteLength(metadata) > 4096) return unavailable('Canonical metadata too large');
  const source = {
    cacheKey: 'sanctions:pressure:v1', schemaVersion: metadata.schemaVersion, sourceVersion: metadata.sourceVersion,
    attribution: 'OFAC SDN and consolidated lists; Global Affairs Canada SEMA.',
    scope: 'Producer top-12 country-pressure display rows; first ISO2 match. Omitted country is display zero, not list-wide absence.',
    computationAt: snapshot.fetchedAt, datasetDate: snapshot.datasetDate, sourceHealth,
  };
  if (!clock(readAt) || readAt < at) return bounded({ ...unavailable('Invalid read clock'), source });
  if (readAt - at > MAX_STALE_MS) return bounded({ ...unavailable('Canonical sanctions snapshot is stale'), source });
  if (SOURCES.some(name => sourceHealth[name].status !== 'unavailable'
    && readAt >= sourceHealth[name].retainedUntil)) {
    return bounded({ ...unavailable('Original source retention expired'), source });
  }
  if (SOURCES.every(name => sourceHealth[name].status === 'unavailable')) {
    return bounded({ ...unavailable('All sources unavailable'), source });
  }
  if (snapshot.totalCount === 0) return bounded({ ...unavailable('Empty producer sentinel'), source });
  for (const row of snapshot.countries) {
    if (!row || typeof row.countryCode !== 'string' || !/^[a-zA-Z]{2}$/.test(row.countryCode)
      || typeof row.countryName !== 'string' || !row.countryName || row.countryName.length > 200
      || !['entryCount', 'newEntryCount', 'vesselCount', 'aircraftCount'].every(field => count(row[field]))
      || row.entryCount > snapshot.totalCount || row.newEntryCount > row.entryCount
      || row.newEntryCount > snapshot.newEntryCount || row.vesselCount > row.entryCount
      || row.aircraftCount > row.entryCount) return unavailable('Invalid country-pressure row');
  }
  const row = snapshot.countries.find(item => item.countryCode.toUpperCase() === countryCode);
  const partial = SOURCES.some(name => sourceHealth[name].status !== 'ok'
    || sourceHealth[name].quarantinedCount !== 0);
  return bounded({
    countryCode, state: 'observed', partial,
    sanctionsDesignations: row?.entryCount ?? 0,
    sanctionsNewDesignations: knownWindow ? row?.newEntryCount ?? 0 : null,
    websiteCounts: {
      scope: POPULATION, partial,
      sanctionsDesignations: row?.entryCount ?? 0,
      sanctionsNewDesignations: knownWindow ? row?.newEntryCount ?? 0 : null,
    },
    countryRow: row ? {
      countryCode: row.countryCode, countryName: row.countryName, entryCount: row.entryCount,
      newEntryCount: row.newEntryCount, vesselCount: row.vesselCount, aircraftCount: row.aircraftCount,
    } : null,
    comparison: {
      ...comparison,
      rule: 'Current merged entry ID absent from previous producer state; effectiveAt is not a cutoff.',
    },
    source,
  });
}
