import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  computeHhi,
  buildPeriodParam,
  buildStalePeriodFallbackParam,
  computeComtradeBackoffMs,
  formatWatchReporterMisses,
  getImportHhiFallbackPeriodParam,
  hasRateLimitedWatchReporter,
  isComtradeQuotaStatus,
  orderImportHhiReporterQueue,
  parseRecords,
  resolveImportHhiRuntimeConfig,
  runWorker,
  validate,
} from '../scripts/seed-recovery-import-hhi.mjs';
import { ISO2_TO_COMTRADE } from '../server/worldmonitor/intelligence/v1/_comtrade-reporters.js';

const seedSrc = readFileSync(new URL('../scripts/seed-recovery-import-hhi.mjs', import.meta.url), 'utf8');
const reporterOverrides = JSON.parse(
  readFileSync(new URL('../scripts/shared/comtrade-reporter-overrides.json', import.meta.url), 'utf8'),
);

describe('seed-recovery-import-hhi', () => {
  it('defines Comtrade reporter overrides for all known non-standard reporter codes', () => {
    assert.deepEqual(reporterOverrides, {
      CH: '757',
      FR: '251',
      IN: '699',
      IT: '381',
      NO: '579',
      TW: '490',
      US: '842',
    });
  });

  it('shared Comtrade override file mirrors the canonical reporter map deltas', () => {
    const unToIso2 = JSON.parse(
      readFileSync(new URL('../scripts/shared/un-to-iso2.json', import.meta.url), 'utf8'),
    );
    const iso2ToUn = Object.fromEntries(Object.entries(unToIso2).map(([un, iso2]) => [iso2, un]));
    const expectedOverrides = {};
    for (const [iso2, code] of Object.entries(ISO2_TO_COMTRADE)) {
      if (iso2ToUn[iso2] && iso2ToUn[iso2] !== code) expectedOverrides[iso2] = code;
    }
    assert.deepEqual(reporterOverrides, expectedOverrides);
  });

  it('applies Comtrade reporter overrides before falling back to ISO2_TO_UN', () => {
    const overrideIdx = seedSrc.indexOf("require('./shared/comtrade-reporter-overrides.json')");
    const mergeIdx = seedSrc.indexOf('for (const [iso2, code] of Object.entries(COMTRADE_REPORTER_OVERRIDES))');
    const iso2ToUnIdx = seedSrc.indexOf('ISO2_TO_UN[iso2] = code', mergeIdx);
    assert.ok(overrideIdx !== -1, 'seeder must define COMTRADE_REPORTER_OVERRIDES');
    assert.ok(mergeIdx !== -1, 'seeder must merge overrides into ISO2_TO_UN');
    assert.ok(
      iso2ToUnIdx !== -1 && iso2ToUnIdx > mergeIdx,
      'seeder must apply overrides to ISO2_TO_UN before reporter fetches',
    );
  });

  it('validate rejects catastrophic partial import-HHI snapshots below the publish floor', () => {
    const partial = Object.fromEntries(
      Array.from({ length: 130 }, (_, i) => [`T${i}`, { hhi: 0.1 }]),
    );
    const sufficient = Object.fromEntries(
      Array.from({ length: 131 }, (_, i) => [`T${i}`, { hhi: 0.1 }]),
    );
    for (const iso2 of ['AE', 'RU', 'NO', 'CH']) {
      partial[iso2] = { hhi: 0.1 };
      sufficient[iso2] = { hhi: 0.1 };
    }
    assert.equal(validate({ countries: partial }), false);
    assert.equal(validate({ countries: sufficient }), true);
  });

  it('validate rejects otherwise sufficient snapshots that still strand watched reporters', () => {
    const countries = Object.fromEntries(
      Array.from({ length: 170 }, (_, i) => [`T${i}`, { hhi: 0.1 }]),
    );
    countries.AE = { hhi: 0.1 };
    countries.RU = { hhi: 0.1 };
    countries.NO = { hhi: 0.1 };

    assert.equal(validate({ countries }), false);
    countries.CH = { hhi: 0.1 };
    assert.equal(validate({ countries }), true);
  });

  it('treats validation rejects as seed failures so partial runs do not refresh seed-meta', () => {
    const runSeedIdx = seedSrc.indexOf("runSeed('resilience', 'recovery:import-hhi'");
    const catchIdx = seedSrc.indexOf('}).catch', runSeedIdx);
    assert.ok(runSeedIdx !== -1, 'seeder must call runSeed for recovery:import-hhi');
    assert.ok(catchIdx !== -1, 'seeder runSeed options block must be locatable');
    const optionsBlock = seedSrc.slice(runSeedIdx, catchIdx);
    assert.ok(
      optionsBlock.includes('emptyDataIsFailure: true'),
      'partial import-HHI snapshots must fail the section instead of refreshing seed-meta and blocking retries',
    );
  });

  it('defaults to conservative Comtrade pacing while keeping all keys active', () => {
    assert.deepEqual(resolveImportHhiRuntimeConfig({}, 2), {
      perKeyDelayMs: 1_500,
      maxConcurrency: 2,
    });
  });

  it('lets operators widen import-HHI pacing and lower concurrency via env', () => {
    assert.deepEqual(resolveImportHhiRuntimeConfig({
      IMPORT_HHI_PER_KEY_DELAY_MS: '10000',
      IMPORT_HHI_MAX_CONCURRENCY: '1',
    }, 3), {
      perKeyDelayMs: 10_000,
      maxConcurrency: 1,
    });
  });

  it('accepts PER_KEY_DELAY_MS as an operational alias for issue #3979 runbooks', () => {
    assert.deepEqual(resolveImportHhiRuntimeConfig({
      PER_KEY_DELAY_MS: '12000',
    }, 2), {
      perKeyDelayMs: 12_000,
      maxConcurrency: 2,
    });
  });

  it('fetches watched reporters before generic backfill when they are missing', () => {
    assert.deepEqual(
      orderImportHhiReporterQueue(['BR', 'NO', 'US', 'RU', 'CH', 'AE']),
      ['AE', 'RU', 'NO', 'CH', 'BR', 'US'],
    );
    assert.deepEqual(
      orderImportHhiReporterQueue(['BR', 'US']),
      ['BR', 'US'],
    );
  });

  it('uses per-key pacing as the 429 retry floor', () => {
    assert.equal(computeComtradeBackoffMs(429, 1, 12_000), 12_000);
    assert.equal(computeComtradeBackoffMs(429, 1, 1_500), 5_000);
    assert.equal(computeComtradeBackoffMs(429, 4, 1_000), 8_000);
    assert.equal(computeComtradeBackoffMs(503, 2, 12_000), 10_000);
  });

  it('treats Comtrade 429 and quota-exhausted 403 as operational key-budget statuses', () => {
    assert.equal(isComtradeQuotaStatus(429), true);
    assert.equal(isComtradeQuotaStatus(403), true);
    assert.equal(isComtradeQuotaStatus(503), false);
    assert.equal(isComtradeQuotaStatus(401), false);
  });

  it('formats watched-reporter misses with HTTP and row-count evidence', () => {
    const formatted = formatWatchReporterMisses(['RU', 'NO', 'CH'], {
      RU: {
        status: 403,
        rows: 0,
        year: null,
        periodParam: '2025,2024,2023,2022',
        errorMessage: 'Out of call volume quota.',
      },
      NO: { status: 429, rows: 0, year: null, periodParam: '2025,2024,2023,2022' },
      CH: { error: 'fetch failed' },
    });
    assert.equal(
      formatted,
      'RU:status=403 rows=0 year=n/a period=2025,2024,2023,2022 message=Out of call volume quota., NO:status=429 rows=0 year=n/a period=2025,2024,2023,2022, CH:error=fetch failed',
    );
    assert.equal(hasRateLimitedWatchReporter(['RU', 'NO', 'CH'], {
      RU: { status: 200, rows: 0, year: null },
      NO: { status: 403, rows: 0, year: null },
    }), true);
    assert.equal(hasRateLimitedWatchReporter(['RU'], { RU: { status: 200, rows: 0, year: null } }), false);
  });

  it('clamps invalid import-HHI pacing controls to safe bounds', () => {
    assert.deepEqual(resolveImportHhiRuntimeConfig({
      IMPORT_HHI_PER_KEY_DELAY_MS: '120000',
      IMPORT_HHI_MAX_CONCURRENCY: '99',
    }, 2), {
      perKeyDelayMs: 60_000,
      maxConcurrency: 2,
    });
    assert.deepEqual(resolveImportHhiRuntimeConfig({
      IMPORT_HHI_PER_KEY_DELAY_MS: 'nope',
      IMPORT_HHI_MAX_CONCURRENCY: '0',
    }, 0), {
      perKeyDelayMs: 1_500,
      maxConcurrency: 0,
    });
  });

  it('clamps below-min import-HHI pacing controls instead of falling through to fallback', () => {
    assert.deepEqual(resolveImportHhiRuntimeConfig({
      IMPORT_HHI_PER_KEY_DELAY_MS: '100',
      PER_KEY_DELAY_MS: '12000',
      IMPORT_HHI_MAX_CONCURRENCY: '0',
    }, 2), {
      perKeyDelayMs: 600,
      maxConcurrency: 1,
    });
  });

  it('wires RU primary zero-row fetch into the stale-period fallback inside runWorker', async () => {
    const calls = [];
    const sleeps = [];
    const countries = {};
    const progressRef = {
      fetched: 0,
      skipped: 0,
      errors: 0,
      rateLimited: 0,
      rateLimitedReporters: [],
      watchOutcomes: {},
    };

    await runWorker('key-a', ['RU'], countries, progressRef, {
      sleep: async (ms) => { sleeps.push(ms); },
      fetchImportsForReporter: async (reporterCode, apiKey, periodParam) => {
        calls.push({ reporterCode, apiKey, periodParam });
        if (calls.length === 1) return { records: [], year: null, status: 200 };
        return {
          records: [
            { partnerCode: '156', primaryValue: 400 },
            { partnerCode: '842', primaryValue: 600 },
          ],
          year: 2018,
          status: 200,
        };
      },
    });

    assert.deepEqual(calls, [
      { reporterCode: '643', apiKey: 'key-a', periodParam: buildPeriodParam() },
      { reporterCode: '643', apiKey: 'key-a', periodParam: buildStalePeriodFallbackParam() },
    ]);
    assert.deepEqual(sleeps, [1_500, 1_500]);
    const { fetchedAt, ...ruEntry } = countries.RU;
    assert.deepEqual(ruEntry, {
      hhi: 0.52,
      concentrated: true,
      partnerCount: 2,
      year: 2018,
    });
    assert.match(fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(progressRef.fetched, 1);
    assert.equal(progressRef.skipped, 0);
    assert.deepEqual(progressRef.watchOutcomes.RU, {
      status: 200,
      rows: 2,
      year: 2018,
      periodParam: buildStalePeriodFallbackParam(),
      errorMessage: undefined,
    });
  });

  it('computes HHI=1 for single-partner imports', () => {
    const records = [{ partnerCode: '156', primaryValue: 1000 }];
    const result = computeHhi(records);
    assert.equal(result.hhi, 1);
    assert.equal(result.partnerCount, 1);
  });

  it('computes HHI for two equal partners', () => {
    const records = [
      { partnerCode: '156', primaryValue: 500 },
      { partnerCode: '842', primaryValue: 500 },
    ];
    const result = computeHhi(records);
    assert.equal(result.hhi, 0.5);
    assert.equal(result.partnerCount, 2);
  });

  it('computes HHI for diversified imports (4 equal partners)', () => {
    const records = [
      { partnerCode: '156', primaryValue: 250 },
      { partnerCode: '842', primaryValue: 250 },
      { partnerCode: '276', primaryValue: 250 },
      { partnerCode: '392', primaryValue: 250 },
    ];
    const result = computeHhi(records);
    assert.equal(result.hhi, 0.25);
    assert.equal(result.partnerCount, 4);
  });

  it('HHI > 0.25 flags concentrated', () => {
    const records = [
      { partnerCode: '156', primaryValue: 900 },
      { partnerCode: '842', primaryValue: 100 },
    ];
    const result = computeHhi(records);
    assert.ok(result.hhi > 0.25, `HHI ${result.hhi} should exceed 0.25 concentration threshold`);
  });

  it('HHI with asymmetric partners matches manual calculation', () => {
    const records = [
      { partnerCode: '156', primaryValue: 600 },
      { partnerCode: '842', primaryValue: 300 },
      { partnerCode: '276', primaryValue: 100 },
    ];
    const result = computeHhi(records);
    const expected = (0.6 ** 2) + (0.3 ** 2) + (0.1 ** 2);
    assert.ok(Math.abs(result.hhi - Math.round(expected * 10000) / 10000) < 0.001);
    assert.equal(result.partnerCount, 3);
  });

  it('excludes world aggregate partner codes (0 and 000)', () => {
    const records = [
      { partnerCode: '0', primaryValue: 5000 },
      { partnerCode: '000', primaryValue: 5000 },
      { partnerCode: '156', primaryValue: 500 },
      { partnerCode: '842', primaryValue: 500 },
    ];
    const result = computeHhi(records);
    assert.equal(result.hhi, 0.5);
    assert.equal(result.partnerCount, 2);
  });

  it('returns null for empty records', () => {
    assert.equal(computeHhi([]), null);
  });

  it('returns null when all records are world aggregates', () => {
    const records = [
      { partnerCode: '0', primaryValue: 1000 },
      { partnerCode: '000', primaryValue: 2000 },
    ];
    assert.equal(computeHhi(records), null);
  });

  // P1 fix: multi-row per partner must aggregate before computing shares
  it('aggregates multiple rows for the same partner before computing shares', () => {
    // Simulates Comtrade returning multiple commodity rows for partner 156
    const records = [
      { partnerCode: '156', primaryValue: 300 },
      { partnerCode: '156', primaryValue: 200 },  // same partner, different commodity
      { partnerCode: '842', primaryValue: 500 },
    ];
    const result = computeHhi(records);
    // After aggregation: 156=500, 842=500 → HHI = 0.5^2 + 0.5^2 = 0.5
    assert.equal(result.hhi, 0.5);
    assert.equal(result.partnerCount, 2, 'partnerCount must count unique partners, not rows');
  });

  it('handles multi-year duplicate rows correctly', () => {
    // Simulates Comtrade returning the same partner across 2 years
    const records = [
      { partnerCode: '156', primaryValue: 400 },  // year 1
      { partnerCode: '156', primaryValue: 600 },  // year 2
      { partnerCode: '842', primaryValue: 200 },  // year 1
      { partnerCode: '842', primaryValue: 300 },  // year 2
    ];
    const result = computeHhi(records);
    // Aggregated: 156=1000, 842=500 → shares: 0.667, 0.333
    // HHI = 0.667^2 + 0.333^2 ≈ 0.5556
    assert.ok(Math.abs(result.hhi - 0.5556) < 0.01, `HHI ${result.hhi} should be ~0.5556`);
    assert.equal(result.partnerCount, 2);
  });
});

// PR 1 of plan 2026-04-24-002: 4-year period window + pick-latest-per-reporter
// to unblock late-reporters (UAE, OM, BH) who publish Comtrade 1-2y behind.
describe('seed-recovery-import-hhi — period window + pick-latest', () => {
  describe('buildPeriodParam', () => {
    it('emits a 4-year window descending from Y-1 to Y-4', () => {
      assert.equal(buildPeriodParam(2026), '2025,2024,2023,2022');
    });

    it('defaults to the current system year when no arg passed', () => {
      const nowYear = new Date().getFullYear();
      const produced = buildPeriodParam();
      const parts = produced.split(',').map(Number);
      assert.equal(parts.length, 4, 'must always produce exactly 4 years');
      assert.equal(parts[0], nowYear - 1, 'first year is Y-1 relative to system clock');
      assert.equal(parts[3], nowYear - 4, 'last year is Y-4');
    });

    it('never emits the current year (Comtrade is always behind by at least 1y)', () => {
      const produced = buildPeriodParam(2026).split(',').map(Number);
      assert.ok(!produced.includes(2026), `${produced} must not include the current year`);
    });

    it('emits a second 4-year fallback window for RU stale publication gaps', () => {
      assert.equal(buildStalePeriodFallbackParam(2026), '2021,2020,2019,2018');
      assert.equal(getImportHhiFallbackPeriodParam('RU', 2026), '2021,2020,2019,2018');
      assert.equal(getImportHhiFallbackPeriodParam('AE', 2026), null);
    });
  });

  describe('parseRecords — picks year with most partners', () => {
    it('picks the year with the most partner rows (completeness tiebreak)', () => {
      const data = { data: [
        // 2023 has 3 partners → fewer than 2024
        { period: 2023, partnerCode: '156', primaryValue: 100 },
        { period: 2023, partnerCode: '842', primaryValue: 100 },
        { period: 2023, partnerCode: '276', primaryValue: 100 },
        // 2024 has 5 partners → winner on completeness
        { period: 2024, partnerCode: '156', primaryValue: 100 },
        { period: 2024, partnerCode: '842', primaryValue: 100 },
        { period: 2024, partnerCode: '276', primaryValue: 100 },
        { period: 2024, partnerCode: '392', primaryValue: 100 },
        { period: 2024, partnerCode: '410', primaryValue: 100 },
      ]};
      const { rows, year } = parseRecords(data);
      assert.equal(year, 2024, 'should pick 2024 (more partners)');
      assert.equal(rows.length, 5, 'should return the 2024 rows only');
    });

    it('picks the most recent year when partner counts tie', () => {
      const data = { data: [
        { period: 2022, partnerCode: '156', primaryValue: 100 },
        { period: 2022, partnerCode: '842', primaryValue: 100 },
        { period: 2023, partnerCode: '156', primaryValue: 100 },
        { period: 2023, partnerCode: '842', primaryValue: 100 },
      ]};
      const { rows, year } = parseRecords(data);
      assert.equal(year, 2023, 'should pick the newer year on ties');
      assert.equal(rows.length, 2);
    });

    it('picks the only populated year for late-reporters (the UAE/OM/BH scenario)', () => {
      // UAE pattern: Comtrade has 2023 data but 2024/2025 rows are empty.
      const data = { data: [
        { period: 2023, partnerCode: '156', primaryValue: 500 },
        { period: 2023, partnerCode: '842', primaryValue: 500 },
        { period: 2023, partnerCode: '276', primaryValue: 500 },
        // No 2024/2025 rows — this is what the API returns for a late reporter.
      ]};
      const { rows, year } = parseRecords(data);
      assert.equal(year, 2023, 'must surface 2023 as the latest non-empty year');
      assert.equal(rows.length, 3, 'must return all 2023 rows intact');
    });

    it('returns { rows: [], year: null } on empty input (no IMPUTE surface)', () => {
      assert.deepEqual(parseRecords({ data: [] }), { rows: [], year: null });
      assert.deepEqual(parseRecords({}), { rows: [], year: null });
      assert.deepEqual(parseRecords(null), { rows: [], year: null });
    });

    it('omits responses at the requested maxRecords cap instead of parsing truncated HHI input', () => {
      const capped = parseRecords({
        data: [
          { period: 2024, partnerCode: '156', primaryValue: 100 },
          { period: 2024, partnerCode: '842', primaryValue: 100 },
        ],
      }, { maxRecords: 2 });
      assert.deepEqual(capped, {
        rows: [],
        year: null,
        truncated: true,
        rawCount: 2,
      });

      const belowCap = parseRecords({
        data: [
          { period: 2024, partnerCode: '156', primaryValue: 100 },
          { period: 2024, partnerCode: '842', primaryValue: 100 },
        ],
      }, { maxRecords: 3 });
      assert.equal(belowCap.truncated, undefined);
      assert.equal(belowCap.rows.length, 2);
      assert.equal(belowCap.year, 2024);
    });

    it('ignores rows with primaryValue <= 0', () => {
      const data = { data: [
        { period: 2024, partnerCode: '156', primaryValue: 0 },
        { period: 2024, partnerCode: '842', primaryValue: -100 },
        { period: 2023, partnerCode: '156', primaryValue: 500 },
      ]};
      const { rows, year } = parseRecords(data);
      assert.equal(year, 2023, 'only 2023 has a positive-value row');
      assert.equal(rows.length, 1);
    });

    it('ignores world-aggregate partner codes (0, 000) in the completeness count', () => {
      // 2024 has one real partner + two world-aggregate rows (4 total rows,
      // but only 1 "usable"); 2023 has two real partners (2 usable). 2023 wins.
      const data = { data: [
        { period: 2024, partnerCode: '0',   primaryValue: 1000 },
        { period: 2024, partnerCode: '000', primaryValue: 1000 },
        { period: 2024, partnerCode: '156', primaryValue: 500 },
        { period: 2023, partnerCode: '156', primaryValue: 500 },
        { period: 2023, partnerCode: '842', primaryValue: 500 },
      ]};
      const { year } = parseRecords(data);
      assert.equal(year, 2023, 'completeness count must exclude world-aggregates');
    });
  });
});

// U1 (plan 2026-04-28-003 §U1) — fetchImportsForReporter retry hardening.
// 2026-04-28 incident: AE was the only GCC reporter missing from
// `resilience:recovery:import-hhi:v1` (5/6 GCC present: SA/KW/QA/BH/OM)
// despite a live probe confirming 231 usable partners in 2023. Root cause:
// the prior single-15s-429-retry budget couldn't survive Comtrade rate-
// limit pressure on a key shared with the sibling reexport-share seeder.
// This block pins the retry semantics and the auth shape so a future
// regression that drops attempts back to 1, removes header auth, or
// removes maxRecords trips the test.
describe('seed-recovery-import-hhi — fetch retry hardening (U1, plan v19)', () => {
  // Lightweight global-fetch mock. Each test installs its own response
  // sequence then restores the original. Mirrors the pattern used in
  // tests/resilience-ranking.test.mts for fetch interception.
  const originalFetch = globalThis.fetch;
  let fetchCalls = [];
  function installFetchSequence(responses) {
    fetchCalls = [];
    let i = 0;
    globalThis.fetch = async (url, init) => {
      fetchCalls.push({ url: typeof url === 'string' ? url : url.toString(), init });
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return r;
    };
  }
  function restoreAll(mod) {
    // Reviewer P2 (PR #3487 round 2): the prior `restoreFetch` form
    // didn't reset the module's sleep override, so any test added
    // AFTER this describe block would silently inherit the no-op
    // sleep stub. Reset both globals to keep the module-level state
    // hygienic across test files.
    globalThis.fetch = originalFetch;
    if (mod && typeof mod.__setSleepForTests === 'function') {
      mod.__setSleepForTests(null);
    }
  }

  function makeJsonResponse(status, body) {
    return new Response(JSON.stringify(body ?? {}), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Async import inside each test so the mock is in place when the
  // module-internal `_retrySleep` shortcut is honored. Using
  // __setSleepForTests below to make the test deterministic + fast;
  // every test must `restoreAll(mod)` in its finally block to reset
  // the sleep stub before the next test runs.
  async function loadFixture() {
    const mod = await import('../scripts/seed-recovery-import-hhi.mjs');
    mod.__setSleepForTests(async () => {});
    return mod;
  }

  it('retries 429 up to 3 attempts before giving up (was 2 pre-fix)', async () => {
    const mod = await loadFixture();
    installFetchSequence([
      makeJsonResponse(429),
      makeJsonResponse(429),
      makeJsonResponse(429),
    ]);
    try {
      const result = await mod.fetchImportsForReporter('784', 'fake-key');
      assert.equal(result.status, 429, 'final response is 429 after exhausting retries');
      assert.equal(result.records.length, 0, 'no records when rate-limited out');
      assert.equal(fetchCalls.length, 3, 'must attempt exactly 3 times');
    } finally {
      restoreAll(mod);
    }
  });

  it('recovers from a transient 429 followed by 200 (the AE rate-limit recovery case)', async () => {
    const mod = await loadFixture();
    installFetchSequence([
      makeJsonResponse(429),
      makeJsonResponse(429),
      makeJsonResponse(200, { data: [
        { period: 2023, partnerCode: '156', primaryValue: 1000 },
        { period: 2023, partnerCode: '842', primaryValue: 500 },
      ]}),
    ]);
    try {
      const result = await mod.fetchImportsForReporter('784', 'fake-key');
      assert.equal(result.status, 200);
      assert.equal(result.records.length, 2, '2023 records returned after retry');
      assert.equal(result.year, 2023);
      assert.equal(fetchCalls.length, 3, 'two 429s + one 200 = 3 attempts');
    } finally {
      restoreAll(mod);
    }
  });

  it('uses header auth (Ocp-Apim-Subscription-Key) — key never appears in URL', async () => {
    // Mirror reexport-share's audit-safe pattern. Pre-fix the key was a
    // URL searchParam which would leak into any logged URL.
    const mod = await loadFixture();
    installFetchSequence([makeJsonResponse(200, { data: [] })]);
    try {
      await mod.fetchImportsForReporter('784', 'super-secret-key');
      assert.equal(fetchCalls.length, 1);
      const { url, init } = fetchCalls[0];
      assert.ok(!url.includes('super-secret-key'),
        `URL must not contain the API key (defense against accidental log leakage); got ${url}`);
      assert.ok(!url.includes('subscription-key'),
        'URL must not have any subscription-key searchParam');
      assert.equal(init.headers['Ocp-Apim-Subscription-Key'], 'super-secret-key',
        'API key must arrive in the Ocp-Apim-Subscription-Key header');
    } finally {
      restoreAll(mod);
    }
  });

  it('surfaces Comtrade error messages for non-retryable quota/auth responses', async () => {
    const mod = await loadFixture();
    installFetchSequence([
      makeJsonResponse(403, { error: 'Out of call volume quota. Quota will be replenished later.' }),
    ]);
    try {
      const result = await mod.fetchImportsForReporter('784', 'k');
      assert.equal(result.status, 403);
      assert.equal(result.records.length, 0);
      assert.match(result.errorMessage, /Out of call volume quota/);
      assert.equal(fetchCalls.length, 1, '403 is operational key state; do not retry immediately');
    } finally {
      restoreAll(mod);
    }
  });

  it('sets explicit maxRecords=250000 to prevent silent default truncation', async () => {
    const mod = await loadFixture();
    installFetchSequence([makeJsonResponse(200, { data: [] })]);
    try {
      await mod.fetchImportsForReporter('784', 'k');
      const url = new URL(fetchCalls[0].url);
      assert.equal(url.searchParams.get('customsCode'), 'C00',
        'customsCode must be C00 so HHI fetches stay at total-customs granularity');
      assert.equal(url.searchParams.get('motCode'), '0',
        'motCode must be 0 so HHI fetches stay at total-transport-mode granularity');
      assert.equal(url.searchParams.get('maxRecords'), '250000',
        'maxRecords must be 250000 (mirrors seed-recovery-reexport-share PR #3385)');
    } finally {
      restoreAll(mod);
    }
  });

  it('omits exact-cap Comtrade responses rather than computing HHI from possibly truncated rows', async () => {
    const mod = await loadFixture();
    const cappedRows = Array.from({ length: 250_000 }, (_, i) => ({
      period: 2024,
      partnerCode: String(100 + (i % 200)),
      primaryValue: 100 + i,
    }));
    installFetchSequence([makeJsonResponse(200, { data: cappedRows })]);
    try {
      const result = await mod.fetchImportsForReporter('784', 'k');
      assert.equal(result.status, 200);
      assert.equal(result.truncated, true);
      assert.equal(result.records.length, 0);
      assert.equal(result.year, null);
      assert.match(result.errorMessage, /maxRecords=250000/);
    } finally {
      restoreAll(mod);
    }
  });

  it('AE-shaped response (200+ partners in latest year) parses to a non-null HHI', async () => {
    // Regression-pin the live probe shape captured 2026-04-28: AE
    // returns ~231 usable partners in 2023. Synthesize a representative
    // response and assert the seeder's parse → computeHhi pipeline
    // produces a real, non-null HHI value end-to-end. If a future
    // refactor breaks the integration (e.g. parse changes silently
    // drop usable rows), this test trips.
    const partners = Array.from({ length: 231 }, (_, i) => ({
      period: 2023,
      partnerCode: String(100 + i), // synthetic non-zero partner codes
      primaryValue: 1_000_000 + i * 1000, // varied values
    }));
    const mod = await loadFixture();
    installFetchSequence([makeJsonResponse(200, { data: partners })]);
    try {
      const result = await mod.fetchImportsForReporter('784', 'k');
      assert.equal(result.status, 200);
      assert.equal(result.records.length, 231, 'all 231 usable partners must parse through');
      assert.equal(result.year, 2023);
      const hhi = mod.computeHhi(result.records);
      assert.ok(hhi !== null, 'computeHhi must NOT return null — AE data is rich');
      assert.ok(hhi.hhi > 0 && hhi.hhi < 0.05,
        `231 partners with varied values → HHI in low range; got ${hhi.hhi}`);
      assert.equal(hhi.partnerCount, 231);
    } finally {
      restoreAll(mod);
    }
  });
});
