// seed-hormuz chart dates: Power BI returns the date hierarchy columns in a
// per-visual order and the month as an English name. These fixtures copy the
// two shapes the WTO report served on 2026-11-02: crude oil and fertilizer
// arrive as [Month, Day, Year, Value], LNG and agriculture as
// [Year, Month, Day, Value]. The panel slices `date.slice(5)` for its label,
// so every point must be ISO YYYY-MM-DD and each series must run oldest first.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseChartSeries } from '../scripts/seed-hormuz.mjs';

const hierarchy = (table, level) => `${table}.voy_load_date.Variation.Date Hierarchy.${level}`;

const monthDayYear = {
  descriptor: {
    Select: [
      { Kind: 1, Value: 'G2', Name: hierarchy('Crude Oil Exports_Full range of dates', 'Year') },
      { Kind: 1, Value: 'G0', Name: hierarchy('Crude Oil Exports_Full range of dates', 'Month') },
      { Kind: 1, Value: 'G1', Name: hierarchy('Crude Oil Exports_Full range of dates', 'Day') },
      { Kind: 2, Value: 'M0', Name: 'Sum(Crude Oil Exports_Full range of dates.voy_intake_index)' },
      null,
    ],
  },
  dsr: {
    DS: [{
      N: 'DS0',
      PH: [{
        DM0: [
          { S: [{ N: 'G0', T: 1 }, { N: 'G1', T: 4 }, { N: 'G2', T: 4 }, { N: 'M0', T: 3 }], C: ['October', 30, 2025, '12.5'] },
          { C: [2026, '40.25'], R: 3 },
          { C: [31, 2025, '7'], R: 1 },
          { C: [2026, 0], R: 3 },
          { C: ['November', 1, 2025, '3'] },
          { C: [2026, '9.5'], R: 3 },
        ],
      }],
    }],
  },
};

const yearMonthDay = {
  descriptor: {
    Select: [
      { Kind: 1, Value: 'G0', Name: hierarchy('Grain plus Agriprod Imports_Full range of dates', 'Year') },
      { Kind: 1, Value: 'G1', Name: hierarchy('Grain plus Agriprod Imports_Full range of dates', 'Month') },
      { Kind: 1, Value: 'G2', Name: hierarchy('Grain plus Agriprod Imports_Full range of dates', 'Day') },
      { Kind: 2, Value: 'M0', Name: 'Sum(Grain plus Agriprod Imports_Full range of dates.voy_intake_index)' },
      null,
    ],
  },
  dsr: {
    DS: [{
      N: 'DS0',
      PH: [{
        DM0: [
          { S: [{ N: 'G0', T: 4 }, { N: 'G1', T: 1 }, { N: 'G2', T: 4 }, { N: 'M0', T: 3 }], C: [2026, 'October', 30, '164.3158130973963'] },
          { C: [31], R: 11 },
          { C: ['November', 1, 0], R: 1 },
          { C: [2, '82.5'], R: 3 },
        ],
      }],
    }],
  },
};

const cutoff = new Date('2026-10-03T00:00:00Z');

describe('parseChartSeries: Power BI date hierarchy to ISO series', () => {
  it('reads a [Month, Day, Year] visual as ISO dates, oldest first, inside the window', () => {
    assert.deepEqual(parseChartSeries(monthDayYear, cutoff), [
      { date: '2026-10-30', value: 40.25 },
      { date: '2026-10-31', value: 0 },
      { date: '2026-11-01', value: 9.5 },
    ]);
  });

  it('reads a [Year, Month, Day] visual as ISO dates, oldest first', () => {
    assert.deepEqual(parseChartSeries(yearMonthDay, cutoff), [
      { date: '2026-10-30', value: 164.3158130973963 },
      { date: '2026-10-31', value: 164.3158130973963 },
      { date: '2026-11-01', value: 0 },
      { date: '2026-11-02', value: 82.5 },
    ]);
  });

  it('rejects rows whose date hierarchy it cannot name, so the run keeps the last good snapshot', () => {
    const unnamed = { ...yearMonthDay, descriptor: { Select: [] } };
    assert.throws(() => parseChartSeries(unnamed, cutoff), /date hierarchy/);
  });

  it('returns no points for a visual with no rows', () => {
    assert.deepEqual(parseChartSeries({ descriptor: yearMonthDay.descriptor, dsr: { DS: [{ PH: [{ DM0: [] }] }] } }, cutoff), []);
  });
});
