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
const PROGRESS_KEY = 'economic:worldbank-progress:v1';
const RENEWABLE_KEY = 'economic:worldbank-renewable:v1';
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
// Progress indicators (Human Progress panel)
// ---------------------------------------------------------------------------

const PROGRESS_INDICATORS = [
  { id: 'lifeExpectancy', code: 'SP.DYN.LE00.IN', years: 65, invertTrend: false },
  { id: 'literacy',       code: 'SE.ADT.LITR.ZS', years: 55, invertTrend: false },
  { id: 'childMortality', code: 'SH.DYN.MORT',    years: 65, invertTrend: true },
  { id: 'poverty',        code: 'SI.POV.DDAY',    years: 45, invertTrend: true },
];

async function fetchProgressData() {
  const currentYear = new Date().getFullYear();
  const results = [];

  for (const ind of PROGRESS_INDICATORS) {
    const startYear = currentYear - ind.years;
    const dateRange = `${startYear}:${currentYear}`;
    console.log(`  Progress: ${ind.code} (${dateRange})`);

    const url = `https://api.worldbank.org/v2/country/1W/indicator/${ind.code}?format=json&date=${dateRange}&per_page=1000`;
    const raw = await fetchWithRetry(url);

    if (!Array.isArray(raw) || raw.length < 2 || !Array.isArray(raw[1])) {
      console.warn(`    → No data for ${ind.code}`);
      results.push({ id: ind.id, code: ind.code, data: [], invertTrend: ind.invertTrend });
      continue;
    }

    const data = raw[1]
      .filter(e => e.value !== null && e.value !== undefined)
      .map(e => ({ year: parseInt(e.date, 10), value: e.value }))
      .filter(d => !isNaN(d.year))
      .sort((a, b) => a.year - b.year);

    console.log(`    → ${data.length} data points`);
    results.push({ id: ind.id, code: ind.code, data, invertTrend: ind.invertTrend });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Renewable energy (EG.ELC.RNEW.ZS) for world + regions
// ---------------------------------------------------------------------------

const RENEWABLE_REGIONS = ['1W', 'EAS', 'ECS', 'LCN', 'MEA', 'NAC', 'SAS', 'SSF'];
const RENEWABLE_REGION_NAMES = {
  '1W': 'World', EAS: 'East Asia & Pacific', ECS: 'Europe & Central Asia',
  LCN: 'Latin America & Caribbean', MEA: 'Middle East & N. Africa',
  NAC: 'North America', SAS: 'South Asia', SSF: 'Sub-Saharan Africa',
};

async function fetchRenewableData() {
  const currentYear = new Date().getFullYear();
  const startYear = currentYear - 35;
  const dateRange = `${startYear}:${currentYear}`;
  const countryCodes = RENEWABLE_REGIONS.join(';');
  const url = `https://api.worldbank.org/v2/country/${countryCodes}/indicator/EG.ELC.RNEW.ZS?format=json&date=${dateRange}&per_page=1000`;

  console.log(`  Renewable: EG.ELC.RNEW.ZS (${dateRange})`);
  const raw = await fetchWithRetry(url);

  if (!Array.isArray(raw) || raw.length < 2 || !Array.isArray(raw[1])) {
    console.warn('    → No renewable energy data from WB');
    return { globalPercentage: 0, globalYear: 0, historicalData: [], regions: [] };
  }

  const entries = raw[1].filter(e => e.value !== null && e.value !== undefined);
  console.log(`    → ${entries.length} entries`);

  const byRegion = {};
  for (const e of entries) {
    const code = e.countryiso3code || e.country?.id;
    if (!code) continue;
    if (!byRegion[code]) byRegion[code] = [];
    byRegion[code].push({ year: parseInt(e.date, 10), value: e.value });
  }

  for (const arr of Object.values(byRegion)) {
    arr.sort((a, b) => a.year - b.year);
  }

  const worldData = byRegion['WLD'] || byRegion['1W'] || [];
  const latest = worldData.length ? worldData[worldData.length - 1] : null;

  const regions = [];
  for (const code of RENEWABLE_REGIONS) {
    if (code === '1W') continue;
    const regionData = byRegion[code] || [];
    if (regionData.length === 0) continue;
    const latestRegion = regionData[regionData.length - 1];
    regions.push({
      code,
      name: RENEWABLE_REGION_NAMES[code] || code,
      percentage: latestRegion.value,
      year: latestRegion.year,
    });
  }
  regions.sort((a, b) => b.percentage - a.percentage);

  return {
    globalPercentage: latest?.value || 0,
    globalYear: latest?.year || 0,
    historicalData: worldData,
    regions,
  };
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
  const progressKey = `${prefix}${PROGRESS_KEY}`;
  const renewableKey = `${prefix}${RENEWABLE_KEY}`;

  console.log('=== World Bank Indicators Seed ===');
  console.log(`  Environment:  ${env}`);
  console.log(`  Prefix:       ${prefix || '(none — production)'}`);
  console.log(`  Redis URL:    ${redisUrl}`);
  console.log(`  Redis Token:  ${maskToken(redisToken)}`);
  console.log(`  Keys: ${fullKey}, ${progressKey}, ${renewableKey}`);
  console.log(`  TTL:          ${TTL_SECONDS}s (7 days)`);
  console.log();

  const t0 = Date.now();

  // ── 1. Tech Readiness rankings ──
  console.log('── Tech Readiness ──');
  const indicatorData = {};
  for (const { key, id, dateRange } of INDICATORS) {
    console.log(`Fetching indicator: ${id} (${dateRange})`);
    indicatorData[key] = await fetchWbIndicator(id, dateRange);
    const count = Object.keys(indicatorData[key]).length;
    console.log(`  → ${count} countries with non-null data\n`);
  }

  const rankings = computeRankings(indicatorData);
  console.log(`  → ${rankings.length} countries ranked`);
  console.log(`  Top 5: ${rankings.slice(0, 5).map(r => `${r.rank}. ${r.countryName} (${r.score})`).join(', ')}\n`);

  // ── 2. Progress indicators ──
  console.log('── Progress Indicators ──');
  const progressData = await fetchProgressData();
  const progressWithData = progressData.filter(p => p.data.length > 0);
  console.log(`  → ${progressWithData.length}/${progressData.length} indicators with data\n`);

  // ── 3. Renewable energy ──
  console.log('── Renewable Energy ──');
  const renewableData = await fetchRenewableData();
  console.log(`  → Global: ${renewableData.globalPercentage}% (${renewableData.globalYear})`);
  console.log(`  → ${renewableData.regions.length} regions\n`);

  const fetchElapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`All data fetched in ${fetchElapsed}s\n`);

  // Validate
  if (rankings.length === 0) {
    console.error('No rankings computed — aborting.');
    process.exit(1);
  }

  // Write all keys to Redis in one pipeline
  const pipeline = [
    ['SET', fullKey, JSON.stringify(rankings), 'EX', String(TTL_SECONDS)],
  ];
  if (progressWithData.length > 0) {
    pipeline.push(['SET', progressKey, JSON.stringify(progressData), 'EX', String(TTL_SECONDS)]);
  }
  if (renewableData.historicalData.length > 0) {
    pipeline.push(['SET', renewableKey, JSON.stringify(renewableData), 'EX', String(TTL_SECONDS)]);
  }

  console.log(`Writing ${pipeline.length} keys to Redis...`);
  await redisPipeline(redisUrl, redisToken, pipeline);

  // Verify
  console.log('Verifying...');
  const verifyResp = await redisPipeline(redisUrl, redisToken, [
    ['GET', fullKey],
    ['GET', progressKey],
    ['GET', renewableKey],
  ]);

  const parsedRankings = verifyResp[0]?.result ? JSON.parse(verifyResp[0].result) : null;
  if (!Array.isArray(parsedRankings) || parsedRankings.length === 0) {
    throw new Error('Verification failed: techReadiness key missing or empty');
  }
  console.log(`  ✓ techReadiness: ${parsedRankings.length} rankings`);

  if (verifyResp[1]?.result) {
    const p = JSON.parse(verifyResp[1].result);
    console.log(`  ✓ progressData: ${p.length} indicators`);
  }
  if (verifyResp[2]?.result) {
    const r = JSON.parse(verifyResp[2].result);
    console.log(`  ✓ renewableEnergy: ${r.regions?.length || 0} regions, global=${r.globalPercentage}%`);
  }

  const total = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== Done in ${total}s ===`);
}

main().catch(err => {
  console.error('\nFATAL:', err.message || err);
  process.exit(0); // graceful for cron
});
