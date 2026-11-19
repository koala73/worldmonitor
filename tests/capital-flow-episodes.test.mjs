// Pins the Forbes & Warnock (2012) episode classifier used by the
// capital-flows seeder. Synthetic series only — fully offline.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  rollingFourQuarterChange,
  classifyEpisodes,
  classifyCountry,
  sumGrossFlows,
  nextQuarter,
} from '../scripts/_capital-flow-episodes.mjs';

function quarters(start, n) {
  const out = [start];
  while (out.length < n) out.push(nextQuarter(out[out.length - 1]));
  return out;
}

// Deterministic small wobble so the rolling standard deviation is non-zero.
function calmSeries(n, base = 100) {
  return Array.from({ length: n }, (_, i) => base + ((i * 7) % 5) - 2);
}

describe('nextQuarter', () => {
  it('rolls Q4 into the next year', () => {
    assert.equal(nextQuarter('2022-Q4'), '2023-Q1');
    assert.equal(nextQuarter('2022-Q2'), '2022-Q3');
  });
});

describe('rollingFourQuarterChange', () => {
  it('is the year-over-year change of the trailing 4-quarter sum', () => {
    const periods = quarters('2000-Q1', 9);
    const values = [1, 1, 1, 1, 2, 2, 2, 2, 5];
    const out = rollingFourQuarterChange(periods, values);
    // C(2001-Q4) = 8, C(2000-Q4) = 4 → ΔC = 4
    assert.equal(out.get('2001-Q4'), 4);
    // C(2002-Q1) = 2+2+2+5 = 11, C(2001-Q1) = 1+1+1+2 = 5 → 6
    assert.equal(out.get('2002-Q1'), 6);
    assert.equal(out.has('2001-Q3'), false, 'needs 8 consecutive quarters');
  });

  it('breaks on a gap instead of summing across missing quarters', () => {
    const periods = ['2000-Q1', '2000-Q2', '2000-Q3', '2000-Q4', '2001-Q1', '2001-Q2', '2001-Q3', '2002-Q1', '2002-Q2'];
    const values = periods.map(() => 1);
    const out = rollingFourQuarterChange(periods, values);
    assert.equal(out.has('2002-Q1'), false);
    assert.equal(out.has('2002-Q2'), false);
  });
});

describe('classifyEpisodes', () => {
  it('flags a spike that crosses 2 sd and extends it while above 1 sd', () => {
    const n = 48;
    const periods = quarters('2000-Q1', n);
    const values = calmSeries(n);
    // Sustained level shift from index 40 (2010-Q1). A level shift avoids the
    // mechanical rebound a temporary spike produces in ΔC four quarters later.
    for (let i = 40; i < n; i++) values[i] += 400;
    const delta = rollingFourQuarterChange(periods, values);
    const { up } = classifyEpisodes(delta);
    assert.ok(up.length >= 1, 'expected an upward episode');
    const ep = up[0];
    assert.equal(ep.start, '2010-Q1');
    assert.ok(ep.peakZ >= 2);
  });

  it('flags a collapse as a downward episode', () => {
    const n = 48;
    const periods = quarters('2000-Q1', n);
    const values = calmSeries(n);
    for (let i = 40; i < n; i++) values[i] -= 400;
    const { down } = classifyEpisodes(rollingFourQuarterChange(periods, values));
    assert.ok(down.length >= 1);
    assert.equal(down[0].start, '2010-Q1');
  });

  it('does not flag a calm series', () => {
    const n = 60;
    const periods = quarters('2000-Q1', n);
    const { up, down } = classifyEpisodes(rollingFourQuarterChange(periods, calmSeries(n)));
    assert.equal(up.length + down.length, 0);
  });

  it('drops a one-quarter blip (episodes must last more than one quarter)', () => {
    const n = 48;
    const periods = quarters('2000-Q1', n);
    const values = calmSeries(n);
    const delta = rollingFourQuarterChange(periods, values);
    // Inject a single-quarter excursion directly into ΔC.
    const blip = new Map(delta);
    const keys = [...blip.keys()];
    blip.set(keys[keys.length - 2], 10_000);
    const { up } = classifyEpisodes(blip);
    assert.equal(up.length, 0);
  });
});

describe('sumGrossFlows', () => {
  it('sums FDI + portfolio + other only when all three components are present', () => {
    const rows = [
      { entry: 'L_NIL_T', indicator: 'D_F', period: '2020-Q1', value: 1 },
      { entry: 'L_NIL_T', indicator: 'P_F', period: '2020-Q1', value: 2 },
      { entry: 'L_NIL_T', indicator: 'O_F', period: '2020-Q1', value: 3 },
      { entry: 'L_NIL_T', indicator: 'D_F', period: '2020-Q2', value: 1 },
      { entry: 'L_NIL_T', indicator: 'P_F', period: '2020-Q2', value: 2 },
      { entry: 'A_NFA_T', indicator: 'D_F', period: '2020-Q1', value: 9 },
    ];
    const out = sumGrossFlows(rows, 'L_NIL_T');
    assert.deepEqual(out, { periods: ['2020-Q1'], values: [6] });
  });
});

describe('classifyCountry', () => {
  it('maps inflow up/down to surge/stop and outflow up/down to flight/retrenchment', () => {
    const n = 48;
    const periods = quarters('2000-Q1', n);
    const inflow = calmSeries(n);
    const outflow = calmSeries(n);
    for (let i = 40; i < n; i++) {
      inflow[i] -= 400; // foreigners pull out → stop
      outflow[i] += 400; // residents send money abroad → flight
    }
    const res = classifyCountry({
      inflows: { periods, values: inflow },
      outflows: { periods, values: outflow },
    });
    assert.equal(res.stop.length, 1);
    assert.equal(res.flight.length, 1);
    assert.equal(res.surge.length, 0);
    assert.equal(res.retrenchment.length, 0);
  });
});
