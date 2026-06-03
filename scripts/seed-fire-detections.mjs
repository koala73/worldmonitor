#!/usr/bin/env node

import { loadEnvFile, maskToken, runSeed, CHROME_UA, sleep } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'wildfire:fires:v1';
const FIRMS_SOURCES = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT'];

// FIRMS area API day range (1–10, max). Small focused boxes use the full
// window; large continental boxes use a shorter window so a single 10-day
// continental CSV (hundreds of MB in peak fire season) can't blow the request
// timeout / runner memory before the FRP cap applies.
const FOCUSED_DAY_RANGE = 10;
const BROAD_DAY_RANGE = 3;
const BROAD_REGIONS = new Set([
  'Russia', 'North America', 'South America', 'Africa',
  'Europe', 'South Asia', 'Southeast Asia', 'Australia',
]);
const dayRangeFor = (regionName) =>
  BROAD_REGIONS.has(regionName) ? BROAD_DAY_RANGE : FOCUSED_DAY_RANGE;

// Cap on total detections kept, sorted by fire radiative power (FRP) so the
// most significant fires survive. Bounds the Redis payload well under the 5 MB
// limit even when continental boxes return tens of thousands of rows.
const MAX_DETECTIONS = 6000;

// bbox = west,south,east,north
// First block: focused OSINT/war regions (kept for their specific region labels
// in the Events feed / Overview). Second block: large continental boxes for
// global coverage so fires show worldwide, not just in conflict zones.
const MONITORED_REGIONS = {
  // — Focused OSINT regions —
  'Ukraine': '22,44,40,53',
  'Russia': '20,50,180,82',
  'Iran': '44,25,63,40',
  'Israel/Gaza': '34,29,36,34',
  'Syria': '35,32,42,37',
  'Taiwan': '119,21,123,26',
  'North Korea': '124,37,131,43',
  'Saudi Arabia': '34,16,56,32',
  'Turkey': '26,36,45,42',
  // — Global coverage (continental boxes) —
  'North America': '-168,14,-52,72',
  'South America': '-82,-56,-34,13',
  'Africa': '-18,-35,52,38',
  'Europe': '-11,36,31,60',
  'South Asia': '60,5,90,35',
  'Southeast Asia': '95,-11,141,21',
  'Australia': '112,-44,154,-10',
};

function mapConfidence(c) {
  switch ((c || '').toLowerCase()) {
    case 'h': return 'FIRE_CONFIDENCE_HIGH';
    case 'n': return 'FIRE_CONFIDENCE_NOMINAL';
    case 'l': return 'FIRE_CONFIDENCE_LOW';
    default: return 'FIRE_CONFIDENCE_UNSPECIFIED';
  }
}

function parseCSV(csv) {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  const results = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',').map(v => v.trim());
    if (vals.length < headers.length) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = vals[idx]; });
    results.push(row);
  }
  return results;
}

function parseDetectedAt(acqDate, acqTime) {
  const padded = (acqTime || '').padStart(4, '0');
  const hours = padded.slice(0, 2);
  const minutes = padded.slice(2);
  return new Date(`${acqDate}T${hours}:${minutes}:00Z`).getTime();
}

async function fetchRegionSource(apiKey, regionName, bbox, source) {
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${apiKey}/${source}/${bbox}/${dayRangeFor(regionName)}`;
  const res = await fetch(url, {
    headers: { Accept: 'text/csv', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`FIRMS ${res.status} for ${regionName}/${source}`);
  const csv = await res.text();
  return parseCSV(csv);
}

async function fetchAllRegions(apiKey) {
  const entries = Object.entries(MONITORED_REGIONS);
  const seen = new Set();
  const fireDetections = [];
  let fulfilled = 0;
  let failed = 0;

  for (const source of FIRMS_SOURCES) {
    for (const [regionName, bbox] of entries) {
      try {
        const rows = await fetchRegionSource(apiKey, regionName, bbox, source);
        fulfilled++;
        for (const row of rows) {
          const id = `${row.latitude ?? ''}-${row.longitude ?? ''}-${row.acq_date ?? ''}-${row.acq_time ?? ''}`;
          if (seen.has(id)) continue;
          seen.add(id);
          const detectedAt = parseDetectedAt(row.acq_date || '', row.acq_time || '');
          fireDetections.push({
            id,
            location: {
              latitude: parseFloat(row.latitude ?? '0') || 0,
              longitude: parseFloat(row.longitude ?? '0') || 0,
            },
            brightness: parseFloat(row.bright_ti4 ?? '0') || 0,
            frp: parseFloat(row.frp ?? '0') || 0,
            confidence: mapConfidence(row.confidence || ''),
            satellite: row.satellite || '',
            detectedAt,
            region: regionName,
            dayNight: row.daynight || '',
          });
        }
      } catch (err) {
        failed++;
        console.error(`  [FIRMS] ${source}/${regionName}: ${err.message || err}`);
      }
      await sleep(6_000); // FIRMS free tier: 10 req/min — 6s between calls stays safely under limit
    }
    console.log(`  ${source}: ${fireDetections.length} total (${fulfilled} ok, ${failed} failed)`);
  }

  // Keep the most significant fires (highest FRP) so the payload stays bounded.
  if (fireDetections.length > MAX_DETECTIONS) {
    fireDetections.sort((a, b) => (b.frp || 0) - (a.frp || 0));
    fireDetections.length = MAX_DETECTIONS;
    console.log(`  Capped to top ${MAX_DETECTIONS} by FRP`);
  }

  return { fireDetections, pagination: undefined };
}

async function main() {
  const apiKey = process.env.NASA_FIRMS_API_KEY || process.env.FIRMS_API_KEY || '';
  if (!apiKey) {
    console.log('NASA_FIRMS_API_KEY not set — skipping fire detections seed');
    process.exit(0);
  }

  console.log(`  FIRMS key: ${maskToken(apiKey)}`);

  await runSeed('wildfire', 'fires', CANONICAL_KEY, () => fetchAllRegions(apiKey), {
    validateFn: (data) => Array.isArray(data?.fireDetections) && data.fireDetections.length > 0,
    ttlSeconds: 7200,
    lockTtlMs: 1_200_000, // 20 min — 48 calls (16 regions × 3 sources) × (6s pace + up to 30s timeout)
    sourceVersion: FIRMS_SOURCES.join('+'),
  });
}

main().catch(err => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
