#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const USGS_FEED_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson';
const CANONICAL_KEY = 'seismology:earthquakes:v1';
const CACHE_TTL = 3600; // 1 hour

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

  return { earthquakes };
}

function validate(data) {
  return Array.isArray(data?.earthquakes) && data.earthquakes.length >= 1;
}

runSeed('seismology', 'earthquakes', CANONICAL_KEY, fetchEarthquakes, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'usgs-4.5-day',
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
