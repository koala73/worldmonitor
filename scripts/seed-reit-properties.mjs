#!/usr/bin/env node

/**
 * Seed REIT property locations with disaster exposure scores.
 * Reads curated property dataset from data/reit-properties.json,
 * cross-references with earthquake/wildfire/hurricane Redis data
 * to compute per-REIT disaster exposure scores (0-100).
 *
 * Redis key: reits:properties:v1 (TTL 86400s / daily)
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile, getRedisCredentials, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));
const CANONICAL_KEY = 'reits:properties:v1';
const CACHE_TTL = 86400;

// --- Haversine distance (km) ---

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// --- Load disaster data from Redis ---

async function loadRedisKey(key) {
  try {
    const { url, token } = getRedisCredentials();
    const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
  } catch (err) {
    console.warn(`  [Redis] Failed to read ${key}: ${err.message}`);
    return null;
  }
}

async function loadDisasterEvents() {
  const events = [];

  // Earthquakes
  const eqData = await loadRedisKey('seismology:earthquakes:v1');
  if (eqData?.earthquakes) {
    for (const eq of eqData.earthquakes) {
      if (eq.magnitude >= 4.0 && eq.latitude && eq.longitude) {
        events.push({ type: 'earthquake', lat: eq.latitude, lng: eq.longitude, severity: eq.magnitude / 10 });
      }
    }
    console.log(`  [Disaster] Loaded ${events.length} earthquakes (M4.0+)`);
  }

  // Wildfires
  const fireData = await loadRedisKey('wildfire:fires:v1');
  const fireEvents = Array.isArray(fireData) ? fireData : fireData?.fires || [];
  let fireCount = 0;
  for (const f of fireEvents) {
    const lat = f.latitude || f.lat;
    const lng = f.longitude || f.lng || f.lon;
    if (lat && lng) {
      events.push({ type: 'wildfire', lat, lng, severity: 0.7 });
      fireCount++;
    }
  }
  if (fireCount) console.log(`  [Disaster] Loaded ${fireCount} wildfires`);

  // Natural events (hurricanes, storms)
  const naturalData = await loadRedisKey('natural:events:v1');
  const naturalEvents = Array.isArray(naturalData) ? naturalData : naturalData?.events || [];
  let stormCount = 0;
  for (const ev of naturalEvents) {
    const geo = ev.geometry?.[0] || ev;
    const lat = geo.latitude || geo.lat;
    const lng = geo.longitude || geo.lng || geo.lon;
    if (lat && lng) {
      events.push({ type: 'storm', lat, lng, severity: 0.8 });
      stormCount++;
    }
  }
  if (stormCount) console.log(`  [Disaster] Loaded ${stormCount} storms/hurricanes`);

  return events;
}

// --- Compute exposure scores ---

function computeExposureScore(properties, disasterEvents) {
  if (disasterEvents.length === 0) {
    // No disaster data available — return 0 (unknown, not "safe")
    return { score: 0, seismicZoneCount: 0, wildfireRiskCount: 0, hurricaneCorridorCount: 0 };
  }

  let totalProximity = 0;
  let seismicZoneCount = 0;
  let wildfireRiskCount = 0;
  let hurricaneCorridorCount = 0;

  for (const prop of properties) {
    let minEqDist = Infinity;
    let minFireDist = Infinity;
    let minStormDist = Infinity;

    for (const ev of disasterEvents) {
      const dist = haversineKm(prop.lat, prop.lng, ev.lat, ev.lng);
      if (ev.type === 'earthquake' && dist < minEqDist) minEqDist = dist;
      if (ev.type === 'wildfire' && dist < minFireDist) minFireDist = dist;
      if (ev.type === 'storm' && dist < minStormDist) minStormDist = dist;
    }

    if (minEqDist < 200) seismicZoneCount++;
    if (minFireDist < 100) wildfireRiskCount++;
    if (minStormDist < 300) hurricaneCorridorCount++;

    // Proximity score per property: closer to disaster = higher exposure
    // Capped at 500km — beyond that, negligible risk
    const eqScore = Math.max(0, 1 - minEqDist / 500);
    const fireScore = Math.max(0, 1 - minFireDist / 500);
    const stormScore = Math.max(0, 1 - minStormDist / 500);
    totalProximity += (eqScore * 0.4 + fireScore * 0.3 + stormScore * 0.3);
  }

  const avgProximity = properties.length > 0 ? totalProximity / properties.length : 0;
  const score = Math.round(avgProximity * 100);

  return { score: Math.min(100, score), seismicZoneCount, wildfireRiskCount, hurricaneCorridorCount };
}

// --- Main ---

async function fetchReitProperties() {
  // 1. Load curated property dataset
  const rawPath = resolve(__dirname, '..', 'data', 'reit-properties.json');
  const properties = JSON.parse(readFileSync(rawPath, 'utf-8'));
  console.log(`  [Properties] Loaded ${properties.length} curated locations`);

  // 2. Load disaster events from Redis
  const disasterEvents = await loadDisasterEvents();
  console.log(`  [Disaster] Total events: ${disasterEvents.length}`);

  // 3. Compute per-REIT exposure scores
  const reitSymbols = [...new Set(properties.map(p => p.reitSymbol))];
  const exposureSummaries = [];

  for (const symbol of reitSymbols) {
    const reitProps = properties.filter(p => p.reitSymbol === symbol);
    const exposure = computeExposureScore(reitProps, disasterEvents);
    exposureSummaries.push({
      reitSymbol: symbol,
      disasterExposureScore: exposure.score,
      seismicZoneCount: exposure.seismicZoneCount,
      wildfireRiskCount: exposure.wildfireRiskCount,
      hurricaneCorridorCount: exposure.hurricaneCorridorCount,
    });
    if (exposure.score > 0) {
      console.log(`  [Exposure] ${symbol}: ${exposure.score}/100 (eq=${exposure.seismicZoneCount} fire=${exposure.wildfireRiskCount} storm=${exposure.hurricaneCorridorCount})`);
    }
  }

  return {
    properties,
    exposureSummaries,
    lastUpdated: new Date().toISOString(),
  };
}

function validate(data) {
  return Array.isArray(data?.properties) && data.properties.length >= 1;
}

runSeed('reits', 'properties', CANONICAL_KEY, fetchReitProperties, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'curated+disaster-v1',
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
