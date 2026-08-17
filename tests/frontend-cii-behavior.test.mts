import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { transitionCiiAvailability } from '../src/services/cii-availability.ts';
import { detectCiiScoreChanges } from '../src/services/cii-score-changes.ts';

const cachedA = { cii: [{ code: 'IR', score: 40 }] } as never;
const cachedB = { cii: [{ code: 'IR', score: 52 }] } as never;

describe('frontend CII behavior', () => {
  it('renders CII availability once per state transition', () => {
    let applied: typeof cachedA | null | undefined;

    let transition = transitionCiiAvailability(applied, null);
    assert.equal(transition.render, 'unavailable');
    assert.equal(transition.refreshBrief, true);
    applied = transition.nextState;

    transition = transitionCiiAvailability(applied, null);
    assert.equal(transition.render, null);
    assert.equal(transition.refreshBrief, false);

    transition = transitionCiiAvailability(applied, cachedA);
    assert.equal(transition.render, 'cached');
    assert.equal(transition.refreshBrief, true);
    applied = transition.nextState;

    transition = transitionCiiAvailability(applied, cachedA);
    assert.equal(transition.render, null);
    assert.equal(transition.refreshBrief, true);

    transition = transitionCiiAvailability(applied, cachedB);
    assert.equal(transition.render, 'cached');
  });

  it('uses the first canonical snapshot as an alert baseline', () => {
    const initial = [{ code: 'IR', score: 40 }] as never;
    const first = detectCiiScoreChanges(initial, new Map(), false);
    assert.deepEqual(first.changes, []);

    const second = detectCiiScoreChanges(
      [{ code: 'IR', score: 51 }] as never,
      first.nextScores,
      false,
    );
    assert.deepEqual(second.changes.map((change) => ({
      code: change.score.code,
      previousScore: change.previousScore,
    })), [{ code: 'IR', previousScore: 40 }]);
  });

  it('updates the alert baseline without notifying during learning mode', () => {
    const result = detectCiiScoreChanges(
      [{ code: 'IR', score: 55 }] as never,
      new Map([['IR', 40]]),
      true,
    );

    assert.deepEqual(result.changes, []);
    assert.equal(result.nextScores.get('IR'), 55);
  });
});
