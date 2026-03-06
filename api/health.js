export const config = { runtime: 'edge' };

const BOOTSTRAP_KEYS = {
  earthquakes:       'seismology:earthquakes:v1',
  outages:           'infra:outages:v1',
  sectors:           'market:sectors:v1',
  etfFlows:          'market:etf-flows:v1',
  climateAnomalies:  'climate:anomalies:v1',
  wildfires:         'wildfire:fires:v1',
  marketQuotes:      'market:stocks-bootstrap:v1',
  commodityQuotes:   'market:commodities-bootstrap:v1',
  cyberThreats:      'cyber:threats-bootstrap:v2',
  techReadiness:     'economic:worldbank-techreadiness:v1',
  positiveGeoEvents: 'positive-events:geo-bootstrap:v1',
  riskScores:        'risk:scores:sebuf:stale:v1',
  naturalEvents:     'natural:events:v1',
  flightDelays:      'aviation:delays-bootstrap:v1',
  insights:          'news:insights:v1',
  predictions:       'prediction:markets-bootstrap:v1',
  cryptoQuotes:      'market:crypto:v1',
  gulfQuotes:        'market:gulf-quotes:v1',
  stablecoinMarkets: 'market:stablecoins:v1',
  unrestEvents:      'unrest:events:v1',
  iranEvents:        'conflict:iran-events:v1',
  ucdpEvents:        'conflict:ucdp-events:v1',
};

const STANDALONE_KEYS = {
  serviceStatuses:       'infra:service-statuses:v1',
  macroSignals:          'economic:macro-signals:v1',
  bisPolicy:             'economic:bis:policy:v1',
  bisExchange:           'economic:bis:eer:v1',
  bisCredit:             'economic:bis:credit:v1',
  shippingRates:         'supply_chain:shipping:v2',
  chokepoints:           'supply_chain:chokepoints:v2',
  minerals:              'supply_chain:minerals:v2',
  giving:                'giving:summary:v1',
  gpsjam:                'intelligence:gpsjam:v1',
  theaterPosture:        'theater-posture:sebuf:stale:v1',
  theaterPostureLive:    'theater-posture:sebuf:v1',
  theaterPostureBackup:  'theater-posture:sebuf:backup:v1',
  riskScoresLive:        'risk:scores:sebuf:v1',
  usniFleet:             'usni-fleet:sebuf:v1',
  usniFleetStale:        'usni-fleet:sebuf:stale:v1',
  faaDelays:             'aviation:delays:faa:v1',
  intlDelays:            'aviation:delays:intl:v3',
  notamClosures:         'aviation:notam:closures:v1',
  positiveEventsLive:    'positive-events:geo:v1',
  cableHealth:           'cable-health-v1',
};

const SEED_META = {
  earthquakes:      { key: 'seed-meta:seismology:earthquakes',  maxStaleMin: 30 },
  wildfires:        { key: 'seed-meta:wildfire:fires',          maxStaleMin: 120 },
  outages:          { key: 'seed-meta:infra:outages',           maxStaleMin: 30 },
  climateAnomalies: { key: 'seed-meta:climate:anomalies',       maxStaleMin: 120 },
  unrestEvents:     { key: 'seed-meta:unrest:events',           maxStaleMin: 30 },
  cyberThreats:     { key: 'seed-meta:cyber:threats',           maxStaleMin: 480 },
  cryptoQuotes:     { key: 'seed-meta:market:crypto',           maxStaleMin: 30 },
  etfFlows:         { key: 'seed-meta:market:etf-flows',        maxStaleMin: 60 },
  gulfQuotes:       { key: 'seed-meta:market:gulf-quotes',      maxStaleMin: 30 },
  stablecoinMarkets:{ key: 'seed-meta:market:stablecoins',      maxStaleMin: 60 },
  naturalEvents:    { key: 'seed-meta:natural:events',          maxStaleMin: 120 },
  flightDelays:     { key: 'seed-meta:aviation:faa',            maxStaleMin: 30 },
  predictions:      { key: 'seed-meta:prediction:markets',      maxStaleMin: 15 },
  insights:         { key: 'seed-meta:news:insights',           maxStaleMin: 30 },
  marketQuotes:     { key: 'seed-meta:market:stocks',         maxStaleMin: 30 },
  commodityQuotes:  { key: 'seed-meta:market:commodities',    maxStaleMin: 30 },
};

// Standalone keys that are populated on-demand by RPC handlers (not seeds).
// Empty = WARN not CRIT since they only exist after first request.
const ON_DEMAND_KEYS = new Set([
  'theaterPostureLive', 'theaterPostureBackup', 'riskScoresLive',
  'usniFleet', 'usniFleetStale', 'positiveEventsLive', 'cableHealth',
  'theaterPosture', 'bisPolicy', 'bisExchange', 'bisCredit',
  'serviceStatuses', 'macroSignals', 'shippingRates', 'chokepoints', 'minerals', 'giving',
]);

const NEG_SENTINEL = '__WM_NEG__';

async function redisPipeline(commands) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis not configured');

  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(8_000),
  });
  if (!resp.ok) throw new Error(`Redis HTTP ${resp.status}`);
  return resp.json();
}

function parseRedisValue(raw) {
  if (!raw || raw === NEG_SENTINEL) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

function dataSize(parsed) {
  if (!parsed) return 0;
  if (Array.isArray(parsed)) return parsed.length;
  if (typeof parsed === 'object') {
    for (const k of ['quotes', 'hexes', 'events', 'stablecoins', 'fires', 'threats',
                      'earthquakes', 'outages', 'delays', 'items', 'predictions',
                      'papers', 'repos', 'articles', 'signals', 'rates', 'countries',
                      'chokepoints', 'minerals', 'anomalies', 'flows', 'bases',
                      'theaters', 'fleets', 'warnings', 'closures', 'cables',
                      'airports', 'categories', 'regions']) {
      if (Array.isArray(parsed[k])) return parsed[k].length;
    }
    return Object.keys(parsed).length;
  }
  return typeof parsed === 'string' ? parsed.length : 1;
}

export default async function handler(req) {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache, no-store',
    'Access-Control-Allow-Origin': '*',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  const now = Date.now();

  const allDataKeys = [
    ...Object.values(BOOTSTRAP_KEYS),
    ...Object.values(STANDALONE_KEYS),
  ];
  const allMetaKeys = Object.values(SEED_META).map(s => s.key);
  const allKeys = [...allDataKeys, ...allMetaKeys];

  let results;
  try {
    const commands = allKeys.map(k => ['GET', k]);
    results = await redisPipeline(commands);
  } catch (err) {
    return new Response(JSON.stringify({
      status: 'REDIS_DOWN',
      error: err.message,
      checkedAt: new Date(now).toISOString(),
    }), { status: 503, headers });
  }

  const keyValues = new Map();
  for (let i = 0; i < allKeys.length; i++) {
    keyValues.set(allKeys[i], results[i]?.result ?? null);
  }

  const checks = {};
  let totalChecks = 0;
  let okCount = 0;
  let warnCount = 0;
  let critCount = 0;

  for (const [name, redisKey] of Object.entries(BOOTSTRAP_KEYS)) {
    totalChecks++;
    const raw = keyValues.get(redisKey);
    const parsed = parseRedisValue(raw);
    const size = dataSize(parsed);
    const seedCfg = SEED_META[name];

    let seedAge = null;
    let seedStale = null;
    if (seedCfg) {
      const metaRaw = keyValues.get(seedCfg.key);
      const meta = parseRedisValue(metaRaw);
      if (meta?.fetchedAt) {
        seedAge = Math.round((now - meta.fetchedAt) / 60_000);
        seedStale = seedAge > seedCfg.maxStaleMin;
      } else {
        seedStale = true;
      }
    }

    let status;
    if (!parsed || raw === NEG_SENTINEL) {
      status = 'EMPTY';
      critCount++;
    } else if (size === 0) {
      status = 'EMPTY_DATA';
      critCount++;
    } else if (seedStale === true) {
      status = 'STALE_SEED';
      warnCount++;
    } else {
      status = 'OK';
      okCount++;
    }

    const entry = { status, redisKey, records: size };
    if (seedAge !== null) entry.seedAgeMin = seedAge;
    if (seedCfg) entry.maxStaleMin = seedCfg.maxStaleMin;
    checks[name] = entry;
  }

  for (const [name, redisKey] of Object.entries(STANDALONE_KEYS)) {
    totalChecks++;
    const raw = keyValues.get(redisKey);
    const parsed = parseRedisValue(raw);
    const size = dataSize(parsed);
    const isOnDemand = ON_DEMAND_KEYS.has(name);

    let status;
    if (!parsed || raw === NEG_SENTINEL) {
      if (isOnDemand) {
        status = 'EMPTY_ON_DEMAND';
        warnCount++;
      } else {
        status = 'EMPTY';
        critCount++;
      }
    } else if (size === 0) {
      if (isOnDemand) {
        status = 'EMPTY_ON_DEMAND';
        warnCount++;
      } else {
        status = 'EMPTY_DATA';
        critCount++;
      }
    } else {
      status = 'OK';
      okCount++;
    }

    checks[name] = { status, redisKey, records: size };
  }

  let overall;
  if (critCount === 0 && warnCount === 0) overall = 'HEALTHY';
  else if (critCount === 0) overall = 'DEGRADED';
  else if (critCount <= 3) overall = 'DEGRADED';
  else overall = 'UNHEALTHY';

  const httpStatus = overall === 'HEALTHY' ? 200 : overall === 'DEGRADED' ? 200 : 503;

  const url = new URL(req.url);
  const compact = url.searchParams.get('compact') === '1';

  const body = {
    status: overall,
    summary: {
      total: totalChecks,
      ok: okCount,
      warn: warnCount,
      crit: critCount,
    },
    checkedAt: new Date(now).toISOString(),
  };

  if (!compact) {
    body.checks = checks;
  } else {
    const problems = {};
    for (const [name, check] of Object.entries(checks)) {
      if (check.status !== 'OK') problems[name] = check;
    }
    if (Object.keys(problems).length > 0) body.problems = problems;
  }

  return new Response(JSON.stringify(body, null, compact ? 0 : 2), {
    status: httpStatus,
    headers,
  });
}
