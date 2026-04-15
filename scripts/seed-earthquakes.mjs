#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const USGS_FEED_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson';
const CANONICAL_KEY = 'seismology:earthquakes:v1';
const CACHE_TTL = 21600; // 6h — 6x the 1h cron interval (was 2x = survived only 1 missed run)

const TEST_SITES = [
  { name: 'Punggye-ri',    lat: 41.28, lon: 129.08 },
  { name: 'Lop Nur',       lat: 41.39, lon: 89.03  },
  { name: 'Novaya Zemlya', lat: 73.37, lon: 54.78  },
  { name: 'Nevada NTS',    lat: 37.07, lon: -116.05 },
  { name: 'Semipalatinsk', lat: 50.07, lon: 78.43  },
];
const TEST_SITE_RADIUS_KM = 100;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function enrichWithTestSite(eq) {
  const lat = eq.location?.latitude ?? 0;
  const lon = eq.location?.longitude ?? 0;
  let nearest = null;
  let nearestKm = Infinity;
  for (const site of TEST_SITES) {
    const km = haversineKm(lat, lon, site.lat, site.lon);
    if (km < nearestKm) { nearestKm = km; nearest = site; }
  }
  if (nearest && nearestKm <= TEST_SITE_RADIUS_KM) {
    const mag = eq.magnitude ?? 0;
    const depthFactor = Math.max(0, 1 - (eq.depthKm ?? 0) / 100);
    const raw =
      (mag / 9) * 0.6 +
      ((TEST_SITE_RADIUS_KM - nearestKm) / TEST_SITE_RADIUS_KM) * 0.25 +
      depthFactor * 0.15;
    const concernScore = Math.min(100, Math.round(raw * 100));
    const concernLevel =
      concernScore >= 75 ? 'critical'
      : concernScore >= 50 ? 'elevated'
      : concernScore >= 25 ? 'moderate'
      : 'low';
    return { ...eq, nearTestSite: true, testSiteName: nearest.name, concernScore, concernLevel };
  }
  return eq;
}

async function fetchEarthquakes() {
  const resp = await fetch(USGS_FEED_URL, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`USGS API error: ${resp.status}`);

  const geojson = await resp.json();
  const features = geojson.features || [];

  const earthquakes = features
    .filter((f) => f?.properties && f?.geometry?.coordinates)
    .map((f) => ({
      id: String(f.id || ''),
      place: String(f.properties?.place || ''),
      magnitude: f.properties?.mag ?? 0,
      depthKm: f.geometry?.coordinates?.[2] ?? 0,
      location: {
        latitude: f.geometry?.coordinates?.[1] ?? 0,
        longitude: f.geometry?.coordinates?.[0] ?? 0,
      },
      occurredAt: f.properties?.time ?? 0,
      sourceUrl: String(f.properties?.url || ''),
    }));

  return { earthquakes: earthquakes.map(enrichWithTestSite) };
}

function validate(data) {
  return Array.isArray(data?.earthquakes) && data.earthquakes.length >= 1;
}

export function declareRecords(data) {
  return Array.isArray(data?.earthquakes) ? data.earthquakes.length : 0;
}

runSeed('seismology', 'earthquakes', CANONICAL_KEY, fetchEarthquakes, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'usgs-4.5-day-nuclear-v1',
  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 30,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
