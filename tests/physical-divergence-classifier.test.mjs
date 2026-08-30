import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  METHODOLOGY_VERSION,
  buildPhysicalStressComposite,
  buildPhysicalDivergenceReading,
  classifyPhysicalPremiumRegime,
  createPhysicalPremiumTransition,
  robustZScore,
} from '../scripts/lib/physical-divergence.mjs';
import { isPhysicalDivergencePrintStale } from '../shared/physical-divergence-staleness.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.parse('2026-10-10T12:00:00.000Z');
const FX = {
  source: 'shared:fx-rates:v1',
  pair: 'CNY/USD',
  asOf: '2026-10-10T11:30:00.000Z',
};

function point(index, premiumPct = index / 100, overrides = {}) {
  return {
    date: new Date(Date.parse('2026-10-01T00:00:00.000Z') - index * DAY_MS)
      .toISOString()
      .slice(0, 10),
    premiumPct,
    premiumUsdPerOz: premiumPct * 10,
    physicalAsOf: new Date(Date.parse('2026-10-01T00:00:00.000Z') - index * DAY_MS)
      .toISOString()
      .slice(0, 10),
    paperAsOf: new Date(Date.parse('2026-10-01T12:00:00.000Z') - index * DAY_MS)
      .toISOString(),
    methodologyVersion: METHODOLOGY_VERSION,
    ...overrides,
  };
}

function current(metal = 'gold', overrides = {}) {
  return {
    metal,
    premiumPct: 1.5,
    premiumUsdPerOz: 45,
    physical: { asOf: '2026-10-01' },
    paper: { asOf: '2026-10-10T11:45:00.000Z' },
    ...overrides,
  };
}

describe('physical divergence methodology v1', () => {
  it('keeps the shared stale boundary inclusive through day 12', () => {
    const nowMs = Date.parse('2026-10-13T12:00:00.000Z');
    assert.equal(isPhysicalDivergencePrintStale('2026-10-01', nowMs), false);
    assert.equal(isPhysicalDivergencePrintStale('2026-09-30', nowMs), true);
  });
  it('flips regimes exactly at the documented metal-specific absolute floors', () => {
    assert.equal(classifyPhysicalPremiumRegime('gold', 0.9999, 50), 'normal');
    assert.equal(classifyPhysicalPremiumRegime('gold', 1, 50), 'elevated');
    assert.equal(classifyPhysicalPremiumRegime('gold', 3, 50), 'stressed');
    assert.equal(classifyPhysicalPremiumRegime('gold', 5, 1), 'extreme');

    assert.equal(classifyPhysicalPremiumRegime('silver', 4.9999, 50), 'normal');
    assert.equal(classifyPhysicalPremiumRegime('silver', 5, 50), 'elevated');
    assert.equal(classifyPhysicalPremiumRegime('silver', 10, 50), 'stressed');
    assert.equal(classifyPhysicalPremiumRegime('silver', 20, 1), 'extreme');
  });

  it('flips regimes exactly at the relative percentile thresholds for a positive premium', () => {
    assert.equal(classifyPhysicalPremiumRegime('gold', 0.5, 79.9999), 'normal');
    assert.equal(classifyPhysicalPremiumRegime('gold', 0.5, 80), 'elevated');
    assert.equal(classifyPhysicalPremiumRegime('gold', 0.5, 94.9999), 'elevated');
    assert.equal(classifyPhysicalPremiumRegime('gold', 0.5, 95), 'stressed');
    assert.equal(classifyPhysicalPremiumRegime('gold', 0.5, 98.9999), 'stressed');
    assert.equal(classifyPhysicalPremiumRegime('gold', 0.5, 99), 'extreme');
    assert.equal(classifyPhysicalPremiumRegime('gold', 0, 99), 'normal');
    assert.equal(classifyPhysicalPremiumRegime('gold', -0.5, 99), 'normal');
  });

  it('uses median and MAD instead of mean and standard deviation under an outlier', () => {
    const z = robustZScore(3, [1, 1, 2, 2, 3, 100]);
    assert.ok(z != null);
    assert.ok(Math.abs(z - 0.67448975) < 1e-6);
  });

  it('calculates exact 5-observation and 20-observation trends across every branch', () => {
    const reading = (delta5d, delta20d) => buildPhysicalDivergenceReading({
      metal: 'gold',
      current: current('gold', { premiumPct: 1.5 }),
      history: Array.from({ length: 60 }, (_, index) => point(
        index,
        index === 5 ? 1.5 - delta5d : index === 20 ? 1.5 - delta20d : 1.5,
      )),
      fx: FX,
      nowMs: NOW_MS,
    });

    const wideningNarrowing = reading(0.02, -0.02);
    assert.deepEqual(
      {
        delta5d: wideningNarrowing.delta5d,
        trend5d: wideningNarrowing.trend5d,
        delta20d: wideningNarrowing.delta20d,
        trend20d: wideningNarrowing.trend20d,
      },
      { delta5d: 0.02, trend5d: 'widening', delta20d: -0.02, trend20d: 'narrowing' },
    );

    const narrowingWidening = reading(-0.02, 0.02);
    assert.deepEqual(
      { trend5d: narrowingWidening.trend5d, trend20d: narrowingWidening.trend20d },
      { trend5d: 'narrowing', trend20d: 'widening' },
    );

    const stable = reading(0.01, -0.01);
    assert.deepEqual(
      {
        delta5d: stable.delta5d,
        trend5d: stable.trend5d,
        delta20d: stable.delta20d,
        trend20d: stable.trend20d,
      },
      { delta5d: 0.01, trend5d: 'stable', delta20d: -0.01, trend20d: 'stable' },
    );
  });

  it('keeps an absolute extreme regime when a stressed trailing window degrades the percentile', () => {
    const history = [point(0, 5), ...Array.from({ length: 59 }, (_, index) => point(index + 1, 12))];
    const reading = buildPhysicalDivergenceReading({
      metal: 'gold',
      current: current('gold', { premiumPct: 5, premiumUsdPerOz: 150 }),
      history,
      fx: FX,
      nowMs: NOW_MS,
    });

    assert.equal(reading.state, 'ok');
    assert.equal(reading.regime, 'extreme');
    assert.ok(reading.percentile < 5);
  });

  it('returns insufficient_history at 59 points and ok at 60 points', () => {
    const insufficient = buildPhysicalDivergenceReading({
      metal: 'gold',
      current: current(),
      history: Array.from({ length: 59 }, (_, index) => point(index)),
      fx: FX,
      nowMs: NOW_MS,
    });
    const ready = buildPhysicalDivergenceReading({
      metal: 'gold',
      current: current(),
      history: Array.from({ length: 60 }, (_, index) => point(index)),
      fx: FX,
      nowMs: NOW_MS,
    });

    assert.deepEqual(
      { state: insufficient.state, index: insufficient.index, reason: insufficient.reason },
      { state: 'insufficient_history', index: null, reason: 'history_points_below_60' },
    );
    assert.equal(ready.state, 'ok');
    assert.equal(typeof ready.index, 'number');
  });

  it('tolerates a 9-day Chinese market closure and marks a 13-day gap stale', () => {
    const history = Array.from({ length: 60 }, (_, index) => point(index));
    const tolerated = buildPhysicalDivergenceReading({
      metal: 'gold',
      current: current('gold', { physical: { asOf: '2026-10-01' } }),
      history,
      fx: FX,
      nowMs: Date.parse('2026-10-10T12:00:00.000Z'),
    });
    const stale = buildPhysicalDivergenceReading({
      metal: 'gold',
      current: current('gold', { physical: { asOf: '2026-09-27' } }),
      history,
      fx: FX,
      nowMs: Date.parse('2026-10-10T12:00:00.000Z'),
    });

    assert.equal(tolerated.state, 'ok');
    assert.equal(stale.state, 'stale_input');
    assert.equal(stale.index, null);
    assert.equal(stale.reason, 'physical_print_older_than_12_calendar_days');
  });

  it('marks stale COMEX and FX snapshots as stale_input', () => {
    const history = Array.from({ length: 60 }, (_, index) => point(index));
    const stalePaper = buildPhysicalDivergenceReading({
      metal: 'gold',
      current: current('gold', { paper: { asOf: '2026-10-08T23:59:59.000Z' } }),
      history,
      fx: FX,
      nowMs: NOW_MS,
    });
    const staleFx = buildPhysicalDivergenceReading({
      metal: 'gold',
      current: current('gold'),
      history,
      fx: { ...FX, asOf: '2026-10-07T23:59:59.000Z' },
      nowMs: NOW_MS,
    });

    assert.deepEqual(
      [stalePaper.state, stalePaper.reason, staleFx.state, staleFx.reason],
      ['stale_input', 'paper_snapshot_older_than_36_hours', 'stale_input', 'fx_snapshot_older_than_60_hours'],
    );
  });

  it('keeps missing input distinct from a normal reading', () => {
    const missing = buildPhysicalDivergenceReading({
      metal: 'gold',
      current: null,
      history: [],
      nowMs: NOW_MS,
    });

    assert.deepEqual(
      { state: missing.state, regime: missing.regime, index: missing.index, reason: missing.reason },
      { state: 'missing_input', regime: null, index: null, reason: 'current_premium_missing' },
    );
  });

  it('returns a null composite with a member-specific reason unless every metal is ok', () => {
    const gold = buildPhysicalDivergenceReading({
      metal: 'gold',
      current: current('gold'),
      history: Array.from({ length: 60 }, (_, index) => point(index)),
      fx: FX,
      nowMs: NOW_MS,
    });
    const silver = buildPhysicalDivergenceReading({
      metal: 'silver',
      current: null,
      history: [],
      nowMs: NOW_MS,
    });
    const composite = buildPhysicalStressComposite([gold, silver]);

    assert.equal(composite.state, 'missing_input');
    assert.equal(composite.index, null);
    assert.equal(composite.reason, 'member_not_ok:silver:missing_input');
    assert.equal(composite.methodologyVersion, METHODOLOGY_VERSION);
  });

  it('weights the ok composite 70% gold and 30% silver', () => {
    const composite = buildPhysicalStressComposite([
      { metal: 'gold', state: 'ok', index: 100 },
      { metal: 'silver', state: 'ok', index: 0 },
    ]);

    assert.equal(composite.state, 'ok');
    assert.equal(composite.index, 70);
    assert.deepEqual(
      composite.weights.map(({ metal, weight }) => ({ metal, weight })),
      [{ metal: 'gold', weight: 0.7 }, { metal: 'silver', weight: 0.3 }],
    );
  });

  it('emits one transition, suppresses the same transition during the 48-hour cooldown, and never emits for dead input', () => {
    const base = {
      metal: 'gold',
      state: 'ok',
      reason: '',
      regime: 'normal',
      index: 25,
      methodologyVersion: METHODOLOGY_VERSION,
    };
    const next = { ...base, regime: 'elevated', index: 55 };
    const first = createPhysicalPremiumTransition({ previous: base, next, nowMs: NOW_MS, lastEmittedAtMs: null });
    const repeat = createPhysicalPremiumTransition({ previous: base, next, nowMs: NOW_MS + DAY_MS, lastEmittedAtMs: NOW_MS });
    const unchangedNormal = createPhysicalPremiumTransition({
      previous: base,
      next: { ...base },
      nowMs: NOW_MS + 3 * DAY_MS,
      lastEmittedAtMs: null,
    });
    const unchangedElevated = createPhysicalPremiumTransition({
      previous: next,
      next: { ...next },
      nowMs: NOW_MS + 3 * DAY_MS,
      lastEmittedAtMs: null,
    });
    const dead = createPhysicalPremiumTransition({
      previous: base,
      next: { ...next, state: 'missing_input', regime: null, index: null },
      nowMs: NOW_MS,
      lastEmittedAtMs: null,
    });

    assert.deepEqual(first && { metal: first.metal, from: first.fromRegime, to: first.toRegime }, {
      metal: 'gold', from: 'normal', to: 'elevated',
    });
    assert.equal(repeat, null);
    assert.equal(unchangedNormal, null);
    assert.equal(unchangedElevated, null);
    assert.equal(dead, null);
  });

});
