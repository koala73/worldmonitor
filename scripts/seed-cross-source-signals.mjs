#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { loadEnvFile, runSeed, getRedisCredentials } from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';
import { CII_RISK_SCORE_CACHE_KEYS } from './_cii-risk-cache-keys.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'intelligence:cross-source-signals:v1';
const CACHE_TTL = 1800; // 30min TTL, 15min cron cadence

// ── Source Redis keys ─────────────────────────────────────────────────────────
const SOURCE_KEYS = [
  'thermal:escalation:v1',
  'intelligence:gpsjam:v2',
  // This writer already derives geospatial theater surges from flight
  // coordinates. Reading the 24h stale key avoids the live key's 10min TTL
  // racing this seeder's 15min cadence.
  'military:surges:stale:v1',
  'unrest:events:v1',
  'relay:oref:history:v1',
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
  'gdelt:intel:tone:military',
  'gdelt:intel:tone:nuclear',
  'gdelt:intel:tone:maritime',
  'weather:alerts:v1',
  CII_RISK_SCORE_CACHE_KEYS.stale,
  'regulatory:actions:v1',
];

// Reject preserved contract envelopes after the same age budgets used by
// api/health.js. runSeed deliberately extends last-good keys on an upstream
// failure without advancing _seed.fetchedAt; without this gate, unwrapping the
// envelope can revive stale observations and stamp them as new signals.
const SOURCE_MAX_AGE_MIN = Object.freeze({
  'thermal:escalation:v1': 360,
  'unrest:events:v1': 120,
  'market:stocks-bootstrap:v1': 30,
  'market:commodities-bootstrap:v1': 30,
  'cyber:threats-bootstrap:v2': 240,
  'supply_chain:shipping:v2': 420,
  'sanctions:pressure:v1': 720,
  'seismology:earthquakes:v1': 30,
  'radiation:observations:v1': 30,
  'infra:outages:v1': 30,
  'wildfire:fires:v1': 360,
  'forecast:predictions:v2': 90,
  'weather:alerts:v1': 45,
});

// ── Theater classification helpers ────────────────────────────────────────────
const REGION_THEATER_MAP = {
  'eastern europe': 'Eastern Europe',
  'ukraine': 'Eastern Europe',
  'russia': 'Eastern Europe',
  'belarus': 'Eastern Europe',
  'baltic': 'Eastern Europe',
  'blacksea': 'Eastern Europe',
  'middle east': 'Middle East',
  'israel': 'Middle East',
  'gaza': 'Middle East',
  'iran': 'Middle East',
  'iraq': 'Middle East',
  'syria': 'Middle East',
  'lebanon': 'Middle East',
  'yemen redsea': 'Red Sea',
  'yemen': 'Middle East',
  'saudi': 'Middle East',
  'east med': 'Middle East',
  'israel gaza': 'Middle East',
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
  CROSS_SOURCE_SIGNAL_TYPE_REGULATORY_ACTION: 'policy',
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
  CROSS_SOURCE_SIGNAL_TYPE_REGULATORY_ACTION: 2.0,      // policy action — direct market impact
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

// Writers publish proto enum strings for status/severity ('THERMAL_STATUS_SPIKE',
// 'CRITICALITY_LEVEL_HIGH', 'OUTAGE_SEVERITY_MAJOR', ...) while several
// extractors here compared against the bare lowercase tier. Accept both forms so
// the comparison cannot go dead again if a writer changes representation — the
// same tolerance seed-correlation.mjs:212 already applies to outage severity.
function enumMatches(value, ...tiers) {
  const normalized = String(value ?? '').toLowerCase();
  return tiers.some((tier) => normalized === tier || normalized.endsWith(`_${tier}`));
}

// Writers are not consistent about epoch-ms numbers vs ISO strings for the same
// concept (thermal lastDetectedAt is ISO, unrest occurredAt is epoch ms).
// Returns 0 for anything undatable so callers can fall back.
function toEpochMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
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
    try {
      // Most of these keys are written by contract-mode seeders, which store
      // `{ _seed, data }` (_seed-utils.mjs:499). Parsing without unwrapping
      // handed every extractor the envelope, so `payload.<field>` was undefined
      // and the signal silently never fired. unwrapEnvelope only unwraps when
      // `_seed.fetchedAt` is a number (_seed-envelope-source.mjs:59), so the
      // legacy bare-shape keys pass through byte-identical.
      //
      // JSON.parse stays out here on purpose: unwrapEnvelope accepts a raw
      // string, but on a parse failure it returns that string as `data`, which
      // would register a malformed value as a found key and inflate the
      // "Found N/M" line below. Parsing first preserves skip-malformed.
      const { _seed, data: payload } = unwrapEnvelope(JSON.parse(raw));
      if (payload == null) continue;
      const key = SOURCE_KEYS[i];
      const maxAgeMin = SOURCE_MAX_AGE_MIN[key];
      if (
        _seed &&
        maxAgeMin != null &&
        Date.now() - _seed.fetchedAt > maxAgeMin * 60_000
      ) continue;
      data[key] = payload;
    } catch { /* skip malformed */ }
  }
  return data;
}

// ── Signal extractors (one per signal type) ───────────────────────────────────

function extractThermalSpike(d) {
  const payload = d['thermal:escalation:v1'];
  if (!payload) return [];
  const clusters = Array.isArray(payload.clusters) ? payload.clusters : [];
  // Cluster shape: lib/thermal-escalation.mjs:308 — status is the proto enum,
  // the anomaly measure is zScore (there is no anomalyScore anywhere in the
  // repo), the label is regionLabel/countryName, and lastDetectedAt is ISO.
  const spikes = clusters.filter(c => enumMatches(c.status, 'spike') || safeNum(c.zScore) > 2);
  if (spikes.length === 0) return [];
  const signals = [];
  for (const c of spikes.slice(0, 5)) {
    const label = c.regionLabel || c.countryName || '';
    const theater = normalizeTheater(label);
    const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_THERMAL_SPIKE'] * Math.min(3, safeNum(c.zScore) || 1.5);
    signals.push({
      id: `thermal:${c.id || (label || 'unknown').replace(/\s+/g, '-').toLowerCase()}`,
      type: 'CROSS_SOURCE_SIGNAL_TYPE_THERMAL_SPIKE',
      theater,
      summary: `Thermal spike detected: ${label || 'unknown'} — z-score ${safeNum(c.zScore).toFixed(1)}`,
      severity: scoreTier(score),
      severityScore: score,
      detectedAt: toEpochMs(c.lastDetectedAt) || Date.now(),
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
      // fetch-gpsjam.mjs:160 writes an ISO string, so safeNum() read 0 here.
      detectedAt: toEpochMs(payload.fetchedAt) || Date.now(),
      contributingTypes: [],
      signalCount: 0,
    };
  });
}

function extractMilitaryFlightSurge(d) {
  const payload = d['military:surges:stale:v1'];
  if (!payload) return [];
  const fetchedAt = toEpochMs(payload.fetchedAt);
  if (!fetchedAt || Date.now() - fetchedAt > 30 * 60_000) return [];
  const surges = Array.isArray(payload.surges) ? payload.surges : [];
  return surges.map((surge) => {
    const theater = normalizeTheater(String(surge.theaterId || '').replace(/-/g, ' '));
    const multiple = Math.max(1, safeNum(surge.surgeMultiple));
    const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_MILITARY_FLIGHT_SURGE'] * Math.min(2, multiple);
    const surgeLabel = String(surge.surgeType || 'air activity').replace(/_/g, ' ');
    return {
      id: `mil-surge:${surge.id || `${surgeLabel}-${surge.theaterId || 'global'}`}`,
      type: 'CROSS_SOURCE_SIGNAL_TYPE_MILITARY_FLIGHT_SURGE',
      theater,
      summary: `Military flight surge: ${surgeLabel} activity at ${multiple.toFixed(1)}x baseline in ${theater}`,
      severity: scoreTier(score),
      severityScore: score,
      detectedAt: toEpochMs(surge.assessedAt) || fetchedAt,
      contributingTypes: [],
      signalCount: 0,
    };
  }).sort((a, b) =>
    (b.severityScore - a.severityScore) ||
    (b.detectedAt - a.detectedAt) ||
    a.id.localeCompare(b.id)
  ).slice(0, 3);
}

function extractUnrestSurge(d) {
  const payload = d['unrest:events:v1'];
  if (!payload) return [];
  const events = Array.isArray(payload.events) ? payload.events : (Array.isArray(payload) ? payload : []);
  if (events.length === 0) return [];
  const cutoff = Date.now() - 24 * 3600 * 1000;
  // seed-unrest-events.mjs:218 publishes occurredAt (epoch ms); date/timestamp/
  // created_at were never written, so the cutoff read 0 for every event and the
  // `|| !e.date` escape hatch let the whole feed through as "recent".
  const recent = events.filter(e => toEpochMs(e.occurredAt) > cutoff);
  const regionMap = new Map();
  for (const ev of recent) {
    // ev.location is { latitude, longitude } (:214) — including it in the chain
    // stringified an object into the theater name.
    const theater = normalizeTheater(ev.country || ev.region || ev.city || '');
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
  const payload = d['relay:oref:history:v1'];
  if (!payload) return [];
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const recentWaves = (Array.isArray(payload.history) ? payload.history : [])
    .map((wave) => ({ wave, detectedAt: toEpochMs(wave.timestamp) }))
    .filter(({ detectedAt }) => detectedAt > cutoff);
  if (recentWaves.length === 0) return [];
  const alertCount = recentWaves.reduce(
    (sum, { wave }) => sum + (Array.isArray(wave.alerts) ? wave.alerts : [])
      .reduce((waveSum, alert) => waveSum + (Array.isArray(alert.data) ? alert.data.length : 1), 0),
    0,
  );
  if (alertCount === 0) return [];
  const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_OREF_ALERT_CLUSTER'] * Math.min(2, 1 + alertCount / 10);
  return [{
    id: 'oref:israel-24h',
    type: 'CROSS_SOURCE_SIGNAL_TYPE_OREF_ALERT_CLUSTER',
    theater: 'Middle East',
    summary: `OREF alert cluster: ${alertCount} alert${alertCount === 1 ? '' : 's'} in Israel in past 24h`,
    severity: scoreTier(score),
    severityScore: score,
    detectedAt: Math.max(...recentWaves.map(({ detectedAt }) => detectedAt)),
    contributingTypes: [],
    signalCount: 0,
  }];
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
  // seed-cyber-threats.mjs:587 publishes CRITICALITY_LEVEL_*; the lowercase
  // tiers this used to compare against are the pre-proto internal form.
  const critical = threats.filter(t => enumMatches(t.severity, 'critical', 'high'));
  if (critical.length === 0) return [];
  const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
  const recent = critical
    .map((threat) => ({
      threat,
      detectedAt: toEpochMs(threat.lastSeenAt) || toEpochMs(threat.firstSeenAt),
    }))
    .filter(({ detectedAt }) => detectedAt > cutoff);
  if (recent.length === 0) return [];
  const countries = new Set(recent.map(({ threat }) => threat.country).filter(Boolean));
  const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_CYBER_ESCALATION'] * Math.min(2, 1 + recent.length / 5);
  return [{
    id: 'cyber:global',
    type: 'CROSS_SOURCE_SIGNAL_TYPE_CYBER_ESCALATION',
    theater: 'Global',
    summary: `Cyber escalation: ${recent.length} critical/high infrastructure indicator${recent.length === 1 ? '' : 's'}${countries.size ? ` geolocated across ${countries.size} countr${countries.size === 1 ? 'y' : 'ies'}` : ''}`,
    severity: scoreTier(score),
    severityScore: score,
    detectedAt: Math.max(...recent.map(({ detectedAt }) => detectedAt)),
    contributingTypes: [],
    signalCount: 0,
  }];
}

function extractShippingDisruption(d) {
  const payload = d['supply_chain:shipping:v2'];
  if (!payload) return [];
  // supply_chain:shipping:v2 publishes rate indices, not routes:
  // { indexId, name, currentValue, previousValue, changePct, unit, history,
  // spikeAlert } (seed-supply-chain-trade.mjs:129). There is no route or
  // disruption concept in the payload, so this keys off the writer's own
  // published spike flag rather than a threshold invented here.
  const indices = Array.isArray(payload.indices) ? payload.indices : [];
  const disrupted = indices.filter(idx => idx.spikeAlert === true);
  if (disrupted.length === 0) return [];
  const theater = disrupted.some(idx => String(idx.name || '').toLowerCase().includes('red sea'))
    ? 'Red Sea' : 'Global';
  const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_SHIPPING_DISRUPTION'] * Math.min(2, 1 + disrupted.length / 3);
  return [{
    id: `shipping:${theater.replace(/\s+/g, '-').toLowerCase()}`,
    type: 'CROSS_SOURCE_SIGNAL_TYPE_SHIPPING_DISRUPTION',
    theater,
    summary: `Shipping disruption: ${disrupted.length} freight rate index${disrupted.length > 1 ? 'es' : ''} spiking (${disrupted.map(idx => idx.name || idx.indexId).join(', ')})`,
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
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const significant = quakes.filter(
    q => safeNum(q.magnitude) >= 6.5 && toEpochMs(q.occurredAt) > cutoff,
  );
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
      // seed-earthquakes.mjs:87 publishes occurredAt; time/timestamp were never
      // written, so every quake was stamped with the run clock.
      detectedAt: toEpochMs(q.occurredAt) || Date.now(),
      contributingTypes: [],
      signalCount: 0,
    };
  });
}

function extractRadiationAnomaly(d) {
  const payload = d['radiation:observations:v1'];
  if (!payload) return [];
  const observations = Array.isArray(payload.observations) ? payload.observations : (Array.isArray(payload) ? payload : []);
  // The observation record (seed-radiation-watch.mjs:172) publishes a severity
  // enum classified from delta/zScore; alert, status and threshold do not
  // exist, so the old filter compared value against NaN and never matched.
  // SPIKE only: BASE_WEIGHT is 3.5, so a single ELEVATED reading would page as
  // CRITICAL on its own.
  const anomalies = observations.filter(o => enumMatches(o.severity, 'spike'));
  if (anomalies.length === 0) return [];
  return anomalies.slice(0, 2).map(a => {
    const locationStr = a.locationName || a.country || 'unknown station';
    const theater = normalizeTheater(a.country || locationStr);
    const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_RADIATION_ANOMALY'];
    return {
      id: `radiation:${a.id || a.anchorId || locationStr.replace(/\s+/g, '-').toLowerCase()}`,
      type: 'CROSS_SOURCE_SIGNAL_TYPE_RADIATION_ANOMALY',
      theater,
      summary: `Radiation anomaly: ${locationStr} — ${safeNum(a.value).toFixed(1)} ${a.unit || ''} reading (z-score ${safeNum(a.zScore).toFixed(1)})`.replace(/\s{2,}/g, ' '),
      severity: scoreTier(score),
      severityScore: score,
      detectedAt: toEpochMs(a.observedAt) || Date.now(),
      contributingTypes: [],
      signalCount: 0,
    };
  });
}

function extractInfrastructureOutage(d) {
  const payload = d['infra:outages:v1'];
  if (!payload) return [];
  const outages = Array.isArray(payload.outages) ? payload.outages : (Array.isArray(payload) ? payload : []);
  // seed-internet-outages.mjs:58 publishes OUTAGE_SEVERITY_TOTAL/MAJOR/PARTIAL.
  // There is no CRITICAL tier and no affectedUsers field, so the old filter
  // matched nothing.
  const now = Date.now();
  const major = outages.filter((o) => {
    const endedAt = toEpochMs(o.endedAt);
    return enumMatches(o.severity, 'total', 'major') && (!endedAt || endedAt > now);
  });
  if (major.length === 0) return [];
  const regionMap = new Map();
  for (const o of major) {
    // region is written as a hardcoded '' (:115) — kept in the chain so a later
    // writer change is picked up, but country is what actually resolves today.
    // o.location is { latitude, longitude }, so it is not a theater source.
    const theater = normalizeTheater(o.region || o.country || 'Global');
    const group = regionMap.get(theater) || { count: 0, detectedAt: 0 };
    group.count += 1;
    group.detectedAt = Math.max(group.detectedAt, toEpochMs(o.detectedAt));
    regionMap.set(theater, group);
  }
  const signals = [];
  for (const [theater, { count, detectedAt }] of regionMap) {
    const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_INFRASTRUCTURE_OUTAGE'] * Math.min(2, 1 + count / 3);
    signals.push({
      id: `outage:${theater.replace(/\s+/g, '-').toLowerCase()}`,
      type: 'CROSS_SOURCE_SIGNAL_TYPE_INFRASTRUCTURE_OUTAGE',
      theater,
      summary: `Infrastructure outage: ${count} major service failure${count > 1 ? 's' : ''} in ${theater}`,
      severity: scoreTier(score),
      severityScore: score,
      detectedAt: detectedAt || now,
      contributingTypes: [],
      signalCount: 0,
    });
  }
  return signals.slice(0, 2);
}

function extractWildfireEscalation(d) {
  const payload = d['wildfire:fires:v1'];
  if (!payload) return [];
  // wildfire:fires:v1 publishes fireDetections, and each detection carries frp
  // (fire radiative power, MW) — not `fires` with `radiativePower`, and it has
  // no severity field at all (seed-fire-detections.mjs:93). The old
  // radiativePower > 5000 clause was also two orders off the scale FIRMS
  // reports, so rather than pick a new number this reuses possibleExplosion,
  // the significance flag the writer itself publishes (frp > 80 && brightness
  // > 380, :106). brightness > 400 was already correct and is kept.
  const detections = Array.isArray(payload.fireDetections) ? payload.fireDetections : [];
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const extreme = detections.filter(
    f => (f.possibleExplosion === true || safeNum(f.brightness) > 400) && toEpochMs(f.detectedAt) > cutoff,
  );
  if (extreme.length === 0) return [];
  const regionMap = new Map();
  for (const f of extreme) {
    // region is the monitored bbox name ('Ukraine', 'Saudi Arabia', ...);
    // there is no country field on a detection.
    const theater = normalizeTheater(f.region || '');
    const group = regionMap.get(theater) || { count: 0, detectedAt: 0 };
    group.count += 1;
    group.detectedAt = Math.max(group.detectedAt, toEpochMs(f.detectedAt));
    regionMap.set(theater, group);
  }
  const signals = [];
  for (const [theater, { count, detectedAt }] of regionMap) {
    if (count < 5) continue;
    const score = BASE_WEIGHT['CROSS_SOURCE_SIGNAL_TYPE_WILDFIRE_ESCALATION'] * Math.min(2, 1 + count / 50);
    signals.push({
      id: `wildfire:${theater.replace(/\s+/g, '-').toLowerCase()}`,
      type: 'CROSS_SOURCE_SIGNAL_TYPE_WILDFIRE_ESCALATION',
      theater,
      summary: `Wildfire escalation: ${count} extreme thermal detections in ${theater}`,
      severity: scoreTier(score),
      severityScore: score,
      detectedAt,
      contributingTypes: [],
      signalCount: 0,
    });
  }
  return signals.slice(0, 2);
}

// Intentionally silent, and documented as such rather than "fixed".
//
// This extractor was written against a `crises[]` array carrying
// `newDisplacements` and `trend`. displacement:summary:v1:<year> has never
// published that shape: the writer emits an annual UNHCR *stock* —
// `summary.countries[]` with code/name/refugees/idps/totalDisplaced
// (seed-displacement-summary.mjs:175) — and carries no flow, delta or trend
// field anywhere in the payload.
//
// So this is not a field-name mismatch that a rename fixes. A surge is a flow,
// and choosing a totalDisplaced cutoff to stand in for one would be inventing a
// calibration rather than repairing a read — the opposite of what the rest of
// this change does. It stays silent until the signal is either sourced from a
// flow series or redefined as a stock-level signal. See #5870.
function extractDisplacementSurge() {
  return [];
}

function extractForecastDeterioration(d) {
  const payload = d['forecast:predictions:v2'];
  if (!payload) return [];
  const predictions = Array.isArray(payload.predictions) ? payload.predictions : (Array.isArray(payload) ? payload : []);
  // computeTrends (seed-forecasts.mjs:2720) only ever assigns
  // 'stable' | 'rising' | 'falling', and there is no `direction` field, so both
  // of those clauses were dead. Probability is the one live criterion; whether
  // a 'rising' trend should also qualify is a calibration call, not a read fix.
  // A prediction's probability is the probability of its proposition, not an
  // escalation score. The canonical writer uses the same polarity distinction
  // when calibrating against prediction markets: a likely ceasefire is not a
  // likely deterioration, while a likely ceasefire failure is.
  const deEscalationTerms = /\b(?:ceasefire|truce|peace|peaceful|agreement|diplomatic solution|withdrawal|reopen(?:ed)?|restored|resolution|resolved|de-?escalat\w*|stabili[sz]\w*|normali[sz]\w*)\b/i;
  const failedDeEscalation = /\b(?:ceasefire|truce|peace|agreement)\b.{0,40}\b(?:fail\w*|collaps\w*|break(?:s|ing)? down|breakdown|breach\w*|violat\w*|reject\w*|expir\w*|end(?:s|ed|ing)?\b(?!\s+of\b))|\b(?:fail\w*|collaps\w*|break(?:s|ing)? down|breakdown|breach\w*|violat\w*|reject\w*|expir\w*|end(?:s|ed|ing)?\b(?!\s+of\b)).{0,40}\b(?:ceasefire|truce|peace|agreement)\b/i;
  const adverseResumption = /\b(?:war|conflict|fighting|hostilities|violence|offensive|attacks?)\b.{0,24}\b(?:resum\w*|renew\w*)\b|\b(?:resum\w*|renew\w*)\b.{0,24}\b(?:war|conflict|fighting|hostilities|violence|offensive|attacks?)\b/i;
  const adverseConditionEnds = /\b(?:war|conflict|fighting|hostilities|violence|offensive|attacks?)\b.{0,40}\bend(?:s|ed|ing)?\b|\bend(?:s|ed|ing)?\b(?:\s+of)?.{0,40}\b(?:war|conflict|fighting|hostilities|violence|offensive|attacks?)\b/i;
  const deteriorating = predictions.filter((p) => {
    if (safeNum(p.probability) <= 0.65) return false;
    const signalText = (Array.isArray(p.signals) ? p.signals : [])
      .map(signal => `${signal?.type || ''} ${signal?.value || ''}`)
      .join(' ');
    const outcomeText = `${p.title || ''} ${p.scenario || ''} ${signalText}`;
    if (adverseConditionEnds.test(outcomeText)) return false;
    if (adverseResumption.test(outcomeText)) return true;
    if (deEscalationTerms.test(outcomeText) && !failedDeEscalation.test(outcomeText)) return false;
    return true;
  });
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
  // NWS passes severity through title-cased ('Extreme' / 'Severe',
  // seed-weather-alerts.mjs:49) and publishes no category field.
  const extreme = alerts.filter(a => enumMatches(a.severity, 'extreme'));
  if (extreme.length === 0) return [];
  // The alert carries areaDesc ('Kern County, CA; Tulare County, CA') and no
  // country/region. Bucketing by that string would give almost every alert its
  // own theater, which can never join a composite. The feed is NWS-only, so the
  // theater is North America by construction.
  const regionMap = new Map([['North America', extreme.length]]);
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

// The per-topic tone keys survive up to TIMELINE_TTL (7d, #5478) so last-good
// data stays SERVABLE through a GDELT brownout — but a days-old declining
// trend must not keep minting deterioration signals stamped detectedAt=now.
// 48h = two daily series points of slack; older (or undatable) payloads are
// skipped and the bundled-canonical fallback below still provides a coarse
// tone signal.
const MAX_TONE_SIGNAL_AGE_MS = 48 * 3600 * 1000;
// A "declining trend" must span real time, not just three adjacent samples.
// The producer's cadence is not a stable contract: it published ~daily DOC
// timeline points, and the bulk materializer (#5843) publishes one point per
// 15-minute cohort, which would turn 45 minutes of small-sample noise into a
// deterioration signal. Requiring a minimum span makes this consumer correct
// under either cadence, and denser series simply need more points (#5863
// review).
const MIN_TONE_TREND_SPAN_MS = 24 * 3600 * 1000;

// Pick the sparsest 3-point window that spans at least MIN_TONE_TREND_SPAN_MS:
// walk back from the newest point and keep the two earlier anchors far enough
// away in time. Returns null when the series does not cover enough ground.
function toneTrendWindow(series) {
  const dated = series
    .map((point) => ({ value: safeNum(point?.value), ms: Date.parse(point?.date) }))
    .filter((point) => Number.isFinite(point.ms) && Number.isFinite(point.value))
    .sort((a, b) => a.ms - b.ms);
  if (dated.length < 3) return null;
  const newest = dated[dated.length - 1];
  const step = MIN_TONE_TREND_SPAN_MS / 2;
  const mid = [...dated].reverse().find((point) => newest.ms - point.ms >= step);
  if (!mid) return null;
  const oldest = [...dated].reverse().find((point) => mid.ms - point.ms >= step);
  if (!oldest) return null;
  return [oldest, mid, newest].map((point) => point.value);
}

function extractMediaToneDeterioration(d) {
  const signals = [];
  for (const topic of GDELT_TONE_TOPICS) {
    const tonePayload = d[`gdelt:intel:tone:${topic}`];
    if (!tonePayload) continue;
    const fetchedMs = Date.parse(tonePayload.fetchedAt);
    if (!Number.isFinite(fetchedMs) || Date.now() - fetchedMs > MAX_TONE_SIGNAL_AGE_MS) continue;
    const series = Array.isArray(tonePayload.data) ? tonePayload.data : [];
    if (series.length < 3) continue;
    const vals = toneTrendWindow(series);
    if (!vals) continue;
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
  // The bundled-canonical fallback that used to sit here read
  // intelligence:gdelt-intel:v1 topics for `avgTone` / `tone`. A topic object is
  // { id, articles, fetchedAt, attemptedAt, _tone, _vol }
  // (seed-gdelt-intel.mjs:438) — neither field has ever existed, so safeNum()
  // returned 0, `0 > -3` skipped every topic, and the branch could not fire even
  // once the envelope was unwrapped. Reconstructing it against topic._tone would
  // mean re-deriving the trend and staleness rules the per-topic path above
  // already implements under #5478/#5863 review, so the dead branch is removed
  // and intelligence:gdelt-intel:v1 is dropped from SOURCE_KEYS with it.
  return signals.slice(0, 2);
}

function extractRiskScoreSpike(d) {
  const payload = d[CII_RISK_SCORE_CACHE_KEYS.stale];
  if (!payload) return [];
  const ciiScores = Array.isArray(payload.ciiScores) ? payload.ciiScores : [];
  const spiking = ciiScores.filter(s => safeNum(s.combinedScore) > 80 || s.trend === 'TREND_DIRECTION_RISING');
  if (spiking.length === 0) return [];
  return spiking.slice(0, 3).map(s => {
    // s.region is an uppercase ISO2 code (get-risk-scores.ts:1206), so it
    // title-cases into 'Ua'/'Cn' rather than mapping to a theater. Left as-is:
    // resolving codes to theater names needs a country resolver this seeder does
    // not have, and the value is at least stable and unique per country.
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

function extractRegulatoryAction(d) {
  const payload = d['regulatory:actions:v1'];
  if (!payload) return [];
  const cutoff = Date.now() - 48 * 3600 * 1000;
  const tierPriority = { high: 0, medium: 1 };
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const recent = actions
    .map((action) => ({
      action,
      publishedAtTs: safeNum(Date.parse(action.publishedAt)),
    }))
    .filter(({ action, publishedAtTs }) => (action.tier === 'high' || action.tier === 'medium') && publishedAtTs > cutoff)
    .sort((a, b) => {
      const tierOrder = tierPriority[a.action.tier] - tierPriority[b.action.tier];
      if (tierOrder !== 0) return tierOrder;
      return b.publishedAtTs - a.publishedAtTs;
    })
    .slice(0, 3);
  if (recent.length === 0) return [];
  return recent.map(({ action, publishedAtTs }) => {
    const tierMult = action.tier === 'high' ? 1.5 : 1.0;
    const score = BASE_WEIGHT.CROSS_SOURCE_SIGNAL_TYPE_REGULATORY_ACTION * tierMult;
    return {
      id: `regulatory:${action.id ?? 'unknown'}`,
      type: 'CROSS_SOURCE_SIGNAL_TYPE_REGULATORY_ACTION',
      theater: 'Global Markets',
      summary: `${action.agency ?? 'Unknown agency'}: ${action.title ?? 'No title'}`,
      severity: scoreTier(score),
      severityScore: score,
      detectedAt: publishedAtTs,
      contributingTypes: [],
      signalCount: 0,
    };
  });
}

// ── Extractor registry ────────────────────────────────────────────────────────
// Module scope (rather than inline in the aggregator) so the envelope-regression
// suite can drive every extractor from one list: an extractor added without a
// fixture fails tests/cross-source-signals-envelope-reads.test.mjs by
// construction. Each handles missing data gracefully and returns [].
const EXTRACTORS = Object.freeze([
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
  extractRegulatoryAction,
]);

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
  const missingKeys = SOURCE_KEYS.filter(k => !foundKeys.includes(k));
  console.log(`  Found ${foundKeys.length}/${SOURCE_KEYS.length} source keys populated`);
  if (missingKeys.length > 0) {
    console.log(`  Missing keys (${missingKeys.length}): ${missingKeys.join(', ')}`);
  }

  const allSignals = [];

  for (const extractor of EXTRACTORS) {
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

export function declareRecords(data) {
  return Array.isArray(data?.signals) ? data.signals.length : 0;
}

// Direct-run guard (scripts/seed-regulatory-actions.mjs:319 idiom). The Railway
// bundle spawns this file as its own process — scripts/_bundle-runner.mjs does
// `spawn(process.execPath, [scriptPath])` — so production still seeds. The guard
// exists so tests can import the extractors instead of reconstructing the module
// with vm + regex source surgery, which is what hid the envelope bug: the old
// harness deleted readAllSourceKeys, the exact seam where the defect lives.
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
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

    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 30,
  });
}

export {
  BASE_WEIGHT,
  EXTRACTORS,
  SOURCE_KEYS,
  TYPE_CATEGORY,
  aggregateCrossSourceSignals,
  detectCompositeEscalation,
  extractCommodityShock,
  extractCyberEscalation,
  extractDisplacementSurge,
  extractEarthquakeSignificant,
  extractForecastDeterioration,
  extractGpsJamming,
  extractInfrastructureOutage,
  extractMarketStress,
  extractMediaToneDeterioration,
  extractMilitaryFlightSurge,
  extractOrefAlertCluster,
  extractRadiationAnomaly,
  extractRegulatoryAction,
  extractRiskScoreSpike,
  extractSanctionsSurge,
  extractShippingDisruption,
  extractThermalSpike,
  extractUnrestSurge,
  extractVixSpike,
  extractWeatherExtreme,
  extractWildfireEscalation,
  normalizeTheater,
  readAllSourceKeys,
  scoreTier,
};
