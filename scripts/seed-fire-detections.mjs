#!/usr/bin/env node

import { loadEnvFile, maskToken, runSeed, CHROME_UA } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'wildfire:fires:v1';
const FIRMS_SOURCE = 'VIIRS_SNPP_NRT';

const MONITORED_REGIONS = {
  'Ukraine': '22,44,40,53',
  'Russia': '20,50,180,82',
  'Iran': '44,25,63,40',
  'Israel/Gaza': '34,29,36,34',
  'Syria': '35,32,42,37',
  'Taiwan': '119,21,123,26',
  'North Korea': '124,37,131,43',
  'Saudi Arabia': '34,16,56,32',
  'Turkey': '26,36,45,42',
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

async function fetchAllRegions(apiKey) {
  const entries = Object.entries(MONITORED_REGIONS);
  const results = await Promise.allSettled(
    entries.map(async ([regionName, bbox]) => {
      const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${apiKey}/${FIRMS_SOURCE}/${bbox}/1`;
      const res = await fetch(url, {
        headers: { Accept: 'text/csv', 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`FIRMS ${res.status} for ${regionName}`);
      const csv = await res.text();
      const rows = parseCSV(csv);
      return { regionName, rows };
    }),
  );

  const fireDetections = [];
  let fulfilled = 0;
  let failed = 0;

  for (const r of results) {
    if (r.status === 'fulfilled') {
      fulfilled++;
      const { regionName, rows } = r.value;
      for (const row of rows) {
        const detectedAt = parseDetectedAt(row.acq_date || '', row.acq_time || '');
        fireDetections.push({
          id: `${row.latitude ?? ''}-${row.longitude ?? ''}-${row.acq_date ?? ''}-${row.acq_time ?? ''}`,
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
    } else {
      failed++;
      console.error(`  [FIRMS] ${r.reason?.message || r.reason}`);
    }
  }

  console.log(`  Regions: ${fulfilled} ok, ${failed} failed | Detections: ${fireDetections.length}`);
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
    sourceVersion: FIRMS_SOURCE,
  });
}

main().catch(err => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
