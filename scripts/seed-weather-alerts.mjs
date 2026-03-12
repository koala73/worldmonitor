#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const NWS_API = 'https://api.weather.gov/alerts/active';
const CANONICAL_KEY = 'weather:alerts:v1';
const CACHE_TTL = 900; // 15 min

function extractCoordinates(geometry) {
  if (!geometry) return [];
  try {
    if (geometry.type === 'Polygon') {
      return geometry.coordinates[0]?.map(c => [c[0], c[1]]) || [];
    }
    if (geometry.type === 'MultiPolygon') {
      return geometry.coordinates[0]?.[0]?.map(c => [c[0], c[1]]) || [];
    }
  } catch { /* ignore */ }
  return [];
}

function calculateCentroid(coords) {
  if (coords.length === 0) return undefined;
  const sum = coords.reduce((acc, [lon, lat]) => [acc[0] + lon, acc[1] + lat], [0, 0]);
  return [sum[0] / coords.length, sum[1] / coords.length];
}

async function fetchAlerts() {
  const resp = await fetch(NWS_API, {
    headers: { Accept: 'application/geo+json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`NWS API error: ${resp.status}`);

  const data = await resp.json();
  const features = data.features || [];

  const alerts = features
    .filter(f => f?.properties?.severity !== 'Unknown')
    .slice(0, 50)
    .map(f => {
      const p = f.properties;
      const coords = extractCoordinates(f.geometry);
      return {
        id: f.id || '',
        event: p.event || '',
        severity: p.severity || 'Unknown',
        headline: p.headline || '',
        description: (p.description || '').slice(0, 500),
        areaDesc: p.areaDesc || '',
        onset: p.onset || '',
        expires: p.expires || '',
        coordinates: coords,
        centroid: calculateCentroid(coords),
      };
    });

  return { alerts };
}

function validate(data) {
  return Array.isArray(data?.alerts) && data.alerts.length >= 1;
}

runSeed('weather', 'alerts', CANONICAL_KEY, fetchAlerts, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'nws-active',
}).catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
