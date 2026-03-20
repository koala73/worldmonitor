import { jsonResponse } from './_json-response.js';

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
  progressData:      'economic:worldbank-progress:v1',
  renewableEnergy:   'economic:worldbank-renewable:v1',
  positiveGeoEvents: 'positive_events:geo-bootstrap:v1',
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
  weatherAlerts:     'weather:alerts:v1',
  spending:          'economic:spending:v1',
  techEvents:        'research:tech-events-bootstrap:v1',
  gdeltIntel:        'intelligence:gdelt-intel:v1',
  correlationCards:   'correlation:cards-bootstrap:v1',
  forecasts:         'forecast:predictions:v2',
  securityAdvisories: 'intelligence:advisories-bootstrap:v1',
  customsRevenue:    'trade:customs-revenue:v1',
  sanctionsPressure: 'sanctions:pressure:v1',
  radiationWatch:    'radiation:observations:v1',
};

const STANDALONE_KEYS = {
  serviceStatuses:       'infra:service-statuses:v1',
  macroSignals:          'economic:macro-signals:v1',
  bisPolicy:             'economic:bis:policy:v1',
  bisExchange:           'economic:bis:eer:v1',
  bisCredit:             'economic:bis:credit:v1',
  shippingRates:         'supply_chain:shipping:v2',
  chokepoints:           'supply_chain:chokepoints:v4',
  minerals:              'supply_chain:minerals:v2',
  giving:                'giving:summary:v1',
  gpsjam:                'intelligence:gpsjam:v2',
  theaterPosture:        'theater_posture:sebuf:stale:v1',
  theaterPostureLive:    'theater-posture:sebuf:v1',
  theaterPostureBackup:  'theater-posture:sebuf:backup:v1',
  riskScoresLive:        'risk:scores:sebuf:v1',
  usniFleet:             'usni-fleet:sebuf:v1',
  usniFleetStale:        'usni-fleet:sebuf:stale:v1',
  faaDelays:             'aviation:delays:faa:v1',
  intlDelays:            'aviation:delays:intl:v3',
  notamClosures:         'aviation:notam:closures:v2',
  positiveEventsLive:    'positive-events:geo:v1',
  cableHealth:           'cable-health-v1',
  cyberThreatsRpc:       'cyber:threats:v2',
  militaryBases:         'military:bases:active',
  militaryFlights:       'military:flights:v1',
  militaryFlightsStale:  'military:flights:stale:v1',
  temporalAnomalies:     'temporal:anomalies:v1',
  displacement:          `displacement:summary:v1:${new Date().getFullYear()}`,
  satellites:            'intelligence:satellites:tle:v1',
  portwatch:             'supply_chain:portwatch:v1',
  corridorrisk:          'supply_chain:corridorrisk:v1',
  chokepointTransits:    'supply_chain:chokepoint_transits:v1',
  transitSummaries:      'supply_chain:transit-summaries:v1',
  thermalEscalation:     'thermal:escalation:v1',
  tariffTrendsUs:        'trade:tariffs:v1:840:all:10',
};

const SEED_META = {
  earthquakes:      { key: 'seed-meta:seismology:earthquakes',  maxStaleMin: 30 },
  wildfires:        { key: 'seed-meta:wildfire:fires',          maxStaleMin: 120 },
  outages:          { key: 'seed-meta:infra:outages',           maxStaleMin: 30 },
  climateAnomalies: { key: 'seed-meta:climate:anomalies',       maxStaleMin: 120 },
  unrestEvents:     { key: 'seed-meta:unrest:events',           maxStaleMin: 75 },
  cyberThreats:     { key: 'seed-meta:cyber:threats',           maxStaleMin: 480 },
  cryptoQuotes:     { key: 'seed-meta:market:crypto',           maxStaleMin: 30 },
  etfFlows:         { key: 'seed-meta:market:etf-flows',        maxStaleMin: 60 },
  gulfQuotes:       { key: 'seed-meta:market:gulf-quotes',      maxStaleMin: 30 },
  stablecoinMarkets:{ key: 'seed-meta:market:stablecoins',      maxStaleMin: 60 },
  naturalEvents:    { key: 'seed-meta:natural:events',          maxStaleMin: 360 }, // 2h cron; 3x interval; was 120 (TTL was 60min — panel went dark before health alarmed)
  flightDelays:     { key: 'seed-meta:aviation:faa',            maxStaleMin: 90 }, // CACHE_TTL=7200s; matches notamClosures from same cron
  notamClosures:    { key: 'seed-meta:aviation:notam',          maxStaleMin: 90 },
  predictions:      { key: 'seed-meta:prediction:markets',      maxStaleMin: 90 },
  insights:         { key: 'seed-meta:news:insights',           maxStaleMin: 30 },
  marketQuotes:     { key: 'seed-meta:market:stocks',         maxStaleMin: 30 },
  commodityQuotes:  { key: 'seed-meta:market:commodities',    maxStaleMin: 30 },
  // RPC/warm-ping keys — seed-meta written by relay loops or handlers
  // serviceStatuses: moved to ON_DEMAND — RPC-populated, no dedicated seed, goes stale when no users visit
  cableHealth:      { key: 'seed-meta:cable-health',              maxStaleMin: 90 }, // ais-relay warm-ping runs every 30min; 90min = 3× interval catches missed pings without false positives
  macroSignals:     { key: 'seed-meta:economic:macro-signals',    maxStaleMin: 20 },
  bisPolicy:        { key: 'seed-meta:economic:bis:policy',       maxStaleMin: 10080 },
  bisExchange:      { key: 'seed-meta:economic:bis:eer',          maxStaleMin: 10080 },
  bisCredit:        { key: 'seed-meta:economic:bis:credit',       maxStaleMin: 10080 },
  shippingRates:    { key: 'seed-meta:supply_chain:shipping',     maxStaleMin: 420 },
  chokepoints:      { key: 'seed-meta:supply_chain:chokepoints',  maxStaleMin: 60 },
  minerals:         { key: 'seed-meta:supply_chain:minerals',     maxStaleMin: 10080 },
  giving:           { key: 'seed-meta:giving:summary',            maxStaleMin: 10080 },
  gpsjam:           { key: 'seed-meta:intelligence:gpsjam',       maxStaleMin: 720 },
  positiveGeoEvents:{ key: 'seed-meta:positive-events:geo',       maxStaleMin: 60 },
  riskScores:       { key: 'seed-meta:intelligence:risk-scores',  maxStaleMin: 30 }, // CII warm-ping every 8min; 30min = ~3.5x interval,
  iranEvents:       { key: 'seed-meta:conflict:iran-events',      maxStaleMin: 10080 },
  ucdpEvents:       { key: 'seed-meta:conflict:ucdp-events',      maxStaleMin: 420 },
  militaryFlights:  { key: 'seed-meta:military:flights',           maxStaleMin: 30 }, // cron ~10min (LIVE_TTL=600s); 30min = 3x interval,
  militaryForecastInputs: { key: 'seed-meta:military-forecast-inputs', maxStaleMin: 30 }, // same cron as militaryFlights,
  satellites:       { key: 'seed-meta:intelligence:satellites',    maxStaleMin: 180 },
  weatherAlerts:    { key: 'seed-meta:weather:alerts',             maxStaleMin: 30 },
  spending:         { key: 'seed-meta:economic:spending',          maxStaleMin: 120 },
  techEvents:       { key: 'seed-meta:research:tech-events',       maxStaleMin: 480 },
  gdeltIntel:       { key: 'seed-meta:intelligence:gdelt-intel',   maxStaleMin: 420 }, // 6h cron + 1h grace; CACHE_TTL is 24h so per-topic merge always has a prior snapshot
  forecasts:        { key: 'seed-meta:forecast:predictions',       maxStaleMin: 90 },
  sectors:          { key: 'seed-meta:market:sectors',             maxStaleMin: 30 },
  techReadiness:    { key: 'seed-meta:economic:worldbank-techreadiness:v1', maxStaleMin: 10080 },
  progressData:     { key: 'seed-meta:economic:worldbank-progress:v1',     maxStaleMin: 10080 },
  renewableEnergy:  { key: 'seed-meta:economic:worldbank-renewable:v1',    maxStaleMin: 10080 },
  intlDelays:       { key: 'seed-meta:aviation:intl',           maxStaleMin: 90 },
  faaDelays:        { key: 'seed-meta:aviation:faa',            maxStaleMin: 90 }, // same key as flightDelays; CACHE_TTL=7200s
  theaterPosture:   { key: 'seed-meta:theater-posture',         maxStaleMin: 60 },
  correlationCards: { key: 'seed-meta:correlation:cards',       maxStaleMin: 15 },
  portwatch:           { key: 'seed-meta:supply_chain:portwatch',            maxStaleMin: 720 },
  corridorrisk:        { key: 'seed-meta:supply_chain:corridorrisk',         maxStaleMin: 120 },
  chokepointTransits:  { key: 'seed-meta:supply_chain:chokepoint_transits',  maxStaleMin: 30 }, // relay every 10min; 30min = 3x interval,
  transitSummaries:    { key: 'seed-meta:supply_chain:transit-summaries',    maxStaleMin: 30 }, // relay every 10min; 30min = 3x interval,
  usniFleet:           { key: 'seed-meta:military:usni-fleet',               maxStaleMin: 480 },
  securityAdvisories:  { key: 'seed-meta:intelligence:advisories',           maxStaleMin: 120 },
  customsRevenue:      { key: 'seed-meta:trade:customs-revenue',              maxStaleMin: 1440 },
  sanctionsPressure:   { key: 'seed-meta:sanctions:pressure',                 maxStaleMin: 720 },
  radiationWatch:      { key: 'seed-meta:radiation:observations',             maxStaleMin: 30 },
  thermalEscalation:   { key: 'seed-meta:thermal:escalation',                 maxStaleMin: 240 },
  tariffTrendsUs:      { key: 'seed-meta:trade:tariffs:v1:840:all:10',        maxStaleMin: 900 },
};

// Standalone keys that are populated on-demand by RPC handlers (not seeds).
// Empty = WARN not CRIT since they only exist after first request.
const ON_DEMAND_KEYS = new Set([
  'riskScoresLive',
  'usniFleetStale', 'positiveEventsLive',
  'bisPolicy', 'bisExchange', 'bisCredit',
  'macroSignals', 'shippingRates', 'chokepoints', 'minerals', 'giving',
  'cyberThreatsRpc', 'militaryBases', 'temporalAnomalies', 'displacement',
  'corridorrisk', // intermediate key; data flows through transit-summaries:v1
  'serviceStatuses', // RPC-populated; seed-meta written on fresh fetch only, goes stale between visits
]);

// Keys where 0 records is a valid healthy state (e.g. no airports closed).
// The key must still exist in Redis; only the record count can be 0.
const EMPTY_DATA_OK_KEYS = new Set(['notamClosures', 'faaDelays', 'gpsjam']);

// Cascade groups: if any key in the group has data, all empty siblings are OK.
// Theater posture uses live → stale → backup fallback chain.
const CASCADE_GROUPS = {
  theaterPosture:       ['theaterPosture', 'theaterPostureLive', 'theaterPostureBackup'],
  theaterPostureLive:   ['theaterPosture', 'theaterPostureLive', 'theaterPostureBackup'],
  theaterPostureBackup: ['theaterPosture', 'theaterPostureLive', 'theaterPostureBackup'],
  militaryFlights:      ['militaryFlights', 'militaryFlightsStale'],
  militaryFlightsStale: ['militaryFlights', 'militaryFlightsStale'],
};

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
                      'earthquakes', 'outages', 'delays', 'items', 'predictions', 'alerts', 'awards',
                      'papers', 'repos', 'articles', 'signals', 'rates', 'countries',
                      'chokepoints', 'minerals', 'anomalies', 'flows', 'bases', 'flights',
                      'theaters', 'fleets', 'warnings', 'closures', 'cables',
                      'airports', 'closedIcaos', 'categories', 'regions', 'entries', 'satellites',
                      'sectors', 'statuses', 'scores', 'topics', 'advisories', 'months']) {
      if (Array.isArray(parsed[k])) return parsed[k].length;
    }
    return Object.keys(parsed).length;
  }
  return typeof parsed === 'string' ? parsed.length : 1;
}

export default async function handler(req) {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'private, no-store, max-age=0',
    'CDN-Cache-Control': 'no-store',
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
    return jsonResponse({
      status: 'REDIS_DOWN',
      error: err.message,
      checkedAt: new Date(now).toISOString(),
    }, 503, headers);
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

    const entry = { status, records: size };
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
    const seedCfg = SEED_META[name];

    // Freshness tracking for standalone keys (same logic as bootstrap keys)
    let seedAge = null;
    let seedStale = null;
    if (seedCfg) {
      const metaRaw = keyValues.get(seedCfg.key);
      const meta = parseRedisValue(metaRaw);
      if (meta?.fetchedAt) {
        seedAge = Math.round((now - meta.fetchedAt) / 60_000);
        seedStale = seedAge > seedCfg.maxStaleMin;
      } else {
        // No seed-meta → data exists but freshness is unknown → stale
        seedStale = true;
      }
    }

    // Cascade: if this key is empty but a sibling in the cascade group has data, it's OK.
    const cascadeSiblings = CASCADE_GROUPS[name];
    let cascadeCovered = false;
    if (cascadeSiblings && (!parsed || size === 0)) {
      for (const sibling of cascadeSiblings) {
        if (sibling === name) continue;
        const sibKey = STANDALONE_KEYS[sibling];
        if (!sibKey) continue;
        const sibRaw = keyValues.get(sibKey);
        const sibParsed = parseRedisValue(sibRaw);
        if (sibParsed && dataSize(sibParsed) > 0) {
          cascadeCovered = true;
          break;
        }
      }
    }

    let status;
    if (!parsed || raw === NEG_SENTINEL) {
      if (cascadeCovered) {
        status = 'OK_CASCADE';
        okCount++;
      } else if (EMPTY_DATA_OK_KEYS.has(name)) {
        if (seedStale === true) {
          status = 'STALE_SEED';
          warnCount++;
        } else {
          status = 'OK';
          okCount++;
        }
      } else if (isOnDemand) {
        status = 'EMPTY_ON_DEMAND';
        warnCount++;
      } else {
        status = 'EMPTY';
        critCount++;
      }
    } else if (size === 0) {
      if (cascadeCovered) {
        status = 'OK_CASCADE';
        okCount++;
      } else if (EMPTY_DATA_OK_KEYS.has(name)) {
        if (seedStale === true) {
          status = 'STALE_SEED';
          warnCount++;
        } else {
          status = 'OK';
          okCount++;
        }
      } else if (isOnDemand) {
        status = 'EMPTY_ON_DEMAND';
        warnCount++;
      } else {
        status = 'EMPTY_DATA';
        critCount++;
      }
    } else if (seedStale === true) {
      status = 'STALE_SEED';
      warnCount++;
    } else {
      status = 'OK';
      okCount++;
    }

    const entry = { status, records: size };
    if (seedAge !== null) entry.seedAgeMin = seedAge;
    if (seedCfg) entry.maxStaleMin = seedCfg.maxStaleMin;
    checks[name] = entry;
  }

  // On-demand keys that simply haven't been requested yet should not affect overall status.
  const onDemandWarnCount = Object.values(checks).filter(c => c.status === 'EMPTY_ON_DEMAND').length;
  const realWarnCount = warnCount - onDemandWarnCount;

  let overall;
  if (critCount === 0 && realWarnCount === 0) overall = 'HEALTHY';
  else if (critCount === 0) overall = 'WARNING';
  else if (critCount <= 3) overall = 'DEGRADED';
  else overall = 'UNHEALTHY';

  const httpStatus = overall === 'HEALTHY' || overall === 'WARNING' ? 200 : 503;

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
      if (check.status !== 'OK' && check.status !== 'OK_CASCADE') problems[name] = check;
    }
    if (Object.keys(problems).length > 0) body.problems = problems;
  }

  return new Response(JSON.stringify(body, null, compact ? 0 : 2), {
    status: httpStatus,
    headers,
  });
}
