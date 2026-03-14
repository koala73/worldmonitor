#!/usr/bin/env node

import crypto from 'node:crypto';
import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import { tagRegions } from './_prediction-scoring.mjs';

const _isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (_isDirectRun) loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'forecast:predictions:v1';
const PRIOR_KEY = 'forecast:predictions:prior:v1';
const TTL_SECONDS = 3600;

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

const CHOKEPOINT_COMMODITIES = {
  'Middle East': { commodity: 'Oil', sensitivity: 0.8 },
  'Red Sea': { commodity: 'Shipping/Oil', sensitivity: 0.7 },
  'Israel/Gaza': { commodity: 'Gas/Oil', sensitivity: 0.5 },
  'Eastern Mediterranean': { commodity: 'Gas', sensitivity: 0.4 },
  'Western Pacific': { commodity: 'Semiconductors', sensitivity: 0.9 },
  'South China Sea': { commodity: 'Trade goods', sensitivity: 0.6 },
  'Black Sea': { commodity: 'Grain/Energy', sensitivity: 0.7 },
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

function getRedisCredentials() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
  return { url, token };
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

async function readInputKeys() {
  const { url, token } = getRedisCredentials();
  const keys = [
    'risk:scores:sebuf:stale:v1',
    'temporal:anomalies:v1',
    'theater-posture:sebuf:stale:v1',
    'prediction:markets-bootstrap:v1',
    'supply_chain:chokepoints:v2',
    'conflict:iran-events:v1',
    'conflict:ucdp-events:v1',
    'unrest:events:v1',
    'infra:outages:v1',
    'cyber:threats-bootstrap:v2',
    'intelligence:gpsjam:v2',
    'news:insights:v1',
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
    predictionMarkets: parse(3),
    chokepoints: parse(4),
    iranEvents: parse(5),
    ucdpEvents: parse(6),
    unrestEvents: parse(7),
    outages: parse(8),
    cyberThreats: parse(9),
    gpsJamming: parse(10),
    newsInsights: parse(11),
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

function makePrediction(domain, region, title, probability, confidence, timeHorizon, signals) {
  const now = Date.now();
  return {
    id: forecastId(domain, region, title),
    domain,
    region,
    title,
    scenario: '',
    probability: +Math.max(0, Math.min(1, probability)).toFixed(3),
    confidence: +Math.max(0, Math.min(1, confidence)).toFixed(3),
    timeHorizon,
    signals,
    cascades: [],
    trend: 'stable',
    priorProbability: 0,
    calibration: null,
    createdAt: now,
    updatedAt: now,
  };
}

function detectConflictScenarios(inputs) {
  const predictions = [];
  const scores = Array.isArray(inputs.ciiScores) ? inputs.ciiScores : inputs.ciiScores?.scores || [];
  const theaters = inputs.theaterPosture?.theaters || [];
  const iran = Array.isArray(inputs.iranEvents) ? inputs.iranEvents : inputs.iranEvents?.events || [];
  const ucdp = Array.isArray(inputs.ucdpEvents) ? inputs.ucdpEvents : inputs.ucdpEvents?.events || [];

  for (const c of scores) {
    if (!c?.score || c.score <= 70) continue;
    if (c.trend !== 'rising' && c.level !== 'critical') continue;

    const signals = [
      { type: 'cii', value: `${c.name || c.code} CII ${c.score} (${c.level})`, weight: 0.4 },
    ];
    let sourceCount = 1;

    if (c.change24h && Math.abs(c.change24h) > 2) {
      signals.push({ type: 'cii_delta', value: `24h change ${c.change24h > 0 ? '+' : ''}${c.change24h.toFixed(1)}`, weight: 0.2 });
      sourceCount++;
    }

    const countryName = (c.name || c.code || '').toLowerCase();
    const matchingIran = iran.filter(e => (e.country || e.location || '').toLowerCase().includes(countryName));
    if (matchingIran.length > 0) {
      signals.push({ type: 'conflict_events', value: `${matchingIran.length} Iran-related events`, weight: 0.2 });
      sourceCount++;
    }

    const matchingUcdp = ucdp.filter(e => (e.country || e.location || '').toLowerCase().includes(countryName));
    if (matchingUcdp.length > 0) {
      signals.push({ type: 'ucdp', value: `${matchingUcdp.length} UCDP events`, weight: 0.2 });
      sourceCount++;
    }

    const ciiNorm = normalize(c.score, 50, 100);
    const eventBoost = (matchingIran.length + matchingUcdp.length) > 0 ? 0.1 : 0;
    const prob = Math.min(0.9, ciiNorm * 0.6 + eventBoost + (c.trend === 'rising' ? 0.1 : 0));
    const confidence = normalize(sourceCount, 1, 4);
    const region = c.name || c.code || 'Unknown';

    predictions.push(makePrediction(
      'conflict', region,
      `Escalation risk: ${c.name || c.code}`,
      prob, confidence, '7d', signals,
    ));
  }

  for (const t of theaters) {
    if (!t?.id) continue;
    const posture = t.postureLevel || t.posture || '';
    if (posture !== 'critical' && posture !== 'elevated') continue;
    const region = THEATER_REGIONS[t.id] || t.name || t.id;
    const alreadyCovered = predictions.some(p => p.region === region);
    if (alreadyCovered) continue;

    const signals = [
      { type: 'theater', value: `${t.name || t.id} posture: ${posture}`, weight: 0.5 },
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
  const scores = Array.isArray(inputs.ciiScores) ? inputs.ciiScores : inputs.ciiScores?.scores || [];

  const affectedRegions = new Set();

  for (const cp of chokepoints) {
    const risk = cp.riskLevel || cp.risk || '';
    if (risk !== 'high' && risk !== 'critical' && (cp.riskScore || 0) < 60) continue;
    const region = cp.region || cp.name || '';
    if (!region) continue;

    const commodity = CHOKEPOINT_COMMODITIES[region];
    if (!commodity) continue;

    if (affectedRegions.has(region)) continue;
    affectedRegions.add(region);

    const riskNorm = normalize(cp.riskScore || (risk === 'critical' ? 85 : 70), 40, 100);
    const prob = Math.min(0.85, riskNorm * commodity.sensitivity);

    predictions.push(makePrediction(
      'market', region,
      `${commodity.commodity} price impact from ${region} disruption`,
      prob, 0.6, '30d',
      [{ type: 'chokepoint', value: `${region} risk: ${risk}`, weight: 0.5 },
       { type: 'commodity', value: `${commodity.commodity} sensitivity: ${commodity.sensitivity}`, weight: 0.3 }],
    ));
  }

  for (const c of scores) {
    if (!c?.score || c.score <= 75) continue;
    const countryName = c.name || c.code || '';
    const matchedRegion = Object.entries(THEATER_REGIONS).find(([, r]) => r.toLowerCase().includes(countryName.toLowerCase()));
    const region = matchedRegion?.[1];
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
    const confidence = normalize(sourceCount, 1, 3);

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
  const scores = Array.isArray(inputs.ciiScores) ? inputs.ciiScores : inputs.ciiScores?.scores || [];
  const anomalies = Array.isArray(inputs.temporalAnomalies) ? inputs.temporalAnomalies : inputs.temporalAnomalies?.anomalies || [];

  for (const c of scores) {
    if (!c?.components) continue;
    const unrestComp = c.components.unrest ?? c.components.protest ?? 0;
    if (unrestComp <= 50) continue;
    if (c.score >= 80) continue;

    const countryName = (c.name || c.code || '').toLowerCase();
    const signals = [
      { type: 'unrest', value: `${c.name || c.code} unrest component: ${unrestComp}`, weight: 0.4 },
    ];
    let sourceCount = 1;

    const protestAnomalies = anomalies.filter(a =>
      (a.type === 'protest' || a.type === 'unrest') &&
      (a.country || a.region || '').toLowerCase().includes(countryName),
    );
    if (protestAnomalies.length > 0) {
      const maxZ = Math.max(...protestAnomalies.map(a => a.zScore || a.z_score || 0));
      signals.push({ type: 'anomaly', value: `Protest anomaly z-score: ${maxZ.toFixed(1)}`, weight: 0.3 });
      sourceCount++;
    }

    const unrestNorm = normalize(unrestComp, 30, 100);
    const anomalyBoost = protestAnomalies.length > 0 ? 0.1 : 0;
    const prob = Math.min(0.8, unrestNorm * 0.6 + anomalyBoost);
    const confidence = normalize(sourceCount, 1, 3);

    predictions.push(makePrediction(
      'political', c.name || c.code || 'Unknown',
      `Political instability: ${c.name || c.code}`,
      prob, confidence, '30d', signals,
    ));
  }

  return predictions;
}

function detectMilitaryScenarios(inputs) {
  const predictions = [];
  const theaters = inputs.theaterPosture?.theaters || [];
  const anomalies = Array.isArray(inputs.temporalAnomalies) ? inputs.temporalAnomalies : inputs.temporalAnomalies?.anomalies || [];

  for (const t of theaters) {
    if (!t?.id) continue;
    const posture = t.postureLevel || t.posture || '';
    if (posture !== 'elevated' && posture !== 'critical') continue;

    const region = THEATER_REGIONS[t.id] || t.name || t.id;
    const signals = [
      { type: 'theater', value: `${t.name || t.id} posture: ${posture}`, weight: 0.5 },
    ];
    let sourceCount = 1;

    const milFlights = anomalies.filter(a =>
      (a.type === 'military_flights' || a.type === 'military') &&
      (a.region || a.theater || '').toLowerCase().includes(region.toLowerCase()),
    );
    if (milFlights.length > 0) {
      const maxZ = Math.max(...milFlights.map(a => a.zScore || a.z_score || 0));
      signals.push({ type: 'mil_flights', value: `Military flight anomaly z-score: ${maxZ.toFixed(1)}`, weight: 0.3 });
      sourceCount++;
    }

    if (t.indicators && Array.isArray(t.indicators)) {
      const activeIndicators = t.indicators.filter(i => i.active || i.triggered);
      if (activeIndicators.length > 0) {
        signals.push({ type: 'indicators', value: `${activeIndicators.length} active posture indicators`, weight: 0.2 });
        sourceCount++;
      }
    }

    const baseLine = posture === 'critical' ? 0.6 : 0.35;
    const flightBoost = milFlights.length > 0 ? 0.1 : 0;
    const prob = Math.min(0.85, baseLine + flightBoost);
    const confidence = normalize(sourceCount, 1, 3);

    predictions.push(makePrediction(
      'military', region,
      `Military posture escalation: ${region}`,
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
    const severity = (o.severity || o.type || '').toLowerCase();
    if (severity !== 'major' && severity !== 'total' && severity !== 'critical') continue;

    const country = o.country || o.region || o.name || '';
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
    const confidence = normalize(sourceCount, 1, 3);

    predictions.push(makePrediction(
      'infrastructure', country,
      `Infrastructure cascade risk: ${country}`,
      prob, confidence, '24h', signals,
    ));
  }

  return predictions;
}

const CASCADE_RULES = [
  { from: 'conflict', to: 'supply_chain', coupling: 0.6, mechanism: 'chokepoint disruption', condition: (p) => CHOKEPOINT_COMMODITIES[p.region] },
  { from: 'conflict', to: 'market', coupling: 0.5, mechanism: 'commodity price shock', condition: (p) => CHOKEPOINT_COMMODITIES[p.region] },
  { from: 'political', to: 'conflict', coupling: 0.4, mechanism: 'instability escalation', condition: (p) => p.probability > 0.6 },
  { from: 'military', to: 'conflict', coupling: 0.5, mechanism: 'force deployment', condition: (p) => p.signals.some(s => s.type === 'theater' && s.value.includes('critical')) },
  { from: 'supply_chain', to: 'market', coupling: 0.4, mechanism: 'supply shortage pricing' },
];

function resolveCascades(predictions) {
  const seen = new Set();
  for (const rule of CASCADE_RULES) {
    const sources = predictions.filter(p => p.domain === rule.from);
    for (const src of sources) {
      if (rule.condition && !rule.condition(src)) continue;
      const cascadeProb = Math.min(0.8, src.probability * rule.coupling);
      const key = `${src.id}:${rule.to}:${rule.mechanism}`;
      if (seen.has(key)) continue;
      seen.add(key);
      src.cascades.push({ domain: rule.to, effect: rule.mechanism, probability: +cascadeProb.toFixed(3) });
    }
  }
}

function calibrateWithMarkets(predictions, markets) {
  if (!markets?.geopolitical) return;
  for (const pred of predictions) {
    const keywords = REGION_KEYWORDS[pred.region] || [];
    if (keywords.length === 0) continue;
    const match = markets.geopolitical.find(m => {
      const mRegions = tagRegions(m.title);
      return mRegions.some(r => keywords.includes(r));
    });
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

async function fetchForecasts() {
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
  ];

  console.log(`  Generated ${predictions.length} predictions`);

  resolveCascades(predictions);
  calibrateWithMarkets(predictions, inputs.predictionMarkets);
  computeTrends(predictions, prior);

  predictions.sort((a, b) => (b.probability * b.confidence) - (a.probability * a.confidence));

  return { predictions, generatedAt: Date.now() };
}

if (_isDirectRun) {
  await runSeed('forecast', 'predictions', CANONICAL_KEY, fetchForecasts, {
    ttlSeconds: TTL_SECONDS,
    lockTtlMs: 180_000,
    validateFn: (data) => Array.isArray(data?.predictions) && data.predictions.length > 0,
    extraKeys: [
      {
        key: PRIOR_KEY,
        transform: (data) => ({
          predictions: data.predictions.map(p => ({ id: p.id, probability: p.probability })),
        }),
        ttl: 7200,
      },
    ],
  });
}

export {
  forecastId,
  normalize,
  makePrediction,
  resolveCascades,
  calibrateWithMarkets,
  computeTrends,
  detectConflictScenarios,
  detectMarketScenarios,
  detectSupplyChainScenarios,
  detectPoliticalScenarios,
  detectMilitaryScenarios,
  detectInfraScenarios,
  CASCADE_RULES,
};
