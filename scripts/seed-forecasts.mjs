#!/usr/bin/env node

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadEnvFile, runSeed, CHROME_UA } from './_seed-utils.mjs';
import { tagRegions } from './_prediction-scoring.mjs';
import { resolveR2StorageConfig, putR2JsonObject, getR2JsonObject } from './_r2-storage.mjs';

const _isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (_isDirectRun) loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'forecast:predictions:v2';
const PRIOR_KEY = 'forecast:predictions:prior:v2';
const HISTORY_KEY = 'forecast:predictions:history:v1';
const TTL_SECONDS = 4800; // 80min (cron runs hourly, 20min buffer for cold start + LLM latency)
const HISTORY_MAX_RUNS = 200;
const HISTORY_MAX_FORECASTS = 25;
const HISTORY_TTL_SECONDS = 45 * 24 * 60 * 60;
const TRACE_LATEST_KEY = 'forecast:trace:latest:v1';
const TRACE_RUNS_KEY = 'forecast:trace:runs:v1';
const TRACE_RUNS_MAX = 50;
const TRACE_REDIS_TTL_SECONDS = 60 * 24 * 60 * 60;
const WORLD_STATE_HISTORY_LIMIT = 6;
const PUBLISH_MIN_PROBABILITY = 0;
const PANEL_MIN_PROBABILITY = 0.1;
const ENRICHMENT_COMBINED_MAX = 3;
const ENRICHMENT_SCENARIO_MAX = 3;
const ENRICHMENT_MAX_PER_DOMAIN = 2;
const ENRICHMENT_MIN_READINESS = 0.34;
const ENRICHMENT_PRIORITY_DOMAINS = ['market', 'military'];
const CYBER_MIN_THREATS_PER_COUNTRY = 5;
const CYBER_MAX_FORECASTS = 12;
const CYBER_SCORE_TYPE_MULTIPLIER = 1.5;    // bonus per distinct threat type
const CYBER_SCORE_CRITICAL_MULTIPLIER = 0.75; // bonus per critical-class threat
const CYBER_PROB_MAX = 0.72;                // probability ceiling for cyber forecasts
const CYBER_PROB_VOLUME_WEIGHT = 0.5;       // weight of volume in probability formula
const CYBER_PROB_TYPE_WEIGHT = 0.15;        // weight of type diversity in probability formula
const MAX_MILITARY_SURGE_AGE_MS = 3 * 60 * 60 * 1000;
const MAX_MILITARY_BUNDLE_DRIFT_MS = 5 * 60 * 1000;

const THEATER_IDS = [
  'iran-theater', 'taiwan-theater', 'baltic-theater',
  'blacksea-theater', 'korea-theater', 'south-china-sea',
  'east-med-theater', 'israel-gaza-theater', 'yemen-redsea-theater',
];

const THEATER_REGIONS = {
  'iran-theater': 'Middle East',
  'taiwan-theater': 'Western Pacific',
  'baltic-theater': 'Northern Europe',
  'blacksea-theater': 'Black Sea',
  'korea-theater': 'Korean Peninsula',
  'south-china-sea': 'South China Sea',
  'east-med-theater': 'Eastern Mediterranean',
  'israel-gaza-theater': 'Israel/Gaza',
  'yemen-redsea-theater': 'Red Sea',
};

const THEATER_LABELS = {
  'iran-theater': 'Iran Theater',
  'taiwan-theater': 'Taiwan Strait',
  'baltic-theater': 'Baltic Theater',
  'blacksea-theater': 'Black Sea',
  'korea-theater': 'Korean Peninsula',
  'south-china-sea': 'South China Sea',
  'east-med-theater': 'Eastern Mediterranean',
  'israel-gaza-theater': 'Israel/Gaza',
  'yemen-redsea-theater': 'Yemen/Red Sea',
};

const THEATER_EXPECTED_ACTORS = {
  'taiwan-theater': { countries: ['China'], operators: ['plaaf', 'plan'] },
  'south-china-sea': { countries: ['China', 'USA', 'Japan', 'Philippines'], operators: ['plaaf', 'plan', 'usaf', 'usn'] },
  'korea-theater': { countries: ['USA', 'South Korea', 'China', 'Japan'], operators: ['usaf', 'usn', 'plaaf'] },
  'baltic-theater': { countries: ['NATO', 'USA', 'UK', 'Germany'], operators: ['nato', 'usaf', 'raf', 'gaf'] },
  'blacksea-theater': { countries: ['Russia', 'NATO', 'Turkey'], operators: ['vks', 'nato'] },
  'iran-theater': { countries: ['Iran', 'USA', 'Israel', 'UK'], operators: ['usaf', 'raf', 'iaf'] },
};

const CHOKEPOINT_COMMODITIES = {
  'Middle East': { commodity: 'Oil', sensitivity: 0.8 },
  'Red Sea': { commodity: 'Shipping/Oil', sensitivity: 0.7 },
  'Israel/Gaza': { commodity: 'Gas/Oil', sensitivity: 0.5 },
  'Eastern Mediterranean': { commodity: 'Gas', sensitivity: 0.4 },
  'Western Pacific': { commodity: 'Semiconductors', sensitivity: 0.9 },
  'South China Sea': { commodity: 'Trade goods', sensitivity: 0.6 },
  'Black Sea': { commodity: 'Grain/Energy', sensitivity: 0.7 },
};

const CHOKEPOINT_MARKET_REGIONS = {
  'Strait of Hormuz': 'Middle East',
  'Bab el-Mandeb': 'Red Sea',
  'Suez Canal': 'Red Sea',
  'Taiwan Strait': 'Western Pacific',
  'Strait of Malacca': 'South China Sea',
  'Kerch Strait': 'Black Sea',
  'Bosporus Strait': 'Black Sea',
};

const REGION_KEYWORDS = {
  'Middle East': ['mena'],
  'Red Sea': ['mena'],
  'Israel/Gaza': ['mena'],
  'Eastern Mediterranean': ['mena', 'eu'],
  'Western Pacific': ['asia'],
  'South China Sea': ['asia'],
  'Black Sea': ['eu'],
  'Korean Peninsula': ['asia'],
  'Northern Europe': ['eu'],
};

const TEXT_STOPWORDS = new Set([
  'will', 'what', 'when', 'where', 'which', 'this', 'that', 'these', 'those',
  'from', 'into', 'onto', 'over', 'under', 'after', 'before', 'through', 'across',
  'about', 'against', 'near', 'amid', 'during', 'with', 'without', 'between',
  'price', 'prices', 'impact', 'risk', 'forecast', 'future', 'major', 'minor',
  'current', 'latest', 'over', 'path', 'case', 'signal', 'signals',
  'would', 'could', 'should', 'might', 'their', 'there', 'than', 'them',
  'market', 'markets', 'political', 'military', 'conflict', 'supply', 'chain',
  'infrastructure', 'cyber', 'active', 'armed', 'instability', 'escalation',
  'disruption', 'concentration',
]);

const FORECAST_DOMAINS = [
  'conflict',
  'market',
  'supply_chain',
  'political',
  'military',
  'cyber',
  'infrastructure',
];

function getRedisCredentials() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
  return { url, token };
}

async function redisCommand(url, token, command) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Redis command failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }
  return resp.json();
}

async function redisGet(url, token, key) {
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data?.result) return null;
  try { return JSON.parse(data.result); } catch { return null; }
}

// ── Phase 4: Input normalizers ──────────────────────────────
function normalizeChokepoints(raw) {
  if (!raw?.chokepoints && !raw?.corridors) return raw;
  const items = raw.chokepoints || raw.corridors || [];
  return {
    ...raw,
    chokepoints: items.map(cp => ({
      ...cp,
      region: cp.name || cp.region || '',
      riskScore: cp.disruptionScore ?? cp.riskScore ?? 0,
      riskLevel: cp.status === 'red' ? 'critical' : cp.status === 'yellow' ? 'high' : cp.riskLevel || 'normal',
      disrupted: cp.status === 'red' || cp.disrupted || false,
    })),
  };
}

function normalizeGpsJamming(raw) {
  if (!raw) return raw;
  if (raw.hexes && !raw.zones) return { ...raw, zones: raw.hexes };
  return raw;
}

async function warmPingChokepoints() {
  const baseUrl = process.env.WM_API_BASE_URL;
  if (!baseUrl) { console.log('  [Chokepoints] Warm-ping skipped (no WM_API_BASE_URL)'); return; }
  try {
    const resp = await fetch(`${baseUrl}/api/supply-chain/v1/get-chokepoint-status`, {
      headers: { 'User-Agent': CHROME_UA, Origin: 'https://worldmonitor.app' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) console.warn(`  [Chokepoints] Warm-ping failed: HTTP ${resp.status}`);
    else console.log('  [Chokepoints] Warm-ping OK');
  } catch (err) { console.warn(`  [Chokepoints] Warm-ping error: ${err.message}`); }
}

async function readInputKeys() {
  const { url, token } = getRedisCredentials();
  const keys = [
    'risk:scores:sebuf:stale:v1',
    'temporal:anomalies:v1',
    'theater_posture:sebuf:stale:v1',
    'military:forecast-inputs:stale:v1',
    'prediction:markets-bootstrap:v1',
    'supply_chain:chokepoints:v4',
    'conflict:iran-events:v1',
    'conflict:ucdp-events:v1',
    'unrest:events:v1',
    'infra:outages:v1',
    'cyber:threats-bootstrap:v2',
    'intelligence:gpsjam:v2',
    'news:insights:v1',
    'news:digest:v1:full:en',
  ];
  const pipeline = keys.map(k => ['GET', k]);
  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(pipeline),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Redis pipeline failed: ${resp.status}`);
  const results = await resp.json();

  const parse = (i) => {
    try { return results[i]?.result ? JSON.parse(results[i].result) : null; } catch { return null; }
  };

  return {
    ciiScores: parse(0),
    temporalAnomalies: parse(1),
    theaterPosture: parse(2),
    militaryForecastInputs: parse(3),
    predictionMarkets: parse(4),
    chokepoints: normalizeChokepoints(parse(5)),
    iranEvents: parse(6),
    ucdpEvents: parse(7),
    unrestEvents: parse(8),
    outages: parse(9),
    cyberThreats: parse(10),
    gpsJamming: normalizeGpsJamming(parse(11)),
    newsInsights: parse(12),
    newsDigest: parse(13),
  };
}

function forecastId(domain, region, title) {
  const hash = crypto.createHash('sha256')
    .update(`${domain}:${region}:${title}`)
    .digest('hex').slice(0, 8);
  return `fc-${domain}-${hash}`;
}

function normalize(value, min, max) {
  if (max <= min) return 0;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

function getFreshMilitaryForecastInputs(inputs, now = Date.now()) {
  const bundle = inputs?.militaryForecastInputs;
  if (!bundle || typeof bundle !== 'object') return null;

  const fetchedAt = Number(bundle.fetchedAt || 0);
  if (!fetchedAt || now - fetchedAt > MAX_MILITARY_SURGE_AGE_MS) return null;

  const theaters = Array.isArray(bundle.theaters) ? bundle.theaters : [];
  const surges = Array.isArray(bundle.surges) ? bundle.surges : [];

  const isAligned = (value) => {
    const ts = Number(value || 0);
    if (!ts) return true;
    return Math.abs(ts - fetchedAt) <= MAX_MILITARY_BUNDLE_DRIFT_MS;
  };

  if (!theaters.every((theater) => isAligned(theater?.assessedAt))) return null;
  if (!surges.every((surge) => isAligned(surge?.assessedAt))) return null;

  return bundle;
}

function selectPrimaryMilitarySurge(_theaterId, surges) {
  const typePriority = { fighter: 3, airlift: 2, air_activity: 1 };
  return surges
    .slice()
    .sort((a, b) => {
      const aScore = (typePriority[a.surgeType] || 0) * 10
        + (a.persistent ? 5 : 0)
        + (a.persistenceCount || 0) * 2
        + (a.strikeCapable ? 2 : 0)
        + (a.awacs > 0 || a.tankers > 0 ? 1 : 0)
        + (a.surgeMultiple || 0);
      const bScore = (typePriority[b.surgeType] || 0) * 10
        + (b.persistent ? 5 : 0)
        + (b.persistenceCount || 0) * 2
        + (b.strikeCapable ? 2 : 0)
        + (b.awacs > 0 || b.tankers > 0 ? 1 : 0)
        + (b.surgeMultiple || 0);
      return bScore - aScore;
    })[0] || null;
}

function computeTheaterActorScore(theaterId, surge) {
  if (!surge) return 0;
  const expected = THEATER_EXPECTED_ACTORS[theaterId];
  if (!expected) return 0;

  const dominantCountry = surge.dominantCountry || '';
  const dominantOperator = surge.dominantOperator || '';
  const countryMatch = dominantCountry && expected.countries.includes(dominantCountry);
  const operatorMatch = dominantOperator && expected.operators.includes(dominantOperator);

  if (countryMatch || operatorMatch) return 0.12;
  if (dominantCountry || dominantOperator) return -0.12;
  return 0;
}

function canPromoteMilitarySurge(posture, surge) {
  if (!surge) return false;
  if (surge.surgeType !== 'air_activity') return true;
  if (posture === 'critical' || posture === 'elevated') return true;
  if (surge.persistent || surge.surgeMultiple >= 3.5) return true;
  if (surge.strikeCapable || surge.fighters >= 4 || surge.awacs > 0 || surge.tankers > 0) return true;
  return false;
}

function buildMilitaryForecastTitle(_theaterId, theaterLabel, surge) {
  if (!surge) return `Military posture escalation: ${theaterLabel}`;
  const countryPrefix = surge.dominantCountry ? `${surge.dominantCountry}-linked ` : '';
  if (surge.surgeType === 'fighter') return `${countryPrefix}fighter surge near ${theaterLabel}`;
  if (surge.surgeType === 'airlift') return `${countryPrefix}airlift surge near ${theaterLabel}`;
  return `Elevated military air activity near ${theaterLabel}`;
}

function resolveCountryName(raw) {
  if (!raw || raw.length > 3) return raw; // already a full name or long-form
  const codes = loadCountryCodes();
  return codes[raw]?.name || raw;
}

function makePrediction(domain, region, title, probability, confidence, timeHorizon, signals) {
  const now = Date.now();
  return {
    id: forecastId(domain, region, title),
    domain,
    region,
    title,
    scenario: '',
    feedSummary: '',
    probability: Math.round(Math.max(0, Math.min(1, probability)) * 1000) / 1000,
    confidence: Math.round(Math.max(0, Math.min(1, confidence)) * 1000) / 1000,
    timeHorizon,
    signals,
    cascades: [],
    trend: 'stable',
    priorProbability: 0,
    calibration: null,
    caseFile: null,
    createdAt: now,
    updatedAt: now,
  };
}

// Normalize CII data from sebuf proto format (server-side) to uniform shape.
// Server writes: { ciiScores: [{ region, combinedScore, trend: 'TREND_DIRECTION_RISING', components: {...} }] }
// Frontend computes: [{ code, name, score, level, trend: 'rising', components: { unrest, conflict, ... } }]
function normalizeCiiEntry(c) {
  const score = c.combinedScore ?? c.score ?? c.dynamicScore ?? 0;
  const code = c.region || c.code || '';
  const rawTrend = (c.trend || '').toLowerCase();
  const trend = rawTrend.includes('rising') ? 'rising'
    : rawTrend.includes('falling') ? 'falling'
    : 'stable';
  const level = score >= 81 ? 'critical' : score >= 66 ? 'high' : score >= 51 ? 'elevated' : score >= 31 ? 'normal' : 'low';
  const unrestCandidates = [
    c.components?.unrest,
    c.components?.protest,
    c.components?.geoConvergence,
    c.components?.ciiContribution,
    c.components?.newsActivity,
  ].filter(value => typeof value === 'number' && Number.isFinite(value));
  const unrest = unrestCandidates.length > 0 ? Math.max(...unrestCandidates) : 0;
  // Resolve ISO code to full country name (prevents substring false positives: IL matching Chile)
  let name = c.name || '';
  if (!name && code) {
    const codes = loadCountryCodes();
    name = codes[code]?.name || code;
  }
  return { code, name, score, level, trend, change24h: c.change24h ?? 0, components: { ...c.components, unrest } };
}

function resolveChokepointMarketRegion(cp) {
  const rawRegion = cp.region || cp.name || '';
  if (!rawRegion) return null;
  if (CHOKEPOINT_COMMODITIES[rawRegion]) return rawRegion;
  return CHOKEPOINT_MARKET_REGIONS[rawRegion] || null;
}

function extractCiiScores(inputs) {
  const raw = inputs.ciiScores;
  if (!raw) return [];
  // sebuf proto: { ciiScores: [...] }, frontend: array or { scores: [...] }
  const arr = Array.isArray(raw) ? raw : raw.ciiScores || raw.scores || [];
  return arr.map(normalizeCiiEntry);
}

function detectConflictScenarios(inputs) {
  const predictions = [];
  const scores = extractCiiScores(inputs);
  const theaters = inputs.theaterPosture?.theaters || [];
  const iran = Array.isArray(inputs.iranEvents) ? inputs.iranEvents : inputs.iranEvents?.events || [];
  const ucdp = Array.isArray(inputs.ucdpEvents) ? inputs.ucdpEvents : inputs.ucdpEvents?.events || [];

  for (const c of scores) {
    if (!c.score || c.score <= 60) continue;
    if (c.level !== 'high' && c.level !== 'critical') continue;

    const signals = [
      { type: 'cii', value: `${c.name} CII ${c.score} (${c.level})`, weight: 0.4 },
    ];
    let sourceCount = 1;

    if (c.change24h && Math.abs(c.change24h) > 2) {
      signals.push({ type: 'cii_delta', value: `24h change ${c.change24h > 0 ? '+' : ''}${c.change24h.toFixed(1)}`, weight: 0.2 });
      sourceCount++;
    }

    // Use word-boundary regex to prevent substring false positives (IL matching Chile)
    const countryName = c.name.toLowerCase();
    const countryCode = c.code.toLowerCase();
    const matchRegex = new RegExp(`\\b(${countryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|${countryCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`, 'i');
    const matchingIran = iran.filter(e => matchRegex.test(e.country || e.location || ''));
    if (matchingIran.length > 0) {
      signals.push({ type: 'conflict_events', value: `${matchingIran.length} Iran-related events`, weight: 0.2 });
      sourceCount++;
    }

    const matchingUcdp = ucdp.filter(e => matchRegex.test(e.country || e.location || ''));
    if (matchingUcdp.length > 0) {
      signals.push({ type: 'ucdp', value: `${matchingUcdp.length} UCDP events`, weight: 0.2 });
      sourceCount++;
    }

    const ciiNorm = normalize(c.score, 50, 100);
    const eventBoost = (matchingIran.length + matchingUcdp.length) > 0 ? 0.1 : 0;
    const prob = Math.min(0.9, ciiNorm * 0.6 + eventBoost + (c.trend === 'rising' ? 0.1 : 0));
    const confidence = Math.max(0.3, normalize(sourceCount, 0, 4));

    predictions.push(makePrediction(
      'conflict', c.name,
      `Escalation risk: ${c.name}`,
      prob, confidence, '7d', signals,
    ));
  }

  for (const t of theaters) {
    const theaterId = t?.id || t?.theater;
    if (!theaterId) continue;
    const posture = t.postureLevel || t.posture || '';
    if (posture !== 'critical' && posture !== 'elevated') continue;
    const region = THEATER_REGIONS[theaterId] || t.name || theaterId;
    const alreadyCovered = predictions.some(p => p.region === region);
    if (alreadyCovered) continue;

    const signals = [
      { type: 'theater', value: `${t.name || theaterId} posture: ${posture}`, weight: 0.5 },
    ];
    const prob = posture === 'critical' ? 0.65 : 0.4;

    predictions.push(makePrediction(
      'conflict', region,
      `Theater escalation: ${region}`,
      prob, 0.5, '7d', signals,
    ));
  }

  return predictions;
}

function detectMarketScenarios(inputs) {
  const predictions = [];
  const chokepoints = inputs.chokepoints?.routes || inputs.chokepoints?.chokepoints || [];
  const scores = extractCiiScores(inputs);

  const affectedRegions = new Set();

  for (const cp of chokepoints) {
    const risk = cp.riskLevel || cp.risk || '';
    if (risk !== 'high' && risk !== 'critical' && (cp.riskScore || 0) < 60) continue;
    const region = resolveChokepointMarketRegion(cp);
    if (!region) continue;

    const commodity = CHOKEPOINT_COMMODITIES[region];
    if (!commodity) continue;

    if (affectedRegions.has(region)) continue;
    affectedRegions.add(region);

    const riskNorm = normalize(cp.riskScore || (risk === 'critical' ? 85 : 70), 40, 100);
    const prob = Math.min(0.85, riskNorm * commodity.sensitivity);

    predictions.push(makePrediction(
      'market', region,
      `${commodity.commodity} price impact from ${(cp.name || cp.region || region)} disruption`,
      prob, 0.6, '30d',
      [{ type: 'chokepoint', value: `${cp.name || region} risk: ${risk}`, weight: 0.5 },
       { type: 'commodity', value: `${commodity.commodity} sensitivity: ${commodity.sensitivity}`, weight: 0.3 }],
    ));
  }

  // Map high-CII countries to their commodity-sensitive theater via entity graph
  const graph = loadEntityGraph();
  for (const c of scores) {
    if (!c.score || c.score <= 75) continue;
    const countryName = c.name || resolveCountryName(c.code || '') || c.code;
    // Find theater region: check entity graph links for theater nodes with commodity sensitivity
    const nodeId = graph.aliases?.[c.code] || graph.aliases?.[c.name];
    const node = nodeId ? graph.nodes?.[nodeId] : null;
    let region = null;
    if (node) {
      for (const linkId of node.links || []) {
        const linked = graph.nodes?.[linkId];
        if (linked?.type === 'theater' && CHOKEPOINT_COMMODITIES[linked.name]) {
          region = linked.name;
          break;
        }
      }
    }
    // Fallback: direct theater region lookup
    if (!region) {
      const matchedTheater = Object.entries(THEATER_REGIONS).find(([id]) => {
        const theaterId = graph.aliases?.[c.name] || graph.aliases?.[c.code];
        return theaterId && graph.nodes?.[theaterId]?.links?.includes(id);
      });
      region = matchedTheater ? THEATER_REGIONS[matchedTheater[0]] : null;
    }
    if (!region || affectedRegions.has(region)) continue;

    const commodity = CHOKEPOINT_COMMODITIES[region];
    if (!commodity) continue;
    affectedRegions.add(region);

    const prob = Math.min(0.7, normalize(c.score, 60, 100) * commodity.sensitivity * 0.8);
    predictions.push(makePrediction(
      'market', region,
      `${commodity.commodity} volatility from ${countryName} instability`,
      prob, 0.4, '30d',
      [{ type: 'cii', value: `${countryName} CII ${c.score}`, weight: 0.4 },
       { type: 'commodity', value: `${commodity.commodity} sensitivity: ${commodity.sensitivity}`, weight: 0.3 }],
    ));
  }

  return predictions;
}

function detectSupplyChainScenarios(inputs) {
  const predictions = [];
  const chokepoints = inputs.chokepoints?.routes || inputs.chokepoints?.chokepoints || [];
  const anomalies = Array.isArray(inputs.temporalAnomalies) ? inputs.temporalAnomalies : inputs.temporalAnomalies?.anomalies || [];
  const jamming = Array.isArray(inputs.gpsJamming) ? inputs.gpsJamming : inputs.gpsJamming?.zones || [];

  const seenRoutes = new Set();

  for (const cp of chokepoints) {
    const disrupted = cp.disrupted || cp.status === 'disrupted' || (cp.riskScore || 0) > 65;
    if (!disrupted) continue;

    const route = cp.route || cp.name || cp.region || '';
    if (!route || seenRoutes.has(route)) continue;
    seenRoutes.add(route);

    const signals = [
      { type: 'chokepoint', value: `${route} disruption detected`, weight: 0.5 },
    ];
    let sourceCount = 1;

    const aisGaps = anomalies.filter(a =>
      (a.type === 'ais_gaps' || a.type === 'ais_gap') &&
      (a.region || a.zone || '').toLowerCase().includes(route.toLowerCase()),
    );
    if (aisGaps.length > 0) {
      signals.push({ type: 'ais_gap', value: `${aisGaps.length} AIS gap anomalies near ${route}`, weight: 0.3 });
      sourceCount++;
    }

    const nearbyJam = jamming.filter(j =>
      (j.region || j.zone || j.name || '').toLowerCase().includes(route.toLowerCase()),
    );
    if (nearbyJam.length > 0) {
      signals.push({ type: 'gps_jamming', value: `GPS interference near ${route}`, weight: 0.2 });
      sourceCount++;
    }

    const riskNorm = normalize(cp.riskScore || 70, 40, 100);
    const prob = Math.min(0.85, riskNorm * 0.7 + (aisGaps.length > 0 ? 0.1 : 0) + (nearbyJam.length > 0 ? 0.05 : 0));
    const confidence = Math.max(0.3, normalize(sourceCount, 0, 4));

    predictions.push(makePrediction(
      'supply_chain', cp.region || route,
      `Supply chain disruption: ${route}`,
      prob, confidence, '7d', signals,
    ));
  }

  return predictions;
}

function detectPoliticalScenarios(inputs) {
  const predictions = [];
  const scores = extractCiiScores(inputs);
  const anomalies = Array.isArray(inputs.temporalAnomalies) ? inputs.temporalAnomalies : inputs.temporalAnomalies?.anomalies || [];
  const unrestEvents = Array.isArray(inputs.unrestEvents) ? inputs.unrestEvents : inputs.unrestEvents?.events || [];
  const unrestCounts = new Map();

  for (const event of unrestEvents) {
    const country = resolveCountryName(event.country || event.country_name || event.region || event.location || '');
    if (!country) continue;
    unrestCounts.set(country, (unrestCounts.get(country) || 0) + 1);
  }

  for (const c of scores) {
    if (!c.components) continue;
    const unrestComp = c.components.unrest ?? 0;
    const unrestCount = unrestCounts.get(c.name) || 0;
    if (unrestComp <= 50 && unrestCount < 3) continue;
    if (c.score >= 80) continue;

    const countryName = c.name.toLowerCase();
    const signals = [
      { type: 'unrest', value: `${c.name} unrest component: ${Math.max(unrestComp, unrestCount * 10)}`, weight: 0.4 },
    ];
    let sourceCount = 1;

    if (unrestCount > 0) {
      signals.push({ type: 'unrest_events', value: `${unrestCount} unrest events in ${c.name}`, weight: 0.3 });
      sourceCount++;
    }

    const protestAnomalies = anomalies.filter(a =>
      (a.type === 'protest' || a.type === 'unrest') &&
      (a.country || a.region || '').toLowerCase().includes(countryName),
    );
    if (protestAnomalies.length > 0) {
      const maxZ = Math.max(...protestAnomalies.map(a => a.zScore || a.z_score || 0));
      signals.push({ type: 'anomaly', value: `Protest anomaly z-score: ${maxZ.toFixed(1)}`, weight: 0.3 });
      sourceCount++;
    }

    const unrestNorm = normalize(Math.max(unrestComp, unrestCount * 10), 30, 100);
    const anomalyBoost = protestAnomalies.length > 0 ? 0.1 : 0;
    const eventBoost = unrestCount >= 5 ? 0.08 : unrestCount >= 3 ? 0.04 : 0;
    const prob = Math.min(0.8, unrestNorm * 0.6 + anomalyBoost + eventBoost);
    const confidence = Math.max(0.3, normalize(sourceCount, 0, 4));

    predictions.push(makePrediction(
      'political', c.name,
      `Political instability: ${c.name}`,
      prob, confidence, '30d', signals,
    ));
  }

  return predictions;
}

function detectMilitaryScenarios(inputs) {
  const predictions = [];
  const militaryInputs = getFreshMilitaryForecastInputs(inputs);
  const theaters = militaryInputs?.theaters || [];
  const anomalies = Array.isArray(inputs.temporalAnomalies) ? inputs.temporalAnomalies : inputs.temporalAnomalies?.anomalies || [];
  const surgeItems = Array.isArray(militaryInputs) ? militaryInputs : militaryInputs?.surges || [];
  const theatersById = new Map(theaters.map((theater) => [(theater?.id || theater?.theater), theater]).filter(([theaterId]) => !!theaterId));
  const surgesByTheater = new Map();

  for (const surge of surgeItems) {
    if (!surge?.theaterId) continue;
    const list = surgesByTheater.get(surge.theaterId) || [];
    list.push(surge);
    surgesByTheater.set(surge.theaterId, list);
  }

  const theaterIds = new Set([
    ...Array.from(theatersById.keys()),
    ...Array.from(surgesByTheater.keys()),
  ]);

  for (const theaterId of theaterIds) {
    const t = theatersById.get(theaterId);
    const theaterSurges = surgesByTheater.get(theaterId) || [];
    if (!theaterId) continue;
    const posture = t?.postureLevel || t?.posture || '';
    const highestSurge = selectPrimaryMilitarySurge(theaterId, theaterSurges);
    const surgeIsUsable = canPromoteMilitarySurge(posture, highestSurge);
    if (posture !== 'elevated' && posture !== 'critical' && !surgeIsUsable) continue;

    const region = THEATER_REGIONS[theaterId] || t?.name || theaterId;
    const theaterLabel = THEATER_LABELS[theaterId] || t?.name || theaterId;
    const signals = [];
    let sourceCount = 0;
    const actorScore = computeTheaterActorScore(theaterId, highestSurge);
    const persistent = !!highestSurge?.persistent || (highestSurge?.surgeMultiple || 0) >= 3.5;

    if (posture === 'elevated' || posture === 'critical') {
      signals.push({ type: 'theater', value: `${theaterLabel} posture: ${posture}`, weight: 0.45 });
      sourceCount++;
    }

    const milFlights = anomalies.filter(a =>
      (a.type === 'military_flights' || a.type === 'military') &&
      [region, theaterLabel, theaterId].some((part) => part && (a.region || a.theater || '').toLowerCase().includes(part.toLowerCase())),
    );
    if (milFlights.length > 0) {
      const maxZ = Math.max(...milFlights.map(a => a.zScore || a.z_score || 0));
      signals.push({ type: 'mil_flights', value: `Military flight anomaly z-score: ${maxZ.toFixed(1)}`, weight: 0.3 });
      sourceCount++;
    }

    if (highestSurge) {
      signals.push({
        type: 'mil_surge',
        value: `${highestSurge.surgeType} surge in ${theaterLabel}: ${highestSurge.currentCount} vs ${highestSurge.baselineCount} baseline (${highestSurge.surgeMultiple}x)`,
        weight: 0.4,
      });
      sourceCount++;
      if (highestSurge.dominantCountry) {
        signals.push({
          type: 'operator',
          value: `${highestSurge.dominantCountry} accounts for ${highestSurge.dominantCountryCount} flights in ${theaterLabel}`,
          weight: 0.2,
        });
        sourceCount++;
      }
      if (highestSurge.awacs > 0 || highestSurge.tankers > 0) {
        signals.push({
          type: 'support_aircraft',
          value: `${highestSurge.tankers} tankers and ${highestSurge.awacs} AWACS active in ${theaterLabel}`,
          weight: 0.15,
        });
        sourceCount++;
      }
      if (highestSurge.persistenceCount > 0) {
        signals.push({
          type: 'persistence',
          value: `${highestSurge.persistenceCount} prior run(s) in ${theaterLabel} were already above baseline`,
          weight: 0.18,
        });
        sourceCount++;
      }
      if (actorScore > 0) {
        signals.push({
          type: 'theater_actor_fit',
          value: `${highestSurge.dominantCountry || highestSurge.dominantOperator} aligns with expected actors in ${theaterLabel}`,
          weight: 0.16,
        });
        sourceCount++;
      }
    }

    if (t?.indicators && Array.isArray(t.indicators)) {
      const activeIndicators = t.indicators.filter(i => i.active || i.triggered);
      if (activeIndicators.length > 0) {
        signals.push({ type: 'indicators', value: `${activeIndicators.length} active posture indicators`, weight: 0.2 });
        sourceCount++;
      }
    }

    const baseLine = highestSurge
      ? highestSurge.surgeType === 'fighter'
        ? Math.min(0.72, 0.42 + Math.max(0, ((highestSurge.surgeMultiple || 1) - 1) * 0.1))
        : highestSurge.surgeType === 'airlift'
          ? Math.min(0.58, 0.32 + Math.max(0, ((highestSurge.surgeMultiple || 1) - 1) * 0.08))
          : Math.min(0.42, 0.2 + Math.max(0, ((highestSurge.surgeMultiple || 1) - 1) * 0.05))
      : posture === 'critical' ? 0.6 : 0.35;
    const flightBoost = milFlights.length > 0 ? 0.1 : 0;
    const postureBoost = posture === 'critical' ? 0.12 : posture === 'elevated' ? 0.06 : 0;
    const supportBoost = highestSurge && (highestSurge.awacs > 0 || highestSurge.tankers > 0) ? 0.05 : 0;
    const strikeBoost = (t?.activeOperations?.includes?.('strike_capable') || highestSurge?.strikeCapable) ? 0.06 : 0;
    const persistenceBoost = persistent ? 0.08 : 0;
    const genericPenalty = highestSurge?.surgeType === 'air_activity' && !persistent ? 0.12 : 0;
    const prob = Math.min(0.9, Math.max(0.05, baseLine + flightBoost + postureBoost + supportBoost + strikeBoost + persistenceBoost + actorScore - genericPenalty));
    const confidence = Math.max(0.3, normalize(sourceCount, 0, 4));
    const title = highestSurge
      ? buildMilitaryForecastTitle(theaterId, theaterLabel, highestSurge)
      : `Military posture escalation: ${region}`;

    predictions.push(makePrediction(
      'military', region,
      title,
      prob, confidence, '7d', signals,
    ));
  }

  return predictions;
}

function detectInfraScenarios(inputs) {
  const predictions = [];
  const outages = Array.isArray(inputs.outages) ? inputs.outages : inputs.outages?.outages || [];
  const cyber = Array.isArray(inputs.cyberThreats) ? inputs.cyberThreats : inputs.cyberThreats?.threats || [];
  const jamming = Array.isArray(inputs.gpsJamming) ? inputs.gpsJamming : inputs.gpsJamming?.zones || [];

  for (const o of outages) {
    const rawSev = (o.severity || o.type || '').toLowerCase();
    // Handle both plain strings and proto enums (SEVERITY_LEVEL_HIGH, SEVERITY_LEVEL_CRITICAL)
    const severity = rawSev.includes('critical') ? 'critical'
      : rawSev.includes('high') ? 'major'
      : rawSev.includes('total') ? 'total'
      : rawSev.includes('major') ? 'major'
      : rawSev;
    if (severity !== 'major' && severity !== 'total' && severity !== 'critical') continue;

    const country = resolveCountryName(o.country || o.region || o.name || '');
    if (!country) continue;

    const countryLower = country.toLowerCase();
    const signals = [
      { type: 'outage', value: `${country} ${severity} outage`, weight: 0.4 },
    ];
    let sourceCount = 1;

    const relatedCyber = cyber.filter(t =>
      (t.country || t.target || t.region || '').toLowerCase().includes(countryLower),
    );
    if (relatedCyber.length > 0) {
      signals.push({ type: 'cyber', value: `${relatedCyber.length} cyber threats targeting ${country}`, weight: 0.3 });
      sourceCount++;
    }

    const nearbyJam = jamming.filter(j =>
      (j.country || j.region || j.name || '').toLowerCase().includes(countryLower),
    );
    if (nearbyJam.length > 0) {
      signals.push({ type: 'gps_jamming', value: `GPS interference in ${country}`, weight: 0.2 });
      sourceCount++;
    }

    const cyberBoost = relatedCyber.length > 0 ? 0.15 : 0;
    const jamBoost = nearbyJam.length > 0 ? 0.05 : 0;
    const baseLine = severity === 'total' ? 0.55 : 0.4;
    const prob = Math.min(0.85, baseLine + cyberBoost + jamBoost);
    const confidence = Math.max(0.3, normalize(sourceCount, 0, 4));

    predictions.push(makePrediction(
      'infrastructure', country,
      `Infrastructure cascade risk: ${country}`,
      prob, confidence, '24h', signals,
    ));
  }

  return predictions;
}

// ── Phase 4: Standalone detectors ───────────────────────────
function detectUcdpConflictZones(inputs) {
  const predictions = [];
  const ucdp = Array.isArray(inputs.ucdpEvents) ? inputs.ucdpEvents : inputs.ucdpEvents?.events || [];
  if (ucdp.length === 0) return predictions;

  const byCountry = {};
  for (const e of ucdp) {
    const country = e.country || e.country_name || '';
    if (!country) continue;
    byCountry[country] = (byCountry[country] || 0) + 1;
  }

  for (const [country, count] of Object.entries(byCountry)) {
    if (count < 10) continue;
    predictions.push(makePrediction(
      'conflict', country,
      `Active armed conflict: ${country}`,
      Math.min(0.85, normalize(count, 5, 100) * 0.7),
      0.3, '30d',
      [{ type: 'ucdp', value: `${count} UCDP conflict events`, weight: 0.5 }],
    ));
  }
  return predictions;
}

function detectCyberScenarios(inputs) {
  const predictions = [];
  const threats = Array.isArray(inputs.cyberThreats) ? inputs.cyberThreats : inputs.cyberThreats?.threats || [];
  if (threats.length < CYBER_MIN_THREATS_PER_COUNTRY) return predictions;

  const byCountry = {};
  for (const t of threats) {
    const country = resolveCountryName(t.country || t.target || t.region || '');
    if (!country) continue;
    if (!byCountry[country]) byCountry[country] = [];
    byCountry[country].push(t);
  }

  const candidates = [];
  for (const [country, items] of Object.entries(byCountry)) {
    if (items.length < CYBER_MIN_THREATS_PER_COUNTRY) continue;
    const types = new Set(items.map(t => t.type || t.category || 'unknown'));
    const criticalCount = items.filter((t) => /ransomware|wiper|ddos|intrusion|exploit|botnet|malware/i.test(`${t.type || ''} ${t.category || ''}`)).length;
    const score = items.length + (types.size * CYBER_SCORE_TYPE_MULTIPLIER) + (criticalCount * CYBER_SCORE_CRITICAL_MULTIPLIER);
    const probability = Math.min(CYBER_PROB_MAX, (normalize(items.length, 4, 50) * CYBER_PROB_VOLUME_WEIGHT) + (normalize(types.size, 1, 6) * CYBER_PROB_TYPE_WEIGHT));
    candidates.push({
      country,
      items,
      types,
      score,
      probability,
      confidence: Math.max(0.32, normalize(items.length + criticalCount, 4, 25) * 0.55),
    });
  }
  candidates
    .sort((a, b) => b.score - a.score || b.probability - a.probability || a.country.localeCompare(b.country))
    .slice(0, CYBER_MAX_FORECASTS)
    .forEach((candidate) => {
      predictions.push(makePrediction(
        'cyber', candidate.country,
        `Cyber threat concentration: ${candidate.country}`,
        candidate.probability,
        candidate.confidence,
        '7d',
        [{ type: 'cyber', value: `${candidate.items.length} threats (${[...candidate.types].join(', ')})`, weight: 0.5 }],
      ));
    });

  return predictions;
}

const MARITIME_REGIONS = {
  'Eastern Mediterranean': { latRange: [33, 37], lonRange: [25, 37] },
  'Red Sea': { latRange: [11, 22], lonRange: [32, 54] },
  'Persian Gulf': { latRange: [20, 32], lonRange: [45, 60] },
  'Black Sea': { latRange: [40, 48], lonRange: [26, 42] },
  'Baltic Sea': { latRange: [52, 65], lonRange: [10, 32] },
};

function detectGpsJammingScenarios(inputs) {
  const predictions = [];
  const zones = Array.isArray(inputs.gpsJamming) ? inputs.gpsJamming
    : inputs.gpsJamming?.zones || inputs.gpsJamming?.hexes || [];
  if (zones.length === 0) return predictions;

  for (const [region, bounds] of Object.entries(MARITIME_REGIONS)) {
    const inRegion = zones.filter(h => {
      const lat = h.lat || h.latitude || 0;
      const lon = h.lon || h.longitude || 0;
      return lat >= bounds.latRange[0] && lat <= bounds.latRange[1]
          && lon >= bounds.lonRange[0] && lon <= bounds.lonRange[1];
    });
    if (inRegion.length < 3) continue;
    predictions.push(makePrediction(
      'supply_chain', region,
      `GPS interference in ${region} shipping zone`,
      Math.min(0.6, normalize(inRegion.length, 2, 30) * 0.5),
      0.3, '7d',
      [{ type: 'gps_jamming', value: `${inRegion.length} jamming hexes in ${region}`, weight: 0.5 }],
    ));
  }
  return predictions;
}

const MARKET_TAG_TO_REGION = {
  mena: 'Middle East', eu: 'Europe', asia: 'Asia-Pacific',
  america: 'Americas', latam: 'Latin America', africa: 'Africa', oceania: 'Oceania',
};

const DOMAIN_HINTS = {
  conflict: ['conflict', 'war', 'strike', 'attack', 'ceasefire', 'offensive', 'military'],
  market: ['market', 'oil', 'gas', 'trade', 'tariff', 'inflation', 'recession', 'price', 'shipping', 'semiconductor'],
  supply_chain: ['shipping', 'supply', 'chokepoint', 'port', 'transit', 'freight', 'logistics', 'gps'],
  political: ['election', 'government', 'parliament', 'protest', 'unrest', 'leadership', 'coalition'],
  military: ['military', 'force', 'deployment', 'exercise', 'missile', 'carrier', 'bomber', 'air defense'],
  cyber: ['cyber', 'malware', 'ransomware', 'intrusion', 'ddos', 'phishing', 'exploit', 'botnet'],
  infrastructure: ['outage', 'blackout', 'power', 'grid', 'pipeline', 'cyber', 'telecom', 'internet'],
};

const DOMAIN_ACTOR_BLUEPRINTS = {
  conflict: [
    { key: 'state_command', name: 'Regional command authority', category: 'state', influenceScore: 0.88 },
    { key: 'security_forces', name: 'Security forces', category: 'security', influenceScore: 0.82 },
    { key: 'external_power', name: 'External power broker', category: 'external', influenceScore: 0.74 },
    { key: 'energy_market', name: 'Energy market participants', category: 'market', influenceScore: 0.58 },
  ],
  market: [
    { key: 'commodity_traders', name: 'Commodity traders', category: 'market', influenceScore: 0.84 },
    { key: 'policy_officials', name: 'Policy officials', category: 'state', influenceScore: 0.72 },
    { key: 'large_importers', name: 'Large importers', category: 'commercial', influenceScore: 0.68 },
    { key: 'regional_producers', name: 'Regional producers', category: 'commercial', influenceScore: 0.62 },
  ],
  supply_chain: [
    { key: 'shipping_operators', name: 'Shipping operators', category: 'commercial', influenceScore: 0.84 },
    { key: 'port_authorities', name: 'Port authorities', category: 'infrastructure', influenceScore: 0.71 },
    { key: 'cargo_owners', name: 'Major cargo owners', category: 'commercial', influenceScore: 0.67 },
    { key: 'marine_insurers', name: 'Marine insurers', category: 'market', influenceScore: 0.54 },
  ],
  political: [
    { key: 'incumbent_leadership', name: 'Incumbent leadership', category: 'state', influenceScore: 0.86 },
    { key: 'opposition_networks', name: 'Opposition networks', category: 'political', influenceScore: 0.69 },
    { key: 'regional_diplomats', name: 'Regional diplomats', category: 'external', influenceScore: 0.57 },
    { key: 'civil_society', name: 'Civil society blocs', category: 'civic', influenceScore: 0.49 },
  ],
  military: [
    { key: 'defense_planners', name: 'Defense planners', category: 'security', influenceScore: 0.86 },
    { key: 'allied_observers', name: 'Allied observers', category: 'external', influenceScore: 0.68 },
    { key: 'commercial_carriers', name: 'Commercial carriers', category: 'commercial', influenceScore: 0.51 },
    { key: 'regional_command', name: 'Regional command posts', category: 'security', influenceScore: 0.74 },
  ],
  cyber: [
    { key: 'cert_teams', name: 'National CERT teams', category: 'security', influenceScore: 0.83 },
    { key: 'critical_it', name: 'Critical IT operators', category: 'infrastructure', influenceScore: 0.74 },
    { key: 'threat_actors', name: 'Threat actors', category: 'adversarial', influenceScore: 0.69 },
    { key: 'platform_defenders', name: 'Platform defenders', category: 'commercial', influenceScore: 0.58 },
  ],
  infrastructure: [
    { key: 'grid_operators', name: 'Grid operators', category: 'infrastructure', influenceScore: 0.83 },
    { key: 'civil_protection', name: 'Civil protection authorities', category: 'state', influenceScore: 0.72 },
    { key: 'critical_providers', name: 'Critical service providers', category: 'commercial', influenceScore: 0.64 },
    { key: 'cyber_responders', name: 'Incident response teams', category: 'security', influenceScore: 0.59 },
  ],
};

const SIGNAL_TRIGGER_TEMPLATES = {
  cii: (pred, signal) => `Watch for another deterioration in ${pred.region} risk indicators beyond ${signal.value}.`,
  cii_delta: (pred) => `A further sharp 24h deterioration in ${pred.region} risk metrics would strengthen the base case.`,
  conflict_events: (pred) => `A fresh cluster of reported conflict events in ${pred.region} would raise escalation pressure quickly.`,
  ucdp: (pred) => `A sustained increase in verified conflict-event counts would confirm the escalation path in ${pred.region}.`,
  theater: (pred) => `Any shift from elevated to critical theater posture in ${pred.region} would move this forecast higher.`,
  indicators: (pred) => `More active posture indicators in ${pred.region} would support an escalatory revision.`,
  mil_flights: () => 'Another spike in military flight anomalies would strengthen the near-term risk path.',
  chokepoint: (_pred, signal) => `${signal.value} persisting for another cycle would deepen downstream disruption risk.`,
  ais_gap: () => 'Further AIS gaps around the affected route would confirm operational disruption rather than noise.',
  gps_jamming: () => 'Wider GPS interference across adjacent zones would increase the chance of spillover effects.',
  unrest: (pred) => `A higher unrest signal in ${pred.region} would raise the probability of instability broadening.`,
  anomaly: () => 'A new anomaly spike above the current protest baseline would strengthen the forecast.',
  outage: (pred) => `A second major outage in ${pred.region} would turn a contained event into a cascade risk.`,
  cyber: (pred) => `Additional cyber incidents tied to ${pred.region} infrastructure would materially worsen the case.`,
  prediction_market: () => 'A market repricing of 8-10 points would be a meaningful confirmation or rejection signal.',
  news_corroboration: (pred) => `More directly matched reporting on ${pred.region} would improve confidence in the current path.`,
};

function tokenizeText(text) {
  return (text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(token => token.length >= 3);
}

function uniqueLowerTerms(terms) {
  return [...new Set((terms || [])
    .map(term => (term || '').toLowerCase().trim())
    .filter(Boolean))];
}

function countTermMatches(text, terms) {
  const lower = (text || '').toLowerCase();
  let hits = 0;
  let score = 0;
  for (const term of uniqueLowerTerms(terms)) {
    if (term.length < 3) continue;
    if (!lower.includes(term)) continue;
    hits += 1;
    score += term.length > 8 ? 4 : term.length > 5 ? 3 : 2;
  }
  return { hits, score };
}

function extractMeaningfulTokens(text, exclude = []) {
  const excluded = new Set(uniqueLowerTerms(exclude)
    .flatMap(term => term.split(/[^a-z0-9]+/g))
    .filter(Boolean));
  return [...new Set(tokenizeText(text).filter(token =>
    token.length >= 4
    && !TEXT_STOPWORDS.has(token)
    && !excluded.has(token)
  ))];
}

function buildExpectedRegionTags(regionTerms, region) {
  return new Set([
    ...uniqueLowerTerms(regionTerms).flatMap(term => tagRegions(term)),
    ...(REGION_KEYWORDS[region] || []),
  ]);
}

function getDomainTerms(domain) {
  return DOMAIN_HINTS[domain] || [];
}

function computeHeadlineRelevance(headline, terms, domain, options = {}) {
  const lower = headline.toLowerCase();
  const regionTerms = uniqueLowerTerms(terms);
  const { hits: regionHits, score: regionScore } = countTermMatches(lower, regionTerms);
  const expectedTags = options.expectedTags instanceof Set
    ? options.expectedTags
    : buildExpectedRegionTags(regionTerms, options.region);
  const headlineTags = tagRegions(headline);
  const tagOverlap = headlineTags.some(tag => expectedTags.has(tag));
  const tagMismatch = headlineTags.length > 0 && expectedTags.size > 0 && !tagOverlap;
  let score = regionScore + (tagOverlap ? 3 : 0) - (tagMismatch ? 4 : 0);
  for (const hint of getDomainTerms(domain)) {
    if (lower.includes(hint)) score += 1;
  }
  const titleTokens = options.titleTokens || [];
  for (const token of titleTokens) {
    if (lower.includes(token)) score += 2;
  }
  if (options.requireRegion && regionHits === 0 && !tagOverlap) return 0;
  if (options.requireSemantic) {
    const domainHits = getDomainTerms(domain).filter(hint => lower.includes(hint)).length;
    const titleHits = titleTokens.filter(token => lower.includes(token)).length;
    if (domainHits === 0 && titleHits === 0) return 0;
  }
  return Math.max(0, score);
}

function computeMarketMatchScore(pred, marketTitle, regionTerms, options = {}) {
  const lower = marketTitle.toLowerCase();
  const { hits: regionHits, score: regionScore } = countTermMatches(lower, regionTerms);
  const expectedTags = options.expectedTags instanceof Set
    ? options.expectedTags
    : buildExpectedRegionTags(regionTerms, pred.region);
  const marketTags = tagRegions(marketTitle);
  const tagOverlap = marketTags.some(tag => expectedTags.has(tag));
  const tagMismatch = marketTags.length > 0 && expectedTags.size > 0 && !tagOverlap;
  let score = regionScore + (tagOverlap ? 2 : 0) - (tagMismatch ? 5 : 0);
  let domainHits = 0;
  for (const hint of getDomainTerms(pred.domain)) {
    if (lower.includes(hint)) {
      domainHits += 1;
      score += 1;
    }
  }
  let titleHits = 0;
  const titleTokens = options.titleTokens || extractMeaningfulTokens(pred.title, regionTerms);
  for (const token of titleTokens) {
    if (lower.includes(token)) {
      titleHits += 1;
      score += 2;
    }
  }
  return {
    score: Math.max(0, score),
    regionHits,
    domainHits,
    titleHits,
    tagOverlap,
    tagMismatch,
  };
}

function detectFromPredictionMarkets(inputs) {
  const predictions = [];
  const markets = inputs.predictionMarkets?.geopolitical || [];

  for (const m of markets) {
    const yesPrice = (m.yesPrice || 50) / 100;
    if (yesPrice < 0.6 || yesPrice > 0.9) continue;
    const tags = tagRegions(m.title);
    if (tags.length === 0) continue;
    const region = MARKET_TAG_TO_REGION[tags[0]] || tags[0];

    const titleLower = m.title.toLowerCase();
    const domain = titleLower.match(/war|strike|military|attack/) ? 'conflict'
      : titleLower.match(/tariff|recession|economy|gdp/) ? 'market'
      : 'political';

    predictions.push(makePrediction(
      domain, region,
      m.title.slice(0, 100),
      yesPrice, 0.7, '30d',
      [{ type: 'prediction_market', value: `${m.source || 'Polymarket'}: ${Math.round(yesPrice * 100)}%`, weight: 0.8 }],
    ));
  }
  return predictions.slice(0, 5);
}

// ── Phase 4: Entity graph ───────────────────────────────────
let _entityGraph = null;
function loadEntityGraph() {
  if (_entityGraph) return _entityGraph;
  try {
    const graphPath = new URL('./data/entity-graph.json', import.meta.url);
    _entityGraph = JSON.parse(readFileSync(graphPath, 'utf8'));
    console.log(`  [Graph] Loaded ${Object.keys(_entityGraph.nodes).length} nodes`);
    return _entityGraph;
  } catch (err) {
    console.warn(`  [Graph] Failed: ${err.message}`);
    return { nodes: {}, edges: [], aliases: {} };
  }
}

function discoverGraphCascades(predictions, graph) {
  if (!graph?.nodes || !graph?.aliases) return;
  for (const pred of predictions) {
    const nodeId = graph.aliases[pred.region];
    if (!nodeId) continue;
    const node = graph.nodes[nodeId];
    if (!node?.links) continue;

    for (const linkedId of node.links) {
      const linked = graph.nodes[linkedId];
      if (!linked) continue;
      const linkedPred = predictions.find(p =>
        p !== pred && p.domain !== pred.domain && graph.aliases[p.region] === linkedId
      );
      if (!linkedPred) continue;

      const edge = graph.edges.find(e =>
        (e.from === nodeId && e.to === linkedId) || (e.from === linkedId && e.to === nodeId)
      );
      const coupling = (edge?.weight || 0.3) * 0.5;
      pred.cascades.push({
        domain: linkedPred.domain,
        effect: `graph: ${edge?.relation || 'linked'} via ${linked.name}`,
        probability: Math.round(Math.min(0.6, pred.probability * coupling) * 1000) / 1000,
      });
    }
  }
}

// ── Phase 3: Data-driven cascade rules ─────────────────────
const DEFAULT_CASCADE_RULES = [
  { from: 'conflict', to: 'supply_chain', coupling: 0.6, mechanism: 'chokepoint disruption', requiresChokepoint: true },
  { from: 'conflict', to: 'market', coupling: 0.5, mechanism: 'commodity price shock', requiresChokepoint: true },
  { from: 'political', to: 'conflict', coupling: 0.4, mechanism: 'instability escalation', minProbability: 0.6 },
  { from: 'military', to: 'conflict', coupling: 0.5, mechanism: 'force deployment', requiresCriticalPosture: true },
  { from: 'supply_chain', to: 'market', coupling: 0.4, mechanism: 'supply shortage pricing' },
];

const PREDICATE_EVALUATORS = {
  requiresChokepoint: (pred) => !!CHOKEPOINT_COMMODITIES[pred.region],
  requiresCriticalPosture: (pred) => pred.signals.some(s => s.type === 'theater' && s.value.includes('critical')),
  minProbability: (pred, val) => pred.probability >= val,
  requiresSeverity: (pred, val) => pred.signals.some(s => s.type === 'outage' && s.value.toLowerCase().includes(val)),
};

function evaluateRuleConditions(rule, pred) {
  for (const [key, val] of Object.entries(rule)) {
    if (['from', 'to', 'coupling', 'mechanism'].includes(key)) continue;
    const evaluator = PREDICATE_EVALUATORS[key];
    if (!evaluator) continue;
    if (!evaluator(pred, val)) return false;
  }
  return true;
}

function loadCascadeRules() {
  try {
    const rulesPath = new URL('./data/cascade-rules.json', import.meta.url);
    const raw = JSON.parse(readFileSync(rulesPath, 'utf8'));
    if (!Array.isArray(raw)) throw new Error('cascade rules must be array');
    const KNOWN_FIELDS = new Set(['from', 'to', 'coupling', 'mechanism', ...Object.keys(PREDICATE_EVALUATORS)]);
    for (const r of raw) {
      if (!r.from || !r.to || typeof r.coupling !== 'number' || !r.mechanism) {
        throw new Error(`invalid rule: ${JSON.stringify(r)}`);
      }
      for (const key of Object.keys(r)) {
        if (!KNOWN_FIELDS.has(key)) throw new Error(`unknown predicate '${key}' in rule: ${r.mechanism}`);
      }
    }
    console.log(`  [Cascade] Loaded ${raw.length} rules from JSON`);
    return raw;
  } catch (err) {
    console.warn(`  [Cascade] Failed to load rules: ${err.message}, using defaults`);
    return DEFAULT_CASCADE_RULES;
  }
}

function resolveCascades(predictions, rules) {
  const seen = new Set();
  for (const rule of rules) {
    const sources = predictions.filter(p => p.domain === rule.from);
    for (const src of sources) {
      if (!evaluateRuleConditions(rule, src)) continue;
      const cascadeProb = Math.min(0.8, src.probability * rule.coupling);
      const key = `${src.id}:${rule.to}:${rule.mechanism}`;
      if (seen.has(key)) continue;
      seen.add(key);
      src.cascades.push({ domain: rule.to, effect: rule.mechanism, probability: +cascadeProb.toFixed(3) });
    }
  }
}

// ── Phase 3: Probability projections ───────────────────────
const PROJECTION_CURVES = {
  conflict:       { h24: 0.91, d7: 1.0, d30: 0.78 },
  market:         { h24: 1.0, d7: 0.58, d30: 0.42 },
  supply_chain:   { h24: 0.91, d7: 1.0, d30: 0.64 },
  political:      { h24: 0.83, d7: 0.87, d30: 1.0 },
  military:       { h24: 1.0, d7: 0.91, d30: 0.65 },
  cyber:          { h24: 1.0, d7: 0.78, d30: 0.4 },
  infrastructure: { h24: 1.0, d7: 0.5, d30: 0.25 },
};

function computeProjections(predictions) {
  for (const pred of predictions) {
    const curve = PROJECTION_CURVES[pred.domain] || { h24: 1, d7: 1, d30: 1 };
    const anchor = pred.timeHorizon === '24h' ? 'h24' : pred.timeHorizon === '30d' ? 'd30' : 'd7';
    const anchorMult = curve[anchor] || 1;
    const base = anchorMult > 0 ? pred.probability / anchorMult : pred.probability;
    pred.projections = {
      h24: Math.round(Math.min(0.95, Math.max(0.01, base * curve.h24)) * 1000) / 1000,
      d7:  Math.round(Math.min(0.95, Math.max(0.01, base * curve.d7)) * 1000) / 1000,
      d30: Math.round(Math.min(0.95, Math.max(0.01, base * curve.d30)) * 1000) / 1000,
    };
  }
}

function calibrateWithMarkets(predictions, markets) {
  if (!markets?.geopolitical) return;
  for (const pred of predictions) {
    const keywords = REGION_KEYWORDS[pred.region] || [];
    const regionTerms = [...new Set([...getSearchTermsForRegion(pred.region), pred.region])];
    const expectedTags = buildExpectedRegionTags(regionTerms, pred.region);
    const titleTokens = extractMeaningfulTokens(pred.title, regionTerms);
    if (keywords.length === 0 && regionTerms.length === 0) continue;
    const candidates = markets.geopolitical
      .map(m => {
        const mRegions = tagRegions(m.title);
        const sameMacroRegion = keywords.length > 0 && mRegions.some(r => keywords.includes(r));
        const match = computeMarketMatchScore(pred, m.title, regionTerms, { expectedTags, titleTokens });
        return { market: m, sameMacroRegion, ...match };
      })
      .filter(item => {
        if (item.tagMismatch && item.regionHits === 0) return false;
        const hasSpecificRegionSignal = item.regionHits > 0 || item.tagOverlap;
        const hasSemanticOverlap = item.titleHits > 0 || item.domainHits > 0;
        if (pred.domain === 'market') {
          return hasSpecificRegionSignal && item.titleHits > 0 && (item.domainHits > 0 || item.score >= 7);
        }
        return hasSpecificRegionSignal && (hasSemanticOverlap || item.score >= 6);
      })
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (b.market.volume || 0) - (a.market.volume || 0);
      });
    const best = candidates[0];
    const match = best?.market || null;
    if (match) {
      const marketProb = (match.yesPrice || 50) / 100;
      pred.calibration = {
        marketTitle: match.title,
        marketPrice: +marketProb.toFixed(3),
        drift: +(pred.probability - marketProb).toFixed(3),
        source: match.source || 'polymarket',
      };
      pred.probability = +(0.4 * marketProb + 0.6 * pred.probability).toFixed(3);
    }
  }
}

async function readPriorPredictions() {
  try {
    const { url, token } = getRedisCredentials();
    return await redisGet(url, token, PRIOR_KEY);
  } catch { return null; }
}

function computeTrends(predictions, prior) {
  if (!prior?.predictions) {
    for (const p of predictions) { p.trend = 'stable'; p.priorProbability = p.probability; }
    return;
  }
  const priorMap = new Map(prior.predictions.map(p => [p.id, p]));
  for (const p of predictions) {
    const prev = priorMap.get(p.id);
    if (!prev) { p.trend = 'stable'; p.priorProbability = p.probability; continue; }
    p.priorProbability = prev.probability;
    const delta = p.probability - prev.probability;
    p.trend = delta > 0.05 ? 'rising' : delta < -0.05 ? 'falling' : 'stable';
  }
}

// ── Phase 2: News Context + Entity Matching ────────────────
let _countryCodes = null;
function loadCountryCodes() {
  if (_countryCodes) return _countryCodes;
  try {
    const codePath = new URL('./data/country-codes.json', import.meta.url);
    _countryCodes = JSON.parse(readFileSync(codePath, 'utf8'));
    return _countryCodes;
  } catch { return {}; }
}

const NEWS_MATCHABLE_TYPES = new Set(['country', 'theater']);

function getSearchTermsForRegion(region) {
  const terms = [region];
  const codes = loadCountryCodes();
  const graph = loadEntityGraph();

  // 1. Country codes JSON: resolve ISO codes to names + keywords
  const countryEntry = codes[region];
  if (countryEntry) {
    terms.push(countryEntry.name);
    terms.push(...countryEntry.keywords);
  }

  // 2. Reverse lookup: if region is a full name (or has parenthetical suffix like "Myanmar (Burma)")
  if (!countryEntry) {
    const regionLower = region.toLowerCase();
    const regionBase = region.replace(/\s*\([^)]*\)\s*$/, '').toLowerCase(); // strip "(Zaire)", "(Burma)", etc.
    for (const [, entry] of Object.entries(codes)) {
      const nameLower = entry.name.toLowerCase();
      if (nameLower === regionLower || nameLower === regionBase || regionLower.includes(nameLower)) {
        terms.push(entry.name);
        terms.push(...entry.keywords);
        break;
      }
    }
  }

  // 3. Entity graph: add linked country/theater names (not commodities)
  const nodeId = graph.aliases?.[region];
  const node = nodeId ? graph.nodes?.[nodeId] : null;
  if (node) {
    if (node.name !== region) terms.push(node.name);
    for (const linkId of node.links || []) {
      const linked = graph.nodes?.[linkId];
      if (linked && NEWS_MATCHABLE_TYPES.has(linked.type) && linked.name.length > 2) {
        terms.push(linked.name);
      }
    }
  }

  // Dedupe and filter short terms
  return [...new Set(terms)].filter(t => t && t.length > 2);
}

function extractAllHeadlines(newsInsights, newsDigest) {
  const headlines = [];
  const seen = new Set();
  // 1. Digest has 300+ headlines across 16 categories
  if (newsDigest?.categories) {
    for (const bucket of Object.values(newsDigest.categories)) {
      for (const item of bucket?.items || []) {
        if (item?.title && !seen.has(item.title)) { seen.add(item.title); headlines.push(item.title); }
      }
    }
  }
  // 2. Fallback to topStories if digest is empty
  if (headlines.length === 0 && newsInsights?.topStories) {
    for (const s of newsInsights.topStories) {
      if (s?.primaryTitle && !seen.has(s.primaryTitle)) { seen.add(s.primaryTitle); headlines.push(s.primaryTitle); }
    }
  }
  return headlines;
}

function attachNewsContext(predictions, newsInsights, newsDigest) {
  const allHeadlines = extractAllHeadlines(newsInsights, newsDigest);
  if (allHeadlines.length === 0) return;

  for (const pred of predictions) {
    const searchTerms = getSearchTermsForRegion(pred.region);
    const expectedTags = buildExpectedRegionTags(searchTerms, pred.region);
    const titleTokens = extractMeaningfulTokens(pred.title, searchTerms);
    const matched = allHeadlines
      .map(headline => ({
        headline,
        score: computeHeadlineRelevance(headline, searchTerms, pred.domain, {
          region: pred.region,
          expectedTags,
          titleTokens,
          requireRegion: true,
          requireSemantic: true,
        }),
      }))
      .filter(item => item.score >= 4)
      .sort((a, b) => b.score - a.score || a.headline.length - b.headline.length)
      .map(item => item.headline);

    pred.newsContext = matched.slice(0, 4);

    if (matched.length > 0) {
      pred.signals.push({
        type: 'news_corroboration',
        value: `${matched.length} headline(s) mention ${pred.region} or linked entities`,
        weight: 0.15,
      });
    }
  }
}

// ── Phase 2: Deterministic Confidence Model ────────────────
const SIGNAL_TO_SOURCE = {
  cii: 'cii', cii_delta: 'cii', unrest: 'cii',
  conflict_events: 'iran_events',
  ucdp: 'ucdp',
  theater: 'theater_posture', indicators: 'theater_posture',
  mil_flights: 'temporal_anomalies', anomaly: 'temporal_anomalies',
  chokepoint: 'chokepoints',
  ais_gap: 'temporal_anomalies',
  gps_jamming: 'gps_jamming',
  outage: 'outages',
  cyber: 'cyber_threats',
  prediction_market: 'prediction_markets',
  news_corroboration: 'news_insights',
};

function computeConfidence(predictions) {
  for (const pred of predictions) {
    const sources = new Set(pred.signals.map(s => SIGNAL_TO_SOURCE[s.type] || s.type));
    const sourceDiversity = normalize(sources.size, 1, 4);
    const calibrationAgreement = pred.calibration
      ? Math.max(0, 1 - Math.abs(pred.calibration.drift) * 3)
      : 0.5;
    const conf = 0.5 * sourceDiversity + 0.5 * calibrationAgreement;
    pred.confidence = Math.round(Math.max(0.2, Math.min(1, conf)) * 1000) / 1000;
  }
}

function roundPct(value) {
  return `${Math.round((value || 0) * 100)}%`;
}

function slugifyValue(value) {
  return (value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function buildCounterEvidence(pred) {
  const items = [];
  if (!pred.newsContext || pred.newsContext.length === 0) {
    items.push({ type: 'coverage_gap', summary: `No directly matched headlines are currently attached to ${pred.region}.`, weight: 0.2 });
  }
  if (pred.confidence < 0.45) {
    items.push({ type: 'confidence', summary: `Confidence is only ${roundPct(pred.confidence)}, implying thin source diversity or mixed calibration.`, weight: 0.25 });
  }
  if (pred.trend === 'falling') {
    items.push({ type: 'trend', summary: `The forecast is already trending down from its prior snapshot (${roundPct(pred.priorProbability)} to ${roundPct(pred.probability)}).`, weight: 0.35 });
  }
  if (pred.calibration) {
    const drift = pred.calibration.drift;
    if (Math.abs(drift) >= 0.08) {
      const direction = drift > 0 ? 'below' : 'above';
      items.push({
        type: 'market_divergence',
        summary: `${pred.calibration.source} pricing in "${pred.calibration.marketTitle}" sits ${direction} the internal estimate by ${Math.round(Math.abs(drift) * 100)} points.`,
        weight: Math.min(0.5, Math.abs(drift)),
      });
    }
  }
  return items.slice(0, 4);
}

function buildCaseTriggers(pred) {
  const triggers = [];
  for (const signal of pred.signals || []) {
    const template = SIGNAL_TRIGGER_TEMPLATES[signal.type];
    if (!template) continue;
    triggers.push(template(pred, signal));
    if (triggers.length >= 4) break;
  }
  if (pred.calibration) {
    triggers.push(`If prediction markets move decisively away from ${roundPct(pred.calibration.marketPrice)}, revisit the probability baseline.`);
  }
  return [...new Set(triggers)].slice(0, 4);
}

function buildForecastActors(pred) {
  const blueprints = DOMAIN_ACTOR_BLUEPRINTS[pred.domain] || [
    { key: 'regional_watchers', name: 'Regional watchers', category: 'general', influenceScore: 0.6 },
    { key: 'market_participants', name: 'Market participants', category: 'market', influenceScore: 0.52 },
    { key: 'external_observers', name: 'External observers', category: 'external', influenceScore: 0.48 },
  ];
  const topTrigger = buildCaseTriggers(pred)[0];
  const topSupport = pred.signals?.[0]?.value || pred.caseFile?.supportingEvidence?.[0]?.summary || pred.title;
  const drift = Math.abs(pred.calibration?.drift || 0);

  return blueprints.slice(0, 4).map((blueprint, index) => {
    const objectives = [];
    const constraints = [];
    const likelyActions = [];

    if (pred.domain === 'conflict' || pred.domain === 'military') {
      objectives.push(`Prevent the ${pred.region} situation from moving beyond the current ${pred.trend} path.`);
      objectives.push(`Preserve decision freedom if ${topSupport} hardens into a broader escalation signal.`);
      likelyActions.push(`Reposition attention and resources around ${pred.region} over the next ${pred.timeHorizon}.`);
    } else if (pred.domain === 'supply_chain') {
      objectives.push(`Keep critical flows through ${pred.region} functioning over the ${pred.timeHorizon}.`);
      objectives.push(`Reduce exposure if ${topSupport} persists into the next cycle.`);
      likelyActions.push(`Adjust routing and contingency plans around ${pred.region}.`);
    } else if (pred.domain === 'market') {
      objectives.push(`Price whether stress in ${pred.region} becomes durable over the ${pred.timeHorizon}.`);
      objectives.push(`Protect against repricing if ${topSupport} intensifies.`);
      likelyActions.push(`Rebalance positions if the probability path moves away from ${roundPct(pred.probability)}.`);
    } else if (pred.domain === 'cyber') {
      objectives.push(`Contain hostile cyber activity affecting ${pred.region} before it spills into core services.`);
      objectives.push(`Preserve resilience if ${topSupport} broadens into a sustained intrusion pattern.`);
      likelyActions.push(`Harden exposed systems and triage incident response in ${pred.region}.`);
    } else if (pred.domain === 'infrastructure') {
      objectives.push(`Contain service degradation in ${pred.region} before it becomes cross-system.`);
      objectives.push(`Maintain continuity if ${topSupport} spreads across adjacent systems.`);
      likelyActions.push(`Prioritize mitigation and continuity measures around the most exposed nodes.`);
    } else {
      objectives.push(`Manage the current ${pred.trend} trajectory in ${pred.region}.`);
      objectives.push(`Limit the chance that ${topSupport} becomes a wider destabilizing signal.`);
      likelyActions.push(`Shift messaging and posture as new evidence arrives.`);
    }

    if (topTrigger) likelyActions.push(topTrigger);
    if ((pred.cascades || []).length > 0) {
      likelyActions.push(`Monitor spillover into ${(pred.cascades || []).slice(0, 2).map(c => c.domain).join(' and ')}.`);
    }

    if (!pred.newsContext?.length) {
      constraints.push(`Public reporting directly tied to ${pred.region} is still thin.`);
    }
    if (drift >= 0.08 && pred.calibration?.marketTitle) {
      constraints.push(`Market pricing in "${pred.calibration.marketTitle}" is not fully aligned with the internal estimate.`);
    }
    if (pred.trend === 'falling') {
      constraints.push(`Recent momentum is softening from ${roundPct(pred.priorProbability)} to ${roundPct(pred.probability)}.`);
    }
    if (constraints.length === 0) {
      constraints.push(`Action remains bounded by the current ${roundPct(pred.confidence)} confidence level.`);
    }

    return {
      id: `${pred.id}:${slugifyValue(blueprint.key || blueprint.name || `actor_${index}`)}`,
      name: blueprint.name,
      category: blueprint.category,
      role: `${blueprint.name} is a primary ${blueprint.category} actor for the ${pred.domain} path in ${pred.region}.`,
      objectives: objectives.slice(0, 2),
      constraints: constraints.slice(0, 2),
      likelyActions: [...new Set(likelyActions)].slice(0, 3),
      influenceScore: +(blueprint.influenceScore || 0.5).toFixed(3),
    };
  });
}

function buildForecastWorldState(pred, actors = [], triggers = [], counterEvidence = []) {
  const leadSupport = pred.caseFile?.supportingEvidence?.[0]?.summary || pred.signals?.[0]?.value || pred.title;
  const summary = `${leadSupport} is setting the current ${pred.trend} baseline in ${pred.region}, with the forecast sitting near ${roundPct(pred.probability)} over the ${pred.timeHorizon}.`;

  const activePressures = [
    ...(pred.caseFile?.supportingEvidence || []).slice(0, 3).map(item => item.summary),
    ...(pred.cascades || []).slice(0, 1).map(cascade => `Spillover pressure into ${cascade.domain} via ${cascade.effect}.`),
  ].filter(Boolean).slice(0, 4);

  const stabilizers = [
    ...counterEvidence.slice(0, 2).map(item => item.summary),
    pred.trend === 'falling' ? `The observed trend is already easing from ${roundPct(pred.priorProbability)} to ${roundPct(pred.probability)}.` : '',
    pred.calibration && Math.abs(pred.calibration.drift || 0) < 0.05
      ? `Prediction-market pricing near ${roundPct(pred.calibration.marketPrice)} is not strongly disputing the internal estimate.`
      : '',
  ].filter(Boolean).slice(0, 3);

  const keyUnknowns = [
    ...triggers.slice(0, 2),
    actors[0]?.constraints?.[0] || '',
    !pred.newsContext?.length ? `Whether directly matched reporting on ${pred.region} appears in the next run.` : '',
  ].filter(Boolean).slice(0, 4);

  return {
    summary,
    activePressures,
    stabilizers,
    keyUnknowns,
  };
}

function branchTitle(kind) {
  if (kind === 'base') return 'Base Branch';
  if (kind === 'escalatory') return 'Escalatory Branch';
  return 'Contrarian Branch';
}

function branchShift(kind, pred, context = {}) {
  const pressureCount = context.worldState?.activePressures?.length || 0;
  const stabilizerCount = context.worldState?.stabilizers?.length || 0;
  const triggerCount = context.triggers?.length || 0;
  const cascadeFactor = Math.min(0.06, (pred.cascades?.length || 0) * 0.02);
  const driftFactor = Math.min(0.04, Math.abs(pred.calibration?.drift || 0) * 0.5);

  if (kind === 'escalatory') {
    return Math.min(0.22, 0.08 + (pressureCount * 0.02) + (triggerCount * 0.015) + cascadeFactor - (stabilizerCount * 0.01));
  }
  if (kind === 'contrarian') {
    return -Math.min(0.22, 0.08 + (stabilizerCount * 0.025) + driftFactor + (pred.trend === 'falling' ? 0.02 : 0));
  }

  const trendNudge = pred.trend === 'rising' ? 0.02 : pred.trend === 'falling' ? -0.02 : 0;
  return Math.max(-0.08, Math.min(0.08, trendNudge + ((pressureCount - stabilizerCount) * 0.01)));
}

function buildBranchRounds(kind, pred, context = {}) {
  const leadPressure = context.worldState?.activePressures?.[0] || pred.signals?.[0]?.value || pred.title;
  const leadTrigger = context.triggers?.[0] || `The next ${pred.domain} update in ${pred.region} becomes the key threshold.`;
  const leadStabilizer = context.worldState?.stabilizers?.[0] || context.counterEvidence?.[0]?.summary || `The current ${roundPct(pred.confidence)} confidence level keeps this path from becoming fully settled.`;
  const actors = context.actors || [];

  const round1 = {
    round: 1,
    focus: kind === 'contrarian' ? 'Constraint absorption' : 'Signal absorption',
    developments: [
      kind === 'contrarian'
        ? leadStabilizer
        : leadPressure,
    ].filter(Boolean),
    actorMoves: actors.slice(0, 2).map(actor => actor.likelyActions?.[0]).filter(Boolean),
    probabilityShift: +((branchShift(kind, pred, context)) / 3).toFixed(3),
  };

  const round2 = {
    round: 2,
    focus: 'Actor response',
    developments: [
      kind === 'escalatory'
        ? leadTrigger
        : kind === 'contrarian'
          ? `Actors slow the path if ${leadStabilizer.toLowerCase()}`
          : `Actors adapt to whether ${leadTrigger.toLowerCase()}`,
    ],
    actorMoves: actors.slice(0, 3).map(actor => actor.likelyActions?.[1] || actor.objectives?.[0]).filter(Boolean),
    probabilityShift: +((branchShift(kind, pred, context)) / 3).toFixed(3),
  };

  const round3 = {
    round: 3,
    focus: 'System effect',
    developments: [
      kind === 'escalatory' && (pred.cascades?.length || 0) > 0
        ? `Spillover becomes visible in ${(pred.cascades || []).slice(0, 2).map(c => c.domain).join(' and ')}.`
        : kind === 'contrarian'
          ? `The path cools if counter-pressure remains stronger than fresh escalation evidence.`
          : `The path settles near the current balance of pressure and restraint.`,
    ],
    actorMoves: actors.slice(0, 2).map(actor => actor.constraints?.[0]).filter(Boolean),
    probabilityShift: +(branchShift(kind, pred, context) - (((branchShift(kind, pred, context)) / 3) * 2)).toFixed(3),
  };

  return [round1, round2, round3];
}

function buildForecastBranches(pred, context = {}) {
  return ['base', 'escalatory', 'contrarian'].map(kind => {
    const shift = branchShift(kind, pred, context);
    const projectedProbability = clamp01((pred.probability || 0) + shift);
    const rounds = buildBranchRounds(kind, pred, context);
    const leadPressure = context.worldState?.activePressures?.[0] || pred.signals?.[0]?.value || pred.title;
    const leadStabilizer = context.worldState?.stabilizers?.[0] || context.counterEvidence?.[0]?.summary || `The current ${roundPct(pred.confidence)} confidence level still leaves room for reversal.`;
    const leadTrigger = context.triggers?.[0] || `The next evidence cycle in ${pred.region} becomes decisive.`;

    const summary = kind === 'escalatory'
      ? `${leadTrigger} If that threshold breaks, the path can move above the current ${roundPct(pred.probability)} baseline.`
      : kind === 'contrarian'
        ? `${leadStabilizer} If that restraint persists, the forecast can move below the current ${roundPct(pred.probability)} baseline.`
        : `${leadPressure} keeps the central path near ${roundPct(projectedProbability)} over the ${pred.timeHorizon}.`;

    const outcome = kind === 'escalatory'
      ? `Actors treat escalation as increasingly self-reinforcing, especially if cross-domain pressure appears.`
      : kind === 'contrarian'
        ? `Actors prioritize containment and the system drifts toward stabilization unless new hard signals emerge.`
        : `Actors absorb the current evidence mix without a decisive break toward either shock or relief.`;

    return {
      kind,
      title: branchTitle(kind),
      summary: summary.slice(0, 400),
      outcome: outcome.slice(0, 400),
      projectedProbability: +projectedProbability.toFixed(3),
      rounds,
    };
  });
}

function buildActorLenses(pred) {
  const actors = buildForecastActors(pred);
  const lenses = actors.map(actor => {
    const objective = actor.objectives?.[0] || actor.role;
    const action = actor.likelyActions?.[0] || `Track ${pred.region} closely over the ${pred.timeHorizon}.`;
    return `${actor.name}: ${objective} ${action}`;
  });
  if (pred.cascades?.length > 0) {
    lenses.push(`Cross-domain watchers will track spillover into ${pred.cascades.slice(0, 2).map(c => c.domain).join(' and ')} if this path hardens.`);
  }
  return lenses.slice(0, 4);
}

function buildForecastCase(pred) {
  const supportingEvidence = [];
  const rankedSignals = [...(pred.signals || [])].sort((a, b) => (b.weight || 0) - (a.weight || 0));

  for (const signal of rankedSignals.slice(0, 4)) {
    supportingEvidence.push({
      type: signal.type,
      summary: signal.value,
      weight: +(signal.weight || 0).toFixed(3),
    });
  }

  for (const headline of (pred.newsContext || []).slice(0, 2)) {
    supportingEvidence.push({
      type: 'headline',
      summary: headline,
      weight: 0.15,
    });
  }

  if (pred.calibration) {
    supportingEvidence.push({
      type: 'market_calibration',
      summary: `${pred.calibration.source} prices "${pred.calibration.marketTitle}" near ${roundPct(pred.calibration.marketPrice)}.`,
      weight: Math.min(0.5, Math.abs(pred.calibration.drift) + 0.2),
    });
  }

  for (const cascade of (pred.cascades || []).slice(0, 2)) {
    supportingEvidence.push({
      type: 'cascade',
      summary: `Potential spillover into ${cascade.domain} via ${cascade.effect} (${roundPct(cascade.probability)}).`,
      weight: +(cascade.probability || 0).toFixed(3),
    });
  }

  const counterEvidence = buildCounterEvidence(pred);
  const triggers = buildCaseTriggers(pred);
  const actors = buildForecastActors(pred);
  const actorLenses = actors.map(actor => {
    const objective = actor.objectives?.[0] || actor.role;
    const action = actor.likelyActions?.[0] || `Track ${pred.region} closely over the ${pred.timeHorizon}.`;
    return `${actor.name}: ${objective} ${action}`;
  }).slice(0, 4);
  const worldState = buildForecastWorldState(
    {
      ...pred,
      caseFile: {
        ...(pred.caseFile || {}),
        supportingEvidence: supportingEvidence.slice(0, 6),
      },
    },
    actors,
    triggers,
    counterEvidence,
  );
  const branches = buildForecastBranches(pred, {
    actors,
    triggers,
    counterEvidence,
    worldState,
  });

  pred.caseFile = {
    supportingEvidence: supportingEvidence.slice(0, 6),
    counterEvidence,
    triggers,
    actorLenses,
    baseCase: '',
    escalatoryCase: '',
    contrarianCase: '',
    changeSummary: '',
    changeItems: [],
    actors,
    worldState,
    branches,
  };

  return pred.caseFile;
}

function buildForecastCases(predictions) {
  for (const pred of predictions) buildForecastCase(pred);
}

function buildPriorForecastSnapshot(pred) {
  return {
    id: pred.id,
    probability: pred.probability,
    signals: (pred.signals || []).map(signal => signal.value),
    newsContext: pred.newsContext || [],
    calibration: pred.calibration
      ? {
          marketTitle: pred.calibration.marketTitle,
          marketPrice: pred.calibration.marketPrice,
        }
      : null,
  };
}

function buildHistoryForecastEntry(pred) {
  return {
    id: pred.id,
    domain: pred.domain,
    region: pred.region,
    title: pred.title,
    probability: pred.probability,
    confidence: pred.confidence,
    timeHorizon: pred.timeHorizon,
    trend: pred.trend,
    priorProbability: pred.priorProbability,
    signals: (pred.signals || []).slice(0, 6).map(signal => ({
      type: signal.type,
      value: signal.value,
      weight: signal.weight,
    })),
    newsContext: (pred.newsContext || []).slice(0, 4),
    calibration: pred.calibration
      ? {
          marketTitle: pred.calibration.marketTitle,
          marketPrice: pred.calibration.marketPrice,
          drift: pred.calibration.drift,
          source: pred.calibration.source,
        }
      : null,
    cascades: (pred.cascades || []).slice(0, 3).map(cascade => ({
      domain: cascade.domain,
      effect: cascade.effect,
      probability: cascade.probability,
    })),
  };
}

function buildHistorySnapshot(data, options = {}) {
  const maxForecasts = options.maxForecasts || HISTORY_MAX_FORECASTS;
  const predictions = Array.isArray(data?.predictions) ? data.predictions : [];
  return {
    generatedAt: data?.generatedAt || Date.now(),
    predictions: predictions.slice(0, maxForecasts).map(buildHistoryForecastEntry),
  };
}

async function appendHistorySnapshot(data, options = {}) {
  const key = options.key || HISTORY_KEY;
  const maxRuns = options.maxRuns || HISTORY_MAX_RUNS;
  const ttlSeconds = options.ttlSeconds || HISTORY_TTL_SECONDS;
  const snapshot = buildHistorySnapshot(data, options);
  const { url, token } = getRedisCredentials();

  await redisCommand(url, token, ['LPUSH', key, JSON.stringify(snapshot)]);
  await redisCommand(url, token, ['LTRIM', key, 0, maxRuns - 1]);
  await redisCommand(url, token, ['EXPIRE', key, ttlSeconds]);
  return snapshot;
}

function getTraceMaxForecasts(totalForecasts = 0) {
  const raw = process.env.FORECAST_TRACE_MAX_FORECASTS;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return Math.min(200, Math.floor(parsed));
  return totalForecasts > 0 ? totalForecasts : 50;
}

function getTraceCapLog(totalForecasts = 0) {
  return {
    raw: process.env.FORECAST_TRACE_MAX_FORECASTS || null,
    resolved: getTraceMaxForecasts(totalForecasts),
    totalForecasts,
  };
}

function applyTraceMeta(pred, patch) {
  pred.traceMeta = {
    ...(pred.traceMeta || {}),
    ...patch,
  };
}

function buildTraceRunPrefix(runId, generatedAt, basePrefix) {
  const iso = new Date(generatedAt || Date.now()).toISOString();
  const [datePart] = iso.split('T');
  const [year, month, day] = datePart.split('-');
  return `${basePrefix}/${year}/${month}/${day}/${runId}`;
}

function buildForecastTraceRecord(pred, rank) {
  return {
    rank,
    id: pred.id,
    title: pred.title,
    domain: pred.domain,
    region: pred.region,
    probability: pred.probability,
    confidence: pred.confidence,
    trend: pred.trend,
    timeHorizon: pred.timeHorizon,
    priorProbability: pred.priorProbability,
    feedSummary: pred.feedSummary || '',
    scenario: pred.scenario || '',
    projections: pred.projections || null,
    calibration: pred.calibration || null,
    cascades: pred.cascades || [],
    signals: pred.signals || [],
    newsContext: pred.newsContext || [],
    perspectives: pred.perspectives || null,
    caseFile: pred.caseFile || null,
    readiness: scoreForecastReadiness(pred),
    analysisPriority: computeAnalysisPriority(pred),
    traceMeta: pred.traceMeta || {
      narrativeSource: 'fallback',
      branchSource: 'deterministic',
    },
  };
}

function buildForecastRunActorRegistry(predictions) {
  const actors = new Map();

  for (const pred of predictions) {
    const structuredActors = pred.caseFile?.actors || buildForecastActors(pred);
    for (const actor of structuredActors) {
      const key = actor.key || `${actor.name}:${actor.category}`;
      if (!actors.has(key)) {
        actors.set(key, {
          id: key,
          name: actor.name,
          category: actor.category || 'general',
          influenceScore: actor.influenceScore || 0,
          domains: new Set(),
          regions: new Set(),
          objectives: new Set(actor.objectives || []),
          constraints: new Set(actor.constraints || []),
          likelyActions: new Set(actor.likelyActions || []),
          forecastIds: new Set(),
        });
      }
      const entry = actors.get(key);
      entry.domains.add(pred.domain);
      entry.regions.add(pred.region);
      entry.forecastIds.add(pred.id);
      for (const value of actor.objectives || []) entry.objectives.add(value);
      for (const value of actor.constraints || []) entry.constraints.add(value);
      for (const value of actor.likelyActions || []) entry.likelyActions.add(value);
      entry.influenceScore = Math.max(entry.influenceScore, actor.influenceScore || 0);
    }
  }

  return [...actors.values()]
    .map((actor) => ({
      id: actor.id,
      name: actor.name,
      category: actor.category,
      influenceScore: +((actor.influenceScore || 0)).toFixed(3),
      domains: [...actor.domains].sort(),
      regions: [...actor.regions].sort(),
      objectives: [...actor.objectives].slice(0, 4),
      constraints: [...actor.constraints].slice(0, 4),
      likelyActions: [...actor.likelyActions].slice(0, 4),
      forecastIds: [...actor.forecastIds].slice(0, 8),
    }))
    .sort((a, b) => b.influenceScore - a.influenceScore || a.name.localeCompare(b.name));
}

function buildActorContinuitySummary(currentActors, priorWorldState = null) {
  const priorActors = Array.isArray(priorWorldState?.actorRegistry) ? priorWorldState.actorRegistry : [];
  const priorById = new Map(priorActors.map(actor => [actor.id, actor]));
  const currentById = new Map(currentActors.map(actor => [actor.id, actor]));

  const newlyActive = [];
  const strengthened = [];
  const weakened = [];

  for (const actor of currentActors) {
    const prev = priorById.get(actor.id);
    if (!prev) {
      newlyActive.push({
        id: actor.id,
        name: actor.name,
        influenceScore: actor.influenceScore,
        domains: actor.domains,
        regions: actor.regions,
      });
      continue;
    }

    const influenceDelta = +((actor.influenceScore || 0) - (prev.influenceScore || 0)).toFixed(3);
    const domainExpansion = actor.domains.filter(domain => !(prev.domains || []).includes(domain));
    const regionExpansion = actor.regions.filter(region => !(prev.regions || []).includes(region));
    const domainContraction = (prev.domains || []).filter(domain => !actor.domains.includes(domain));
    const regionContraction = (prev.regions || []).filter(region => !actor.regions.includes(region));

    if (influenceDelta >= 0.05 || domainExpansion.length > 0 || regionExpansion.length > 0) {
      strengthened.push({
        id: actor.id,
        name: actor.name,
        influenceDelta,
        addedDomains: domainExpansion.slice(0, 4),
        addedRegions: regionExpansion.slice(0, 4),
      });
    } else if (influenceDelta <= -0.05 || domainContraction.length > 0 || regionContraction.length > 0) {
      weakened.push({
        id: actor.id,
        name: actor.name,
        influenceDelta,
        removedDomains: domainContraction.slice(0, 4),
        removedRegions: regionContraction.slice(0, 4),
      });
    }
  }

  const noLongerActive = priorActors
    .filter(actor => !currentById.has(actor.id))
    .map(actor => ({
      id: actor.id,
      name: actor.name,
      influenceScore: actor.influenceScore || 0,
      domains: actor.domains || [],
      regions: actor.regions || [],
    }));

  const persistentCount = currentActors.filter(actor => priorById.has(actor.id)).length;

  return {
    priorActorCount: priorActors.length,
    currentActorCount: currentActors.length,
    persistentCount,
    newlyActiveCount: newlyActive.length,
    strengthenedCount: strengthened.length,
    weakenedCount: weakened.length,
    noLongerActiveCount: noLongerActive.length,
    newlyActivePreview: newlyActive.slice(0, 8),
    strengthenedPreview: strengthened
      .sort((a, b) => b.influenceDelta - a.influenceDelta || a.name.localeCompare(b.name))
      .slice(0, 8),
    weakenedPreview: weakened
      .sort((a, b) => a.influenceDelta - b.influenceDelta || a.name.localeCompare(b.name))
      .slice(0, 8),
    noLongerActivePreview: noLongerActive.slice(0, 8),
  };
}

function buildForecastBranchStates(predictions) {
  const branches = [];

  for (const pred of predictions) {
    const branchList = pred.caseFile?.branches || buildForecastBranches(pred, {
      actors: pred.caseFile?.actors || buildForecastActors(pred),
      triggers: pred.caseFile?.triggers || buildCaseTriggers(pred),
      counterEvidence: pred.caseFile?.counterEvidence || buildCounterEvidence(pred),
      worldState: pred.caseFile?.worldState || buildForecastWorldState(pred),
    });

    for (const branch of branchList) {
      branches.push({
        id: `${pred.id}:${branch.kind}`,
        forecastId: pred.id,
        forecastTitle: pred.title,
        kind: branch.kind,
        title: branch.title,
        domain: pred.domain,
        region: pred.region,
        projectedProbability: +(branch.projectedProbability || 0).toFixed(3),
        baselineProbability: +(pred.probability || 0).toFixed(3),
        probabilityDelta: +((branch.projectedProbability || 0) - (pred.probability || 0)).toFixed(3),
        summary: branch.summary,
        outcome: branch.outcome,
        roundCount: Array.isArray(branch.rounds) ? branch.rounds.length : 0,
        actorIds: (pred.caseFile?.actors || []).map(actor => actor.id).slice(0, 6),
        triggerSample: (pred.caseFile?.triggers || []).slice(0, 3),
        evidenceSample: (pred.caseFile?.supportingEvidence || []).slice(0, 2).map(item => item.summary),
        counterEvidenceSample: (pred.caseFile?.counterEvidence || []).slice(0, 2).map(item => item.summary),
      });
    }
  }

  return branches
    .sort((a, b) => b.projectedProbability - a.projectedProbability || a.id.localeCompare(b.id));
}

function buildBranchContinuitySummary(currentBranchStates, priorWorldState = null) {
  const priorBranchStates = Array.isArray(priorWorldState?.branchStates) ? priorWorldState.branchStates : [];
  const priorById = new Map(priorBranchStates.map(branch => [branch.id, branch]));
  const currentById = new Map(currentBranchStates.map(branch => [branch.id, branch]));

  const newBranches = [];
  const strengthened = [];
  const weakened = [];
  const stable = [];

  for (const branch of currentBranchStates) {
    const prev = priorById.get(branch.id);
    if (!prev) {
      newBranches.push({
        id: branch.id,
        forecastId: branch.forecastId,
        kind: branch.kind,
        title: branch.title,
        projectedProbability: branch.projectedProbability,
      });
      continue;
    }

    const delta = +((branch.projectedProbability || 0) - (prev.projectedProbability || 0)).toFixed(3);
    const actorDelta = branch.actorIds.filter(id => !(prev.actorIds || []).includes(id));
    const triggerDelta = branch.triggerSample.filter(item => !(prev.triggerSample || []).includes(item));

    const record = {
      id: branch.id,
      forecastId: branch.forecastId,
      kind: branch.kind,
      title: branch.title,
      projectedProbability: branch.projectedProbability,
      priorProjectedProbability: +(prev.projectedProbability || 0).toFixed(3),
      probabilityDelta: delta,
      newActorIds: actorDelta.slice(0, 4),
      newTriggers: triggerDelta.slice(0, 3),
    };

    if (delta >= 0.05 || actorDelta.length > 0 || triggerDelta.length > 0) {
      strengthened.push(record);
    } else if (delta <= -0.05) {
      weakened.push(record);
    } else {
      stable.push(record);
    }
  }

  const resolved = priorBranchStates
    .filter(branch => !currentById.has(branch.id))
    .map(branch => ({
      id: branch.id,
      forecastId: branch.forecastId,
      kind: branch.kind,
      title: branch.title,
      projectedProbability: +(branch.projectedProbability || 0).toFixed(3),
    }));

  return {
    priorBranchCount: priorBranchStates.length,
    currentBranchCount: currentBranchStates.length,
    persistentBranchCount: currentBranchStates.filter(branch => priorById.has(branch.id)).length,
    newBranchCount: newBranches.length,
    strengthenedBranchCount: strengthened.length,
    weakenedBranchCount: weakened.length,
    stableBranchCount: stable.length,
    resolvedBranchCount: resolved.length,
    newBranchPreview: newBranches.slice(0, 8),
    strengthenedBranchPreview: strengthened
      .sort((a, b) => b.probabilityDelta - a.probabilityDelta || a.id.localeCompare(b.id))
      .slice(0, 8),
    weakenedBranchPreview: weakened
      .sort((a, b) => a.probabilityDelta - b.probabilityDelta || a.id.localeCompare(b.id))
      .slice(0, 8),
    resolvedBranchPreview: resolved.slice(0, 8),
  };
}

function uniqueSortedStrings(values) {
  return Array.from(new Set((values || []).filter(Boolean).map((value) => String(value)))).sort((a, b) => a.localeCompare(b));
}

function normalizeSituationText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token && token.length > 2 && !TEXT_STOPWORDS.has(token));
}

function hashSituationKey(parts) {
  return crypto.createHash('sha256').update(parts.filter(Boolean).join('|')).digest('hex').slice(0, 10);
}

function buildSituationCandidate(prediction) {
  return {
    prediction,
    regions: uniqueSortedStrings([prediction.region, ...(prediction.caseFile?.regions || [])]),
    domains: uniqueSortedStrings([prediction.domain, ...(prediction.caseFile?.domains || [])]),
    actors: uniqueSortedStrings((prediction.caseFile?.actors || []).map((actor) => actor.id || actor.name).filter(Boolean)),
    branchKinds: uniqueSortedStrings((prediction.caseFile?.branches || []).map((branch) => branch.kind).filter(Boolean)),
    tokens: uniqueSortedStrings([
      ...normalizeSituationText(prediction.title),
      ...normalizeSituationText(prediction.feedSummary),
      ...(prediction.signals || []).flatMap((signal) => normalizeSituationText(signal?.value)),
      ...(prediction.newsContext || []).flatMap((headline) => normalizeSituationText(headline)),
    ]).slice(0, 24),
  };
}

function computeSituationOverlap(candidate, cluster) {
  const overlapCount = (left, right) => left.filter((item) => right.includes(item)).length;
  return (
    overlapCount(candidate.regions, cluster.regions) * 3 +
    overlapCount(candidate.actors, cluster.actors) * 2 +
    overlapCount(candidate.domains, cluster.domains) * 1.5 +
    overlapCount(candidate.branchKinds, cluster.branchKinds) * 1 +
    overlapCount(candidate.tokens, cluster.tokens) * 0.25
  );
}

function finalizeSituationCluster(cluster) {
  const avgProbability = cluster._probabilityTotal / Math.max(1, cluster.forecastCount);
  const avgConfidence = cluster._confidenceTotal / Math.max(1, cluster.forecastCount);
  const topSignals = Object.entries(cluster._signalCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([type, count]) => ({ type, count }));
  const stableKey = [
    ...cluster.regions.slice(0, 2),
    ...cluster.actors.slice(0, 2),
    ...cluster.domains.slice(0, 2),
  ];
  const leadRegion = cluster.regions[0] || 'Cross-regional';
  const leadDomain = cluster.domains[0] || 'multi-domain';
  const leadActor = cluster.actors[0] || '';

  return {
    id: `sit-${hashSituationKey(stableKey)}`,
    stableKey,
    label: leadActor ? `${leadRegion}: ${leadActor} ${leadDomain} pressure` : `${leadRegion}: ${leadDomain} pressure`,
    forecastCount: cluster.forecastCount,
    forecastIds: cluster.forecastIds.slice(0, 12),
    regions: cluster.regions,
    domains: cluster.domains,
    actors: cluster.actors,
    branchKinds: cluster.branchKinds,
    avgProbability: +avgProbability.toFixed(3),
    avgConfidence: +avgConfidence.toFixed(3),
    topSignals,
    sampleTitles: cluster.sampleTitles.slice(0, 6),
  };
}

function computeSituationSimilarity(currentCluster, priorCluster) {
  const overlapCount = (left, right) => left.filter((item) => right.includes(item)).length;
  return (
    overlapCount(currentCluster.regions || [], priorCluster.regions || []) * 3 +
    overlapCount(currentCluster.actors || [], priorCluster.actors || []) * 2 +
    overlapCount(currentCluster.domains || [], priorCluster.domains || []) * 1.5 +
    overlapCount(currentCluster.branchKinds || [], priorCluster.branchKinds || []) * 1 +
    overlapCount(currentCluster.forecastIds || [], priorCluster.forecastIds || []) * 0.5
  );
}
function buildSituationClusters(predictions) {
  const clusters = [];

  for (const prediction of predictions) {
    const candidate = buildSituationCandidate(prediction);
    let bestCluster = null;
    let bestScore = 0;

    for (const cluster of clusters) {
      const score = computeSituationOverlap(candidate, cluster);
      if (score > bestScore) {
        bestScore = score;
        bestCluster = cluster;
      }
    }

    if (!bestCluster || bestScore < 3) {
      bestCluster = {
        regions: [],
        domains: [],
        actors: [],
        branchKinds: [],
        tokens: [],
        forecastIds: [],
        sampleTitles: [],
        forecastCount: 0,
        _probabilityTotal: 0,
        _confidenceTotal: 0,
        _signalCounts: {},
      };
      clusters.push(bestCluster);
    }

    bestCluster.regions = uniqueSortedStrings([...bestCluster.regions, ...candidate.regions]);
    bestCluster.domains = uniqueSortedStrings([...bestCluster.domains, ...candidate.domains]);
    bestCluster.actors = uniqueSortedStrings([...bestCluster.actors, ...candidate.actors]);
    bestCluster.branchKinds = uniqueSortedStrings([...bestCluster.branchKinds, ...candidate.branchKinds]);
    bestCluster.tokens = uniqueSortedStrings([...bestCluster.tokens, ...candidate.tokens]).slice(0, 28);
    bestCluster.forecastIds.push(prediction.id);
    bestCluster.sampleTitles.push(prediction.title);
    bestCluster.forecastCount += 1;
    bestCluster._probabilityTotal += Number(prediction.probability || 0);
    bestCluster._confidenceTotal += Number(prediction.confidence || 0);

    for (const signal of prediction.signals || []) {
      const type = signal?.type || 'unknown';
      bestCluster._signalCounts[type] = (bestCluster._signalCounts[type] || 0) + 1;
    }
  }

  return clusters
    .map(finalizeSituationCluster)
    .sort((a, b) => b.forecastCount - a.forecastCount || b.avgProbability - a.avgProbability);
}

function buildSituationContinuitySummary(currentSituationClusters, priorWorldState = null) {
  const priorSituationClusters = Array.isArray(priorWorldState?.situationClusters) ? priorWorldState.situationClusters : [];
  const matchedPriorIds = new Set();
  const persistent = [];
  const newlyActive = [];
  const strengthened = [];
  const weakened = [];

  for (const cluster of currentSituationClusters) {
    let prev = priorSituationClusters.find((item) => item.id === cluster.id);
    if (!prev) {
      let bestMatch = null;
      let bestScore = 0;
      for (const priorCluster of priorSituationClusters) {
        if (matchedPriorIds.has(priorCluster.id)) continue;
        const score = computeSituationSimilarity(cluster, priorCluster);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = priorCluster;
        }
      }
      if (bestMatch && bestScore >= 4) prev = bestMatch;
    }
    if (!prev) {
      newlyActive.push(cluster);
      continue;
    }

    matchedPriorIds.add(prev.id);
    persistent.push(cluster);
    const probabilityDelta = +((cluster.avgProbability || 0) - (prev.avgProbability || 0)).toFixed(3);
    const countDelta = cluster.forecastCount - (prev.forecastCount || 0);
    const addedActors = cluster.actors.filter((actor) => !(prev.actors || []).includes(actor));
    const addedRegions = cluster.regions.filter((region) => !(prev.regions || []).includes(region));

    const record = {
      id: cluster.id,
      label: cluster.label,
      forecastCount: cluster.forecastCount,
      priorForecastCount: prev.forecastCount || 0,
      avgProbability: cluster.avgProbability,
      priorAvgProbability: +(prev.avgProbability || 0).toFixed(3),
      probabilityDelta,
      countDelta,
      addedActors: addedActors.slice(0, 4),
      addedRegions: addedRegions.slice(0, 4),
    };

    if (probabilityDelta >= 0.08 || countDelta >= 2 || addedActors.length > 0 || addedRegions.length > 0) {
      strengthened.push(record);
    } else if (probabilityDelta <= -0.08 || countDelta <= -2) {
      weakened.push(record);
    }
  }

  const resolved = priorSituationClusters
    .filter((cluster) => !matchedPriorIds.has(cluster.id))
    .map((cluster) => ({
      id: cluster.id,
      label: cluster.label,
      forecastCount: cluster.forecastCount || 0,
      avgProbability: +(cluster.avgProbability || 0).toFixed(3),
    }));

  return {
    priorSituationCount: priorSituationClusters.length,
    currentSituationCount: currentSituationClusters.length,
    persistentSituationCount: persistent.length,
    newSituationCount: newlyActive.length,
    strengthenedSituationCount: strengthened.length,
    weakenedSituationCount: weakened.length,
    resolvedSituationCount: resolved.length,
    newSituationPreview: newlyActive.slice(0, 8),
    strengthenedSituationPreview: strengthened
      .sort((a, b) => b.probabilityDelta - a.probabilityDelta || b.countDelta - a.countDelta || a.id.localeCompare(b.id))
      .slice(0, 8),
    weakenedSituationPreview: weakened
      .sort((a, b) => a.probabilityDelta - b.probabilityDelta || a.countDelta - b.countDelta || a.id.localeCompare(b.id))
      .slice(0, 8),
    resolvedSituationPreview: resolved.slice(0, 8),
  };
}

function buildSituationSummary(situationClusters, situationContinuity) {
  const leading = situationClusters.slice(0, 4).map((cluster) => ({
    id: cluster.id,
    label: cluster.label,
    forecastCount: cluster.forecastCount,
    avgProbability: cluster.avgProbability,
    regions: cluster.regions,
    domains: cluster.domains,
  }));

  return {
    summary: situationClusters.length
      ? `${situationClusters.length} clustered situations are active, led by ${leading.map((cluster) => cluster.label).join(', ')}.`
      : 'No clustered situations are active in this run.',
    continuitySummary: `Situations: ${situationContinuity.newSituationCount} new, ${situationContinuity.strengthenedSituationCount} strengthened, ${situationContinuity.resolvedSituationCount} resolved.`,
    leading,
  };
}

function summarizeWorldStateHistory(priorWorldStates = []) {
  return priorWorldStates
    .filter(Boolean)
    .slice(0, WORLD_STATE_HISTORY_LIMIT)
    .map((state) => ({
      generatedAt: state.generatedAt,
      generatedAtIso: state.generatedAtIso,
      summary: state.summary,
      domainCount: Array.isArray(state.domainStates) ? state.domainStates.length : 0,
      regionCount: Array.isArray(state.regionalStates) ? state.regionalStates.length : 0,
      situationCount: Array.isArray(state.situationClusters) ? state.situationClusters.length : 0,
      actorCount: Array.isArray(state.actorRegistry) ? state.actorRegistry.length : 0,
      branchCount: Array.isArray(state.branchStates) ? state.branchStates.length : 0,
    }));
}

function buildReportContinuity(current, priorWorldStates = []) {
  const history = summarizeWorldStateHistory(priorWorldStates);

  const persistentPressures = [];
  const emergingPressures = [];
  const fadingPressures = [];
  const repeatedStrengthening = [];
  const matchedLatestPriorIds = new Set();

  for (const cluster of current.situationClusters || []) {
    const priorMatches = [];
    for (const state of priorWorldStates.filter(Boolean)) {
      const candidates = Array.isArray(state.situationClusters) ? state.situationClusters : [];
      let match = candidates.find((item) => item.id === cluster.id) || null;
      if (!match) {
        let bestMatch = null;
        let bestScore = 0;
        for (const candidate of candidates) {
          const score = computeSituationSimilarity(cluster, candidate);
          if (score > bestScore) {
            bestScore = score;
            bestMatch = candidate;
          }
        }
        if (bestMatch && bestScore >= 4) match = bestMatch;
      }
      if (!match) continue;
      priorMatches.push({
        id: match.id,
        label: match.label,
        generatedAt: state.generatedAt || 0,
        avgProbability: Number(match.avgProbability || 0),
        forecastCount: Number(match.forecastCount || 0),
      });
      if (state === priorWorldStates[0]) matchedLatestPriorIds.add(match.id);
    }

    if (priorMatches.length === 0) {
      emergingPressures.push({
        id: cluster.id,
        label: cluster.label,
        forecastCount: cluster.forecastCount,
        avgProbability: cluster.avgProbability,
      });
      continue;
    }

    persistentPressures.push({
      id: cluster.id,
      label: cluster.label,
      appearances: priorMatches.length + 1,
      forecastCount: cluster.forecastCount,
      avgProbability: cluster.avgProbability,
    });

    // priorMatches is ordered most-recent-first (mirrors priorWorldStates order from LRANGE)
    const lastMatch = priorMatches[0];
    const earliestMatch = priorMatches[priorMatches.length - 1];
    // "strengthening" means current is >= both the most-recent and oldest prior snapshots,
    // catching recoveries (V-shapes) as well as monotonic increases intentionally
    if (
      cluster.avgProbability >= (lastMatch?.avgProbability || 0) &&
      cluster.avgProbability >= (earliestMatch?.avgProbability || 0) &&
      cluster.forecastCount >= (lastMatch?.forecastCount || 0)
    ) {
      repeatedStrengthening.push({
        id: cluster.id,
        label: cluster.label,
        avgProbability: cluster.avgProbability,
        priorAvgProbability: lastMatch?.avgProbability || 0,
        appearances: priorMatches.length + 1,
      });
    }
  }

  const latestPriorState = priorWorldStates[0] || null;
  for (const cluster of latestPriorState?.situationClusters || []) {
    if (matchedLatestPriorIds.has(cluster.id)) continue;
    fadingPressures.push({
      id: cluster.id,
      label: cluster.label,
      forecastCount: cluster.forecastCount || 0,
      avgProbability: cluster.avgProbability || 0,
    });
  }

  const summary = history.length
    ? `Across the last ${history.length + 1} runs, ${persistentPressures.length} situations persisted, ${emergingPressures.length} emerged, and ${fadingPressures.length} faded from the latest prior snapshot.`
    : 'No prior world-state history is available yet for report continuity.';

  return {
    history,
    summary,
    persistentPressureCount: persistentPressures.length,
    emergingPressureCount: emergingPressures.length,
    fadingPressureCount: fadingPressures.length,
    repeatedStrengtheningCount: repeatedStrengthening.length,
    persistentPressurePreview: persistentPressures.slice(0, 8),
    emergingPressurePreview: emergingPressures.slice(0, 8),
    fadingPressurePreview: fadingPressures.slice(0, 8),
    repeatedStrengtheningPreview: repeatedStrengthening
      .sort((a, b) => b.appearances - a.appearances || b.avgProbability - a.avgProbability || a.id.localeCompare(b.id))
      .slice(0, 8),
  };
}

function buildWorldStateReport(worldState) {
  const leadDomains = (worldState.domainStates || [])
    .slice(0, 3)
    .map(item => `${item.domain} (${item.forecastCount})`);
  const leadRegions = (worldState.regionalStates || [])
    .slice(0, 4)
    .map(item => ({
      region: item.region,
      summary: `${item.forecastCount} forecasts with ${Math.round((item.avgProbability || 0) * 100)}% average probability and ${Math.round((item.avgConfidence || 0) * 100)}% average confidence.`,
      domainMix: item.domainMix,
    }));

  const actorWatchlist = [
    ...(worldState.actorContinuity?.newlyActivePreview || []).map(actor => ({
      type: 'new_actor',
      name: actor.name,
      summary: `${actor.name} is newly active across ${actor.domains.join(', ')} in ${actor.regions.join(', ')}.`,
    })),
    ...(worldState.actorContinuity?.strengthenedPreview || []).map(actor => ({
      type: 'strengthened_actor',
      name: actor.name,
      summary: `${actor.name} strengthened by ${Math.round((actor.influenceDelta || 0) * 100)} points${actor.addedRegions?.length ? ` with new regional exposure in ${actor.addedRegions.join(', ')}` : ''}.`,
    })),
  ].slice(0, 6);

  const branchWatchlist = [
    ...(worldState.branchContinuity?.strengthenedBranchPreview || []).map(branch => ({
      type: 'strengthened_branch',
      title: branch.title,
      summary: `${branch.title} in ${branch.kind} moved from ${roundPct(branch.priorProjectedProbability)} to ${roundPct(branch.projectedProbability)}.`,
    })),
    ...(worldState.branchContinuity?.newBranchPreview || []).map(branch => ({
      type: 'new_branch',
      title: branch.title,
      summary: `${branch.title} is newly active with a projected probability near ${roundPct(branch.projectedProbability)}.`,
    })),
    ...(worldState.branchContinuity?.resolvedBranchPreview || []).map(branch => ({
      type: 'resolved_branch',
      title: branch.title,
      summary: `${branch.title} is no longer active in the current run.`,
    })),
  ].slice(0, 6);

  const situationWatchlist = [
    ...(worldState.situationContinuity?.strengthenedSituationPreview || []).map((situation) => ({
      type: 'strengthened_situation',
      label: situation.label,
      summary: `${situation.label} strengthened from ${roundPct(situation.priorAvgProbability)} to ${roundPct(situation.avgProbability)} across ${situation.forecastCount} forecasts.`,
    })),
    ...(worldState.situationContinuity?.newSituationPreview || []).map((situation) => ({
      type: 'new_situation',
      label: situation.label,
      summary: `${situation.label} is newly active across ${situation.forecastCount} forecasts.`,
    })),
    ...(worldState.situationContinuity?.resolvedSituationPreview || []).map((situation) => ({
      type: 'resolved_situation',
      label: situation.label,
      summary: `${situation.label} is no longer active in the current run.`,
    })),
  ].slice(0, 6);

  const continuityWatchlist = [
    ...(worldState.reportContinuity?.repeatedStrengtheningPreview || []).map((situation) => ({
      type: 'persistent_strengthening',
      label: situation.label,
      summary: `${situation.label} has strengthened across ${situation.appearances} runs, from ${roundPct(situation.priorAvgProbability)} to ${roundPct(situation.avgProbability)}.`,
    })),
    ...(worldState.reportContinuity?.emergingPressurePreview || []).map((situation) => ({
      type: 'emerging_pressure',
      label: situation.label,
      summary: `${situation.label} is a newly emerging situation in the current run.`,
    })),
    ...(worldState.reportContinuity?.fadingPressurePreview || []).map((situation) => ({
      type: 'fading_pressure',
      label: situation.label,
      summary: `${situation.label} has faded versus the latest prior world-state snapshot.`,
    })),
  ].slice(0, 6);

  const continuitySummary = `Actors: ${worldState.actorContinuity?.newlyActiveCount || 0} new, ${worldState.actorContinuity?.strengthenedCount || 0} strengthened. Branches: ${worldState.branchContinuity?.newBranchCount || 0} new, ${worldState.branchContinuity?.strengthenedBranchCount || 0} strengthened, ${worldState.branchContinuity?.resolvedBranchCount || 0} resolved. Situations: ${worldState.situationContinuity?.newSituationCount || 0} new, ${worldState.situationContinuity?.strengthenedSituationCount || 0} strengthened, ${worldState.situationContinuity?.resolvedSituationCount || 0} resolved.`;

  const summary = `${worldState.summary} The leading domains in this run are ${leadDomains.join(', ') || 'none'}, the main continuity changes are captured through ${worldState.actorContinuity?.newlyActiveCount || 0} newly active actors and ${worldState.branchContinuity?.strengthenedBranchCount || 0} strengthened branches, and the situation layer currently carries ${worldState.situationClusters?.length || 0} active clusters.`;

  return {
    summary,
    continuitySummary,
    domainOverview: {
      leadDomains,
      activeDomainCount: worldState.domainStates?.length || 0,
      activeRegionCount: worldState.regionalStates?.length || 0,
    },
    regionalHotspots: leadRegions,
    actorWatchlist,
    branchWatchlist,
    situationWatchlist,
    continuityWatchlist,
    keyUncertainties: (worldState.uncertainties || []).slice(0, 6).map(item => item.summary || item),
  };
}

function buildForecastDomainStates(predictions) {
  const states = new Map();

  for (const pred of predictions) {
    if (!states.has(pred.domain)) {
      states.set(pred.domain, {
        domain: pred.domain,
        forecastCount: 0,
        highlightedCount: 0,
        totalProbability: 0,
        totalConfidence: 0,
        totalReadiness: 0,
        regions: new Map(),
        signals: [],
        forecastIds: [],
      });
    }
    const entry = states.get(pred.domain);
    const readiness = pred.readiness?.overall ?? scoreForecastReadiness(pred).overall;
    entry.forecastCount++;
    if ((pred.probability || 0) >= PANEL_MIN_PROBABILITY) entry.highlightedCount++;
    entry.totalProbability += pred.probability || 0;
    entry.totalConfidence += pred.confidence || 0;
    entry.totalReadiness += readiness;
    entry.regions.set(pred.region, (entry.regions.get(pred.region) || 0) + 1);
    entry.forecastIds.push(pred.id);
    entry.signals.push(...(pred.signals || []).map(signal => signal.type));
  }

  return [...states.values()]
    .map((entry) => ({
      domain: entry.domain,
      forecastCount: entry.forecastCount,
      highlightedCount: entry.highlightedCount,
      avgProbability: +(entry.totalProbability / entry.forecastCount).toFixed(3),
      avgConfidence: +(entry.totalConfidence / entry.forecastCount).toFixed(3),
      avgReadiness: +(entry.totalReadiness / entry.forecastCount).toFixed(3),
      topRegions: [...entry.regions.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 4)
        .map(([region, count]) => ({ region, count })),
      topSignals: pickTopCountEntries(summarizeTypeCounts(entry.signals), 5),
      forecastIds: entry.forecastIds.slice(0, 10),
    }))
    .sort((a, b) => b.forecastCount - a.forecastCount || a.domain.localeCompare(b.domain));
}

function buildForecastRegionalStates(predictions) {
  const states = new Map();

  for (const pred of predictions) {
    if (!states.has(pred.region)) {
      states.set(pred.region, {
        region: pred.region,
        forecastCount: 0,
        domains: new Map(),
        totalProbability: 0,
        totalConfidence: 0,
      });
    }
    const entry = states.get(pred.region);
    entry.forecastCount++;
    entry.totalProbability += pred.probability || 0;
    entry.totalConfidence += pred.confidence || 0;
    entry.domains.set(pred.domain, (entry.domains.get(pred.domain) || 0) + 1);
  }

  return [...states.values()]
    .map((entry) => ({
      region: entry.region,
      forecastCount: entry.forecastCount,
      avgProbability: +(entry.totalProbability / entry.forecastCount).toFixed(3),
      avgConfidence: +(entry.totalConfidence / entry.forecastCount).toFixed(3),
      domainMix: Object.fromEntries(
        [...entry.domains.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      ),
    }))
    .sort((a, b) => b.forecastCount - a.forecastCount || a.region.localeCompare(b.region))
    .slice(0, 15);
}

function buildForecastEvidenceLedger(predictions) {
  const supporting = [];
  const counter = [];

  for (const pred of predictions) {
    for (const item of pred.caseFile?.supportingEvidence || []) {
      supporting.push({
        forecastId: pred.id,
        domain: pred.domain,
        region: pred.region,
        summary: item.summary,
      });
    }
    for (const item of pred.caseFile?.counterEvidence || []) {
      counter.push({
        forecastId: pred.id,
        domain: pred.domain,
        region: pred.region,
        type: item.type,
        summary: item.summary,
      });
    }
  }

  return {
    supporting: supporting.slice(0, 25),
    counter: counter.slice(0, 25),
  };
}

function buildForecastRunContinuity(predictions) {
  let newForecasts = 0;
  let risingForecasts = 0;
  let fallingForecasts = 0;
  let stableForecasts = 0;
  const changed = [];

  for (const pred of predictions) {
    if (pred.priorProbability == null || pred.caseFile?.changeSummary?.startsWith('This forecast is new')) {
      newForecasts++;
    }
    if (pred.trend === 'rising') risingForecasts++;
    else if (pred.trend === 'falling') fallingForecasts++;
    else stableForecasts++;

    const delta = Math.abs((pred.probability || 0) - (pred.priorProbability ?? pred.probability ?? 0));
    changed.push({
      id: pred.id,
      title: pred.title,
      region: pred.region,
      domain: pred.domain,
      trend: pred.trend,
      delta: +delta.toFixed(3),
      summary: pred.caseFile?.changeSummary || '',
    });
  }

  return {
    newForecasts,
    risingForecasts,
    fallingForecasts,
    stableForecasts,
    materiallyChanged: changed
      .filter((item) => item.delta >= 0.05 || item.summary.startsWith('This forecast is new'))
      .sort((a, b) => b.delta - a.delta || a.title.localeCompare(b.title))
      .slice(0, 8),
  };
}

function buildForecastRunWorldState(data) {
  const generatedAt = data?.generatedAt || Date.now();
  const predictions = Array.isArray(data?.predictions) ? data.predictions : [];
  const priorWorldState = data?.priorWorldState || null;
  const domainStates = buildForecastDomainStates(predictions);
  const regionalStates = buildForecastRegionalStates(predictions);
  const actorRegistry = buildForecastRunActorRegistry(predictions);
  const actorContinuity = buildActorContinuitySummary(actorRegistry, priorWorldState);
  const branchStates = buildForecastBranchStates(predictions);
  const branchContinuity = buildBranchContinuitySummary(branchStates, priorWorldState);
  const situationClusters = buildSituationClusters(predictions);
  const situationContinuity = buildSituationContinuitySummary(situationClusters, priorWorldState);
  const situationSummary = buildSituationSummary(situationClusters, situationContinuity);
  const reportContinuity = buildReportContinuity({
    situationClusters,
  }, data?.priorWorldStates || []);
  const continuity = buildForecastRunContinuity(predictions);
  const evidenceLedger = buildForecastEvidenceLedger(predictions);
  const activeDomains = domainStates.filter((item) => item.forecastCount > 0).map((item) => item.domain);
  const summary = `${predictions.length} active forecasts are spanning ${activeDomains.length} domains, ${regionalStates.length} key regions, and ${situationClusters.length} clustered situations in this run, with ${continuity.newForecasts} new forecasts, ${continuity.materiallyChanged.length} materially changed paths, ${actorContinuity.newlyActiveCount} newly active actors, and ${branchContinuity.strengthenedBranchCount} strengthened branches.`;
  const worldState = {
    version: 1,
    generatedAt,
    generatedAtIso: new Date(generatedAt).toISOString(),
    summary,
    domainStates,
    regionalStates,
    actorRegistry,
    actorContinuity,
    branchStates,
    branchContinuity,
    situationClusters,
    situationContinuity,
    situationSummary,
    reportContinuity,
    continuity,
    evidenceLedger,
    uncertainties: evidenceLedger.counter.slice(0, 10),
  };
  worldState.report = buildWorldStateReport(worldState);
  return worldState;
}

function summarizeTypeCounts(items) {
  const counts = new Map();
  for (const item of items) {
    if (!item) continue;
    counts.set(item, (counts.get(item) || 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  );
}

function pickTopCountEntries(countMap, limit = 5) {
  return Object.entries(countMap)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([type, count]) => ({ type, count }));
}

function summarizeForecastPopulation(predictions) {
  const domainCounts = Object.fromEntries(FORECAST_DOMAINS.map(domain => [domain, 0]));
  const highlightedDomainCounts = Object.fromEntries(FORECAST_DOMAINS.map(domain => [domain, 0]));

  for (const pred of predictions) {
    domainCounts[pred.domain] = (domainCounts[pred.domain] || 0) + 1;
    if ((pred.probability || 0) >= PANEL_MIN_PROBABILITY) {
      highlightedDomainCounts[pred.domain] = (highlightedDomainCounts[pred.domain] || 0) + 1;
    }
  }

  return {
    forecastCount: predictions.length,
    domainCounts,
    highlightedDomainCounts,
    quietDomains: FORECAST_DOMAINS.filter(domain => (domainCounts[domain] || 0) === 0),
  };
}

function summarizeForecastTraceQuality(predictions, tracedPredictions, enrichmentMeta = null) {
  const fullRun = summarizeForecastPopulation(predictions);
  const traced = summarizeForecastPopulation(tracedPredictions);

  const narrativeSourceCounts = summarizeTypeCounts(
    tracedPredictions.map(item => item.traceMeta?.narrativeSource || 'fallback')
  );

  const promotionSignalCounts = summarizeTypeCounts(
    tracedPredictions.flatMap(item => (item.signals || []).slice(0, 3).map(signal => signal.type))
  );

  const suppressionSignalCounts = summarizeTypeCounts(
    tracedPredictions.flatMap(item => (item.caseFile?.counterEvidence || []).map(counter => counter.type))
  );

  const readinessValues = tracedPredictions.map(item => item.readiness?.overall || 0);
  const avgReadiness = readinessValues.length
    ? +(readinessValues.reduce((sum, value) => sum + value, 0) / readinessValues.length).toFixed(3)
    : 0;
  const avgProbability = tracedPredictions.length
    ? +(tracedPredictions.reduce((sum, item) => sum + (item.probability || 0), 0) / tracedPredictions.length).toFixed(3)
    : 0;
  const avgConfidence = tracedPredictions.length
    ? +(tracedPredictions.reduce((sum, item) => sum + (item.confidence || 0), 0) / tracedPredictions.length).toFixed(3)
    : 0;

  const fallbackCount = narrativeSourceCounts.fallback || 0;
  const llmCombinedCount =
    (narrativeSourceCounts.llm_combined || 0) +
    (narrativeSourceCounts.llm_combined_cache || 0);
  const llmScenarioCount =
    (narrativeSourceCounts.llm_scenario || 0) +
    (narrativeSourceCounts.llm_scenario_cache || 0);
  const enrichedCount = tracedPredictions.length - fallbackCount;

  return {
    fullRun,
    traced: {
      ...traced,
      narrativeSourceCounts,
      fallbackCount,
      fallbackRate: tracedPredictions.length ? +(fallbackCount / tracedPredictions.length).toFixed(3) : 0,
      enrichedCount,
      enrichedRate: tracedPredictions.length ? +(enrichedCount / tracedPredictions.length).toFixed(3) : 0,
      llmCombinedCount,
      llmScenarioCount,
      avgReadiness,
      avgProbability,
      avgConfidence,
      topPromotionSignals: pickTopCountEntries(promotionSignalCounts, 5),
      topSuppressionSignals: pickTopCountEntries(suppressionSignalCounts, 5),
    },
    enrichment: enrichmentMeta,
  };
}

function buildForecastTraceArtifacts(data, context = {}, config = {}) {
  const generatedAt = data?.generatedAt || Date.now();
  const predictions = Array.isArray(data?.predictions) ? data.predictions : [];
  const maxForecasts = config.maxForecasts || getTraceMaxForecasts(predictions.length);
  const tracedPredictions = predictions.slice(0, maxForecasts).map((pred, index) => buildForecastTraceRecord(pred, index + 1));
  const quality = summarizeForecastTraceQuality(predictions, tracedPredictions, data?.enrichmentMeta || null);
  const worldState = buildForecastRunWorldState({
    generatedAt,
    predictions,
    priorWorldState: data?.priorWorldState || null,
    priorWorldStates: data?.priorWorldStates || [],
  });
  const prefix = buildTraceRunPrefix(
    context.runId || `run_${generatedAt}`,
    generatedAt,
    config.basePrefix || 'seed-data/forecast-traces'
  );
  const manifestKey = `${prefix}/manifest.json`;
  const summaryKey = `${prefix}/summary.json`;
  const worldStateKey = `${prefix}/world-state.json`;
  const forecastKeys = tracedPredictions.map(item => ({
    id: item.id,
    title: item.title,
    key: `${prefix}/forecasts/${item.id}.json`,
  }));

  const manifest = {
    version: 1,
    runId: context.runId || '',
    generatedAt,
    generatedAtIso: new Date(generatedAt).toISOString(),
    canonicalKey: CANONICAL_KEY,
    forecastCount: predictions.length,
    tracedForecastCount: tracedPredictions.length,
    manifestKey,
    summaryKey,
    worldStateKey,
    forecastKeys,
  };

  const summary = {
    runId: manifest.runId,
    generatedAt: manifest.generatedAt,
    generatedAtIso: manifest.generatedAtIso,
    forecastCount: manifest.forecastCount,
    tracedForecastCount: manifest.tracedForecastCount,
    quality,
    worldStateSummary: {
      summary: worldState.summary,
      reportSummary: worldState.report?.summary || '',
      reportContinuitySummary: worldState.reportContinuity?.summary || '',
      domainCount: worldState.domainStates.length,
      regionCount: worldState.regionalStates.length,
      situationCount: worldState.situationClusters.length,
      persistentSituations: worldState.situationContinuity.persistentSituationCount,
      newSituations: worldState.situationContinuity.newSituationCount,
      strengthenedSituations: worldState.situationContinuity.strengthenedSituationCount,
      weakenedSituations: worldState.situationContinuity.weakenedSituationCount,
      resolvedSituations: worldState.situationContinuity.resolvedSituationCount,
      historyRuns: worldState.reportContinuity?.history?.length || 0,
      persistentPressures: worldState.reportContinuity?.persistentPressureCount || 0,
      emergingPressures: worldState.reportContinuity?.emergingPressureCount || 0,
      fadingPressures: worldState.reportContinuity?.fadingPressureCount || 0,
      repeatedStrengthening: worldState.reportContinuity?.repeatedStrengtheningCount || 0,
      actorCount: worldState.actorRegistry.length,
      persistentActorCount: worldState.actorContinuity.persistentCount,
      newlyActiveActors: worldState.actorContinuity.newlyActiveCount,
      strengthenedActors: worldState.actorContinuity.strengthenedCount,
      weakenedActors: worldState.actorContinuity.weakenedCount,
      noLongerActiveActors: worldState.actorContinuity.noLongerActiveCount,
      branchCount: worldState.branchStates.length,
      persistentBranches: worldState.branchContinuity.persistentBranchCount,
      newBranches: worldState.branchContinuity.newBranchCount,
      strengthenedBranches: worldState.branchContinuity.strengthenedBranchCount,
      weakenedBranches: worldState.branchContinuity.weakenedBranchCount,
      resolvedBranches: worldState.branchContinuity.resolvedBranchCount,
      newForecasts: worldState.continuity.newForecasts,
      materiallyChanged: worldState.continuity.materiallyChanged.length,
    },
    topForecasts: tracedPredictions.map(item => ({
      rank: item.rank,
      id: item.id,
      title: item.title,
      domain: item.domain,
      region: item.region,
      probability: item.probability,
      confidence: item.confidence,
      trend: item.trend,
      analysisPriority: item.analysisPriority,
      readiness: item.readiness,
      narrativeSource: item.traceMeta?.narrativeSource || 'fallback',
      llmCached: !!item.traceMeta?.llmCached,
    })),
  };

  return {
    prefix,
    manifestKey,
    summaryKey,
    manifest,
    summary,
    worldStateKey,
    worldState,
    forecasts: tracedPredictions.map(item => ({
      key: `${prefix}/forecasts/${item.id}.json`,
      payload: item,
    })),
  };
}

async function writeForecastTracePointer(pointer) {
  const { url, token } = getRedisCredentials();
  await redisCommand(url, token, ['SET', TRACE_LATEST_KEY, JSON.stringify(pointer), 'EX', TRACE_REDIS_TTL_SECONDS]);
  await redisCommand(url, token, ['LPUSH', TRACE_RUNS_KEY, JSON.stringify(pointer)]);
  await redisCommand(url, token, ['LTRIM', TRACE_RUNS_KEY, 0, TRACE_RUNS_MAX - 1]);
  await redisCommand(url, token, ['EXPIRE', TRACE_RUNS_KEY, TRACE_REDIS_TTL_SECONDS]);
}

async function readPreviousForecastWorldState(storageConfig) {
  try {
    const { url, token } = getRedisCredentials();
    const pointer = await redisGet(url, token, TRACE_LATEST_KEY);
    if (!pointer?.worldStateKey) return null;
    return await getR2JsonObject(storageConfig, pointer.worldStateKey);
  } catch (err) {
    console.warn(`  [Trace] Prior world state read failed: ${err.message}`);
    return null;
  }
}

// Returns world states ordered most-recent-first (LPUSH prepends, LRANGE 0 N reads from head).
// Callers that rely on priorMatches[0] being the most recent must not reorder this array.
async function readForecastWorldStateHistory(storageConfig, limit = WORLD_STATE_HISTORY_LIMIT) {
  try {
    const { url, token } = getRedisCredentials();
    const resp = await redisCommand(url, token, ['LRANGE', TRACE_RUNS_KEY, 0, Math.max(0, limit - 1)]);
    const rawPointers = Array.isArray(resp?.result) ? resp.result : [];
    const pointers = rawPointers
      .map((value) => {
        try { return JSON.parse(value); } catch { return null; }
      })
      .filter((item) => item?.worldStateKey);
    const seen = new Set();
    const keys = [];
    for (const pointer of pointers) {
      if (seen.has(pointer.worldStateKey)) continue;
      seen.add(pointer.worldStateKey);
      keys.push(pointer.worldStateKey);
      if (keys.length >= limit) break;
    }
    const states = await Promise.all(keys.map((key) => getR2JsonObject(storageConfig, key).catch(() => null)));
    return states.filter(Boolean);
  } catch (err) {
    console.warn(`  [Trace] World-state history read failed: ${err.message}`);
    return [];
  }
}

async function writeForecastTraceArtifacts(data, context = {}) {
  const storageConfig = resolveR2StorageConfig();
  if (!storageConfig) return null;
  const predictionCount = Array.isArray(data?.predictions) ? data.predictions.length : 0;
  const traceCap = getTraceCapLog(predictionCount);
  console.log(`  Trace cap: raw=${traceCap.raw ?? 'default'} resolved=${traceCap.resolved} total=${traceCap.totalForecasts}`);

  // Keep TRACE_LATEST_KEY as a fallback because writeForecastTracePointer() updates
  // the latest pointer and history list in separate Redis calls. If SET succeeds
  // but LPUSH/LTRIM fails or the history list is stale, continuity should still
  // see the most recent prior world state.
  const [priorWorldStates, priorWorldStateFallback] = await Promise.all([
    readForecastWorldStateHistory(storageConfig, WORLD_STATE_HISTORY_LIMIT),
    readPreviousForecastWorldState(storageConfig),
  ]);
  const priorWorldState = priorWorldStates[0] ?? priorWorldStateFallback;
  const artifacts = buildForecastTraceArtifacts({
    ...data,
    priorWorldState,
    priorWorldStates,
  }, context, {
    basePrefix: storageConfig.basePrefix,
    maxForecasts: getTraceMaxForecasts(predictionCount),
  });

  await putR2JsonObject(storageConfig, artifacts.manifestKey, artifacts.manifest, {
    runid: String(artifacts.manifest.runId || ''),
    kind: 'manifest',
  });
  await putR2JsonObject(storageConfig, artifacts.summaryKey, artifacts.summary, {
    runid: String(artifacts.manifest.runId || ''),
    kind: 'summary',
  });
  await putR2JsonObject(storageConfig, artifacts.worldStateKey, artifacts.worldState, {
    runid: String(artifacts.manifest.runId || ''),
    kind: 'world_state',
  });
  await Promise.all(
    artifacts.forecasts.map((item, index) => putR2JsonObject(storageConfig, item.key, item.payload, {
      runid: String(artifacts.manifest.runId || ''),
      kind: 'forecast',
      rank: String(index + 1),
    })),
  );

  const pointer = {
    runId: artifacts.manifest.runId,
    generatedAt: artifacts.manifest.generatedAt,
    generatedAtIso: artifacts.manifest.generatedAtIso,
    bucket: storageConfig.bucket,
    prefix: artifacts.prefix,
    manifestKey: artifacts.manifestKey,
    summaryKey: artifacts.summaryKey,
    worldStateKey: artifacts.worldStateKey,
    forecastCount: artifacts.manifest.forecastCount,
    tracedForecastCount: artifacts.manifest.tracedForecastCount,
    quality: artifacts.summary.quality,
    worldStateSummary: artifacts.summary.worldStateSummary,
  };
  await writeForecastTracePointer(pointer);
  return pointer;
}

function buildChangeItems(pred, prev) {
  const items = [];
  if (!prev) {
    items.push(`New forecast surfaced in this run at ${roundPct(pred.probability)} over the ${pred.timeHorizon}.`);
    if (pred.caseFile?.supportingEvidence?.[0]?.summary) {
      items.push(`Lead evidence: ${pred.caseFile.supportingEvidence[0].summary}`);
    }
    if (pred.calibration?.marketTitle) {
      items.push(`Initial market check: ${pred.calibration.marketTitle} at ${roundPct(pred.calibration.marketPrice)}.`);
    }
    return items.slice(0, 4);
  }

  const previousSignals = new Set(prev.signals || []);
  const newSignals = (pred.signals || [])
    .map(signal => signal.value)
    .filter(value => !previousSignals.has(value));
  for (const signal of newSignals.slice(0, 2)) {
    items.push(`New signal: ${signal}`);
  }

  const previousHeadlines = new Set(prev.newsContext || []);
  const newHeadlines = (pred.newsContext || []).filter(headline => !previousHeadlines.has(headline));
  for (const headline of newHeadlines.slice(0, 2)) {
    items.push(`New reporting: ${headline}`);
  }

  if (pred.calibration) {
    const prevMarket = prev.calibration;
    if (!prevMarket || prevMarket.marketTitle !== pred.calibration.marketTitle) {
      items.push(`New market anchor: ${pred.calibration.marketTitle} at ${roundPct(pred.calibration.marketPrice)}.`);
    } else if (Math.abs((pred.calibration.marketPrice || 0) - (prevMarket.marketPrice || 0)) >= 0.05) {
      items.push(`Market moved from ${roundPct(prevMarket.marketPrice)} to ${roundPct(pred.calibration.marketPrice)} in ${pred.calibration.marketTitle}.`);
    }
  }

  if (items.length === 0) {
    if (Math.abs(pred.probability - (prev.probability || pred.priorProbability || pred.probability)) < 0.05) {
      items.push('Evidence mix is broadly unchanged from the prior snapshot.');
    } else if (pred.caseFile?.counterEvidence?.[0]?.summary) {
      items.push(`Counter-pressure: ${pred.caseFile.counterEvidence[0].summary}`);
    }
  }

  return items.slice(0, 4);
}

function buildChangeSummary(pred, prev, changeItems) {
  if (!prev) {
    return `This forecast is new in the current run, entering at ${roundPct(pred.probability)} with a ${pred.trend} trajectory.`;
  }

  const delta = pred.probability - prev.probability;
  const movement = Math.abs(delta);
  const lead = movement >= 0.05
    ? `Probability ${delta > 0 ? 'rose' : 'fell'} from ${roundPct(prev.probability)} to ${roundPct(pred.probability)} since the prior run.`
    : `Probability is holding near ${roundPct(pred.probability)} versus ${roundPct(prev.probability)} in the prior run.`;

  const follow = changeItems[0]
    ? changeItems[0]
    : pred.trend === 'rising'
      ? 'The evidence mix is leaning more supportive than in the last snapshot.'
      : pred.trend === 'falling'
        ? 'The latest snapshot is showing more restraint than the previous run.'
        : 'The evidence mix remains broadly similar to the previous run.';

  return `${lead} ${follow}`.slice(0, 500);
}

function annotateForecastChanges(predictions, prior) {
  const priorMap = new Map((prior?.predictions || []).map(item => [item.id, item]));
  for (const pred of predictions) {
    if (!pred.caseFile) buildForecastCase(pred);
    const prev = priorMap.get(pred.id);
    const changeItems = buildChangeItems(pred, prev);
    pred.caseFile.changeItems = changeItems;
    pred.caseFile.changeSummary = buildChangeSummary(pred, prev, changeItems);
  }
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value || 0));
}

function scoreForecastReadiness(pred) {
  const supportCount = pred.caseFile?.supportingEvidence?.length || 0;
  const counterCount = pred.caseFile?.counterEvidence?.length || 0;
  const triggerCount = pred.caseFile?.triggers?.length || 0;
  const actorCount = pred.caseFile?.actorLenses?.length || 0;
  const headlineCount = pred.newsContext?.length || 0;
  const sourceCount = new Set((pred.signals || []).map(s => SIGNAL_TO_SOURCE[s.type] || s.type)).size;

  const evidenceScore = clamp01((normalize(supportCount, 0, 6) * 0.55) + (normalize(sourceCount, 1, 4) * 0.45));
  const groundingScore = clamp01(
    (headlineCount > 0 ? Math.min(1, headlineCount / 2) * 0.35 : 0) +
    (pred.calibration ? 0.3 : 0) +
    (triggerCount > 0 ? Math.min(1, triggerCount / 3) * 0.35 : 0)
  );
  const alternativeScore = clamp01(
    ((pred.caseFile?.baseCase || supportCount > 0) ? 1 : 0) * (1 / 3) +
    ((pred.caseFile?.escalatoryCase || triggerCount > 0 || (pred.cascades?.length || 0) > 0) ? 1 : 0) * (1 / 3) +
    ((pred.caseFile?.contrarianCase || counterCount > 0 || pred.trend === 'falling') ? 1 : 0) * (1 / 3)
  );
  const actorScore = actorCount > 0 ? Math.min(1, actorCount / 3) : 0;
  const driftPenalty = pred.calibration ? Math.min(0.18, Math.abs(pred.calibration.drift || 0) * 0.6) : 0;
  const overall = clamp01(
    evidenceScore * 0.4 +
    groundingScore * 0.25 +
    alternativeScore * 0.2 +
    actorScore * 0.15 -
    driftPenalty
  );

  return {
    evidenceScore: +evidenceScore.toFixed(3),
    groundingScore: +groundingScore.toFixed(3),
    alternativeScore: +alternativeScore.toFixed(3),
    actorScore: +actorScore.toFixed(3),
    overall: +overall.toFixed(3),
  };
}

function computeAnalysisPriority(pred) {
  const readiness = scoreForecastReadiness(pred);
  const baseScore = (pred.probability || 0) * (pred.confidence || 0);
  const counterEvidenceTypes = new Set((pred.caseFile?.counterEvidence || []).map(item => item.type));
  const hasNewsCorroboration = (pred.signals || []).some(signal => signal.type === 'news_corroboration');
  const readinessMultiplier = 0.78 + (readiness.overall * 0.5);
  const groundingBonus = readiness.groundingScore * 0.025;
  const evidenceBonus = readiness.evidenceScore * 0.02;
  const corroborationBonus = hasNewsCorroboration ? 0.018 : 0;
  const calibrationBonus = pred.calibration ? 0.012 : 0;
  const priorityDomainBonus = ENRICHMENT_PRIORITY_DOMAINS.includes(pred.domain) && readiness.overall >= 0.45 ? 0.012 : 0;
  const trendBonus = pred.trend === 'rising' ? 0.015 : pred.trend === 'falling' ? -0.005 : 0;
  // penalties
  const lowGroundingPenalty = readiness.groundingScore < 0.2 ? 0.02 : 0;
  const lowEvidencePenalty = readiness.evidenceScore < 0.25 ? 0.015 : 0;
  const coveragePenalty = counterEvidenceTypes.has('coverage_gap') ? 0.015 : 0;
  const confidencePenalty = counterEvidenceTypes.has('confidence') ? 0.012 : 0;
  const cyberThinSignalPenalty = pred.domain === 'cyber' && counterEvidenceTypes.has('coverage_gap') ? 0.01 : 0;
  return +(
    (baseScore * readinessMultiplier) +
    groundingBonus +
    evidenceBonus +
    corroborationBonus +
    calibrationBonus +
    priorityDomainBonus +
    trendBonus -
    lowGroundingPenalty -
    lowEvidencePenalty -
    coveragePenalty -
    confidencePenalty -
    cyberThinSignalPenalty
  ).toFixed(6);
}

function rankForecastsForAnalysis(predictions) {
  const priorities = new Map(predictions.map(p => [p, computeAnalysisPriority(p)]));
  predictions.sort((a, b) => {
    const delta = priorities.get(b) - priorities.get(a);
    if (Math.abs(delta) > 1e-6) return delta;
    return (b.probability * b.confidence) - (a.probability * a.confidence);
  });
}

function filterPublishedForecasts(predictions, minProbability = PUBLISH_MIN_PROBABILITY) {
  let weakFallbackCount = 0;
  const result = predictions.filter((pred) => {
    if ((pred?.probability || 0) <= minProbability) return false;
    const narrativeSource = pred?.traceMeta?.narrativeSource || 'fallback';
    if (narrativeSource !== 'fallback') return true;
    const readiness = pred?.readiness?.overall ?? scoreForecastReadiness(pred).overall;
    const priority = typeof pred?.analysisPriority === 'number' ? pred.analysisPriority : computeAnalysisPriority(pred);
    const counterEvidenceTypes = new Set((pred?.caseFile?.counterEvidence || []).map(item => item.type));
    const weakFallback = (
      readiness < 0.4 &&
      priority < 0.08 &&
      (pred?.confidence || 0) < 0.45 &&
      (pred?.probability || 0) < 0.12 &&
      counterEvidenceTypes.has('coverage_gap') &&
      counterEvidenceTypes.has('confidence')
    );
    if (weakFallback) weakFallbackCount++;
    return !weakFallback;
  });
  if (weakFallbackCount > 0) {
    console.log(`  [filterPublished] Suppressed ${weakFallbackCount} weak fallback forecast(s)`);
  }
  return result;
}

function selectForecastsForEnrichment(predictions, options = {}) {
  const maxCombined = options.maxCombined ?? ENRICHMENT_COMBINED_MAX;
  const maxScenario = options.maxScenario ?? ENRICHMENT_SCENARIO_MAX;
  const maxPerDomain = options.maxPerDomain ?? ENRICHMENT_MAX_PER_DOMAIN;
  const minReadiness = options.minReadiness ?? ENRICHMENT_MIN_READINESS;
  const maxTotal = maxCombined + maxScenario;

  const ranked = predictions
    .map((pred, index) => ({
      pred,
      index,
      readiness: scoreForecastReadiness(pred),
      analysisPriority: computeAnalysisPriority(pred),
    }))
    .filter(item => item.readiness.overall >= minReadiness)
    .sort((a, b) => {
      if (b.analysisPriority !== a.analysisPriority) return b.analysisPriority - a.analysisPriority;
      return (b.pred.probability * b.pred.confidence) - (a.pred.probability * a.pred.confidence);
    });

  const selectedDomains = new Map();
  const selectedIds = new Set();
  const combined = [];
  const scenarioOnly = [];
  const reservedScenarioDomains = [];
  let droppedByDomainCap = 0;

  function trySelect(target, item) {
    if (!item || selectedIds.has(item.pred.id)) return false;
    const currentCount = selectedDomains.get(item.pred.domain) || 0;
    if (currentCount >= maxPerDomain) {
      droppedByDomainCap++;
      return false;
    }
    target.push(item);
    selectedIds.add(item.pred.id);
    selectedDomains.set(item.pred.domain, currentCount + 1);
    return true;
  }

  for (const item of ranked) {
    if (combined.length >= maxCombined) break;
    trySelect(combined, item);
  }

  for (const domain of ENRICHMENT_PRIORITY_DOMAINS) {
    if (scenarioOnly.length >= maxScenario) break;
    const candidate = ranked.find(item => item.pred.domain === domain && !selectedIds.has(item.pred.id));
    if (candidate && trySelect(scenarioOnly, candidate)) reservedScenarioDomains.push(domain);
  }

  for (const item of ranked) {
    if ((combined.length + scenarioOnly.length) >= maxTotal || scenarioOnly.length >= maxScenario) break;
    trySelect(scenarioOnly, item);
  }

  return {
    combined: combined.map(item => item.pred),
    scenarioOnly: scenarioOnly.map(item => item.pred),
    telemetry: {
      candidateCount: predictions.length,
      readinessEligibleCount: ranked.length,
      selectedCombinedCount: combined.length,
      selectedScenarioCount: scenarioOnly.length,
      reservedScenarioDomains,
      droppedByDomainCap,
      selectedDomainCounts: Object.fromEntries(selectedDomains),
    },
  };
}

// ── Phase 2: LLM Scenario Enrichment ───────────────────────
const FORECAST_LLM_PROVIDERS = [
  { name: 'groq', envKey: 'GROQ_API_KEY', apiUrl: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.1-8b-instant', timeout: 20_000 },
  { name: 'openrouter', envKey: 'OPENROUTER_API_KEY', apiUrl: 'https://openrouter.ai/api/v1/chat/completions', model: 'google/gemini-2.5-flash', timeout: 25_000 },
];
const FORECAST_LLM_PROVIDER_NAMES = new Set(FORECAST_LLM_PROVIDERS.map(provider => provider.name));

function parseForecastProviderOrder(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const seen = new Set();
  const providers = [];
  for (const item of raw.split(',')) {
    const provider = item.trim().toLowerCase();
    if (!FORECAST_LLM_PROVIDER_NAMES.has(provider) || seen.has(provider)) continue;
    seen.add(provider);
    providers.push(provider);
  }
  return providers.length > 0 ? providers : null;
}

function getForecastLlmCallOptions(stage = 'default') {
  const defaultProviderOrder = FORECAST_LLM_PROVIDERS.map(provider => provider.name);
  const globalProviderOrder = parseForecastProviderOrder(process.env.FORECAST_LLM_PROVIDER_ORDER);
  const combinedProviderOrder = parseForecastProviderOrder(process.env.FORECAST_LLM_COMBINED_PROVIDER_ORDER);
  const providerOrder = stage === 'combined'
    ? (combinedProviderOrder || globalProviderOrder || defaultProviderOrder)
    : (globalProviderOrder || defaultProviderOrder);

  const openrouterModel = stage === 'combined'
    ? (process.env.FORECAST_LLM_COMBINED_MODEL_OPENROUTER || process.env.FORECAST_LLM_MODEL_OPENROUTER)
    : process.env.FORECAST_LLM_MODEL_OPENROUTER;

  return {
    providerOrder,
    modelOverrides: openrouterModel ? { openrouter: openrouterModel } : {},
  };
}

function resolveForecastLlmProviders(options = {}) {
  const requestedOrder = Array.isArray(options.providerOrder) && options.providerOrder.length > 0
    ? options.providerOrder
    : FORECAST_LLM_PROVIDERS.map(provider => provider.name);

  const seen = new Set();
  const providers = [];
  for (const providerName of requestedOrder) {
    if (seen.has(providerName)) continue;
    const provider = FORECAST_LLM_PROVIDERS.find(item => item.name === providerName);
    if (!provider) continue;
    seen.add(providerName);
    providers.push({
      ...provider,
      model: options.modelOverrides?.[provider.name] || provider.model,
    });
  }
  return providers.length > 0 ? providers : FORECAST_LLM_PROVIDERS;
}

function summarizeForecastLlmOptions(options = {}) {
  return {
    providerOrder: Array.isArray(options.providerOrder) ? options.providerOrder : [],
    modelOverrides: options.modelOverrides || {},
  };
}

const SCENARIO_SYSTEM_PROMPT = `You are a senior geopolitical intelligence analyst writing scenario briefs.

RULES:
- Write four fields for each prediction:
  - scenario: 1-2 sentence executive summary of the base case
  - baseCase: 2 sentences on the most likely path
  - escalatoryCase: 1-2 sentences on what would push risk materially higher
  - contrarianCase: 1-2 sentences on what would stall or reverse the path
- Every field MUST cite at least one concrete signal, headline, market cue, or trigger from the provided case file.
- Do NOT use your own knowledge. Base everything on the provided evidence only.
- Keep each field under 90 words.

Respond with ONLY a JSON array: [{"index": 0, "scenario": "...", "baseCase": "...", "escalatoryCase": "...", "contrarianCase": "..."}, ...]`;

// Phase 3: Combined scenario + perspectives prompt for top-2 predictions
const COMBINED_SYSTEM_PROMPT = `You are a senior geopolitical intelligence analyst. For each prediction:

1. Write a SCENARIO (1-2 sentences, evidence-grounded, citing signal values)
2. Write 3 CASES (1-2 sentences each):
   - BASE_CASE: the most likely path
   - ESCALATORY_CASE: what would push risk higher
   - CONTRARIAN_CASE: what would stall or reverse the path
3. Write 3 PERSPECTIVES (1-2 sentences each):
   - STRATEGIC: Neutral analysis of what signals indicate
   - REGIONAL: What this means for actors in the affected region
   - CONTRARIAN: What factors could prevent or reverse this outcome, grounded in the counter-evidence

RULES:
- Every field MUST cite a specific signal value, headline, market cue, or trigger from the case file
- Base everything on provided data, not your knowledge
- Do NOT use hedging without a data point

Output JSON array:
[{"index": 0, "scenario": "...", "baseCase": "...", "escalatoryCase": "...", "contrarianCase": "...", "strategic": "...", "regional": "...", "contrarian": "..."}, ...]`;

function validatePerspectives(items, predictions) {
  if (!Array.isArray(items)) return [];
  return items.filter(item => {
    if (typeof item.index !== 'number' || item.index < 0 || item.index >= predictions.length) return false;
    for (const key of ['strategic', 'regional', 'contrarian']) {
      if (typeof item[key] !== 'string') return false;
      item[key] = item[key].replace(/<[^>]*>/g, '').trim().slice(0, 300);
      if (item[key].length < 20) return false;
    }
    return true;
  });
}

function validateCaseNarratives(items, predictions) {
  if (!Array.isArray(items)) return [];
  return items.filter(item => {
    if (typeof item.index !== 'number' || item.index < 0 || item.index >= predictions.length) return false;
    for (const key of ['baseCase', 'escalatoryCase', 'contrarianCase']) {
      if (typeof item[key] !== 'string') return false;
      item[key] = item[key].replace(/<[^>]*>/g, '').trim().slice(0, 500);
      if (item[key].length < 20) return false;
    }
    return true;
  });
}

function sanitizeForPrompt(text) {
  return (text || '').replace(/[\n\r]/g, ' ').replace(/[<>{}\x00-\x1f]/g, '').slice(0, 200).trim();
}

function parseLLMScenarios(text) {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\|thinking\|>[\s\S]*?<\|\/thinking\|>/gi, '')
    .trim();
  // Try complete JSON array first
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (match) {
    try { return JSON.parse(match[0]); } catch { /* fall through to repair */ }
  }
  // Try truncated: find opening bracket and attempt repair
  const bracketIdx = cleaned.indexOf('[');
  if (bracketIdx === -1) return null;
  const partial = cleaned.slice(bracketIdx);
  for (const suffix of ['"}]', '}]', '"]', ']']) {
    try { return JSON.parse(partial + suffix); } catch { /* next */ }
  }
  return null;
}

function hasEvidenceReference(text, candidate) {
  const normalized = sanitizeForPrompt(candidate).toLowerCase();
  if (!normalized) return false;
  if (text.includes(normalized)) return true;
  return tokenizeText(normalized).some(token => token.length > 3 && text.includes(token));
}

function validateScenarios(scenarios, predictions) {
  if (!Array.isArray(scenarios)) return [];
  return scenarios.filter(s => {
    if (!s || typeof s.scenario !== 'string' || s.scenario.length < 30) return false;
    if (typeof s.index !== 'number' || s.index < 0 || s.index >= predictions.length) return false;
    const pred = predictions[s.index];
    const scenarioLower = s.scenario.toLowerCase();
    const evidenceCandidates = [
      ...pred.signals.flatMap(sig => [sig.type, sig.value]),
      ...(pred.newsContext || []),
      pred.calibration?.marketTitle || '',
      pred.calibration ? roundPct(pred.calibration.marketPrice) : '',
      ...(pred.caseFile?.supportingEvidence || []).map(item => item.summary || ''),
      ...(pred.caseFile?.counterEvidence || []).map(item => item.summary || ''),
      ...(pred.caseFile?.triggers || []),
    ];
    const hasEvidenceRef = evidenceCandidates.some(candidate => hasEvidenceReference(scenarioLower, candidate));
    if (!hasEvidenceRef) {
      console.warn(`  [LLM] Scenario ${s.index} rejected: no evidence reference`);
      return false;
    }
    s.scenario = s.scenario.replace(/<[^>]*>/g, '').slice(0, 500);
    return true;
  });
}

function getEnrichmentFailureReason({ result, raw, scenarios = 0, perspectives = 0, cases = 0 }) {
  if (!result) return 'call_failed';
  if (raw == null) return 'parse_failed';
  if (Array.isArray(raw) && raw.length === 0) return 'empty_output';
  if ((scenarios + perspectives + cases) === 0) return 'validation_failed';
  return '';
}

async function callForecastLLM(systemPrompt, userPrompt, options = {}) {
  const stage = options.stage || 'default';
  const providers = resolveForecastLlmProviders(options);
  const requestedOrder = Array.isArray(options.providerOrder) && options.providerOrder.length > 0
    ? options.providerOrder.join(',')
    : providers.map(provider => provider.name).join(',');
  console.log(`  [LLM:${stage}] providerOrder=${requestedOrder} modelOverrides=${JSON.stringify(options.modelOverrides || {})}`);

  for (const provider of providers) {
    const apiKey = process.env[provider.envKey];
    if (!apiKey) continue;
    try {
      const resp = await fetch(provider.apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': CHROME_UA,
          ...(provider.name === 'openrouter' ? { 'HTTP-Referer': 'https://worldmonitor.app', 'X-Title': 'World Monitor' } : {}),
        },
        body: JSON.stringify({
          model: provider.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 1500,
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(provider.timeout),
      });
      if (!resp.ok) {
        console.warn(`  [LLM:${stage}] ${provider.name} HTTP ${resp.status}`);
        continue;
      }
      const json = await resp.json();
      const text = json.choices?.[0]?.message?.content?.trim();
      if (!text || text.length < 20) continue;
      const model = json.model || provider.model;
      console.log(`  [LLM:${stage}] ${provider.name} success model=${model}`);
      return { text, model, provider: provider.name };
    } catch (err) {
      console.warn(`  [LLM:${stage}] ${provider.name} ${err.message}`);
    }
  }
  return null;
}

async function redisSet(url, token, key, data, ttlSeconds) {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['SET', key, JSON.stringify(data), 'EX', ttlSeconds]),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) { console.warn(`  [Redis] Cache write failed for ${key}: ${err.message}`); }
}

function buildCacheHash(preds) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(preds.map(p => ({
      id: p.id, d: p.domain, r: p.region, p: p.probability,
      s: p.signals.map(s => s.value).join(','),
      c: p.calibration?.drift,
      n: (p.newsContext || []).join(','),
      t: p.trend,
      j: p.projections ? `${p.projections.h24}|${p.projections.d7}|${p.projections.d30}` : '',
      g: (p.cascades || []).map(cascade => `${cascade.domain}:${cascade.effect}:${cascade.probability}`).join(','),
    }))))
    .digest('hex').slice(0, 16);
}

function buildUserPrompt(preds) {
  const predsText = preds.map((p, i) => {
    const sigs = p.signals.map(s => `[SIGNAL] ${sanitizeForPrompt(s.value)}`).join('\n');
    const cal = p.calibration ? `\n[CALIBRATION] ${sanitizeForPrompt(p.calibration.marketTitle)} at ${Math.round(p.calibration.marketPrice * 100)}%` : '';
    const projections = p.projections
      ? `\n[PROJECTIONS] 24h ${Math.round(p.projections.h24 * 100)}% | 7d ${Math.round(p.projections.d7 * 100)}% | 30d ${Math.round(p.projections.d30 * 100)}%`
      : '';
    const cascades = (p.cascades || []).length > 0
      ? `\n[CASCADES] ${p.cascades.map(c => `${sanitizeForPrompt(c.domain)} via ${sanitizeForPrompt(c.effect)} (${Math.round(c.probability * 100)}%)`).join('; ')}`
      : '';
    const headlines = (p.newsContext || []).slice(0, 3).map(h => `- ${sanitizeForPrompt(h)}`).join('\n');
    const news = headlines ? `\n[HEADLINES]\n${headlines}` : '\n[HEADLINES]\n- No directly matched headlines';
    const caseFile = p.caseFile || {};
    const support = (caseFile.supportingEvidence || [])
      .slice(0, 4)
      .map(item => `- ${sanitizeForPrompt(item.summary)} (${Math.round((item.weight || 0) * 100)}%)`)
      .join('\n');
    const counter = (caseFile.counterEvidence || [])
      .slice(0, 3)
      .map(item => `- ${sanitizeForPrompt(item.summary)}`)
      .join('\n');
    const triggers = (caseFile.triggers || []).slice(0, 3).map(item => `- ${sanitizeForPrompt(item)}`).join('\n');
    const actors = (caseFile.actors || [])
      .slice(0, 3)
      .map(actor => `- ${sanitizeForPrompt(actor.name)} [${sanitizeForPrompt(actor.category)}]: ${sanitizeForPrompt(actor.role)} | objective: ${sanitizeForPrompt(actor.objectives?.[0] || '')} | likely action: ${sanitizeForPrompt(actor.likelyActions?.[0] || '')}`)
      .join('\n');
    const worldSummary = caseFile.worldState?.summary ? sanitizeForPrompt(caseFile.worldState.summary) : '';
    const worldPressures = (caseFile.worldState?.activePressures || []).slice(0, 3).map(item => `- ${sanitizeForPrompt(item)}`).join('\n');
    const worldStabilizers = (caseFile.worldState?.stabilizers || []).slice(0, 2).map(item => `- ${sanitizeForPrompt(item)}`).join('\n');
    const worldUnknowns = (caseFile.worldState?.keyUnknowns || []).slice(0, 3).map(item => `- ${sanitizeForPrompt(item)}`).join('\n');
    const branches = (caseFile.branches || [])
      .slice(0, 3)
      .map(branch => `- ${sanitizeForPrompt(branch.kind)}: ${sanitizeForPrompt(branch.summary)} | outcome: ${sanitizeForPrompt(branch.outcome)} | projected: ${Math.round((branch.projectedProbability || 0) * 100)}%`)
      .join('\n');
    const caseSections = `${support ? `\n[SUPPORTING_EVIDENCE]\n${support}` : ''}${counter ? `\n[COUNTER_EVIDENCE]\n${counter}` : ''}${triggers ? `\n[TRIGGERS]\n${triggers}` : ''}${actors ? `\n[ACTORS]\n${actors}` : ''}${worldSummary ? `\n[WORLD_STATE]\n- ${worldSummary}` : ''}${worldPressures ? `\n[ACTIVE_PRESSURES]\n${worldPressures}` : ''}${worldStabilizers ? `\n[STABILIZERS]\n${worldStabilizers}` : ''}${worldUnknowns ? `\n[KEY_UNKNOWNS]\n${worldUnknowns}` : ''}${branches ? `\n[SIMULATED_BRANCHES]\n${branches}` : ''}`;
    return `[${i}] "${sanitizeForPrompt(p.title)}" (${p.domain}, ${p.region})\nProbability: ${Math.round(p.probability * 100)}% | Confidence: ${Math.round(p.confidence * 100)}% | Trend: ${p.trend} | Horizon: ${p.timeHorizon}\n${sigs}${cal}${projections}${cascades}${news}${caseSections}`;
  }).join('\n\n');
  return `Predictions to analyze:\n\n${predsText}`;
}

function buildFallbackBaseCase(pred) {
  const branch = pred.caseFile?.branches?.find(item => item.kind === 'base');
  if (branch?.summary && branch?.outcome) {
    return `${branch.summary} ${branch.outcome}`.slice(0, 500);
  }
  const support = pred.caseFile?.supportingEvidence?.[0]?.summary || pred.signals?.[0]?.value || pred.title;
  const secondary = pred.caseFile?.supportingEvidence?.[1]?.summary || pred.signals?.[1]?.value;
  const lead = `${support} is the clearest active driver behind this ${pred.domain} forecast in ${pred.region}.`;
  const follow = secondary
    ? `${secondary} keeps the base case anchored near ${roundPct(pred.probability)} over the ${pred.timeHorizon}.`
    : `The most likely path remains near ${roundPct(pred.probability)} over the ${pred.timeHorizon}, with ${pred.trend} momentum.`;
  return `${lead} ${follow}`.slice(0, 500);
}

function buildFallbackEscalatoryCase(pred) {
  const branch = pred.caseFile?.branches?.find(item => item.kind === 'escalatory');
  if (branch?.summary && branch?.outcome) {
    return `${branch.summary} ${branch.outcome}`.slice(0, 500);
  }
  const trigger = pred.caseFile?.triggers?.[0];
  const cascade = pred.cascades?.[0];
  const firstSignal = pred.signals?.[0]?.value || pred.title;
  const escalation = trigger
    ? `${trigger} That would likely push the forecast above its current ${roundPct(pred.probability)} baseline.`
    : `${firstSignal} intensifying further would move this forecast above its current ${roundPct(pred.probability)} baseline.`;
  const spillover = cascade
    ? `The first spillover risk would likely appear in ${cascade.domain} via ${cascade.effect}.`
    : `The next move higher would depend on the current ${pred.trend} trajectory hardening into a clearer signal cluster.`;
  return `${escalation} ${spillover}`.slice(0, 500);
}

function buildFallbackContrarianCase(pred) {
  const branch = pred.caseFile?.branches?.find(item => item.kind === 'contrarian');
  if (branch?.summary && branch?.outcome) {
    return `${branch.summary} ${branch.outcome}`.slice(0, 500);
  }
  const counter = pred.caseFile?.counterEvidence?.[0]?.summary;
  const calibration = pred.calibration
    ? `A move in "${pred.calibration.marketTitle}" away from the current ${roundPct(pred.calibration.marketPrice)} market signal would challenge the existing baseline.`
    : 'A failure to add corroborating evidence across sources would challenge the current baseline.';
  return `${counter || calibration} ${pred.trend === 'falling' ? 'The already falling trend is the main stabilizing clue.' : 'The base case still needs further confirmation to stay durable.'}`.slice(0, 500);
}

function buildFallbackScenario(pred) {
  const baseCase = pred.caseFile?.baseCase || buildFallbackBaseCase(pred);
  return baseCase.slice(0, 500);
}

function buildFeedSummary(pred) {
  const lead = pred.caseFile?.baseCase || pred.scenario || buildFallbackScenario(pred);
  const compact = lead.replace(/\s+/g, ' ').trim();
  const summary = compact.length > 180 ? `${compact.slice(0, 177).trimEnd()}...` : compact;
  if (summary) return summary;
  return `${pred.title} remains live at ${roundPct(pred.probability)} over the ${pred.timeHorizon}.`;
}

function buildFallbackPerspectives(pred) {
  const firstSignal = pred.caseFile?.supportingEvidence?.[0]?.summary || pred.signals?.[0]?.value || pred.title;
  const contrarian = pred.caseFile?.contrarianCase || buildFallbackContrarianCase(pred);
  return {
    strategic: `${firstSignal} is setting the strategic baseline, and the current ${Math.round(pred.probability * 100)}% probability implies a live but not settled risk path.`,
    regional: `For actors in ${pred.region}, the practical implication is continued sensitivity to short-term triggers over the ${pred.timeHorizon}, especially if the current ${pred.trend} trend persists.`,
    contrarian,
  };
}

function populateFallbackNarratives(predictions) {
  let fallbackCount = 0;
  for (const pred of predictions) {
    if (!pred.caseFile) buildForecastCase(pred);
    if (!pred.caseFile.baseCase) pred.caseFile.baseCase = buildFallbackBaseCase(pred);
    if (!pred.caseFile.escalatoryCase) pred.caseFile.escalatoryCase = buildFallbackEscalatoryCase(pred);
    if (!pred.caseFile.contrarianCase) pred.caseFile.contrarianCase = buildFallbackContrarianCase(pred);
    if (!pred.caseFile.changeItems?.length || !pred.caseFile.changeSummary) {
      const fallbackItems = buildChangeItems(pred, null);
      pred.caseFile.changeItems = fallbackItems;
      pred.caseFile.changeSummary = buildChangeSummary(pred, null, fallbackItems);
    }
    if (!pred.scenario) pred.scenario = buildFallbackScenario(pred);
    if (!pred.feedSummary) pred.feedSummary = buildFeedSummary(pred);
    if (!pred.perspectives) pred.perspectives = buildFallbackPerspectives(pred);
    if (!pred.traceMeta) {
      applyTraceMeta(pred, {
        narrativeSource: 'fallback',
        llmCached: false,
        llmProvider: '',
        llmModel: '',
        branchSource: 'deterministic',
      });
      fallbackCount++;
    }
  }
  if (fallbackCount > 0) {
    console.log(`  [fallbackNarratives] Applied fallback narratives to ${fallbackCount} forecast(s)`);
  }
}

async function enrichScenariosWithLLM(predictions) {
  if (predictions.length === 0) return null;
  const { url, token } = getRedisCredentials();
  const enrichmentTargets = selectForecastsForEnrichment(predictions);
  const combinedLlmOptions = getForecastLlmCallOptions('combined');
  const scenarioLlmOptions = getForecastLlmCallOptions('scenario');
  const enrichmentMeta = {
    selection: enrichmentTargets.telemetry,
    combined: {
      requested: enrichmentTargets.combined.length,
      source: 'none',
      provider: '',
      model: '',
      scenarios: 0,
      perspectives: 0,
      cases: 0,
      rawItemCount: 0,
      failureReason: '',
      succeeded: false,
    },
    scenario: {
      requested: enrichmentTargets.scenarioOnly.length,
      source: 'none',
      provider: '',
      model: '',
      scenarios: 0,
      cases: 0,
      rawItemCount: 0,
      failureReason: '',
      succeeded: false,
    },
  };

  // Higher-quality top forecasts get richer scenario + perspective treatment.
  const topWithPerspectives = enrichmentTargets.combined;
  const scenarioOnly = enrichmentTargets.scenarioOnly;

  // Call 1: Combined scenario + perspectives for top-2
  if (topWithPerspectives.length > 0) {
    const hash = buildCacheHash(topWithPerspectives);
    const cacheKey = `forecast:llm-combined:${hash}`;
    const cached = await redisGet(url, token, cacheKey);

    if (cached?.items) {
      enrichmentMeta.combined.source = 'cache';
      enrichmentMeta.combined.succeeded = true;
      enrichmentMeta.combined.provider = 'cache';
      enrichmentMeta.combined.model = 'cache';
      enrichmentMeta.combined.scenarios = cached.items.filter(item => item.scenario).length;
      enrichmentMeta.combined.perspectives = cached.items.filter(item => item.strategic || item.regional || item.contrarian).length;
      enrichmentMeta.combined.cases = cached.items.filter(item => item.baseCase || item.escalatoryCase || item.contrarianCase).length;
      enrichmentMeta.combined.rawItemCount = cached.items.length;
      for (const item of cached.items) {
        if (item.index >= 0 && item.index < topWithPerspectives.length) {
          applyTraceMeta(topWithPerspectives[item.index], {
            narrativeSource: 'llm_combined_cache',
            llmCached: true,
            llmProvider: 'cache',
            llmModel: 'cache',
            branchSource: 'deterministic',
          });
          if (item.scenario) topWithPerspectives[item.index].scenario = item.scenario;
          if (item.strategic) topWithPerspectives[item.index].perspectives = { strategic: item.strategic, regional: item.regional, contrarian: item.contrarian };
          if (item.baseCase || item.escalatoryCase || item.contrarianCase) {
            topWithPerspectives[item.index].caseFile = {
              ...(topWithPerspectives[item.index].caseFile || buildForecastCase(topWithPerspectives[item.index])),
              baseCase: item.baseCase || topWithPerspectives[item.index].caseFile?.baseCase || '',
              escalatoryCase: item.escalatoryCase || topWithPerspectives[item.index].caseFile?.escalatoryCase || '',
              contrarianCase: item.contrarianCase || topWithPerspectives[item.index].caseFile?.contrarianCase || '',
            };
          }
        }
      }
      console.log(JSON.stringify({ event: 'llm_combined', cached: true, count: cached.items.length, hash }));
    } else {
      const t0 = Date.now();
      const result = await callForecastLLM(COMBINED_SYSTEM_PROMPT, buildUserPrompt(topWithPerspectives), { ...combinedLlmOptions, stage: 'combined' });
      if (result) {
        const raw = parseLLMScenarios(result.text);
        const validScenarios = validateScenarios(raw, topWithPerspectives);
        const validPerspectives = validatePerspectives(raw, topWithPerspectives);
        const validCases = validateCaseNarratives(raw, topWithPerspectives);
        enrichmentMeta.combined.source = 'live';
        enrichmentMeta.combined.provider = result.provider;
        enrichmentMeta.combined.model = result.model;
        enrichmentMeta.combined.rawItemCount = Array.isArray(raw) ? raw.length : 0;
        enrichmentMeta.combined.scenarios = validScenarios.length;
        enrichmentMeta.combined.perspectives = validPerspectives.length;
        enrichmentMeta.combined.cases = validCases.length;
        enrichmentMeta.combined.succeeded = validScenarios.length > 0 || validPerspectives.length > 0 || validCases.length > 0;
        enrichmentMeta.combined.failureReason = getEnrichmentFailureReason({
          result,
          raw,
          scenarios: validScenarios.length,
          perspectives: validPerspectives.length,
          cases: validCases.length,
        });

        for (const s of validScenarios) {
          applyTraceMeta(topWithPerspectives[s.index], {
            narrativeSource: 'llm_combined',
            llmCached: false,
            llmProvider: result.provider,
            llmModel: result.model,
            branchSource: 'deterministic',
          });
          topWithPerspectives[s.index].scenario = s.scenario;
        }
        for (const p of validPerspectives) {
          topWithPerspectives[p.index].perspectives = { strategic: p.strategic, regional: p.regional, contrarian: p.contrarian };
        }
        for (const c of validCases) {
          topWithPerspectives[c.index].caseFile = {
            ...(topWithPerspectives[c.index].caseFile || buildForecastCase(topWithPerspectives[c.index])),
            baseCase: c.baseCase,
            escalatoryCase: c.escalatoryCase,
            contrarianCase: c.contrarianCase,
          };
        }

        // Cache only validated items (not raw) to prevent persisting invalid LLM output
        const items = [];
        for (const s of validScenarios) {
          const entry = { index: s.index, scenario: s.scenario };
          const p = validPerspectives.find(vp => vp.index === s.index);
          if (p) { entry.strategic = p.strategic; entry.regional = p.regional; entry.contrarian = p.contrarian; }
          const c = validCases.find(vc => vc.index === s.index);
          if (c) {
            entry.baseCase = c.baseCase;
            entry.escalatoryCase = c.escalatoryCase;
            entry.contrarianCase = c.contrarianCase;
          }
          items.push(entry);
        }

        console.log(JSON.stringify({
          event: 'llm_combined', provider: result.provider, model: result.model,
          hash, count: topWithPerspectives.length,
          rawItems: Array.isArray(raw) ? raw.length : 0,
          scenarios: validScenarios.length, perspectives: validPerspectives.length, cases: validCases.length,
          failureReason: enrichmentMeta.combined.failureReason || '',
          latencyMs: Math.round(Date.now() - t0), cached: false,
        }));

        if (items.length > 0) await redisSet(url, token, cacheKey, { items }, 3600);
      } else {
        enrichmentMeta.combined.failureReason = 'call_failed';
        console.warn('  [LLM:combined] call failed');
      }
    }
  }

  // Call 2: Scenario-only for predictions 3-4
  if (scenarioOnly.length > 0) {
    const hash = buildCacheHash(scenarioOnly);
    const cacheKey = `forecast:llm-scenarios:${hash}`;
    const cached = await redisGet(url, token, cacheKey);

    if (cached?.scenarios) {
      enrichmentMeta.scenario.source = 'cache';
      enrichmentMeta.scenario.succeeded = true;
      enrichmentMeta.scenario.provider = 'cache';
      enrichmentMeta.scenario.model = 'cache';
      enrichmentMeta.scenario.scenarios = cached.scenarios.filter(item => item.scenario).length;
      enrichmentMeta.scenario.cases = cached.scenarios.filter(item => item.baseCase || item.escalatoryCase || item.contrarianCase).length;
      enrichmentMeta.scenario.rawItemCount = cached.scenarios.length;
      for (const s of cached.scenarios) {
        if (s.index >= 0 && s.index < scenarioOnly.length && s.scenario) {
          applyTraceMeta(scenarioOnly[s.index], {
            narrativeSource: 'llm_scenario_cache',
            llmCached: true,
            llmProvider: 'cache',
            llmModel: 'cache',
            branchSource: 'deterministic',
          });
          scenarioOnly[s.index].scenario = s.scenario;
        }
        if (s.index >= 0 && s.index < scenarioOnly.length && (s.baseCase || s.escalatoryCase || s.contrarianCase)) {
          scenarioOnly[s.index].caseFile = {
            ...(scenarioOnly[s.index].caseFile || buildForecastCase(scenarioOnly[s.index])),
            baseCase: s.baseCase || scenarioOnly[s.index].caseFile?.baseCase || '',
            escalatoryCase: s.escalatoryCase || scenarioOnly[s.index].caseFile?.escalatoryCase || '',
            contrarianCase: s.contrarianCase || scenarioOnly[s.index].caseFile?.contrarianCase || '',
          };
        }
      }
      console.log(JSON.stringify({ event: 'llm_scenario', cached: true, count: cached.scenarios.length, hash }));
    } else {
      const t0 = Date.now();
      const result = await callForecastLLM(SCENARIO_SYSTEM_PROMPT, buildUserPrompt(scenarioOnly), { ...scenarioLlmOptions, stage: 'scenario' });
      if (result) {
        const raw = parseLLMScenarios(result.text);
        const valid = validateScenarios(raw, scenarioOnly);
        const validCases = validateCaseNarratives(raw, scenarioOnly);
        enrichmentMeta.scenario.source = 'live';
        enrichmentMeta.scenario.provider = result.provider;
        enrichmentMeta.scenario.model = result.model;
        enrichmentMeta.scenario.rawItemCount = Array.isArray(raw) ? raw.length : 0;
        enrichmentMeta.scenario.scenarios = valid.length;
        enrichmentMeta.scenario.cases = validCases.length;
        enrichmentMeta.scenario.succeeded = valid.length > 0 || validCases.length > 0;
        enrichmentMeta.scenario.failureReason = getEnrichmentFailureReason({
          result,
          raw,
          scenarios: valid.length,
          cases: validCases.length,
        });
        for (const s of valid) {
          applyTraceMeta(scenarioOnly[s.index], {
            narrativeSource: 'llm_scenario',
            llmCached: false,
            llmProvider: result.provider,
            llmModel: result.model,
            branchSource: 'deterministic',
          });
          scenarioOnly[s.index].scenario = s.scenario;
        }
        for (const c of validCases) {
          scenarioOnly[c.index].caseFile = {
            ...(scenarioOnly[c.index].caseFile || buildForecastCase(scenarioOnly[c.index])),
            baseCase: c.baseCase,
            escalatoryCase: c.escalatoryCase,
            contrarianCase: c.contrarianCase,
          };
        }

        console.log(JSON.stringify({
          event: 'llm_scenario', provider: result.provider, model: result.model,
          hash, count: scenarioOnly.length, rawItems: Array.isArray(raw) ? raw.length : 0, scenarios: valid.length, cases: validCases.length,
          failureReason: enrichmentMeta.scenario.failureReason || '',
          latencyMs: Math.round(Date.now() - t0), cached: false,
        }));

        if (valid.length > 0 || validCases.length > 0) {
          const scenarios = [];
          const seen = new Set();
          for (const s of valid) {
            const item = { index: s.index, scenario: s.scenario };
            const c = validCases.find(vc => vc.index === s.index);
            if (c) {
              item.baseCase = c.baseCase;
              item.escalatoryCase = c.escalatoryCase;
              item.contrarianCase = c.contrarianCase;
            }
            scenarios.push(item);
            seen.add(s.index);
          }
          for (const c of validCases) {
            if (seen.has(c.index)) continue;
            scenarios.push({
              index: c.index,
              scenario: '',
              baseCase: c.baseCase,
              escalatoryCase: c.escalatoryCase,
              contrarianCase: c.contrarianCase,
            });
          }
          await redisSet(url, token, cacheKey, { scenarios }, 3600);
        }
      } else {
        enrichmentMeta.scenario.failureReason = 'call_failed';
        console.warn('  [LLM:scenario] call failed');
      }
    }
  }

  return enrichmentMeta;
}

// ── Main pipeline ──────────────────────────────────────────
async function fetchForecasts() {
  await warmPingChokepoints();

  console.log('  Reading input data from Redis...');
  const inputs = await readInputKeys();
  const prior = await readPriorPredictions();

  console.log('  Running domain detectors...');
  const predictions = [
    ...detectConflictScenarios(inputs),
    ...detectMarketScenarios(inputs),
    ...detectSupplyChainScenarios(inputs),
    ...detectPoliticalScenarios(inputs),
    ...detectMilitaryScenarios(inputs),
    ...detectInfraScenarios(inputs),
    ...detectUcdpConflictZones(inputs),
    ...detectCyberScenarios(inputs),
    ...detectGpsJammingScenarios(inputs),
    ...detectFromPredictionMarkets(inputs),
  ];

  console.log(`  Generated ${predictions.length} predictions`);
  {
    const traceCap = getTraceCapLog(predictions.length);
    console.log(`  Forecast trace config: raw=${traceCap.raw ?? 'default'} resolved=${traceCap.resolved} total=${traceCap.totalForecasts}`);
  }

  attachNewsContext(predictions, inputs.newsInsights, inputs.newsDigest);
  calibrateWithMarkets(predictions, inputs.predictionMarkets);
  computeConfidence(predictions);
  computeProjections(predictions);
  const cascadeRules = loadCascadeRules();
  resolveCascades(predictions, cascadeRules);
  discoverGraphCascades(predictions, loadEntityGraph());
  computeTrends(predictions, prior);
  buildForecastCases(predictions);
  annotateForecastChanges(predictions, prior);

  rankForecastsForAnalysis(predictions);

  const enrichmentMeta = await enrichScenariosWithLLM(predictions);
  populateFallbackNarratives(predictions);

  const publishedPredictions = filterPublishedForecasts(predictions);
  if (publishedPredictions.length !== predictions.length) {
    console.log(`  Filtered ${predictions.length - publishedPredictions.length} forecasts at publish floor > ${PUBLISH_MIN_PROBABILITY}`);
  }

  return { predictions: publishedPredictions, generatedAt: Date.now(), enrichmentMeta };
}

if (_isDirectRun) {
  await runSeed('forecast', 'predictions', CANONICAL_KEY, fetchForecasts, {
    ttlSeconds: TTL_SECONDS,
    lockTtlMs: 180_000,
    validateFn: (data) => Array.isArray(data?.predictions) && data.predictions.length > 0,
    afterPublish: async (data, meta) => {
      try {
        const snapshot = await appendHistorySnapshot(data);
        console.log(`  History appended: ${snapshot.predictions.length} forecasts -> ${HISTORY_KEY}`);
      } catch (err) {
        console.warn(`  [History] Append failed: ${err.message}`);
      }

      try {
        console.log('  [Trace] Starting R2 export...');
        const pointer = await writeForecastTraceArtifacts(data, { runId: meta?.runId || `${Date.now()}` });
        if (pointer) {
          console.log(`  [Trace] Written: ${pointer.summaryKey} (${pointer.tracedForecastCount} forecasts)`);
        } else {
          console.log('  [Trace] Skipped: R2 storage not configured');
        }
      } catch (err) {
        console.warn(`  [Trace] Export failed: ${err.message}`);
        if (err.stack) console.warn(`  [Trace] Stack: ${err.stack.split('\n').slice(0, 3).join(' | ')}`);
      }
    },
    extraKeys: [
      {
        key: PRIOR_KEY,
        transform: (data) => ({
          predictions: data.predictions.map(buildPriorForecastSnapshot),
        }),
        ttl: 7200,
      },
    ],
  });
}

export {
  CANONICAL_KEY,
  PRIOR_KEY,
  HISTORY_KEY,
  HISTORY_MAX_RUNS,
  HISTORY_MAX_FORECASTS,
  TRACE_LATEST_KEY,
  TRACE_RUNS_KEY,
  forecastId,
  normalize,
  makePrediction,
  normalizeCiiEntry,
  extractCiiScores,
  resolveCascades,
  calibrateWithMarkets,
  computeTrends,
  detectConflictScenarios,
  detectMarketScenarios,
  detectSupplyChainScenarios,
  detectPoliticalScenarios,
  detectMilitaryScenarios,
  detectInfraScenarios,
  attachNewsContext,
  computeConfidence,
  sanitizeForPrompt,
  parseLLMScenarios,
  validateScenarios,
  validatePerspectives,
  validateCaseNarratives,
  computeProjections,
  computeHeadlineRelevance,
  computeMarketMatchScore,
  buildUserPrompt,
  buildForecastCase,
  buildForecastCases,
  buildPriorForecastSnapshot,
  buildHistoryForecastEntry,
  buildHistorySnapshot,
  appendHistorySnapshot,
  getTraceMaxForecasts,
  buildTraceRunPrefix,
  buildForecastTraceRecord,
  buildForecastTraceArtifacts,
  writeForecastTraceArtifacts,
  buildChangeItems,
  buildChangeSummary,
  annotateForecastChanges,
  buildCounterEvidence,
  buildCaseTriggers,
  buildForecastActors,
  buildForecastWorldState,
  buildForecastRunWorldState,
  buildForecastBranches,
  buildActorLenses,
  scoreForecastReadiness,
  computeAnalysisPriority,
  rankForecastsForAnalysis,
  filterPublishedForecasts,
  selectForecastsForEnrichment,
  parseForecastProviderOrder,
  getForecastLlmCallOptions,
  resolveForecastLlmProviders,
  buildFallbackScenario,
  buildFallbackBaseCase,
  buildFallbackEscalatoryCase,
  buildFallbackContrarianCase,
  buildFeedSummary,
  buildFallbackPerspectives,
  populateFallbackNarratives,
  loadCascadeRules,
  evaluateRuleConditions,
  SIGNAL_TO_SOURCE,
  PREDICATE_EVALUATORS,
  DEFAULT_CASCADE_RULES,
  PROJECTION_CURVES,
  normalizeChokepoints,
  normalizeGpsJamming,
  detectUcdpConflictZones,
  detectCyberScenarios,
  detectGpsJammingScenarios,
  detectFromPredictionMarkets,
  getFreshMilitaryForecastInputs,
  loadEntityGraph,
  discoverGraphCascades,
  MARITIME_REGIONS,
  MARKET_TAG_TO_REGION,
  resolveCountryName,
  loadCountryCodes,
  getSearchTermsForRegion,
  extractAllHeadlines,
};
