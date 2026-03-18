import { cellToLatLng } from 'h3-js';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { extendExistingTtl } from './_seed-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, 'data');

const REDIS_KEY_V2 = 'intelligence:gpsjam:v2';
const REDIS_KEY_V1 = 'intelligence:gpsjam:v1';
const REDIS_TTL = 172800; // 48h

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const outputPath = getArg('output', null);

function classifyRegion(lat, lon) {
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

async function fetchWingbits(apiKey) {
  const url = 'https://customer-api.wingbits.com/v1/gps/jam';
  console.error(`[gpsjam] Fetching ${url}`);

  const resp = await fetch(url, {
    headers: {
      'x-api-key': apiKey,
      'User-Agent': 'WorldMonitor/1.0',
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} from Wingbits API`);
  }

  const body = await resp.json();

  if (!Array.isArray(body.hexes)) {
    throw new Error(`Invalid response: body.hexes is not an array`);
  }

  return body;
}

function processHexes(rawHexes) {
  const results = [];
  let skipped = 0;
  let h3Failures = 0;

  for (const hex of rawHexes) {
    if (typeof hex.h3Index !== 'string') {
      console.error(`[gpsjam] WARN: skipping hex with non-string h3Index: ${JSON.stringify(hex).slice(0, 100)}`);
      skipped++;
      continue;
    }
    if (!Number.isFinite(hex.npAvg)) {
      console.error(`[gpsjam] WARN: skipping hex ${hex.h3Index} — npAvg not finite: ${hex.npAvg}`);
      skipped++;
      continue;
    }
    if (!Number.isInteger(hex.sampleCount) || hex.sampleCount < 0) {
      console.error(`[gpsjam] WARN: skipping hex ${hex.h3Index} — invalid sampleCount: ${hex.sampleCount}`);
      skipped++;
      continue;
    }
    if (!Number.isInteger(hex.aircraftCount) || hex.aircraftCount < 0) {
      console.error(`[gpsjam] WARN: skipping hex ${hex.h3Index} — invalid aircraftCount: ${hex.aircraftCount}`);
      skipped++;
      continue;
    }

    let level;
    if (hex.npAvg <= 0.5) level = 'high';
    else if (hex.npAvg <= 1.0) level = 'medium';
    else continue; // skip low interference

    let lat, lon;
    try {
      const [lt, ln] = cellToLatLng(hex.h3Index);
      lat = Math.round(lt * 1e5) / 1e5;
      lon = Math.round(ln * 1e5) / 1e5;
    } catch {
      console.error(`[gpsjam] WARN: h3 conversion failed for ${hex.h3Index}`);
      h3Failures++;
      continue;
    }

    results.push({
      h3: hex.h3Index,
      lat,
      lon,
      level,
      npAvg: hex.npAvg,
      sampleCount: hex.sampleCount,
      aircraftCount: hex.aircraftCount,
      region: classifyRegion(lat, lon),
    });
  }

  if (h3Failures > rawHexes.length * 0.5) {
    throw new Error(`>50% of hexes failed h3 conversion (${h3Failures}/${rawHexes.length}) — aborting seed`);
  }

  // Sort: high first, then by npAvg ascending (lower = worse)
  results.sort((a, b) => {
    if (a.level !== b.level) return a.level === 'high' ? -1 : 1;
    return a.npAvg - b.npAvg;
  });

  console.error(`[gpsjam] Processed ${rawHexes.length} hexes → ${results.length} kept, ${skipped} invalid, ${h3Failures} h3 failures`);

  return results;
}

async function seedRedis(output) {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!redisUrl || !redisToken) {
    console.error('[gpsjam] No UPSTASH_REDIS_REST_URL/TOKEN — skipping Redis seed');
    return;
  }

  console.error(`[gpsjam] Seeding Redis keys "${REDIS_KEY_V2}" and "${REDIS_KEY_V1}"...`);
  console.error(`[gpsjam]   URL:   ${redisUrl}`);
  console.error(`[gpsjam]   Token: ${maskToken(redisToken)}`);

  const payload = JSON.stringify(output);

  // Write v2
  const v2Body = JSON.stringify(['SET', REDIS_KEY_V2, payload, 'EX', REDIS_TTL]);
  const v2Resp = await fetch(redisUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
    body: v2Body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!v2Resp.ok) {
    const text = await v2Resp.text().catch(() => '');
    console.error(`[gpsjam] Redis SET v2 failed: HTTP ${v2Resp.status} — ${text.slice(0, 200)}`);
    return;
  }
  console.error(`[gpsjam] Redis SET v2 result:`, await v2Resp.json());

  // Dual-write v1 in old schema shape so pre-deploy code can parse it
  const v1Output = {
    ...output,
    source: output.source || 'wingbits',
    hexes: output.hexes.map(hex => ({
      h3: hex.h3,
      lat: hex.lat,
      lon: hex.lon,
      level: hex.level,
      region: hex.region,
      pct: hex.npAvg <= 0.5 ? 15 : hex.npAvg <= 1.0 ? 5 : 0,
      good: Math.max(0, hex.aircraftCount - hex.sampleCount),
      bad: hex.sampleCount,
      total: hex.aircraftCount,
    })),
  };
  const v1Body = JSON.stringify(['SET', REDIS_KEY_V1, JSON.stringify(v1Output), 'EX', REDIS_TTL]);
  const v1Resp = await fetch(redisUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
    body: v1Body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!v1Resp.ok) {
    const text = await v1Resp.text().catch(() => '');
    console.error(`[gpsjam] Redis SET v1 failed: HTTP ${v1Resp.status} — ${text.slice(0, 200)}`);
  } else {
    console.error(`[gpsjam] Redis SET v1 result:`, await v1Resp.json());
  }

  // Verify v2
  const getResp = await fetch(`${redisUrl}/get/${encodeURIComponent(REDIS_KEY_V2)}`, {
    headers: { Authorization: `Bearer ${redisToken}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (getResp.ok) {
    const getData = await getResp.json();
    if (getData.result) {
      const parsed = JSON.parse(getData.result);
      console.error(`[gpsjam] Verified: ${parsed.hexes?.length} hexes in Redis (source: ${parsed.source})`);
    }
  }

  // Write seed-meta
  const metaKey = 'seed-meta:intelligence:gpsjam';
  const meta = { fetchedAt: Date.now(), recordCount: output.hexes?.length || 0 };
  const metaBody = JSON.stringify(['SET', metaKey, JSON.stringify(meta), 'EX', 604800]);
  await fetch(redisUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
    body: metaBody,
    signal: AbortSignal.timeout(5_000),
  }).catch(() => console.error('[gpsjam] seed-meta write failed'));
  console.error(`[gpsjam] Wrote seed-meta: ${metaKey}`);
}

async function main() {
  loadEnvFile();
  const apiKey = process.env.WINGBITS_API_KEY;
  if (!apiKey) {
    console.error('[gpsjam] WINGBITS_API_KEY not set — cannot fetch data');
    process.exit(1);
  }

  let body;
  try {
    body = await fetchWingbits(apiKey);
  } catch (err) {
    console.error(`[gpsjam] Fetch failed: ${err.message} — extending TTL on stale data`);
    await extendExistingTtl([REDIS_KEY_V2, REDIS_KEY_V1, 'seed-meta:intelligence:gpsjam'], REDIS_TTL);
    process.exit(0);
  }

  const hexes = processHexes(body.hexes);

  const highCount = hexes.filter(r => r.level === 'high').length;
  const mediumCount = hexes.filter(r => r.level === 'medium').length;

  const output = {
    fetchedAt: new Date().toISOString(),
    source: 'wingbits',
    stats: {
      totalHexes: body.hexes.length,
      highCount,
      mediumCount,
    },
    hexes,
  };

  console.error(`[gpsjam] ${body.hexes.length} total hexes → ${highCount} high, ${mediumCount} medium`);

  if (outputPath) {
    mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    writeFileSync(path.resolve(outputPath), JSON.stringify(output, null, 2));
    console.error(`[gpsjam] Written to ${outputPath}`);
  } else {
    mkdirSync(DATA_DIR, { recursive: true });
    const defaultPath = path.join(DATA_DIR, 'gpsjam-latest.json');
    writeFileSync(defaultPath, JSON.stringify(output, null, 2));
    console.error(`[gpsjam] Written to ${defaultPath}`);
    process.stdout.write(JSON.stringify(output));
  }

  await seedRedis(output);
}

main().catch(err => {
  console.error(`[gpsjam] Fatal: ${err.message}`);
  process.exit(1);
});
