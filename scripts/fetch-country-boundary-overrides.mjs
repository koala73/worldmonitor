#!/usr/bin/env node
/**
 * Fetches country boundaries from Natural Earth 50m Admin 0 Countries and writes
 * country-boundary-overrides.geojson locally. After running, upload to R2:
 *   rclone copy public/data/country-boundary-overrides.geojson r2:worldmonitor-maps/
 *
 * Currently extracts: Pakistan (PK), India (IN)
 *
 * Note: downloads the full NE 50m countries file (~24 MB) to extract boundaries.
 *
 * Usage: node scripts/fetch-country-boundary-overrides.mjs
 * Requires network access.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NE_50M_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson';
const OUT_DIR = join(__dirname, '..', 'public', 'data');
const OUT_FILE = join(OUT_DIR, 'country-boundary-overrides.geojson');

/** Countries to extract from Natural Earth and include as boundary overrides. */
const OVERRIDE_COUNTRIES = [
  { iso2: 'PK', iso3: 'PAK', name: 'Pakistan' },
  { iso2: 'IN', iso3: 'IND', name: 'India' },
];

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

  const features = [];
  for (const country of OVERRIDE_COUNTRIES) {
    const feature = data.features.find(
      (f) => f.properties?.ISO_A2 === country.iso2 || f.properties?.['ISO3166-1-Alpha-2'] === country.iso2,
    );
    if (!feature) {
      throw new Error(`${country.name} (${country.iso2}) feature not found in Natural Earth data`);
    }
    features.push({
      type: 'Feature',
      properties: {
        name: country.name,
        'ISO3166-1-Alpha-2': country.iso2,
        'ISO3166-1-Alpha-3': country.iso3,
      },
      geometry: feature.geometry,
    });
    console.log(`Extracted ${country.name} (${country.iso2})`);
  }

  const override = { type: 'FeatureCollection', features };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(override) + '\n', 'utf8');
  console.log('Wrote', OUT_FILE, `(${features.length} countries)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
