import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildInstrument } from '../scripts/seed-cot.mjs';
import { mapCotPositioning } from '../server/worldmonitor/market/v1/get-cot-positioning.ts';

const target = { name: 'S&P 500 E-Mini', code: 'ES' };

describe('COT small-trader positioning', () => {
  it('maps TFF non-reportable positions into the persisted instrument', () => {
    const row = {
      report_date_as_yyyy_mm_dd: '2026-08-04',
      open_interest_all: '1000',
      asset_mgr_positions_long: '300',
      asset_mgr_positions_short: '200',
      dealer_positions_long_all: '250',
      dealer_positions_short_all: '200',
      lev_money_positions_long: '150',
      lev_money_positions_short: '100',
      nonrept_positions_long_all: '70',
      nonrept_positions_short_all: '30',
    };

    const instrument = buildInstrument(target, row, null, 'financial');

    assert.equal(instrument.smallTraderLong, 70);
    assert.equal(instrument.smallTraderShort, 30);
    assert.equal(instrument.smallTraderAvailable, true);
  });

  it('maps Disaggregated non-reportable positions into the same contract', () => {
    const row = {
      report_date_as_yyyy_mm_dd: '2026-08-04',
      open_interest_all: '1000',
      m_money_positions_long_all: '300',
      m_money_positions_short_all: '200',
      swap_positions_long_all: '250',
      swap__positions_short_all: '200',
      nonrept_positions_long_all: '80',
      nonrept_positions_short_all: '20',
    };

    const instrument = buildInstrument({ name: 'Gold', code: 'GC' }, row, null, 'commodity');

    assert.equal(instrument.smallTraderLong, 80);
    assert.equal(instrument.smallTraderShort, 20);
    assert.equal(instrument.smallTraderAvailable, true);
  });

  it('marks old cache-compatible rows as unavailable instead of confirmed zero', () => {
    const instrument = buildInstrument(target, {
      report_date_as_yyyy_mm_dd: '2026-08-04',
      open_interest_all: '1000',
      asset_mgr_positions_long: '300',
      asset_mgr_positions_short: '200',
      dealer_positions_long_all: '250',
      dealer_positions_short_all: '200',
    }, null, 'financial');

    assert.equal(instrument.smallTraderLong, 0);
    assert.equal(instrument.smallTraderShort, 0);
    assert.equal(instrument.smallTraderAvailable, false);
  });

  it('preserves the availability sentinel across the Redis-to-RPC boundary', async () => {
    const response = mapCotPositioning({
      reportDate: '2026-08-04',
      instruments: [
        {
          name: 'Legacy', code: 'OLD', reportDate: '2026-08-04',
          assetManagerLong: 1, assetManagerShort: 2,
          leveragedFundsLong: 3, leveragedFundsShort: 4,
          smallTraderLong: 0, smallTraderShort: 0,
          dealerLong: 5, dealerShort: 6, netPct: 0,
        },
        {
          name: 'Current', code: 'NEW', reportDate: '2026-08-04',
          assetManagerLong: 1, assetManagerShort: 2,
          leveragedFundsLong: 3, leveragedFundsShort: 4,
          smallTraderLong: 7, smallTraderShort: 8, smallTraderAvailable: true,
          dealerLong: 5, dealerShort: 6, netPct: 0,
        },
      ],
    });

    assert.equal(response.unavailable, false);
    assert.equal(response.instruments[0].smallTraderAvailable, false);
    assert.equal(response.instruments[1].smallTraderAvailable, true);
    assert.equal(response.instruments[1].smallTraderLong, '7');
    assert.equal(response.instruments[1].smallTraderShort, '8');
  });
});
