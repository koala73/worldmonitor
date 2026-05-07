import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeHhi, buildPeriodParam, parseRecords } from '../scripts/seed-recovery-import-hhi.mjs';

describe('seed-recovery-import-hhi', () => {
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

  it('sets explicit maxRecords=250000 to prevent silent default truncation', async () => {
    const mod = await loadFixture();
    installFetchSequence([makeJsonResponse(200, { data: [] })]);
    try {
      await mod.fetchImportsForReporter('784', 'k');
      const url = new URL(fetchCalls[0].url);
      assert.equal(url.searchParams.get('maxRecords'), '250000',
        'maxRecords must be 250000 (mirrors seed-recovery-reexport-share PR #3385)');
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
