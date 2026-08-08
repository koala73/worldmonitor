// Pure gpsjam.org CSV parser, extracted from fetch-gpsjam.mjs so it can be
// unit-tested without running the seeder's main()/network path.

import { cellToLatLng, isValidCell } from 'h3-js';

export function classifyRegion(lat, lon) {
  if (lat >= 29 && lat <= 42 && lon >= 43 && lon <= 63) return 'iran-iraq';
  if (lat >= 31 && lat <= 37 && lon >= 35 && lon <= 43) return 'levant';
  if (lat >= 28 && lat <= 34 && lon >= 29 && lon <= 36) return 'israel-sinai';
  if (lat >= 44 && lat <= 53 && lon >= 22 && lon <= 41) return 'ukraine-russia';
  if (lat >= 54 && lat <= 70 && lon >= 27 && lon <= 60) return 'russia-north';
  if (lat >= 36 && lat <= 42 && lon >= 26 && lon <= 45) return 'turkey-caucasus';
  if (lat >= 32 && lat <= 38 && lon >= 63 && lon <= 75) return 'afghanistan-pakistan';
  if (lat >= 10 && lat <= 20 && lon >= 42 && lon <= 55) return 'yemen-horn';
  if (lat >= 0 && lat <= 12 && lon >= 32 && lon <= 48) return 'east-africa';
  if (lat >= 15 && lat <= 24 && lon >= 25 && lon <= 40) return 'sudan-sahel';
  if (lat >= 50 && lat <= 72 && lon >= -10 && lon <= 25) return 'northern-europe';
  if (lat >= 35 && lat <= 50 && lon >= -10 && lon <= 25) return 'western-europe';
  if (lat >= 1 && lat <= 8 && lon >= 95 && lon <= 108) return 'southeast-asia';
  if (lat >= 20 && lat <= 45 && lon >= 100 && lon <= 145) return 'east-asia';
  if (lat >= 25 && lat <= 50 && lon >= -125 && lon <= -65) return 'north-america';
  return 'other';
}

// Daily H3 res-4 CSV → medium/high hexes in the v2 shape the consumers read.
export function processHexes(csv, minAircraft = 3) {
  // Coalesce an invalid threshold (e.g. NaN from a bad --min-aircraft) to 3.
  // `total < NaN` is always false, which would silently disable the low-sample filter.
  const minAir = Number.isFinite(minAircraft) && minAircraft > 0 ? minAircraft : 3;
  const lines = csv.trim().split('\n');
  const header = lines[0]; // hex,count_good_aircraft,count_bad_aircraft
  if (!header.includes('hex')) throw new Error(`Unexpected CSV header: ${header}`);

  const results = [];
  let skippedLowSample = 0;
  let skippedLow = 0;
  // h3Attempts counts ONLY the rows that survive the minAircraft + interference
  // filters and actually reach cellToLatLng — the correct denominator for the
  // corruption guard. Comparing failures against all CSV rows (lines.length-1)
  // made the guard unreachable: only ~4% of rows ever attempt H3 conversion.
  let h3Attempts = 0;
  let h3Failures = 0;

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 3) continue;

    const hex = parts[0];
    const good = parseInt(parts[1], 10);
    const bad = parseInt(parts[2], 10);
    if (!Number.isFinite(good) || !Number.isFinite(bad)) continue;
    const total = good + bad;

    if (total < minAir) { skippedLowSample++; continue; }

    const pctRaw = (bad / total) * 100;
    let level;
    if (pctRaw > 10) level = 'high';
    else if (pctRaw >= 2) level = 'medium';
    else { skippedLow++; continue; }

    h3Attempts++;
    // h3-js cellToLatLng silently returns a bogus centroid for non-hex garbage
    // (it only throws on hex-parseable-but-invalid cells), so validate first —
    // otherwise corrupt rows seed as fake hexes at a fixed location AND never
    // register as failures, defeating the abort guard below.
    if (!isValidCell(hex)) { h3Failures++; continue; }
    let lat, lon;
    try {
      const [lt, ln] = cellToLatLng(hex);
      lat = Math.round(lt * 1e5) / 1e5;
      lon = Math.round(ln * 1e5) / 1e5;
    } catch {
      h3Failures++;
      continue;
    }

    const pct = Math.round(pctRaw * 10) / 10;
    results.push({
      h3: hex,
      lat,
      lon,
      level,
      region: classifyRegion(lat, lon),
      // Web-UI fields (api/gpsjam.js → gps-interference.ts): the honest gpsjam.org metric.
      pct,
      affectedAircraft: bad,
      totalAircraft: total,
      // Public-API compat: list-gps-interference.ts + gps_jamming.proto still expose
      // np_avg/sample_count/aircraft_count. Keep that contract stable (no proto regen)
      // by carrying them here. np_avg has no gpsjam.org equivalent, so it's a pct-bucketed
      // proxy — same mapping api/gpsjam.js already uses for the v1 fallback.
      npAvg: pctRaw > 10 ? 0.3 : pctRaw >= 2 ? 0.8 : 1.5,
      sampleCount: bad,
      aircraftCount: total,
    });
  }

  // Abort if a majority of ATTEMPTED conversions failed — a real upstream
  // format/precision break, not a handful of bad hexes. Guarded on h3Attempts>0
  // so an all-low-interference day doesn't divide-by-zero into a false abort.
  if (h3Attempts > 0 && h3Failures > h3Attempts * 0.5) {
    throw new Error(`>50% of attempted hexes failed h3 conversion (${h3Failures}/${h3Attempts}) — aborting seed`);
  }

  // High first, then by interference % descending (worst first).
  results.sort((a, b) => {
    if (a.level !== b.level) return a.level === 'high' ? -1 : 1;
    return b.pct - a.pct;
  });

  return { results, skippedLowSample, skippedLow, h3Attempts, h3Failures, totalRows: lines.length - 1 };
}
