import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { getCachedJson, setCachedJson } from './_upstash-cache.js';

export const config = { runtime: 'edge' };

const CACHE_KEY = 'cable-health-v1';
const CACHE_TTL = 180; // 3 minutes

/**
 * Cable Health API
 *
 * Computes a health status for each submarine cable by combining:
 * 1. Operator fault signals from NGA maritime warnings
 * 2. Repair ship activity (cable ship proximity/operations)
 *
 * Each signal produces a severity, confidence, and TTL.
 * The composite score per cable = max(effective signals).
 * Status thresholds: fault >= 0.80, degraded >= 0.50, ok < 0.50.
 */
export default async function handler(req) {
  const cors = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  try {
    // Check cache
    const cached = await getCachedJson(CACHE_KEY);
    if (cached) {
      return new Response(JSON.stringify(cached), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...cors,
          'Cache-Control': 'public, max-age=60, s-maxage=180, stale-while-revalidate=60',
        },
      });
    }

    // Fetch NGA warnings (reuse existing endpoint logic)
    const ngaData = await fetchNgaWarnings();
    const signals = processNgaSignals(ngaData);
    const healthMap = computeHealthMap(signals);

    const result = {
      generatedAt: new Date().toISOString(),
      cables: healthMap,
    };

    // Cache the result
    await setCachedJson(CACHE_KEY, result, CACHE_TTL).catch(() => {});

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...cors,
        'Cache-Control': 'public, max-age=60, s-maxage=180, stale-while-revalidate=60',
      },
    });
  } catch (error) {
    console.error('[cable-health] Error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }
}

// ── NGA Warning Fetch ──

async function fetchNgaWarnings() {
  try {
    const res = await fetch(
      'https://msi.nga.mil/api/publications/broadcast-warn?output=json&status=A',
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : data?.warnings ?? [];
  } catch {
    return [];
  }
}

// ── Signal Processing ──

const CABLE_KEYWORDS = [
  'CABLE', 'CABLESHIP', 'CABLE SHIP', 'CABLE LAYING',
  'CABLE OPERATIONS', 'SUBMARINE CABLE', 'UNDERSEA CABLE',
  'FIBER OPTIC', 'TELECOMMUNICATIONS CABLE',
];

const FAULT_KEYWORDS = /FAULT|BREAK|CUT|DAMAGE|SEVERED|RUPTURE|OUTAGE|FAILURE/i;
const SHIP_PATTERNS = [
  /CABLESHIP\s+([A-Z][A-Z0-9\s\-']+)/i,
  /CABLE\s+SHIP\s+([A-Z][A-Z0-9\s\-']+)/i,
  /CS\s+([A-Z][A-Z0-9\s\-']+)/i,
  /M\/V\s+([A-Z][A-Z0-9\s\-']+)/i,
];
const ON_STATION_RE = /ON STATION|OPERATIONS IN PROGRESS|LAYING|REPAIRING|WORKING|COMMENCED/i;

// Known cable names → cableId mapping for direct key matching
const CABLE_NAME_MAP = {
  'MAREA': 'marea',
  'GRACE HOPPER': 'grace_hopper',
  'HAVFRUE': 'havfrue',
  'FASTER': 'faster',
  'SOUTHERN CROSS': 'southern_cross',
  'CURIE': 'curie',
  'SEA-ME-WE': 'seamewe6',
  'SEAMEWE': 'seamewe6',
  'SMW6': 'seamewe6',
  'FLAG': 'flag',
  '2AFRICA': '2africa',
  'WACS': 'wacs',
  'EASSY': 'eassy',
  'SAM-1': 'sam1',
  'SAM1': 'sam1',
  'ELLALINK': 'ellalink',
  'ELLA LINK': 'ellalink',
  'APG': 'apg',
  'INDIGO': 'indigo',
  'SJC': 'sjc',
  'FARICE': 'farice',
  'FALCON': 'falcon',
};

// Minimal cable geometry for proximity matching (landing coords)
const CABLE_LANDINGS = {
  marea: [[36.85, -75.98], [43.26, -2.93]],
  grace_hopper: [[40.57, -73.97], [50.83, -4.55], [43.26, -2.93]],
  havfrue: [[40.22, -74.01], [58.15, 8.0], [55.56, 8.13]],
  faster: [[43.37, -124.22], [34.95, 139.95], [34.32, 136.85]],
  southern_cross: [[-33.87, 151.21], [-36.85, 174.76], [33.74, -118.27]],
  curie: [[33.74, -118.27], [-33.05, -71.62]],
  seamewe6: [[1.35, 103.82], [19.08, 72.88], [25.13, 56.34], [21.49, 39.19], [29.97, 32.55], [43.30, 5.37]],
  flag: [[50.04, -5.66], [31.20, 29.92], [25.20, 55.27], [19.08, 72.88], [1.35, 103.82], [35.69, 139.69]],
  '2africa': [[50.83, -4.55], [38.72, -9.14], [14.69, -17.44], [6.52, 3.38], [-33.93, 18.42], [-4.04, 39.67], [21.49, 39.19], [31.26, 32.30]],
  wacs: [[-33.93, 18.42], [6.52, 3.38], [14.69, -17.44], [38.72, -9.14], [51.51, -0.13]],
  eassy: [[-29.85, 31.02], [-25.97, 32.58], [-6.80, 39.28], [-4.04, 39.67], [11.59, 43.15]],
  sam1: [[-22.91, -43.17], [-34.60, -58.38], [26.36, -80.08]],
  ellalink: [[38.72, -9.14], [-3.72, -38.52]],
  apg: [[35.69, 139.69], [25.15, 121.44], [22.29, 114.17], [1.35, 103.82]],
  indigo: [[-31.95, 115.86], [1.35, 103.82], [-6.21, 106.85]],
  sjc: [[35.69, 139.69], [36.07, 120.32], [1.35, 103.82], [22.29, 114.17]],
  farice: [[64.13, -21.90], [62.01, -6.77], [55.95, -3.19]],
  falcon: [[25.13, 56.34], [23.59, 58.38], [26.23, 50.59], [29.38, 47.98]],
};

function isCableRelated(text) {
  const upper = text.toUpperCase();
  return CABLE_KEYWORDS.some(kw => upper.includes(kw));
}

function parseCoordinates(text) {
  const coords = [];
  const dms = /(\d{1,3})-(\d{1,2}(?:\.\d+)?)\s*([NS])\s+(\d{1,3})-(\d{1,2}(?:\.\d+)?)\s*([EW])/gi;
  let m;
  while ((m = dms.exec(text)) !== null) {
    let lat = parseInt(m[1], 10) + parseFloat(m[2]) / 60;
    let lon = parseInt(m[4], 10) + parseFloat(m[5]) / 60;
    if (m[3].toUpperCase() === 'S') lat = -lat;
    if (m[6].toUpperCase() === 'W') lon = -lon;
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) coords.push([lat, lon]);
  }
  return coords;
}

function matchCableByName(text) {
  const upper = text.toUpperCase();
  for (const [name, id] of Object.entries(CABLE_NAME_MAP)) {
    if (upper.includes(name)) return id;
  }
  return null;
}

function findNearestCable(lat, lon) {
  let bestId = null;
  let bestDist = Infinity;
  const MAX_DIST_DEG = 5;

  for (const [cableId, landings] of Object.entries(CABLE_LANDINGS)) {
    for (const [lLat, lLon] of landings) {
      const dist = Math.sqrt((lat - lLat) ** 2 + (lon - lLon) ** 2);
      if (dist < bestDist && dist < MAX_DIST_DEG) {
        bestDist = dist;
        bestId = cableId;
      }
    }
  }

  return bestId ? { cableId: bestId, distanceDeg: bestDist } : null;
}

function parseIssueDate(dateStr) {
  const m = dateStr?.match(/(\d{2})(\d{4})Z\s+([A-Z]{3})\s+(\d{4})/i);
  if (!m) return new Date(0); // epoch: signal will decay to zero immediately
  const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  return new Date(Date.UTC(
    parseInt(m[4], 10),
    months[m[3].toUpperCase()] ?? 0,
    parseInt(m[1], 10),
    parseInt(m[2].slice(0, 2), 10),
    parseInt(m[2].slice(2, 4), 10),
  ));
}

function hasShipName(text) {
  for (const pat of SHIP_PATTERNS) {
    if (pat.test(text)) return true;
  }
  return false;
}

function processNgaSignals(warnings) {
  const signals = []; // Array of { cableId, ts, severity, confidence, ttlSeconds, kind, evidence }

  const cableWarnings = warnings.filter(w => isCableRelated(w.text || ''));

  for (const warning of cableWarnings) {
    const text = warning.text || '';
    const ts = parseIssueDate(warning.issueDate).toISOString();
    const coords = parseCoordinates(text);

    // Direct cable ID match by name
    let cableId = matchCableByName(text);
    let joinMethod = 'name';
    let distanceKm = 0;

    // Fallback: geometry proximity match
    if (!cableId && coords.length > 0) {
      const centLat = coords.reduce((s, c) => s + c[0], 0) / coords.length;
      const centLon = coords.reduce((s, c) => s + c[1], 0) / coords.length;
      const nearest = findNearestCable(centLat, centLon);
      if (nearest) {
        cableId = nearest.cableId;
        joinMethod = 'geometry';
        distanceKm = Math.round(nearest.distanceDeg * 111);
      }
    }

    if (!cableId) continue;

    const isFault = FAULT_KEYWORDS.test(text);
    const isRepairShip = hasShipName(text);
    const isOnStation = ON_STATION_RE.test(text);

    const warningId = `${warning.navArea || 'X'}-${warning.msgYear}-${warning.msgNumber}`;
    const summaryText = text.slice(0, 150) + (text.length > 150 ? '...' : '');

    // Signal 1: Operator fault / hazard advisory
    if (isFault) {
      signals.push({
        cableId,
        ts,
        severity: 1.0,
        confidence: joinMethod === 'name' ? 0.9 : Math.max(0.4, 0.8 - distanceKm / 500),
        ttlSeconds: 5 * 86400, // 5 days
        kind: 'operator_fault',
        evidence: [{
          source: 'NGA',
          summary: `Fault/damage reported: ${summaryText}`,
          ts,
          meta: { warningId, joinMethod, distanceKm },
        }],
      });
    } else {
      // Hazard/avoidance advisory
      signals.push({
        cableId,
        ts,
        severity: 0.6,
        confidence: joinMethod === 'name' ? 0.8 : Math.max(0.3, 0.7 - distanceKm / 500),
        ttlSeconds: 3 * 86400, // 3 days
        kind: 'operator_fault',
        evidence: [{
          source: 'NGA',
          summary: `Cable advisory: ${summaryText}`,
          ts,
          meta: { warningId, joinMethod, distanceKm },
        }],
      });
    }

    // Signal 2: Repair activity
    if (isRepairShip) {
      signals.push({
        cableId,
        ts,
        severity: isOnStation ? 0.8 : 0.5,
        confidence: isOnStation ? 0.85 : 0.6,
        ttlSeconds: isOnStation ? 24 * 3600 : 12 * 3600,
        kind: 'repair_activity',
        evidence: [{
          source: 'NGA',
          summary: isOnStation
            ? `Cable repair vessel on station: ${summaryText}`
            : `Cable ship in area: ${summaryText}`,
          ts,
          meta: { warningId, joinMethod, status: isOnStation ? 'on-station' : 'enroute' },
        }],
      });
    }
  }

  return signals;
}

// ── Health Computation ──

function computeHealthMap(signals) {
  const now = Date.now();
  const byCable = {};

  // Group signals by cable
  for (const sig of signals) {
    if (!byCable[sig.cableId]) byCable[sig.cableId] = [];
    byCable[sig.cableId].push(sig);
  }

  const healthMap = {};

  for (const [cableId, cableSignals] of Object.entries(byCable)) {
    const effectiveSignals = [];

    for (const sig of cableSignals) {
      const ageMs = now - new Date(sig.ts).getTime();
      const ageSec = Math.max(0, ageMs / 1000);
      const recencyWeight = Math.max(0, Math.min(1, 1 - ageSec / sig.ttlSeconds));

      if (recencyWeight <= 0) continue;

      const effective = sig.severity * sig.confidence * recencyWeight;
      effectiveSignals.push({ ...sig, effective, recencyWeight });
    }

    if (effectiveSignals.length === 0) continue;

    // Sort by effective score descending
    effectiveSignals.sort((a, b) => b.effective - a.effective);

    const topScore = effectiveSignals[0].effective;
    const topConfidence = effectiveSignals[0].confidence * effectiveSignals[0].recencyWeight;

    // Attribution rules: fault requires operator_fault OR two corroborating signal types
    const hasOperatorFault = effectiveSignals.some(
      s => s.kind === 'operator_fault' && s.effective >= 0.50
    );
    const hasRepairActivity = effectiveSignals.some(
      s => s.kind === 'repair_activity' && s.effective >= 0.40
    );

    let status;
    if (topScore >= 0.80 && hasOperatorFault) {
      status = 'fault';
    } else if (topScore >= 0.80 && hasRepairActivity) {
      // Repair activity alone caps at degraded (operator fault required for fault)
      status = 'degraded';
    } else if (topScore >= 0.50) {
      status = 'degraded';
    } else {
      status = 'ok';
    }

    // Top 3 evidence items
    const evidence = effectiveSignals
      .slice(0, 3)
      .flatMap(s => s.evidence)
      .slice(0, 3)
      .map(e => ({
        source: e.source,
        summary: e.summary,
        ts: e.ts,
      }));

    // Find latest timestamp
    const lastUpdated = effectiveSignals
      .map(s => s.ts)
      .sort()
      .reverse()[0];

    healthMap[cableId] = {
      status,
      score: Math.round(topScore * 100) / 100,
      confidence: Math.round(topConfidence * 100) / 100,
      lastUpdated,
      evidence,
    };
  }

  return healthMap;
}

// ── Test helpers (exported for unit tests, not used in production) ──

export function __testProcessNgaSignals(warnings) {
  return processNgaSignals(warnings);
}

export function __testComputeHealthMap(signals) {
  return computeHealthMap(signals);
}

export function __testIsCableRelated(text) {
  return isCableRelated(text);
}

export function __testMatchCableByName(text) {
  return matchCableByName(text);
}

export function __testFindNearestCable(lat, lon) {
  return findNearestCable(lat, lon);
}

export function __testParseCoordinates(text) {
  return parseCoordinates(text);
}
