#!/usr/bin/env node

import { loadEnvFile, runSeed, getRedisCredentials } from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';

loadEnvFile(import.meta.url);

export const CANONICAL_KEY = 'energy:chokepoint-flows:v1';
const PORTWATCH_KEY = 'supply_chain:portwatch:v1';
const BASELINES_KEY = 'energy:chokepoint-baselines:v1';
const DISRUPTIONS_KEY = 'portwatch:disruptions:active:v1';
const TTL = 259_200; // 3d — upstream seeder runs every 6h
const HAZARD_RADIUS_KM = 500;

// 7 chokepoints with EIA baseline mb/d figures + coordinates for hazard matching
const CHOKEPOINT_MAP = [
  { canonicalId: 'hormuz_strait',  baselineId: 'hormuz',  lat: 26.56, lon: 56.25 },
  { canonicalId: 'malacca_strait', baselineId: 'malacca', lat: 2.5,   lon: 101.5 },
  { canonicalId: 'suez',           baselineId: 'suez',    lat: 30.45, lon: 32.35 },
  { canonicalId: 'bab_el_mandeb',  baselineId: 'babelm',  lat: 12.58, lon: 43.33 },
  { canonicalId: 'bosphorus',      baselineId: 'turkish', lat: 41.12, lon: 29.05 },
  { canonicalId: 'dover_strait',   baselineId: 'danish',  lat: 51.05, lon: 1.45  },
  { canonicalId: 'panama',         baselineId: 'panama',  lat: 9.08,  lon: -79.68 },
];

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function findNearestHazard(events, cpLat, cpLon) {
  if (!Array.isArray(events)) return null;
  let best = null;
  let bestDist = HAZARD_RADIUS_KM;
  for (const ev of events) {
    if (ev.alertLevel !== 'RED' && ev.alertLevel !== 'ORANGE') continue;
    if (!ev.active) continue;
    if (!Number.isFinite(ev.lat) || !Number.isFinite(ev.lon)) continue;
    const dist = haversineKm(cpLat, cpLon, ev.lat, ev.lon);
    if (dist < bestDist) { bestDist = dist; best = ev; }
  }
  return best;
}

async function redisGet(url, token, key) {
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.result ? unwrapEnvelope(JSON.parse(data.result)).data : null;
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

export async function fetchAll() {
  const { url, token } = getRedisCredentials();

  const [portwatch, baselines, disruptions] = await Promise.all([
    redisGet(url, token, PORTWATCH_KEY),
    redisGet(url, token, BASELINES_KEY),
    redisGet(url, token, DISRUPTIONS_KEY).catch(() => null), // optional — absent until PR 4 deploys
  ]);

  if (!portwatch || typeof portwatch !== 'object' || Object.keys(portwatch).length === 0) {
    throw new Error('PortWatch data unavailable (supply_chain:portwatch:v1 absent or empty) — retrying in 20 min');
  }

  const result = {};

  for (const cp of CHOKEPOINT_MAP) {
    const pw = portwatch[cp.canonicalId];
    if (!pw?.history?.length) continue;

    const baseline = baselines?.chokepoints?.find(b => b.id === cp.baselineId);
    if (!baseline?.mbd) continue;

    const history = [...pw.history].sort((a, b) => a.date.localeCompare(b.date));

    // Require at least 40 days of data to compute a meaningful baseline
    if (history.length < 40) continue;

    const last7 = history.slice(-7);
    const prev90 = history.slice(-97, -7); // days [-97..-7], up to 90 days
    if (last7.length < 3 || prev90.length < 20) continue;

    // Prefer DWT (capTanker) when the baseline window has majority DWT coverage.
    // Decision is based on the 90-day baseline, NOT the recent window — zero
    // recent capTanker is the disruption signal, not a reason to abandon DWT.
    // Majority guard: partial DWT roll-out (1-2 days non-zero) should not
    // activate DWT mode and pull down the baseline average via zero-filled gaps.
    const dwtBaselineDays = prev90.filter(d => (d.capTanker ?? 0) > 0).length;
    const useDwt = dwtBaselineDays >= Math.ceil(prev90.length / 2);

    const current7d = useDwt
      ? avg(last7.map(d => d.capTanker ?? 0))
      : avg(last7.map(d => d.tanker ?? 0));

    const baseline90d = useDwt
      ? avg(prev90.map(d => d.capTanker ?? 0))
      : avg(prev90.map(d => d.tanker ?? 0));

    // Skip if baseline is too thin to be meaningful
    if (baseline90d < (useDwt ? 1 : 0.5)) continue;

    const flowRatio = Math.min(1.5, Math.max(0, current7d / baseline90d));
    const currentMbd = Math.round(baseline.mbd * flowRatio * 10) / 10;

    // Disrupted = each of last 3 individual days has day_ratio < 0.85
    const last3 = history.slice(-3);
    const disrupted = last3.length === 3 && last3.every(d => {
      const dayVal = useDwt ? (d.capTanker ?? 0) : (d.tanker ?? 0);
      return baseline90d > 0 && (dayVal / baseline90d) < 0.85;
    });

    const hazard = findNearestHazard(disruptions?.events, cp.lat, cp.lon);

    result[cp.canonicalId] = {
      currentMbd,
      baselineMbd: baseline.mbd,
      flowRatio: Math.round(flowRatio * 1000) / 1000,
      disrupted,
      source: useDwt ? 'portwatch-dwt' : 'portwatch-counts',
      hazardAlertLevel: hazard?.alertLevel ?? null,
      hazardAlertName: hazard?.eventName ?? null,
    };
  }

  if (Object.keys(result).length === 0) {
    console.warn('[ChokepointFlows] No flow estimates computed — PortWatch and baselines data may be insufficient');
  }

  return result;
}

export function validateFn(data) {
  return data && typeof data === 'object' && Object.keys(data).length >= 3;
}

const isMain = process.argv[1]?.endsWith('seed-chokepoint-flows.mjs');
export function declareRecords(data) {
  return data && typeof data === "object" ? Object.keys(data).length : 0;
}

if (isMain) {
  runSeed('energy', 'chokepoint-flows', CANONICAL_KEY, fetchAll, {
    validateFn,
    ttlSeconds: TTL,
    sourceVersion: 'portwatch-eia-flows-v1',
    recordCount: (data) => Object.keys(data).length,
  
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 720,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
