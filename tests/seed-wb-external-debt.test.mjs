// Pin the WB IDS short-term external debt composition formula and the
// validate floor. Plan 2026-04-25-004 §Component 1.
//
// shortTermDebtPctGni = (DT.DOD.DSTC.CD / NY.GNP.MKTP.CD) × 100
//
// Both source indicators are absolute USD values; the ratio is computed
// directly. Earlier draft used `DT.DOD.DSTC.IR.ZS` × `DT.DOD.DECT.GN.ZS`
// which composed gibberish because `DT.DOD.DSTC.IR.ZS` is "% of total
// reserves" (NOT "% of total external debt"). Caught by activation-time
// audit (PR #3407 follow-up).
//
// The pure helper `combineExternalDebt` is exported so this test runs
// fully offline — no network, no recorded fixture file. The seeder's
// network path (`fetchWbExternalDebt`) is the same proven WB API
// pattern as `seed-recovery-external-debt.mjs` (in-tree precedent).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { combineExternalDebt, validate } from '../scripts/seed-wb-external-debt.mjs';

describe('combineExternalDebt — formula composition', () => {
  it('Brazil: $200B short-term debt / $2T GNI = 10% short-term debt of GNI', () => {
    const shortTermDebtUsd = { BR: { value: 200_000_000_000, year: 2023 } };
    const gniUsd = { BR: { value: 2_000_000_000_000, year: 2023 } };
    const out = combineExternalDebt({ shortTermDebtUsd, gniUsd });
    assert.equal(out.BR.value, 10);
    assert.equal(out.BR.year, 2023);
    assert.equal(out.BR.shortTermDebtUsd, 200_000_000_000);
    assert.equal(out.BR.gniUsd, 2_000_000_000_000);
  });

  it('Argentina at the IMF Article IV vulnerability threshold (15% GNI) = score-0 anchor', () => {
    // Argentina's 2018 crisis profile: short-term debt ~$60B, GNI ~$400B → 15% of GNI.
    const shortTermDebtUsd = { AR: { value: 60_000_000_000, year: 2018 } };
    const gniUsd = { AR: { value: 400_000_000_000, year: 2018 } };
    const out = combineExternalDebt({ shortTermDebtUsd, gniUsd });
    assert.equal(out.AR.value, 15);
  });

  it('uses min(year) when the two source indicators disagree on year', () => {
    // Real-world case: WB IDS publishes the two indicators with different
    // lag patterns. Choose the conservative (older) year.
    const shortTermDebtUsd = { GH: { value: 6_000_000_000, year: 2022 } };
    const gniUsd = { GH: { value: 75_000_000_000, year: 2023 } };
    const out = combineExternalDebt({ shortTermDebtUsd, gniUsd });
    assert.equal(out.GH.year, 2022, 'must use min(year) — older year is the binding constraint');
    assert.equal(out.GH.yearMismatch, true, 'cross-year composition must be flagged for ops triage');
    // Per-indicator years preserved so downstream consumers can see the
    // actual source vintages without re-fetching.
    assert.equal(out.GH.shortTermDebtUsdYear, 2022);
    assert.equal(out.GH.gniUsdYear, 2023);
  });

  it('flags yearMismatch=false when both indicators are from the same year (preferred case)', () => {
    const shortTermDebtUsd = { ZA: { value: 30_000_000_000, year: 2023 } };
    const gniUsd = { ZA: { value: 400_000_000_000, year: 2023 } };
    const out = combineExternalDebt({ shortTermDebtUsd, gniUsd });
    assert.equal(out.ZA.yearMismatch, false, 'single-year payload must not be flagged');
  });

  it('drops country when either source indicator is missing', () => {
    const shortTermDebtUsd = { ET: { value: 5_000_000_000, year: 2023 } };
    const gniUsd = { /* ET absent */ };
    const out = combineExternalDebt({ shortTermDebtUsd, gniUsd });
    assert.equal(Object.keys(out).length, 0);
  });

  it('drops country when GNI is zero or negative (cannot normalize)', () => {
    const shortTermDebtUsd = { XX: { value: 1_000_000, year: 2023 } };
    const gniUsd = { XX: { value: 0, year: 2023 } };
    const out = combineExternalDebt({ shortTermDebtUsd, gniUsd });
    assert.equal(Object.keys(out).length, 0);
  });

  it('drops country when short-term debt is negative (invalid)', () => {
    const shortTermDebtUsd = { XX: { value: -1_000_000, year: 2023 } };
    const gniUsd = { XX: { value: 100_000_000_000, year: 2023 } };
    const out = combineExternalDebt({ shortTermDebtUsd, gniUsd });
    assert.equal(Object.keys(out).length, 0);
  });

  it('handles $0 short-term debt → 0% of GNI (no short-term debt)', () => {
    const shortTermDebtUsd = { CL: { value: 0, year: 2023 } };
    const gniUsd = { CL: { value: 300_000_000_000, year: 2023 } };
    const out = combineExternalDebt({ shortTermDebtUsd, gniUsd });
    assert.equal(out.CL.value, 0);
  });

  it('caps result at full ratio (no clamping; very high debt produces high values)', () => {
    // Sri Lanka 2022 default: short-term debt ~$30B, GNI ~$80B → 37.5% — well above 15% threshold.
    // The scorer's normalizeLowerBetter(value, 0, 15) clamps the score, NOT the input value.
    const shortTermDebtUsd = { LK: { value: 30_000_000_000, year: 2022 } };
    const gniUsd = { LK: { value: 80_000_000_000, year: 2022 } };
    const out = combineExternalDebt({ shortTermDebtUsd, gniUsd });
    assert.equal(out.LK.value, 37.5);
  });
});

describe('validate', () => {
  it('rejects empty payload (upstream outage signal)', () => {
    assert.equal(validate({ countries: {} }), false);
  });

  it('rejects payload below 80-country floor', () => {
    const tiny = {};
    for (let i = 0; i < 50; i++) {
      tiny[`X${i.toString().padStart(2, '0')}`] = { value: 5, year: 2023 };
    }
    assert.equal(validate({ countries: tiny }), false);
  });

  it('accepts payload at or above the LMIC coverage floor', () => {
    const ample = {};
    for (let i = 0; i < 100; i++) {
      ample[`X${i.toString().padStart(2, '0')}`] = { value: 5, year: 2023 };
    }
    assert.equal(validate({ countries: ample }), true);
  });
});
