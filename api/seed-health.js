import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { validateApiKey } from './_api-key.js';
import { jsonResponse } from './_json-response.js';
import { unwrapEnvelope } from './_seed-envelope.js';
// @ts-expect-error — JS module, no declaration file
import { redisPipeline } from './_upstash-json.js';

export const config = { runtime: 'edge' };

// Keep these literals in sync with scripts/_resilience-intervals.mjs. Edge
// functions cannot import from scripts/, so tests enforce this mirror.
const RESILIENCE_INTERVAL_KEY_PREFIX = 'resilience:intervals:v9:';
const RESILIENCE_INTERVAL_METHODOLOGY = 'weight-perturbation-sensitivity-v3';
const RESILIENCE_INTERVAL_SOURCE_VERSION = `resilience-intervals:${RESILIENCE_INTERVAL_KEY_PREFIX}${RESILIENCE_INTERVAL_METHODOLOGY}`;
const RESILIENCE_INTERVAL_PROBE_KEY = `${RESILIENCE_INTERVAL_KEY_PREFIX}US`;
const RESILIENCE_INTERVAL_SCORE_MIN = 0;
const RESILIENCE_INTERVAL_SCORE_MAX = 100;

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
  'intelligence:risk-scores': { key: 'seed-meta:intelligence:risk-scores', intervalMin: 15 }, // CII warm-ping every 8min; intervalMin*2 = 30min, aligned with api/health.js riskScores.
  'conflict:iran-events':     { key: 'seed-meta:conflict:iran-events',     intervalMin: 5040 },
  'conflict:ucdp-events':     { key: 'seed-meta:conflict:ucdp-events',     intervalMin: 210 },
  'weather:alerts':           { key: 'seed-meta:weather:alerts',           intervalMin: 15 },
  'economic:spending':        { key: 'seed-meta:economic:spending',        intervalMin: 60 },
  'intelligence:gpsjam':      { key: 'seed-meta:intelligence:gpsjam',      intervalMin: 720 }, // 720 × 2 = 1440min (24h) staleness; matches api/health.js gpsjam.maxStaleMin. Widened from 360 (12h) on 2026-04-29 alongside Wingbits API quota incident — see PR #3494 + the seeder graceful-failure path at scripts/fetch-gpsjam.mjs:258-262.
  'intelligence:satellites':  { key: 'seed-meta:intelligence:satellites',  intervalMin: 90 },
  'military:flights':         { key: 'seed-meta:military:flights',         intervalMin: 8 },
  'military-forecast-inputs': { key: 'seed-meta:military-forecast-inputs', intervalMin: 8 },
  'infra:service-statuses':   { key: 'seed-meta:infra:service-statuses',   intervalMin: 60 },
  'supply_chain:shipping':    { key: 'seed-meta:supply_chain:shipping',    intervalMin: 120 },
  'supply_chain:chokepoints': { key: 'seed-meta:supply_chain:chokepoints', intervalMin: 30 },
  'cable-health':             { key: 'seed-meta:cable-health',             intervalMin: 30 },
  'prediction:markets':       { key: 'seed-meta:prediction:markets',       intervalMin: 8 },
  'aviation:intl':            { key: 'seed-meta:aviation:intl',            intervalMin: 45 }, // intervalMin*2 = 90min staleness. seed-aviation's freshness gate (AVIATIONSTACK_MIN_REFRESH_MIN, default 55) lets fetchedAt age to ~55+cron between paid fetches; 90min matches the aviation:faa sibling + api/health.js intlDelays maxStaleMin:90. Was 15 (30min) and false-WARNed every cycle once the gate landed.
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
  'intelligence:social-reddit': { key: 'seed-meta:intelligence:social-reddit', intervalMin: 270 }, // 180min relay loop (3h; dropped from 60min now that ScrapeCreators handles Reddit); intervalMin = maxStaleMin / 2 (540 / 2), matching api/health.js
  'intelligence:wsb-tickers': { key: 'seed-meta:intelligence:wsb-tickers', intervalMin: 270 }, // 180min relay loop (3h); intervalMin = maxStaleMin / 2 (540 / 2), matching api/health.js
  'trade:customs-revenue':    { key: 'seed-meta:trade:customs-revenue',    intervalMin: 720 },
  'thermal:escalation':       { key: 'seed-meta:thermal:escalation',       intervalMin: 180 },
  'radiation:observations':   { key: 'seed-meta:radiation:observations',   intervalMin: 15 },
  'sanctions:pressure':       { key: 'seed-meta:sanctions:pressure',       intervalMin: 360 },
  'health:air-quality':       { key: 'seed-meta:health:air-quality',       intervalMin: 60 },  // hourly cron (shared seeder writes health + climate keys)
  'economic:grocery-basket':  { key: 'seed-meta:economic:grocery-basket',  intervalMin: 5040 }, // weekly seed; intervalMin = maxStaleMin / 2
  'economic:bigmac':          { key: 'seed-meta:economic:bigmac',          intervalMin: 5040 }, // weekly seed; intervalMin = maxStaleMin / 2
  'resilience:static':        { key: 'seed-meta:resilience:static',        intervalMin: 288000 }, // annual October snapshot; intervalMin = health.js maxStaleMin / 2 (400d alert threshold)
  'resilience:intervals':     {
    key: 'seed-meta:resilience:intervals',
    intervalMin: 420, // Same 840min freshness budget as api/health.js, expressed as intervalMin * 2.
    dataProbe: {
      key: RESILIENCE_INTERVAL_PROBE_KEY,
      kind: 'resilience_interval',
      methodology: RESILIENCE_INTERVAL_METHODOLOGY,
      formula: currentResilienceCacheFormula(),
      sourceVersion: RESILIENCE_INTERVAL_SOURCE_VERSION,
    },
  },
  'regulatory:actions':       { key: 'seed-meta:regulatory:actions',       intervalMin: 120 }, // 2h cron; intervalMin = maxStaleMin / 3
  'economic:owid-energy-mix': { key: 'seed-meta:economic:owid-energy-mix', intervalMin: 25200 }, // monthly cron on 1st; intervalMin = health.js maxStaleMin / 2 (50400 / 2)
  'economic:fao-ffpi':        { key: 'seed-meta:economic:fao-ffpi',        intervalMin: 43200 }, // monthly seed; intervalMin = health.js maxStaleMin / 2 (86400 / 2)
  'economic:imf-growth':      { key: 'seed-meta:economic:imf-growth',      intervalMin: 50400 }, // monthly WEO seed; intervalMin = health.js maxStaleMin / 2 (100800 / 2)
  'economic:imf-labor':       { key: 'seed-meta:economic:imf-labor',       intervalMin: 50400 }, // monthly WEO seed; intervalMin = health.js maxStaleMin / 2 (100800 / 2)
  'economic:imf-external':    { key: 'seed-meta:economic:imf-external',    intervalMin: 50400 }, // monthly WEO seed; intervalMin = health.js maxStaleMin / 2 (100800 / 2)
  // plan 2026-04-25-004 Phase 2: financialSystemExposure component seeders.
  // intervalMin = health.js maxStaleMin / 2 (mirrors the IMF-pattern). Bundle: scripts/seed-bundle-macro.mjs.
  'economic:wb-external-debt': { key: 'seed-meta:economic:wb-external-debt', intervalMin: 50400 }, // annual WB IDS publication; intervalMin = health.js maxStaleMin / 2 (100800 / 2)
  'economic:bis-lbs':          { key: 'seed-meta:economic:bis-lbs',          intervalMin: 7200 },  // BIS LBS quarterly; intervalMin = health.js maxStaleMin / 2 (14400 / 2)
  'economic:fatf-listing':     { key: 'seed-meta:economic:fatf-listing',     intervalMin: 30240 }, // FATF plenary 3×/year; intervalMin = health.js maxStaleMin / 2 (60480 / 2)
  'product-catalog':          { key: 'seed-meta:product-catalog',          intervalMin: 360 }, // relay loop every 6h; intervalMin = health.js maxStaleMin / 3 (1080 / 3)
  'portwatch:chokepoints-ref': { key: 'seed-meta:portwatch:chokepoints-ref', intervalMin: 10080 }, // seed-bundle-portwatch runs this at WEEK cadence; intervalMin*2 = 14d matches api/health.js SEED_META.portwatchChokepointsRef
  'supply_chain:portwatch-ports': { key: 'seed-meta:supply_chain:portwatch-ports', intervalMin: 720, minRecordCount: 174 }, // 12h cron (0 */12 * * *); intervalMin = maxStaleMin / 3 (2160 / 3); #3613 requires 174-country coverage before OK.
  'energy:chokepoint-flows': { key: 'seed-meta:energy:chokepoint-flows', intervalMin: 360 }, // 6h relay loop; intervalMin = maxStaleMin / 2 (720 / 2)
  'energy:eia-petroleum':   { key: 'seed-meta:energy:eia-petroleum',   intervalMin: 1440 }, // daily bundle cron; intervalMin*3 = health.js maxStaleMin (4320)
  'energy:spine':                 { key: 'seed-meta:energy:spine',                 intervalMin: 1440 }, // daily cron (0 6 * * *); intervalMin = maxStaleMin / 2 (2880 / 2)
  'energy:ember': { key: 'seed-meta:energy:ember', intervalMin: 1440 }, // daily cron (0 8 * * *); intervalMin = maxStaleMin / 2 (2880 / 2)
  'energy:spr-policies': { key: 'seed-meta:energy:spr-policies', intervalMin: 288000 }, // annual static registry; intervalMin = health.js maxStaleMin / 2 (576000 / 2)
  'energy:pipelines-gas': { key: 'seed-meta:energy:pipelines-gas', intervalMin: 10080 }, // weekly cron (7d); intervalMin = health.js maxStaleMin / 2 (20160 / 2)
  'energy:pipelines-oil': { key: 'seed-meta:energy:pipelines-oil', intervalMin: 10080 }, // weekly cron; same seeder writes both keys
  'energy:storage-facilities': { key: 'seed-meta:energy:storage-facilities', intervalMin: 10080 }, // weekly cron (7d); intervalMin = health.js maxStaleMin / 2 (20160 / 2)
  'energy:fuel-shortages': { key: 'seed-meta:energy:fuel-shortages', intervalMin: 1440 }, // daily cron; intervalMin = health.js maxStaleMin / 2 (2880 / 2)
  'energy:disruptions': { key: 'seed-meta:energy:disruptions', intervalMin: 10080 }, // weekly cron; intervalMin = health.js maxStaleMin / 2 (20160 / 2)
  'market:aaii-sentiment': { key: 'seed-meta:market:aaii-sentiment', intervalMin: 10080 }, // weekly cron; intervalMin = maxStaleMin / 2 (20160 / 2)
  'intelligence:regional-briefs': { key: 'seed-meta:intelligence:regional-briefs', intervalMin: 10080 }, // weekly cron; intervalMin = health.js maxStaleMin / 2 (20160 / 2)
  'economic:eurostat-house-prices': { key: 'seed-meta:economic:eurostat-house-prices', intervalMin: 36000 }, // weekly cron, annual data; intervalMin = health.js maxStaleMin / 2 (72000 / 2)
  'economic:eurostat-gov-debt-q':   { key: 'seed-meta:economic:eurostat-gov-debt-q',   intervalMin: 10080 }, // 2d cron, quarterly data; intervalMin = health.js maxStaleMin / 2 (20160 / 2)
  'economic:eurostat-industrial-production': { key: 'seed-meta:economic:eurostat-industrial-production', intervalMin: 3600 }, // daily cron, monthly data; intervalMin = health.js maxStaleMin / 2 (7200 / 2)
  'resilience:recovery:reexport-share':   { key: 'seed-meta:resilience:recovery:reexport-share',   intervalMin: 43200 }, // monthly bundle cron (30d); intervalMin*2 = 60d matches health.js maxStaleMin
  'resilience:recovery:sovereign-wealth': { key: 'seed-meta:resilience:recovery:sovereign-wealth', intervalMin: 43200 }, // monthly bundle cron (30d); intervalMin*2 = 60d matches health.js maxStaleMin
};

function parseJsonValue(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseFiniteRecordCount(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isEnabledEnv(name, defaultValue) {
  return String(process.env[name] ?? defaultValue).toLowerCase() === 'true';
}

function currentResilienceCacheFormula() {
  // Mirrors server/worldmonitor/resilience/v1/_shared.ts currentCacheFormula().
  // Edge functions cannot import the server module, so this is intentionally
  // duplicated and guarded by tests.
  return isEnabledEnv('RESILIENCE_PILLAR_COMBINE_ENABLED', 'false') &&
    isEnabledEnv('RESILIENCE_SCHEMA_V2_ENABLED', 'true')
    ? 'pc'
    : 'd6';
}

function isValidResilienceIntervalPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (typeof payload.p05 !== 'number' || !Number.isFinite(payload.p05)) return false;
  if (typeof payload.p95 !== 'number' || !Number.isFinite(payload.p95)) return false;
  return (
    payload.p05 >= RESILIENCE_INTERVAL_SCORE_MIN &&
    payload.p05 <= RESILIENCE_INTERVAL_SCORE_MAX &&
    payload.p95 >= RESILIENCE_INTERVAL_SCORE_MIN &&
    payload.p95 <= RESILIENCE_INTERVAL_SCORE_MAX &&
    payload.p05 <= payload.p95
  );
}

function evaluateDataProbe(cfg, raw) {
  if (!cfg) return null;
  const requiredFormula = cfg.formula ?? null;
  if (!raw) {
    return {
      ok: false,
      status: 'data_missing',
      key: cfg.key,
      requiredMethodology: cfg.methodology ?? null,
      requiredSourceVersion: cfg.sourceVersion ?? null,
      requiredFormula,
    };
  }

  const parsed = unwrapEnvelope(parseJsonValue(raw)).data;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      status: 'data_invalid',
      key: cfg.key,
      requiredMethodology: cfg.methodology ?? null,
      requiredSourceVersion: cfg.sourceVersion ?? null,
      requiredFormula,
    };
  }

  const methodology = typeof parsed.methodology === 'string' ? parsed.methodology : null;
  const formula = typeof parsed._formula === 'string' ? parsed._formula : null;
  if (cfg.methodology && methodology !== cfg.methodology) {
    return {
      ok: false,
      status: 'methodology_mismatch',
      key: cfg.key,
      methodology,
      formula,
      requiredMethodology: cfg.methodology,
      requiredSourceVersion: cfg.sourceVersion ?? null,
      requiredFormula,
    };
  }

  if (requiredFormula && formula !== requiredFormula) {
    return {
      ok: false,
      status: 'formula_mismatch',
      key: cfg.key,
      formula,
      requiredFormula,
      methodology,
      requiredMethodology: cfg.methodology ?? null,
      requiredSourceVersion: cfg.sourceVersion ?? null,
    };
  }

  if (cfg.kind === 'resilience_interval' && !isValidResilienceIntervalPayload(parsed)) {
    return {
      ok: false,
      status: 'data_invalid',
      key: cfg.key,
      formula,
      requiredFormula,
      methodology,
      requiredMethodology: cfg.methodology ?? null,
      requiredSourceVersion: cfg.sourceVersion ?? null,
      p05: typeof parsed.p05 === 'number' && Number.isFinite(parsed.p05) ? parsed.p05 : null,
      p95: typeof parsed.p95 === 'number' && Number.isFinite(parsed.p95) ? parsed.p95 : null,
    };
  }

  return {
    ok: true,
    status: 'ok',
    key: cfg.key,
    methodology,
    requiredMethodology: cfg.methodology ?? null,
    requiredSourceVersion: cfg.sourceVersion ?? null,
    formula,
    requiredFormula,
    computedAt: typeof parsed.computedAt === 'string' ? parsed.computedAt : null,
  };
}

async function getSeedBatch(entries) {
  const commands = [];
  const metaSlots = [];
  const probeSlots = [];
  for (const [domain, cfg] of entries) {
    metaSlots.push({ domain, key: cfg.key, index: commands.length });
    commands.push(['GET', cfg.key]);
    if (cfg.dataProbe?.key) {
      probeSlots.push({ domain, index: commands.length });
      commands.push(['GET', cfg.dataProbe.key]);
    }
  }

  const data = await redisPipeline(commands, 3000);
  if (!data) throw new Error('Redis not configured');

  const metaMap = new Map();
  const probeMap = new Map();
  for (const slot of metaSlots) {
    const raw = data[slot.index]?.result;
    if (raw) {
      const parsed = parseJsonValue(raw);
      if (parsed) metaMap.set(slot.key, parsed);
    }
  }
  for (const slot of probeSlots) {
    probeMap.set(slot.domain, data[slot.index]?.result ?? null);
  }
  return { metaMap, probeMap };
}

export default async function handler(req) {
  if (isDisallowedOrigin(req))
    return new Response('Forbidden', { status: 403 });

  const cors = getCorsHeaders(req);
  if (req.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: cors });

  const apiKeyResult = await validateApiKey(req);
  if (apiKeyResult.required && !apiKeyResult.valid)
    return jsonResponse({ error: apiKeyResult.error }, 401, cors);

  const now = Date.now();
  const entries = Object.entries(SEED_DOMAINS);

  let metaMap;
  let probeMap;
  try {
    ({ metaMap, probeMap } = await getSeedBatch(entries));
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
      if (cfg.minRecordCount != null) seeds[domain].minRecordCount = cfg.minRecordCount;
      missingCount++;
      continue;
    }

    const ageMs = now - (meta.fetchedAt || 0);
    const recordCount = parseFiniteRecordCount(meta.recordCount);
    const coveragePartial = cfg.minRecordCount != null && (recordCount == null || recordCount < cfg.minRecordCount);
    const isError = meta.status === 'error';
    const probe = evaluateDataProbe(cfg.dataProbe, probeMap.get(domain));
    const sourceMismatch = Boolean(
      cfg.dataProbe?.sourceVersion &&
      typeof meta.sourceVersion === 'string' &&
      meta.sourceVersion !== '' &&
      meta.sourceVersion !== cfg.dataProbe.sourceVersion
    );
    const stale = ageMs > maxStalenessMs || coveragePartial || isError || sourceMismatch || probe?.ok === false;
    if (stale) staleCount++;

    seeds[domain] = {
      status: isError
        ? 'error'
        : sourceMismatch
          ? 'source_version_mismatch'
          : probe?.ok === false
            ? probe.status
            : coveragePartial
              ? 'coverage_partial'
              : stale
              ? 'stale'
              : 'ok',
      fetchedAt: meta.fetchedAt,
      recordCount: recordCount ?? meta.recordCount ?? null,
      sourceVersion: meta.sourceVersion || null,
      ageMinutes: Math.round(ageMs / 60000),
      stale,
    };
    if (cfg.minRecordCount != null) seeds[domain].minRecordCount = cfg.minRecordCount;
    if (probe) seeds[domain].dataProbe = probe;
  }

  const overall = missingCount > 0 ? 'degraded' : staleCount > 0 ? 'warning' : 'healthy';

  const httpStatus = overall === 'healthy' ? 200 : overall === 'warning' ? 200 : 503;

  return jsonResponse({ overall, seeds, checkedAt: now }, httpStatus, {
    ...cors,
    'Cache-Control': 'no-cache',
  });
}
