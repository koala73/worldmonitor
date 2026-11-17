#!/usr/bin/env node

// @ts-check

// Extended bilateral HS4 headings: rubber, cocoa, coconut and palm kernel oil,
// fruit, fish and seafood, processed food and oleochemicals, for every
// reporter. Same source, route and row shapes as seed-comtrade-bilateral-hs4,
// but its own keys, seed-meta and monthly tick:
//
// - Own keys (comtrade:bilateral-hs4-ext:{iso2}:v1 and its partners sibling),
//   because three scorers and two bulk readers pull every core country key in
//   one pipeline under a 4.5 MB ceiling. Only get-country-products reads these.
// - Own tick (the 15th, see scripts/railway-services.json), because UN
//   Comtrade's free subscription is 500 calls per DAY and the core run on the
//   1st already spends most of it. The catalogue is one batch, so a full pass
//   is ~197 calls.
// - No world-exports or LNG snapshot: those belong to the core run.

import {
  acquireLockSafely,
  extendExistingTtl,
  loadEnvFile,
  logSeedResult,
  releaseLock,
  sleep,
} from './_seed-utils.mjs';
import { EXT_HS4_BATCH, EXT_HS4_CODES, groupExtByProduct, toCanonicalProduct, toPartnersProduct, comtradeFailureState } from './shared/comtrade.mjs';
import {
  COMTRADE_ROUTE,
  MAX_CONSECUTIVE_RATE_LIMITED_FETCHES,
  MAX_PIPELINE_BYTES,
  MAX_PIPELINE_COMMANDS,
  MAX_PRESERVE_RUNS,
  fetchBilateral,
  orderCountriesForRun,
  periodCandidates,
  rateLimitStreak,
  redisPipeline,
  reporterRoster,
  reporterUnCode,
  resetRateLimitStreak,
} from './seed-comtrade-bilateral-hs4.mjs';

loadEnvFile(import.meta.url);

export const META_KEY = 'seed-meta:comtrade:bilateral-hs4-ext';
export const KEY_PREFIX = 'comtrade:bilateral-hs4-ext:';
export const PARTNERS_KEY_PREFIX = 'comtrade:bilateral-hs4-ext-partners:';
// Durable "has ever published" marker read by /api/health (ACTIVATION_MARKERS):
// set with no TTL once a run writes at least one country, so the probe stays
// soft until the first real run and alarms normally afterwards.
export const ACTIVATION_KEY = 'seed-activated:comtrade:bilateral-hs4-ext';
const TTL_SECONDS = 3456000; // 40d: monthly cadence + 9d slack, as the core run
const LOCK_DOMAIN = 'comtrade:bilateral-hs4-ext';
const LOCK_TTL_MS = 30 * 60 * 1000;
// Same gate as the core run: shorter than the shortest month, so a scheduled
// tick is never skipped, and long enough that a stuck schedule cannot spend
// the daily quota on repeat runs. FORCE_RESEED=true bypasses it.
export const FRESHNESS_GATE_MS = 24 * 24 * 60 * 60 * 1000;
export const SEED_META_TTL_SECONDS = Math.max(TTL_SECONDS, Math.ceil(FRESHNESS_GATE_MS / 1000) + 86_400);
// One request per reporter, ~197 reporters. The preview route's fallback
// period can double a reporter's cost; the cap keeps a run under the 500/day
// quota with room for the other keyed jobs that share it.
export const REQUEST_BUDGET = Number(process.env.COMTRADE_EXT_REQUEST_BUDGET) || 260;
// Same deliberately loose floor as the core run (110 of 197 reporters). Keep
// in step with api/health.js and api/seed-health.js.
export const MIN_COUNTRY_COVERAGE = 110;

/** @param {number} writtenCount @returns {'ok' | 'partial'} */
export function coverageStatus(writtenCount) {
  return writtenCount >= MIN_COUNTRY_COVERAGE ? 'ok' : 'partial';
}

let _paceSleep = sleep;
/** Tests swap the pacing sleep for a no-op; null restores it. */
export function __setPaceSleepForTests(fn) { _paceSleep = typeof fn === 'function' ? fn : sleep; }

/** The previous run's meta, fail-open to "no evidence". */
async function readMeta() {
  try {
    const result = await redisPipeline([['GET', META_KEY]]);
    const raw = Array.isArray(result) ? result[0]?.result : null;
    return raw && typeof raw === 'string' ? JSON.parse(raw) : null;
  } catch (err) {
    console.warn(`[bilateral-hs4-ext] seed-meta read failed (fail-open): ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

const isRecord = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {{ requestBudget?: number, now?: number }} [options]
 */
export async function main({ requestBudget = REQUEST_BUDGET, now = Date.now() } = {}) {
  const startedAt = Date.now();
  const runId = `${LOCK_DOMAIN}:${startedAt}`;
  const budget = Number.isFinite(requestBudget) && requestBudget > 0 ? Math.floor(requestBudget) : REQUEST_BUDGET;

  const priorMeta = await readMeta();
  const priorFetchedAt = Number(priorMeta?.fetchedAt);
  if (!process.env.FORCE_RESEED && Number.isFinite(priorFetchedAt) && now - priorFetchedAt < FRESHNESS_GATE_MS) {
    console.log(`[bilateral-hs4-ext] seed-meta is ${((now - priorFetchedAt) / 86_400_000).toFixed(1)}d old (gate=${FRESHNESS_GATE_MS / 86_400_000}d) — skipping (set FORCE_RESEED=true to override)`);
    return;
  }

  const prior = {
    streaks: isRecord(priorMeta?.preserveStreaks) ? priorMeta.preserveStreaks : {},
    coverage: isRecord(priorMeta?.countryCoverage) ? priorMeta.countryCoverage : null,
  };
  const countries = orderCountriesForRun(reporterRoster(), prior);
  const canonicalKey = (iso2) => `${KEY_PREFIX}${iso2}:v1`;
  const partnersKey = (iso2) => `${PARTNERS_KEY_PREFIX}${iso2}:v1`;
  const allKeys = countries.flatMap(([iso2]) => [canonicalKey(iso2), partnersKey(iso2)]);

  const lock = await acquireLockSafely(LOCK_DOMAIN, runId, LOCK_TTL_MS, { label: LOCK_DOMAIN });
  if (lock.skipped) {
    await extendExistingTtl([...allKeys, META_KEY], TTL_SECONDS)
      .catch(e => console.warn('[bilateral-hs4-ext] TTL extension (skipped) failed:', e.message));
    return;
  }
  if (!lock.locked) {
    console.log('[bilateral-hs4-ext] Lock held, skipping');
    return;
  }

  const PERIODS = periodCandidates(COMTRADE_ROUTE.usePublicApi);
  const countryCoverage = Object.fromEntries(countries.map(([iso2]) => [iso2, { state: 'not_attempted' }]));
  const writeMeta = async (count, status, preserveStreaks = {}) => {
    const meta = JSON.stringify({ fetchedAt: Date.now(), recordCount: count, status, preserveStreaks, requestedHs4s: EXT_HS4_CODES, countryCoverage });
    await redisPipeline([['SET', META_KEY, meta, 'EX', String(SEED_META_TTL_SECONDS)]])
      .catch(e => console.warn('[bilateral-hs4-ext] Failed to write seed-meta:', e.message));
  };

  resetRateLimitStreak();

  try {
    console.log(`[bilateral-hs4-ext] Fetching ${EXT_HS4_CODES.length} extended headings for ${countries.length} countries [${COMTRADE_ROUTE.source}]...`);
    const commands = [];
    const writtenKeys = new Set();
    let pendingBytes = 0;
    let writtenCount = 0;
    let failedCount = 0;
    let requestCount = 0;
    let budgetExhausted = false;
    const reserveRequest = () => {
      if (requestCount >= budget) {
        budgetExhausted = true;
        throw new Error(`Comtrade request budget reached (${requestCount}/${budget})`);
      }
      requestCount++;
    };
    const queueWrite = (key, payload) => {
      commands.push(['SET', key, payload, 'EX', String(TTL_SECONDS)]);
      pendingBytes += payload.length;
      writtenKeys.add(key);
    };

    for (let i = 0; i < countries.length; i++) {
      const [iso2] = countries[i];
      const unCode = reporterUnCode(iso2);
      if (!unCode) {
        console.warn(`  ${iso2}: no UN code, skipping`);
        continue;
      }
      if (requestCount + 1 > budget) {
        budgetExhausted = true;
        console.warn(`[bilateral-hs4-ext] Request budget reached (${requestCount}/${budget}) before ${iso2}; writing the partial result.`);
        break;
      }
      if (requestCount > 0) await _paceSleep(COMTRADE_ROUTE.interRequestDelayMs);

      let rowCounts = [];
      const recordRowCount = n => rowCounts.push(n);
      try {
        let records = [];
        let usedPeriod = PERIODS[0];
        for (let p = 0; p < PERIODS.length; p++) {
          if (p > 0) {
            if (requestCount + 1 > budget) break;
            await _paceSleep(COMTRADE_ROUTE.interRequestDelayMs);
          }
          usedPeriod = PERIODS[p];
          rowCounts = [];
          console.log(`  [${i + 1}/${countries.length}] ${iso2} (period ${usedPeriod})...`);
          records = await fetchBilateral(unCode, EXT_HS4_BATCH, usedPeriod, reserveRequest, recordRowCount);
          if (records.length > 0) break;
        }

        const products = groupExtByProduct(records, Number(String(usedPeriod).split(',')[0]));
        countryCoverage[iso2] = { state: products.length ? 'observed' : 'no_records', attemptedAt: new Date().toISOString(), missingHs4s: EXT_HS4_CODES.filter(code => !products.some(p => p.hs4 === code)), rowCounts };
        if (products.length > 0) {
          const fetchedAt = new Date().toISOString();
          const base = { iso2, fetchedAt, source: COMTRADE_ROUTE.source, requestedHs4s: EXT_HS4_CODES };
          queueWrite(canonicalKey(iso2), JSON.stringify({ ...base, products: products.map(toCanonicalProduct) }));
          queueWrite(partnersKey(iso2), JSON.stringify({ ...base, products: products.map(toPartnersProduct) }));
          writtenCount++;
          console.log(`    ${iso2}: ${products.length} products, ${records.length} records`);
        }
      } catch (err) {
        console.warn(`  [bilateral-hs4-ext] ${iso2}: fetch failed, preserving existing data: ${err.message}`);
        countryCoverage[iso2] = { state: comtradeFailureState(err), attemptedAt: new Date().toISOString(), rowCounts };
        failedCount++;
      }

      if (commands.length >= MAX_PIPELINE_COMMANDS || pendingBytes >= MAX_PIPELINE_BYTES) {
        await redisPipeline(commands.splice(0));
        pendingBytes = 0;
      }
      if (rateLimitStreak() >= MAX_CONSECUTIVE_RATE_LIMITED_FETCHES) {
        console.warn(`[bilateral-hs4-ext] ABORTING after ${rateLimitStreak()} consecutive refused fetches (HTTP 429/401/403); writing the partial result.`);
        break;
      }
      if (budgetExhausted) break;
    }

    if (commands.length > 0) await redisPipeline(commands);

    // Countries not rewritten keep their last good pair for at most
    // MAX_PRESERVE_RUNS runs, as in the core run.
    /** @type {Record<string, number>} */
    const preserveStreaks = {};
    const staleCountries = countries.map(([iso2]) => iso2).filter(iso2 => !writtenKeys.has(canonicalKey(iso2)));
    const existing = staleCountries.length > 0
      ? await redisPipeline(staleCountries.flatMap(iso2 => [['EXISTS', canonicalKey(iso2)], ['EXISTS', partnersKey(iso2)]]))
          .catch(e => {
            console.warn('[bilateral-hs4-ext] preserved-key EXISTS probe failed:', e.message);
            return null;
          })
      : null;
    const preservedKeys = [];
    for (let c = 0; c < staleCountries.length; c++) {
      if (!existing || Number(existing[c * 2]?.result) !== 1) continue;
      const iso2 = staleCountries[c];
      const streak = (Number(prior.streaks[iso2]) || 0) + 1;
      if (streak > MAX_PRESERVE_RUNS) continue;
      preserveStreaks[iso2] = streak;
      preservedKeys.push(canonicalKey(iso2));
      if (Number(existing[c * 2 + 1]?.result) === 1) preservedKeys.push(partnersKey(iso2));
    }
    if (preservedKeys.length > 0) {
      await extendExistingTtl(preservedKeys, TTL_SECONDS)
        .catch(e => console.warn('[bilateral-hs4-ext] TTL extension (preserved) failed:', e.message));
    }

    const status = coverageStatus(writtenCount);
    await writeMeta(writtenCount, status, preserveStreaks);
    if (writtenCount > 0) {
      await redisPipeline([['SET', ACTIVATION_KEY, '1']])
        .catch(e => console.warn('[bilateral-hs4-ext] Failed to write activation marker:', e.message));
    }
    logSeedResult('comtrade:bilateral-hs4-ext', writtenCount, Date.now() - startedAt, {
      countries: countries.length,
      failed: failedCount,
      hs4Codes: EXT_HS4_CODES.length,
      requests: requestCount,
      preserved: preservedKeys.length,
      status,
    });
    if (status === 'partial') console.warn(`[bilateral-hs4-ext] PARTIAL: seeded ${writtenCount} of ${countries.length} countries (floor ${MIN_COUNTRY_COVERAGE})`);
    console.log(`[bilateral-hs4-ext] Seeded ${writtenCount} country keys (${failedCount} failed, ${preservedKeys.length} preserved)`);
  } catch (err) {
    console.error('[bilateral-hs4-ext] Seed failed:', err.message || err);
    await extendExistingTtl([...allKeys, META_KEY], TTL_SECONDS)
      .catch(e => console.warn('[bilateral-hs4-ext] TTL extension failed:', e.message));
    await writeMeta(0, 'error');
    throw err;
  } finally {
    await releaseLock(LOCK_DOMAIN, runId);
  }
}

const isMain = process.argv[1]?.endsWith('seed-comtrade-bilateral-hs4-ext.mjs');
if (isMain) {
  const __runStartedAt = Date.now();
  main()
    .then(() => console.log(`\n=== Done (${Date.now() - __runStartedAt}ms) ===`))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
