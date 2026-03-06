/**
 * Fetches GPS/GNSS interference data from Wingbits API.
 * Filters to medium/high interference hexes, adds lat/lon, writes to Redis.
 *
 * Run:   node scripts/fetch-gpsjam.mjs [--output path.json]
 * Cron:  Every 1-6 hours (data updates continuously).
 *
 * Requires: WINGBITS_API_KEY, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 */

import { cellToLatLng } from 'h3-js';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, 'data');

const REDIS_KEY = 'intelligence:gpsjam:v2';
const REDIS_TTL = 86400; // 24 hours

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const outputPath = getArg('output', null);

// ---------------------------------------------------------------------------
// Env helpers
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

// ---------------------------------------------------------------------------
// Wingbits fetch
// ---------------------------------------------------------------------------
const NP_HIGH = 0.5;
const NP_MEDIUM = 1.0;

async function fetchFromWingbits() {
  const apiKey = process.env.WINGBITS_API_KEY;
  if (!apiKey) throw new Error('WINGBITS_API_KEY not set');

  console.error(`[gpsjam] Fetching from Wingbits API...`);

  const resp = await fetch('https://customer-api.wingbits.com/v1/gps/jam', {
    headers: { 'x-api-key': apiKey, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`Wingbits GPS HTTP ${resp.status}`);

  const body = await resp.json();
  if (!body.hexes || !Array.isArray(body.hexes)) throw new Error('Unexpected response shape: missing hexes array');

  const hexes = [];
  for (const h of body.hexes) {
    const np = h.npAvg;
    let level;
    if (np <= NP_HIGH) level = 'high';
    else if (np <= NP_MEDIUM) level = 'medium';
    else continue;

    try {
      const [lat, lon] = cellToLatLng(h.h3Index);
      hexes.push({
        h3: h.h3Index,
        lat: Math.round(lat * 1e5) / 1e5,
        lon: Math.round(lon * 1e5) / 1e5,
        level,
        npAvg: np,
        sampleCount: h.sampleCount,
        aircraftCount: h.aircraftCount,
      });
    } catch { /* skip invalid hex */ }
  }

  return {
    hexes,
    lastUpdated: body.lastUpdated || new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------
async function seedRedis(output) {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!redisUrl || !redisToken) {
    console.error('[gpsjam] No UPSTASH_REDIS_REST_URL/TOKEN — skipping Redis seed');
    return;
  }

  console.error(`[gpsjam] Seeding Redis key "${REDIS_KEY}"...`);
  console.error(`[gpsjam]   URL:   ${redisUrl}`);
  console.error(`[gpsjam]   Token: ${maskToken(redisToken)}`);

  const body = JSON.stringify(['SET', REDIS_KEY, JSON.stringify(output), 'EX', String(REDIS_TTL)]);
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
      console.error(`[gpsjam] Verified: ${parsed.hexes?.length} hexes in Redis`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  loadEnvFile();

  const data = await fetchFromWingbits();
  const highCount = data.hexes.filter(h => h.level === 'high').length;
  console.error(`[gpsjam] Fetched ${data.hexes.length} hexes (${highCount} high, ${data.hexes.length - highCount} medium)`);

  if (outputPath) {
    mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    writeFileSync(path.resolve(outputPath), JSON.stringify(data, null, 2));
    console.error(`[gpsjam] Written to ${outputPath}`);
  } else {
    mkdirSync(DATA_DIR, { recursive: true });
    const defaultPath = path.join(DATA_DIR, 'gpsjam-latest.json');
    writeFileSync(defaultPath, JSON.stringify(data, null, 2));
    console.error(`[gpsjam] Written to ${defaultPath}`);
    process.stdout.write(JSON.stringify(data));
  }

  await seedRedis(data);
}

main().catch(err => {
  console.error(`[gpsjam] Fatal: ${err.message}`);
  process.exit(1);
});
