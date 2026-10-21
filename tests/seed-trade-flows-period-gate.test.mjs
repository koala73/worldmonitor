// Regression test for seed-trade-flows CRASHED-on-Railway incident (2026-07-02).
//
// Root cause (verified live against comtradeapi.un.org):
//   1. fetchFlows pinned NO `period`, so the Comtrade preview endpoint defaulted
//      to the single most-recent annual year present globally (2025). Only the
//      USA had filed 2025 annual HS data; China/India/Taiwan/Russia/Iran all
//      returned {count:0,data:[]}. Coverage collapsed to 5/30 (17%), the publish
//      gate refused the partial snapshot, and runSeed exited 75
//      (GRACEFUL_FETCH_FAILURE_EXIT_CODE) → Railway paints any non-zero exit CRASHED.
//   2. Russia (643) and Iran (364) return 0 for every recent year — they have
//      largely stopped reporting to UN Comtrade as reporters (Russia suspended
//      post-2022, Iran sporadic). Behind the 40% hard per-reporter floor they
//      make the gate structurally unsatisfiable regardless of period.
//
// Fix contract pinned here:
//   - fetchFlows requests an explicit lagged period (recentPeriod()).
//   - checkCoverage treats reporters with `required:false` as best-effort:
//     still fetched/published if present, but excluded from both coverage floors.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchFlows,
  fetchAllFlows,
  checkCoverage,
  KEY_PREFIX,
  TRADE_FLOW_COVERAGE_CODES,
  TRADE_FLOW_RATE_LIMIT_RETRY_BUDGET,
  __setSleepForTests,
} from '../scripts/seed-trade-flows.mjs';

const ORIGINAL_FETCH = globalThis.fetch;
let fetchCalls;

beforeEach(() => {
  fetchCalls = [];
  __setSleepForTests(async () => {});
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    return new Response(
      JSON.stringify({ data: [{ period: 2024, flowCode: 'X', primaryValue: 1, partnerCode: '000' }] }),
      { status: 200 },
    );
  };
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  __setSleepForTests();
});

// --- Defect 1: no explicit period → endpoint defaults to bleeding-edge year ---
test('fetchFlows pins an explicit lagged period (not the bleeding-edge default)', async () => {
  await fetchFlows({ code: '156', name: 'China' }, { code: '2709', desc: 'Crude' });
  const url = fetchCalls[0];
  assert.match(
    url,
    /[?&]period=/,
    'request must pin an explicit period so the endpoint does not default to the latest global year (which only the fastest reporter has filed)',
  );
  const lagYear = String(new Date().getUTCFullYear() - 2);
  assert.ok(url.includes(lagYear), `period window should include the newest safely-published year (${lagYear}); got: ${url}`);
});

test('fetchFlows uses the stable HS preview route while product metadata tracks HS2022', async () => {
  await fetchFlows({ code: '156', name: 'China' }, { code: '8542', desc: 'Semiconductors' }, '2024');
  const url = new URL(fetchCalls[0]);

  assert.equal(
    url.pathname,
    '/public/v1/preview/C/A/HS',
    'the preview API route classifier is HS; H6 is the HS2022 dataset revision and returns HTTP 500 when used in this path',
  );
});

// --- Defect 2: structurally-absent reporters must not block publish ---
const REQUIRED_FOUR = [
  { code: '842', name: 'USA' },
  { code: '156', name: 'China' },
  { code: '699', name: 'India' },
  { code: '490', name: 'Taiwan' },
];
const BEST_EFFORT = [
  { code: '643', name: 'Russia', required: false },
  { code: '364', name: 'Iran', required: false },
];
const GATE_REPORTERS = [...REQUIRED_FOUR, ...BEST_EFFORT];
const GATE_COMMODITIES = [
  { code: '2709', desc: 'Crude' }, { code: '7108', desc: 'Gold' },
  { code: '8542', desc: 'Semis' }, { code: '9301', desc: 'Arms' }, { code: '2711', desc: 'LNG' },
];

function buildPerKey(reporters, commodities, isPopulated) {
  const out = {};
  for (const r of reporters) {
    for (const c of commodities) {
      const key = `${KEY_PREFIX}:${r.code}:${c.code}`;
      out[key] = { flows: isPopulated(r, c) ? [{ year: 2024 }, { year: 2023 }] : [], fetchedAt: 't' };
    }
  }
  return out;
}

test('checkCoverage: publishes when the four required reporters are full and only Russia/Iran are empty', () => {
  // Fast four fully populated (20/20), Russia+Iran flatlined (0/10).
  const perKey = buildPerKey(GATE_REPORTERS, GATE_COMMODITIES, (r) => r.required !== false);
  const res = checkCoverage(perKey, GATE_REPORTERS, GATE_COMMODITIES);
  assert.equal(res.ok, true, `expected publish to proceed when only best-effort reporters are empty; got reason: ${res.reason}`);
});

test('checkCoverage: still blocks when a REQUIRED reporter flatlines', () => {
  // India (required) empty; everyone else (incl. best-effort) populated.
  const perKey = buildPerKey(GATE_REPORTERS, GATE_COMMODITIES, (r) => r.code !== '699');
  const res = checkCoverage(perKey, GATE_REPORTERS, GATE_COMMODITIES);
  assert.equal(res.ok, false, 'a required reporter flatlining must still block publish');
  assert.match(res.reason, /India/);
});

// --- recentPeriod / candidatePeriods pure helpers ---
// The preview endpoint accepts only a SINGLE period (comma-separated → HTTP 400),
// so we pin the newest reliably-final year (current UTC year − 2).
test('recentPeriod returns the newest safely-final year (y-2) as a single period', async () => {
  const mod = await import('../scripts/seed-trade-flows.mjs');
  assert.equal(typeof mod.recentPeriod, 'function', 'recentPeriod must be exported');
  assert.equal(mod.recentPeriod(new Date('2026-07-02T00:00:00Z')), '2024');
  assert.equal(mod.recentPeriod(new Date('2027-03-15T00:00:00Z')), '2025');
});

test('candidatePeriods returns [y-2, y-3] freshest-first', async () => {
  const mod = await import('../scripts/seed-trade-flows.mjs');
  assert.deepEqual(mod.candidatePeriods(new Date('2026-07-02T00:00:00Z')), ['2024', '2023']);
  assert.deepEqual(mod.candidatePeriods(new Date('2027-01-01T00:00:00Z')), ['2025', '2024']);
});

// --- Year-boundary fallback: y-2 unfiled → fall back to y-3 (P2) ---
// Returns populated flows only for the `populatedPeriod`; every other period is
// an empty (but HTTP-200) snapshot — the exact "reporters haven't filed y-2 yet"
// shape that made the endpoint flatline.
function installPeriodKeyedFetch(populatedPeriod) {
  fetchCalls = [];
  globalThis.fetch = async (url) => {
    const s = String(url);
    fetchCalls.push(s);
    const period = new URL(s).searchParams.get('period');
    const body = period === populatedPeriod
      ? { data: [{ period: Number(period), flowCode: 'X', primaryValue: 100, partnerCode: '000' }] }
      : { data: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

test('fetchAllFlows falls back to the older period when the newer one fails coverage', async () => {
  installPeriodKeyedFetch('2023'); // y-2 (2024) empty, y-3 (2023) populated
  const res = await fetchAllFlows({ periods: ['2024', '2023'], pace: async () => {} });
  assert.equal(res.period, '2023', 'should publish using the fallback period');
  assert.ok(res.flows.length > 0, 'fallback period supplies the flows');
  assert.ok(fetchCalls.some((u) => u.includes('period=2024')), 'tried the fresher period first');
  assert.ok(fetchCalls.some((u) => u.includes('period=2023')), 'fell back to the older period');
});

test('fetchAllFlows uses the newest period and skips fallback when coverage passes', async () => {
  installPeriodKeyedFetch('2024'); // y-2 (2024) populated
  const res = await fetchAllFlows({ periods: ['2024', '2023'], pace: async () => {} });
  assert.equal(res.period, '2024');
  assert.ok(fetchCalls.length > 0);
  assert.ok(fetchCalls.every((u) => u.includes('period=2024')), 'must not fetch the fallback period once coverage passes');
});

test('fetchAllFlows gates on the baseline while publishing available expansion products', async () => {
  const coverageCodes = new Set(TRADE_FLOW_COVERAGE_CODES);
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    fetchCalls.push(parsed.toString());
    const code = parsed.searchParams.get('cmdCode');
    const body = coverageCodes.has(code)
      ? { data: [{ period: 2024, flowCode: 'X', primaryValue: 100, partnerCode: '000' }] }
      : { data: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  };

  const res = await fetchAllFlows({ periods: ['2024'], pace: async () => {} });
  assert.equal(res.period, '2024');
  assert.ok(res.flows.length > 0);

  const firstExpansionIndex = fetchCalls.findIndex((url) => !coverageCodes.has(new URL(url).searchParams.get('cmdCode')));
  assert.equal(
    firstExpansionIndex,
    GATE_REPORTERS.length * TRADE_FLOW_COVERAGE_CODES.length,
    'all reporters must finish the baseline before expansion requests begin',
  );
});

test('fetchAllFlows caps run-wide 429 waits and preserves a healthy baseline snapshot', async () => {
  const coverageCodes = new Set(TRADE_FLOW_COVERAGE_CODES);
  const retrySleeps = [];
  __setSleepForTests(async (ms) => { retrySleeps.push(ms); });
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    fetchCalls.push(parsed.toString());
    const code = parsed.searchParams.get('cmdCode');
    if (!coverageCodes.has(code)) return new Response('', { status: 429 });
    return new Response(
      JSON.stringify({ data: [{ period: 2024, flowCode: 'X', primaryValue: 100, partnerCode: '000' }] }),
      { status: 200 },
    );
  };

  const res = await fetchAllFlows({ periods: ['2024'], pace: async () => {} });
  assert.equal(res.period, '2024', 'a healthy baseline remains publishable when expansion is rate-limited');
  assert.deepEqual(
    retrySleeps,
    Array.from({ length: TRADE_FLOW_RATE_LIMIT_RETRY_BUDGET }, () => 60_000),
    '429 waits are bounded across the entire reporter-product matrix',
  );
  const baselineCalls = GATE_REPORTERS.length * TRADE_FLOW_COVERAGE_CODES.length;
  assert.ok(
    fetchCalls.length <= baselineCalls + TRADE_FLOW_RATE_LIMIT_RETRY_BUDGET * 2 + 1,
    'the expansion circuit breaker must stop probing after the aggregate retry budget is exhausted',
  );
});

test('best-effort reporter 429s cannot starve later required baseline reporters', async () => {
  const requiredReporterCodes = new Set(REQUIRED_FOUR.map((reporter) => reporter.code));
  const requestedReporterCodes = [];
  __setSleepForTests(async () => {});
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    fetchCalls.push(parsed.toString());
    const reporterCode = parsed.searchParams.get('reporterCode');
    requestedReporterCodes.push(reporterCode);
    if (!requiredReporterCodes.has(reporterCode)) return new Response('', { status: 429 });
    return new Response(
      JSON.stringify({ data: [{ period: 2024, flowCode: 'X', primaryValue: 100, partnerCode: '000' }] }),
      { status: 200 },
    );
  };

  const res = await fetchAllFlows({ periods: ['2024'], pace: async () => {} });
  assert.equal(res.period, '2024');
  for (const code of requiredReporterCodes) {
    assert.ok(requestedReporterCodes.includes(code), `required reporter ${code} must be fetched before best-effort quota pressure`);
  }
  const firstBestEffortIndex = requestedReporterCodes.findIndex((code) => !requiredReporterCodes.has(code));
  const lastRequiredIndex = Math.max(...[...requiredReporterCodes].map((code) => requestedReporterCodes.lastIndexOf(code)));
  assert.ok(firstBestEffortIndex > lastRequiredIndex, 'all required baseline reporters must run before Russia/Iran');
});

test('a failed fresh baseline falls back before any fresh-period expansion probes', async () => {
  const coverageCodes = new Set(TRADE_FLOW_COVERAGE_CODES);
  const bestEffortReporterCodes = new Set(BEST_EFFORT.map((reporter) => reporter.code));
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    fetchCalls.push(parsed.toString());
    const period = parsed.searchParams.get('period');
    const code = parsed.searchParams.get('cmdCode');
    const reporterCode = parsed.searchParams.get('reporterCode');
    if (period === '2024' && bestEffortReporterCodes.has(reporterCode)) return new Response('', { status: 429 });
    const body = period === '2023' && coverageCodes.has(code)
      ? { data: [{ period: 2023, flowCode: 'X', primaryValue: 100, partnerCode: '000' }] }
      : { data: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  };

  const res = await fetchAllFlows({ periods: ['2024', '2023'], pace: async () => {} });
  assert.equal(res.period, '2023');
  assert.ok(fetchCalls.some((url) => new URL(url).searchParams.get('period') === '2023'));
  assert.equal(
    fetchCalls.some((url) => {
      const parsed = new URL(url);
      return parsed.searchParams.get('period') === '2024'
        && !coverageCodes.has(parsed.searchParams.get('cmdCode'));
    }),
    false,
    'fresh-period expansion must not run after its baseline failed',
  );
  assert.equal(
    fetchCalls.some((url) => {
      const parsed = new URL(url);
      return parsed.searchParams.get('period') === '2024'
        && bestEffortReporterCodes.has(parsed.searchParams.get('reporterCode'));
    }),
    false,
    'fresh-period best-effort reporters must not run after required baseline failure',
  );
});

test('fetchAllFlows throws (→ graceful exit 75) when no candidate period has coverage', async () => {
  installPeriodKeyedFetch('9999'); // no candidate populated
  await assert.rejects(
    () => fetchAllFlows({ periods: ['2024', '2023'], pace: async () => {} }),
    /below (global floor|per-reporter)/,
  );
});
