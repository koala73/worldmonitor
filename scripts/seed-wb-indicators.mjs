#!/usr/bin/env node
/**
 * Seed script: World Bank Tech Readiness indicators → Redis
 *
 * Fetches 4 WB indicators for all countries, computes rankings identical to
 * getTechReadinessRankings() in src/services/economic/index.ts, and stores
 * the result under economic:worldbank-techreadiness:v1 for bootstrap hydration.
 *
 * Usage:
 *   node scripts/seed-wb-indicators.mjs [--env production|preview|development] [--sha <sha>]
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const BOOTSTRAP_KEY = 'economic:worldbank-techreadiness:v1';
const TTL_SECONDS = 7 * 24 * 3600; // 7 days — WB data is annual
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

// Mirror weights from getTechReadinessRankings()
const WEIGHTS = { internet: 30, mobile: 15, broadband: 20, rdSpend: 35 };
const NORMALIZE_MAX = { internet: 100, mobile: 150, broadband: 50, rdSpend: 5 };

// WB indicators + date ranges matching the RPC handler
const INDICATORS = [
  { key: 'internet',  id: 'IT.NET.USER.ZS', dateRange: '2019:2024' },
  { key: 'mobile',    id: 'IT.CEL.SETS.P2', dateRange: '2019:2024' },
  { key: 'broadband', id: 'IT.NET.BBND.P2', dateRange: '2019:2024' },
  { key: 'rdSpend',   id: 'GB.XPD.RSDV.GD.ZS', dateRange: '2018:2024' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  let env = 'production';
  let sha = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--env' && args[i + 1]) {
      env = args[++i];
    } else if (args[i] === '--sha' && args[i + 1]) {
      sha = args[++i];
    } else if (args[i].startsWith('--env=')) {
      env = args[i].split('=')[1];
    } else if (args[i].startsWith('--sha=')) {
      sha = args[i].split('=')[1];
    }
  }

  const valid = ['production', 'preview', 'development'];
  if (!valid.includes(env)) {
    console.error(`Invalid --env "${env}". Must be one of: ${valid.join(', ')}`);
    process.exit(1);
  }

  if ((env === 'preview' || env === 'development') && !sha) {
    sha = 'dev';
  }

  return { env, sha };
}

function getKeyPrefix(env, sha) {
  if (env === 'production') return '';
  return `${env}:${sha}:`;
}

function maskToken(token) {
  if (!token || token.length < 8) return '***';
  return token.slice(0, 4) + '***' + token.slice(-4);
}

function loadEnvFile() {
  const envPath = join(__dirname, '..', '.env.local');
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
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchWithRetry(url, attempt = 1) {
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'WorldMonitor-Seed/1.0 (https://worldmonitor.app)',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    return resp.json();
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
      console.warn(`  Retry ${attempt}/${MAX_RETRIES} for ${url} in ${delay}ms... (${err.message})`);
      await sleep(delay);
      return fetchWithRetry(url, attempt + 1);
    }
    throw err;
  }
}

async function redisPipeline(redisUrl, token, commands) {
  const resp = await fetch(`${redisUrl}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Redis pipeline failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }
  return resp.json();
}

// ---------------------------------------------------------------------------
// World Bank fetch + parse
// ---------------------------------------------------------------------------

/**
 * Fetch all pages of a WB indicator and return latestByCountry map.
 * latestByCountry[iso3] = { value: number, name: string, year: number }
 */
async function fetchWbIndicator(indicatorId, dateRange) {
  const baseUrl = `https://api.worldbank.org/v2/country/all/indicator/${indicatorId}`;
  const perPage = 1000;
  let page = 1;
  let totalPages = 1;
  const allEntries = [];

  while (page <= totalPages) {
    const url = `${baseUrl}?format=json&date=${dateRange}&per_page=${perPage}&page=${page}`;
    console.log(`  Fetching ${indicatorId} page ${page}/${totalPages}...`);
    const raw = await fetchWithRetry(url);

    // WB response: [{metadata}, [entries]]
    if (!Array.isArray(raw) || raw.length < 2) {
      throw new Error(`Unexpected WB response shape for ${indicatorId}`);
    }

    const meta = raw[0];
    const entries = raw[1];
    totalPages = meta.pages || 1;

    if (Array.isArray(entries)) {
      allEntries.push(...entries);
    }

    page++;
  }

  // Build latestByCountry: keep most recent non-null value per ISO3 code
  const latestByCountry = {};

  for (const entry of allEntries) {
    if (entry.value === null || entry.value === undefined) continue;
    const iso3 = entry.countryiso3code;
    if (!iso3 || iso3.length !== 3) continue; // skip entries with missing or malformed country codes

    const year = parseInt(entry.date, 10);
    if (!latestByCountry[iso3] || year > latestByCountry[iso3].year) {
      latestByCountry[iso3] = {
        value: entry.value,
        name: entry.country?.value || iso3,
        year,
      };
    }
  }

  return latestByCountry;
}

// ---------------------------------------------------------------------------
// Rankings computation (mirrors getTechReadinessRankings() exactly)
// ---------------------------------------------------------------------------

function normalize(val, max) {
  if (val === undefined || val === null) return null;
  return Math.min(100, (val / max) * 100);
}

function computeRankings(indicatorData) {
  const allCountries = new Set();
  for (const data of Object.values(indicatorData)) {
    Object.keys(data).forEach(c => allCountries.add(c));
  }

  const scores = [];

  for (const countryCode of allCountries) {
    const iData = indicatorData.internet[countryCode];
    const mData = indicatorData.mobile[countryCode];
    const bData = indicatorData.broadband[countryCode];
    const rData = indicatorData.rdSpend[countryCode];

    const components = {
      internet:  normalize(iData?.value, NORMALIZE_MAX.internet),
      mobile:    normalize(mData?.value, NORMALIZE_MAX.mobile),
      broadband: normalize(bData?.value, NORMALIZE_MAX.broadband),
      rdSpend:   normalize(rData?.value, NORMALIZE_MAX.rdSpend),
    };

    let totalWeight = 0;
    let weightedSum = 0;
    for (const [key, weight] of Object.entries(WEIGHTS)) {
      const val = components[key];
      if (val !== null) {
        weightedSum += val * weight;
        totalWeight += weight;
      }
    }

    const score = totalWeight > 0 ? weightedSum / totalWeight : 0;
    const countryName = iData?.name || mData?.name || bData?.name || rData?.name || countryCode;

    scores.push({
      country: countryCode,
      countryName,
      score: Math.round(score * 10) / 10,
      rank: 0,
      components,
    });
  }

  scores.sort((a, b) => b.score - a.score);
  scores.forEach((s, i) => { s.rank = i + 1; });

  return scores;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  loadEnvFile();

  const { env, sha } = parseArgs();
  const prefix = getKeyPrefix(env, sha);

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!redisUrl) {
    console.error('Missing UPSTASH_REDIS_REST_URL. Set it in .env.local or as an env var.');
    process.exit(1);
  }
  if (!redisToken) {
    console.error('Missing UPSTASH_REDIS_REST_TOKEN. Set it in .env.local or as an env var.');
    process.exit(1);
  }

  const fullKey = `${prefix}${BOOTSTRAP_KEY}`;

  console.log('=== World Bank Tech Readiness Seed ===');
  console.log(`  Environment:  ${env}`);
  console.log(`  Prefix:       ${prefix || '(none — production)'}`);
  console.log(`  Redis URL:    ${redisUrl}`);
  console.log(`  Redis Token:  ${maskToken(redisToken)}`);
  console.log(`  Bootstrap key: ${fullKey}`);
  console.log(`  TTL:          ${TTL_SECONDS}s (7 days)`);
  console.log();

  // Fetch all 4 indicators
  const indicatorData = {};
  const t0 = Date.now();

  for (const { key, id, dateRange } of INDICATORS) {
    console.log(`Fetching indicator: ${id} (${dateRange})`);
    indicatorData[key] = await fetchWbIndicator(id, dateRange);
    const count = Object.keys(indicatorData[key]).length;
    console.log(`  → ${count} countries with non-null data\n`);
  }

  const fetchElapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`All indicators fetched in ${fetchElapsed}s\n`);

  // Compute rankings
  console.log('Computing rankings...');
  const rankings = computeRankings(indicatorData);
  console.log(`  → ${rankings.length} countries ranked`);
  console.log(`  Top 5: ${rankings.slice(0, 5).map(r => `${r.rank}. ${r.countryName} (${r.score})`).join(', ')}`);
  console.log();

  if (rankings.length === 0) {
    console.error('No rankings computed — aborting to avoid writing empty data.');
    process.exit(1);
  }

  // Write to Redis
  console.log(`Writing to Redis key: ${fullKey}`);
  await redisPipeline(redisUrl, redisToken, [
    ['SET', fullKey, JSON.stringify(rankings), 'EX', String(TTL_SECONDS)],
  ]);

  // Verify
  console.log('Verifying...');
  const verifyResp = await redisPipeline(redisUrl, redisToken, [
    ['GET', fullKey],
  ]);
  const stored = verifyResp[0]?.result;
  if (!stored) {
    throw new Error('Verification failed: key not found in Redis after write');
  }
  const parsed = JSON.parse(stored);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('Verification failed: stored value is not a non-empty array');
  }
  console.log(`  ✓ Verified ${parsed.length} rankings stored`);

  const total = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== Done in ${total}s ===`);
  console.log(`  ✓ Wrote ${fullKey} (${rankings.length} rankings)`);
}

main().catch(err => {
  console.error('\nFATAL:', err.message || err);
  process.exit(1);
});
