#!/usr/bin/env node

import { loadEnvFile, runSeed, getRedisCredentials, loadSharedConfig } from './_seed-utils.mjs';
import { resolveIso2, normalizeCountryToken } from './_country-resolver.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'correlation:cards-bootstrap:v1';
const CACHE_TTL = 1200; // 20min — outlives maxStaleMin:15 with buffer (cron runs every 5min)

const INPUT_KEYS = [
  'military:flights:v1',
  'military:flights:stale:v1',
  'unrest:events:v1',
  'infra:outages:v1',
  'seismology:earthquakes:v1',
  'market:stocks-bootstrap:v1',
  'market:commodities-bootstrap:v1',
  'market:crypto:v1',
  'news:insights:v1',
];

async function fetchInputData() {
  const { url, token } = getRedisCredentials();
  const pipeline = INPUT_KEYS.map(k => ['GET', k]);
  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(pipeline),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`Redis pipeline: HTTP ${resp.status}`);
  const results = await resp.json();
  const data = {};
  for (let i = 0; i < INPUT_KEYS.length; i++) {
    const raw = results[i]?.result;
    if (raw) {
      try { data[INPUT_KEYS[i]] = JSON.parse(raw); } catch { /* skip */ }
    }
  }
  return data;
}

// ── Haversine ───────────────────────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const COUNTRY_NAME_TO_ISO2 = loadSharedConfig('country-names.json');
const ISO3_TO_ISO2 = loadSharedConfig('iso3-to-iso2.json');

const COUNTRY_CENTROIDS = {
  'AF':[33.9,67.7],'AL':[41.2,20.2],'DZ':[28.0,1.7],'AO':[-11.2,17.9],'AR':[-38.4,-63.6],
  'AM':[40.1,45.0],'AU':[-25.3,133.8],'AT':[47.5,14.6],'AZ':[40.1,47.6],'BH':[26.0,50.6],
  'BD':[23.7,90.4],'BY':[53.7,28.0],'BE':[50.5,4.5],'BO':[-16.3,-63.6],'BA':[43.9,17.7],
  'BR':[-14.2,-51.9],'BG':[42.7,25.5],'BF':[12.2,-1.6],'KH':[12.6,105.0],'CM':[7.4,12.4],
  'CA':[56.1,-106.3],'CF':[6.6,20.9],'TD':[15.5,18.7],'CL':[-35.7,-71.5],'CN':[35.9,104.2],
  'CO':[4.6,-74.3],'CD':[-4.0,21.8],'CG':[-0.2,15.8],'HR':[45.1,15.2],'CU':[21.5,-78.0],
  'CZ':[49.8,15.5],'DK':[56.3,9.5],'DJ':[11.6,43.1],'DO':[18.7,-70.2],'EC':[-1.8,-78.2],
  'EG':[26.8,30.8],'SV':[13.8,-88.9],'ER':[15.2,39.8],'EE':[58.6,25.0],'ET':[9.1,40.5],
  'FI':[61.9,25.7],'FR':[46.2,2.2],'GE':[42.3,43.4],'DE':[51.2,10.5],'GH':[7.9,-1.0],
  'GR':[39.1,21.8],'GT':[15.8,-90.2],'GN':[9.9,-9.7],'HT':[19.0,-72.3],'HN':[15.2,-86.2],
  'HU':[47.2,19.5],'IN':[20.6,79.0],'ID':[-0.8,113.9],'IR':[32.4,53.7],'IQ':[33.2,43.7],
  'IE':[53.1,-7.7],'IL':[31.0,34.9],'IT':[41.9,12.6],'JM':[18.1,-77.3],'JP':[36.2,138.3],
  'JO':[30.6,36.2],'KZ':[48.0,68.0],'KE':[-0.0,37.9],'KW':[29.3,47.5],'KG':[41.2,74.8],
  'LV':[56.9,24.1],'LB':[33.9,35.9],'LY':[26.3,17.2],'LT':[55.2,23.9],'MG':[-18.8,46.9],
  'MW':[-13.3,34.3],'MY':[4.2,101.9],'ML':[17.6,-4.0],'MR':[21.0,-10.9],'MX':[23.6,-102.6],
  'MD':[47.4,28.4],'MN':[46.9,103.8],'ME':[42.7,19.4],'MA':[31.8,-7.1],'MZ':[-18.7,35.5],
  'MM':[21.9,95.9],'NA':[-22.6,17.1],'NP':[28.4,84.1],'NL':[52.1,5.3],'NZ':[-40.9,174.9],
  'NI':[12.9,-85.2],'NE':[17.6,8.1],'NG':[9.1,8.7],'KP':[40.3,127.5],'MK':[41.5,21.7],
  'NO':[60.5,8.5],'OM':[21.5,55.9],'PK':[30.4,69.3],'PS':[31.9,35.2],'PA':[9.0,-79.5],
  'PG':[-6.3,143.9],'PY':[-23.4,-58.4],'PE':[-9.2,-75.0],'PH':[12.9,121.8],'PL':[51.9,19.1],
  'PT':[39.4,-8.2],'QA':[25.4,51.2],'RO':[45.9,25.0],'RU':[61.5,105.3],'RW':[-1.9,29.9],
  'SA':[23.9,45.1],'SN':[14.5,-14.5],'RS':[44.0,21.0],'SL':[8.5,-11.8],'SG':[1.4,103.8],
  'SK':[48.7,19.7],'SI':[46.2,14.6],'SO':[5.2,46.2],'ZA':[-30.6,22.9],'KR':[35.9,127.8],
  'SS':[6.9,31.3],'ES':[40.5,-3.7],'LK':[7.9,80.8],'SD':[12.9,30.2],'SE':[60.1,18.6],
  'CH':[46.8,8.2],'SY':[35.0,38.5],'TW':[23.7,121.0],'TJ':[38.9,71.3],'TZ':[-6.4,34.9],
  'TH':[15.9,100.9],'TG':[8.6,1.2],'TN':[34.0,9.5],'TR':[39.0,35.2],'TM':[39.0,59.6],
  'UG':[1.4,32.3],'UA':[48.4,31.2],'AE':[23.4,53.8],'GB':[55.4,-3.4],'US':[37.1,-95.7],
  'UY':[-32.5,-55.8],'UZ':[41.4,64.6],'VE':[6.4,-66.6],'VN':[14.1,108.3],'YE':[15.6,48.5],
  'ZM':[-13.1,27.8],'ZW':[-19.0,29.2],
  'CI':[7.5,-5.5],'CR':[10.0,-84.0],'CV':[16.0,-24.0],'CY':[35.1,33.4],'GA':[-0.8,11.6],
  'IS':[64.9,-19.0],'LA':[19.9,102.5],'SZ':[-26.5,31.5],'TL':[-8.9,125.7],'TT':[10.4,-61.2],
  'XK':[42.6,20.9],
};

function nearestCountryByCoords(lat, lon) {
  if (lat == null || lon == null || (lat === 0 && lon === 0)) return undefined;
  let bestCode, bestDist = Infinity;
  for (const [code, [clat, clon]] of Object.entries(COUNTRY_CENTROIDS)) {
    const d = haversineKm(lat, lon, clat, clon);
    if (d < bestDist) { bestDist = d; bestCode = code; }
  }
  return bestDist < 800 ? bestCode : undefined;
}

function normalizeToCode(country, lat, lon) {
  if (country) {
    const resolved = resolveIso2({ iso2: country, iso3: country, name: country });
    if (resolved) return resolved;
  }
  return nearestCountryByCoords(lat, lon);
}

const COUNTRY_NAME_ENTRIES = Object.entries(COUNTRY_NAME_TO_ISO2)
  .filter(([name]) => name.length >= 2)
  .sort((a, b) => b[0].length - a[0].length)
  .map(([name, code]) => ({ name, code, regex: new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') }));

export function matchCountryNamesInText(text) {
  const matched = [];
  let remaining = text.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase()
    .replace(/['.(),/-]/g, ' ').replace(/\s+/g, ' ');
  for (const { code, regex } of COUNTRY_NAME_ENTRIES) {
    if (regex.test(remaining)) {
      matched.push(code);
      remaining = remaining.replace(regex, '');
    }
  }
  return matched;
}

// ── Adapter: Military ───────────────────────────────────────
const STRIKE_TYPES = new Set(['fighter', 'bomber', 'attack']);
const SUPPORT_TYPES = new Set(['tanker', 'awacs', 'surveillance', 'electronic_warfare']);

function collectMilitarySignals(flights) {
  const signals = [];
  const now = Date.now();
  const windowMs = 24 * 60 * 60 * 1000;
  for (const f of flights) {
    const ts = typeof f.lastSeen === 'number' ? f.lastSeen : (f.lastSeen ? new Date(f.lastSeen).getTime() : now);
    if (now - ts > windowMs) continue;
    const isStrike = STRIKE_TYPES.has(f.aircraftType);
    const isSupport = SUPPORT_TYPES.has(f.aircraftType);
    const severity = isStrike ? 80 : isSupport ? 60 : 55;
    signals.push({
      type: 'military_flight',
      source: 'signal-aggregator',
      severity,
      lat: f.lat,
      lon: f.lon,
      country: f.operatorCountry,
      timestamp: ts,
      label: `${f.operator || ''} ${f.aircraftType || ''} ${f.callsign || ''}`.trim(),
      aircraftType: f.aircraftType,
    });
  }
  return signals;
}

function generateMilitaryTitle(cluster) {
  const types = new Set(cluster.map(s => s.type));
  const countries = [...new Set(cluster.map(s => s.country).filter(Boolean))];
  const countryLabel = countries.slice(0, 2).join('/') || 'Unknown region';
  const flightTypes = new Set(
    cluster.filter(s => s.type === 'military_flight').map(s => s.aircraftType).filter(Boolean),
  );
  const hasStrikePackage = [...STRIKE_TYPES].some(t => flightTypes.has(t)) &&
                           [...SUPPORT_TYPES].some(t => flightTypes.has(t));
  if (hasStrikePackage) return `Strike packaging detected \u2014 ${countryLabel}`;
  if (types.has('military_flight')) return `Military flight cluster \u2014 ${countryLabel}`;
  return `Military activity convergence \u2014 ${countryLabel}`;
}

// ── Adapter: Escalation ─────────────────────────────────────
const ESCALATION_KEYWORDS = /\b((?:military|armed|air)\s*(?:strike|attack|offensive)|invasion|bombing|missile|airstrike|shelling|drone\s+strike|war(?:fare)?|ceasefire|martial\s+law|armed\s+clash(?:es)?|gunfire|coup(?:\s+attempt)?|insurgent|rebel|militia|terror(?:ist|ism)|hostage|siege|blockade|mobiliz(?:ation|e)|escalat(?:ion|ing|e)|retaliat|deploy(?:ment|ed)|incursion|annex(?:ation|ed)|occupation|humanitarian\s+crisis|refugee|evacuat|nuclear|chemical\s+weapon|biological\s+weapon)\b/i;

function collectEscalationSignals(protests, outages, newsClusters) {
  const signals = [];
  const now = Date.now();
  const windowMs = 48 * 60 * 60 * 1000;

  for (const p of protests) {
    const ts = typeof p.occurredAt === 'number' ? p.occurredAt : (p.occurredAt ? new Date(p.occurredAt).getTime() : now);
    if (now - ts > windowMs) continue;
    const pLat = p.location?.latitude ?? p.lat;
    const pLon = p.location?.longitude ?? p.lon;
    const code = normalizeToCode(p.country, pLat, pLon);
    if (!code) continue;
    const severityMap = { SEVERITY_LEVEL_HIGH: 85, SEVERITY_LEVEL_MEDIUM: 55, SEVERITY_LEVEL_LOW: 30, high: 85, medium: 55, low: 30 };
    signals.push({
      type: 'conflict_event',
      source: 'signal-aggregator',
      severity: severityMap[p.severity] ?? 40,
      lat: pLat,
      lon: pLon,
      country: code,
      timestamp: ts,
      label: `${p.eventType || 'event'}: ${p.title || ''}`,
    });
  }

  for (const o of outages) {
    const ts = typeof o.detectedAt === 'number' ? o.detectedAt : (o.detectedAt ? new Date(o.detectedAt).getTime() : now);
    if (now - ts > windowMs) continue;
    const oLat = o.location?.latitude ?? o.lat;
    const oLon = o.location?.longitude ?? o.lon;
    if (oLat != null && oLon != null && oLat === 0 && oLon === 0) continue;
    const code = normalizeToCode(o.country, oLat, oLon);
    if (!code) continue;
    const severityMap = { OUTAGE_SEVERITY_TOTAL: 90, OUTAGE_SEVERITY_MAJOR: 70, OUTAGE_SEVERITY_PARTIAL: 40, total: 90, major: 70, partial: 40 };
    signals.push({
      type: 'escalation_outage',
      source: 'signal-aggregator',
      severity: severityMap[o.severity] ?? 30,
      lat: oLat,
      lon: oLon,
      country: code,
      timestamp: ts,
      label: `${o.severity || ''} outage: ${o.title || ''}`,
    });
  }

  for (const c of newsClusters) {
    if (!c.threat || c.threat.level === 'info' || c.threat.level === 'low') continue;
    const ts = c.lastUpdated ?? now;
    if (now - ts > windowMs) continue;
    if (!ESCALATION_KEYWORDS.test(c.primaryTitle)) continue;
    const severity = c.threat.level === 'critical' ? 85 : c.threat.level === 'high' ? 65 : 45;
    const matched = matchCountryNamesInText(c.primaryTitle);
    const code = normalizeToCode(matched[0], c.lat, c.lon);
    if (!code) continue;
    signals.push({
      type: 'news_severity',
      source: 'analysis-core',
      severity,
      lat: c.lat,
      lon: c.lon,
      country: code,
      timestamp: ts,
      label: c.primaryTitle,
    });
  }

  const conflictCountries = new Set(
    signals.filter(s => s.type === 'conflict_event').map(s => s.country).filter(Boolean),
  );
  return signals.filter(s => s.type !== 'escalation_outage' || conflictCountries.has(s.country));
}

function generateEscalationTitle(cluster) {
  const types = new Set(cluster.map(s => s.type));
  const countries = [...new Set(cluster.map(s => s.country).filter(Boolean))];
  const countryLabel = countries[0] || 'Unknown';
  const parts = [];
  if (types.has('conflict_event')) parts.push('conflict');
  if (types.has('escalation_outage')) parts.push('comms disruption');
  if (types.has('news_severity')) parts.push('news escalation');
  return parts.length > 0
    ? `${parts.join(' + ')} \u2014 ${countryLabel}`
    : `Escalation signals \u2014 ${countryLabel}`;
}

// ── Adapter: Economic ───────────────────────────────────────
const SANCTIONS_KEYWORDS = /\b(sanction|tariff|embargo|trade\s+war|ban|restrict|block|seize|freeze\s+assets|export\s+control|blacklist|decouple|decoupl|subsid|dumping|countervail|quota|levy|excise|retaliat|currency\s+manipulat|capital\s+controls|swift|cbdc|petrodollar|de-?dollar|opec|cartel|price\s+cap|oil|crude|commodity|shortage|stockpile|strategic\s+reserve|supply\s+chain|rare\s+earth|chip\s+ban|semiconductor|economic\s+warfare|financial\s+weapon)\b/i;
const COMMODITY_SYMBOLS = new Set(['CL=F', 'GC=F', 'NG=F', 'SI=F', 'HG=F', 'ZW=F', 'BTC-USD', 'BZ=F', 'ETH-USD', 'KC=F', 'SB=F', 'CT=F', 'CC=F']);
const SIGNIFICANT_CHANGE_PCT = 1.5;

function collectEconomicSignals(markets, newsClusters) {
  const signals = [];
  const now = Date.now();
  const windowMs = 24 * 60 * 60 * 1000;

  for (const m of markets) {
    if (m.change == null || m.price == null) continue;
    const absPct = Math.abs(m.change);
    if (absPct < SIGNIFICANT_CHANGE_PCT) continue;
    const isCommodity = COMMODITY_SYMBOLS.has(m.symbol);
    const type = isCommodity ? 'commodity_spike' : 'market_move';
    signals.push({
      type,
      source: 'markets',
      severity: Math.min(100, absPct * 10),
      timestamp: now,
      label: `${m.display ?? m.symbol} ${m.change > 0 ? '+' : ''}${m.change.toFixed(1)}%`,
      symbol: m.symbol,
      display: m.display,
      change: m.change,
    });
  }

  for (const c of newsClusters) {
    const ts = c.lastUpdated ?? now;
    if (now - ts > windowMs) continue;
    if (!SANCTIONS_KEYWORDS.test(c.primaryTitle)) continue;
    const severity = c.threat?.level === 'critical' ? 85 : c.threat?.level === 'high' ? 70 : 50;
    signals.push({
      type: 'sanctions_news',
      source: 'analysis-core',
      severity,
      timestamp: ts,
      label: c.primaryTitle,
    });
  }

  return signals;
}

const KNOWN_ENTITIES = /\b(Iran|Russia|China|North Korea|Venezuela|Cuba|Syria|Myanmar|Belarus|Turkey|Saudi|OPEC|EU|USA?|United States|India)\b(?![A-Za-z])/i;
const GENERIC_ENTITY_KEYS = new Set([
  'sanctions', 'trade', 'tariff', 'commodity', 'currency', 'energy',
  'embargo', 'semiconductor', 'crypto', 'inflation',
]);

function generateEconomicTitle(cluster, entityKey) {
  const types = new Set(cluster.map(s => s.type));

  if (types.has('commodity_spike')) {
    const spikes = cluster.filter(s => s.type === 'commodity_spike');
    const names = spikes.map(s => s.display ?? s.symbol ?? s.label.split(' ')[0]).slice(0, 2);
    const change = spikes[0]?.change;
    const pctSuffix = change != null ? ` (${change > 0 ? '+' : ''}${change.toFixed(1)}%)` : '';
    const base = `${names.join('/')} spike${pctSuffix}`;
    if (types.has('sanctions_news')) return `${base} + sanctions`;
    return base;
  }

  if (types.has('sanctions_news')) {
    const labels = cluster.filter(s => s.type === 'sanctions_news').map(s => s.label);
    let qualifier = '';
    for (const label of labels) {
      const match = KNOWN_ENTITIES.exec(label);
      if (match) { qualifier = match[1]; break; }
    }
    if (!qualifier && entityKey && !GENERIC_ENTITY_KEYS.has(entityKey)) {
      qualifier = entityKey.charAt(0).toUpperCase() + entityKey.slice(1);
    }
    const sanctionsBase = qualifier ? `${qualifier} sanctions activity` : 'Sanctions activity';
    if (types.has('market_move')) {
      const movers = cluster.filter(s => s.type === 'market_move');
      const moverNames = movers.map(s => s.display ?? s.symbol ?? s.label.split(' ')[0]).slice(0, 2);
      return `${sanctionsBase} + ${moverNames.join('/')} disruption`;
    }
    return sanctionsBase;
  }

  if (types.has('market_move')) {
    const movers = cluster.filter(s => s.type === 'market_move');
    const names = movers.map(s => s.display ?? s.symbol ?? s.label.split(' ')[0]).slice(0, 2);
    return `Market disruption: ${names.join('/')}`;
  }

  const fallback = entityKey && !GENERIC_ENTITY_KEYS.has(entityKey)
    ? entityKey.charAt(0).toUpperCase() + entityKey.slice(1) : '';
  return fallback ? `Economic convergence: ${fallback}` : 'Economic convergence detected';
}

// ── Adapter: Disaster ───────────────────────────────────────
function collectDisasterSignals(earthquakes, outages, protests) {
  const signals = [];
  const now = Date.now();
  const windowMs = 96 * 60 * 60 * 1000;

  for (const q of earthquakes) {
    const ts = q.occurredAt ?? now;
    if (now - ts > windowMs) continue;
    if (q.location?.latitude == null || q.location?.longitude == null) continue;
    const severity = Math.min(100, Math.max(10, (q.magnitude - 1.5) * 17));
    signals.push({
      type: 'earthquake',
      source: 'usgs',
      severity,
      lat: q.location.latitude,
      lon: q.location.longitude,
      timestamp: ts,
      label: `M${q.magnitude.toFixed(1)} \u2014 ${q.place}`,
      magnitude: q.magnitude,
    });
  }

  const conflictCountries = new Set(
    (protests ?? [])
      .filter(p => {
        const ts = typeof p.occurredAt === 'number' ? p.occurredAt : (p.occurredAt ? new Date(p.occurredAt).getTime() : now);
        return (now - ts) <= windowMs;
      })
      .map(p => p.country)
      .filter(Boolean),
  );

  for (const o of outages) {
    const ts = typeof o.detectedAt === 'number' ? o.detectedAt : (o.detectedAt ? new Date(o.detectedAt).getTime() : now);
    if (now - ts > windowMs) continue;
    if (o.country && conflictCountries.has(o.country)) continue;
    const oLat = o.location?.latitude ?? o.lat;
    const oLon = o.location?.longitude ?? o.lon;
    if (oLat == null || oLon == null || (oLat === 0 && oLon === 0)) continue;
    const severityMap = { OUTAGE_SEVERITY_TOTAL: 90, OUTAGE_SEVERITY_MAJOR: 70, OUTAGE_SEVERITY_PARTIAL: 40, total: 90, major: 70, partial: 40 };
    signals.push({
      type: 'infra_outage',
      source: 'signal-aggregator',
      severity: severityMap[o.severity] ?? 30,
      lat: oLat,
      lon: oLon,
      country: o.country,
      timestamp: ts,
      label: `Infra outage: ${o.title || ''}`,
    });
  }

  return signals;
}

function generateDisasterTitle(cluster) {
  const types = new Set(cluster.map(s => s.type));
  const parts = [];
  if (types.has('earthquake')) {
    const maxMag = Math.max(...cluster.filter(s => s.type === 'earthquake').map(s => s.magnitude ?? 0));
    parts.push(`M${maxMag.toFixed(1)} seismic`);
  }
  if (types.has('infra_outage')) parts.push('infra disruption');
  const quakePlace = cluster.find(s => s.type === 'earthquake')?.label?.split('\u2014')[1]?.trim();
  return parts.length > 0
    ? `Disaster cascade: ${parts.join(' + ')}${quakePlace ? ` \u2014 ${quakePlace}` : ''}`
    : 'Disaster convergence detected';
}

// ── Clustering ──────────────────────────────────────────────
function clusterByProximity(signals, radiusKm) {
  if (signals.length === 0) return [];
  const DEG_PER_KM_LAT = 1 / 111;
  const cellSizeLat = radiusKm * DEG_PER_KM_LAT;
  const parent = signals.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const grid = new Map();
  const validIndices = [];
  for (let i = 0; i < signals.length; i++) {
    const s = signals[i];
    if (s.lat == null || s.lon == null) continue;
    validIndices.push(i);
    const cellRow = Math.floor(s.lat / cellSizeLat);
    const cosLat = Math.cos(s.lat * Math.PI / 180);
    const cellSizeLon = cosLat > 0.01 ? cellSizeLat / cosLat : cellSizeLat;
    const cellCol = Math.floor(s.lon / cellSizeLon);
    const key = `${cellRow}:${cellCol}`;
    const list = grid.get(key);
    if (list) list.push(i); else grid.set(key, [i]);
  }
  for (const [key, indices] of grid) {
    const sep = key.indexOf(':');
    const row = Number(key.slice(0, sep));
    const col = Number(key.slice(sep + 1));
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const neighbors = grid.get(`${row + dr}:${col + dc}`);
        if (!neighbors) continue;
        for (const i of indices) {
          const si = signals[i];
          for (const j of neighbors) {
            if (i >= j) continue;
            const sj = signals[j];
            if (haversineKm(si.lat, si.lon, sj.lat, sj.lon) <= radiusKm) union(i, j);
          }
        }
      }
    }
  }
  const clusterMap = new Map();
  for (const i of validIndices) {
    const root = find(i);
    const list = clusterMap.get(root);
    if (list) list.push(signals[i]); else clusterMap.set(root, [signals[i]]);
  }
  const clusters = [];
  for (const sigs of clusterMap.values()) {
    if (sigs.length >= 2) clusters.push({ signals: sigs });
  }
  return clusters;
}

function clusterByCountry(signals) {
  const byCountry = new Map();
  for (const s of signals) {
    if (!s.country) continue;
    const list = byCountry.get(s.country) ?? [];
    list.push(s);
    byCountry.set(s.country, list);
  }
  const clusters = [];
  for (const [country, sigs] of byCountry) {
    if (sigs.length < 2) continue;
    clusters.push({ signals: sigs, country });
  }
  return clusters;
}

function clusterByEntity(signals) {
  const COMPOUND_PATTERNS = [
    'supply chain', 'rare earth', 'central bank', 'interest rate',
    'trade war', 'oil price', 'gas price', 'federal reserve',
  ];
  const SINGLE_KEYS = new Set([
    'oil', 'gas', 'sanctions', 'trade', 'tariff', 'commodity', 'currency',
    'energy', 'wheat', 'crude', 'gold', 'silver', 'copper', 'bitcoin',
    'crypto', 'inflation', 'embargo', 'opec', 'semiconductor', 'dollar',
    'yuan', 'euro',
  ]);
  const tokenMap = new Map();
  for (const s of signals) {
    const lower = s.label.toLowerCase();
    let matchedKey = COMPOUND_PATTERNS.find(p => lower.includes(p));
    if (!matchedKey) {
      const words = lower.split(/\W+/);
      matchedKey = words.find(w => SINGLE_KEYS.has(w));
    }
    if (!matchedKey) continue;
    const list = tokenMap.get(matchedKey) ?? [];
    list.push(s);
    tokenMap.set(matchedKey, list);
  }
  const clusters = [];
  for (const [key, sigs] of tokenMap) {
    if (sigs.length < 2) continue;
    clusters.push({ signals: sigs, entityKey: key });
  }
  return clusters;
}

// ── Scoring ─────────────────────────────────────────────────
function scoreClusters(clusters, weights, threshold) {
  return clusters
    .map(cluster => {
      const perType = new Map();
      for (const s of cluster.signals) {
        const current = perType.get(s.type) ?? 0;
        perType.set(s.type, Math.max(current, s.severity));
      }
      let weightedSum = 0;
      for (const [type, severity] of perType) {
        weightedSum += severity * (weights[type] ?? 0);
      }
      const diversityBonus = Math.min(30, Math.max(0, (perType.size - 2)) * 12);
      const score = Math.min(100, weightedSum + diversityBonus);

      let centroidLat, centroidLon;
      const geoSignals = cluster.signals.filter(s => s.lat != null && s.lon != null);
      if (geoSignals.length > 0) {
        centroidLat = geoSignals.reduce((sum, s) => sum + s.lat, 0) / geoSignals.length;
        const toRad = Math.PI / 180;
        let sinSum = 0, cosSum = 0;
        for (const s of geoSignals) {
          sinSum += Math.sin(s.lon * toRad);
          cosSum += Math.cos(s.lon * toRad);
        }
        centroidLon = Math.atan2(sinSum, cosSum) * (180 / Math.PI);
      }

      const countries = [...new Set(cluster.signals.map(s => s.country).filter(Boolean))];
      const key = cluster.country ?? cluster.entityKey ?? `${centroidLat?.toFixed(1)},${centroidLon?.toFixed(1)}`;

      return { cluster, score, countries, centroidLat, centroidLon, key };
    })
    .filter(c => c.score >= threshold);
}

// ── Card Generation ─────────────────────────────────────────
function toCard(scored, domain, titleFn) {
  const title = titleFn(scored.cluster.signals, scored.cluster.entityKey);
  const location = scored.centroidLat != null && scored.centroidLon != null
    ? { lat: scored.centroidLat, lon: scored.centroidLon, label: scored.key }
    : undefined;

  const signals = scored.cluster.signals.map(s => ({
    type: s.type,
    source: s.source,
    severity: s.severity,
    lat: s.lat,
    lon: s.lon,
    country: s.country,
    timestamp: s.timestamp,
    label: s.label,
  }));

  return {
    id: `${domain}:${scored.key}`,
    domain,
    title,
    score: Math.round(scored.score),
    signals,
    location,
    countries: scored.countries,
    trend: 'stable',
    timestamp: Date.now(),
  };
}

// ── Domain configs ──────────────────────────────────────────
const DOMAINS = {
  military: {
    weights: { military_flight: 0.40, ais_gap: 0.30, military_vessel: 0.30 },
    clusterMode: 'geographic',
    spatialRadius: 500,
    threshold: 20,
    titleFn: generateMilitaryTitle,
  },
  escalation: {
    weights: { conflict_event: 0.45, escalation_outage: 0.25, news_severity: 0.30 },
    clusterMode: 'country',
    threshold: 20,
    titleFn: generateEscalationTitle,
  },
  economic: {
    weights: { market_move: 0.35, sanctions_news: 0.30, commodity_spike: 0.35 },
    clusterMode: 'entity',
    threshold: 20,
    titleFn: generateEconomicTitle,
  },
  disaster: {
    weights: { earthquake: 0.55, infra_outage: 0.45 },
    clusterMode: 'geographic',
    spatialRadius: 500,
    threshold: 20,
    titleFn: generateDisasterTitle,
  },
};

// ── Main ────────────────────────────────────────────────────
async function computeCorrelation() {
  const data = await fetchInputData();

  const hasAnyData = INPUT_KEYS.some(k => data[k] != null);
  if (!hasAnyData) throw new Error('No input data available in Redis');

  const flights = data['military:flights:v1']?.flights
    ?? data['military:flights:stale:v1']?.flights
    ?? data['military:flights:v1'] ?? data['military:flights:stale:v1'] ?? [];
  const rawFlights = Array.isArray(flights) ? flights : [];

  const protestData = data['unrest:events:v1'];
  const protests = protestData?.events ?? (Array.isArray(protestData) ? protestData : []);

  const outageData = data['infra:outages:v1'];
  const outages = outageData?.outages ?? (Array.isArray(outageData) ? outageData : []);

  const quakeData = data['seismology:earthquakes:v1'];
  const earthquakes = quakeData?.earthquakes ?? (Array.isArray(quakeData) ? quakeData : []);

  const stockQuotes = data['market:stocks-bootstrap:v1']?.quotes ?? [];
  const commodityQuotes = data['market:commodities-bootstrap:v1']?.quotes ?? [];
  const cryptoQuotes = data['market:crypto:v1']?.quotes ?? [];
  const allMarkets = [...stockQuotes, ...commodityQuotes, ...cryptoQuotes];

  const insights = data['news:insights:v1'];
  const newsClusters = (insights?.topStories ?? []).map(s => ({
    primaryTitle: s.primaryTitle,
    threat: { level: s.threatLevel ?? 'moderate' },
    lastUpdated: s.pubDate ? new Date(s.pubDate).getTime() : (insights?.generatedAt ? new Date(insights.generatedAt).getTime() : Date.now()),
    lat: s.lat,
    lon: s.lon,
  }));

  const result = { military: [], escalation: [], economic: [], disaster: [], computedAt: Date.now() };

  // Military
  const milSignals = collectMilitarySignals(rawFlights);
  const milClusters = clusterByProximity(milSignals, 500);
  const milScored = scoreClusters(milClusters, DOMAINS.military.weights, DOMAINS.military.threshold);
  result.military = milScored.map(s => toCard(s, 'military', generateMilitaryTitle)).sort((a, b) => b.score - a.score);

  // Escalation
  const escSignals = collectEscalationSignals(protests, outages, newsClusters);
  const escClusters = clusterByCountry(escSignals);
  const escScored = scoreClusters(escClusters, DOMAINS.escalation.weights, DOMAINS.escalation.threshold);
  result.escalation = escScored.map(s => toCard(s, 'escalation', generateEscalationTitle)).sort((a, b) => b.score - a.score);

  // Economic
  const ecoSignals = collectEconomicSignals(allMarkets, newsClusters);
  const ecoClusters = clusterByEntity(ecoSignals);
  const ecoScored = scoreClusters(ecoClusters, DOMAINS.economic.weights, DOMAINS.economic.threshold);
  result.economic = ecoScored.map(s => toCard(s, 'economic', generateEconomicTitle)).sort((a, b) => b.score - a.score);

  // Disaster
  const disSignals = collectDisasterSignals(earthquakes, outages, protests);
  const disClusters = clusterByProximity(disSignals, 500);
  const disScored = scoreClusters(disClusters, DOMAINS.disaster.weights, DOMAINS.disaster.threshold);
  result.disaster = disScored.map(s => toCard(s, 'disaster', generateDisasterTitle)).sort((a, b) => b.score - a.score);

  return result;
}

if (process.argv[1]?.endsWith('seed-correlation.mjs')) {
  runSeed('correlation', 'cards', CANONICAL_KEY, computeCorrelation, {
    ttlSeconds: CACHE_TTL,
    sourceVersion: 'correlation-engine-v1',
    recordCount: (data) => (data.military?.length ?? 0) + (data.escalation?.length ?? 0) + (data.economic?.length ?? 0) + (data.disaster?.length ?? 0),
    extraKeys: [
      { key: 'correlation:military:v1', ttl: CACHE_TTL },
      { key: 'correlation:escalation:v1', ttl: CACHE_TTL },
      { key: 'correlation:economic:v1', ttl: CACHE_TTL },
      { key: 'correlation:disaster:v1', ttl: CACHE_TTL },
    ].map(ek => ({
      key: ek.key,
      ttl: ek.ttl,
      transform: (data) => data[ek.key.split(':')[1]],
    })),
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
