import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

import { normalizePhysicalDivergenceSnapshot } from '../server/_shared/physical-divergence-snapshot.ts';
import {
  PHYSICAL_DIVERGENCE_CONTRACT,
  buildPhysicalStressComposite,
  isPhysicalDivergenceStoredCompositeReason,
  isPhysicalDivergenceStoredReadingReason,
  physicalDivergenceStateForFreshnessReason,
} from '../shared/physical-divergence-contract.js';
import { buildProducerBackedPhysicalComparisonFixture } from './helpers/mcp-producer-fixtures.mjs';

const STATES = ['ok', 'insufficient_history', 'stale_input', 'missing_input'] as const;
const proto = readFileSync(
  new URL('../proto/worldmonitor/market/v1/get_physical_divergence_index.proto', import.meta.url),
  'utf8',
);

function reasonPattern(messageName: string): string {
  const message = new RegExp(`message ${messageName} \\{([\\s\\S]*?)\\n\\}`).exec(proto)?.[1];
  assert.ok(message, `${messageName} must exist in the proto`);
  const pattern = /string reason = \d+ \[\(buf\.validate\.field\)\.string\.pattern = "([^"]+)"\];/.exec(message)?.[1];
  assert.ok(pattern, `${messageName}.reason must have a string pattern`);
  return pattern;
}

describe('physical divergence shared contract', () => {
  it('owns the canonical domain facts', () => {
    assert.equal(PHYSICAL_DIVERGENCE_CONTRACT.methodologyVersion, 'physical-divergence-v2');
    assert.deepEqual(PHYSICAL_DIVERGENCE_CONTRACT.metalOrder, ['gold', 'silver']);
    assert.deepEqual(PHYSICAL_DIVERGENCE_CONTRACT.states, STATES);
    assert.deepEqual(PHYSICAL_DIVERGENCE_CONTRACT.nonOkStatePriority, [
      'missing_input',
      'stale_input',
      'insufficient_history',
    ]);
    assert.deepEqual(PHYSICAL_DIVERGENCE_CONTRACT.regimes, ['normal', 'elevated', 'stressed', 'extreme']);
    assert.deepEqual(PHYSICAL_DIVERGENCE_CONTRACT.trends, ['widening', 'stable', 'narrowing']);
    assert.deepEqual(PHYSICAL_DIVERGENCE_CONTRACT.history, {
      retainedPoints: 750,
      windowPoints: 250,
      minimumPoints: 60,
    });
    assert.deepEqual(PHYSICAL_DIVERGENCE_CONTRACT.metals, {
      gold: {
        physicalSymbol: 'SHAU',
        physicalUnit: 'gram',
        paperSymbol: 'GC=F',
        weight: 0.7,
        absoluteFloors: { elevated: 1, stressed: 3, extreme: 5 },
        historyKey: 'market:physical-premium-history:v1:gold',
      },
      silver: {
        physicalSymbol: 'SHAG',
        physicalUnit: 'kilogram',
        paperSymbol: 'SI=F',
        weight: 0.3,
        absoluteFloors: { elevated: 5, stressed: 10, extreme: 20 },
        historyKey: 'market:physical-premium-history:v1:silver',
      },
    });
  });

  it('keeps proto reason patterns equal to the closed shared vocabularies', () => {
    assert.equal(reasonPattern('PhysicalDivergenceReading'), PHYSICAL_DIVERGENCE_CONTRACT.readingReasonPattern);
    assert.equal(reasonPattern('PhysicalStressComposite'), PHYSICAL_DIVERGENCE_CONTRACT.compositeReasonPattern);
    for (const reason of PHYSICAL_DIVERGENCE_CONTRACT.readingReasonValues) {
      assert.match(reason, new RegExp(PHYSICAL_DIVERGENCE_CONTRACT.readingReasonPattern));
    }
    for (const reason of PHYSICAL_DIVERGENCE_CONTRACT.compositeReasonValues) {
      assert.match(reason, new RegExp(PHYSICAL_DIVERGENCE_CONTRACT.compositeReasonPattern));
    }
  });

  it('maps every freshness reason to its explicit state', () => {
    for (const reason of PHYSICAL_DIVERGENCE_CONTRACT.freshness.missingReasons) {
      assert.equal(physicalDivergenceStateForFreshnessReason(reason), 'missing_input');
    }
    for (const reason of PHYSICAL_DIVERGENCE_CONTRACT.freshness.staleReasons) {
      assert.equal(physicalDivergenceStateForFreshnessReason(reason), 'stale_input');
    }
    assert.throws(
      () => physicalDivergenceStateForFreshnessReason('unregistered_freshness_reason'),
      /Unknown physical divergence freshness reason/,
    );
  });

  it('validates stored reading and composite reasons against their states', () => {
    assert.equal(isPhysicalDivergenceStoredReadingReason('ok', ''), true);
    assert.equal(isPhysicalDivergenceStoredReadingReason('insufficient_history', 'history_points_below_60'), true);
    assert.equal(isPhysicalDivergenceStoredReadingReason('stale_input', 'physical_print_older_than_12_calendar_days'), true);
    assert.equal(isPhysicalDivergenceStoredReadingReason('missing_input', 'current_premium_missing'), true);
    assert.equal(isPhysicalDivergenceStoredReadingReason('missing_input', 'divergence_snapshot_unavailable'), false);
    assert.equal(isPhysicalDivergenceStoredReadingReason('stale_input', 'paper_snapshot_in_future'), false);
    assert.equal(isPhysicalDivergenceStoredCompositeReason('ok', ''), true);
    assert.equal(isPhysicalDivergenceStoredCompositeReason('missing_input', 'member_not_ok:gold:missing_input'), true);
    assert.equal(isPhysicalDivergenceStoredCompositeReason('missing_input', 'divergence_snapshot_unavailable'), false);
  });

  it('builds composites with canonical priority, order, weights, and rounding', () => {
    assert.deepEqual(buildPhysicalStressComposite([
      { metal: 'silver', state: 'ok', index: 33.33 },
      { metal: 'gold', state: 'ok', index: 66.66 },
    ]), {
      state: 'ok',
      reason: '',
      index: 56.66,
      weights: [
        { metal: 'gold', weight: 0.7, methodologyVersion: 'physical-divergence-v2' },
        { metal: 'silver', weight: 0.3, methodologyVersion: 'physical-divergence-v2' },
      ],
      methodologyVersion: 'physical-divergence-v2',
    });
    assert.equal(buildPhysicalStressComposite([
      { metal: 'gold', state: 'stale_input', index: null },
      { metal: 'silver', state: 'missing_input', index: null },
    ]).reason, 'member_not_ok:silver:missing_input');
    assert.equal(buildPhysicalStressComposite([
      { metal: 'silver', state: 'stale_input', index: null },
    ]).reason, 'member_not_ok:gold:missing_input');
    assert.throws(
      () => buildPhysicalStressComposite([
        { metal: 'gold', state: 'ok', index: 1 },
        { metal: 'gold', state: 'ok', index: 2 },
      ]),
      /repeats a metal/,
    );
    assert.throws(
      () => buildPhysicalStressComposite([
        { metal: 'gold', state: 'future_state', index: null },
        { metal: 'silver', state: 'ok', index: 1 },
      ]),
      /Unknown physical divergence state/,
    );
  });
});

describe('physical divergence producer and consumer parity', () => {
  for (const state of STATES) {
    it(`derives the producer composite for ${state} readings`, () => {
      const { divergence } = buildProducerBackedPhysicalComparisonFixture(state);
      const normalized = normalizePhysicalDivergenceSnapshot(
        divergence,
        Date.parse(divergence.evaluatedAt),
      );

      assert.deepEqual(normalized.composite, divergence.composite);
    });
  }
});
