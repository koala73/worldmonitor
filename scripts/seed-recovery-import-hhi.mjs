#!/usr/bin/env node

import { createRequire } from 'node:module';
import { loadEnvFile, CHROME_UA, runSeed, sleep, readSeedSnapshot, writeExtraKey } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const require = createRequire(import.meta.url);
const UN_TO_ISO2 = require('./shared/un-to-iso2.json');

const CANONICAL_KEY = 'resilience:recovery:import-hhi:v1';
// Separate checkpoint key so partial writes cannot overwrite the canonical
// key out of order. runSeed publishes the final authoritative snapshot at end.
const CHECKPOINT_KEY = 'resilience:recovery:import-hhi:checkpoint:v1';
const CACHE_TTL = 90 * 24 * 3600;
const CHECKPOINT_TTL = 45 * 24 * 3600;
// Resume TTL must outlive the bundle-runner freshness gate (intervalMs * 0.8
// ≈ 24 days for a 30-day interval), otherwise consecutive partial runs cannot
// accumulate coverage: a run that passes validate() with >=80 countries
// refreshes seed-meta, suppressing the next bundle run for ~24 days, by which
// point a shorter resume window would have already expired. 45 days gives a
// safe buffer across two bundle cycles. Comtrade annual data changes on a
// yearly cadence, so 45-day-old HHI values are still representative.
const RESUME_TTL_MS = 45 * 24 * 3600 * 1000;
// Checkpoint cadence: write partial progress every N successful fetches so a
// timeout or crash does not discard an entire run.
const CHECKPOINT_EVERY = 25;
// Lock TTL must cover the longest expected runtime. Bundle allows 30min; use
// the same so two overlapping cron invocations cannot both grab the lock.
const LOCK_TTL_MS = 30 * 60 * 1000;

// COMTRADE_API_KEYS is comma-separated; we rotate per request and also run
// one fetch per key in parallel (bounded concurrency = key count).
const COMTRADE_KEYS = (process.env.COMTRADE_API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);

if (COMTRADE_KEYS.length === 0) {
  console.error('[seed] import-hhi: COMTRADE_API_KEYS is required. Set the env var (comma-separated keys) and retry.');
}
const COMTRADE_URL = 'https://comtradeapi.un.org/data/v1/get/C/A/HS';
const PER_KEY_DELAY_MS = 600;

// UN M49 codes mostly match UN Comtrade reporterCodes, except for India (699,
// not 356) and Taiwan (490 "Other Asia, nes", not 158). Using M49 codes for
// these silently returns count:0 from the Comtrade API.
const COMTRADE_REPORTER_OVERRIDES = { IN: '699', TW: '490' };
const ISO2_TO_UN = Object.fromEntries(
  Object.entries(UN_TO_ISO2).map(([un, iso2]) => [iso2, un]),
);
for (const [iso2, code] of Object.entries(COMTRADE_REPORTER_OVERRIDES)) {
  ISO2_TO_UN[iso2] = code;
}

const ALL_REPORTERS = Object.values(UN_TO_ISO2).filter(c => c.length === 2);

// Parse Comtrade imports into partner-value rows for HHI. Picks the
// "best" year per reporter using a freshness-weighted rule:
//   (a) prefer years with more partner rows (proxy for data completeness);
//   (b) on ties, prefer the most recent year (newer data wins).
//
// PR 1 of plan 2026-04-24-002: period window is 4y (Y-1..Y-4). Late-
// reporters like UAE, Oman, Bahrain publish Comtrade 1-2y behind; with
// the original Y-1..Y-2 window their per-reporter query returned an
// empty set and they fell through to IMPUTED on importConcentration.
// The 4y window gives us a chance to pick a reporter's latest
// non-empty year without degrading the result for on-time reporters
// (they still get their newest year on the completeness tiebreak).
export function parseRecords(data) {
  const records = data?.data ?? [];
  if (!Array.isArray(records)) return { rows: [], year: null };
  const valid = records.filter(r => r && Number(r.primaryValue ?? 0) > 0);
  if (valid.length === 0) return { rows: [], year: null };
  const byPeriod = new Map();
  for (const r of valid) {
    const p = String(r.period ?? r.refPeriodId ?? '0');
    if (!byPeriod.has(p)) byPeriod.set(p, []);
    byPeriod.get(p).push(r);
  }
  let bestPeriod = '';
  let bestCount = 0;
  for (const [p, rows] of byPeriod) {
    const usable = rows.filter(r => {
      const pc = String(r.partnerCode ?? r.partner2Code ?? '000');
      return pc !== '0' && pc !== '000';
    }).length;
    if (usable > bestCount || (usable === bestCount && p > bestPeriod)) {
      bestCount = usable;
      bestPeriod = p;
    }
  }
  const rows = byPeriod.get(bestPeriod).map(r => ({
    partnerCode: String(r.partnerCode ?? r.partner2Code ?? '000'),
    primaryValue: Number(r.primaryValue ?? 0),
  }));
  const yearNum = Number(bestPeriod);
  return { rows, year: Number.isFinite(yearNum) ? yearNum : null };
}

// Comtrade transient 5xx (500/502/503/504) must be retried or the reporter
// silently drops from the HHI calc. The seeder's resume cache picks up
// still-missing reporters on the next run, so we cap retries to keep the
// 30-min bundle budget viable.
export function isTransientComtrade(status) {
  return status === 500 || status === 502 || status === 503 || status === 504;
}

// Injectable sleep so unit tests can exercise the classification loop without
// real 15s/5s/10s waits. Production defaults to the real sleep.
let _retrySleep = sleep;
export function __setSleepForTests(fn) { _retrySleep = typeof fn === 'function' ? fn : sleep; }

// 4-year period window. Plan 2026-04-24-002 §PR 1: late-reporters
// (UAE, Oman, Bahrain and others) publish Comtrade 1-2y behind G7, so
// a Y-1..Y-2 window silently drops them. Y-1..Y-4 keeps on-time
// reporters' latest-year data AND picks up late reporters' most
// recent published year.
const PERIOD_WINDOW_YEARS = 4;
export function buildPeriodParam(nowYear = new Date().getFullYear()) {
  const years = [];
  for (let i = 1; i <= PERIOD_WINDOW_YEARS; i++) years.push(nowYear - i);
  return years.join(',');
}

// Verbose mode: gated by IMPORT_HHI_VERBOSE=1 in env. Logs per-country
// HTTP status / row count / picked year. Diagnostic-only — keeps prod
// runs quiet but lets the next tick after a flaky-country investigation
// (2026-04-28 AE incident) capture exactly what shape Comtrade returns.
const IMPORT_HHI_VERBOSE = process.env.IMPORT_HHI_VERBOSE === '1';

export async function fetchImportsForReporter(reporterCode, apiKey) {
  const url = new URL(COMTRADE_URL);
  url.searchParams.set('reporterCode', reporterCode);
  url.searchParams.set('flowCode', 'M');
  url.searchParams.set('cmdCode', 'TOTAL');
  url.searchParams.set('period', buildPeriodParam());
  // Mirror seed-recovery-reexport-share.mjs (PR #3385): explicit
  // maxRecords cap so Comtrade doesn't apply its silent default
  // truncation. cmdCode=TOTAL with the 4y window typically returns
  // ~200 partners × 4 years = ~800 rows for an active reporter, so the
  // 250000 cap is generous belt-and-suspenders headroom.
  url.searchParams.set('maxRecords', '250000');

  async function once() {
    return fetch(url.toString(), {
      // Header auth (Ocp-Apim-Subscription-Key) instead of URL
      // searchParam — mirrors the audit-safe pattern reexport-share
      // shipped in PR #3385 and keeps the key out of any logged URL.
      // The reexport-share seeder uses this method successfully for AE
      // (verified 2026-04-28 — AE present in resilience:recovery:
      // reexport-share:v1 with reexportShareOfImports=0.355 for 2023).
      headers: {
        'Ocp-Apim-Subscription-Key': apiKey,
        'User-Agent': CHROME_UA,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(45_000),
    });
  }

  // Retry pattern mirrors seed-recovery-reexport-share.mjs (PR #3385):
  // 3 attempts total with exponential-ish backoff. Pre-fix this seeder
  // retried 429 once (15s wait) which left AE persistently absent from
  // the canonical key (verified 2026-04-28: 5/6 GCC reporters present,
  // AE alone missing). Comtrade rate-limits per-key per-hour and the
  // bundle runs reexport-share + import-hhi back-to-back on shared
  // keys, so by the time import-hhi reaches AE alphabetically the
  // bucket is sometimes drained — needs more retry budget than a
  // single 15s wait.
  const MAX_ATTEMPTS = 3;
  let resp = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    resp = await once();
    const isRateLimit = resp.status === 429;
    const isTransient = isTransientComtrade(resp.status);
    if (!isRateLimit && !isTransient) break;
    if (attempt === MAX_ATTEMPTS) break;
    // 429 → 2s, 4s; transient 5xx → 5s, 10s. Backoff scales with
    // attempt so later retries wait longer regardless of error type.
    const backoffMs = isRateLimit ? 2000 * attempt : 5000 * attempt;
    if (IMPORT_HHI_VERBOSE) {
      console.warn(`  [verbose] reporter=${reporterCode} attempt=${attempt}/${MAX_ATTEMPTS} status=${resp.status} backoff=${backoffMs}ms`);
    }
    await _retrySleep(backoffMs);
  }

  if (!resp.ok) {
    if (IMPORT_HHI_VERBOSE) {
      console.warn(`  [verbose] reporter=${reporterCode} FINAL status=${resp.status} — no records returned`);
    }
    return { records: [], year: null, status: resp.status };
  }
  const { rows, year } = parseRecords(await resp.json());
  if (IMPORT_HHI_VERBOSE) {
    console.log(`  [verbose] reporter=${reporterCode} status=${resp.status} parsedRows=${rows.length} year=${year ?? 'null'}`);
  }
  return { records: rows, year, status: resp.status };
}

export function computeHhi(records) {
  const validRecords = records.filter(r => r.partnerCode !== '0' && r.partnerCode !== '000');
  const byPartner = new Map();
  for (const r of validRecords) {
    byPartner.set(r.partnerCode, (byPartner.get(r.partnerCode) ?? 0) + r.primaryValue);
  }
  const totalValue = [...byPartner.values()].reduce((s, v) => s + v, 0);
  if (totalValue <= 0) return null;
  let hhi = 0;
  for (const partnerValue of byPartner.values()) {
    const share = partnerValue / totalValue;
    hhi += share * share;
  }
  return { hhi: Math.round(hhi * 10000) / 10000, partnerCount: byPartner.size };
}

// Serialize checkpoint writes across workers. Without this, two concurrent
// writeExtraKey() calls can land in Redis in the opposite order they were
// issued, rolling the snapshot backward and losing recovered countries.
let checkpointInFlight = false;
async function checkpoint(countries, progressRef) {
  if (checkpointInFlight) return;
  checkpointInFlight = true;
  try {
    await writeExtraKey(
      CHECKPOINT_KEY,
      { countries: { ...countries }, seededAt: new Date().toISOString() },
      CHECKPOINT_TTL,
    );
  } catch { /* non-fatal: next checkpoint or final publish will cover it */ }
  finally { checkpointInFlight = false; }
  console.log(`  [checkpoint ${progressRef.fetched}/${ALL_REPORTERS.length}] ${Object.keys(countries).length} countries in checkpoint`);
}

// Bounded-concurrency worker: each worker owns one API key, loops pulling
// reporters off a shared queue until empty. Concurrency == key count so we
// never have two in-flight requests competing for the same key's rate limit.
async function runWorker(apiKey, queue, countries, progressRef) {
  while (queue.length > 0) {
    const iso2 = queue.shift();
    if (!iso2) break;
    const unCode = ISO2_TO_UN[iso2];
    if (!unCode) { progressRef.skipped++; continue; }

    try {
      const { records, year, status } = await fetchImportsForReporter(unCode, apiKey);
      if (records.length === 0) {
        if (status && status !== 200) progressRef.errors++;
        progressRef.skipped++;
      } else {
        const result = computeHhi(records);
        if (result === null) {
          progressRef.skipped++;
        } else {
          countries[iso2] = {
            hhi: result.hhi,
            concentrated: result.hhi > 0.25,
            partnerCount: result.partnerCount,
            // `year` is the reporter's latest non-empty Comtrade year inside
            // the 4y window. Publication-lag auditors (operators + the
            // cohort-sanity audit at scripts/audit-resilience-cohorts.mjs)
            // read this to see which reporters are 2-3y stale vs current.
            year,
            fetchedAt: new Date().toISOString(),
          };
          progressRef.fetched++;

          // Checkpoint every N successes. Serialized via checkpointInFlight so
          // a slow earlier write cannot overwrite a newer one.
          if (progressRef.fetched % CHECKPOINT_EVERY === 0) {
            await checkpoint(countries, progressRef);
          }
        }
      }
    } catch (err) {
      console.warn(`  ${iso2}: fetch failed: ${err.message}`);
      progressRef.errors++;
      progressRef.skipped++;
    }

    // Small per-key delay to stay under Comtrade's per-key rate limit.
    await sleep(PER_KEY_DELAY_MS);
  }
}

async function fetchImportHhi() {
  if (COMTRADE_KEYS.length === 0) return { countries: {}, seededAt: new Date().toISOString() };

  // Resume: prefer the checkpoint key (freshest partial state), then fall back
  // to the canonical snapshot. Legacy snapshots lack per-country fetchedAt —
  // migrate by treating the top-level seededAt as the effective fetchedAt.
  const [checkpoint, canonical] = await Promise.all([
    readSeedSnapshot(CHECKPOINT_KEY),
    readSeedSnapshot(CANONICAL_KEY),
  ]);
  const cutoffMs = Date.now() - RESUME_TTL_MS;
  const countries = {};
  let resumed = 0;
  for (const source of [checkpoint, canonical]) {
    if (!source?.countries) continue;
    const fallbackTs = source.seededAt ? Date.parse(source.seededAt) : NaN;
    for (const [iso2, entry] of Object.entries(source.countries)) {
      if (countries[iso2]) continue; // checkpoint wins over canonical
      const perEntry = entry?.fetchedAt ? Date.parse(entry.fetchedAt) : NaN;
      const ts = Number.isFinite(perEntry) ? perEntry : fallbackTs;
      if (Number.isFinite(ts) && ts >= cutoffMs) {
        countries[iso2] = entry;
        resumed++;
      }
    }
  }

  const todo = ALL_REPORTERS.filter(iso2 => !countries[iso2]);
  console.log(`[seed] import-hhi: resuming with ${resumed} fresh entries, fetching ${todo.length} reporters (${COMTRADE_KEYS.length} key(s), concurrency=${COMTRADE_KEYS.length})`);

  const progressRef = { fetched: 0, skipped: 0, errors: 0 };
  // Single shared queue — workers race to shift() so each reporter is fetched once.
  const queue = [...todo];
  const workers = COMTRADE_KEYS.map(key => runWorker(key, queue, countries, progressRef));
  await Promise.all(workers);

  console.log(`[seed] import-hhi: ${progressRef.fetched} fetched, ${progressRef.skipped} skipped, ${progressRef.errors} errors, ${Object.keys(countries).length} total (incl. resumed)`);
  return { countries, seededAt: new Date().toISOString() };
}

// Note: worker queue is shared mutably — simplest dispatcher. Each worker
// shifts until empty; no coordination needed because Array.shift is atomic
// in single-threaded Node.js.
function validate(data) {
  return typeof data?.countries === 'object' && Object.keys(data.countries).length >= 80;
}

export function declareRecords(data) {
  return Object.keys(data?.countries || {}).length;
}

if (process.argv[1]?.endsWith('seed-recovery-import-hhi.mjs')) {
  runSeed('resilience', 'recovery:import-hhi', CANONICAL_KEY, fetchImportHhi, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    lockTtlMs: LOCK_TTL_MS,
    sourceVersion: `comtrade-hhi-${new Date().getFullYear()}`,
    recordCount: (data) => Object.keys(data?.countries ?? {}).length,
  
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 86400,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
