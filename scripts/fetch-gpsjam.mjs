/**
 * Fetches GPS/GNSS interference data from gpsjam.org (the free, no-auth source
 * the layer is named after; ADS-B Exchange derived). Restored 2026-07 from the
 * Wingbits customer API (#1240), which hit recurring monthly-quota (HTTP 402)
 * exhaustion → silent staleness. gpsjam.org has no key and no quota.
 *
 * Source:  gpsjam.org/data/manifest.csv (latest date) + {date}-h3_4.csv
 * Format:  H3 res-4 hexes, columns hex,count_good_aircraft,count_bad_aircraft.
 * Metric:  pct = bad/total aircraft with GPS issues. Low <2%, Medium 2-10%, High >10%.
 * Cadence: daily (updates once/day; the seed refreshes seed-meta.fetchedAt each run).
 *
 * Run:  node scripts/fetch-gpsjam.mjs [--date YYYY-MM-DD] [--min-aircraft 3] [--output path.json]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { extendExistingTtl } from './_seed-utils.mjs';
import { processHexes } from './_gpsjam-parse.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, 'data');

const REDIS_KEY_V2 = 'intelligence:gpsjam:v2';
const REDIS_KEY_V1 = 'intelligence:gpsjam:v1';
const REDIS_TTL = 172800; // 48h
const BASE_URL = 'https://gpsjam.org/data';
const UA = 'Mozilla/5.0 (compatible; WorldMonitor/1.0)';

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const requestedDate = getArg('date', null);
const minAircraftRaw = parseInt(getArg('min-aircraft', '3'), 10);
// Guard against a typo'd --min-aircraft (NaN) silently disabling the low-sample filter.
const minAircraft = Number.isFinite(minAircraftRaw) && minAircraftRaw > 0 ? minAircraftRaw : 3;
const outputPath = getArg('output', null);

function maskToken(token) {
  if (!token || token.length < 8) return '***';
  return token.slice(0, 4) + '***' + token.slice(-4);
}

async function fetchText(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.text();
}

// Latest available date is the last row of the manifest (date,suspect,num_bad_hexes).
async function getLatestDate() {
  const csv = await fetchText(`${BASE_URL}/manifest.csv`);
  const lines = csv.trim().split('\n');
  const last = lines[lines.length - 1];
  const date = last.split(',')[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Unexpected manifest tail: ${last.slice(0, 80)}`);
  return date;
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

  const v2Resp = await fetch(redisUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['SET', REDIS_KEY_V2, payload, 'EX', REDIS_TTL]),
    signal: AbortSignal.timeout(15_000),
  });
  if (!v2Resp.ok) {
    const text = await v2Resp.text().catch(() => '');
    console.error(`[gpsjam] Redis SET v2 failed: HTTP ${v2Resp.status} — ${text.slice(0, 200)}`);
    return;
  }
  console.error(`[gpsjam] Redis SET v2 result:`, await v2Resp.json());

  // Dual-write v1 in the original gpsjam.org schema (good/bad/total) for any
  // reader still on the pre-migration shape.
  const v1Output = {
    ...output,
    hexes: output.hexes.map(hex => ({
      h3: hex.h3,
      lat: hex.lat,
      lon: hex.lon,
      level: hex.level,
      region: hex.region,
      pct: hex.pct,
      good: Math.max(0, hex.totalAircraft - hex.affectedAircraft),
      bad: hex.affectedAircraft,
      total: hex.totalAircraft,
    })),
  };
  const v1Resp = await fetch(redisUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['SET', REDIS_KEY_V1, JSON.stringify(v1Output), 'EX', REDIS_TTL]),
    signal: AbortSignal.timeout(15_000),
  });
  if (!v1Resp.ok) {
    const text = await v1Resp.text().catch(() => '');
    console.error(`[gpsjam] Redis SET v1 failed: HTTP ${v1Resp.status} — ${text.slice(0, 200)}`);
  } else {
    console.error(`[gpsjam] Redis SET v1 result:`, await v1Resp.json());
  }

  const getResp = await fetch(`${redisUrl}/get/${encodeURIComponent(REDIS_KEY_V2)}`, {
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

  const metaKey = 'seed-meta:intelligence:gpsjam';
  const meta = { fetchedAt: Date.now(), recordCount: output.hexes?.length || 0 };
  await fetch(redisUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['SET', metaKey, JSON.stringify(meta), 'EX', 604800]),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => console.error('[gpsjam] seed-meta write failed'));
  console.error(`[gpsjam] Wrote seed-meta: ${metaKey}`);
}

async function main() {
  const date = requestedDate || await getLatestDate();
  console.error(`[gpsjam] Date: ${date}, min aircraft: ${minAircraft}`);

  const url = `${BASE_URL}/${date}-h3_4.csv`;
  console.error(`[gpsjam] Fetching ${url}`);
  const csv = await fetchText(url);
  const { results, skippedLowSample, skippedLow, totalRows } = processHexes(csv, minAircraft);

  const highCount = results.filter(r => r.level === 'high').length;
  const mediumCount = results.filter(r => r.level === 'medium').length;

  const output = {
    date,
    fetchedAt: new Date().toISOString(),
    source: 'gpsjam.org',
    attribution: 'Data derived from ADS-B Exchange via gpsjam.org',
    minAircraftThreshold: minAircraft,
    stats: { totalHexes: totalRows, highCount, mediumCount, skippedLowSample, skippedLow },
    hexes: results,
  };

  console.error(`[gpsjam] ${totalRows} total hexes → ${highCount} high, ${mediumCount} medium (skipped: ${skippedLowSample} low-sample, ${skippedLow} low-interference)`);

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

main().catch(async err => {
  // Preserve-last-good: gpsjam.org is a daily feed; a transient fetch/parse
  // failure must not blow away yesterday's hexes. Extend the existing TTLs and
  // exit 0 (graceful), matching the seeder convention. seed-meta.fetchedAt is
  // intentionally NOT refreshed, so a persistent outage still surfaces via the
  // age-based STALE_SEED alarm (api/health.js gpsjam maxStaleMin=1440).
  console.error(`[gpsjam] Fetch failed: ${err.message} — extending TTL on stale data`);
  await extendExistingTtl([REDIS_KEY_V2, REDIS_KEY_V1, 'seed-meta:intelligence:gpsjam'], REDIS_TTL)
    .catch(e => console.error(`[gpsjam] TTL extend failed: ${e.message}`));
  process.exit(0);
});
