import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { validateApiKey } from './_api-key.js';
import { jsonResponse } from './_json-response.js';
// @ts-expect-error — JS module, no declaration file
import { redisPipeline } from './_upstash-json.js';

export const config = { runtime: 'edge' };

const SEED_DOMAINS = {
  // Phase 1 — Snapshot endpoints
  'seismology:earthquakes':   { key: 'seed-meta:seismology:earthquakes',   intervalMin: 15 },
  'wildfire:fires':           { key: 'seed-meta:wildfire:fires',           intervalMin: 60 },
  'infra:outages':            { key: 'seed-meta:infra:outages',            intervalMin: 15 },
  'climate:anomalies':        { key: 'seed-meta:climate:anomalies',        intervalMin: 120 },
  'climate:disasters':        { key: 'seed-meta:climate:disasters',        intervalMin: 360 },
  'climate:zone-normals':     { key: 'seed-meta:climate:zone-normals',     intervalMin: 44640 },
  'climate:co2-monitoring':   { key: 'seed-meta:climate:co2-monitoring',   intervalMin: 1440 }, // daily cron; health.js maxStaleMin:4320 (3x) is intentionally higher — it's an alarm threshold, not the cron cadence
  'climate:ocean-ice':        { key: 'seed-meta:climate:ocean-ice',        intervalMin: 1440 }, // daily cron; health.js maxStaleMin:2880 (2x) tolerates one missed run
  'climate:news-intelligence': { key: 'seed-meta:climate:news-intelligence', intervalMin: 30 },
  // Phase 2 — Parameterized endpoints
  'unrest:events':            { key: 'seed-meta:unrest:events',            intervalMin: 15 },
  'cyber:threats':            { key: 'seed-meta:cyber:threats',            intervalMin: 240 },
  'market:crypto':            { key: 'seed-meta:market:crypto',            intervalMin: 15 },
  'market:hyperliquid-flow':  { key: 'seed-meta:market:hyperliquid-flow',  intervalMin: 5 }, // Railway cron 5min via seed-bundle-market-backup
  'market:etf-flows':         { key: 'seed-meta:market:etf-flows',         intervalMin: 30 },
  'market:gulf-quotes':       { key: 'seed-meta:market:gulf-quotes',       intervalMin: 15 },
  'market:stablecoins':       { key: 'seed-meta:market:stablecoins',       intervalMin: 30 },
  // Phase 3 — Hybrid endpoints
  'natural:events':           { key: 'seed-meta:natural:events',           intervalMin: 60 },
  'displacement:summary':     { key: 'seed-meta:displacement:summary',     intervalMin: 360 },
  // Aligned with health.js SEED_META (intervalMin = maxStaleMin / 2)
  'market:stocks':            { key: 'seed-meta:market:stocks',            intervalMin: 15 },
  'market:commodities':       { key: 'seed-meta:market:commodities',       intervalMin: 15 },
  'market:gold-extended':     { key: 'seed-meta:market:gold-extended',     intervalMin: 15 },
  'market:gold-etf-flows':    { key: 'seed-meta:market:gold-etf-flows',    intervalMin: 1440 },
  // maxStaleMin in health.js is 44640 (~31 days; IMF IFS is monthly w/ 2-3mo lag).
  // This endpoint flags stale at intervalMin*2, so keep intervalMin = 22320 to match.
  'market:gold-cb-reserves':  { key: 'seed-meta:market:gold-cb-reserves',  intervalMin: 22320 },
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
  'economic:bis-extended':    { key: 'seed-meta:economic:bis-extended',    intervalMin: 720 }, // 12h Railway cron; "seeder ran" aggregate — per-dataset freshness lives below
  'economic:bis-dsr':                  { key: 'seed-meta:economic:bis-dsr',                  intervalMin: 720 }, // 12h cron; only written when DSR slice fetched fresh entries
  'economic:bis-property-residential': { key: 'seed-meta:economic:bis-property-residential', intervalMin: 720 }, // 12h cron; only written when SPP slice fetched fresh entries
  'economic:bis-property-commercial':  { key: 'seed-meta:economic:bis-property-commercial',  intervalMin: 720 }, // 12h cron; only written when CPP slice fetched fresh entries
  'research:tech-events':    { key: 'seed-meta:research:tech-events',     intervalMin: 240 },
  'intelligence:gdelt-intel': { key: 'seed-meta:intelligence:gdelt-intel', intervalMin: 210 }, // 420min maxStaleMin / 2 — aligned with health.js (6h cron + 1h grace)
  'correlation:cards':        { key: 'seed-meta:correlation:cards',        intervalMin: 5 },
  'intelligence:advisories':  { key: 'seed-meta:intelligence:advisories',  intervalMin: 60 },
  'intelligence:social-reddit': { key: 'seed-meta:intelligence:social-reddit', intervalMin: 90 }, // 60min relay loop (hourly, bumped from 10min to reduce Reddit IP blocking); intervalMin = maxStaleMin / 2 (180 / 2)
  'intelligence:wsb-tickers': { key: 'seed-meta:intelligence:wsb-tickers', intervalMin: 90 }, // 60min relay loop (hourly, bumped from 10min); intervalMin = maxStaleMin / 2 (180 / 2)
  'trade:customs-revenue':    { key: 'seed-meta:trade:customs-revenue',    intervalMin: 720 },
  'thermal:escalation':       { key: 'seed-meta:thermal:escalation',       intervalMin: 180 },
  'radiation:observations':   { key: 'seed-meta:radiation:observations',   intervalMin: 15 },
  'sanctions:pressure':       { key: 'seed-meta:sanctions:pressure',       intervalMin: 360 },
  'health:air-quality':       { key: 'seed-meta:health:air-quality',       intervalMin: 60 },  // hourly cron (shared seeder writes health + climate keys)
  'economic:grocery-basket':  { key: 'seed-meta:economic:grocery-basket',  intervalMin: 5040 }, // weekly seed; intervalMin = maxStaleMin / 2
  'economic:bigmac':          { key: 'seed-meta:economic:bigmac',          intervalMin: 5040 }, // weekly seed; intervalMin = maxStaleMin / 2
  'resilience:static':        { key: 'seed-meta:resilience:static',        intervalMin: 288000 }, // annual October snapshot; intervalMin = health.js maxStaleMin / 2 (400d alert threshold)
  'resilience:intervals':     { key: 'seed-meta:resilience:intervals',     intervalMin: 10080 }, // weekly cron; intervalMin = health.js maxStaleMin / 2 (20160 / 2)
  'regulatory:actions':       { key: 'seed-meta:regulatory:actions',       intervalMin: 120 }, // 2h cron; intervalMin = maxStaleMin / 3
  'economic:owid-energy-mix': { key: 'seed-meta:economic:owid-energy-mix', intervalMin: 25200 }, // monthly cron on 1st; intervalMin = health.js maxStaleMin / 2 (50400 / 2)
  'economic:fao-ffpi':        { key: 'seed-meta:economic:fao-ffpi',        intervalMin: 43200 }, // monthly seed; intervalMin = health.js maxStaleMin / 2 (86400 / 2)
  'economic:imf-growth':      { key: 'seed-meta:economic:imf-growth',      intervalMin: 50400 }, // monthly WEO seed; intervalMin = health.js maxStaleMin / 2 (100800 / 2)
  'economic:imf-labor':       { key: 'seed-meta:economic:imf-labor',       intervalMin: 50400 }, // monthly WEO seed; intervalMin = health.js maxStaleMin / 2 (100800 / 2)
  'economic:imf-external':    { key: 'seed-meta:economic:imf-external',    intervalMin: 50400 }, // monthly WEO seed; intervalMin = health.js maxStaleMin / 2 (100800 / 2)
  'product-catalog':          { key: 'seed-meta:product-catalog',          intervalMin: 360 }, // relay loop every 6h; intervalMin = health.js maxStaleMin / 3 (1080 / 3)
  'portwatch:chokepoints-ref': { key: 'seed-meta:portwatch:chokepoints-ref', intervalMin: 10080 }, // seed-bundle-portwatch runs this at WEEK cadence; intervalMin*2 = 14d matches api/health.js SEED_META.portwatchChokepointsRef
  'supply_chain:portwatch-ports': { key: 'seed-meta:supply_chain:portwatch-ports', intervalMin: 720 }, // 12h cron (0 */12 * * *); intervalMin = maxStaleMin / 3 (2160 / 3)
  'energy:chokepoint-flows': { key: 'seed-meta:energy:chokepoint-flows', intervalMin: 360 }, // 6h relay loop; intervalMin = maxStaleMin / 2 (720 / 2)
  'energy:eia-petroleum':   { key: 'seed-meta:energy:eia-petroleum',   intervalMin: 1440 }, // daily bundle cron; intervalMin*3 = health.js maxStaleMin (4320)
  'energy:spine':                 { key: 'seed-meta:energy:spine',                 intervalMin: 1440 }, // daily cron (0 6 * * *); intervalMin = maxStaleMin / 2 (2880 / 2)
  'energy:ember': { key: 'seed-meta:energy:ember', intervalMin: 1440 }, // daily cron (0 8 * * *); intervalMin = maxStaleMin / 2 (2880 / 2)
  'energy:spr-policies': { key: 'seed-meta:energy:spr-policies', intervalMin: 288000 }, // annual static registry; intervalMin = health.js maxStaleMin / 2 (576000 / 2)
  'market:aaii-sentiment': { key: 'seed-meta:market:aaii-sentiment', intervalMin: 10080 }, // weekly cron; intervalMin = maxStaleMin / 2 (20160 / 2)
  'intelligence:regional-briefs': { key: 'seed-meta:intelligence:regional-briefs', intervalMin: 10080 }, // weekly cron; intervalMin = health.js maxStaleMin / 2 (20160 / 2)
  'economic:eurostat-house-prices': { key: 'seed-meta:economic:eurostat-house-prices', intervalMin: 36000 }, // weekly cron, annual data; intervalMin = health.js maxStaleMin / 2 (72000 / 2)
  'economic:eurostat-gov-debt-q':   { key: 'seed-meta:economic:eurostat-gov-debt-q',   intervalMin: 10080 }, // 2d cron, quarterly data; intervalMin = health.js maxStaleMin / 2 (20160 / 2)
  'economic:eurostat-industrial-production': { key: 'seed-meta:economic:eurostat-industrial-production', intervalMin: 3600 }, // daily cron, monthly data; intervalMin = health.js maxStaleMin / 2 (7200 / 2)
};

async function getMetaBatch(keys) {
  const pipeline = keys.map((k) => ['GET', k]);
  const data = await redisPipeline(pipeline, 3000);
  if (!data) throw new Error('Redis not configured');

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
    const isError = meta.status === 'error';
    const stale = ageMs > maxStalenessMs || isError;
    if (stale) staleCount++;

    seeds[domain] = {
      status: stale ? (isError ? 'error' : 'stale') : 'ok',
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
