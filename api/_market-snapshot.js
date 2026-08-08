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

function observationTimestamp(data) {
  const direct = finiteTimestamp(data?.fetchedAt ?? data?.updatedAt ?? data?.timestamp ?? data?.ts);
  if (direct) return direct;
  const observations = data?.series?.observations;
  const date = Array.isArray(observations) ? observations.at(-1)?.date : data?.date;
  return finiteTimestamp(date);
}

export function normalizeDataset(definition, entry, generatedAtMs) {
  if (!entry || typeof entry !== 'object' || Object.prototype.hasOwnProperty.call(entry, 'error')) {
    return { ...definition, status: 'error', data: null, fetchedAt: null, observedAt: null, ageMin: null, quality: ['redis_read_error'] };
  }
  if (!Object.prototype.hasOwnProperty.call(entry, 'result') || entry.result == null) {
    return { ...definition, status: 'missing', data: null, fetchedAt: null, observedAt: null, ageMin: null, quality: ['missing'] };
  }
  try {
    const parsed = typeof entry.result === 'string' ? JSON.parse(entry.result) : entry.result;
    const { data, _seed } = unwrapEnvelope(parsed);
    if (data == null) throw new Error('empty envelope');
    const fetchedAtMs = finiteTimestamp(_seed?.fetchedAt ?? data?.fetchedAt ?? data?.updatedAt ?? data?.timestamp ?? data?.ts);
    const observedAtMs = observationTimestamp(data);
    const freshnessTs = fetchedAtMs ?? observedAtMs;
    const ageMin = freshnessTs == null ? null : Math.max(0, Math.floor((generatedAtMs - freshnessTs) / 60000));
    const status = ageMin == null ? 'unknown' : ageMin > definition.staleAfterMin ? 'stale' : 'fresh';
    const quality = [];
    if (status === 'stale') quality.push('stale');
    if (ageMin == null) quality.push('timestamp_missing');
    if (data?.warmup === true) quality.push('warmup');
    if (data?.unavailable === true) quality.push('upstream_unavailable');
    return {
      ...definition,
      status,
      data,
      fetchedAt: fetchedAtMs == null ? null : new Date(fetchedAtMs).toISOString(),
      observedAt: observedAtMs == null ? null : new Date(observedAtMs).toISOString(),
      ageMin,
      quality,
    };
  } catch {
    return { ...definition, status: 'error', data: null, fetchedAt: null, observedAt: null, ageMin: null, quality: ['invalid_json_or_envelope'] };
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
      lines.push('', `### ${item.id}`, '', `- Status: ${item.status}`, `- Source: ${item.source}`, `- Fetched at: ${item.fetchedAt ?? 'missing'}`, `- Observed at: ${item.observedAt ?? 'missing'}`, `- Age: ${item.ageMin == null ? 'unknown' : `${item.ageMin} minutes`}`, `- Quality: ${item.quality.length ? item.quality.join(', ') : 'ok'}`, '', '```json', JSON.stringify(item.data, null, 2), '```');
    }
  }
  return `${lines.join('\n')}\n`;
}
