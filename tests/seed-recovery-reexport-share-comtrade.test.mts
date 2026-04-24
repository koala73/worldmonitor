// Pure-math tests for the Comtrade-backed re-export-share seeder.
// Verifies the three extracted helpers (`parseComtradeFlowResponse`,
// `computeShareFromFlows`, `clampShare`) behave correctly in isolation,
// and that no subscription-key query param ever appears in the
// serialized envelope (belt-and-suspenders even with header auth).
//
// Context: plan 2026-04-24-003 §Phase 3 tests 1-6. These replace the
// 7 obsolete reexport-share-loader tests (YAML flattener deleted in
// this same PR).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  clampShare,
  computeShareFromFlows,
  declareRecords,
  parseComtradeFlowResponse,
} from '../scripts/seed-recovery-reexport-share.mjs';

describe('parseComtradeFlowResponse', () => {
  it('sums primaryValue per year, skipping zero/negative/non-numeric', () => {
    const rows = [
      { period: 2023, primaryValue: 100_000 },
      { period: 2023, primaryValue: 50_000 },
      { period: 2022, primaryValue: 30_000 },
      { period: 2021, primaryValue: 0 },      // skipped (zero)
      { period: 2021, primaryValue: -5 },      // skipped (negative)
      { period: 2021, primaryValue: 'x' },     // skipped (non-numeric)
    ];
    const out = parseComtradeFlowResponse(rows);
    assert.equal(out.get(2023), 150_000);
    assert.equal(out.get(2022), 30_000);
    assert.equal(out.has(2021), false);
  });

  it('sums ONLY world-aggregate rows (partnerCode=0), excludes partner-level rows', () => {
    // Defensive filter: if Comtrade returns BOTH a world-aggregate
    // row (partner=0) AND per-partner breakdown rows for the same
    // year, summing all would silently double-count and cut any
    // derived share in half. We sum only partnerCode='0' / 0 / null.
    const rows = [
      { period: 2023, partnerCode: '0', primaryValue: 1_000_000 },   // world aggregate — include
      { period: 2023, partnerCode: '842', primaryValue: 200_000 },   // per-partner (US) — EXCLUDE
      { period: 2023, partnerCode: '826', primaryValue: 150_000 },   // per-partner (UK) — EXCLUDE
    ];
    const out = parseComtradeFlowResponse(rows);
    assert.equal(out.get(2023), 1_000_000,
      'per-partner rows must not add to the world-aggregate total');
  });

  it('accepts numeric 0 partnerCode (shape variant)', () => {
    // Comtrade has occasionally emitted numeric 0 vs string '0' depending
    // on response shape; both must be treated as world-aggregate.
    const rows = [
      { period: 2023, partnerCode: 0, primaryValue: 500 },
      { period: 2023, partnerCode: '0', primaryValue: 500 },
    ];
    const out = parseComtradeFlowResponse(rows);
    assert.equal(out.get(2023), 1_000);
  });

  it('accepts rows with no partnerCode field (older response shape)', () => {
    // Defensive: if a response shape omits partnerCode entirely,
    // treat the row as world-aggregate rather than silently dropping it.
    const rows = [{ period: 2024, primaryValue: 42 }];
    const out = parseComtradeFlowResponse(rows);
    assert.equal(out.get(2024), 42);
  });

  it('handles refPeriodId fallback when period is absent', () => {
    const rows = [{ refPeriodId: 2024, primaryValue: 42 }];
    const out = parseComtradeFlowResponse(rows);
    assert.equal(out.get(2024), 42);
  });

  it('returns empty map on empty input', () => {
    assert.equal(parseComtradeFlowResponse([]).size, 0);
  });
});

describe('computeShareFromFlows', () => {
  it('picks the latest co-populated year and returns share = RX / M', () => {
    const rx = new Map([[2023, 300], [2022, 200], [2021, 100]]);
    const m = new Map([[2023, 1000], [2022, 500], [2021, 400]]);
    const picked = computeShareFromFlows(rx, m);
    assert.equal(picked?.year, 2023);
    assert.equal(picked?.share, 0.3);
    assert.equal(picked?.reexportsUsd, 300);
    assert.equal(picked?.importsUsd, 1000);
  });

  it('ignores years where RX or M is missing', () => {
    const rx = new Map([[2024, 500], [2022, 200]]);  // 2024 is RX-only
    const m = new Map([[2023, 1000], [2022, 500]]);  // 2023 is M-only
    const picked = computeShareFromFlows(rx, m);
    // Only 2022 is co-populated; even though 2024 is newer, it's not in M.
    assert.equal(picked?.year, 2022);
    assert.equal(picked?.share, 0.4);
  });

  it('returns null when no year is co-populated', () => {
    const rx = new Map([[2024, 500]]);
    const m = new Map([[2022, 500]]);
    assert.equal(computeShareFromFlows(rx, m), null);
  });

  it('returns null when imports at picked year is zero (guards division)', () => {
    // This can only happen if parseComtradeFlowResponse changes behavior;
    // test the branch anyway since computeShareFromFlows is exported for
    // tests and could be called with hand-crafted maps.
    const rx = new Map([[2023, 300]]);
    const m = new Map([[2023, 0]]);
    assert.equal(computeShareFromFlows(rx, m), null);
  });
});

describe('clampShare', () => {
  it('returns null for sub-floor shares (< 0.05)', () => {
    assert.equal(clampShare(0.03), null);
    assert.equal(clampShare(0.049999), null);
    assert.equal(clampShare(0), null);
  });

  it('caps above-ceiling shares at 0.95 (< 1 guard for computeNetImports)', () => {
    assert.equal(clampShare(1.2), 0.95);
    assert.equal(clampShare(0.99), 0.95);
    assert.equal(clampShare(0.951), 0.95);
  });

  it('passes through in-range shares unchanged', () => {
    assert.equal(clampShare(0.05), 0.05);
    assert.equal(clampShare(0.355), 0.355);
    assert.equal(clampShare(0.5), 0.5);
    assert.equal(clampShare(0.95), 0.95);
  });

  it('returns null for NaN, Infinity, and negative', () => {
    assert.equal(clampShare(NaN), null);
    assert.equal(clampShare(Infinity), null);
    assert.equal(clampShare(-0.1), null);
  });
});

describe('declareRecords', () => {
  it('counts material entries in the published payload', () => {
    const payload = { countries: { AE: {}, PA: {} } };
    assert.equal(declareRecords(payload), 2);
  });

  it('returns 0 for empty countries map (valid zero state)', () => {
    assert.equal(declareRecords({ countries: {} }), 0);
    assert.equal(declareRecords(null), 0);
    assert.equal(declareRecords({}), 0);
  });
});

describe('credential-leak regression guard', () => {
  it('module source must not embed subscription-key in any URL literal', async () => {
    // Read the seeder source file and assert no literal `subscription-key=`
    // appears anywhere. Belt-and-suspenders even though fetchComtradeFlow
    // uses header auth — if any future refactor adds `subscription-key=`
    // to a URL builder, this test fails before it leaks to prod Redis.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const here = fileURLToPath(import.meta.url);
    const seederPath = here.replace(/\/tests\/.*$/, '/scripts/seed-recovery-reexport-share.mjs');
    const src = await readFile(seederPath, 'utf8');
    // Flag only string-literal embeddings inside '...', "...", or `...`;
    // regex literals (/subscription-key=/i used by the defensive serialize
    // check) are intentional safeguards, not leaks.
    // [^'\n] variant prevents the regex from spanning across multiple
    // lines, which would falsely match any two unrelated quotes that
    // happen to sandwich a `subscription-key=` reference elsewhere.
    const stringLitMatches = [
      ...src.matchAll(/'[^'\n]*subscription-key=[^'\n]*'/g),
      ...src.matchAll(/"[^"\n]*subscription-key=[^"\n]*"/g),
      ...src.matchAll(/`[^`\n]*subscription-key=[^`\n]*`/g),
    ];
    assert.equal(stringLitMatches.length, 0,
      `found hardcoded subscription-key in string literal: ${stringLitMatches.map(m => m[0]).join(', ')}`);
  });
});
