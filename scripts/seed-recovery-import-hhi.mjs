#!/usr/bin/env node

import { createRequire } from 'node:module';
import { loadEnvFile, CHROME_UA, runSeed, sleep, readSeedSnapshot, writeExtraKey } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const require = createRequire(import.meta.url);
const UN_TO_ISO2 = require('./shared/un-to-iso2.json');

const CANONICAL_KEY = 'resilience:recovery:import-hhi:v1';
const CACHE_TTL = 90 * 24 * 3600;
// Resume TTL: skip reporters fetched within last 14 days. Seeder runs monthly,
// so two consecutive runs can fully cover the world even if each only finishes
// ~half the reporters before the bundle timeout.
const RESUME_TTL_MS = 14 * 24 * 3600 * 1000;
// Checkpoint cadence: write partial progress every N successful fetches so a
// timeout or crash does not discard an entire run.
const CHECKPOINT_EVERY = 25;

// COMTRADE_API_KEYS is comma-separated; we rotate per request and also run
// one fetch per key in parallel (bounded concurrency = key count).
const COMTRADE_KEYS = (process.env.COMTRADE_API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);

if (COMTRADE_KEYS.length === 0) {
  console.error('[seed] import-hhi: COMTRADE_API_KEYS is required. Set the env var (comma-separated keys) and retry.');
}
const COMTRADE_URL = 'https://comtradeapi.un.org/data/v1/get/C/A/HS';
const PER_KEY_DELAY_MS = 600;

const ISO2_TO_UN = Object.fromEntries(
  Object.entries(UN_TO_ISO2).map(([un, iso2]) => [iso2, un]),
);

const ALL_REPORTERS = Object.values(UN_TO_ISO2).filter(c => c.length === 2);

function parseRecords(data) {
  const records = data?.data ?? [];
  if (!Array.isArray(records)) return [];
  const valid = records.filter(r => r && Number(r.primaryValue ?? 0) > 0);
  if (valid.length === 0) return [];
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
  return byPeriod.get(bestPeriod).map(r => ({
    partnerCode: String(r.partnerCode ?? r.partner2Code ?? '000'),
    primaryValue: Number(r.primaryValue ?? 0),
  }));
}

async function fetchImportsForReporter(reporterCode, apiKey) {
  const url = new URL(COMTRADE_URL);
  url.searchParams.set('reporterCode', reporterCode);
  url.searchParams.set('flowCode', 'M');
  url.searchParams.set('cmdCode', 'TOTAL');
  url.searchParams.set('period', `${new Date().getFullYear() - 1},${new Date().getFullYear() - 2}`);
  url.searchParams.set('subscription-key', apiKey);

  const resp = await fetch(url.toString(), {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(45_000),
  });

  if (resp.status === 429) {
    // Short backoff on 429 — 60s is too long when the overall bundle budget is tight.
    // We only retry once; subsequent 429s count as a skip and the resume cache picks
    // them up on the next run.
    await sleep(15_000);
    const retry = await fetch(url.toString(), {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(45_000),
    });
    if (!retry.ok) return { records: [], status: retry.status };
    return { records: parseRecords(await retry.json()), status: retry.status };
  }

  if (!resp.ok) return { records: [], status: resp.status };
  return { records: parseRecords(await resp.json()), status: resp.status };
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
      const { records, status } = await fetchImportsForReporter(unCode, apiKey);
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
            fetchedAt: new Date().toISOString(),
          };
          progressRef.fetched++;

          // Checkpoint to Redis every N successes so a crash does not lose work.
          if (progressRef.fetched % CHECKPOINT_EVERY === 0) {
            await writeExtraKey(CANONICAL_KEY, { countries, seededAt: new Date().toISOString() }, CACHE_TTL).catch(() => null);
            console.log(`  [checkpoint ${progressRef.fetched}/${ALL_REPORTERS.length}] ${iso2}: HHI=${result.hhi} (${result.partnerCount} partners)`);
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

  // Resume: reuse fresh entries from the last run so we only refetch what's
  // missing or stale. Comtrade annual data changes slowly; 14 days is safe.
  const existing = await readSeedSnapshot(CANONICAL_KEY);
  const cutoffMs = Date.now() - RESUME_TTL_MS;
  const countries = {};
  let resumed = 0;
  if (existing?.countries) {
    for (const [iso2, entry] of Object.entries(existing.countries)) {
      const ts = entry?.fetchedAt ? Date.parse(entry.fetchedAt) : NaN;
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

if (process.argv[1]?.endsWith('seed-recovery-import-hhi.mjs')) {
  runSeed('resilience', 'recovery:import-hhi', CANONICAL_KEY, fetchImportHhi, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: `comtrade-hhi-${new Date().getFullYear()}`,
    recordCount: (data) => Object.keys(data?.countries ?? {}).length,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
