#!/usr/bin/env node
/**
 * Fetches Pakistan's boundary from Natural Earth 50m Admin 0 Countries and writes
 * public/data/country-boundary-overrides.geojson.
 *
 * Note: downloads the full NE 50m countries file (~24 MB) to extract Pakistan.
 *
 * Usage: node scripts/fetch-pakistan-boundary-override.mjs
 * Requires network access.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NE_50M_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson';
const OUT_DIR = join(__dirname, '..', 'public', 'data');
const OUT_FILE = join(OUT_DIR, 'country-boundary-overrides.geojson');

async function main() {
  console.log('Fetching Natural Earth 50m countries...');
  const resp = await fetch(NE_50M_URL, { signal: AbortSignal.timeout(60_000) });
  if (!resp.ok) {
    throw new Error(`Fetch failed: ${resp.status} ${resp.statusText}`);
  }
  const data = await resp.json();
  if (!data?.features?.length) {
    throw new Error('Invalid GeoJSON: no features');
  }
  const pak = data.features.find((f) => f.properties?.ISO_A2 === 'PK' || f.properties?.['ISO3166-1-Alpha-2'] === 'PK');
  if (!pak) {
    throw new Error('Pakistan (PK) feature not found in Natural Earth data');
  }
  const override = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          name: 'Pakistan',
          'ISO3166-1-Alpha-2': 'PK',
          'ISO3166-1-Alpha-3': 'PAK',
        },
        geometry: pak.geometry,
      },
    ],
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(override) + '\n', 'utf8');
  console.log('Wrote', OUT_FILE);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
