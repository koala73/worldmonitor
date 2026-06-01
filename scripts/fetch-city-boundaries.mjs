#!/usr/bin/env node
/**
 * Fetches city boundary polygons from Nominatim and writes api/data/city-boundaries.ts.
 *
 * Usage:
 *   node scripts/fetch-city-boundaries.mjs
 *
 * Nominatim rate limits apply; this script pauses between requests.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = join(__dirname, '..', 'api', 'data', 'city-boundaries.ts');

const CITY_QUERIES = [
  { key: 'san francisco', queries: ['San Francisco, California, USA'], country: 'USA' },
  { key: 'new york', queries: ['New York, New York, USA'], country: 'USA' },
  { key: 'london', queries: ['London, UK'], country: 'UK' },
  { key: 'paris', queries: ['Paris, France'], country: 'France' },
  { key: 'tokyo', queries: ['Tokyo, Japan'], country: 'Japan' },
  { key: 'beijing', queries: ['Beijing, China'], country: 'China' },
  { key: 'mumbai', queries: ['Mumbai, India', 'Mumbai Suburban District, Maharashtra, India', 'Mumbai Metropolitan Region, Maharashtra, India'], country: 'India' },
  { key: 'delhi', queries: ['Delhi, India'], country: 'India' },
  { key: 'sydney', queries: ['Sydney, Australia'], country: 'Australia' },
  { key: 'singapore', queries: ['Singapore, Singapore'], country: 'Singapore' },
];

function titleCase(value) {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}

function toTsLiteral(value, indent = 2) {
  return JSON.stringify(value, null, indent)
    .replace(/"([A-Za-z_$][A-Za-z0-9_$]*)"(?=\s*:)/g, '$1');
}

function findPolygonFeature(results, key) {
  if (!Array.isArray(results)) {
    throw new Error(`Unexpected search result format for ${key}`);
  }
  return results.find((result) => {
    const geojson = result?.geojson;
    return geojson && ['Polygon', 'MultiPolygon'].includes(geojson.type);
  });
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'worldmonitor-city-boundary-fetcher/1.0 (https://github.com/worldmonitor/worldmonitor)',
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Fetch failed ${response.status}: ${response.statusText}`);
  }

  return await response.json();
}

function normalizeFeature(feature, key, cityName, country) {
  if (!feature || !feature.geojson) {
    throw new Error(`Missing geojson for ${cityName}`);
  }

  const { geojson } = feature;
  if (!['Polygon', 'MultiPolygon'].includes(geojson.type)) {
    throw new Error(`Unexpected geojson type ${geojson.type} for ${cityName}`);
  }

  return {
    type: 'Feature',
    properties: {
      city: cityName,
      country,
    },
    geometry: geojson,
  };
}

async function main() {
  const cityFeatures = {};
  for (const { key, queries, country } of CITY_QUERIES) {
    console.log(`Fetching boundary for ${key}...`);
    let feature = null;
    for (const query of queries) {
      console.log(`  trying query: ${query}`);
      const url = new URL('https://nominatim.openstreetmap.org/search');
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      url.searchParams.set('polygon_geojson', '1');
      url.searchParams.set('limit', '10');
      url.searchParams.set('addressdetails', '0');

      const results = await getJson(url.toString());
      if (!Array.isArray(results) || results.length === 0) {
        continue;
      }

      const candidate = findPolygonFeature(results, key);
      if (candidate) {
        feature = normalizeFeature(candidate, key, titleCase(key), country);
        break;
      }
      await sleep(500);
    }

    if (!feature) {
      throw new Error(`No polygon boundary found for ${key}`);
    }

    cityFeatures[key] = feature;
    await sleep(1100);
  }

  const tsSource = `export const CITY_BOUNDARIES: Record<string, GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>> = ${toTsLiteral(cityFeatures, 2)};\n`;
  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, tsSource, 'utf8');
  console.log(`Wrote ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
