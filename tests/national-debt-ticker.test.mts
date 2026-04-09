import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const BASELINE_TS = Date.UTC(2024, 0, 1);
const SECONDS_PER_YEAR = 365.25 * 86400;

function getCurrentDebt(entry: { debtUsd: number; perSecondRate: number; baselineTs: number }, nowMs: number): number {
  const secondsElapsed = (nowMs - entry.baselineTs) / 1000;
  return entry.debtUsd + entry.perSecondRate * secondsElapsed;
}

function formatDebt(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0';
  if (usd >= 1e12) return `$${(usd / 1e12).toFixed(1)}T`;
  if (usd >= 1e9) return `$${(usd / 1e9).toFixed(1)}B`;
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(1)}M`;
  return `$${Math.round(usd).toLocaleString()}`;
}

describe('getCurrentDebt ticking math', () => {
  it('returns base debt at baseline_ts', () => {
    const entry = { debtUsd: 33_600_000_000_000, perSecondRate: 10000, baselineTs: BASELINE_TS };
    const result = getCurrentDebt(entry, BASELINE_TS);
    assert.ok(Math.abs(result - 33_600_000_000_000) < 1, `Expected base debt, got ${result}`);
  });

  it('accrues correctly after 1 hour', () => {
    const perSecondRate = 50_000;
    const entry = { debtUsd: 33_600_000_000_000, perSecondRate, baselineTs: BASELINE_TS };
    const oneHourLater = BASELINE_TS + 3600 * 1000;
    const result = getCurrentDebt(entry, oneHourLater);
    const expected = 33_600_000_000_000 + perSecondRate * 3600;
    assert.ok(Math.abs(result - expected) < 1, `Expected ${expected}, got ${result}`);
  });

  it('accrues correctly after 1 year', () => {
    const deficitPct = 5;
    const gdpUsd = 28_000_000_000_000;
    const perSecondRate = (deficitPct / 100) * gdpUsd / SECONDS_PER_YEAR;
    const entry = { debtUsd: 33_600_000_000_000, perSecondRate, baselineTs: BASELINE_TS };
    const oneYearLater = BASELINE_TS + Math.round(SECONDS_PER_YEAR * 1000);
    const result = getCurrentDebt(entry, oneYearLater);
    const expectedAccrual = (deficitPct / 100) * gdpUsd;
    const accrued = result - entry.debtUsd;
    assert.ok(Math.abs(accrued - expectedAccrual) < 1000, `Accrued ${accrued}, expected ~${expectedAccrual}`);
  });

  it('zero perSecondRate keeps debt flat', () => {
    const entry = { debtUsd: 1_000_000_000_000, perSecondRate: 0, baselineTs: BASELINE_TS };
    const later = BASELINE_TS + 86400_000;
    const result = getCurrentDebt(entry, later);
    assert.ok(Math.abs(result - 1_000_000_000_000) < 1, 'Debt should be flat with zero rate');
  });
});

describe('formatDebt', () => {
  it('formats trillions', () => {
    assert.equal(formatDebt(33_600_000_000_000), '$33.6T');
    assert.equal(formatDebt(1_000_000_000_000), '$1.0T');
    assert.equal(formatDebt(100_000_000_000_000), '$100.0T');
  });

  it('formats billions', () => {
    assert.equal(formatDebt(913_200_000_000), '$913.2B');
    assert.equal(formatDebt(1_000_000_000), '$1.0B');
  });

  it('formats millions', () => {
    assert.equal(formatDebt(12_300_000), '$12.3M');
    assert.equal(formatDebt(1_000_000), '$1.0M');
  });

  it('handles zero and non-finite', () => {
    assert.equal(formatDebt(0), '$0');
    assert.equal(formatDebt(NaN), '$0');
    assert.equal(formatDebt(-1), '$0');
  });
});
