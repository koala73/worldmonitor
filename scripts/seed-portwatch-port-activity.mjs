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
const ACTIVITY_LOG_EVERY = 20;

function epochToTimestamp(epochMs) {
  const d = new Date(epochMs);
  const p = (n) => String(n).padStart(2, '0');
  return `timestamp '${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}'`;
}

async function fetchWithTimeout(url, { signal } = {}) {
  // Combine the per-call FETCH_TIMEOUT with the upstream per-country signal
  // so a per-country abort propagates into the in-flight fetch AND future
  // pagination iterations (review feedback P1 on PR #3222). Without this,
  // the 90s withPerCountryTimeout timer fires, the batch moves on, but the
  // orphaned country keeps paginating with fresh 45s fetch timeouts —
  // breaking the CONCURRENCY=12 cap and amplifying ArcGIS throttling.
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
    // Pass the caller signal so a per-country abort also cancels the proxy
    // fallback path (review feedback on PR #3222). Without this, a timed-out
    // country could keep a proxy CONNECT tunnel + request alive for another
    // 45s after the batch moved on, re-creating the orphan-work problem
    // under the exact throttling scenario this PR addresses.
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

// Fetch ALL ports globally in one paginated pass, grouped by ISO3.
// Replaces 240× per-country queries with a handful of pages. Returns
// Map<iso3, Map<portId, { lat, lon }>>.
//
// IMPORTANT: ArcGIS FeatureServer can cap responses below the requested
// resultRecordCount (PortWatch_ports_database caps at 1000 despite
// PAGE_SIZE=2000). Advancing by PAGE_SIZE silently skips the rows between
// the server cap and PAGE_SIZE. Advance by the actual features.length.
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
    body = await fetchWithTimeout(`${EP4_BASE}?${params}`, { signal });
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
    if (features.length === 0) break; // defensive: ETL=true + 0 features would infinite-loop
    offset += features.length;
  } while (body.exceededTransferLimit);
  return byIso3;
}

// Stream-aggregate ALL activity rows into per-port running counters.
// Replaces 174× per-country WHERE=ISO3 round-trips (which hit ~90s each at
// concurrency 12, far exceeding the 420s section budget even when none of
// them hung) with a single sequential loop of ~150-200 pages that completes
// comfortably inside the section budget. Also eliminates the `Invalid query
// parameters` errors we saw in prod for BRA/IDN/NGA on the per-country
// filter: the global WHERE has no ISO3 equality, so those failure modes
// disappear.
//
// Memory: each page's features are folded into Map<iso3, Map<portId, Accum>>
// and discarded. We never materialise the full 180k+ rows at once; only
// ~2000 accumulators (≈100 bytes each = ~200KB) live across pages. Review
// feedback on PR #3225 flagged the prior shape (Map<iso3, Feature[]>) as an
// OOM risk on the 1GB Railway container — this addresses it.
//
// Returns Map<iso3, Map<portId, PortAccum>>. Aborts between pages when
// signal.aborted is set.
async function fetchAndAggregateActivity(since, { signal, progress } = {}) {
  const now = Date.now();
  const cutoff30 = now - 30 * 86400000;
  const cutoff60 = now - 60 * 86400000;
  const cutoff7 = now - 7 * 86400000;

  const accumByIso3 = new Map();
  let offset = 0;
  let body;
  let page = 0;
  const t0 = Date.now();
  let totalRows = 0;

  do {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    const params = new URLSearchParams({
      where: `date > ${epochToTimestamp(since)}`,
      outFields: 'portid,portname,ISO3,date,portcalls_tanker,import_tanker,export_tanker',
      // ArcGIS returns geometry by default (~100-200KB per page). We only
      // need attributes — skip geometry to shave tens of MB off the wire
      // across ~150-200 pages on the perf-critical path (PR #3225 review).
      returnGeometry: 'false',
      orderByFields: 'portid ASC,date ASC',
      resultRecordCount: String(PAGE_SIZE),
      resultOffset: String(offset),
      outSR: '4326',
      f: 'json',
    });
    body = await fetchWithTimeout(`${EP3_BASE}?${params}`, { signal });
    const features = body.features ?? [];
    for (const f of features) {
      const a = f.attributes;
      if (!a || a.portid == null || !a.ISO3 || a.date == null) continue;
      const iso3 = String(a.ISO3);
      const portId = String(a.portid);
      // ArcGIS changed date field to esriFieldTypeDateOnly — returns ISO
      // string "YYYY-MM-DD", not epoch ms. Same parse as the prior per-row
      // code, just done inline here so we can fold without keeping the row.
      const date = typeof a.date === 'number' ? a.date : Date.parse(a.date + 'T12:00:00Z');
      const calls = Number(a.portcalls_tanker ?? 0);
      const imports = Number(a.import_tanker ?? 0);
      const exports_ = Number(a.export_tanker ?? 0);

      let countryMap = accumByIso3.get(iso3);
      if (!countryMap) { countryMap = new Map(); accumByIso3.set(iso3, countryMap); }

      let acc = countryMap.get(portId);
      if (!acc) {
        // First time we see this port — capture its name. Rows arrive in
        // (portid ASC, date ASC) order, so this matches the old behaviour
        // where `rows[0].portname` was the earliest row's portname.
        acc = {
          portname: String(a.portname || ''),
          last30_calls: 0, last30_count: 0, last30_import: 0, last30_export: 0,
          prev30_calls: 0,
          last7_calls: 0, last7_count: 0,
        };
        countryMap.set(portId, acc);
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
    page++;
    totalRows += features.length;
    if (progress) {
      progress.pages = page;
      progress.countries = accumByIso3.size;
    }
    if (page === 1 || page % ACTIVITY_LOG_EVERY === 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  [port-activity]   activity page ${page}: +${features.length} rows (${accumByIso3.size} countries, ${totalRows} total rows, ${elapsed}s)`);
    }
    if (features.length === 0) break;
    offset += features.length;
  } while (body.exceededTransferLimit);
  console.log(`  [port-activity] Activity folded: ${page} pages, ${totalRows} rows, ${accumByIso3.size} countries (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  return accumByIso3;
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
// can report which stage was running and how far into it we got.
export async function fetchAll(progress, { signal } = {}) {
  const { iso3ToIso2 } = createCountryResolvers();
  const since = Date.now() - HISTORY_DAYS * 86400000;

  if (progress) progress.stage = 'refs';
  console.log('  [port-activity] Fetching global port reference (EP4)...');
  const t0 = Date.now();
  const refsByIso3 = await fetchAllPortRefs({ signal });
  console.log(`  [port-activity] Refs loaded: ${refsByIso3.size} countries with ports (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  if (progress) progress.stage = 'activity';
  console.log(`  [port-activity] Fetching + aggregating global activity (${HISTORY_DAYS}d history, EP3)...`);
  const accumByIso3 = await fetchAndAggregateActivity(since, { signal, progress });

  if (progress) progress.stage = 'compute';
  const eligibleIso3 = [...refsByIso3.keys()].filter(iso3 => iso3ToIso2.has(iso3));
  const skipped = refsByIso3.size - eligibleIso3.length;
  console.log(`  [port-activity] Finalising ports for ${eligibleIso3.length} eligible countries (skipping ${skipped} unmapped iso3)`);

  const countryData = new Map();
  let missingActivity = 0;
  for (const iso3 of eligibleIso3) {
    const accum = accumByIso3.get(iso3);
    if (!accum || accum.size === 0) { missingActivity++; continue; }
    const ports = finalisePortsForCountry(accum, refsByIso3.get(iso3));
    if (!ports.length) continue;
    const iso2 = iso3ToIso2.get(iso3);
    countryData.set(iso2, { iso2, ports, fetchedAt: new Date().toISOString() });
  }

  if (missingActivity > 0) {
    console.log(`  [port-activity] ${missingActivity} eligible countries had no activity rows in the global dataset`);
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

  // Mutated in-place by fetchAll() so the SIGTERM handler can report which
  // stage was running and how far into the global paginator we got.
  const progress = { stage: 'starting', pages: 0, countries: 0 };

  // AbortController plumbed through fetchAll → fetchAllActivityRows →
  // fetchWithTimeout → _proxy-utils so a SIGTERM kill (or bundle-runner
  // grace-window escalation) actually stops any in-flight HTTP work
  // instead of leaving orphan requests running into the SIGKILL.
  const shutdownController = new AbortController();

  // Bundle-runner SIGKILLs via SIGTERM → SIGKILL on timeout. Release the lock
  // and extend existing TTLs synchronously(ish) so the next cron tick isn't
  // blocked for up to 30 min and the Redis snapshot doesn't evaporate.
  let sigHandled = false;
  const onSigterm = async () => {
    if (sigHandled) return;
    sigHandled = true;
    try { shutdownController.abort(new Error('SIGTERM')); } catch {}
    console.error(
      `  [port-activity] SIGTERM during stage=${progress.stage} (pages=${progress.pages}, countries=${progress.countries})`,
    );
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
    // Read previous snapshot first — needed for both degradation guard and error TTL extension.
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
