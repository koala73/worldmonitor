#!/usr/bin/env node

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REDIS_KEY = 'conflict:ucdp-events:v1';
const UCDP_PAGE_SIZE = 1000;
const MAX_PAGES = 6;
const MAX_EVENTS = 2000; // TODO: review cap after observing real map density & panel usage
const TRAILING_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

const VIOLENCE_TYPE_MAP = {
  1: 'UCDP_VIOLENCE_TYPE_STATE_BASED',
  2: 'UCDP_VIOLENCE_TYPE_NON_STATE',
  3: 'UCDP_VIOLENCE_TYPE_ONE_SIDED',
};

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function loadEnvFile() {
  let envPath = join(__dirname, '..', '.env.local');
  if (!existsSync(envPath)) {
    envPath = join('/Users/eliehabib/Documents/GitHub/worldmonitor', '.env.local');
  }
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

function maskToken(token) {
  if (!token || token.length < 8) return '***';
  return token.slice(0, 4) + '***' + token.slice(-4);
}

function buildVersionCandidates() {
  const year = new Date().getFullYear() - 2000;
  return [...new Set([`${year}.1`, `${year - 1}.1`, '25.1', '24.1'])];
}

async function fetchGedPage(version, page, token) {
  const headers = { Accept: 'application/json', 'User-Agent': CHROME_UA };
  if (token) headers['x-ucdp-access-token'] = token;
  const resp = await fetch(
    `https://ucdpapi.pcr.uu.se/api/gedevents/${version}?pagesize=${UCDP_PAGE_SIZE}&page=${page}`,
    { headers, signal: AbortSignal.timeout(30_000) },
  );
  if (!resp.ok) throw new Error(`UCDP GED API error (${version}, page ${page}): ${resp.status}`);
  return resp.json();
}

async function discoverVersion(token) {
  const candidates = buildVersionCandidates();
  console.log(`  Probing versions: ${candidates.join(', ')}`);
  const results = await Promise.allSettled(
    candidates.map(async (version) => {
      const page0 = await fetchGedPage(version, 0, token);
      if (!Array.isArray(page0?.Result)) throw new Error('No results');
      return { version, page0 };
    }),
  );
  for (const result of results) {
    if (result.status === 'fulfilled') return result.value;
  }
  throw new Error('No valid UCDP GED version found');
}

function parseDateMs(value) {
  if (!value) return NaN;
  return Date.parse(String(value));
}

function getMaxDateMs(events) {
  let maxMs = NaN;
  for (const event of events) {
    const ms = parseDateMs(event?.date_start);
    if (!Number.isFinite(ms)) continue;
    if (!Number.isFinite(maxMs) || ms > maxMs) maxMs = ms;
  }
  return maxMs;
}

async function main() {
  loadEnvFile();

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const ucdpToken = (process.env.UCDP_ACCESS_TOKEN || process.env.UC_DP_KEY || '').trim();

  if (!redisUrl || !redisToken) {
    console.error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
    process.exit(1);
  }

  console.log('=== UCDP Events Seed ===');
  console.log(`  Redis:      ${redisUrl}`);
  console.log(`  Redis Token: ${maskToken(redisToken)}`);
  console.log(`  UCDP Token: ${ucdpToken ? maskToken(ucdpToken) : '(none — unauthenticated)'}`);
  console.log();

  const { version, page0 } = await discoverVersion(ucdpToken);
  const totalPages = Math.max(1, Number(page0?.TotalPages) || 1);
  const newestPage = totalPages - 1;
  console.log(`  Version: ${version} | Total pages: ${totalPages}`);

  const FAILED = Symbol('failed');
  const pagesToFetch = [];
  for (let offset = 0; offset < MAX_PAGES && (newestPage - offset) >= 0; offset++) {
    const page = newestPage - offset;
    if (page === 0) {
      pagesToFetch.push(Promise.resolve(page0));
    } else {
      pagesToFetch.push(fetchGedPage(version, page, ucdpToken).catch(() => FAILED));
    }
  }

  const pageResults = await Promise.all(pagesToFetch);

  const allEvents = [];
  let latestDatasetMs = NaN;
  let failedPages = 0;

  for (const rawData of pageResults) {
    if (rawData === FAILED) { failedPages++; continue; }
    const events = Array.isArray(rawData?.Result) ? rawData.Result : [];
    allEvents.push(...events);
    const pageMaxMs = getMaxDateMs(events);
    if (!Number.isFinite(latestDatasetMs) && Number.isFinite(pageMaxMs)) {
      latestDatasetMs = pageMaxMs;
    }
  }

  console.log(`  Raw events: ${allEvents.length} | Failed pages: ${failedPages}`);

  const filtered = allEvents.filter((event) => {
    if (!Number.isFinite(latestDatasetMs)) return true;
    const eventMs = parseDateMs(event?.date_start);
    if (!Number.isFinite(eventMs)) return false;
    return eventMs >= (latestDatasetMs - TRAILING_WINDOW_MS);
  });

  console.log(`  After 1-year trailing window: ${filtered.length}`);

  const mapped = filtered.map((e) => ({
    id: String(e.id || ''),
    dateStart: Date.parse(e.date_start) || 0,
    dateEnd: Date.parse(e.date_end) || 0,
    location: {
      latitude: Number(e.latitude) || 0,
      longitude: Number(e.longitude) || 0,
    },
    country: e.country || '',
    sideA: (e.side_a || '').substring(0, 200),
    sideB: (e.side_b || '').substring(0, 200),
    deathsBest: Number(e.best) || 0,
    deathsLow: Number(e.low) || 0,
    deathsHigh: Number(e.high) || 0,
    violenceType: VIOLENCE_TYPE_MAP[e.type_of_violence] || 'UCDP_VIOLENCE_TYPE_UNSPECIFIED',
    sourceOriginal: (e.source_original || '').substring(0, 300),
  }));

  mapped.sort((a, b) => b.dateStart - a.dateStart);
  const capped = mapped.slice(0, MAX_EVENTS);
  if (mapped.length > MAX_EVENTS) console.log(`  Capped: ${mapped.length} → ${MAX_EVENTS}`);

  const payload = {
    events: capped,
    fetchedAt: Date.now(),
    version,
    totalRaw: allEvents.length,
    filteredCount: mapped.length,
  };

  console.log(`  Mapped: ${mapped.length} events`);
  if (mapped[0]) {
    console.log(`  Newest: ${new Date(mapped[0].dateStart).toISOString().slice(0, 10)} — ${mapped[0].country}`);
  }
  console.log();

  const body = JSON.stringify(['SET', REDIS_KEY, JSON.stringify(payload), 'EX', 86400]);
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
    console.error(`Redis SET failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
    process.exit(1);
  }

  const result = await resp.json();
  console.log('  Redis SET result:', result);

  const getResp = await fetch(`${redisUrl}/get/${encodeURIComponent(REDIS_KEY)}`, {
    headers: { Authorization: `Bearer ${redisToken}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (getResp.ok) {
    const getData = await getResp.json();
    if (getData.result) {
      const parsed = JSON.parse(getData.result);
      console.log(`\n  Verified: ${parsed.events?.length} events in Redis`);
      console.log(`  Version: ${parsed.version} | fetchedAt: ${new Date(parsed.fetchedAt).toISOString()}`);
    }
  }

  console.log('\n=== Done ===');
}

main().catch(err => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
