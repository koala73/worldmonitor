#!/usr/bin/env node

import {
  loadEnvFile,
  CHROME_UA,
  getRedisCredentials,
  acquireLockSafely,
  releaseLock,
  extendExistingTtl,
  logSeedResult,
  readSeedSnapshot,
  resolveProxyForConnect,
  httpsProxyFetchRaw,
} from './_seed-utils.mjs';
import { createCountryResolvers } from './_country-resolver.mjs';

loadEnvFile(import.meta.url);

export const CANONICAL_KEY = 'supply_chain:portwatch-ports:v1:_countries';
const KEY_PREFIX = 'supply_chain:portwatch-ports:v1:';
const META_KEY = 'seed-meta:supply_chain:portwatch-ports';
const LOCK_DOMAIN = 'supply_chain:portwatch-ports';
const LOCK_TTL_MS = 30 * 60 * 1000; // 30 min — covers worst-case full run
const TTL = 259_200; // 3 days — 6× the 12h cron interval
const MIN_VALID_COUNTRIES = 50;

const EP3_BASE =
  'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Ports_Data/FeatureServer/0/query';
const EP4_BASE =
  'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/PortWatch_ports_database/FeatureServer/0/query';

const PAGE_SIZE = 2000;
const FETCH_TIMEOUT = 45_000;
const HISTORY_DAYS = 90;
const MAX_PORTS_PER_COUNTRY = 50;
const CONCURRENCY = 4;

function epochToTimestamp(epochMs) {
  const d = new Date(epochMs);
  const p = (n) => String(n).padStart(2, '0');
  return `timestamp '${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}'`;
}

async function fetchWithTimeout(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (resp.status === 429) {
    const proxyAuth = resolveProxyForConnect();
    if (!proxyAuth) throw new Error(`ArcGIS HTTP 429 (rate limited) for ${url.slice(0, 80)}`);
    console.warn(`  [portwatch] 429 rate-limited — retrying via proxy: ${url.slice(0, 80)}`);
    const { buffer } = await httpsProxyFetchRaw(url, proxyAuth, { accept: 'application/json', timeoutMs: FETCH_TIMEOUT });
    const proxied = JSON.parse(buffer.toString('utf8'));
    if (proxied.error) throw new Error(`ArcGIS error (via proxy): ${proxied.error.message}`);
    return proxied;
  }
  if (!resp.ok) throw new Error(`ArcGIS HTTP ${resp.status} for ${url.slice(0, 80)}`);
  const body = await resp.json();
  if (body.error) throw new Error(`ArcGIS error: ${body.error.message}`);
  return body;
}

async function fetchPortRef(iso3) {
  let offset = 0;
  const refMap = new Map();
  let body;
  do {
    const params = new URLSearchParams({
      where: `ISO3='${iso3}'`,
      outFields: 'portid,lat,lon',
      returnGeometry: 'false',
      orderByFields: 'portid ASC',
      resultRecordCount: String(PAGE_SIZE),
      resultOffset: String(offset),
      outSR: '4326',
      f: 'json',
    });
    body = await fetchWithTimeout(`${EP4_BASE}?${params}`);
    for (const f of body.features ?? []) {
      const a = f.attributes;
      if (a?.portid != null) {
        refMap.set(String(a.portid), { lat: Number(a.lat ?? 0), lon: Number(a.lon ?? 0) });
      }
    }
    offset += PAGE_SIZE;
  } while (body.exceededTransferLimit);
  return refMap;
}

async function fetchActivityRows(iso3, since) {
  let offset = 0;
  const allRows = [];
  let body;
  do {
    const params = new URLSearchParams({
      where: `ISO3='${iso3}' AND date > ${epochToTimestamp(since)}`,
      outFields: 'portid,portname,ISO3,date,portcalls_tanker,import_tanker,export_tanker',
      orderByFields: 'portid ASC,date ASC',
      resultRecordCount: String(PAGE_SIZE),
      resultOffset: String(offset),
      outSR: '4326',
      f: 'json',
    });
    body = await fetchWithTimeout(`${EP3_BASE}?${params}`);
    if (body.features?.length) allRows.push(...body.features);
    offset += PAGE_SIZE;
  } while (body.exceededTransferLimit);
  return allRows;
}

function computeCountryPorts(rawRows, refMap) {
  const now = Date.now();
  const cutoff30 = now - 30 * 86400000;
  const cutoff60 = now - 60 * 86400000;
  const cutoff7 = now - 7 * 86400000;

  const portGroups = new Map();
  for (const f of rawRows) {
    const a = f.attributes;
    if (a?.portid == null || a?.date == null) continue;
    const portId = String(a.portid);
    if (!portGroups.has(portId)) portGroups.set(portId, []);
    portGroups.get(portId).push({
      date: Number(a.date),
      portname: String(a.portname || ''),
      portcalls_tanker: Number(a.portcalls_tanker ?? 0),
      import_tanker: Number(a.import_tanker ?? 0),
      export_tanker: Number(a.export_tanker ?? 0),
    });
  }

  const ports = [];
  for (const [portId, rows] of portGroups) {
    const last30 = rows.filter(r => r.date >= cutoff30);
    const prev30 = rows.filter(r => r.date >= cutoff60 && r.date < cutoff30);
    const last7 = rows.filter(r => r.date >= cutoff7);

    const tankerCalls30d = last30.reduce((s, r) => s + r.portcalls_tanker, 0);
    const tankerCalls30dPrev = prev30.reduce((s, r) => s + r.portcalls_tanker, 0);
    const importTankerDwt30d = last30.reduce((s, r) => s + r.import_tanker, 0);
    const exportTankerDwt30d = last30.reduce((s, r) => s + r.export_tanker, 0);

    const avg30d = last30.length > 0 ? tankerCalls30d / last30.length : 0;
    const avg7d = last7.length > 0 ? last7.reduce((s, r) => s + r.portcalls_tanker, 0) / last7.length : 0;
    const anomalySignal = avg30d > 0 && avg7d < avg30d * 0.5;

    const trendDelta = tankerCalls30dPrev > 0
      ? Math.round(((tankerCalls30d - tankerCalls30dPrev) / tankerCalls30dPrev) * 1000) / 10
      : 0;

    const portName = rows[0].portname;
    const coords = refMap.get(portId) || { lat: 0, lon: 0 };

    ports.push({
      portId,
      portName,
      lat: coords.lat,
      lon: coords.lon,
      tankerCalls30d,
      trendDelta,
      importTankerDwt30d,
      exportTankerDwt30d,
      anomalySignal,
    });
  }

  return ports
    .sort((a, b) => b.tankerCalls30d - a.tankerCalls30d)
    .slice(0, MAX_PORTS_PER_COUNTRY);
}

async function redisPipeline(commands) {
  const { url, token } = getRedisCredentials();
  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': CHROME_UA },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Redis pipeline failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }
  return resp.json();
}

async function processCountry(iso3, iso2, since) {
  const [refMap, rawRows] = await Promise.all([
    fetchPortRef(iso3),
    fetchActivityRows(iso3, since),
  ]);
  if (!rawRows.length) return null;
  const ports = computeCountryPorts(rawRows, refMap);
  if (!ports.length) return null;
  return { iso2, ports, fetchedAt: new Date().toISOString() };
}

// fetchAll() — pure data collection, no Redis writes.
// Returns { countries: string[], countryData: Map<iso2, payload>, fetchedAt: string }.
export async function fetchAll() {
  const { iso3ToIso2 } = createCountryResolvers();
  const ISO3_LIST = [...iso3ToIso2.keys()];
  const since = Date.now() - HISTORY_DAYS * 86400000;

  const countryData = new Map();
  const errors = [];

  for (let i = 0; i < ISO3_LIST.length; i += CONCURRENCY) {
    const batch = ISO3_LIST.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(iso3 => {
        const iso2 = iso3ToIso2.get(iso3);
        return processCountry(iso3, iso2, since);
      })
    );
    for (let j = 0; j < batch.length; j++) {
      const iso3 = batch[j];
      const outcome = settled[j];
      if (outcome.status === 'rejected') {
        errors.push(`${iso3}: ${outcome.reason?.message || outcome.reason}`);
        continue;
      }
      if (!outcome.value) continue;
      const { iso2, ports, fetchedAt } = outcome.value;
      countryData.set(iso2, { iso2, ports, fetchedAt });
    }
  }

  if (errors.length) {
    console.warn(`  [port-activity] ${errors.length} country errors: ${errors.slice(0, 5).join('; ')}${errors.length > 5 ? ' ...' : ''}`);
  }

  if (countryData.size === 0) throw new Error('No country port data returned from ArcGIS');
  return { countries: [...countryData.keys()], countryData, fetchedAt: new Date().toISOString() };
}

export function validateFn(data) {
  return data && Array.isArray(data.countries) && data.countries.length >= MIN_VALID_COUNTRIES;
}

async function main() {
  const startedAt = Date.now();
  const runId = `portwatch-ports:${startedAt}`;

  console.log('=== supply_chain:portwatch-ports Seed ===');
  console.log(`  Run ID: ${runId}`);
  console.log(`  Key prefix: ${KEY_PREFIX}`);

  const lock = await acquireLockSafely(LOCK_DOMAIN, runId, LOCK_TTL_MS, { label: LOCK_DOMAIN });
  if (lock.skipped) return;
  if (!lock.locked) {
    console.log(`  SKIPPED: another seed run in progress (lock: seed-lock:${LOCK_DOMAIN}, held up to ${LOCK_TTL_MS / 60000}min — will retry at next cron trigger)`);
    return;
  }

  // Hoist so the catch block can extend TTLs even when the error occurs before these are resolved.
  let prevCountryKeys = [];
  let prevCount = 0;

  try {
    // Read previous snapshot first — needed for both degradation guard and error TTL extension.
    const prevIso2List = await readSeedSnapshot(CANONICAL_KEY).catch(() => null);
    prevCountryKeys = Array.isArray(prevIso2List) ? prevIso2List.map(iso2 => `${KEY_PREFIX}${iso2}`) : [];
    prevCount = Array.isArray(prevIso2List) ? prevIso2List.length : 0;

    console.log(`  Fetching port activity data (${HISTORY_DAYS}d history)...`);
    const { countries, countryData } = await fetchAll();

    console.log(`  Fetched ${countryData.size} countries`);

    if (!validateFn({ countries })) {
      console.error(`  COVERAGE GATE FAILED: only ${countryData.size} countries, need >=${MIN_VALID_COUNTRIES}`);
      await extendExistingTtl([CANONICAL_KEY, META_KEY, ...prevCountryKeys], TTL).catch(() => {});
      return;
    }

    // Degradation guard: refuse to replace a healthy snapshot that is significantly smaller.
    // Transient ArcGIS outages cause per-country fetches to fail via Promise.allSettled() without
    // throwing — publishin a 50-country result over a 120-country snapshot silently drops 70 countries.
    if (prevCount > 0 && countryData.size < prevCount * 0.8) {
      console.error(`  DEGRADATION GUARD: ${countryData.size} countries vs ${prevCount} previous — refusing to overwrite (need ≥${Math.ceil(prevCount * 0.8)})`);
      await extendExistingTtl([CANONICAL_KEY, META_KEY, ...prevCountryKeys], TTL).catch(() => {});
      return;
    }

    const metaPayload = { fetchedAt: Date.now(), recordCount: countryData.size };

    const commands = [];
    for (const [iso2, payload] of countryData) {
      commands.push(['SET', `${KEY_PREFIX}${iso2}`, JSON.stringify(payload), 'EX', TTL]);
    }
    commands.push(['SET', CANONICAL_KEY, JSON.stringify(countries), 'EX', TTL]);
    commands.push(['SET', META_KEY, JSON.stringify(metaPayload), 'EX', TTL]);

    const results = await redisPipeline(commands);
    const failures = results.filter(r => r?.error || r?.result === 'ERR');
    if (failures.length > 0) {
      throw new Error(`Redis pipeline: ${failures.length}/${commands.length} commands failed`);
    }

    logSeedResult('supply_chain', countryData.size, Date.now() - startedAt, { source: 'portwatch-ports' });
    console.log(`  Seeded ${countryData.size} countries`);
    console.log(`\n=== Done (${Date.now() - startedAt}ms) ===`);
  } catch (err) {
    console.error(`  SEED FAILED: ${err.message}`);
    await extendExistingTtl([CANONICAL_KEY, META_KEY, ...prevCountryKeys], TTL).catch(() => {});
    throw err;
  } finally {
    await releaseLock(LOCK_DOMAIN, runId);
  }
}

const isMain = process.argv[1]?.endsWith('seed-portwatch-port-activity.mjs');
if (isMain) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
