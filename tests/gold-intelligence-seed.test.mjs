import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildInstrument, computeNextCotRelease } from '../scripts/seed-cot.mjs';

describe('seed-cot: computeNextCotRelease', () => {
  it('returns report date + 3 days for a Tuesday report', () => {
    // 2026-04-07 is a Tuesday; next Friday release is 2026-04-10
    assert.equal(computeNextCotRelease('2026-04-07'), '2026-04-10');
  });

  it('handles month rollover', () => {
    assert.equal(computeNextCotRelease('2026-03-31'), '2026-04-03');
  });

  it('returns empty for empty input', () => {
    assert.equal(computeNextCotRelease(''), '');
  });

  it('returns empty for invalid date', () => {
    assert.equal(computeNextCotRelease('not-a-date'), '');
  });
});

describe('seed-cot: buildInstrument (commodity kind)', () => {
  const gcTarget = { name: 'Gold', code: 'GC' };

  it('computes managed money net % and OI share', () => {
    const current = {
      report_date_as_yyyy_mm_dd: '2026-04-07',
      open_interest_all: '600000',
      m_money_positions_long_all: '200000',
      m_money_positions_short_all: '50000',
      swap_positions_long_all: '30000',
      swap__positions_short_all: '180000',
    };
    const inst = buildInstrument(gcTarget, current, null, 'commodity');
    assert.equal(inst.code, 'GC');
    assert.equal(inst.openInterest, 600000);
    assert.equal(inst.nextReleaseDate, '2026-04-10');
    // MM: (200000-50000)/(250000) = 60%
    assert.equal(inst.managedMoney.netPct, 60);
    // MM OI share: 250000/600000 = 41.67%
    assert.ok(Math.abs(inst.managedMoney.oiSharePct - 41.67) < 0.05);
    // Producer/Swap: (30000-180000)/(210000) ≈ -71.43%
    assert.ok(Math.abs(inst.producerSwap.netPct - -71.43) < 0.05);
    assert.equal(inst.managedMoney.wowNetDelta, 0);
  });

  it('computes WoW net delta from prior row', () => {
    const current = {
      report_date_as_yyyy_mm_dd: '2026-04-07',
      open_interest_all: '600000',
      m_money_positions_long_all: '200000',
      m_money_positions_short_all: '50000',
      swap_positions_long_all: '30000',
      swap__positions_short_all: '180000',
    };
    const prior = {
      report_date_as_yyyy_mm_dd: '2026-03-31',
      m_money_positions_long_all: '180000',
      m_money_positions_short_all: '60000',
      swap_positions_long_all: '40000',
      swap__positions_short_all: '170000',
    };
    const inst = buildInstrument(gcTarget, current, prior, 'commodity');
    // Prior MM net = 180000-60000 = 120000; current = 200000-50000 = 150000; delta = +30000
    assert.equal(inst.managedMoney.wowNetDelta, 30000);
    // Prior P/S net = 40000-170000 = -130000; current = 30000-180000 = -150000; delta = -20000
    assert.equal(inst.producerSwap.wowNetDelta, -20000);
  });

  it('builds financial instrument from TFF fields', () => {
    const target = { name: '10-Year T-Note', code: 'ZN' };
    const current = {
      report_date_as_yyyy_mm_dd: '2026-04-07',
      open_interest_all: '5000000',
      asset_mgr_positions_long: '1500000',
      asset_mgr_positions_short: '500000',
      dealer_positions_long_all: '400000',
      dealer_positions_short_all: '1600000',
    };
    const inst = buildInstrument(target, current, null, 'financial');
    assert.equal(inst.managedMoney.longPositions, 1500000);
    assert.equal(inst.producerSwap.longPositions, 400000);
    assert.equal(inst.managedMoney.netPct, 50); // (1.5M-0.5M)/2M
  });

  it('preserves leveragedFunds fields for financial TFF consumers', () => {
    const target = { name: '10-Year T-Note', code: 'ZN' };
    const current = {
      report_date_as_yyyy_mm_dd: '2026-04-07',
      open_interest_all: '5000000',
      asset_mgr_positions_long: '1500000',
      asset_mgr_positions_short: '500000',
      lev_money_positions_long: '750000',
      lev_money_positions_short: '250000',
      dealer_positions_long_all: '400000',
      dealer_positions_short_all: '1600000',
    };
    const inst = buildInstrument(target, current, null, 'financial');
    // Regression guard: CotPositioningPanel reads these for the Leveraged Funds bar.
    assert.equal(inst.leveragedFundsLong, 750000);
    assert.equal(inst.leveragedFundsShort, 250000);
  });

  it('commodity instruments emit leveragedFunds as 0 (no equivalent field in disaggregated report)', () => {
    const current = {
      report_date_as_yyyy_mm_dd: '2026-04-07',
      open_interest_all: '100000',
      m_money_positions_long_all: '10000',
      m_money_positions_short_all: '5000',
      swap_positions_long_all: '2000',
      swap__positions_short_all: '8000',
    };
    const inst = buildInstrument(gcTarget, current, null, 'commodity');
    assert.equal(inst.leveragedFundsLong, 0);
    assert.equal(inst.leveragedFundsShort, 0);
  });

  it('preserves legacy flat fields for backward compat', () => {
    const current = {
      report_date_as_yyyy_mm_dd: '2026-04-07',
      open_interest_all: '100000',
      m_money_positions_long_all: '10000',
      m_money_positions_short_all: '5000',
      swap_positions_long_all: '2000',
      swap__positions_short_all: '8000',
    };
    const inst = buildInstrument(gcTarget, current, null, 'commodity');
    assert.equal(inst.assetManagerLong, 10000);
    assert.equal(inst.dealerShort, 8000);
    assert.equal(inst.netPct, inst.managedMoney.netPct);
  });
});
