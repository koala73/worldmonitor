import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { validateApiKey } from './_api-key.js';
import { jsonResponse } from './_json-response.js';

export const config = { runtime: 'edge' };

const SEED_DOMAINS = {
  // Phase 1 — Snapshot endpoints
  'seismology:earthquakes':   { key: 'seed-meta:seismology:earthquakes',   intervalMin: 15 },
  'wildfire:fires':           { key: 'seed-meta:wildfire:fires',           intervalMin: 60 },
  'infra:outages':            { key: 'seed-meta:infra:outages',            intervalMin: 15 },
  'climate:anomalies':        { key: 'seed-meta:climate:anomalies',        intervalMin: 60 },
  // Phase 2 — Parameterized endpoints
  'unrest:events':            { key: 'seed-meta:unrest:events',            intervalMin: 15 },
  'cyber:threats':            { key: 'seed-meta:cyber:threats',            intervalMin: 240 },
  'market:crypto':            { key: 'seed-meta:market:crypto',            intervalMin: 15 },
  'market:etf-flows':         { key: 'seed-meta:market:etf-flows',         intervalMin: 30 },
  'market:gulf-quotes':       { key: 'seed-meta:market:gulf-quotes',       intervalMin: 15 },
  'market:stablecoins':       { key: 'seed-meta:market:stablecoins',       intervalMin: 30 },
  // Phase 3 — Hybrid endpoints
  'natural:events':           { key: 'seed-meta:natural:events',           intervalMin: 60 },
  'displacement:summary':     { key: 'seed-meta:displacement:summary',     intervalMin: 360 },
  // Aligned with health.js SEED_META (intervalMin = maxStaleMin / 2)
  'market:stocks':            { key: 'seed-meta:market:stocks',            intervalMin: 15 },
  'market:commodities':       { key: 'seed-meta:market:commodities',       intervalMin: 15 },
  'market:sectors':           { key: 'seed-meta:market:sectors',           intervalMin: 15 },
  'aviation:faa':             { key: 'seed-meta:aviation:faa',             intervalMin: 45 },
  'news:insights':            { key: 'seed-meta:news:insights',            intervalMin: 15 },
  'positive-events:geo':      { key: 'seed-meta:positive-events:geo',      intervalMin: 30 },
  'risk:scores:sebuf':        { key: 'seed-meta:risk:scores:sebuf',        intervalMin: 15 },
  'conflict:iran-events':     { key: 'seed-meta:conflict:iran-events',     intervalMin: 5040 },
  'conflict:ucdp-events':     { key: 'seed-meta:conflict:ucdp-events',     intervalMin: 210 },
  'weather:alerts':           { key: 'seed-meta:weather:alerts',           intervalMin: 15 },
  'economic:spending':        { key: 'seed-meta:economic:spending',        intervalMin: 60 },
  'intelligence:gpsjam':      { key: 'seed-meta:intelligence:gpsjam',      intervalMin: 360 },
  'intelligence:satellites':  { key: 'seed-meta:intelligence:satellites',  intervalMin: 90 },
  'military:flights':         { key: 'seed-meta:military:flights',         intervalMin: 8 },
  'military-forecast-inputs': { key: 'seed-meta:military-forecast-inputs', intervalMin: 8 },
  'infra:service-statuses':   { key: 'seed-meta:infra:service-statuses',   intervalMin: 60 },
  'supply_chain:shipping':    { key: 'seed-meta:supply_chain:shipping',    intervalMin: 120 },
  'supply_chain:chokepoints': { key: 'seed-meta:supply_chain:chokepoints', intervalMin: 30 },
  'cable-health':             { key: 'seed-meta:cable-health',             intervalMin: 30 },
  'prediction:markets':       { key: 'seed-meta:prediction:markets',       intervalMin: 8 },
  'aviation:intl':            { key: 'seed-meta:aviation:intl',            intervalMin: 15 },
  'theater-posture':          { key: 'seed-meta:theater-posture',          intervalMin: 8 },
  'economic:worldbank-techreadiness': { key: 'seed-meta:economic:worldbank-techreadiness:v1', intervalMin: 5040 },
  'economic:worldbank-progress':      { key: 'seed-meta:economic:worldbank-progress:v1',     intervalMin: 5040 },
  'economic:worldbank-renewable':     { key: 'seed-meta:economic:worldbank-renewable:v1',    intervalMin: 5040 },
  'research:tech-events':    { key: 'seed-meta:research:tech-events',     intervalMin: 240 },
  'intelligence:gdelt-intel': { key: 'seed-meta:intelligence:gdelt-intel', intervalMin: 210 }, // 420min maxStaleMin / 2 — aligned with health.js (6h cron + 1h grace)
  'correlation:cards':        { key: 'seed-meta:correlation:cards',        intervalMin: 5 },
  'intelligence:advisories':  { key: 'seed-meta:intelligence:advisories',  intervalMin: 60 },
  'trade:customs-revenue':    { key: 'seed-meta:trade:customs-revenue',    intervalMin: 720 },
  'thermal:escalation':       { key: 'seed-meta:thermal:escalation',       intervalMin: 180 },
  'radiation:observations':   { key: 'seed-meta:radiation:observations',   intervalMin: 15 },
  'sanctions:pressure':       { key: 'seed-meta:sanctions:pressure',       intervalMin: 360 },
};

async function getMetaBatch(keys) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis not configured');

  const pipeline = keys.map((k) => ['GET', k]);
  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(pipeline),
    signal: AbortSignal.timeout(3000),
  });
  if (!resp.ok) throw new Error(`Redis HTTP ${resp.status}`);

  const data = await resp.json();
  const result = new Map();
  for (let i = 0; i < keys.length; i++) {
    const raw = data[i]?.result;
    if (raw) {
      try { result.set(keys[i], JSON.parse(raw)); } catch { /* skip */ }
    }
  }
  return result;
}

export default async function handler(req) {
  if (isDisallowedOrigin(req))
    return new Response('Forbidden', { status: 403 });

  const cors = getCorsHeaders(req);
  if (req.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: cors });

  const apiKeyResult = validateApiKey(req);
  if (apiKeyResult.required && !apiKeyResult.valid)
    return jsonResponse({ error: apiKeyResult.error }, 401, cors);

  const now = Date.now();
  const entries = Object.entries(SEED_DOMAINS);
  const metaKeys = entries.map(([, v]) => v.key);

  let metaMap;
  try {
    metaMap = await getMetaBatch(metaKeys);
  } catch {
    return jsonResponse({ error: 'Redis unavailable' }, 503, cors);
  }

  const seeds = {};
  let staleCount = 0;
  let missingCount = 0;

  for (const [domain, cfg] of entries) {
    const meta = metaMap.get(cfg.key);
    const maxStalenessMs = cfg.intervalMin * 2 * 60 * 1000;

    if (!meta) {
      seeds[domain] = { status: 'missing', fetchedAt: null, recordCount: null, stale: true };
      missingCount++;
      continue;
    }

    const ageMs = now - (meta.fetchedAt || 0);
    const stale = ageMs > maxStalenessMs;
    if (stale) staleCount++;

    seeds[domain] = {
      status: stale ? 'stale' : 'ok',
      fetchedAt: meta.fetchedAt,
      recordCount: meta.recordCount ?? null,
      sourceVersion: meta.sourceVersion || null,
      ageMinutes: Math.round(ageMs / 60000),
      stale,
    };
  }

  const overall = missingCount > 0 ? 'degraded' : staleCount > 0 ? 'warning' : 'healthy';

  const httpStatus = overall === 'healthy' ? 200 : overall === 'warning' ? 200 : 503;

  return jsonResponse({ overall, seeds, checkedAt: now }, httpStatus, {
    ...cors,
    'Cache-Control': 'no-cache',
  });
}
