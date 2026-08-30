import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  METHODOLOGY_VERSION,
  TRANSITION_COOLDOWN_MS,
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

describe('physical divergence methodology v2', () => {
  it('keeps the shared stale boundary inclusive through day 12', () => {
    const nowMs = Date.parse('2026-10-13T12:00:00.000Z');
    assert.equal(isPhysicalDivergencePrintStale('2026-10-01', nowMs), false);
    assert.equal(isPhysicalDivergencePrintStale('2026-09-30', nowMs), true);
  });

  it('uses the Shanghai date across the midnight stale boundary', () => {
    const beforeShanghaiMidnight = Date.parse('2026-10-13T15:59:59.999Z');
    const afterShanghaiMidnight = Date.parse('2026-10-13T16:00:00.000Z');
    assert.equal(isPhysicalDivergencePrintStale('2026-10-01', beforeShanghaiMidnight), false);
    assert.equal(isPhysicalDivergencePrintStale('2026-10-01', afterShanghaiMidnight), true);
    assert.equal(isPhysicalDivergencePrintStale('2026-10-02', afterShanghaiMidnight), false);
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

  it('refuses to escalate a trivially small premium that merely tops its own window', () => {
    // The regression this guards: the relative ladder gated on `premiumPct > 0`, a sign test
    // rather than a magnitude test. The current point sits inside its own reference window
    // and percentileRank is inclusive, so ANY new high scores 100 — and a 0.05% gold premium
    // (20x under the 1% elevated floor) classified `extreme`, pinning the index at 100/100
    // on a calm, discounted window. #6448: "percentile-only classification is forbidden".
    assert.equal(classifyPhysicalPremiumRegime('gold', 0.05, 100), 'normal');
    // The gate sits at half the elevated floor — gold 0.5, silver 2.5 — so the documented
    // 80/95/99 ladder above stays reachable rather than collapsing into the absolute floors.
    assert.equal(classifyPhysicalPremiumRegime('gold', 0.4999, 100), 'normal');
    assert.equal(classifyPhysicalPremiumRegime('gold', 0.5, 100), 'extreme');
    assert.equal(classifyPhysicalPremiumRegime('silver', 2.4999, 100), 'normal');
    assert.equal(classifyPhysicalPremiumRegime('silver', 2.5, 100), 'extreme');
  });

  it('keeps index monotonic in regime rank and reserves 100 for absolute extreme (#7423)', () => {
    // Relative-only extreme: gold at half the elevated floor topping a calm window.
    // Absolute stress for 0.5% is well below the extreme premium floor; the published index
    // must still clear every stressed reading without saturating the 0–100 scale at 100.
    const relativeExtreme = buildPhysicalDivergenceReading({
      metal: 'gold',
      current: current('gold', { premiumPct: 0.5, premiumUsdPerOz: 15 }),
      history: [
        point(0, 0.5),
        ...Array.from({ length: 59 }, (_, index) => point(index + 1, 0.1)),
      ],
      fx: FX,
      nowMs: NOW_MS,
    });
    assert.equal(relativeExtreme.state, 'ok');
    assert.equal(relativeExtreme.regime, 'extreme');
    assert.equal(relativeExtreme.percentile, 100);
    assert.equal(relativeExtreme.index, 90);
    assert.ok(relativeExtreme.index < 100);

    // Absolute stressed just under the extreme premium floor. Trailing values sit higher so
    // the relative ladder cannot escalate past absolute magnitude.
    const absoluteStressed = buildPhysicalDivergenceReading({
      metal: 'gold',
      current: current('gold', { premiumPct: 4.999, premiumUsdPerOz: 149.97 }),
      history: [
        point(0, 4.999),
        ...Array.from({ length: 59 }, (_, index) => point(index + 1, 12)),
      ],
      fx: FX,
      nowMs: NOW_MS,
    });
    assert.equal(absoluteStressed.state, 'ok');
    assert.equal(absoluteStressed.regime, 'stressed');
    assert.ok(absoluteStressed.index < relativeExtreme.index);
    assert.ok(absoluteStressed.index >= 70);
    assert.ok(absoluteStressed.index < 90);

    // Near-ceiling absolute stressed must stay strictly below the extreme floor after the
    // published two-decimal round (a full *20 span would round 4.9995+ up to 90).
    const nearCeilingStressed = buildPhysicalDivergenceReading({
      metal: 'gold',
      current: current('gold', { premiumPct: 4.9999, premiumUsdPerOz: 149.997 }),
      history: [
        point(0, 4.9999),
        ...Array.from({ length: 59 }, (_, index) => point(index + 1, 12)),
      ],
      fx: FX,
      nowMs: NOW_MS,
    });
    assert.equal(nearCeilingStressed.regime, 'stressed');
    assert.ok(nearCeilingStressed.index < 90);
    assert.ok(nearCeilingStressed.index < relativeExtreme.index);

    // Absolute extreme clears the metal floor and alone may publish 100.
    const absoluteExtreme = buildPhysicalDivergenceReading({
      metal: 'gold',
      current: current('gold', { premiumPct: 5, premiumUsdPerOz: 150 }),
      history: [
        point(0, 5),
        ...Array.from({ length: 59 }, (_, index) => point(index + 1, 12)),
      ],
      fx: FX,
      nowMs: NOW_MS,
    });
    assert.equal(absoluteExtreme.state, 'ok');
    assert.equal(absoluteExtreme.regime, 'extreme');
    assert.equal(absoluteExtreme.index, 100);

    // Silver mirrors the same compressed floors with its own absolute thresholds.
    const silverRelativeExtreme = buildPhysicalDivergenceReading({
      metal: 'silver',
      current: current('silver', { premiumPct: 2.5, premiumUsdPerOz: 0.75 }),
      history: [
        point(0, 2.5),
        ...Array.from({ length: 59 }, (_, index) => point(index + 1, 0.5)),
      ],
      fx: FX,
      nowMs: NOW_MS,
    });
    const silverNearCeilingStressed = buildPhysicalDivergenceReading({
      metal: 'silver',
      current: current('silver', { premiumPct: 19.999, premiumUsdPerOz: 6 }),
      history: [
        point(0, 19.999),
        ...Array.from({ length: 59 }, (_, index) => point(index + 1, 40)),
      ],
      fx: FX,
      nowMs: NOW_MS,
    });
    const silverAbsoluteExtreme = buildPhysicalDivergenceReading({
      metal: 'silver',
      current: current('silver', { premiumPct: 20, premiumUsdPerOz: 6 }),
      history: [
        point(0, 20),
        ...Array.from({ length: 59 }, (_, index) => point(index + 1, 40)),
      ],
      fx: FX,
      nowMs: NOW_MS,
    });
    assert.equal(silverRelativeExtreme.regime, 'extreme');
    assert.equal(silverRelativeExtreme.index, 90);
    assert.equal(silverNearCeilingStressed.regime, 'stressed');
    assert.ok(silverNearCeilingStressed.index < 90);
    assert.equal(silverAbsoluteExtreme.regime, 'extreme');
    assert.equal(silverAbsoluteExtreme.index, 100);

    // Relative stressed at the half-elevated gate with percentile exactly 95
    // (57 of 60 window values at or below the current premium).
    const relativeStressed = buildPhysicalDivergenceReading({
      metal: 'gold',
      current: current('gold', { premiumPct: 0.5, premiumUsdPerOz: 15 }),
      history: [
        point(0, 0.5),
        ...Array.from({ length: 56 }, (_, index) => point(index + 1, 0.1)),
        ...Array.from({ length: 3 }, (_, index) => point(index + 57, 0.6)),
      ],
      fx: FX,
      nowMs: NOW_MS,
    });
    assert.equal(relativeStressed.regime, 'stressed');
    assert.equal(relativeStressed.percentile, 95);
    assert.equal(relativeStressed.index, 70);

    // Absolute normal / elevated with higher trailing values so relative stays quiet.
    const absoluteNormal = buildPhysicalDivergenceReading({
      metal: 'gold',
      current: current('gold', { premiumPct: 0.4, premiumUsdPerOz: 12 }),
      history: [
        point(0, 0.4),
        ...Array.from({ length: 59 }, (_, index) => point(index + 1, 2)),
      ],
      fx: FX,
      nowMs: NOW_MS,
    });
    const absoluteElevated = buildPhysicalDivergenceReading({
      metal: 'gold',
      current: current('gold', { premiumPct: 2.5, premiumUsdPerOz: 75 }),
      history: [
        point(0, 2.5),
        ...Array.from({ length: 59 }, (_, index) => point(index + 1, 10)),
      ],
      fx: FX,
      nowMs: NOW_MS,
    });
    assert.equal(absoluteNormal.regime, 'normal');
    assert.equal(absoluteElevated.regime, 'elevated');
    assert.ok(absoluteNormal.index < 45);
    assert.ok(absoluteElevated.index >= 45);
    assert.ok(absoluteElevated.index < 70);

    const maxOf = (...readings) => Math.max(...readings.map((reading) => reading.index));
    const minOf = (...readings) => Math.min(...readings.map((reading) => reading.index));
    // Stressed must never strictly outscore extreme; lower bands stay at or below higher ones.
    assert.ok(maxOf(absoluteNormal) <= minOf(absoluteElevated));
    assert.ok(maxOf(absoluteElevated) <= minOf(absoluteStressed, relativeStressed, nearCeilingStressed));
    assert.ok(
      maxOf(absoluteStressed, relativeStressed, nearCeilingStressed, silverNearCeilingStressed)
        < minOf(relativeExtreme, absoluteExtreme, silverRelativeExtreme, silverAbsoluteExtreme),
    );
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

  it('fails closed when an SGE print is later than the Shanghai business date', () => {
    const reading = buildPhysicalDivergenceReading({
      metal: 'gold',
      current: current('gold', { physical: { asOf: '2026-10-11' } }),
      history: Array.from({ length: 60 }, (_, index) => point(index)),
      fx: FX,
      nowMs: NOW_MS,
    });

    assert.deepEqual(
      { state: reading.state, reason: reading.reason, index: reading.index },
      { state: 'missing_input', reason: 'physical_print_in_future', index: null },
    );
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

  it('fails closed when COMEX or FX clocks are in the future', () => {
    const history = Array.from({ length: 60 }, (_, index) => point(index));
    const futurePaper = buildPhysicalDivergenceReading({
      metal: 'gold',
      current: current('gold', { paper: { asOf: '2026-10-10T12:00:00.001Z' } }),
      history,
      fx: FX,
      nowMs: NOW_MS,
    });
    const futureFx = buildPhysicalDivergenceReading({
      metal: 'gold',
      current: current('gold'),
      history,
      fx: { ...FX, asOf: '2026-10-10T12:00:00.001Z' },
      nowMs: NOW_MS,
    });

    assert.deepEqual(
      [futurePaper.state, futurePaper.reason, futureFx.state, futureFx.reason],
      ['missing_input', 'paper_snapshot_in_future', 'missing_input', 'fx_snapshot_in_future'],
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

  it('prioritizes missing and stale members over an insufficient-history sibling', () => {
    const weightsOnly = (state, metal) => ({ metal, state, index: null });
    for (const readings of [
      [weightsOnly('insufficient_history', 'gold'), weightsOnly('stale_input', 'silver')],
      [weightsOnly('stale_input', 'gold'), weightsOnly('insufficient_history', 'silver')],
    ]) {
      assert.equal(buildPhysicalStressComposite(readings).state, 'stale_input');
    }
    assert.equal(buildPhysicalStressComposite([
      weightsOnly('stale_input', 'gold'),
      weightsOnly('missing_input', 'silver'),
    ]).state, 'missing_input');
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
    // The cooldown is keyed on the regime we last ANNOUNCED, not merely on elapsed time:
    // a flap back to a regime already announced inside the window is suppressed...
    const repeat = createPhysicalPremiumTransition({
      previous: base,
      next,
      nowMs: NOW_MS + DAY_MS,
      lastEmittedAtMs: NOW_MS,
      lastEmittedRegime: 'elevated',
    });
    // ...and a de-escalation inside the window is too.
    const deEscalationInWindow = createPhysicalPremiumTransition({
      previous: next,
      next: base,
      nowMs: NOW_MS + DAY_MS,
      lastEmittedAtMs: NOW_MS,
      lastEmittedRegime: 'elevated',
    });
    // But an ESCALATION beyond what we announced is never dropped, even mid-window. Without
    // this the second regime change is lost permanently rather than deferred: `previous` is
    // the last PUBLISHED snapshot, which advances even on a suppressed run, so once the
    // window clears the regimes match and the transition can never fire.
    const escalationInWindow = createPhysicalPremiumTransition({
      previous: next,
      next: { ...base, regime: 'stressed', index: 80 },
      nowMs: NOW_MS + DAY_MS,
      lastEmittedAtMs: NOW_MS,
      lastEmittedRegime: 'elevated',
    });
    // Positive control on the boundary itself: once the window has elapsed, a repeat of the
    // same transition emits again. A guard mutated to suppress whenever a cooldown record
    // exists would leave every other assertion here green.
    const afterCooldown = createPhysicalPremiumTransition({
      previous: base,
      next,
      nowMs: NOW_MS + TRANSITION_COOLDOWN_MS,
      lastEmittedAtMs: NOW_MS,
      lastEmittedRegime: 'elevated',
    });
    const justInsideCooldown = createPhysicalPremiumTransition({
      previous: base,
      next,
      nowMs: NOW_MS + TRANSITION_COOLDOWN_MS - 1,
      lastEmittedAtMs: NOW_MS,
      lastEmittedRegime: 'elevated',
    });
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
    assert.equal(deEscalationInWindow, null);
    assert.equal(justInsideCooldown, null);
    assert.equal(unchangedNormal, null);
    assert.equal(unchangedElevated, null);
    assert.equal(dead, null);
    assert.deepEqual(
      escalationInWindow && { from: escalationInWindow.fromRegime, to: escalationInWindow.toRegime },
      { from: 'elevated', to: 'stressed' },
    );
    assert.deepEqual(
      afterCooldown && { from: afterCooldown.fromRegime, to: afterCooldown.toRegime },
      { from: 'normal', to: 'elevated' },
    );
  });

});
