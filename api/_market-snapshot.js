import { unwrapEnvelope } from './_seed-envelope.js';

export const MARKET_SNAPSHOT_VERSION = '1.0';

export const DATASETS = [
  { id: 'commodities', key: 'market:commodities-bootstrap:v1', domain: 'commodities', source: 'market quote providers', cadenceMin: 15, staleAfterMin: 30 },
  { id: 'crypto', key: 'market:crypto:v1', domain: 'crypto', source: 'CoinGecko', cadenceMin: 5, staleAfterMin: 30 },
  { id: 'positioning247', key: 'market:hyperliquid:flow:v1', domain: 'positioning', source: 'Hyperliquid', cadenceMin: 5, staleAfterMin: 30 },
  { id: 'cotPositioning', key: 'market:cot:v1', domain: 'positioning', source: 'CFTC', cadenceMin: 10080, staleAfterMin: 20160 },
  { id: 'goldExtended', key: 'market:gold-extended:v1', domain: 'gold', source: 'market quote providers', cadenceMin: 15, staleAfterMin: 30 },
  { id: 'goldEtfFlows', key: 'market:gold-etf-flows:v1', domain: 'gold', source: 'SPDR', cadenceMin: 1440, staleAfterMin: 2880 },
  { id: 'goldCentralBankReserves', key: 'market:gold-cb-reserves:v1', domain: 'gold', source: 'IMF IFS', cadenceMin: 44640, staleAfterMin: 89280 },
  { id: 'ecbFx', key: 'economic:ecb-fx-rates:v1', domain: 'fx', source: 'ECB', cadenceMin: 1440, staleAfterMin: 4320 },
  { id: 'euYieldCurve', key: 'economic:yield-curve-eu:v1', domain: 'macroRates', source: 'ECB', cadenceMin: 1440, staleAfterMin: 4320 },
  { id: 'fedFunds', key: 'economic:fred:v1:FEDFUNDS:0', domain: 'macroRates', source: 'FRED', cadenceMin: 1440, staleAfterMin: 4320 },
  { id: 'us2y', key: 'economic:fred:v1:DGS2:0', domain: 'macroRates', source: 'FRED', cadenceMin: 1440, staleAfterMin: 4320 },
  { id: 'us10y', key: 'economic:fred:v1:DGS10:0', domain: 'macroRates', source: 'FRED', cadenceMin: 1440, staleAfterMin: 4320 },
  { id: 'us30y', key: 'economic:fred:v1:DGS30:0', domain: 'macroRates', source: 'FRED', cadenceMin: 1440, staleAfterMin: 4320 },
];

function finiteTimestamp(value) {
  const n = typeof value === 'string' ? Date.parse(value) : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function newestTimestamp(values) {
  let newest = null;
  for (const value of values) {
    const timestamp = finiteTimestamp(value);
    if (timestamp != null && (newest == null || timestamp > newest)) newest = timestamp;
  }
  return newest;
}

function fredObservationTimestamp(data) {
  const observations = data?.series?.observations ?? data?.observations;
  return Array.isArray(observations)
    ? newestTimestamp(observations.map((observation) => observation?.date))
    : null;
}

function observationTimestamp(definition, data, seed, fetchedAtMs) {
  // Content-age envelopes own the observation clock. An explicit null or
  // invalid newestItemAt means the producer could not prove freshness; do not
  // relabel that content with a payload or fetch timestamp.
  if (seed && Object.prototype.hasOwnProperty.call(seed, 'newestItemAt')) {
    return finiteTimestamp(seed.newestItemAt);
  }

  switch (definition.id) {
    case 'cotPositioning':
      return finiteTimestamp(data?.reportDate)
        ?? newestTimestamp((data?.instruments ?? []).map((instrument) => instrument?.reportDate));
    case 'goldEtfFlows':
      return finiteTimestamp(data?.asOfDate);
    case 'goldCentralBankReserves':
      return finiteTimestamp(data?.asOfMonth);
    case 'ecbFx':
      return newestTimestamp(Object.values(data?.rates ?? {}).map((rate) => rate?.date))
        ?? finiteTimestamp(data?.updatedAt);
    case 'euYieldCurve':
      return finiteTimestamp(data?.date);
    case 'fedFunds':
    case 'us2y':
    case 'us10y':
    case 'us30y':
      return fredObservationTimestamp(data);
    case 'positioning247':
      return finiteTimestamp(data?.ts ?? data?.fetchedAt);
    case 'goldExtended':
      return finiteTimestamp(data?.updatedAt);
    default:
      break;
  }

  const explicitObservation = finiteTimestamp(
    data?.observedAt
      ?? data?.reportDate
      ?? data?.asOfDate
      ?? data?.asOfMonth
      ?? data?.date
      ?? data?.timestamp
      ?? data?.ts
      ?? data?.fetchedAt,
  ) ?? fredObservationTimestamp(data);
  // Near-live quote payloads do not currently retain an upstream quote clock.
  // Their successful fetch is the narrowest truthful observation proxy; unlike
  // periodic datasets above, it cannot relabel an old report/month as current.
  return explicitObservation ?? fetchedAtMs;
}

function ageMinutes(generatedAtMs, timestamp) {
  return timestamp == null ? null : Math.floor((generatedAtMs - timestamp) / 60000);
}

function emptyDataset(definition, status, quality) {
  return {
    ...definition,
    status,
    data: null,
    fetchedAt: null,
    observedAt: null,
    fetchAgeMin: null,
    observationAgeMin: null,
    ageMin: null,
    maxContentAgeMin: null,
    staleMemberCount: 0,
    quality,
  };
}

export function normalizeDataset(definition, entry, generatedAtMs) {
  if (!entry || typeof entry !== 'object' || Object.prototype.hasOwnProperty.call(entry, 'error')) {
    return emptyDataset(definition, 'error', ['redis_read_error']);
  }
  if (!Object.prototype.hasOwnProperty.call(entry, 'result') || entry.result == null) {
    return emptyDataset(definition, 'missing', ['missing']);
  }
  try {
    const parsed = typeof entry.result === 'string' ? JSON.parse(entry.result) : entry.result;
    const { data, _seed } = unwrapEnvelope(parsed);
    if (data == null) throw new Error('empty envelope');
    const fetchedAtMs = finiteTimestamp(_seed?.fetchedAt ?? data?.fetchedAt ?? data?.updatedAt ?? data?.timestamp ?? data?.ts);
    const observedAtMs = observationTimestamp(definition, data, _seed, fetchedAtMs);
    const fetchAgeMin = ageMinutes(generatedAtMs, fetchedAtMs);
    const observationAgeMin = ageMinutes(generatedAtMs, observedAtMs);
    const configuredContentAgeLimit = Number(_seed?.maxContentAgeMin);
    const contentAgeLimit = Number.isFinite(configuredContentAgeLimit)
      && configuredContentAgeLimit > 0
      ? configuredContentAgeLimit
      : definition.staleAfterMin;
    const transportFuture = fetchAgeMin != null && fetchAgeMin < 0;
    const contentFuture = observationAgeMin != null && observationAgeMin < 0;
    const transportStale = fetchAgeMin != null
      && (transportFuture || fetchAgeMin > definition.staleAfterMin);
    const contentStale = observationAgeMin != null
      && (contentFuture || observationAgeMin > contentAgeLimit);
    const staleMemberCount = Array.isArray(data?.assets)
      ? data.assets.filter((asset) => asset?.stale === true).length
      : 0;
    const clocksMissing = fetchAgeMin == null || observationAgeMin == null;
    let status = 'fresh';
    if (transportStale || contentStale || staleMemberCount > 0) status = 'stale';
    else if (clocksMissing) status = 'unknown';
    // schemaVersion 1.0 defined ageMin as the fetch-first clock. Keep that
    // public field compatible while the named clocks and status use the stricter
    // two-clock freshness contract. Legacy ageMin also clamped future values.
    const legacyAgeMin = fetchAgeMin ?? observationAgeMin;
    const ageMin = legacyAgeMin == null ? null : Math.max(0, legacyAgeMin);
    const quality = [];
    if (transportStale) quality.push('transport_stale');
    if (contentStale) quality.push('content_stale');
    if (transportFuture) quality.push('fetch_timestamp_future');
    if (contentFuture) quality.push('observation_timestamp_future');
    if (transportFuture || contentFuture) quality.push('future_timestamp');
    if (staleMemberCount > 0) quality.push('stale_members');
    if (status === 'stale') quality.push('stale');
    if (fetchAgeMin == null) quality.push('fetch_timestamp_missing');
    if (observationAgeMin == null) quality.push('observation_timestamp_missing');
    if (clocksMissing) quality.push('timestamp_missing');
    if (data?.warmup === true) quality.push('warmup');
    if (data?.unavailable === true) quality.push('upstream_unavailable');
    return {
      ...definition,
      status,
      data,
      fetchedAt: fetchedAtMs == null ? null : new Date(fetchedAtMs).toISOString(),
      observedAt: observedAtMs == null ? null : new Date(observedAtMs).toISOString(),
      fetchAgeMin,
      observationAgeMin,
      ageMin,
      maxContentAgeMin: contentAgeLimit,
      staleMemberCount,
      quality,
    };
  } catch {
    return emptyDataset(definition, 'error', ['invalid_json_or_envelope']);
  }
}

export function buildMarketSnapshot(entries, now = Date.now()) {
  const datasets = DATASETS.map((definition, index) => normalizeDataset(definition, entries?.[index], now));
  const byDomain = {};
  for (const dataset of datasets) (byDomain[dataset.domain] ??= []).push(dataset);
  return {
    schemaVersion: MARKET_SNAPSHOT_VERSION,
    generatedAt: new Date(now).toISOString(),
    purpose: 'current_market_assessment',
    caveat: 'Point-in-time evidence export. Not a prediction, predictive score, or validated trading signal.',
    summary: {
      total: datasets.length,
      fresh: datasets.filter((x) => x.status === 'fresh').length,
      stale: datasets.filter((x) => x.status === 'stale').length,
      missing: datasets.filter((x) => x.status === 'missing').length,
      error: datasets.filter((x) => x.status === 'error').length,
      unknown: datasets.filter((x) => x.status === 'unknown').length,
    },
    domains: byDomain,
  };
}

export function marketSnapshotToMarkdown(snapshot) {
  const lines = [
    '# World Monitor Market Snapshot',
    '',
    `Generated: ${snapshot.generatedAt}`,
    '',
    `> ${snapshot.caveat}`,
    '',
    `Fresh ${snapshot.summary.fresh}/${snapshot.summary.total}; stale ${snapshot.summary.stale}; missing ${snapshot.summary.missing}; errors ${snapshot.summary.error}.`,
  ];
  for (const [domain, datasets] of Object.entries(snapshot.domains)) {
    lines.push('', `## ${domain}`);
    for (const item of datasets) {
      lines.push('', `### ${item.id}`, '', `- Status: ${item.status}`, `- Source: ${item.source}`, `- Age: ${item.ageMin == null ? 'unknown' : `${item.ageMin} minutes`}`, `- Fetched at: ${item.fetchedAt ?? 'missing'}`, `- Fetch age: ${item.fetchAgeMin == null ? 'unknown' : `${item.fetchAgeMin} minutes`}`, `- Observed at: ${item.observedAt ?? 'missing'}`, `- Observation age: ${item.observationAgeMin == null ? 'unknown' : `${item.observationAgeMin} minutes`}`, `- Content-age budget: ${item.maxContentAgeMin == null ? 'unknown' : `${item.maxContentAgeMin} minutes`}`, `- Stale members: ${item.staleMemberCount}`, `- Quality: ${item.quality.length ? item.quality.join(', ') : 'ok'}`, '', '```json', JSON.stringify(item.data, null, 2), '```');
    }
  }
  return `${lines.join('\n')}\n`;
}
