import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ReservoirLevel, ReservoirLevelStatus } from '../src/services/climate/reservoir-levels.ts';
import {
  RESERVOIR_STATUS_ORDER,
  filterReservoirs,
  formatSignedMetres,
  needsAttention,
  reservoirDetail,
  reservoirHeadline,
  reservoirMeasured,
  reservoirPlace,
  reservoirSparkline,
  reservoirTone,
  reservoirToneRgb,
  resampleByTime,
  sortReservoirs,
  type ReservoirFormatContext,
} from '../src/components/reservoir-levels-view.ts';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const MINUS = '−';

/** Echoes the key and its params so a test can read which copy was chosen and with what. */
const t = (key: string, params?: Record<string, unknown>) =>
  params ? `${key.replace('components.reservoirLevels.', '')}(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(',')})` : key.replace('components.reservoirLevels.', '');
const ctx: ReservoirFormatContext = { t, locale: 'en-GB', nowMs: NOW };

function reservoir(overrides: Partial<ReservoirLevel> = {}): ReservoirLevel {
  return {
    id: 'mead', name: 'Lake Mead', country: 'US', riparians: ['US'], river: 'Colorado',
    lat: 36.1, lon: -114.4, tags: [], why: 'Supplies Las Vegas.',
    latest: { observedAt: new Date('2026-09-06T00:00:00Z'), levelM: 318.4, madM: 0.03, segments: 40, ageDays: 60 },
    prevDate: '2026-08-10', changePrevM: -0.4, change30dM: -0.4, change90dM: -1.1, change365dM: -5.3,
    seasonalAnomalyM: -8.2, seasonalZ: -2.4, recordMinM: 318.4, recordMaxM: 335, recordStart: '2018-10-14',
    percentOfRange: 0, recordLow: true, recordHigh: false, status: 'record_low',
    series: [{ date: '2024-01-01', levelM: 325 }, { date: '2025-01-01', levelM: 322 }, { date: '2026-09-06', levelM: 318.4 }],
    ...overrides,
  };
}

describe('reservoir sort and filters', () => {
  it('orders by attention status, then by |seasonalZ|, then by name', () => {
    const rows = [
      reservoir({ id: 'a', name: 'Normal B', status: 'normal', seasonalZ: 0.2 }),
      reservoir({ id: 'b', name: 'Stale', status: 'no_recent_data', seasonalZ: null }),
      reservoir({ id: 'c', name: 'Low weak', status: 'low', seasonalZ: -1.6 }),
      reservoir({ id: 'd', name: 'High strong', status: 'high', seasonalZ: 2.9 }),
      reservoir({ id: 'e', name: 'Low strong', status: 'low', seasonalZ: -2.8 }),
      reservoir({ id: 'f', name: 'Record', status: 'record_low', seasonalZ: -0.5 }),
      reservoir({ id: 'g', name: 'Low no z', status: 'low', seasonalZ: null }),
      reservoir({ id: 'h', name: 'Normal A', status: 'normal', seasonalZ: 0.2 }),
      reservoir({ id: 'i', name: 'Short', status: 'insufficient_history', seasonalZ: null }),
      reservoir({ id: 'j', name: 'Rising', status: 'rising_fast', seasonalZ: 0.1 }),
    ];
    assert.deepEqual(sortReservoirs(rows).map((r) => r.id), ['f', 'j', 'e', 'c', 'g', 'd', 'h', 'a', 'i', 'b']);
    assert.equal(rows[0]!.id, 'a', 'sort returns a copy');
  });

  it('keeps the status order attention first', () => {
    assert.deepEqual(RESERVOIR_STATUS_ORDER, [
      'record_low', 'record_high', 'falling_fast', 'rising_fast', 'low', 'high', 'normal', 'insufficient_history', 'no_recent_data',
    ]);
  });

  it('treats only abnormal readings as needing attention', () => {
    const calm: ReservoirLevelStatus[] = ['normal', 'insufficient_history', 'no_recent_data'];
    for (const status of RESERVOIR_STATUS_ORDER) assert.equal(needsAttention(status), !calm.includes(status), status);
  });

  it('filters by attention and by the transboundary tag', () => {
    const rows = [
      reservoir({ id: 'gerd', status: 'high', tags: ['transboundary', 'hydropower'] }),
      reservoir({ id: 'tana', status: 'normal', tags: ['transboundary'] }),
      reservoir({ id: 'mead', status: 'record_low', tags: [] }),
      reservoir({ id: 'dukan', status: 'no_recent_data', tags: [] }),
    ];
    assert.deepEqual(filterReservoirs(rows, 'all').map((r) => r.id), ['gerd', 'tana', 'mead', 'dukan']);
    assert.deepEqual(filterReservoirs(rows, 'attention').map((r) => r.id), ['gerd', 'mead']);
    assert.deepEqual(filterReservoirs(rows, 'transboundary').map((r) => r.id), ['gerd', 'tana']);
  });
});

describe('reservoir tones', () => {
  it('maps each status to its colour family', () => {
    assert.deepEqual(RESERVOIR_STATUS_ORDER.map(reservoirTone), [
      'record-low', 'rising', 'falling', 'rising', 'low', 'rising', 'normal', 'muted', 'muted',
    ]);
  });

  it('reads the live theme token and falls back to the dark value', () => {
    assert.deepEqual(reservoirToneRgb('rising', () => '#0055cc'), [0, 85, 204]);
    assert.deepEqual(reservoirToneRgb('rising', () => ''), [51, 136, 255]);
    assert.deepEqual(reservoirToneRgb('falling'), [255, 136, 0]);
  });
});

describe('reservoir wording', () => {
  it('formats signed metres with a true minus sign', () => {
    assert.equal(formatSignedMetres(-8.202, 'en-GB'), `${MINUS}8.2 m`);
    assert.equal(formatSignedMetres(3.31, 'en-GB'), '+3.3 m');
    assert.equal(formatSignedMetres(0, 'en-GB'), '0.0 m');
  });

  it('leads with the seasonal anomaly and moves the 12-month change to the detail line', () => {
    const r = reservoir();
    assert.equal(reservoirHeadline(r, ctx), `vsUsual(value=${MINUS}8.2 m,month=September)`);
    assert.equal(reservoirDetail(r, ctx), `in12Months(value=${MINUS}5.3 m) · measured(date=6 Sept,age=66 days ago)`);
  });

  it('falls back to the 12-month change, then to a plain note', () => {
    const noAnomaly = reservoir({ seasonalAnomalyM: null, seasonalZ: null, change365dM: -12.142 });
    assert.equal(reservoirHeadline(noAnomaly, ctx), `in12Months(value=${MINUS}12.1 m)`);
    assert.equal(reservoirDetail(noAnomaly, ctx), 'measured(date=6 Sept,age=66 days ago)', 'no repeated 12-month change');
    assert.equal(reservoirHeadline(reservoir({ seasonalAnomalyM: null, change365dM: null }), ctx), 'noComparison');
  });

  it('ages a pass from the client clock and shows the year only when it differs', () => {
    const old = reservoir({ latest: { observedAt: new Date('2025-12-30T00:00:00Z'), levelM: 1, madM: 0, segments: 9, ageDays: 1 } });
    assert.equal(reservoirMeasured(old, ctx), 'measured(date=30 Dec 2025,age=316 days ago)');
    assert.equal(reservoirMeasured(old, ctx, true), '30 Dec 2025 (316 days ago)');
    assert.equal(reservoirMeasured(reservoir({ latest: null }), ctx), 'noPass');
  });

  it('names the country in the reader locale and joins the river', () => {
    assert.equal(reservoirPlace(reservoir({ country: 'ET', river: 'Blue Nile' }), 'en'), 'Ethiopia · Blue Nile');
    assert.equal(reservoirPlace(reservoir({ country: 'ET', river: '' }), 'fr'), 'Éthiopie');
    assert.equal(reservoirPlace(reservoir({ country: 'XX-1', river: 'Nile' }), 'en'), 'XX-1 · Nile');
  });

  it('draws a sparkline only with two or more points', () => {
    assert.match(reservoirSparkline(reservoir()), /^<svg[^>]*class="mini-sparkline"/);
    assert.equal(reservoirSparkline(reservoir({ series: [{ date: '2026-09-06', levelM: 318.4 }] })), '');
  });

  it('spaces sparkline readings by elapsed time, not by index', () => {
    // A 5-day gap then a 120-day gap: by index the rise would fill half the chart.
    const values = resampleByTime([
      { date: '2026-01-01', levelM: 0 },
      { date: '2026-01-06', levelM: 10 },
      { date: '2026-05-06', levelM: 10 },
    ], 5);
    assert.equal(values.length, 5);
    assert.equal(values[0], 0);
    for (const v of values.slice(1)) assert.ok(Math.abs(v - 10) < 1e-9, `got ${values}`);
  });

  it('interpolates between readings on the time grid', () => {
    const values = resampleByTime([
      { date: '2026-01-01', levelM: 100 },
      { date: '2026-01-11', levelM: 110 },
    ], 3);
    assert.deepEqual(values.map((v) => Math.round(v * 1000) / 1000), [100, 105, 110]);
  });
});
