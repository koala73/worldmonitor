import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  axeTargetFingerprint,
  compareAxeViolationBaseline,
  type AxeViolationLike,
} from '../e2e/axe-violation-baseline.ts';

function violation(id: string, ...targets: unknown[]): AxeViolationLike {
  return { id, nodes: targets.map((target) => ({ target })) };
}

describe('axe violation target baseline', () => {
  it('accepts the exact known rule-and-target set', () => {
    const target = ['#known'];
    assert.deepEqual(
      compareAxeViolationBaseline(
        [violation('color-contrast', target)],
        { 'color-contrast': [axeTargetFingerprint(target)] },
      ),
      {
        unexpectedRuleIds: [],
        expandedTargets: [],
        staleTargets: [],
        invalidBaselineRuleIds: [],
      },
    );
  });

  it('rejects another node even when its rule is already known', () => {
    const known = ['#known'];
    const added = ['#added'];
    const result = compareAxeViolationBaseline(
      [violation('color-contrast', known, added)],
      { 'color-contrast': [axeTargetFingerprint(known)] },
    );

    assert.deepEqual(result.expandedTargets, [
      `color-contrast: ${axeTargetFingerprint(added)}`,
    ]);
  });

  it('reports stale targets and new rule IDs independently', () => {
    const stale = ['#removed'];
    const result = compareAxeViolationBaseline(
      [violation('label', ['#new-rule'])],
      { 'color-contrast': [axeTargetFingerprint(stale)] },
    );

    assert.deepEqual(result.unexpectedRuleIds, ['label']);
    assert.deepEqual(result.staleTargets, [
      `color-contrast: ${axeTargetFingerprint(stale)}`,
    ]);
  });

  it('rejects empty baseline entries that would allow a whole rule', () => {
    const result = compareAxeViolationBaseline([], { 'color-contrast': [] });
    assert.deepEqual(result.invalidBaselineRuleIds, ['color-contrast']);
  });
});
