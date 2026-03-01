#!/usr/bin/env node

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const RAW_PATH = join(DATA_DIR, 'osm-military-raw.json');
const PROCESSED_PATH = join(DATA_DIR, 'osm-military-processed.json');

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const OVERPASS_QUERY = `
[out:json][timeout:300];
(
  node["military"]["name"];
  way["military"]["name"];
  relation["military"]["name"];
);
out center tags;
`.trim();

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
    console.log(`Created directory: ${DATA_DIR}`);
  }
}

async function fetchOverpassData() {
  console.log('Querying Overpass API for military features with names...');
  console.log(`Query:\n${OVERPASS_QUERY}\n`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(OVERPASS_QUERY)}`,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Overpass API returned ${res.status}: ${text.slice(0, 500)}`);
    }

    console.log('Response received, reading body...');
    const json = await res.json();
    return json;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error('Overpass API request timed out after 5 minutes');
    }
    throw err;
  }
}

function processFeatures(raw) {
  const elements = raw.elements || [];
  console.log(`Raw elements count: ${elements.length}`);

  const processed = elements.map((el) => {
    const tags = el.tags || {};

    // Coordinates: nodes have lat/lon directly; ways/relations use center
    const lat = el.lat ?? el.center?.lat ?? null;
    const lon = el.lon ?? el.center?.lon ?? null;

    const typePrefix = el.type; // node, way, relation
    const osmId = `${typePrefix}/${el.id}`;

    const name = tags['name:en'] || tags.name || '';
    const country = tags['addr:country'] || '';
    const kind = tags.military || '';
    const operator = tags.operator || '';
    const description = tags.description || '';
    const militaryBranch = tags.military_branch || '';

    return {
      osm_id: osmId,
      name,
      country,
      kind,
      lat,
      lon,
      operator,
      description,
      military_branch: militaryBranch,
    };
  });

  // Filter out entries without coordinates
  const withCoords = processed.filter((f) => f.lat != null && f.lon != null);
  const skipped = processed.length - withCoords.length;
  if (skipped > 0) {
    console.log(`Skipped ${skipped} features without coordinates`);
  }

  return withCoords;
}

function printSummary(features) {
  console.log(`\n--- Summary ---`);
  console.log(`Total processed features: ${features.length}`);

  // Count by kind
  const kindCounts = {};
  for (const f of features) {
    kindCounts[f.kind] = (kindCounts[f.kind] || 0) + 1;
  }
  console.log('\nBy military tag value:');
  const sorted = Object.entries(kindCounts).sort((a, b) => b[1] - a[1]);
  for (const [kind, count] of sorted) {
    console.log(`  ${kind}: ${count}`);
  }

  // Count with country
  const withCountry = features.filter((f) => f.country).length;
  console.log(`\nFeatures with country tag: ${withCountry}`);

  // Sample entries
  console.log('\nSample entries (first 5):');
  for (const f of features.slice(0, 5)) {
    console.log(`  ${f.osm_id} | ${f.name} | ${f.kind} | ${f.lat?.toFixed(4)},${f.lon?.toFixed(4)} | ${f.country || '(no country)'}`);
  }
}

async function main() {
  const start = Date.now();
  ensureDataDir();

  const raw = await fetchOverpassData();

  // Save raw
  console.log(`Saving raw response to ${RAW_PATH}...`);
  writeFileSync(RAW_PATH, JSON.stringify(raw, null, 2));
  console.log('Raw data saved.');

  // Process
  const features = processFeatures(raw);

  // Save processed
  console.log(`Saving processed data to ${PROCESSED_PATH}...`);
  writeFileSync(PROCESSED_PATH, JSON.stringify(features, null, 2));
  console.log('Processed data saved.');

  printSummary(features);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s`);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
