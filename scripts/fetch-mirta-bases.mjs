#!/usr/bin/env node
/**
 * Fetch MIRTA (Military Installations, Ranges and Training Areas) dataset
 * from the US Army Corps of Engineers ArcGIS FeatureServer.
 *
 * Source: https://geospatial-usace.opendata.arcgis.com/maps/fc0f38c5a19a46dbacd92f2fb823ef8c
 * API:    https://services7.arcgis.com/n1YM8pTrFmm7L4hs/arcgis/rest/services/mirta/FeatureServer
 *
 * Layers:
 *   0 = DoD Sites - Point   (737 features)
 *   1 = DoD Sites - Boundary (825 features, polygons)
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, 'data');
mkdirSync(DATA_DIR, { recursive: true });

const BASE = 'https://services7.arcgis.com/n1YM8pTrFmm7L4hs/arcgis/rest/services/mirta/FeatureServer';
const PAGE_SIZE = 1000; // server maxRecordCount

// ---------------------------------------------------------------------------
// Branch / component mapping
// ---------------------------------------------------------------------------
const BRANCH_MAP = {
  usa: 'Army',
  usar: 'Army Reserve',
  armynationalguard: 'Army National Guard',
  usaf: 'Air Force',
  afr: 'Air Force Reserve',
  airnationalguard: 'Air National Guard',
  usmc: 'Marine Corps',
  usmcr: 'Marine Corps Reserve',
  usn: 'Navy',
  usnr: 'Navy Reserve',
  whs: 'Washington Headquarters Services',
  other: 'Other',
};

const COMPONENT_MAP = {
  usa: 'Active',
  usar: 'Reserve',
  armynationalguard: 'National Guard',
  usaf: 'Active',
  afr: 'Reserve',
  airnationalguard: 'National Guard',
  usmc: 'Active',
  usmcr: 'Reserve',
  usn: 'Active',
  usnr: 'Reserve',
  whs: 'Active',
  other: 'Unknown',
};

const STATUS_MAP = {
  act: 'Active',
  clsd: 'Closed',
  semi: 'Semi-Active',
  care: 'Caretaker',
  excs: 'Excess',
};

const STATE_MAP = {
  al: 'Alabama', ak: 'Alaska', az: 'Arizona', ar: 'Arkansas', ca: 'California',
  co: 'Colorado', ct: 'Connecticut', de: 'Delaware', fl: 'Florida', ga: 'Georgia',
  hi: 'Hawaii', id: 'Idaho', il: 'Illinois', in: 'Indiana', ia: 'Iowa',
  ks: 'Kansas', ky: 'Kentucky', la: 'Louisiana', me: 'Maine', md: 'Maryland',
  ma: 'Massachusetts', mi: 'Michigan', mn: 'Minnesota', ms: 'Mississippi',
  mo: 'Missouri', mt: 'Montana', ne: 'Nebraska', nv: 'Nevada', nh: 'New Hampshire',
  nj: 'New Jersey', nm: 'New Mexico', ny: 'New York', nc: 'North Carolina',
  nd: 'North Dakota', oh: 'Ohio', ok: 'Oklahoma', or: 'Oregon', pa: 'Pennsylvania',
  ri: 'Rhode Island', sc: 'South Carolina', sd: 'South Dakota', tn: 'Tennessee',
  tx: 'Texas', ut: 'Utah', vt: 'Vermont', va: 'Virginia', wa: 'Washington',
  wv: 'West Virginia', wi: 'Wisconsin', wy: 'Wyoming', dc: 'District of Columbia',
  pr: 'Puerto Rico', gu: 'Guam', vi: 'Virgin Islands', as: 'American Samoa',
  mp: 'Northern Mariana Islands',
};

// ---------------------------------------------------------------------------
// Paginated ArcGIS fetch
// ---------------------------------------------------------------------------
async function fetchAllFeatures(layerIndex) {
  let offset = 0;
  let page = 0;
  const allFeatures = [];
  let exceeded = true;

  while (exceeded) {
    page++;
    const params = new URLSearchParams({
      where: '1=1',
      outFields: '*',
      f: 'geojson',
      resultRecordCount: String(PAGE_SIZE),
      resultOffset: String(offset),
    });
    const url = `${BASE}/${layerIndex}/query?${params}`;
    console.log(`  Page ${page}: offset=${offset} ...`);

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    const json = await resp.json();

    const features = json.features || [];
    allFeatures.push(...features);
    console.log(`  Page ${page}: got ${features.length} features (total so far: ${allFeatures.length})`);

    exceeded = json.properties?.exceededTransferLimit === true;
    offset += PAGE_SIZE;
  }

  return {
    type: 'FeatureCollection',
    features: allFeatures,
  };
}

// ---------------------------------------------------------------------------
// Centroid of a polygon (simple average of all coordinates)
// ---------------------------------------------------------------------------
function centroid(geometry) {
  if (!geometry) return { lat: null, lon: null };

  if (geometry.type === 'Point') {
    return { lon: geometry.coordinates[0], lat: geometry.coordinates[1] };
  }

  let rings;
  if (geometry.type === 'Polygon') {
    rings = geometry.coordinates;
  } else if (geometry.type === 'MultiPolygon') {
    rings = geometry.coordinates.flat();
  } else {
    return { lat: null, lon: null };
  }

  let sumLon = 0, sumLat = 0, count = 0;
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      sumLon += lon;
      sumLat += lat;
      count++;
    }
  }
  return count > 0
    ? { lon: +(sumLon / count).toFixed(6), lat: +(sumLat / count).toFixed(6) }
    : { lat: null, lon: null };
}

// ---------------------------------------------------------------------------
// Process features into clean records
// ---------------------------------------------------------------------------
function processFeature(feature) {
  const p = feature.properties || {};
  const comp = (p.SITEREPORTINGCOMPONENT || '').toLowerCase().trim();
  const statusRaw = (p.SITEOPERATIONALSTATUS || '').toLowerCase().trim();
  const stateRaw = (p.STATENAMECODE || '').toLowerCase().trim();
  const { lat, lon } = centroid(feature.geometry);

  return {
    name: (p.SITENAME || p.FEATURENAME || '').trim(),
    branch: BRANCH_MAP[comp] || comp || 'Unknown',
    status: STATUS_MAP[statusRaw] || statusRaw || 'Unknown',
    state: STATE_MAP[stateRaw] || stateRaw.toUpperCase() || 'Unknown',
    lat,
    lon,
    kind: (p.FEATUREDESCRIPTION && p.FEATUREDESCRIPTION !== 'na')
      ? p.FEATUREDESCRIPTION
      : 'Installation',
    component: COMPONENT_MAP[comp] || 'Unknown',
    jointBase: p.ISJOINTBASE === 'yes',
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('=== MIRTA Dataset Fetcher ===\n');

  // ---------- Points layer (layer 0) ----------
  console.log('[1/4] Fetching Points layer (layer 0)...');
  const pointsGeoJson = await fetchAllFeatures(0);
  console.log(`  Total point features: ${pointsGeoJson.features.length}\n`);

  // ---------- Boundary layer (layer 1) ----------
  console.log('[2/4] Fetching Boundary layer (layer 1)...');
  const boundaryGeoJson = await fetchAllFeatures(1);
  console.log(`  Total boundary features: ${boundaryGeoJson.features.length}\n`);

  // ---------- Save raw GeoJSON ----------
  console.log('[3/4] Saving raw GeoJSON...');

  const combinedRaw = {
    type: 'FeatureCollection',
    metadata: {
      source: 'MIRTA - Military Installations, Ranges and Training Areas',
      url: 'https://geospatial-usace.opendata.arcgis.com/maps/fc0f38c5a19a46dbacd92f2fb823ef8c',
      fetchedAt: new Date().toISOString(),
      pointFeatures: pointsGeoJson.features.length,
      boundaryFeatures: boundaryGeoJson.features.length,
    },
    features: [
      ...pointsGeoJson.features,
      ...boundaryGeoJson.features,
    ],
  };

  const rawPath = resolve(DATA_DIR, 'mirta-raw.geojson');
  writeFileSync(rawPath, JSON.stringify(combinedRaw, null, 2));
  const rawSizeMB = (Buffer.byteLength(JSON.stringify(combinedRaw)) / 1024 / 1024).toFixed(2);
  console.log(`  Saved ${rawPath} (${rawSizeMB} MB)\n`);

  // ---------- Process into clean records ----------
  console.log('[4/4] Processing into clean records...');

  // Use points layer as primary (has exact coordinates).
  // Supplement with boundary-only entries (those not in points).
  const pointNames = new Set(
    pointsGeoJson.features.map(f => (f.properties?.SITENAME || '').toLowerCase().trim())
  );

  const processed = [];

  for (const f of pointsGeoJson.features) {
    processed.push(processFeature(f));
  }

  let boundaryOnly = 0;
  for (const f of boundaryGeoJson.features) {
    const name = (f.properties?.SITENAME || '').toLowerCase().trim();
    if (!pointNames.has(name)) {
      processed.push(processFeature(f));
      boundaryOnly++;
    }
  }

  // Sort by name
  processed.sort((a, b) => a.name.localeCompare(b.name));

  const output = {
    metadata: {
      source: 'MIRTA - Military Installations, Ranges and Training Areas',
      url: 'https://geospatial-usace.opendata.arcgis.com/maps/fc0f38c5a19a46dbacd92f2fb823ef8c',
      fetchedAt: new Date().toISOString(),
      totalInstallations: processed.length,
      fromPoints: pointsGeoJson.features.length,
      fromBoundariesOnly: boundaryOnly,
    },
    installations: processed,
  };

  const processedPath = resolve(DATA_DIR, 'mirta-processed.json');
  writeFileSync(processedPath, JSON.stringify(output, null, 2));
  const procSizeMB = (Buffer.byteLength(JSON.stringify(output)) / 1024 / 1024).toFixed(2);
  console.log(`  Saved ${processedPath} (${procSizeMB} MB)\n`);

  // ---------- Summary ----------
  console.log('=== Summary ===');
  console.log(`Total installations: ${processed.length}`);
  console.log(`  From points layer: ${pointsGeoJson.features.length}`);
  console.log(`  From boundaries only: ${boundaryOnly}`);

  // Branch breakdown
  const branchCounts = {};
  const statusCounts = {};
  const componentCounts = {};
  for (const inst of processed) {
    branchCounts[inst.branch] = (branchCounts[inst.branch] || 0) + 1;
    statusCounts[inst.status] = (statusCounts[inst.status] || 0) + 1;
    componentCounts[inst.component] = (componentCounts[inst.component] || 0) + 1;
  }

  console.log('\nBy branch:');
  for (const [k, v] of Object.entries(branchCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }

  console.log('\nBy status:');
  for (const [k, v] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }

  console.log('\nBy component:');
  for (const [k, v] of Object.entries(componentCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }

  console.log('\nSample entries:');
  const samples = [processed[0], processed[Math.floor(processed.length / 3)], processed[Math.floor(processed.length * 2 / 3)], processed[processed.length - 1]];
  for (const s of samples) {
    console.log(`  ${s.name} | ${s.branch} | ${s.status} | ${s.state} | (${s.lat}, ${s.lon})`);
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
