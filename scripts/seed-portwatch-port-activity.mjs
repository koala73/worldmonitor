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
// 60 min — covers the widest realistic run of this standalone service.
const LOCK_TTL_MS = 60 * 60 * 1000;
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

// Per-country budget. ArcGIS's ISO3 index makes per-country fetches O(rows-in-country),
// which is fine for most countries but heavy ones (USA ~313k historic rows, CHN/IND/RUS
// similar) can push 60-90s when the server is under load. Promise.allSettled would
// otherwise wait for the slowest, stalling the whole batch.
const PER_COUNTRY_TIMEOUT_MS = 90_000;
const CONCURRENCY = 12;
const BATCH_LOG_EVERY = 5;

function epochToTimestamp(epochMs) {
  const d = new Date(epochMs);
  const p = (n) => String(n).padStart(2, '0');
  return `timestamp '${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}'`;
}

async function fetchWithTimeout(url, { signal } = {}) {
  // Combine the per-call FETCH_TIMEOUT with the upstream caller signal so an
  // abort propagates into the in-flight fetch AND future pagination iterations.
  const combined = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT)])
    : AbortSignal.timeout(FETCH_TIMEOUT);
  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: combined,
  });
  if (resp.status === 429) {
    const proxyAuth = resolveProxyForConnect();
    if (!proxyAuth) throw new Error(`ArcGIS HTTP 429 (rate limited) for ${url.slice(0, 80)}`);
    console.warn(`  [portwatch] 429 rate-limited — retrying via proxy: ${url.slice(0, 80)}`);
    const { buffer } = await httpsProxyFetchRaw(url, proxyAuth, { accept: 'application/json', timeoutMs: FETCH_TIMEOUT, signal });
    const proxied = JSON.parse(buffer.toString('utf8'));
    if (proxied.error) throw new Error(`ArcGIS error (via proxy): ${proxied.error.message}`);
    return proxied;
  }
  if (!resp.ok) throw new Error(`ArcGIS HTTP ${resp.status} for ${url.slice(0, 80)}`);
  const body = await resp.json();
  if (body.error) throw new Error(`ArcGIS error: ${body.error.message}`);
  return body;
}

// ArcGIS's Daily_Ports_Data FeatureServer intermittently returns "Cannot
// perform query. Invalid query parameters." for otherwise-valid queries —
// observed in prod 2026-04-20 for BRA/IDN/NGA on per-country WHERE, and
// also for the global WHERE after the PR #3225 rollout. A single retry with
// a short back-off clears it in practice. No retry loop — one attempt
// bounded. Does not retry any other error class.
async function fetchWithRetryOnInvalidParams(url, { signal } = {}) {
  try {
    return await fetchWithTimeout(url, { signal });
  } catch (err) {
    const msg = err?.message || '';
    if (!/Invalid query parameters/i.test(msg)) throw err;
    await new Promise((r) => setTimeout(r, 500));
    if (signal?.aborted) throw signal.reason ?? err;
    console.warn(`  [port-activity] retrying after "${msg}": ${url.slice(0, 80)}`);
    return await fetchWithTimeout(url, { signal });
  }
}

// Fetch ALL ports globally in one paginated pass, grouped by ISO3.
// ArcGIS server-cap: advance by actual features.length, never PAGE_SIZE.
async function fetchAllPortRefs({ signal } = {}) {
  const byIso3 = new Map();
  let offset = 0;
  let body;
  let page = 0;
  do {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    page++;
    const params = new URLSearchParams({
      where: '1=1',
      outFields: 'portid,ISO3,lat,lon',
      returnGeometry: 'false',
      orderByFields: 'portid ASC',
      resultRecordCount: String(PAGE_SIZE),
      resultOffset: String(offset),
      outSR: '4326',
      f: 'json',
    });
    body = await fetchWithRetryOnInvalidParams(`${EP4_BASE}?${params}`, { signal });
    const features = body.features ?? [];
    for (const f of features) {
      const a = f.attributes;
      if (a?.portid == null || !a?.ISO3) continue;
      const iso3 = String(a.ISO3);
      const portId = String(a.portid);
      let ports = byIso3.get(iso3);
      if (!ports) { ports = new Map(); byIso3.set(iso3, ports); }
      ports.set(portId, { lat: Number(a.lat ?? 0), lon: Number(a.lon ?? 0) });
    }
    console.log(`  [port-activity]   ref page ${page}: +${features.length} ports (${byIso3.size} countries so far)`);
    if (features.length === 0) break;
    offset += features.length;
  } while (body.exceededTransferLimit);
  return byIso3;
}

// Fetch ONE country's activity rows, streaming into per-port accumulators.
// ArcGIS's ISO3 index makes this cheap for most countries (~3-9s typical).
// Heavy countries (USA/CHN/etc.) can be 30-60s because 90 days × their many
// ports = thousands of rows across multiple pages. Hence the per-country
// timeout + single retry.
//
// Returns Map<portId, PortAccum> — same shape `finalisePortsForCountry`
// consumes. Memory per country is O(unique ports for that country) ≈ <200.
async function fetchCountryAccum(iso3, since, { signal } = {}) {
  const now = Date.now();
  const cutoff30 = now - 30 * 86400000;
  const cutoff60 = now - 60 * 86400000;
  const cutoff7 = now - 7 * 86400000;

  const portAccumMap = new Map();
  let offset = 0;
  let body;
  do {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    const params = new URLSearchParams({
      where: `ISO3='${iso3}' AND date > ${epochToTimestamp(since)}`,
      outFields: 'portid,portname,ISO3,date,portcalls_tanker,import_tanker,export_tanker',
      returnGeometry: 'false',
      orderByFields: 'portid ASC,date ASC',
      resultRecordCount: String(PAGE_SIZE),
      resultOffset: String(offset),
      outSR: '4326',
      f: 'json',
    });
    body = await fetchWithRetryOnInvalidParams(`${EP3_BASE}?${params}`, { signal });
    const features = body.features ?? [];
    for (const f of features) {
      const a = f.attributes;
      if (!a || a.portid == null || a.date == null) continue;
      const portId = String(a.portid);
      // ArcGIS date is esriFieldTypeDateOnly → "YYYY-MM-DD" string (or epoch ms).
      const date = typeof a.date === 'number' ? a.date : Date.parse(a.date + 'T12:00:00Z');
      const calls = Number(a.portcalls_tanker ?? 0);
      const imports = Number(a.import_tanker ?? 0);
      const exports_ = Number(a.export_tanker ?? 0);

      let acc = portAccumMap.get(portId);
      if (!acc) {
        acc = {
          portname: String(a.portname || ''),
          last30_calls: 0, last30_count: 0, last30_import: 0, last30_export: 0,
          prev30_calls: 0,
          last7_calls: 0, last7_count: 0,
        };
        portAccumMap.set(portId, acc);
      }
      if (date >= cutoff30) {
        acc.last30_calls += calls;
        acc.last30_count += 1;
        acc.last30_import += imports;
        acc.last30_export += exports_;
        if (date >= cutoff7) {
          acc.last7_calls += calls;
          acc.last7_count += 1;
        }
      } else if (date >= cutoff60) {
        acc.prev30_calls += calls;
      }
    }
    if (features.length === 0) break;
    offset += features.length;
  } while (body.exceededTransferLimit);
  return portAccumMap;
}

export function finalisePortsForCountry(portAccumMap, refMap) {
  const ports = [];
  for (const [portId, a] of portAccumMap) {
    const avg30d = a.last30_count > 0 ? a.last30_calls / a.last30_count : 0;
    const avg7d = a.last7_count > 0 ? a.last7_calls / a.last7_count : 0;
    const anomalySignal = avg30d > 0 && avg7d < avg30d * 0.5;
    const trendDelta = a.prev30_calls > 0
      ? Math.round(((a.last30_calls - a.prev30_calls) / a.prev30_calls) * 1000) / 10
      : 0;
    const coords = refMap.get(portId) || { lat: 0, lon: 0 };
    ports.push({
      portId,
      portName: a.portname,
      lat: coords.lat,
      lon: coords.lon,
      tankerCalls30d: a.last30_calls,
      trendDelta,
      importTankerDwt30d: a.last30_import,
      exportTankerDwt30d: a.last30_export,
      anomalySignal,
    });
  }
  return ports
    .sort((x, y) => y.tankerCalls30d - x.tankerCalls30d)
    .slice(0, MAX_PORTS_PER_COUNTRY);
}

// Runs `doWork(signal)` but rejects if the per-country timer fires first,
// aborting the controller so the in-flight fetch (and its pagination loop)
// actually stops instead of orphaning. Keeps the CONCURRENCY cap real.
// Exported with an injectable timeoutMs so runtime tests can exercise the
// abort path at 40ms instead of the production 90s.
export function withPerCountryTimeout(doWork, iso3, timeoutMs = PER_COUNTRY_TIMEOUT_MS) {
  const controller = new AbortController();
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`per-country timeout after ${timeoutMs / 1000}s (${iso3})`);
      try { controller.abort(err); } catch {}
      reject(err);
    }, timeoutMs);
  });
  const work = doWork(controller.signal);
  return Promise.race([work, guard]).finally(() => clearTimeout(timer));
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

// fetchAll() — pure data collection, no Redis writes.
// Returns { countries: string[], countryData: Map<iso2, payload>, fetchedAt: string }.
//
// `progress` (optional) is mutated in-place so a SIGTERM handler in main()
// can report which batch / country we died on.
export async function fetchAll(progress, { signal } = {}) {
  const { iso3ToIso2 } = createCountryResolvers();
  const since = Date.now() - HISTORY_DAYS * 86400000;

  if (progress) progress.stage = 'refs';
  console.log('  [port-activity] Fetching global port reference (EP4)...');
  const t0 = Date.now();
  const refsByIso3 = await fetchAllPortRefs({ signal });
  console.log(`  [port-activity] Refs loaded: ${refsByIso3.size} countries with ports (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  if (progress) progress.stage = 'activity';
  const eligibleIso3 = [...refsByIso3.keys()].filter(iso3 => iso3ToIso2.has(iso3));
  const skipped = refsByIso3.size - eligibleIso3.length;
  const batches = Math.ceil(eligibleIso3.length / CONCURRENCY);
  if (progress) progress.totalBatches = batches;
  console.log(`  [port-activity] Activity queue: ${eligibleIso3.length} countries (skipping ${skipped} unmapped iso3, concurrency ${CONCURRENCY}, per-country cap ${PER_COUNTRY_TIMEOUT_MS / 1000}s)`);

  const countryData = new Map();
  const errors = progress?.errors ?? [];
  const activityStart = Date.now();

  for (let i = 0; i < eligibleIso3.length; i += CONCURRENCY) {
    const batch = eligibleIso3.slice(i, i + CONCURRENCY);
    const batchIdx = Math.floor(i / CONCURRENCY) + 1;
    if (progress) progress.batchIdx = batchIdx;

    const promises = batch.map(iso3 => {
      const p = withPerCountryTimeout(
        (childSignal) => fetchCountryAccum(iso3, since, { signal: childSignal }),
        iso3,
      );
      // Eager error flush so a SIGTERM mid-batch captures rejections that
      // have already fired, not only those that settled after allSettled.
      p.catch(err => errors.push(`${iso3}: ${err?.message || err}`));
      return p;
    });
    const settled = await Promise.allSettled(promises);

    for (let j = 0; j < batch.length; j++) {
      const iso3 = batch[j];
      const outcome = settled[j];
      if (outcome.status === 'rejected') continue; // already recorded via .catch
      const portAccumMap = outcome.value;
      if (!portAccumMap || portAccumMap.size === 0) continue;
      const ports = finalisePortsForCountry(portAccumMap, refsByIso3.get(iso3));
      if (!ports.length) continue;
      const iso2 = iso3ToIso2.get(iso3);
      countryData.set(iso2, { iso2, ports, fetchedAt: new Date().toISOString() });
    }

    if (progress) progress.seeded = countryData.size;
    if (batchIdx === 1 || batchIdx % BATCH_LOG_EVERY === 0 || batchIdx === batches) {
      const elapsed = ((Date.now() - activityStart) / 1000).toFixed(1);
      console.log(`  [port-activity]   batch ${batchIdx}/${batches}: ${countryData.size} countries seeded, ${errors.length} errors (${elapsed}s)`);
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

  // Shared progress object so the SIGTERM handler can report which batch /
  // stage we died in and what per-country errors have fired so far.
  const progress = { stage: 'starting', batchIdx: 0, totalBatches: 0, seeded: 0, errors: [] };

  // AbortController threaded through fetchAll → fetchCountryAccum → fetchWithTimeout
  // → _proxy-utils so a SIGTERM kill (or bundle-runner grace-window escalation)
  // actually stops any in-flight HTTP work.
  const shutdownController = new AbortController();

  let sigHandled = false;
  const onSigterm = async () => {
    if (sigHandled) return;
    sigHandled = true;
    try { shutdownController.abort(new Error('SIGTERM')); } catch {}
    console.error(
      `  [port-activity] SIGTERM at batch ${progress.batchIdx}/${progress.totalBatches} (stage=${progress.stage}) — ${progress.seeded} seeded, ${progress.errors.length} errors`,
    );
    if (progress.errors.length) {
      console.error(`  [port-activity] First errors: ${progress.errors.slice(0, 10).join('; ')}`);
    }
    console.error('  [port-activity] Releasing lock + extending TTLs');
    try {
      await extendExistingTtl([CANONICAL_KEY, META_KEY, ...prevCountryKeys], TTL);
    } catch {}
    try { await releaseLock(LOCK_DOMAIN, runId); } catch {}
    process.exit(1);
  };
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigterm);

  try {
    const prevIso2List = await readSeedSnapshot(CANONICAL_KEY).catch(() => null);
    prevCountryKeys = Array.isArray(prevIso2List) ? prevIso2List.map(iso2 => `${KEY_PREFIX}${iso2}`) : [];
    prevCount = Array.isArray(prevIso2List) ? prevIso2List.length : 0;

    console.log(`  Fetching port activity data (${HISTORY_DAYS}d history)...`);
    const { countries, countryData } = await fetchAll(progress, { signal: shutdownController.signal });

    console.log(`  Fetched ${countryData.size} countries`);

    if (!validateFn({ countries })) {
      console.error(`  COVERAGE GATE FAILED: only ${countryData.size} countries, need >=${MIN_VALID_COUNTRIES}`);
      await extendExistingTtl([CANONICAL_KEY, META_KEY, ...prevCountryKeys], TTL).catch(() => {});
      return;
    }

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
