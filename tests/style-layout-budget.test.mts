/**
 * The #4536 styleLayout gate.
 *
 * The gate this replaces was worse than absent: `tests/measure-*-mainthread`
 * run in CI but assert fixture parsing only, so a green check read as perf
 * coverage while measuring nothing. A replacement therefore has to be tested
 * for the ways an alarm goes green while dead — and the first revision of THIS
 * gate failed that on review:
 *
 *  - its "styleLayout category absent" guard was dead code, because
 *    `categorize()` in the harness SEEDS all six categories at 0, so the real
 *    producer always emits a `styleLayout` entry. A fixture that omitted the
 *    category exercised a branch production can never reach — an inert fixture.
 *  - the real failure shape is `styleLayout: 0%` alongside positive
 *    `mainThreadMs` (error page, redirect, unhydrated shell), which the checker
 *    accepted as a comfortable pass.
 *  - `unmeasured` exited 0, so a scheduled alarm stayed green with no capture.
 *
 * Every fixture below therefore uses the REAL producer shape: all six seeded
 * categories plus `url`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_MAX_STYLE_LAYOUT_PCT,
  evaluateStyleLayoutBudget,
  MIN_PLAUSIBLE_MAIN_THREAD_MS,
  MIN_PLAUSIBLE_STYLE_LAYOUT_PCT,
} from '../scripts/check-style-layout-budget.mjs';

const DASHBOARD_URL = 'https://www.worldmonitor.app/dashboard';

/**
 * Mirrors `buildDecomposition` output: every category present, always — which
 * is exactly why "category absent" cannot be the only zero-attribution guard.
 */
function report(styleLayoutPct: number, overrides: Record<string, unknown> = {}) {
  const rest = Math.max(0, 100 - styleLayoutPct);
  return {
    url: DASHBOARD_URL,
    cpu: 1,
    mainThreadMs: 10800,
    categories: [
      { category: 'other', ms: 5270, pct: Number((rest * 0.55).toFixed(1)) },
      { category: 'styleLayout', ms: 2380, pct: styleLayoutPct },
      { category: 'scripting', ms: 1910, pct: Number((rest * 0.35).toFixed(1)) },
      { category: 'paintComposite', ms: 1160, pct: Number((rest * 0.1).toFixed(1)) },
      { category: 'parseHTML', ms: 50, pct: 0.5 },
      { category: 'garbageCollection', ms: 5, pct: 0 },
    ],
    other: [],
    ...overrides,
  };
}

test('the committed baseline passes the budget', () => {
  const verdict = evaluateStyleLayoutBudget(report(22.1));
  assert.equal(verdict.status, 'pass');
  assert.equal(verdict.pct, 22.1);
});

test('the worst committed capture still passes', () => {
  assert.equal(evaluateStyleLayoutBudget(report(23.3)).status, 'pass');
});

test('a real regression fails', () => {
  const over = DEFAULT_MAX_STYLE_LAYOUT_PCT + 6;
  assert.ok(over > DEFAULT_MAX_STYLE_LAYOUT_PCT, 'fixture must exceed the budget');
  const verdict = evaluateStyleLayoutBudget(report(over));
  assert.equal(verdict.status, 'regressed');
  assert.match(verdict.reason, /over the \d+% budget/);
});

test('exactly at the budget passes; a hair over fails', () => {
  assert.equal(evaluateStyleLayoutBudget(report(DEFAULT_MAX_STYLE_LAYOUT_PCT)).status, 'pass');
  assert.equal(
    evaluateStyleLayoutBudget(report(DEFAULT_MAX_STYLE_LAYOUT_PCT + 0.1)).status,
    'regressed',
  );
});

// ---- green-while-dead: the shapes the REAL producer can emit ----

test('0% styleLayout in a fully-populated report is unmeasured, NOT a pass', () => {
  // The production failure shape: every category seeded, real mainThreadMs, but
  // nothing rendered. Reading 0% as "well under budget" is how the alarm dies.
  const verdict = evaluateStyleLayoutBudget(report(0));
  assert.equal(verdict.status, 'unmeasured');
  assert.match(verdict.reason, /implausible/);
});

test('a share just under the plausibility floor is unmeasured', () => {
  const verdict = evaluateStyleLayoutBudget(report(MIN_PLAUSIBLE_STYLE_LAYOUT_PCT - 0.1));
  assert.equal(verdict.status, 'unmeasured');
});

test('a share just at the plausibility floor is measured, not discarded', () => {
  assert.equal(evaluateStyleLayoutBudget(report(MIN_PLAUSIBLE_STYLE_LAYOUT_PCT)).status, 'pass');
});

test('a trivially small capture is unmeasured even at a healthy share', () => {
  const verdict = evaluateStyleLayoutBudget(
    report(22.1, { mainThreadMs: MIN_PLAUSIBLE_MAIN_THREAD_MS - 1 }),
  );
  assert.equal(verdict.status, 'unmeasured');
  assert.match(verdict.reason, /never really ran/);
});

test("the harness's own refusal-to-attribute warning is unmeasured", () => {
  const verdict = evaluateStyleLayoutBudget(
    report(22.1, { warning: 'no CrRendererMain thread found in trace; not attributing' }),
  );
  assert.equal(verdict.status, 'unmeasured');
  assert.match(verdict.reason, /declined to attribute/);
});

test('a capture of the wrong page is unmeasured', () => {
  // A redirect, auth wall, or error page produces a perfectly numeric trace.
  const verdict = evaluateStyleLayoutBudget(
    report(22.1, { url: 'https://www.worldmonitor.app/login' }),
    { expectedUrlSuffix: '/dashboard' },
  );
  assert.equal(verdict.status, 'unmeasured');
  assert.match(verdict.reason, /expected a URL ending/);
});

test('the expected page passes the URL contract, including query and trailing slash', () => {
  for (const url of [
    DASHBOARD_URL,
    `${DASHBOARD_URL}/`,
    `${DASHBOARD_URL}?variant=full`,
    `${DASHBOARD_URL}#panels`,
  ]) {
    const verdict = evaluateStyleLayoutBudget(report(22.1, { url }), {
      expectedUrlSuffix: '/dashboard',
    });
    assert.equal(verdict.status, 'pass', `expected ${url} to satisfy the URL contract`);
  }
});

test('a missing url is unmeasured when a URL is required', () => {
  const verdict = evaluateStyleLayoutBudget(report(22.1, { url: undefined }), {
    expectedUrlSuffix: '/dashboard',
  });
  assert.equal(verdict.status, 'unmeasured');
});

test('an empty decomposition is unmeasured', () => {
  const verdict = evaluateStyleLayoutBudget({
    url: DASHBOARD_URL,
    mainThreadMs: 0,
    categories: [],
    other: [],
  });
  assert.equal(verdict.status, 'unmeasured');
  assert.equal(verdict.pct, null);
});

test('a decomposition missing styleLayout is unmeasured', () => {
  const base = report(22.1);
  base.categories = base.categories.filter((c) => c.category !== 'styleLayout');
  const verdict = evaluateStyleLayoutBudget(base);
  assert.equal(verdict.status, 'unmeasured');
  assert.match(verdict.reason, /no 'styleLayout' category/);
});

test('garbage input is unmeasured rather than throwing or passing', () => {
  for (const bad of [null, undefined, 42, 'nope', [], {}]) {
    assert.equal(
      evaluateStyleLayoutBudget(bad).status,
      'unmeasured',
      `expected unmeasured for ${JSON.stringify(bad)}`,
    );
  }
});

test('a non-numeric pct is unmeasured rather than coerced', () => {
  assert.equal(evaluateStyleLayoutBudget(report(Number.NaN)).status, 'unmeasured');
});

test('an explicit maxPct overrides the default', () => {
  assert.equal(evaluateStyleLayoutBudget(report(22.1), { maxPct: 20 }).status, 'regressed');
  assert.equal(evaluateStyleLayoutBudget(report(22.1), { maxPct: 40 }).status, 'pass');
});

test('the default budget sits above the committed baseline range', () => {
  assert.ok(
    DEFAULT_MAX_STYLE_LAYOUT_PCT > 23.3,
    'budget must exceed the worst committed capture (23.3% at cpu 4)',
  );
});

test('the plausibility floor sits well below the committed baseline range', () => {
  // If the floor ever crept up to the measured range it would reject healthy
  // captures as unmeasured — a permanently red gate rather than a signal.
  assert.ok(
    MIN_PLAUSIBLE_STYLE_LAYOUT_PCT < 19,
    'floor must stay below the lowest committed capture (~19%)',
  );
});
