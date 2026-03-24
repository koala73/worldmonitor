#!/usr/bin/env node

import { loadEnvFile, runSeed, getRedisCredentials } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'intelligence:cross-source-signals:v1';
const CACHE_TTL = 1800; // 30min TTL, 15min cron cadence

// ── Source Redis keys ─────────────────────────────────────────────────────────
const SOURCE_KEYS = [
  'thermal:escalation:v1',
  'intelligence:gpsjam:v2',
  'military:flights:v1',
  'unrest:events:v1',
  'intelligence:advisories-bootstrap:v1',
  'market:stocks-bootstrap:v1',
  'market:commodities-bootstrap:v1',
  'cyber:threats-bootstrap:v2',
  'supply_chain:shipping:v2',
  'sanctions:pressure:v1',
  'seismology:earthquakes:v1',
  'radiation:observations:v1',
  'infra:outages:v1',
  'wildfire:fires:v1',
  `displacement:summary:v1:${new Date().getFullYear()}`,
  'forecast:predictions:v2',
  'intelligence:gdelt-intel:v1',
  'gdelt:intel:tone:military',
  'gdelt:intel:tone:nuclear',
  'gdelt:intel:tone:maritime',
  'weather:alerts:v1',
  'risk:scores:sebuf:stale:v1',
];

// ── Theater classification helpers ────────────────────────────────────────────
const REGION_THEATER_MAP = {
  'eastern europe': 'Eastern Europe',
  'ukraine': 'Eastern Europe',
  'russia': 'Eastern Europe',
  'belarus': 'Eastern Europe',
  'middle east': 'Middle East',
  'israel': 'Middle East',
  'gaza': 'Middle East',
  'iran': 'Middle East',
  'iraq': 'Middle East',
  'syria': 'Middle East',
  'lebanon': 'Middle East',
  'yemen': 'Middle East',
  'saudi': 'Middle East',
  'red sea': 'Red Sea',
  'gulf of aden': 'Red Sea',
  'persian gulf': 'Persian Gulf',
  'strait of hormuz': 'Persian Gulf',
  'east asia': 'East Asia',
  'south china sea': 'East Asia',
  'taiwan': 'East Asia',
  'korea': 'East Asia',
  'china': 'East Asia',
  'japan': 'East Asia',
  'south asia': 'South Asia',
  'india': 'South Asia',
  'pakistan': 'South Asia',
  'africa': 'Sub-Saharan Africa',
  'sahel': 'Sub-Saharan Africa',
  'sudan': 'Sub-Saharan Africa',
  'ethiopia': 'Sub-Saharan Africa',
  'somalia': 'Sub-Saharan Africa',
  'latin america': 'Latin America',
  'venezuela': 'Latin America',
  'colombia': 'Latin America',
  'north america': 'North America',
  'europe': 'Western Europe',
  'balkans': 'Western Europe',
  'arctic': 'Arctic',
  'global': 'Global',
  'global markets': 'Global Markets',
};

function normalizeTheater(raw) {
  if (!raw) return 'Global';
  const lower = String(raw).toLowerCase();
  for (const [key, theater] of Object.entries(REGION_THEATER_MAP)) {
    if (lower.includes(key)) return theater;
  }
  // Title-case the raw value as fallback
  return String(raw).trim().replace(/\b\w/g, c => c.toUpperCase()) || 'Global';
}

// ── Signal category mapping for composite detection ────────────────────────────
const TYPE_CATEGORY = {
  CROSS_SOURCE_SIGNAL_TYPE_THERMAL_SPIKE: 'kinetic',
  CROSS_SOURCE_SIGNAL_TYPE_GPS_JAMMING: 'electronic_warfare',
  CROSS_SOURCE_SIGNAL_TYPE_MILITARY_FLIGHT_SURGE: 'military',
  CROSS_SOURCE_SIGNAL_TYPE_UNREST_SURGE: 'civil',
  CROSS_SOURCE_SIGNAL_TYPE_OREF_ALERT_CLUSTER: 'kinetic',
  CROSS_SOURCE_SIGNAL_TYPE_VIX_SPIKE: 'financial',
  CROSS_SOURCE_SIGNAL_TYPE_COMMODITY_SHOCK: 'economic',
  CROSS_SOURCE_SIGNAL_TYPE_CYBER_ESCALATION: 'cyber',
  CROSS_SOURCE_SIGNAL_TYPE_SHIPPING_DISRUPTION: 'maritime',
  CROSS_SOURCE_SIGNAL_TYPE_SANCTIONS_SURGE: 'diplomatic',
  CROSS_SOURCE_SIGNAL_TYPE_EARTHQUAKE_SIGNIFICANT: 'natural',
  CROSS_SOURCE_SIGNAL_TYPE_RADIATION_ANOMALY: 'radiological',
  CROSS_SOURCE_SIGNAL_TYPE_INFRASTRUCTURE_OUTAGE: 'infrastructure',
  CROSS_SOURCE_SIGNAL_TYPE_WILDFIRE_ESCALATION: 'natural',
  CROSS_SOURCE_SIGNAL_TYPE_DISPLACEMENT_SURGE: 'humanitarian',
  CROSS_SOURCE_SIGNAL_TYPE_FORECAST_DETERIORATION: 'intelligence',
  CROSS_SOURCE_SIGNAL_TYPE_MARKET_STRESS: 'financial',
  CROSS_SOURCE_SIGNAL_TYPE_WEATHER_EXTREME: 'natural',
  CROSS_SOURCE_SIGNAL_TYPE_MEDIA_TONE_DETERIORATION: 'information',
  CROSS_SOURCE_SIGNAL_TYPE_RISK_SCORE_SPIKE: 'intelligence',
};

// Base severity weights for each signal type
// Base severity weights per signal type. These are multiplied by a domain-
// specific factor (e.g. anomaly score, % change) to produce severityScore.
// Scoring thresholds: >=3.5 → CRITICAL, >=2.5 → HIGH, >=1.5 → MEDIUM, else LOW.
// Higher weight = a weaker domain signal can still reach HIGH/CRITICAL.
// Composite escalation starts at 4.0 and grows with categoryMap.size.
const BASE_WEIGHT = {
  CROSS_SOURCE_SIGNAL_TYPE_COMPOSITE_ESCALATION: 4.0,  // synthetic — grows with co-firing count
  CROSS_SOURCE_SIGNAL_TYPE_THERMAL_SPIKE: 3.0,          // high kinetic significance
  CROSS_SOURCE_SIGNAL_TYPE_MILITARY_FLIGHT_SURGE: 3.0,  // high kinetic significance
  CROSS_SOURCE_SIGNAL_TYPE_OREF_ALERT_CLUSTER: 3.5,     // active alert = direct threat
  CROSS_SOURCE_SIGNAL_TYPE_RADIATION_ANOMALY: 3.5,      // catastrophic potential
  CROSS_SOURCE_SIGNAL_TYPE_GPS_JAMMING: 2.5,            // active EW operation
  CROSS_SOURCE_SIGNAL_TYPE_UNREST_SURGE: 2.5,           // civil instability
  CROSS_SOURCE_SIGNAL_TYPE_CYBER_ESCALATION: 2.5,       // active APT operation
  CROSS_SOURCE_SIGNAL_TYPE_EARTHQUAKE_SIGNIFICANT: 2.5, // immediate humanitarian
  CROSS_SOURCE_SIGNAL_TYPE_RISK_SCORE_SPIKE: 2.5,       // composite CII deterioration
  CROSS_SOURCE_SIGNAL_TYPE_VIX_SPIKE: 2.0,              // financial stress indicator
  CROSS_SOURCE_SIGNAL_TYPE_COMMODITY_SHOCK: 2.0,        // supply shock proxy
  CROSS_SOURCE_SIGNAL_TYPE_SHIPPING_DISRUPTION: 2.0,    // logistics/trade impact
  CROSS_SOURCE_SIGNAL_TYPE_INFRASTRUCTURE_OUTAGE: 2.0,  // operational disruption
  CROSS_SOURCE_SIGNAL_TYPE_DISPLACEMENT_SURGE: 2.0,     // humanitarian — lagging
  CROSS_SOURCE_SIGNAL_TYPE_MARKET_STRESS: 2.0,          // broad market indicator
  CROSS_SOURCE_SIGNAL_TYPE_SANCTIONS_SURGE: 1.5,        // policy action — slow burn
  CROSS_SOURCE_SIGNAL_TYPE_WILDFIRE_ESCALATION: 1.5,    // environmental — regional
  CROSS_SOURCE_SIGNAL_TYPE_FORECAST_DETERIORATION: 1.5, // predictive — lower confidence
  CROSS_SOURCE_SIGNAL_TYPE_WEATHER_EXTREME: 1.5,        // environmental — regional
  CROSS_SOURCE_SIGNAL_TYPE_MEDIA_TONE_DETERIORATION: 1.5, // sentiment — lagging
};

function scoreTier(score) {
  if (score >= 3.5) return 'CROSS_SOURCE_SIGNAL_SEVERITY_CRITICAL';
  if (score >= 2.5) return 'CROSS_SOURCE_SIGNAL_SEVERITY_HIGH';
  if (score >= 1.5) return 'CROSS_SOURCE_SIGNAL_SEVERITY_MEDIUM';
  return 'CROSS_SOURCE_SIGNAL_SEVERITY_LOW';
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ── Read all source keys in parallel via Upstash pipeline ─────────────────────
async function readAllSourceKeys() {
  const { url, token } = getRedisCredentials();
  const pipeline = SOURCE_KEYS.map(k => ['GET', k]);
  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(pipeline),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Redis pipeline: HTTP ${resp.status}`);
  const results = await resp.json();
  const data = {};
  for (let i = 0; i < SOURCE_KEYS.length; i++) {
    const raw = results[i]?.result;
    if (!raw) continue;
    try { data[SOURCE_KEYS[i]] = JSON.parse(raw); } catch { /* skip malformed */ }
  }
  return data;
}

// ── Signal extractors (one per signal type) ───────────────────────────────────

function extractThermalSpike(d) {
  const payload = d['thermal:escalation:v1'];
  if (!payload) return [];
  const clusters = Array.isArray(payload.clusters) ? payload.clusters : [];
  const spikes = clusters.filter(c => c.status === 'spike' || (safeNum(c.anomalyScore) > 2));
  if (spikes.length === 0) return [];
  const signals = [];
  for (const c of spikes.slice(0, 5)) {
    const theater = normalizeTheater(c.region || c.name || '');
    const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_THERMAL_SPIKE'] * Math.min(3, safeNum(c.anomalyScore) || 1.5);
    signals.push({
      id: `thermal:${c.id || (c.name || c.region || 'unknown').replace(/\s+/g, '-').toLowerCase()}`,
      type: 'CROSS_SOURCE_SIGNAL_TYPE_THERMAL_SPIKE',
      theater,
      summary: `Thermal spike detected: ${c.name || c.region || 'unknown'} — anomaly score ${safeNum(c.anomalyScore).toFixed(1)}`,
      severity: scoreTier(score),
      severityScore: score,
      detectedAt: safeNum(c.detectedAt) || Date.now(),
      contributingTypes: [],
      signalCount: 0,
    });
  }
  return signals;
}

function extractGpsJamming(d) {
  const payload = d['intelligence:gpsjam:v2'];
  if (!payload) return [];
  const hexes = Array.isArray(payload.hexes) ? payload.hexes : [];
  const highHexes = hexes.filter(h => h.level === 'high' || (safeNum(h.npAvg) < 0.5 && safeNum(h.npAvg) > 0));
  if (highHexes.length === 0) return [];
  // Group by region
  const regionMap = new Map();
  for (const h of highHexes) {
    const theater = normalizeTheater(h.region || '');
    const existing = regionMap.get(theater) || { count: 0, theater };
    existing.count += 1;
    regionMap.set(theater, existing);
  }
  return [...regionMap.values()].slice(0, 3).map(({ theater, count }) => {
    const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_GPS_JAMMING'] * Math.min(2, 1 + count / 50);
    return {
      id: `gpsjam:${theater.replace(/\s+/g, '-').toLowerCase()}`,
      type: 'CROSS_SOURCE_SIGNAL_TYPE_GPS_JAMMING',
      theater,
      summary: `GPS jamming detected: ${count} high-interference hexagons in ${theater}`,
      severity: scoreTier(score),
      severityScore: score,
      detectedAt: safeNum(payload.fetchedAt) || Date.now(),
      contributingTypes: [],
      signalCount: 0,
    };
  });
}

function extractMilitaryFlightSurge(d) {
  const payload = d['military:flights:v1'] || d['military:flights:stale:v1'];
  if (!payload) return [];
  const flights = Array.isArray(payload.flights) ? payload.flights : [];
  if (flights.length < 5) return [];
  // Group by callsign country prefix / region
  const regionMap = new Map();
  for (const f of flights) {
    const theater = normalizeTheater(f.region || f.country || f.origin || '');
    regionMap.set(theater, (regionMap.get(theater) || 0) + 1);
  }
  const signals = [];
  for (const [theater, count] of regionMap) {
    if (count < 3) continue;
    const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_MILITARY_FLIGHT_SURGE'] * Math.min(2, 1 + count / 20);
    signals.push({
      id: `mil-flights:${theater.replace(/\s+/g, '-').toLowerCase()}`,
      type: 'CROSS_SOURCE_SIGNAL_TYPE_MILITARY_FLIGHT_SURGE',
      theater,
      summary: `Military flight surge: ${count} active sorties tracked in ${theater}`,
      severity: scoreTier(score),
      severityScore: score,
      detectedAt: safeNum(payload.fetchedAt) || Date.now(),
      contributingTypes: [],
      signalCount: 0,
    });
  }
  return signals.slice(0, 3);
}

function extractUnrestSurge(d) {
  const payload = d['unrest:events:v1'];
  if (!payload) return [];
  const events = Array.isArray(payload.events) ? payload.events : (Array.isArray(payload) ? payload : []);
  if (events.length === 0) return [];
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const recent = events.filter(e => safeNum(e.date || e.timestamp || e.created_at) > cutoff || !e.date);
  const regionMap = new Map();
  for (const ev of recent) {
    const theater = normalizeTheater(ev.region || ev.country || ev.location || '');
    regionMap.set(theater, (regionMap.get(theater) || 0) + 1);
  }
  const signals = [];
  for (const [theater, count] of regionMap) {
    if (count < 3) continue;
    const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_UNREST_SURGE'] * Math.min(2, 1 + count / 10);
    signals.push({
      id: `unrest:${theater.replace(/\s+/g, '-').toLowerCase()}`,
      type: 'CROSS_SOURCE_SIGNAL_TYPE_UNREST_SURGE',
      theater,
      summary: `Unrest surge: ${count} events in ${theater} in past 24h`,
      severity: scoreTier(score),
      severityScore: score,
      detectedAt: Date.now(),
      contributingTypes: [],
      signalCount: 0,
    });
  }
  return signals.slice(0, 3);
}

function extractOrefAlertCluster(d) {
  const payload = d['intelligence:advisories-bootstrap:v1'];
  if (!payload) return [];
  const advisories = Array.isArray(payload.advisories) ? payload.advisories : [];
  const critical = advisories.filter(a => String(a.level || '').toLowerCase() === 'do not travel');
  if (critical.length === 0) return [];
  return critical.slice(0, 3).map(a => {
    const theater = normalizeTheater(a.region || a.country || '');
    const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_OREF_ALERT_CLUSTER'];
    return {
      id: `advisory:${(a.country || a.region || 'unknown').replace(/\s+/g, '-').toLowerCase()}`,
      type: 'CROSS_SOURCE_SIGNAL_TYPE_OREF_ALERT_CLUSTER',
      theater,
      summary: `"Do Not Travel" advisory: ${a.country || a.region || 'unknown'}${a.reason ? ` — ${a.reason}` : ''}`,
      severity: scoreTier(score),
      severityScore: score,
      detectedAt: Date.now(),
      contributingTypes: [],
      signalCount: 0,
    };
  });
}

function extractVixSpike(d) {
  const payload = d['market:stocks-bootstrap:v1'];
  if (!payload) return [];
  const quotes = Array.isArray(payload.quotes) ? payload.quotes : [];
  const vix = quotes.find(q => q.symbol === '^VIX' || q.symbol === 'VIX' || q.display === 'VIX');
  if (!vix || safeNum(vix.price) < 25) return [];
  const vixVal = safeNum(vix.price);
  const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_VIX_SPIKE'] * (vixVal > 40 ? 2 : vixVal > 30 ? 1.5 : 1.2);
  return [{
    id: 'vix:global-markets',
    type: 'CROSS_SOURCE_SIGNAL_TYPE_VIX_SPIKE',
    theater: 'Global Markets',
    summary: `VIX elevated at ${vixVal.toFixed(1)} — fear index signals market stress`,
    severity: scoreTier(score),
    severityScore: score,
    detectedAt: Date.now(),
    contributingTypes: [],
    signalCount: 0,
  }];
}

function extractCommodityShock(d) {
  const payload = d['market:commodities-bootstrap:v1'];
  if (!payload) return [];
  const quotes = Array.isArray(payload.quotes) ? payload.quotes : [];
  const signals = [];
  for (const q of quotes) {
    const change = safeNum(q.change);
    if (Math.abs(change) < 5) continue;
    const theater = (q.symbol === 'OIL' || q.symbol === 'CL=F' || q.display?.includes('Oil')) ? 'Persian Gulf' : 'Global Markets';
    const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_COMMODITY_SHOCK'] * Math.min(2, Math.abs(change) / 5);
    signals.push({
      id: `commodity:${(q.symbol || q.display || 'unknown').replace(/[^a-z0-9]/gi, '-').toLowerCase()}`,
      type: 'CROSS_SOURCE_SIGNAL_TYPE_COMMODITY_SHOCK',
      theater,
      summary: `Commodity shock: ${q.display || q.symbol} ${change > 0 ? '+' : ''}${change.toFixed(1)}% — ${Math.abs(change) > 10 ? 'extreme' : 'significant'} move`,
      severity: scoreTier(score),
      severityScore: score,
      detectedAt: Date.now(),
      contributingTypes: [],
      signalCount: 0,
    });
  }
  return signals.slice(0, 3);
}

function extractCyberEscalation(d) {
  const payload = d['cyber:threats-bootstrap:v2'];
  if (!payload) return [];
  const threats = Array.isArray(payload.threats) ? payload.threats : (Array.isArray(payload) ? payload : []);
  const critical = threats.filter(t => t.severity === 'critical' || t.severity === 'high');
  if (critical.length === 0) return [];
  const regionMap = new Map();
  for (const t of critical) {
    const theater = normalizeTheater(t.targetCountry || t.region || t.country || '');
    regionMap.set(theater, (regionMap.get(theater) || 0) + 1);
  }
  const signals = [];
  for (const [theater, count] of regionMap) {
    const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_CYBER_ESCALATION'] * Math.min(2, 1 + count / 5);
    signals.push({
      id: `cyber:${theater.replace(/\s+/g, '-').toLowerCase()}`,
      type: 'CROSS_SOURCE_SIGNAL_TYPE_CYBER_ESCALATION',
      theater,
      summary: `Cyber escalation: ${count} critical/high threat${count > 1 ? 's' : ''} targeting ${theater}`,
      severity: scoreTier(score),
      severityScore: score,
      detectedAt: Date.now(),
      contributingTypes: [],
      signalCount: 0,
    });
  }
  return signals.slice(0, 2);
}

function extractShippingDisruption(d) {
  const payload = d['supply_chain:shipping:v2'];
  if (!payload) return [];
  const routes = Array.isArray(payload.routes) ? payload.routes : (Array.isArray(payload) ? payload : []);
  const disrupted = routes.filter(r => r.disrupted || r.status === 'disrupted' || safeNum(r.rerouting) > 10);
  if (disrupted.length === 0) return [];
  const theater = disrupted.some(r => String(r.name || '').toLowerCase().includes('red sea') || String(r.route || '').toLowerCase().includes('red sea'))
    ? 'Red Sea' : 'Global';
  const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_SHIPPING_DISRUPTION'] * Math.min(2, 1 + disrupted.length / 3);
  return [{
    id: `shipping:${theater.replace(/\s+/g, '-').toLowerCase()}`,
    type: 'CROSS_SOURCE_SIGNAL_TYPE_SHIPPING_DISRUPTION',
    theater,
    summary: `Shipping disruption: ${disrupted.length} route${disrupted.length > 1 ? 's' : ''} affected in ${theater}`,
    severity: scoreTier(score),
    severityScore: score,
    detectedAt: Date.now(),
    contributingTypes: [],
    signalCount: 0,
  }];
}

function extractSanctionsSurge(d) {
  const payload = d['sanctions:pressure:v1'];
  if (!payload) return [];
  const newCount = safeNum(payload.newEntryCount);
  if (newCount < 5) return [];
  const topCountry = (payload.countries || [])[0];
  const theater = normalizeTheater(topCountry?.countryName || '');
  const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_SANCTIONS_SURGE'] * Math.min(2, 1 + newCount / 20);
  return [{
    id: `sanctions:${theater.replace(/\s+/g, '-').toLowerCase()}`,
    type: 'CROSS_SOURCE_SIGNAL_TYPE_SANCTIONS_SURGE',
    theater,
    summary: `Sanctions surge: ${newCount} new designations — ${topCountry?.countryName || 'multiple countries'} most targeted`,
    severity: scoreTier(score),
    severityScore: score,
    detectedAt: Date.now(),
    contributingTypes: [],
    signalCount: 0,
  }];
}

function extractEarthquakeSignificant(d) {
  const payload = d['seismology:earthquakes:v1'];
  if (!payload) return [];
  const quakes = Array.isArray(payload.earthquakes) ? payload.earthquakes : (Array.isArray(payload) ? payload : []);
  const significant = quakes.filter(q => safeNum(q.magnitude) >= 6.5);
  if (significant.length === 0) return [];
  return significant.slice(0, 2).map(q => {
    const theater = normalizeTheater(q.place || q.region || q.country || '');
    const mag = safeNum(q.magnitude);
    const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_EARTHQUAKE_SIGNIFICANT'] * (mag >= 7.5 ? 2 : mag >= 7.0 ? 1.5 : 1.2);
    return {
      id: `quake:${q.id || q.code || `${String(q.latitude || '0')}-${String(q.longitude || '0')}-${mag.toFixed(1)}`}`,
      type: 'CROSS_SOURCE_SIGNAL_TYPE_EARTHQUAKE_SIGNIFICANT',
      theater,
      summary: `M${mag.toFixed(1)} earthquake — ${q.place || theater}`,
      severity: scoreTier(score),
      severityScore: score,
      detectedAt: safeNum(q.time) || safeNum(q.timestamp) || Date.now(),
      contributingTypes: [],
      signalCount: 0,
    };
  });
}

function extractRadiationAnomaly(d) {
  const payload = d['radiation:observations:v1'];
  if (!payload) return [];
  const observations = Array.isArray(payload.observations) ? payload.observations : (Array.isArray(payload) ? payload : []);
  const anomalies = observations.filter(o => o.alert || o.status === 'alert' || safeNum(o.value) > safeNum(o.threshold) * 1.5);
  if (anomalies.length === 0) return [];
  return anomalies.slice(0, 2).map(a => {
    const theater = normalizeTheater(a.country || a.region || a.location || '');
    const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_RADIATION_ANOMALY'];
    return {
      id: `radiation:${a.id || a.stationId || (a.location || a.stationName || 'unknown').replace(/\s+/g, '-').toLowerCase()}`,
      type: 'CROSS_SOURCE_SIGNAL_TYPE_RADIATION_ANOMALY',
      theater,
      summary: `Radiation anomaly: ${a.location || a.stationName || 'unknown station'} — ${a.value || 'elevated'} reading`,
      severity: scoreTier(score),
      severityScore: score,
      detectedAt: safeNum(a.timestamp) || safeNum(a.measuredAt) || Date.now(),
      contributingTypes: [],
      signalCount: 0,
    };
  });
}

function extractInfrastructureOutage(d) {
  const payload = d['infra:outages:v1'];
  if (!payload) return [];
  const outages = Array.isArray(payload.outages) ? payload.outages : (Array.isArray(payload) ? payload : []);
  const major = outages.filter(o => o.severity === 'major' || o.severity === 'critical' || safeNum(o.affectedUsers) > 100000);
  if (major.length === 0) return [];
  const regionMap = new Map();
  for (const o of major) {
    const theater = normalizeTheater(o.region || o.country || o.location || 'Global');
    regionMap.set(theater, (regionMap.get(theater) || 0) + 1);
  }
  const signals = [];
  for (const [theater, count] of regionMap) {
    const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_INFRASTRUCTURE_OUTAGE'] * Math.min(2, 1 + count / 3);
    signals.push({
      id: `outage:${theater.replace(/\s+/g, '-').toLowerCase()}`,
      type: 'CROSS_SOURCE_SIGNAL_TYPE_INFRASTRUCTURE_OUTAGE',
      theater,
      summary: `Infrastructure outage: ${count} major service failure${count > 1 ? 's' : ''} in ${theater}`,
      severity: scoreTier(score),
      severityScore: score,
      detectedAt: Date.now(),
      contributingTypes: [],
      signalCount: 0,
    });
  }
  return signals.slice(0, 2);
}

function extractWildfireEscalation(d) {
  const payload = d['wildfire:fires:v1'];
  if (!payload) return [];
  const fires = Array.isArray(payload.fires) ? payload.fires : (Array.isArray(payload) ? payload : []);
  const extreme = fires.filter(f => f.radiativePower > 5000 || f.severity === 'extreme' || safeNum(f.brightness) > 400);
  if (extreme.length === 0) return [];
  const regionMap = new Map();
  for (const f of extreme) {
    const theater = normalizeTheater(f.region || f.country || '');
    regionMap.set(theater, (regionMap.get(theater) || 0) + 1);
  }
  const signals = [];
  for (const [theater, count] of regionMap) {
    if (count < 5) continue;
    const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_WILDFIRE_ESCALATION'] * Math.min(2, 1 + count / 50);
    signals.push({
      id: `wildfire:${theater.replace(/\s+/g, '-').toLowerCase()}`,
      type: 'CROSS_SOURCE_SIGNAL_TYPE_WILDFIRE_ESCALATION',
      theater,
      summary: `Wildfire escalation: ${count} extreme thermal detections in ${theater}`,
      severity: scoreTier(score),
      severityScore: score,
      detectedAt: Date.now(),
      contributingTypes: [],
      signalCount: 0,
    });
  }
  return signals.slice(0, 2);
}

function extractDisplacementSurge(d) {
  const payload = d[`displacement:summary:v1:${new Date().getFullYear()}`];
  if (!payload) return [];
  const crises = Array.isArray(payload.crises) ? payload.crises : (Array.isArray(payload) ? payload : []);
  const surges = crises.filter(c => safeNum(c.newDisplacements) > 50000 || c.trend === 'rising');
  if (surges.length === 0) return [];
  return surges.slice(0, 2).map(c => {
    const theater = normalizeTheater(c.country || c.region || '');
    const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_DISPLACEMENT_SURGE'] * Math.min(2, 1 + safeNum(c.newDisplacements) / 100000);
    return {
      id: `displacement:${theater.replace(/\s+/g, '-').toLowerCase()}`,
      type: 'CROSS_SOURCE_SIGNAL_TYPE_DISPLACEMENT_SURGE',
      theater,
      summary: `Displacement surge: ${c.country || theater} — ${safeNum(c.newDisplacements).toLocaleString()} new displaced persons`,
      severity: scoreTier(score),
      severityScore: score,
      detectedAt: Date.now(),
      contributingTypes: [],
      signalCount: 0,
    };
  });
}

function extractForecastDeterioration(d) {
  const payload = d['forecast:predictions:v2'];
  if (!payload) return [];
  const predictions = Array.isArray(payload.predictions) ? payload.predictions : (Array.isArray(payload) ? payload : []);
  const deteriorating = predictions.filter(p => p.trend === 'deteriorating' || p.direction === 'negative' || safeNum(p.probability) > 0.65);
  if (deteriorating.length === 0) return [];
  return deteriorating.slice(0, 2).map(p => {
    const theater = normalizeTheater(p.region || p.country || p.theater || '');
    const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_FORECAST_DETERIORATION'] * Math.min(2, 1 + safeNum(p.probability));
    return {
      id: `forecast:${p.id || (p.title || p.label || theater).replace(/\s+/g, '-').toLowerCase().slice(0, 40)}`,
      type: 'CROSS_SOURCE_SIGNAL_TYPE_FORECAST_DETERIORATION',
      theater,
      summary: `Forecast deterioration: ${p.title || p.label || 'Geopolitical risk'} — ${Math.round(safeNum(p.probability) * 100)}% probability`,
      severity: scoreTier(score),
      severityScore: score,
      detectedAt: Date.now(),
      contributingTypes: [],
      signalCount: 0,
    };
  });
}

function extractMarketStress(d) {
  const payload = d['market:stocks-bootstrap:v1'];
  if (!payload) return [];
  const quotes = Array.isArray(payload.quotes) ? payload.quotes : [];
  const spx = quotes.find(q => q.symbol === '^GSPC' || q.symbol === 'SPX' || q.display === 'S&P 500');
  if (!spx) return [];
  const change = safeNum(spx.change);
  if (Math.abs(change) < 2) return [];
  const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_MARKET_STRESS'] * Math.min(2, Math.abs(change) / 2);
  return [{
    id: 'market-stress:global',
    type: 'CROSS_SOURCE_SIGNAL_TYPE_MARKET_STRESS',
    theater: 'Global Markets',
    summary: `Market stress: S&P 500 ${change > 0 ? '+' : ''}${change.toFixed(1)}% — ${Math.abs(change) > 4 ? 'extreme' : 'significant'} session move`,
    severity: scoreTier(score),
    severityScore: score,
    detectedAt: Date.now(),
    contributingTypes: [],
    signalCount: 0,
  }];
}

function extractWeatherExtreme(d) {
  const payload = d['weather:alerts:v1'];
  if (!payload) return [];
  const alerts = Array.isArray(payload.alerts) ? payload.alerts : (Array.isArray(payload) ? payload : []);
  const extreme = alerts.filter(a => a.severity === 'extreme' || a.category === 'extreme');
  if (extreme.length === 0) return [];
  const regionMap = new Map();
  for (const a of extreme) {
    const theater = normalizeTheater(a.area || a.country || a.region || '');
    regionMap.set(theater, (regionMap.get(theater) || 0) + 1);
  }
  const signals = [];
  for (const [theater, count] of regionMap) {
    const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_WEATHER_EXTREME'] * Math.min(2, 1 + count / 5);
    signals.push({
      id: `weather:${theater.replace(/\s+/g, '-').toLowerCase()}`,
      type: 'CROSS_SOURCE_SIGNAL_TYPE_WEATHER_EXTREME',
      theater,
      summary: `Extreme weather: ${count} active extreme alert${count > 1 ? 's' : ''} in ${theater}`,
      severity: scoreTier(score),
      severityScore: score,
      detectedAt: Date.now(),
      contributingTypes: [],
      signalCount: 0,
    });
  }
  return signals.slice(0, 2);
}

const GDELT_TONE_TOPICS = ['military', 'nuclear', 'maritime'];

function extractMediaToneDeterioration(d) {
  const signals = [];
  for (const topic of GDELT_TONE_TOPICS) {
    const tonePayload = d[`gdelt:intel:tone:${topic}`];
    if (!tonePayload) continue;
    const series = Array.isArray(tonePayload.data) ? tonePayload.data : [];
    if (series.length < 3) continue;
    const last3 = series.slice(-3);
    const vals = last3.map(p => safeNum(p.value));
    const isDeclining = vals[0] > vals[1] && vals[1] > vals[2];
    const finalVal = vals[2];
    if (!isDeclining || finalVal >= -1.5) continue;
    const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_MEDIA_TONE_DETERIORATION'] * Math.min(2, Math.abs(finalVal) / 3);
    signals.push({
      id: `gdelt-tone:${topic}`,
      type: 'CROSS_SOURCE_SIGNAL_TYPE_MEDIA_TONE_DETERIORATION',
      theater: topic === 'maritime' ? 'Indo-Pacific' : 'Global',
      summary: `Media tone deterioration: ${topic} coverage tone ${finalVal.toFixed(2)} (3-point declining trend)`,
      severity: scoreTier(score),
      severityScore: score,
      detectedAt: Date.now(),
      contributingTypes: [],
      signalCount: 0,
    });
  }
  // Fallback: bundled gdelt-intel topics array if per-topic keys unavailable
  if (signals.length === 0) {
    const payload = d['intelligence:gdelt-intel:v1'];
    const topics = Array.isArray(payload?.topics) ? payload.topics : [];
    for (const topic of topics) {
      const avgTone = safeNum(topic.avgTone || topic.tone);
      if (avgTone > -3) continue;
      const theater = normalizeTheater(topic.region || topic.country || '');
      const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_MEDIA_TONE_DETERIORATION'] * Math.min(2, Math.abs(avgTone) / 3);
      signals.push({
        id: `gdelt-tone:${(topic.id || topic.label || 'unknown').replace(/\s+/g, '-').toLowerCase().slice(0, 40)}`,
        type: 'CROSS_SOURCE_SIGNAL_TYPE_MEDIA_TONE_DETERIORATION',
        theater,
        summary: `Media tone deterioration: "${topic.label || topic.topic}" avg tone ${avgTone.toFixed(1)}`,
        severity: scoreTier(score),
        severityScore: score,
        detectedAt: Date.now(),
        contributingTypes: [],
        signalCount: 0,
      });
      if (signals.length >= 2) break;
    }
  }
  return signals.slice(0, 2);
}

function extractRiskScoreSpike(d) {
  const payload = d['risk:scores:sebuf:stale:v1'];
  if (!payload) return [];
  const ciiScores = Array.isArray(payload.ciiScores) ? payload.ciiScores : [];
  const spiking = ciiScores.filter(s => safeNum(s.combinedScore) > 80 || s.trend === 'TREND_DIRECTION_RISING');
  if (spiking.length === 0) return [];
  return spiking.slice(0, 3).map(s => {
    const theater = normalizeTheater(s.region || '');
    const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_RISK_SCORE_SPIKE'] * Math.min(2, safeNum(s.combinedScore) / 60);
    return {
      id: `risk:${(s.region || 'unknown').replace(/\s+/g, '-').toLowerCase()}`,
      type: 'CROSS_SOURCE_SIGNAL_TYPE_RISK_SCORE_SPIKE',
      theater,
      summary: `Risk score spike: ${s.region || 'unknown'} CII score ${safeNum(s.combinedScore).toFixed(0)} — trend ${s.trend === 'TREND_DIRECTION_RISING' ? 'rising' : 'elevated'}`,
      severity: scoreTier(score),
      severityScore: score,
      detectedAt: Date.now(),
      contributingTypes: [],
      signalCount: 0,
    };
  });
}

// ── Composite escalation detector ─────────────────────────────────────────────
// Fires when >=3 signals from DIFFERENT categories share the same theater.
function detectCompositeEscalation(signals) {
  const theaterMap = new Map();
  for (const sig of signals) {
    if (sig.type === 'CROSS_SOURCE_SIGNAL_TYPE_COMPOSITE_ESCALATION') continue;
    const category = TYPE_CATEGORY[sig.type] || 'other';
    if (!theaterMap.has(sig.theater)) theaterMap.set(sig.theater, new Map());
    const categoryMap = theaterMap.get(sig.theater);
    if (!categoryMap.has(category)) categoryMap.set(category, []);
    categoryMap.get(category).push(sig);
  }

  const composites = [];
  for (const [theater, categoryMap] of theaterMap) {
    if (categoryMap.size < 3) continue; // Need >=3 distinct categories
    const contributingTypes = [];
    let totalScore = 0;
    let signalCount = 0;
    for (const [, categorySigs] of categoryMap) {
      for (const s of categorySigs) {
        contributingTypes.push(s.type.replace('CROSS_SOURCE_SIGNAL_TYPE_', '').replace(/_/g, ' ').toLowerCase());
        totalScore += s.severityScore;
        signalCount++;
      }
    }
    const compositeScore = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_COMPOSITE_ESCALATION'] * Math.min(3, 1 + categoryMap.size / 3) + totalScore * 0.2;
    composites.push({
      id: `composite:${theater.replace(/\s+/g, '-').toLowerCase()}`,
      type: 'CROSS_SOURCE_SIGNAL_TYPE_COMPOSITE_ESCALATION',
      theater,
      summary: `Composite escalation in ${theater}: ${categoryMap.size} signal categories co-firing (${contributingTypes.slice(0, 4).join(', ')}${contributingTypes.length > 4 ? ' ...' : ''})`,
      severity: scoreTier(compositeScore),
      severityScore: compositeScore,
      detectedAt: Date.now(),
      contributingTypes: [...new Set(contributingTypes)],
      signalCount,
    });
  }
  return composites;
}

// ── Main aggregator ───────────────────────────────────────────────────────────
async function aggregateCrossSourceSignals() {
  console.log('  Reading source keys...');
  const sourceData = await readAllSourceKeys();
  const foundKeys = Object.keys(sourceData);
  console.log(`  Found ${foundKeys.length}/${SOURCE_KEYS.length} source keys populated`);

  const allSignals = [];

  // Run all extractors; each handles missing data gracefully (returns [])
  const extractors = [
    extractThermalSpike,
    extractGpsJamming,
    extractMilitaryFlightSurge,
    extractUnrestSurge,
    extractOrefAlertCluster,
    extractVixSpike,
    extractCommodityShock,
    extractCyberEscalation,
    extractShippingDisruption,
    extractSanctionsSurge,
    extractEarthquakeSignificant,
    extractRadiationAnomaly,
    extractInfrastructureOutage,
    extractWildfireEscalation,
    extractDisplacementSurge,
    extractForecastDeterioration,
    extractMarketStress,
    extractWeatherExtreme,
    extractMediaToneDeterioration,
    extractRiskScoreSpike,
  ];

  for (const extractor of extractors) {
    try {
      const extracted = extractor(sourceData);
      allSignals.push(...extracted);
    } catch (err) {
      console.warn(`  Extractor ${extractor.name} failed: ${err.message}`);
    }
  }

  console.log(`  Extracted ${allSignals.length} raw signals`);

  // Detect composite escalation zones
  const composites = detectCompositeEscalation(allSignals);
  console.log(`  Detected ${composites.length} composite escalation zone(s)`);

  // Merge composites at the front, then sort remainder by severity desc, detectedAt desc
  const sortedSignals = allSignals.sort((a, b) =>
    (b.severityScore - a.severityScore) || (b.detectedAt - a.detectedAt)
  );

  const MAX_SIGNALS = 30;
  const finalSignals = [...composites, ...sortedSignals].slice(0, MAX_SIGNALS);

  return {
    signals: finalSignals,
    evaluatedAt: Date.now(),
    compositeCount: composites.length,
  };
}

function validate(data) {
  // Allow publishing even if no signals fired (empty array is valid — no escalation)
  return Array.isArray(data?.signals);
}

runSeed('intelligence', 'cross-source-signals', CANONICAL_KEY, aggregateCrossSourceSignals, {
  ttlSeconds: CACHE_TTL,
  validateFn: validate,
  sourceVersion: 'cross-source-v1',
  recordCount: (data) => data.signals?.length ?? 0,
  afterPublish: async (data) => {
    const { url, token } = getRedisCredentials();
    const metaKey = 'seed-meta:intelligence:cross-source-signals';
    const meta = { fetchedAt: Date.now(), recordCount: data.signals?.length ?? 0 };
    await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['SET', metaKey, JSON.stringify(meta), 'EX', 86400 * 7]),
      signal: AbortSignal.timeout(5_000),
    }).catch(err => console.warn(`  seed-meta write failed: ${err.message}`));
  },
});
