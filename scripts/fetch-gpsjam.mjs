/**
 * Fetches GPS/GNSS interference data from gpsjam.org.
 * Outputs medium & high interference hexagons with lat/lon centroids.
 *
 * Data source: gpsjam.org (ADS-B Exchange derived)
 * Format: H3 resolution-4 hexagons with good/bad aircraft counts.
 * Levels: Low (0-2%), Medium (2-10%), High (>10%) of aircraft with GPS issues.
 *
 * Run:   node scripts/fetch-gpsjam.mjs [--date YYYY-MM-DD] [--min-aircraft 3] [--output path.json]
 * Cron:  Can be called daily; data updates once per day.
 */

import { cellToLatLng } from 'h3-js';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, 'data');

const REDIS_KEY = 'intelligence:gpsjam:v1';
const BASE_URL = 'https://gpsjam.org/data';
const UA = 'Mozilla/5.0 (compatible; WorldMonitor/1.0)';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const requestedDate = getArg('date', null);
const minAircraft = parseInt(getArg('min-aircraft', '3'), 10);
const outputPath = getArg('output', null);

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------
async function fetchText(url) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Encoding': 'gzip, deflate',
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.text();
}

// ---------------------------------------------------------------------------
// Get latest available date from manifest
// ---------------------------------------------------------------------------
async function getLatestDate() {
  const csv = await fetchText(`${BASE_URL}/manifest.csv`);
  const lines = csv.trim().split('\n');
  // Last line: date,suspect,num_bad_aircraft_hexes
  const last = lines[lines.length - 1];
  return last.split(',')[0];
}

// ---------------------------------------------------------------------------
// Fetch & parse hex data
// ---------------------------------------------------------------------------
async function fetchHexData(date) {
  const url = `${BASE_URL}/${date}-h3_4.csv`;
  console.error(`[gpsjam] Fetching ${url}`);
  const csv = await fetchText(url);
  const lines = csv.trim().split('\n');
  const header = lines[0]; // hex,count_good_aircraft,count_bad_aircraft
  if (!header.includes('hex')) throw new Error(`Unexpected CSV header: ${header}`);

  const results = [];
  let skippedLowSample = 0;
  let skippedLow = 0;

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 3) continue;

    const hex = parts[0];
    const good = parseInt(parts[1], 10);
    const bad = parseInt(parts[2], 10);
    const total = good + bad;

    // Skip hexes with too few aircraft (noisy data)
    if (total < minAircraft) { skippedLowSample++; continue; }

    const pct = (bad / total) * 100;

    let level;
    if (pct > 10) level = 'high';
    else if (pct >= 2) level = 'medium';
    else { skippedLow++; continue; }

    // H3 hex → lat/lon centroid
    let lat, lon;
    try {
      const [lt, ln] = cellToLatLng(hex);
      lat = Math.round(lt * 1e5) / 1e5;
      lon = Math.round(ln * 1e5) / 1e5;
    } catch {
      continue; // invalid hex
    }

    results.push({
      h3: hex,
      lat,
      lon,
      level,
      pct: Math.round(pct * 10) / 10,
      good,
      bad,
      total,
    });
  }

  // Sort: high first, then by interference % descending
  results.sort((a, b) => {
    if (a.level !== b.level) return a.level === 'high' ? -1 : 1;
    return b.pct - a.pct;
  });

  return { results, skippedLowSample, skippedLow, totalRows: lines.length - 1 };
}

// ---------------------------------------------------------------------------
// Country lookup (approximate, from lat/lon → nearest known region)
// ---------------------------------------------------------------------------
function classifyRegion(lat, lon) {
  // Rough bounding boxes for conflict-relevant regions
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

// ---------------------------------------------------------------------------
// Env + Redis helpers (pattern from seed-iran-events.mjs)
// ---------------------------------------------------------------------------
function loadEnvFile() {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

function maskToken(token) {
  if (!token || token.length < 8) return '***';
  return token.slice(0, 4) + '***' + token.slice(-4);
}

async function seedRedis(output) {
  loadEnvFile();
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!redisUrl || !redisToken) {
    console.error('[gpsjam] No UPSTASH_REDIS_REST_URL/TOKEN — skipping Redis seed');
    return;
  }

  console.error(`[gpsjam] Seeding Redis key "${REDIS_KEY}"...`);
  console.error(`[gpsjam]   URL:   ${redisUrl}`);
  console.error(`[gpsjam]   Token: ${maskToken(redisToken)}`);

  const body = JSON.stringify(['SET', REDIS_KEY, JSON.stringify(output)]);
  const resp = await fetch(redisUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${redisToken}`,
      'Content-Type': 'application/json',
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    console.error(`[gpsjam] Redis SET failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
    return;
  }

  const result = await resp.json();
  console.error(`[gpsjam] Redis SET result:`, result);

  const getResp = await fetch(`${redisUrl}/get/${encodeURIComponent(REDIS_KEY)}`, {
    headers: { Authorization: `Bearer ${redisToken}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (getResp.ok) {
    const getData = await getResp.json();
    if (getData.result) {
      const parsed = JSON.parse(getData.result);
      console.error(`[gpsjam] Verified: ${parsed.hexes?.length} hexes in Redis (date: ${parsed.date})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const date = requestedDate || await getLatestDate();
  console.error(`[gpsjam] Date: ${date}, min aircraft: ${minAircraft}`);

  const { results, skippedLowSample, skippedLow, totalRows } = await fetchHexData(date);

  const highCount = results.filter(r => r.level === 'high').length;
  const mediumCount = results.filter(r => r.level === 'medium').length;

  // Add region tags
  for (const r of results) {
    r.region = classifyRegion(r.lat, r.lon);
  }

  const output = {
    date,
    fetchedAt: new Date().toISOString(),
    source: 'gpsjam.org',
    attribution: 'Data derived from ADS-B Exchange via gpsjam.org',
    minAircraftThreshold: minAircraft,
    stats: {
      totalHexes: totalRows,
      mediumCount,
      highCount,
      skippedLowSample,
      skippedLow,
    },
    hexes: results,
  };

  console.error(`[gpsjam] ${totalRows} total hexes → ${highCount} high, ${mediumCount} medium (skipped: ${skippedLowSample} low-sample, ${skippedLow} low-interference)`);

  if (outputPath) {
    mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    writeFileSync(path.resolve(outputPath), JSON.stringify(output, null, 2));
    console.error(`[gpsjam] Written to ${outputPath}`);
  } else {
    // Default: write to scripts/data/gpsjam-latest.json and also stdout
    mkdirSync(DATA_DIR, { recursive: true });
    const defaultPath = path.join(DATA_DIR, 'gpsjam-latest.json');
    writeFileSync(defaultPath, JSON.stringify(output, null, 2));
    console.error(`[gpsjam] Written to ${defaultPath}`);
    // Also output to stdout for piping
    process.stdout.write(JSON.stringify(output));
  }

  await seedRedis(output);
}

main().catch(err => {
  console.error(`[gpsjam] Fatal: ${err.message}`);
  process.exit(1);
});
