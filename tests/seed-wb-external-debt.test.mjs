// Pin the WB IDS short-term external debt composition formula and the
// validate floor. Plan 2026-04-25-004 §Component 1.
//
// shortTermDebtPctGni = (DT.DOD.DSTC.IR.ZS / 100) × DT.DOD.DECT.GN.ZS
//
// The pure helper `combineExternalDebt` is exported so this test runs
// fully offline — no network, no recorded fixture file. The seeder's
// network path (`fetchWbExternalDebt`) is the same proven WB API
// pattern as `seed-recovery-external-debt.mjs` (in-tree precedent).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { combineExternalDebt, validate } from '../scripts/seed-wb-external-debt.mjs';

describe('combineExternalDebt — formula composition', () => {
  it('Brazil: 18% of total debt × 35% of GNI = 6.30% short-term debt of GNI', () => {
    const shortTermPctOfTotal = { BR: { value: 18, year: 2023 } };
    const totalDebtPctGni = { BR: { value: 35, year: 2023 } };
    const out = combineExternalDebt({ shortTermPctOfTotal, totalDebtPctGni });
    assert.equal(out.BR.value, 6.30);
    assert.equal(out.BR.year, 2023);
    assert.equal(out.BR.shortTermPctOfTotalDebt, 18);
    assert.equal(out.BR.totalDebtPctOfGni, 35);
  });

  it('Argentina at the IMF Article IV vulnerability threshold (15% GNI) = score-0 anchor', () => {
    // Argentina's 2018 crisis: short-term debt ~25% of total × ~60% of GNI
    // = 15% of GNI → IMF Article IV "vulnerable" tier.
    const shortTermPctOfTotal = { AR: { value: 25, year: 2018 } };
    const totalDebtPctGni = { AR: { value: 60, year: 2018 } };
    const out = combineExternalDebt({ shortTermPctOfTotal, totalDebtPctGni });
    assert.equal(out.AR.value, 15);
  });

  it('uses min(year) when the two source indicators disagree on year', () => {
    // Real-world case: WB IDS publishes the two indicators with different
    // lag patterns. Choose the conservative (older) year.
    const shortTermPctOfTotal = { GH: { value: 22, year: 2022 } };
    const totalDebtPctGni = { GH: { value: 30, year: 2023 } };
    const out = combineExternalDebt({ shortTermPctOfTotal, totalDebtPctGni });
    assert.equal(out.GH.year, 2022, 'must use min(year) — older year is the binding constraint');
    assert.equal(out.GH.yearMismatch, true, 'cross-year composition must be flagged for ops triage');
    // Per-indicator years preserved so downstream consumers can see the
    // actual source vintages without re-fetching.
    assert.equal(out.GH.shortTermPctOfTotalDebtYear, 2022);
    assert.equal(out.GH.totalDebtPctOfGniYear, 2023);
  });

  it('flags yearMismatch=false when both indicators are from the same year (preferred case)', () => {
    const shortTermPctOfTotal = { ZA: { value: 18, year: 2023 } };
    const totalDebtPctGni = { ZA: { value: 30, year: 2023 } };
    const out = combineExternalDebt({ shortTermPctOfTotal, totalDebtPctGni });
    assert.equal(out.ZA.yearMismatch, false, 'single-year payload must not be flagged');
  });

  it('drops country when either source indicator is missing', () => {
    const shortTermPctOfTotal = { ET: { value: 10, year: 2023 } };
    const totalDebtPctGni = { /* ET absent */ };
    const out = combineExternalDebt({ shortTermPctOfTotal, totalDebtPctGni });
    assert.equal(Object.keys(out).length, 0);
  });

  it('drops country when either source has a negative value (invalid)', () => {
    const shortTermPctOfTotal = { XX: { value: -5, year: 2023 } };
    const totalDebtPctGni = { XX: { value: 30, year: 2023 } };
    const out = combineExternalDebt({ shortTermPctOfTotal, totalDebtPctGni });
    assert.equal(Object.keys(out).length, 0);
  });

  it('handles 0% short-term share → 0% of GNI (no short-term debt)', () => {
    const shortTermPctOfTotal = { CL: { value: 0, year: 2023 } };
    const totalDebtPctGni = { CL: { value: 80, year: 2023 } };
    const out = combineExternalDebt({ shortTermPctOfTotal, totalDebtPctGni });
    assert.equal(out.CL.value, 0);
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
