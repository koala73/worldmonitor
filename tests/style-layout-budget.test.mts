/**
 * The #4536 styleLayout gate.
 *
 * The gate this replaces was worse than absent: `tests/measure-*-mainthread`
 * run in CI but assert fixture parsing only, so a green check read as perf
 * coverage while measuring nothing. A replacement therefore has to be tested
 * for the ways an alarm goes green while dead, not just for the happy path:
 *
 *  - a report that measured NOTHING must not read as 0% styleLayout = healthy
 *  - the over-budget fixture must actually be over budget (an inert fixture
 *    would make the fail-closed case vacuous)
 *  - the threshold must come from the committed baseline, not from the fixture
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_MAX_STYLE_LAYOUT_PCT,
  evaluateStyleLayoutBudget,
} from '../scripts/check-style-layout-budget.mjs';

/** Shaped like real `buildDecomposition` output. */
function report(styleLayoutPct: number | null, overrides: Record<string, unknown> = {}) {
  const categories: Array<Record<string, unknown>> = [
    { category: 'other', ms: 5270, pct: 48.9 },
    { category: 'scripting', ms: 1910, pct: 17.7 },
    { category: 'paintComposite', ms: 1160, pct: 10.8 },
  ];
  if (styleLayoutPct !== null) {
    categories.splice(1, 0, { category: 'styleLayout', ms: 2380, pct: styleLayoutPct });
  }
  return { mainThreadMs: 10800, categories, other: [], ...overrides };
}

test('the committed baseline passes the budget', () => {
  // 22.1% is the measured 2026-07-02 cpu-1 capture.
  const verdict = evaluateStyleLayoutBudget(report(22.1));
  assert.equal(verdict.status, 'pass');
  assert.equal(verdict.pct, 22.1);
});

test('the worst committed capture still passes', () => {
  // 23.3% is the cpu-4 capture — host variance must not trip the gate.
  assert.equal(evaluateStyleLayoutBudget(report(23.3)).status, 'pass');
});

test('a real regression fails', () => {
  // Deliberately above DEFAULT_MAX_STYLE_LAYOUT_PCT so the fail-closed branch is
  // genuinely exercised rather than asserted against an inert fixture.
  const over = DEFAULT_MAX_STYLE_LAYOUT_PCT + 6;
  assert.ok(over > DEFAULT_MAX_STYLE_LAYOUT_PCT, 'fixture must exceed the budget');
  const verdict = evaluateStyleLayoutBudget(report(over));
  assert.equal(verdict.status, 'regressed');
  assert.match(verdict.reason, /over the \d+% budget/);
});

test('exactly at the budget passes; a hair over fails', () => {
  assert.equal(evaluateStyleLayoutBudget(report(DEFAULT_MAX_STYLE_LAYOUT_PCT)).status, 'pass');
  assert.equal(evaluateStyleLayoutBudget(report(DEFAULT_MAX_STYLE_LAYOUT_PCT + 0.1)).status, 'regressed');
});

test('an empty decomposition is unmeasured, NOT a pass', () => {
  const verdict = evaluateStyleLayoutBudget({ mainThreadMs: 0, categories: [], other: [] });
  assert.equal(verdict.status, 'unmeasured');
  assert.equal(verdict.pct, null);
});

test('a decomposition missing styleLayout is unmeasured, NOT 0% healthy', () => {
  // The dangerous case: categories present, styleLayout absent. Reading the
  // missing category as 0% would report a broken capture as perfect.
  const verdict = evaluateStyleLayoutBudget(report(null));
  assert.equal(verdict.status, 'unmeasured');
  assert.match(verdict.reason, /no 'styleLayout' category/);
});

test('a zero mainThreadMs is unmeasured even when categories look populated', () => {
  const verdict = evaluateStyleLayoutBudget(report(22.1, { mainThreadMs: 0 }));
  assert.equal(verdict.status, 'unmeasured');
});

test('garbage input is unmeasured rather than throwing or passing', () => {
  for (const bad of [null, undefined, 42, 'nope', [], {}]) {
    const verdict = evaluateStyleLayoutBudget(bad);
    assert.equal(verdict.status, 'unmeasured', `expected unmeasured for ${JSON.stringify(bad)}`);
  }
});

test('a non-numeric pct is unmeasured rather than coerced', () => {
  const verdict = evaluateStyleLayoutBudget(report(Number.NaN));
  assert.equal(verdict.status, 'unmeasured');
});

test('an explicit maxPct overrides the default', () => {
  assert.equal(evaluateStyleLayoutBudget(report(22.1), { maxPct: 20 }).status, 'regressed');
  assert.equal(evaluateStyleLayoutBudget(report(22.1), { maxPct: 40 }).status, 'pass');
});

test('the default budget sits above the committed baseline range', () => {
  // Guards the threshold itself: if someone tightens it below what the baseline
  // actually measured, the gate becomes a permanent red rather than a signal.
  assert.ok(
    DEFAULT_MAX_STYLE_LAYOUT_PCT > 23.3,
    'budget must exceed the worst committed capture (23.3% at cpu 4)',
  );
});
