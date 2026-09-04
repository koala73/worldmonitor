#!/usr/bin/env node

// Railway service config (set up manually via Railway dashboard or `railway service`):
//   - Service name: seed-fire-detections
//   - Builder: NIXPACKS (root Dockerfile not used for this seed)
//   - rootDirectory: scripts
//   - startCommand: node seed-fire-detections.mjs
//   - Cron schedule: "*/10 * * * *" (every 10min UTC)

import { loadEnvFile, runSeed, CHROME_UA, sleep, MAX_PAYLOAD_BYTES } from './_seed-utils.mjs';
import { buildEnvelope } from './_seed-envelope-source.mjs';
import { compactWildfireDashboardPayload, WILDFIRE_CANONICAL_DETECTION_LIMIT } from './_wildfire-dashboard.mjs';
import {
  fetchCwfisFires,
} from './wildfire/cwfis-wfs.mjs';
import {
  canadianWildfireAfterPublish,
  fetchBcFirePoints,
  mergeWildfireSourcesWithBc,
} from './wildfire/bc-fire-points.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'wildfire:fires:v1';
const BOOTSTRAP_KEY = 'wildfire:fires-bootstrap:v1';
const FIRMS_SOURCES = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT'];

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

async function fetchRegionSource(apiKey, regionName, bbox, source) {
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${apiKey}/${source}/${bbox}/1`;
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'text/csv', 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`FIRMS ${res.status} for ${regionName}/${source}`);
      return parseCSV(await res.text());
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await sleep(6_000); // match inter-call pacing so retry stays within FIRMS 10 req/min budget
    }
  }
  throw lastErr;
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
          const brightness = parseFloat(row.bright_ti4 ?? '0') || 0;
          const frp = parseFloat(row.frp ?? '0') || 0;
          fireDetections.push({
            id,
            location: {
              latitude: parseFloat(row.latitude ?? '0') || 0,
              longitude: parseFloat(row.longitude ?? '0') || 0,
            },
            brightness,
            frp,
            confidence: mapConfidence(row.confidence || ''),
            satellite: row.satellite || '',
            detectedAt,
            region: regionName,
            dayNight: row.daynight || '',
            possibleExplosion: frp > 80 && brightness > 380,
            source: 'firms',
            kind: 'active',
            emergency: true,
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

  // Surface the per-call outcome, don't just log it. Every throw above is
  // caught inside the loop, so this function has NO rejection path: a total
  // FIRMS outage (expired key, NASA 5xx, rate-limit block) returns exactly
  // like a genuinely empty window. Without these counters the merge grades
  // FIRMS 'ok' on promise settlement alone and republishes the canonical
  // WORLDWIDE key as Canada-only, which every downstream content clock then
  // reads as healthy. See #7141 follow-up.
  return { fireDetections, pagination: undefined, _firmsFulfilledCalls: fulfilled, _firmsFailedCalls: failed };
}

export function declareRecords(data) {
  return Array.isArray(data?.fireDetections) ? data.fireDetections.length : 0;
}

// Bound the canonical payload before it reaches atomicPublish (#5866). FIRMS detection volume
// is seasonal and unbounded: on 2026-07-30 a clean run (27/27 sources ok, zero upstream
// failures) accumulated 20,442 detections, serialized to 5.2MB, and atomicPublish hard-threw
// above its 5MB cap. That throw escapes to main().catch — exit 1, nothing published, TTL not
// extended — so the deliberately short 2h TTL below then blanked the panel.
//
// Ranking is the dashboard comparator (possibleExplosion -> confidence -> brightness -> frp ->
// detectedAt), so what gets dropped is always the lowest-signal tail, and the real FIRMS count
// survives in `pagination.totalCount`.
const CANONICAL_SOURCE_VERSION = `${FIRMS_SOURCES.join('+')}+cwfis-wfs-v1+bc-wildfire-kml-v1`;

function measureCanonicalPublishBytes(data) {
  return Buffer.byteLength(JSON.stringify(buildEnvelope({
    fetchedAt: Date.now(),
    recordCount: Array.isArray(data?.fireDetections) ? data.fireDetections.length : 0,
    sourceVersion: CANONICAL_SOURCE_VERSION,
    schemaVersion: 1,
    state: 'OK',
    data,
  })), 'utf8');
}

function capCanonicalPayload(data) {
  const capped = compactWildfireDashboardPayload(data, WILDFIRE_CANONICAL_DETECTION_LIMIT, {
    maxBytes: MAX_PAYLOAD_BYTES,
    measureBytes: measureCanonicalPublishBytes,
  });
  // Same reference back = already under the cap (or an unrecognized shape). Never dereference
  // blindly here: a throw inside publishTransform is the exact FATAL this function exists to
  // prevent.
  if (capped === data) return data;
  const total = data.fireDetections.length;
  const kept = capped.fireDetections.length;
  console.log(`  canonical cap: publishing ${kept} of ${total} detections (dropped ${total - kept} lowest-signal to stay under the 5MB publish cap)`);
  return capped;
}

async function fetchMergedWildfires() {
  const apiKey = process.env.NASA_FIRMS_API_KEY || process.env.FIRMS_API_KEY || '';
  const cache = new Map();
  // Missing config is NOT runtime degradation. Without this refusal an absent key
  // reaches mergeWildfireSourcesWithBc, is swallowed by allSettled, and silently
  // republishes the canonical worldwide key as Canada-only on every tick.
  // Let a live FIRMS outage degrade; never let a misconfigured deploy do it.
  if (!apiKey) {
    console.error('[seed-fire-detections] NASA_FIRMS_API_KEY (or FIRMS_API_KEY) is required but not set. Refusing to run.');
    process.exit(1);
  }
  console.log('  FIRMS key configured');
  return mergeWildfireSourcesWithBc({
    fetchFirms: async () => fetchAllRegions(apiKey),
    fetchCwfis: () => fetchCwfisFires({ fetchFn: globalThis.fetch, cache }),
    fetchBcWildfire: () => fetchBcFirePoints({ fetchFn: globalThis.fetch, cache }),
  });
}

async function main() {
  await runSeed('wildfire', 'fires', CANONICAL_KEY, fetchMergedWildfires, {
    validateFn: (data) => Array.isArray(data?.fireDetections) && data.fireDetections.length > 0,
    // 2h — deliberately BELOW the 6h health gate (maxStaleMin 360). Do NOT "fix" this
    // by raising it to satisfy tests/seed-ttl-outlives-staleness-fleet: doing so DOWNGRADES
    // a safety alarm. Verified against classifyKey with the seeder dead for 3h:
    //
    //   ttl 2h (this):  wildfires -> EMPTY (crit)   — ops is paged, panel blanks honestly
    //   ttl 7h:         wildfires -> OK    (green)  — 3h-old fire data served, silently
    //
    // The canonical `wildfires` is NOT in EMPTY_DATA_OK_KEYS, so its key expiring at 2h is
    // exactly what makes a dead fire feed loud. A longer TTL keeps stale data alive past
    // the gate and turns that crit into a warn (and, inside the gate, into a green).
    ttlSeconds: 7200,
    // Applied to the CANONICAL key only. runSeed feeds extraKey transforms the RAW fetcher
    // output, not publishData (scripts/_seed-utils.mjs), so the bootstrap key below still
    // ranks its top-500 over every detection FIRMS returned — capping here cannot change what
    // the dashboard renders. Capping inside fetchAllRegions would not have that property.
    publishTransform: capCanonicalPayload,
    lockTtlMs: 2_400_000, // 40 min — 27 slots × ~72s worst case (30s timeout + 6s backoff + 30s retry + 6s pace) ≈ 32.4 min; pad headroom. Next cron tick sees lock held and safely skips.
    sourceVersion: CANONICAL_SOURCE_VERSION,
    extraKeys: [{
      key: BOOTSTRAP_KEY,
      transform: compactWildfireDashboardPayload,
      declareRecords,
      metaKey: 'seed-meta:wildfire:fires-bootstrap',
    }],
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 360,
    afterPublish: canadianWildfireAfterPublish,
  });
}

main().catch(err => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
