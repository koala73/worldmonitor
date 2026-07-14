// Stable operator contract for China-specific coverage. Later China tickets may
// change their domain implementations, but they extend this manifest only after
// the serialized shared-registry frontier reaches them (issue #5271).

import { CHINA_NEWS_SOURCE_NAMES } from './_china-news-coverage.mjs';

export const CHINA_COVERAGE_SUMMARY_KEY = 'health:china-coverage:v1';
export const CHINA_COVERAGE_SEED_META_KEY = 'seed-meta:health:china-coverage';
export const CHINA_COVERAGE_ACTIVATION_KEY = 'seed-activated:health:china-coverage';

export const CHINA_COVERAGE_STATUS = Object.freeze(['healthy', 'degraded', 'unavailable', 'planned', 'blocked']);
export const CHINA_COVERAGE_TRANSPORT_STATUS = Object.freeze(['fresh', 'stale', 'missing', 'error', 'not_applicable']);
export const CHINA_COVERAGE_CONTENT_STATUS = Object.freeze(['fresh', 'stale', 'missing', 'empty', 'partial', 'timestamp_missing', 'not_applicable']);
export const CHINA_COVERAGE_LAUNCH_STATUS = Object.freeze(['launched', 'planned', 'blocked']);

export const CHINA_COVERAGE_REASON_CODES = Object.freeze({
  TRANSPORT_MISSING: 'TRANSPORT_MISSING',
  TRANSPORT_STALE: 'TRANSPORT_STALE',
  TRANSPORT_ERROR: 'TRANSPORT_ERROR',
  CHINA_ROW_MISSING: 'CHINA_ROW_MISSING',
  CHINA_ROW_EMPTY: 'CHINA_ROW_EMPTY',
  CHINA_COVERAGE_PARTIAL: 'CHINA_COVERAGE_PARTIAL',
  CHINA_UPSTREAM_ROW_UNAVAILABLE: 'CHINA_UPSTREAM_ROW_UNAVAILABLE',
  CHINA_COVERAGE_PROJECTION_UNAVAILABLE: 'CHINA_COVERAGE_PROJECTION_UNAVAILABLE',
  CONTENT_TIMESTAMP_MISSING: 'CONTENT_TIMESTAMP_MISSING',
  CONTENT_STALE: 'CONTENT_STALE',
  NOT_LAUNCHED: 'NOT_LAUNCHED',
});

const metaTransport = (key, maxAgeMin) => ({
  key,
  maxAgeMin,
  timestampPaths: [['fetchedAt']],
});

export const CHINA_COVERAGE_ENTRIES = Object.freeze([
  {
    id: 'economic.bis-policy',
    label: 'BIS policy rate',
    ownerIssue: 5271,
    launchStatus: 'launched',
    transport: metaTransport('seed-meta:economic:bis', 10_080),
    content: {
      key: 'economic:bis:policy:v1',
      maxAgeMin: 180 * 1_440,
      probe: { kind: 'array-match', path: ['rates'], field: 'countryCode', values: ['CN'], timestampPaths: [['date']] },
    },
  },
  {
    id: 'economic.imf-macro',
    label: 'IMF macro snapshot',
    ownerIssue: 5271,
    launchStatus: 'launched',
    transport: metaTransport('seed-meta:economic:imf-macro', 100_800),
    content: {
      key: 'economic:imf:macro:v2',
      maxAgeMin: 800 * 1_440,
      // IMF WEO years are forecast horizons, not observation dates. The
      // seeder maps 2026 forecasts to the end of 2025 for content freshness.
      probe: {
        kind: 'object-property',
        path: ['countries', 'CN'],
        timestampPaths: [['latestYear'], ['year']],
        timestampSemantics: 'imf-weo-forecast-year',
      },
    },
  },
  {
    id: 'energy.jodi-oil',
    label: 'JODI oil',
    ownerIssue: 5271,
    // JODI remains a global source, but its current published country index
    // has no substantive CN row. Do not advertise China coverage until that
    // upstream contract recovers.
    launchStatus: 'blocked',
    blockedReason: CHINA_COVERAGE_REASON_CODES.CHINA_UPSTREAM_ROW_UNAVAILABLE,
    transport: metaTransport('seed-meta:energy:jodi-oil', 57_600),
    content: {
      key: 'energy:jodi-oil:v1:CN',
      maxAgeMin: 60 * 1_440,
      probe: { kind: 'object', timestampPaths: [['dataMonth']] },
    },
  },
  {
    id: 'energy.jodi-gas',
    label: 'JODI gas',
    ownerIssue: 5271,
    launchStatus: 'blocked',
    blockedReason: CHINA_COVERAGE_REASON_CODES.CHINA_UPSTREAM_ROW_UNAVAILABLE,
    transport: metaTransport('seed-meta:energy:jodi-gas', 57_600),
    content: {
      key: 'energy:jodi-gas:v1:CN',
      maxAgeMin: 60 * 1_440,
      probe: { kind: 'object', timestampPaths: [['dataMonth']] },
    },
  },
  {
    id: 'energy.spine',
    label: 'China energy spine',
    ownerIssue: 5271,
    launchStatus: 'launched',
    transport: metaTransport('seed-meta:energy:spine', 2_880),
    content: {
      key: 'energy:spine:v1:CN',
      maxAgeMin: 400 * 1_440,
      probe: { kind: 'object', timestampPaths: [['sources', '*']] },
    },
  },
  {
    id: 'trade.comtrade-reporter-156',
    label: 'UN Comtrade reporter 156',
    ownerIssue: 5271,
    launchStatus: 'launched',
    transport: metaTransport('seed-meta:trade:comtrade-flows', 2_880),
    content: {
      key: 'comtrade:flows:v1',
      maxAgeMin: 1_200 * 1_440,
      probe: { kind: 'array-match', path: ['flows'], field: 'reporterCode', values: ['156'], timestampPaths: [['year']] },
    },
  },
  {
    id: 'supply-chain.ccfi',
    label: 'China Containerized Freight Index',
    ownerIssue: 5271,
    launchStatus: 'launched',
    transport: metaTransport('seed-meta:supply_chain:shipping', 420),
    content: {
      key: 'supply_chain:shipping:v2',
      maxAgeMin: 28 * 1_440,
      probe: { kind: 'array-match', path: ['indices'], field: 'indexId', values: ['CCFI'], timestampPaths: [['history', '*', 'date'], ['fetchedAt']] },
    },
  },
  {
    id: 'market.china-index',
    label: 'China country market index',
    ownerIssue: 5271,
    launchStatus: 'launched',
    // The country-index RPC cache is a user-facing read-through cache. Railway
    // seeds the same CN Yahoo source through the market bundle, so its seed
    // metadata is the transport proof; the CN cache below proves the actual
    // country-index payload remains available without waiting for a user read.
    transport: metaTransport('seed-meta:market:stocks', 1_440),
    content: {
      key: 'market:stock-index:v1:CN',
      maxAgeMin: 7 * 1_440,
      probe: { kind: 'object', requiredTruthyPaths: [['available']], timestampPaths: [['fetchedAt']] },
    },
  },
  {
    id: 'news.china',
    label: 'China news digest',
    ownerIssue: 5272,
    launchStatus: 'launched',
    transport: metaTransport('seed-meta:news:insights', 30),
    content: {
      // The canonical digest remains globally ranked. The insights seeder
      // writes this source-status projection before ranking, so a China feed
      // that is merely outranked cannot look like a China coverage outage.
      key: 'news:insights:v1:CN',
      maxAgeMin: 7 * 1_440,
      probe: {
        kind: 'array-coverage',
        path: ['sources'],
        field: 'source',
        values: CHINA_NEWS_SOURCE_NAMES,
        validField: 'status',
        validValues: ['available'],
        timestampPaths: [['observedAt']],
      },
    },
  },
  {
    id: 'aviation.china-hubs',
    label: 'China aviation hubs',
    ownerIssue: 5273,
    // Per-hub coverage comes from the canonical provider payload. Do not use
    // bootstrap alerts here: they include presentation-only NORMAL/UNKNOWN rows.
    launchStatus: 'launched',
    transport: metaTransport('seed-meta:aviation:intl', 90),
    content: {
      key: 'aviation:delays-bootstrap:v2',
      maxAgeMin: 120,
      probe: {
        kind: 'array-coverage',
        path: ['coverage'],
        field: 'iata',
        values: ['PEK', 'PVG', 'CAN', 'SZX', 'CTU', 'KMG', 'URC', 'HKG'],
        validField: 'status',
        validValues: ['normal', 'disruption'],
        timestampPaths: [['updatedAt']],
      },
    },
  },
  {
    id: 'macro.china-snapshot',
    label: 'Normalized China macro snapshot',
    ownerIssue: 5275,
    launchStatus: 'launched',
    transport: metaTransport('seed-meta:economic:china-macro', 4_320),
    content: {
      key: 'economic:china:macro:v1',
      maxAgeMin: 120 * 1_440,
      // contentObservationDate is the OLDEST required launch indicator, so a
      // fresh FX tick cannot mask stale price/activity content.
      probe: { kind: 'object', timestampPaths: [['contentObservationDate']] },
    },
  },
  {
    id: 'macro.china-release-calendar',
    label: 'China release calendar',
    ownerIssue: 5275,
    launchStatus: 'launched',
    transport: metaTransport('seed-meta:economic:china-release-calendar', 4_320),
    content: {
      key: 'economic:china:release-calendar:v1',
      maxAgeMin: 45 * 1_440,
      probe: { kind: 'object', requiredTruthyPaths: [['countryCode'], ['events']], timestampPaths: [['generatedAt']] },
    },
  },
  {
    id: 'hazards.western-pacific-cyclones',
    label: 'Western Pacific cyclone identity',
    ownerIssue: 5276,
    launchStatus: 'launched',
    transport: metaTransport('seed-meta:natural:western-pacific-cyclones', 540),
    content: {
      key: 'natural:western-pacific-cyclones:v1',
      maxAgeMin: 540,
      probe: { kind: 'object', timestampPaths: [['evaluatedAt'], ['latestObservationAt']] },
    },
  },
  {
    id: 'hazards.hko-warnings',
    label: 'Hong Kong Observatory warnings',
    ownerIssue: 5276,
    launchStatus: 'launched',
    transport: metaTransport('seed-meta:weather:hko-warnings', 540),
    content: {
      key: 'weather:hko-warnings:v1',
      maxAgeMin: 540,
      probe: { kind: 'object', timestampPaths: [['evaluatedAt'], ['latestObservationAt']] },
    },
  },
]);

export function chinaCoverageRedisKeys(entries = CHINA_COVERAGE_ENTRIES) {
  const data = new Set();
  const meta = new Set();
  for (const entry of entries) {
    if (entry.launchStatus !== 'launched') continue;
    if (entry.content?.key) data.add(entry.content.key);
    if (entry.transport?.key) {
      if (entry.transport.key.startsWith('seed-meta:')) meta.add(entry.transport.key);
      else data.add(entry.transport.key);
    }
  }
  return { data: [...data].sort(), meta: [...meta].sort() };
}
