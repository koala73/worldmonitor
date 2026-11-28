import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHOKEPOINT_MAP,
  computeFlowEstimate,
  resolveFlowSource,
  validateFn,
} from '../scripts/seed-chokepoint-flows.mjs';
import { CHOKEPOINTS as BASELINE_CHOKEPOINTS } from '../scripts/seed-chokepoint-baselines.mjs';

/**
 * Builds `count` PortWatch daily rows ending `startOffset` days before today.
 * Only `tanker` / `capTanker` carry signal; the rest exist because the real
 * payload has them.
 */
function makeDays(count, tanker, capTanker, startOffset = 0) {
  const days = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.now() - (startOffset + i) * 86400000);
    days.push({
      date: d.toISOString().slice(0, 10),
      tanker,
      capTanker,
      cargo: 0, other: 0, total: tanker,
      container: 0, dryBulk: 0, generalCargo: 0, roro: 0,
      capContainer: 0, capDryBulk: 0, capGeneralCargo: 0, capRoro: 0,
    });
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

/** 7 recent days at one level, 90 prior days at another. */
const historyWith = ({ recentTanker, recentDwt, baseTanker, baseDwt }) =>
  [
    ...makeDays(7, recentTanker, recentDwt, 0),
    ...makeDays(90, baseTanker, baseDwt, 7),
  ].sort((a, b) => a.date.localeCompare(b.date));

const BASELINE_MBD = 21.0;

describe('computeFlowEstimate — latest PortWatch day', () => {
  it('stamps the estimate with the last day its 7-day window covers', () => {
    const history = makeDays(97, 60, 0, 4);
    const lastDay = history.at(-1).date;
    assert.equal(computeFlowEstimate(history, BASELINE_MBD).latestDate, lastDay);
    assert.notEqual(lastDay, new Date().toISOString().slice(0, 10), 'the fixture lags today, as PortWatch does');
  });

  it('reads the last day from the dates, not from the input order', () => {
    const history = makeDays(97, 60, 0, 4);
    assert.equal(
      computeFlowEstimate([...history].reverse(), BASELINE_MBD).latestDate,
      history.at(-1).date,
    );
  });
});

describe('computeFlowEstimate — flow ratio', () => {
  it('reports ratio 1.0 when the recent week matches the 90-day baseline', () => {
    const estimate = computeFlowEstimate(makeDays(97, 60, 0), BASELINE_MBD);
    assert.equal(estimate.flowRatio, 1);
    assert.equal(estimate.currentMbd, 21);
    assert.equal(estimate.baselineMbd, BASELINE_MBD);
  });

  it('collapses the ratio when recent traffic drops far below baseline', () => {
    const estimate = computeFlowEstimate(
      historyWith({ recentTanker: 5, recentDwt: 0, baseTanker: 60, baseDwt: 0 }),
      BASELINE_MBD,
    );
    assert.ok(estimate.flowRatio < 0.2, `expected <0.2, got ${estimate.flowRatio}`);
    assert.equal(estimate.disrupted, true);
  });

  it('caps the ratio at 1.5 during a surge', () => {
    const estimate = computeFlowEstimate(
      historyWith({ recentTanker: 600, recentDwt: 0, baseTanker: 60, baseDwt: 0 }),
      BASELINE_MBD,
    );
    assert.equal(estimate.flowRatio, 1.5);
    assert.equal(estimate.currentMbd, 31.5);
  });
});

describe('computeFlowEstimate — year-earlier baseline', () => {
  // Hormuz on 2026-11-15: about one tanker a day for months, against 49.3
  // tankers and 2.29M DWT a day in the PortWatch year before. A trailing
  // 90-day baseline sits inside the closure, so it read 82% of 21 mb/d.
  const closedForMonths = () => makeDays(97, 1, 3_077);
  const YEAR_EARLIER = { avgDaily: 87.4, days: 365, from: '2024-11-15', to: '2025-11-14', tankerAvgDaily: 49.3, capTankerAvgDaily: 2_294_291 };

  it('measures a long closure against the year before, not against the closure', () => {
    const estimate = computeFlowEstimate(closedForMonths(), BASELINE_MBD, YEAR_EARLIER);
    assert.ok(estimate.flowRatio < 0.01, `expected <1% of the year-earlier tanker DWT, got ${estimate.flowRatio}`);
    assert.ok(estimate.currentMbd < 0.5, `expected under 0.5 mb/d, got ${estimate.currentMbd}`);
    assert.equal(estimate.disrupted, true);
    assert.equal(estimate.source, 'portwatch-dwt');
  });

  it('falls back to tanker counts when the year-earlier row has no DWT mean', () => {
    const { capTankerAvgDaily: _dwt, ...countsOnly } = YEAR_EARLIER;
    const estimate = computeFlowEstimate(closedForMonths(), BASELINE_MBD, countsOnly);
    assert.equal(estimate.source, 'portwatch-counts');
    assert.equal(estimate.flowRatio, Math.round((1 / 49.3) * 1000) / 1000);
    assert.equal(estimate.disrupted, true);
  });

  it('keeps the trailing 90-day baseline when the year-earlier row carries no tanker means', () => {
    const totalsOnly = { avgDaily: 87.4, days: 365, from: '2024-11-15', to: '2025-11-14' };
    const history = historyWith({ recentTanker: 60, recentDwt: 0, baseTanker: 60, baseDwt: 0 });
    assert.equal(computeFlowEstimate(history, BASELINE_MBD, totalsOnly).flowRatio, 1);
    assert.equal(computeFlowEstimate(history, BASELINE_MBD, null).flowRatio, 1);
  });

  it('uses the tanker-count baseline when recent days carry tankers but no DWT', () => {
    // PortWatch blanks (stored as 0) mean DWT was not reported; a passing
    // tanker always has tonnage. Reading them as zero DWT would report a
    // closure at a strait running normally.
    const history = makeDays(97, 49, 0);
    const estimate = computeFlowEstimate(history, BASELINE_MBD, YEAR_EARLIER);
    assert.equal(estimate.source, 'portwatch-counts');
    assert.ok(Math.abs(estimate.flowRatio - 1) < 0.01, `got ${estimate.flowRatio}`);
    assert.equal(estimate.disrupted, false);
  });

  it('keeps DWT when recent zero tonnage comes with zero tankers: that is a closure', () => {
    const estimate = computeFlowEstimate(makeDays(97, 0, 0), BASELINE_MBD, YEAR_EARLIER);
    assert.equal(estimate.source, 'portwatch-dwt');
    assert.equal(estimate.flowRatio, 0);
    assert.equal(estimate.disrupted, true);
  });

  it('reads a normal week as normal against the year before', () => {
    const estimate = computeFlowEstimate(makeDays(97, 50, 2_300_000), BASELINE_MBD, YEAR_EARLIER);
    assert.ok(Math.abs(estimate.flowRatio - 1) < 0.01, `got ${estimate.flowRatio}`);
    assert.equal(estimate.disrupted, false);
  });
});

describe('computeFlowEstimate — DWT coverage rule', () => {
  it('uses DWT when the baseline window has majority coverage', () => {
    // tanker counts look disrupted (10/60) but DWT is flat — DWT must win.
    const estimate = computeFlowEstimate(
      historyWith({ recentTanker: 10, recentDwt: 50_000, baseTanker: 60, baseDwt: 50_000 }),
      BASELINE_MBD,
    );
    assert.equal(estimate.source, 'portwatch-dwt');
    assert.equal(estimate.flowRatio, 1);
    assert.equal(estimate.disrupted, false);
  });

  it('stays on DWT when recent tankers and DWT both fall to zero — that is the disruption signal', () => {
    const estimate = computeFlowEstimate(
      historyWith({ recentTanker: 0, recentDwt: 0, baseTanker: 60, baseDwt: 50_000 }),
      BASELINE_MBD,
    );
    assert.equal(estimate.source, 'portwatch-dwt');
    assert.equal(estimate.flowRatio, 0);
    assert.equal(estimate.disrupted, true);
  });

  it('uses trailing tanker counts when recent tankers report no DWT', () => {
    // Normal traffic with blank tonnage: PortWatch stores the blank as 0, so
    // DWT would read a closure that the counts do not show.
    const estimate = computeFlowEstimate(
      historyWith({ recentTanker: 60, recentDwt: 0, baseTanker: 60, baseDwt: 50_000 }),
      BASELINE_MBD,
    );
    assert.equal(estimate.source, 'portwatch-counts');
    assert.equal(estimate.flowRatio, 1);
    assert.equal(estimate.disrupted, false);
  });

  it('falls back to counts when DWT covers less than half the baseline', () => {
    // 20 of 90 baseline days carry DWT — below the ceil(n/2) majority guard.
    const history = [
      ...makeDays(7, 60, 50_000, 0),
      ...makeDays(20, 60, 50_000, 7),
      ...makeDays(70, 60, 0, 27),
    ].sort((a, b) => a.date.localeCompare(b.date));
    const estimate = computeFlowEstimate(history, BASELINE_MBD);
    assert.equal(estimate.source, 'portwatch-counts');
  });

  it('maps the coverage basis to the proto JSON names', () => {
    assert.equal(resolveFlowSource(true), 'portwatch-dwt');
    assert.equal(resolveFlowSource(false), 'portwatch-counts');
  });
});

describe('computeFlowEstimate — disruption flag', () => {
  it('does not flag when the last 3 days sit above the 0.85 day-ratio', () => {
    const estimate = computeFlowEstimate(makeDays(97, 55, 0), BASELINE_MBD);
    assert.equal(estimate.disrupted, false);
  });

  it('needs all three trailing days below the threshold, not just some', () => {
    // Two disrupted days followed by a recovered one must clear the flag.
    const history = [
      ...makeDays(1, 60, 0, 0),
      ...makeDays(2, 5, 0, 1),
      ...makeDays(94, 60, 0, 3),
    ].sort((a, b) => a.date.localeCompare(b.date));
    assert.equal(computeFlowEstimate(history, BASELINE_MBD).disrupted, false);
  });
});

describe('computeFlowEstimate — insufficient input', () => {
  it('returns null when history is shorter than the 40-day floor', () => {
    assert.equal(computeFlowEstimate(makeDays(39, 60, 0), BASELINE_MBD), null);
  });

  it('returns null when the baseline average is too thin to divide by', () => {
    assert.equal(computeFlowEstimate(makeDays(97, 0, 0), BASELINE_MBD), null);
  });

  it('returns null without a baseline figure or a history array', () => {
    assert.equal(computeFlowEstimate(makeDays(97, 60, 0), 0), null);
    assert.equal(computeFlowEstimate(null, BASELINE_MBD), null);
  });
});

describe('validateFn', () => {
  it('rejects a degraded payload so runSeed extends TTL instead of overwriting', () => {
    assert.equal(validateFn({}), false);
    assert.equal(validateFn({ a: 1, b: 2 }), false);
    // `data && …` short-circuits, so a nullish payload returns the payload
    // itself rather than `false`; runSeed only needs it falsy.
    assert.ok(!validateFn(null));
    assert.ok(!validateFn(undefined));
  });

  it('accepts a payload carrying at least three chokepoints', () => {
    assert.equal(validateFn({ a: 1, b: 2, c: 3 }), true);
  });
});

describe('portwatch to baseline id mapping', () => {
  it('resolves every mapped baselineId against the baselines seeder table', () => {
    const known = new Set(BASELINE_CHOKEPOINTS.map((c) => c.id));
    for (const cp of CHOKEPOINT_MAP) {
      assert.ok(known.has(cp.baselineId), `unmapped baselineId: ${cp.baselineId}`);
    }
  });

  it('pairs each canonicalId with the baseline row that declares it', () => {
    // The baselines table carries the reverse pointer (relayId), so a shuffled
    // pairing in either file breaks this — greping the two ids separately does not.
    const relayById = new Map(BASELINE_CHOKEPOINTS.map((c) => [c.id, c.relayId]));
    for (const cp of CHOKEPOINT_MAP) {
      assert.equal(relayById.get(cp.baselineId), cp.canonicalId);
    }
  });

  it('covers the full baselines table with no duplicate canonical ids', () => {
    assert.equal(CHOKEPOINT_MAP.length, BASELINE_CHOKEPOINTS.length);
    assert.equal(new Set(CHOKEPOINT_MAP.map((c) => c.canonicalId)).size, CHOKEPOINT_MAP.length);
  });
});
