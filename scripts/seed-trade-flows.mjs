#!/usr/bin/env node
// Seed UN Comtrade strategic commodity trade flows (issue #2045).
// Uses the public preview endpoint — no auth required.

import { createRequire } from 'node:module';
import { loadEnvFile, CHROME_UA, runSeed, sleep, writeExtraKey } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'comtrade:flows:v1';
const CACHE_TTL = 259200; // 72h = 3× daily interval
export const KEY_PREFIX = 'comtrade:flows';
const COMTRADE_BASE = 'https://comtradeapi.un.org/public/v1';
const COMTRADE_PREVIEW_CLASSIFIER = 'HS'; // API route family; metadata tracks the active H6/HS2022 revision separately.
export const INTER_REQUEST_DELAY_MS = 3_000;
export const TRADE_FLOW_FETCH_PHASE_TIMEOUT_MS = 25 * 60 * 1000;
export const TRADE_FLOW_LOCK_TTL_MS = 30 * 60 * 1000;
export const TRADE_FLOW_RATE_LIMIT_RETRY_BUDGET = 3;
const ANOMALY_THRESHOLD = 0.30; // 30% YoY change
const CHINA_REPORTER_CODE = '156';
// Require at least this fraction of (reporter × commodity) pairs to return
// non-empty flows. Guards against an entire reporter silently flatlining
// (e.g., wrong reporterCode → HTTP 200 with count:0 for every commodity).
// Global coverage floor — overall populated/total must be ≥ this.
const MIN_COVERAGE_RATIO = 0.70;
// Per-reporter coverage floor — each REQUIRED reporter must have ≥ this fraction
// of its commodities populated. Prevents the "India/Taiwan flatlines entirely"
// failure mode: losing one full required reporter passes the global ratio but
// its zero-coverage reporter result blocks publish here.
const MIN_PER_REPORTER_RATIO = 0.40;

// Strategic reporters: required reporters first, then best-effort reporters.
// This order is load-bearing: a best-effort 429 circuit must never prevent a
// required reporter from being queried during the baseline stage.
// `required: false` reporters are best-effort: still fetched and published when
// they return data, but excluded from BOTH coverage floors. Russia (suspended
// UN Comtrade reporting post-2022) and Iran (sporadic) return 0 as reporters for
// every recent year, so gating on them makes the publish gate unsatisfiable and
// exit-75-crashes the seed on every run regardless of period.
const REPORTERS = [
  { code: '842', name: 'USA' },
  { code: '156', name: 'China' },
  { code: '699', name: 'India' },
  { code: '490', name: 'Taiwan' },
  { code: '643', name: 'Russia', required: false },
  { code: '364', name: 'Iran', required: false },
];
const REQUIRED_REPORTERS = REPORTERS.filter((reporter) => reporter.required !== false);
const BEST_EFFORT_REPORTERS = REPORTERS.filter((reporter) => reporter.required === false);

// Comtrade annual data lags. The preview endpoint accepts a SINGLE period and,
// when given NONE, defaults to the most-recent year present GLOBALLY — currently
// the fastest reporter (US) is a full year ahead of everyone else, so that
// default flatlines every other reporter and trips the coverage gate. (Multiple
// comma-separated periods return HTTP 400 on this endpoint.) Pin an explicit,
// uniform year instead: (y-2) is ~2 years old, so it is reliably final for all
// strategic reporters. (Single-year data means yoyChange stays 0 here, same as
// the pre-fix implicit-latest behavior — restoring true YoY needs a second call.)
export function recentPeriod(now = new Date(), lag = 2) {
  return String(now.getUTCFullYear() - lag);
}

// Candidate periods, freshest first. fetchAllFlows tries (y-2) and, only if its
// coverage gate fails, falls back to (y-3). This survives the year boundary:
// on Jan 1, (y-2) rolls to a fresher year the slower required reporters may not
// have filed yet — without the fallback the seed would exit-75-crash for weeks
// until they catch up. (y-3) is guaranteed-final and keeps the snapshot fresh
// enough (annual trade data is inherently ~2yr lagged).
export function candidatePeriods(now = new Date()) {
  return [recentPeriod(now, 2), recentPeriod(now, 3)];
}

const require = createRequire(import.meta.url);
const STRATEGIC_PRODUCT_METADATA = require('./shared/comtrade-strategic-products.json');
const COMMODITIES = STRATEGIC_PRODUCT_METADATA.products
  .filter((product) => product.tradeFlowCode)
  .map((product) => ({
    code: product.tradeFlowCode,
    desc: product.label,
    coverageStage: product.tradeFlowCoverageStage,
  }));
const BASELINE_COMMODITIES = COMMODITIES.filter((product) => product.coverageStage === 1);
const EXPANSION_COMMODITIES = COMMODITIES.filter((product) => product.coverageStage !== 1);
export const TRADE_FLOW_COVERAGE_CODES = BASELINE_COMMODITIES.map((product) => product.code);
export const TRADE_FLOW_MATRIX_SIZE = REPORTERS.length * COMMODITIES.length;

// Comtrade preview regularly hits transient 5xx (500/502/503/504). Without
// retry each (reporter,commodity) pair that drew a 5xx is silently lost.
export function isTransientComtrade(status) {
  return status === 500 || status === 502 || status === 503 || status === 504;
}

// Injectable sleep so unit tests can exercise the retry loop without real
// 5s/15s waits. Production defaults to the real sleep.
let _retrySleep = sleep;
export function __setSleepForTests(fn) { _retrySleep = typeof fn === 'function' ? fn : sleep; }

export async function fetchFlows(reporter, commodity, period = recentPeriod(), opts = {}) {
  const url = new URL(`${COMTRADE_BASE}/preview/C/A/${COMTRADE_PREVIEW_CLASSIFIER}`);
  url.searchParams.set('reporterCode', reporter.code);
  url.searchParams.set('cmdCode', commodity.code);
  url.searchParams.set('flowCode', 'X,M'); // exports + imports
  url.searchParams.set('period', period); // explicit lagged year; see recentPeriod()

  async function once() {
    return fetch(url.toString(), {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  }

  // Classification loop: one bounded 429 wait plus up to two transient-5xx
  // retries (5s, 15s), reclassifying every response before giving up.
  let rateLimitedOnce = false;
  let transientRetries = 0;
  const MAX_TRANSIENT_RETRIES = 2;
  let resp;
  while (true) {
    resp = await once();
    if (resp.status === 429 && !rateLimitedOnce) {
      const rateLimitBudget = opts.rateLimitBudget;
      if (rateLimitBudget && rateLimitBudget.remaining <= 0) {
        rateLimitBudget.exhausted = true;
        const error = new Error('Comtrade run-level 429 retry budget exhausted');
        error.code = 'COMTRADE_RATE_LIMIT_BUDGET_EXHAUSTED';
        error.nonRetryable = true;
        throw error;
      }
      if (rateLimitBudget) rateLimitBudget.remaining--;
      console.warn(`  HTTP 429 for reporter ${reporter.code} cmd ${commodity.code}, retrying in 60s...`);
      await _retrySleep(60_000);
      rateLimitedOnce = true;
      continue;
    }
    if (isTransientComtrade(resp.status) && transientRetries < MAX_TRANSIENT_RETRIES) {
      const delay = transientRetries === 0 ? 5_000 : 15_000;
      console.warn(`  transient HTTP ${resp.status} for reporter ${reporter.code} cmd ${commodity.code}, retrying in ${delay / 1000}s...`);
      await _retrySleep(delay);
      transientRetries++;
      continue;
    }
    break;
  }

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();

  // Comtrade preview returns { data: [...] } with annual records
  const records = data?.data ?? [];
  if (!Array.isArray(records)) return [];

  // The preview endpoint returns partner-level rows (one per counterparty).
  // Aggregate to World totals per (flowCode, year) by summing, so YoY is
  // computed against full-year totals. Keying on (flowCode, year) without
  // summing would silently drop every partner except the last one seen.
  const byFlowYear = new Map(); // key: `${flowCode}:${year}`
  for (const r of records) {
    const year = Number(r.period ?? r.refYear ?? r.refMonth?.slice(0, 4) ?? 0);
    if (!year) continue;
    const flowCode = String(r.flowCode ?? r.rgDesc ?? 'X');
    const val = Number(r.primaryValue ?? r.cifvalue ?? r.fobvalue ?? 0);
    const wt = Number(r.netWgt ?? 0);
    const mapKey = `${flowCode}:${year}`;
    const prev = byFlowYear.get(mapKey);
    if (prev) {
      prev.val += val;
      prev.wt += wt;
    } else {
      byFlowYear.set(mapKey, { year, flowCode, val, wt, partnerCode: '000', partnerName: 'World' });
    }
  }

  // Derive the set of (flowCode, year) pairs sorted for YoY lookup.
  const entries = Array.from(byFlowYear.values()).sort((a, b) => a.year - b.year || a.flowCode.localeCompare(b.flowCode));
  const flows = [];

  for (const cur of entries) {
    const prevKey = `${cur.flowCode}:${cur.year - 1}`;
    const prev = byFlowYear.get(prevKey);
    const yoyChange = prev && prev.val > 0 ? (cur.val - prev.val) / prev.val : 0;
    const isAnomaly = Math.abs(yoyChange) > ANOMALY_THRESHOLD;

    flows.push({
      reporterCode: reporter.code,
      reporterName: reporter.name,
      partnerCode: cur.partnerCode,
      partnerName: cur.partnerName,
      cmdCode: commodity.code,
      cmdDesc: commodity.desc,
      year: cur.year,
      tradeValueUsd: cur.val,
      netWeightKg: cur.wt,
      yoyChange,
      isAnomaly,
    });
  }

  return flows;
}

// Fetch one commodity stage for one annual `period`. The shared pacing state
// keeps the inter-request gap across stage and fallback-period boundaries.
async function fetchCommodityStage(period, reporters, commodities, pace, rateLimitBudget, pacingState) {
  const allFlows = [];
  const perKeyFlows = {};

  for (const reporter of reporters) {
    for (const commodity of commodities) {
      const label = `${reporter.name}/${commodity.desc}`;

      if (pacingState.requestCount > 0) await pace(INTER_REQUEST_DELAY_MS);
      pacingState.requestCount++;
      console.log(`  Fetching ${label} (period ${period})...`);

      let flows = [];
      try {
        flows = await fetchFlows(reporter, commodity, period, { rateLimitBudget });
        console.log(`    ${flows.length} records`);
      } catch (err) {
        console.warn(`    ${label}: failed (${err.message})`);
        if (err?.code === 'COMTRADE_RATE_LIMIT_BUDGET_EXHAUSTED') {
          return { allFlows, perKeyFlows, rateLimitBudgetExhausted: true };
        }
      }

      allFlows.push(...flows);
      const key = `${KEY_PREFIX}:${reporter.code}:${commodity.code}`;
      perKeyFlows[key] = { flows, fetchedAt: new Date().toISOString() };
    }
  }

  return { allFlows, perKeyFlows, rateLimitBudgetExhausted: false };
}

export async function fetchAllFlows(opts = {}) {
  const periods = opts.periods ?? candidatePeriods();
  const pace = opts.pace ?? sleep;
  const rateLimitBudget = opts.rateLimitBudget ?? {
    remaining: TRADE_FLOW_RATE_LIMIT_RETRY_BUDGET,
    exhausted: false,
  };
  const pacingState = { requestCount: 0 };

  let lastGate = null;
  for (let pi = 0; pi < periods.length; pi++) {
    const period = periods[pi];
    if (pi > 0) {
      console.log(`  Prior period failed coverage — falling back to period ${period}...`);
    }

    // Gate the proven baseline before any expansion probe can consume quota or
    // prevent the older fallback period from running.
    const requiredBaseline = await fetchCommodityStage(
      period,
      REQUIRED_REPORTERS,
      BASELINE_COMMODITIES,
      pace,
      rateLimitBudget,
      pacingState,
    );

    const gate = checkCoverage(requiredBaseline.perKeyFlows, REPORTERS, BASELINE_COMMODITIES);
    lastGate = gate;
    console.log(`  Coverage (period ${period}): ${gate.populated}/${gate.total} (${(gate.globalRatio * 100).toFixed(0)}%) required reporter×commodity pairs populated`);
    for (const r of gate.perReporter) {
      if (!r.required) {
        console.log(`    ${r.reporter} reporter ${r.code}: ${r.populated}/${r.total} (best-effort, not gated)`);
      } else if (r.ratio < MIN_PER_REPORTER_RATIO) {
        console.warn(`    ${r.reporter} reporter ${r.code}: ${r.populated}/${r.total} (${(r.ratio * 100).toFixed(0)}%) — below per-reporter floor ${MIN_PER_REPORTER_RATIO}`);
      }
    }

    if (!gate.ok && requiredBaseline.rateLimitBudgetExhausted) {
      const error = new Error(`Comtrade rate-limit budget exhausted before baseline coverage passed: ${gate.reason}`);
      error.code = 'COMTRADE_RATE_LIMIT_BUDGET_EXHAUSTED';
      error.nonRetryable = true;
      throw error;
    }
    if (!gate.ok) continue;

    if (requiredBaseline.rateLimitBudgetExhausted) {
      return {
        flows: requiredBaseline.allFlows,
        perKeyFlows: requiredBaseline.perKeyFlows,
        fetchedAt: new Date().toISOString(),
        period,
      };
    }

    const bestEffortBaseline = await fetchCommodityStage(
      period,
      BEST_EFFORT_REPORTERS,
      BASELINE_COMMODITIES,
      pace,
      rateLimitBudget,
      pacingState,
    );
    const baselineFlows = [...requiredBaseline.allFlows, ...bestEffortBaseline.allFlows];
    const baselinePerKeyFlows = {
      ...requiredBaseline.perKeyFlows,
      ...bestEffortBaseline.perKeyFlows,
    };
    if (bestEffortBaseline.rateLimitBudgetExhausted) {
      return {
        flows: baselineFlows,
        perKeyFlows: baselinePerKeyFlows,
        fetchedAt: new Date().toISOString(),
        period,
      };
    }

    const requiredExpansion = await fetchCommodityStage(
      period,
      REQUIRED_REPORTERS,
      EXPANSION_COMMODITIES,
      pace,
      rateLimitBudget,
      pacingState,
    );
    if (requiredExpansion.rateLimitBudgetExhausted) {
      return {
        flows: [...baselineFlows, ...requiredExpansion.allFlows],
        perKeyFlows: { ...baselinePerKeyFlows, ...requiredExpansion.perKeyFlows },
        fetchedAt: new Date().toISOString(),
        period,
      };
    }

    const bestEffortExpansion = await fetchCommodityStage(
      period,
      BEST_EFFORT_REPORTERS,
      EXPANSION_COMMODITIES,
      pace,
      rateLimitBudget,
      pacingState,
    );
    return {
      flows: [...baselineFlows, ...requiredExpansion.allFlows, ...bestEffortExpansion.allFlows],
      perKeyFlows: {
        ...baselinePerKeyFlows,
        ...requiredExpansion.perKeyFlows,
        ...bestEffortExpansion.perKeyFlows,
      },
      fetchedAt: new Date().toISOString(),
      period,
    };
  }

  throw new Error(lastGate?.reason ?? 'no candidate period produced sufficient coverage');
}

/**
 * Pure coverage gate. Returns pass/fail + per-reporter breakdown.
 * Exported for unit testing — mocking the full reporter-product matrix in
 * fetchAllFlows is fragile,
 * and the failure mode the PR is trying to block lives here, not in fetchFlows.
 *
 * Blocks publish when EITHER: global ratio < MIN_COVERAGE_RATIO, OR any single
 * reporter's commodity coverage < MIN_PER_REPORTER_RATIO. The latter catches
 * the India/Taiwan-style "one reporter flatlines completely" case that passes
 * a global-only gate.
 */
export function checkCoverage(perKeyFlows, reporters, commodities) {
  const commTotal = commodities.length;

  // Full breakdown (for logging). `required` defaults to true, so callers that
  // pass plain { code, name } reporters keep the original all-reporters gate.
  const perReporter = reporters.map((r) => {
    const pop = commodities.filter((c) => (perKeyFlows[`${KEY_PREFIX}:${r.code}:${c.code}`]?.flows?.length ?? 0) > 0).length;
    return {
      reporter: r.name,
      code: r.code,
      populated: pop,
      total: commTotal,
      ratio: commTotal > 0 ? pop / commTotal : 0,
      required: r.required !== false,
    };
  });

  // Both floors apply to REQUIRED reporters only. Best-effort reporters
  // (required:false) are still fetched and published when they return data,
  // but never block publish — see the REPORTERS note on Russia/Iran.
  const gated = perReporter.filter((r) => r.required);
  const total = gated.length * commTotal;
  const populated = gated.reduce((n, r) => n + r.populated, 0);
  const globalRatio = total > 0 ? populated / total : 0;

  const chinaReporter = perReporter.find((r) => r.code === CHINA_REPORTER_CODE);
  // China is independently load-bearing for this strategic-dependency feed.
  // Keep this separate from `required` so a future reporter policy change
  // cannot silently turn reporter 156 into best-effort coverage.
  if (!chinaReporter) {
    return {
      ok: false,
      populated,
      total,
      globalRatio,
      perReporter,
      reason: 'China reporter 156 missing from reporter coverage set',
    };
  }
  if (chinaReporter.ratio < MIN_PER_REPORTER_RATIO) {
    return {
      ok: false,
      populated,
      total,
      globalRatio,
      perReporter,
      reason: `China reporter 156 below per-reporter independent coverage floor: ${chinaReporter.populated}/${chinaReporter.total}`,
    };
  }

  if (globalRatio < MIN_COVERAGE_RATIO) {
    return { ok: false, populated, total, globalRatio, perReporter, reason: `coverage ${populated}/${total} below global floor ${MIN_COVERAGE_RATIO}; refusing to publish partial snapshot` };
  }
  const dead = gated.find((r) => r.ratio < MIN_PER_REPORTER_RATIO);
  if (dead) {
    return { ok: false, populated, total, globalRatio, perReporter, reason: `reporter ${dead.reporter} (${dead.code}) only ${dead.populated}/${dead.total} commodities — below per-reporter floor ${MIN_PER_REPORTER_RATIO}; refusing to publish snapshot with a flatlined reporter` };
  }
  return { ok: true, populated, total, globalRatio, perReporter, reason: null };
}

function validate(data) {
  return Array.isArray(data?.flows) && data.flows.length > 0;
}

function publishTransform(data) {
  const { perKeyFlows: _pkf, ...rest } = data;
  return rest;
}

async function afterPublish(data, _meta) {
  for (const [key, value] of Object.entries(data.perKeyFlows ?? {})) {
    if ((value.flows?.length ?? 0) > 0) {
      await writeExtraKey(key, value, CACHE_TTL);
    }
  }
}

// isMain guard so tests can import fetchFlows without triggering a real seed run.
export function declareRecords(data) {
  return Array.isArray(data?.flows) ? data.flows.length : 0;
}

if (process.argv[1]?.endsWith('seed-trade-flows.mjs')) {
  runSeed('trade', 'comtrade-flows', CANONICAL_KEY, fetchAllFlows, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    lockTtlMs: TRADE_FLOW_LOCK_TTL_MS,
    fetchPhaseTimeoutMs: TRADE_FLOW_FETCH_PHASE_TIMEOUT_MS,
    sourceVersion: 'comtrade-preview-v1',
    publishTransform,
    afterPublish,
  
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: 2880,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(0);
  });
}
