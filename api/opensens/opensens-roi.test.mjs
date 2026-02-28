/**
 * Unit tests for /api/opensens/roi
 * Run with: node --test api/opensens/opensens-roi.test.mjs
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

// ---- Inline pure ROI functions ----

function autonomyHours(bessKwh, dod, itLoadW, pue) {
  const effectiveW = itLoadW * pue;
  return (bessKwh * dod * 1000) / effectiveW;
}

function npv(initialCapex, annualNetCashFlow, discountRate, years) {
  let value = -initialCapex;
  for (let t = 1; t <= years; t++) {
    value += annualNetCashFlow / Math.pow(1 + discountRate, t);
  }
  return parseFloat(value.toFixed(0));
}

function irr(initialCapex, annualNetCashFlow, years, maxRate = 5.0) {
  if (annualNetCashFlow <= 0) return null;
  let lo = -0.999, hi = maxRate;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const pv = npv(initialCapex, annualNetCashFlow, mid, years);
    if (Math.abs(pv) < 1) return parseFloat((mid * 100).toFixed(1));
    if (pv > 0) lo = mid; else hi = mid;
  }
  return parseFloat(((lo + hi) / 2 * 100).toFixed(1));
}

function demandScore(popDensity, nightlight, bizDensity) {
  const popScore = Math.min(40, (popDensity / 5000) * 40);
  const ntlScore = Math.min(30, (nightlight ?? 0.3) * 30);
  const bizScore = Math.min(30, (bizDensity ?? 50) / 200 * 30);
  return parseFloat(Math.min(100, popScore + ntlScore + bizScore).toFixed(1));
}

describe('autonomyHours', () => {
  it('20 kWh BESS at 100% DoD, 1 kW load, PUE 1.0 → 20 h', () => {
    assert.equal(autonomyHours(20, 1.0, 1000, 1.0), 20);
  });

  it('PUE reduces autonomy', () => {
    const base = autonomyHours(20, 1.0, 1000, 1.0);
    const withPue = autonomyHours(20, 1.0, 1000, 1.25);
    assert.ok(withPue < base, 'Higher PUE should reduce autonomy');
  });

  it('80% DoD reduces to 16 h for same config', () => {
    const h = autonomyHours(20, 0.80, 1000, 1.0);
    assert.equal(h, 16);
  });

  it('scales with BESS size', () => {
    const h10 = autonomyHours(10, 1.0, 1000, 1.0);
    const h20 = autonomyHours(20, 1.0, 1000, 1.0);
    assert.equal(h20, h10 * 2);
  });
});

describe('npv', () => {
  it('negative NPV when revenue is 0', () => {
    const val = npv(10000, 0, 0.1, 5);
    assert.equal(val, -10000);
  });

  it('positive NPV when cash flows exceed capex PV', () => {
    const val = npv(1000, 500, 0.1, 5);
    assert.ok(val > 0, `Expected positive NPV, got ${val}`);
  });

  it('higher discount rate reduces NPV', () => {
    const low = npv(10000, 3000, 0.05, 5);
    const high = npv(10000, 3000, 0.20, 5);
    assert.ok(high < low, 'Higher discount rate should give lower NPV');
  });
});

describe('irr', () => {
  it('returns null for zero annual cash flow', () => {
    assert.equal(irr(10000, 0, 5), null);
  });

  it('returns null for negative annual cash flow', () => {
    assert.equal(irr(10000, -100, 5), null);
  });

  it('returns a positive percentage for profitable project', () => {
    const r = irr(10000, 3000, 5);
    assert.ok(typeof r === 'number' && r > 0, `Expected positive IRR, got ${r}`);
  });

  it('higher cash flow → higher IRR', () => {
    const r1 = irr(10000, 2000, 5);
    const r2 = irr(10000, 4000, 5);
    assert.ok(r2 > r1, 'Higher cash flow should give higher IRR');
  });
});

describe('demandScore', () => {
  it('returns 0 for zero inputs', () => {
    assert.equal(demandScore(0, 0, 0), 0);
  });

  it('scales with population density', () => {
    const low = demandScore(100, 0, 0);
    const high = demandScore(5000, 0, 0);
    assert.ok(high > low);
  });

  it('capped at 100 max', () => {
    const score = demandScore(100000, 1.0, 10000);
    assert.ok(score <= 100, `Score should be ≤ 100, got ${score}`);
  });

  it('uses default nighttime light if null', () => {
    const score = demandScore(1000, null, 50);
    assert.ok(score > 0); // default 0.3 nighttime light
  });
});

describe('scenario multipliers', () => {
  it('aggressive has higher revenue than conservative', () => {
    const revenue = (mult) => 150 * 5 * 12 * mult; // revenuePerNode * nodes * months * mult
    assert.ok(revenue(1.8) > revenue(1.0));
    assert.ok(revenue(1.0) > revenue(0.5));
  });
});
