#!/usr/bin/env node
// Seed UN Comtrade strategic commodity trade flows (issue #2045).
// Uses the public preview endpoint — no auth required.

import { loadEnvFile, CHROME_UA, runSeed, sleep, writeExtraKey } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'comtrade:flows:v1';
const CACHE_TTL = 259200; // 72h = 3× daily interval
export const KEY_PREFIX = 'comtrade:flows';
const COMTRADE_BASE = 'https://comtradeapi.un.org/public/v1';
const INTER_REQUEST_DELAY_MS = 3_000;
const ANOMALY_THRESHOLD = 0.30; // 30% YoY change
// Require at least this fraction of (reporter × commodity) pairs to return
// non-empty flows. Guards against an entire reporter silently flatlining
// (e.g., wrong reporterCode → HTTP 200 with count:0 for every commodity).
// Global coverage floor — overall populated/total must be ≥ this.
const MIN_COVERAGE_RATIO = 0.70;
// Per-reporter coverage floor — each reporter must have ≥ this fraction of
// its commodities populated. Prevents the "India/Taiwan flatlines entirely"
// failure mode: with 6 reporters × 5 commodities, losing one full reporter
// is only 5/30 missing (83% global coverage → passes MIN_COVERAGE_RATIO),
// but 0/5 per-reporter coverage for the dead one blocks publish here.
const MIN_PER_REPORTER_RATIO = 0.40; // at least 2 of 5 commodities per reporter

// Strategic reporters: US, China, Russia, Iran, India, Taiwan
const REPORTERS = [
  { code: '842', name: 'USA' },
  { code: '156', name: 'China' },
  { code: '643', name: 'Russia' },
  { code: '364', name: 'Iran' },
  { code: '699', name: 'India' },
  { code: '490', name: 'Taiwan' },
];

// Strategic HS commodity codes
const COMMODITIES = [
  { code: '2709', desc: 'Crude oil' },
  { code: '2711', desc: 'LNG / natural gas' },
  { code: '7108', desc: 'Gold' },
  { code: '8542', desc: 'Semiconductors' },
  { code: '9301', desc: 'Arms / military equipment' },
];

// Comtrade preview regularly hits transient 5xx (500/502/503/504). Without
// retry each (reporter,commodity) pair that drew a 5xx is silently lost.
export function isTransientComtrade(status) {
  return status === 500 || status === 502 || status === 503 || status === 504;
}

// Injectable sleep so unit tests can exercise the retry loop without real
// 5s/15s waits. Production defaults to the real sleep.
let _retrySleep = sleep;
export function __setSleepForTests(fn) { _retrySleep = typeof fn === 'function' ? fn : sleep; }

export async function fetchFlows(reporter, commodity) {
  const url = new URL(`${COMTRADE_BASE}/preview/C/A/HS`);
  url.searchParams.set('reporterCode', reporter.code);
  url.searchParams.set('cmdCode', commodity.code);
  url.searchParams.set('flowCode', 'X,M'); // exports + imports

  async function once() {
    return fetch(url.toString(), {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  }

  // Classification loop: up to two transient-5xx retries (5s, 15s) then give up.
  let transientRetries = 0;
  const MAX_TRANSIENT_RETRIES = 2;
  let resp;
  while (true) {
    resp = await once();
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

async function fetchAllFlows() {
  const allFlows = [];
  const perKeyFlows = {};

  for (let ri = 0; ri < REPORTERS.length; ri++) {
    for (let ci = 0; ci < COMMODITIES.length; ci++) {
      const reporter = REPORTERS[ri];
      const commodity = COMMODITIES[ci];
      const label = `${reporter.name}/${commodity.desc}`;

      if (ri > 0 || ci > 0) await sleep(INTER_REQUEST_DELAY_MS);
      console.log(`  Fetching ${label}...`);

      let flows = [];
      try {
        flows = await fetchFlows(reporter, commodity);
        console.log(`    ${flows.length} records`);
      } catch (err) {
        console.warn(`    ${label}: failed (${err.message})`);
      }

      allFlows.push(...flows);
      const key = `${KEY_PREFIX}:${reporter.code}:${commodity.code}`;
      perKeyFlows[key] = { flows, fetchedAt: new Date().toISOString() };
    }
  }

  const gate = checkCoverage(perKeyFlows, REPORTERS, COMMODITIES);
  console.log(`  Coverage: ${gate.populated}/${gate.total} (${(gate.globalRatio * 100).toFixed(0)}%) reporter×commodity pairs populated`);
  for (const r of gate.perReporter) {
    if (r.ratio < MIN_PER_REPORTER_RATIO) {
      console.warn(`    ${r.reporter} reporter ${r.code}: ${r.populated}/${r.total} (${(r.ratio * 100).toFixed(0)}%) — below per-reporter floor ${MIN_PER_REPORTER_RATIO}`);
    }
  }
  if (!gate.ok) throw new Error(gate.reason);

  return { flows: allFlows, perKeyFlows, fetchedAt: new Date().toISOString() };
}

/**
 * Pure coverage gate. Returns pass/fail + per-reporter breakdown.
 * Exported for unit testing — mocking 30+ fetches in fetchAllFlows is fragile,
 * and the failure mode the PR is trying to block lives here, not in fetchFlows.
 *
 * Blocks publish when EITHER: global ratio < MIN_COVERAGE_RATIO, OR any single
 * reporter's commodity coverage < MIN_PER_REPORTER_RATIO. The latter catches
 * the India/Taiwan-style "one reporter flatlines completely" case that passes
 * a global-only gate.
 */
export function checkCoverage(perKeyFlows, reporters, commodities) {
  const total = reporters.length * commodities.length;
  const populated = Object.values(perKeyFlows).filter((v) => (v.flows?.length ?? 0) > 0).length;
  const globalRatio = total > 0 ? populated / total : 0;

  const perReporter = reporters.map((r) => {
    const pop = commodities.filter((c) => (perKeyFlows[`${KEY_PREFIX}:${r.code}:${c.code}`]?.flows?.length ?? 0) > 0).length;
    return { reporter: r.name, code: r.code, populated: pop, total: commodities.length, ratio: commodities.length > 0 ? pop / commodities.length : 0 };
  });

  if (globalRatio < MIN_COVERAGE_RATIO) {
    return { ok: false, populated, total, globalRatio, perReporter, reason: `coverage ${populated}/${total} below global floor ${MIN_COVERAGE_RATIO}; refusing to publish partial snapshot` };
  }
  const dead = perReporter.find((r) => r.ratio < MIN_PER_REPORTER_RATIO);
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
