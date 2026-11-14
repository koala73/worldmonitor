import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyPasses, classifyStatus, computeChange, levelAt, seasonalBaseline } from '../scripts/_reservoir-levels.mjs';

const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

function pass(dateIso, levelM, extra = {}) {
  const t = Date.parse(`${dateIso}T12:00:00Z`);
  return { time: `${iso(t).slice(0, 16)}Z`, date: dateIso, rgt: extra.rgt ?? (Math.floor(t / DAY) % 1387), levelM, madM: 0.03, n: 50, beamSpreadM: 0.05, ...extra };
}

/** Passes every `stepDays` from start to end with level fn(tMs). */
function series(startIso, endIso, stepDays, fn) {
  const out = [];
  for (let t = Date.parse(`${startIso}T12:00:00Z`); t <= Date.parse(`${endIso}T12:00:00Z`); t += stepDays * DAY) {
    out.push(pass(iso(t).slice(0, 10), Math.round(fn(t) * 1000) / 1000));
  }
  return out;
}

const metrics = (passes, nowIso) => computeChange(classifyPasses(passes), Date.parse(`${nowIso}T00:00:00Z`));

describe('latest and previous pass', () => {
  it('returns insufficient_history with nulls when there is no ok pass', () => {
    const m = metrics([pass('2026-01-01', 10, { madM: 0.9 })], '2026-03-01');
    assert.equal(m.latest, null);
    assert.equal(m.status, 'insufficient_history');
    assert.equal(m.change30dM, null);
    assert.deepEqual(m.series, []);
  });

  it('reports the latest ok pass with its age and the change from the previous ok pass', () => {
    const m = metrics([pass('2026-01-01', 100), pass('2026-01-11', 100.4), pass('2026-01-20', 99, { n: 3 })], '2026-03-02');
    assert.deepEqual(m.latest, { date: '2026-01-11', levelM: 100.4, madM: 0.03, segmentCount: 50, ageDays: 49 });
    assert.equal(m.prevDate, '2026-01-01');
    assert.equal(m.changePrevM, 0.4);
  });
});

describe('windowed changes', () => {
  it('interpolates the level at t-30d between bracketing passes', () => {
    // passes at day 0 (level 100) and day 20 (102); latest at day 50 (105): t-30 = day 20.
    const m = metrics([pass('2026-01-01', 100), pass('2026-01-11', 101), pass('2026-01-21', 102), pass('2026-02-20', 105)], '2026-03-01');
    assert.equal(m.change30dM, 3);
  });

  it('interpolates linearly when the target falls between passes', () => {
    // t-30 = 2026-01-16, between 01-11 (101) and 01-21 (102) -> 101.5
    const m = metrics([pass('2026-01-11', 101), pass('2026-01-21', 102), pass('2026-02-15', 103)], '2026-03-01');
    assert.equal(m.change30dM, 1.5);
  });

  it('is null when no ok pass lies within the tolerance of the target date', () => {
    // t-30 = 2026-03-03; nearest passes 2026-01-01 and 2026-04-02 are 61 and 30 days away? -> 30 > 20
    const m = metrics([pass('2026-01-01', 100), pass('2026-04-02', 103)], '2026-04-10');
    assert.equal(m.change30dM, null);
    // within 20 days on one side is enough
    const m2 = metrics([pass('2026-01-01', 100), pass('2026-02-15', 102), pass('2026-04-02', 103)], '2026-04-10');
    assert.notEqual(m2.change30dM, null);
  });

  it('never extrapolates before the first pass', () => {
    const m = metrics([pass('2026-03-20', 100), pass('2026-04-02', 103)], '2026-04-10');
    assert.equal(m.change30dM, null);
    assert.equal(m.change90dM, null);
    assert.equal(m.change365dM, null);
  });

  it('uses a 45-day tolerance for the 90-day and 365-day windows', () => {
    const passes = [pass('2025-02-15', 90), pass('2025-11-20', 95), pass('2026-04-01', 100)];
    // t-90 = 2026-01-01: nearest pass 2025-11-20 is 42 days away -> computable
    // t-365 = 2025-04-01: nearest pass 2025-02-15 is 45 days away -> computable
    const m = metrics(passes, '2026-04-10');
    assert.notEqual(m.change90dM, null);
    assert.notEqual(m.change365dM, null);
    const m2 = metrics([pass('2025-02-10', 90), pass('2025-11-10', 95), pass('2026-04-01', 100)], '2026-04-10');
    assert.equal(m2.change90dM, null); // 52 days away
    assert.equal(m2.change365dM, null); // 50 days away
  });

  it('levelAt returns null outside the record and an exact level at a pass', () => {
    const ok = classifyPasses([pass('2026-01-01', 1), pass('2026-01-11', 2)]).filter((p) => p.ok);
    assert.equal(levelAt(ok, Date.parse('2025-12-31T00:00:00Z'), 20), null);
    assert.equal(levelAt(ok, Date.parse('2026-01-11T12:00:00Z'), 20), 2);
  });
});

describe('seasonal anomaly', () => {
  // Seasonal cycle: sin over the year, amplitude 2 m, base 100, plus a year offset.
  const seasonal = (yearOffset) => (t) => 100 + 2 * Math.sin((2 * Math.PI * (t / DAY)) / 365.25) + yearOffset(new Date(t).getUTCFullYear());

  it('needs at least three prior years in the day-of-year window', () => {
    const two = series('2023-03-01', '2025-03-20', 20, seasonal(() => 0));
    const m = metrics(two, '2025-04-01');
    assert.equal(m.seasonalAnomalyM, null);
    assert.equal(m.seasonalZ, null);
    const three = series('2022-03-01', '2025-03-20', 20, seasonal(() => 0));
    const m3 = metrics(three, '2025-04-01');
    assert.notEqual(m3.seasonalAnomalyM, null);
    assert.ok(Math.abs(m3.seasonalAnomalyM) < 1);
  });

  it('measures the latest level against the median of prior years and floors sigma at 0.25 m', () => {
    // Flat 100 m in prior years, latest 99 m: anomaly -1, MAD 0 -> sigma 0.25 -> z = -4.
    const prior = series('2021-01-01', '2025-12-31', 15, () => 100);
    const m = metrics([...prior, pass('2026-02-01', 99)], '2026-03-01');
    assert.equal(m.seasonalAnomalyM, -1);
    assert.equal(m.seasonalZ, -4);
  });

  it('uses 1.4826 x MAD of the sample when larger than the floor', () => {
    // Prior years at the same season: 98, 100, 102 (+ repeats). Median 100, MAD 2 -> sigma 2.9652.
    const prior = [];
    for (const [y, lvl] of [[2022, 98], [2023, 100], [2024, 102]]) {
      prior.push(pass(`${y}-02-01`, lvl), pass(`${y}-07-01`, 100));
    }
    const m = metrics([...prior, pass('2025-07-01', 100), pass('2026-02-03', 103)], '2026-03-01');
    assert.equal(m.seasonalAnomalyM, 3);
    assert.equal(m.seasonalZ, Math.round((3 / 2.9652) * 100) / 100);
  });
});

describe('record range', () => {
  it('needs three years of record and a 1 m range', () => {
    const short = series('2024-06-01', '2026-02-01', 30, (t) => 100 + (t % (90 * DAY)) / (30 * DAY));
    const m = metrics(short, '2026-03-01');
    assert.notEqual(m.recordMinM, null);
    assert.equal(m.percentOfRange, null);
    assert.equal(m.recordLow, false);
    const flat = series('2020-01-01', '2026-02-01', 30, (t) => 100 + 0.4 * Math.sin(t / (40 * DAY)));
    assert.equal(metrics(flat, '2026-03-01').percentOfRange, null);
  });

  it('computes percent of range and the record start', () => {
    const passes = [pass('2020-01-01', 100), pass('2021-06-01', 110), pass('2023-01-01', 105), pass('2026-01-01', 102.5)];
    const m = metrics(passes, '2026-02-01');
    assert.equal(m.recordMinM, 100);
    assert.equal(m.recordMaxM, 110);
    assert.equal(m.recordStart, '2020-01-01');
    assert.equal(m.percentOfRange, 25);
  });
});

describe('status', () => {
  const base = [pass('2020-01-01', 100), pass('2021-06-01', 110), pass('2023-01-01', 105)];

  it('no_recent_data wins over everything once the latest pass is older than 150 days', () => {
    const m = metrics([...base, pass('2025-06-01', 99)], '2025-11-01');
    assert.equal(m.latest.ageDays, 152); // pass at 12:00 UTC, floor of 152.5 days
    assert.equal(m.status, 'no_recent_data');
  });

  it('record_low and record_high', () => {
    assert.equal(metrics([...base, pass('2026-01-01', 99)], '2026-02-01').status, 'record_low');
    assert.equal(metrics([...base, pass('2026-01-01', 111)], '2026-02-01').status, 'record_high');
  });

  it('falling_fast and rising_fast use max(2 m, 15% of range) over 90 days', () => {
    // range 100..110 -> threshold max(2, 1.5) = 2
    const fall = [...base, pass('2025-10-01', 108), pass('2025-11-15', 107), pass('2026-01-01', 105.9)];
    // t-90 = 2025-10-03, interpolated 107.956 m
    assert.equal(metrics(fall, '2026-02-01').change90dM, -2.056);
    assert.equal(metrics(fall, '2026-02-01').status, 'falling_fast');
    const notFast = [...base, pass('2025-10-01', 108), pass('2025-11-15', 107), pass('2026-01-01', 106.1)];
    assert.equal(metrics(notFast, '2026-02-01').status, 'normal');
    const rise = [...base, pass('2025-10-01', 102), pass('2025-11-15', 103), pass('2026-01-01', 104.2)];
    assert.equal(metrics(rise, '2026-02-01').status, 'rising_fast');
    // Large range: 15% of a 40 m range = 6 m, so a 3 m fall is not fast.
    const big = [pass('2020-01-01', 100), pass('2021-06-01', 140), pass('2023-01-01', 120), pass('2025-10-01', 123), pass('2026-01-01', 120)];
    assert.equal(metrics(big, '2026-02-01').status, 'normal');
  });

  it('low and high from percent of range', () => {
    assert.equal(metrics([...base, pass('2026-01-01', 101.4)], '2026-02-01').status, 'low');
    assert.equal(metrics([...base, pass('2026-01-01', 108.6)], '2026-02-01').status, 'high');
    assert.equal(metrics([...base, pass('2026-01-01', 105)], '2026-02-01').status, 'normal');
  });

  it('low and high from the seasonal z-score when the range is not usable', () => {
    // Flat 100 m for five years -> range < 1 m; latest 99.5 -> z = -2
    const prior = series('2021-01-01', '2025-12-31', 15, () => 100);
    assert.equal(metrics([...prior, pass('2026-02-01', 99.5)], '2026-03-01').status, 'low');
    assert.equal(metrics([...prior, pass('2026-02-01', 100.5)], '2026-03-01').status, 'high');
    assert.equal(metrics([...prior, pass('2026-02-01', 100.1)], '2026-03-01').status, 'normal');
  });

  it('insufficient_history when neither percent of range nor z is computable', () => {
    const m = metrics([pass('2025-06-01', 100), pass('2025-09-01', 100.5), pass('2026-01-01', 100.2)], '2026-02-01');
    assert.equal(m.percentOfRange, null);
    assert.equal(m.seasonalZ, null);
    assert.equal(m.status, 'insufficient_history');
  });

  it('classifyStatus orders rules exactly', () => {
    const latest = { ageDays: 10 };
    assert.equal(classifyStatus({ latest, recordLow: true, recordHigh: true, change90dM: 10 }, 10), 'record_low');
    assert.equal(classifyStatus({ latest, recordHigh: true, change90dM: -10 }, 10), 'record_high');
    assert.equal(classifyStatus({ latest, change90dM: -3, percentOfRange: 99 }, 10), 'falling_fast');
    assert.equal(classifyStatus({ latest, change90dM: 3, percentOfRange: 1 }, 10), 'rising_fast');
    assert.equal(classifyStatus({ latest, change90dM: 0, percentOfRange: 50, seasonalZ: -1.5 }, 10), 'low');
    // The seasonal z-score decides when it exists; percent of range is the fallback only.
    assert.equal(classifyStatus({ latest, change90dM: 0, percentOfRange: 15, seasonalZ: 3 }, 10), 'high');
    assert.equal(classifyStatus({ latest, change90dM: 0, percentOfRange: 13, seasonalZ: -0.1 }, 10), 'normal');
    assert.equal(classifyStatus({ latest, change90dM: null, percentOfRange: 15, seasonalZ: null }, 10), 'low');
    // With a seasonal baseline, a fast call needs the raw move and the excess to agree.
    assert.equal(classifyStatus({ latest, change90dM: 28, change90dExcessM: 1.9, seasonalZ: -0.8 }, 40), 'normal');
    assert.equal(classifyStatus({ latest, change90dM: 13, change90dExcessM: -9, seasonalZ: -0.4 }, 40), 'normal');
    assert.equal(classifyStatus({ latest, change90dM: 34, change90dExcessM: null, seasonalZ: 0.1 }, 40), 'normal');
    assert.equal(classifyStatus({ latest, change90dM: -3, change90dExcessM: -3.9, seasonalZ: -2.4 }, 10), 'falling_fast');
    assert.equal(classifyStatus({ latest, change90dM: 11, change90dExcessM: 10, seasonalZ: 0.4 }, 20), 'rising_fast');
    assert.equal(classifyStatus({ latest, change90dM: null, percentOfRange: 85, seasonalZ: null }, 10), 'high');
    assert.equal(classifyStatus({ latest, change90dM: null, percentOfRange: null, seasonalZ: null }, 10), 'insufficient_history');
    assert.equal(classifyStatus({ latest: { ageDays: 151 }, recordLow: true }, 10), 'no_recent_data');
    assert.equal(classifyStatus({ latest: null }, 10), 'insufficient_history');
  });
});

describe('series and ended records', () => {
  it('keeps 36 months of ok passes with one point per day', () => {
    const passes = series('2021-01-01', '2026-01-01', 10, () => 100);
    passes.push(pass('2026-01-05', 100, { rgt: 76 }), pass('2026-01-05', 101, { rgt: 77 })); // two passes on one day
    passes.push(pass('2025-06-01', 50, { n: 2 })); // not ok
    const m = metrics(passes, '2026-02-01');
    assert.equal(m.series[0][0] >= '2023-01-05', true);
    assert.ok(m.series[0][0] <= '2023-01-15');
    assert.equal(m.series.at(-1)[0], '2026-01-05');
    assert.equal(m.series.at(-1)[1], 100.5);
    assert.equal(new Set(m.series.map((p) => p[0])).size, m.series.length);
    assert.ok(!m.series.some(([, l]) => l === 50));
  });

  it('a Kakhovka-style series shows the collapse and then reports no_recent_data, not an error', () => {
    const before = series('2018-11-01', '2023-05-30', 12, (t) => 16 + 0.8 * Math.sin(t / (60 * DAY)));
    const after = [pass('2023-06-12', 9.5), pass('2023-06-25', 4.1), pass('2023-07-20', 3.2), pass('2023-09-01', 3.0)];
    const m = metrics([...before, ...after], '2026-11-01');
    assert.equal(m.status, 'no_recent_data');
    assert.equal(m.latest.date, '2023-09-01');
    assert.equal(m.latest.levelM, 3);
    assert.ok(m.latest.ageDays > 1000);
    assert.equal(m.recordLow, true);
    assert.ok(m.series.some(([d, l]) => d === '2023-06-12' && l === 9.5), 'the drawdown passes are kept');
  });
});

describe('seasonal reservoirs and the newest pass', () => {
  // Annual cycle: 100 m in winter, 130 m at the late-summer peak, same every year.
  const cycle = (t) => 115 - 15 * Math.cos(2 * Math.PI * ((t / DAY - 45) % 365.25) / 365.25);

  it('does not call a normal annual fill rising_fast', () => {
    const passes = series('2019-01-01', '2026-08-20', 20, cycle);
    const m = metrics(passes, '2026-09-01');
    assert.ok(m.change90dM > 10, `expected a large seasonal rise, got ${m.change90dM}`);
    assert.ok(Math.abs(m.change90dExcessM) < 3, `excess ${m.change90dExcessM}`);
    assert.equal(m.status, 'normal');
  });

  it('calls a fall that the season does not explain falling_fast', () => {
    const passes = series('2019-01-01', '2026-08-20', 20, (t) => cycle(t) - (t > Date.parse('2026-05-20') ? (t - Date.parse('2026-05-20')) / DAY * 0.3 : 0));
    const m = metrics(passes, '2026-09-01');
    assert.ok(m.change90dM <= -6, `raw ${m.change90dM}`);
    assert.ok(m.change90dExcessM <= -6, `excess ${m.change90dExcessM}`);
    assert.equal(m.status, 'falling_fast');
  });

  it('seasonalBaseline needs three earlier seasons and ignores the current one', () => {
    const passes = classifyPasses(series('2024-01-01', '2026-08-20', 20, cycle));
    assert.equal(seasonalBaseline(passes, Date.parse('2026-08-20T12:00:00Z')), null);
    const longer = classifyPasses(series('2021-01-01', '2026-08-20', 20, cycle));
    const b = seasonalBaseline(longer, Date.parse('2026-08-20T12:00:00Z'));
    assert.ok(Math.abs(b.medianM - cycle(Date.parse('2026-08-20T12:00:00Z'))) < 2, `median ${b.medianM}`);
  });

  it('drops a newest pass from a ground track whose earlier passes were despiked', () => {
    const flat = series('2024-01-01', '2026-06-01', 15, () => 100).map((p) => ({ ...p, rgt: 10 }));
    const arm = (d) => pass(d, 121, { rgt: 777 });
    const c = classifyPasses([...flat, arm('2024-03-07'), arm('2024-09-05'), arm('2025-03-06'), arm('2026-06-10')]);
    const newest = c.find((p) => p.date === '2026-06-10');
    assert.equal(newest.ok, false);
    assert.equal(newest.spike, true);
    assert.equal(computeChange(c, Date.parse('2026-07-01')).latest.levelM, 100);
  });

  it('keeps a newest pass that jumps when its track has a clean history', () => {
    const flat = series('2024-01-01', '2026-06-01', 15, () => 100).map((p) => ({ ...p, rgt: 10 }));
    const c = classifyPasses([...flat, pass('2026-06-10', 121, { rgt: 10 })]);
    assert.equal(c.find((p) => p.date === '2026-06-10').ok, true);
  });
});
