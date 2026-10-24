---
title: "A flake fix was undone by an unrelated rewrite of the same test block"
date: 2026-10-24
category: test-failures
module: china-policy-events-tests
problem_type: test_failure
component: testing_framework
severity: medium
symptoms:
  - "unit-shard fails on 'keeps its teeth: a genuinely quadratic scan still trips the gate' with a ratio just under the 12x ceiling (11.4x min/min on PR #9633)"
  - "The same test had failed the same way before (11.9x on CI) and had been fixed"
  - "The failure is CI-only: locally the control measures 14-16x, alone or under heavy load"
root_cause: logic_error
resolution_type: test_fix
related_components: [development_workflow]
tags: [flaky-test, regression, positive-control, timing-test, ratio-of-mins, median, git-log-s, china-policy]
---

# A flake fix was undone by an unrelated rewrite of the same test block

## Problem

`tests/china-policy-events.test.mts` checks that the china-policy HTML parser scales linearly. It times the parser at two input sizes 4x apart and fails if CPU time grows more than 12x. A positive control (`keeps its teeth`) runs a deliberately quadratic scan through the same measurement and must trip the gate. Otherwise the guard could no longer fail.

The control failed `unit-shard (1)` on PR #9633 at 11.4x, with the real quadratic behaving normally everywhere else.

## Symptoms

- `the quadratic control must trip the gate, but scaled only 11.4x min/min ... (16.5ms → 188.1ms, -12.0ms against the ceiling)`.
- Locally the control measured 14.1-14.8x alone (12 runs), and 13.9-15.8x with 24 copies running at once on an 18-core machine. It never failed.

## What Didn't Work

- **Treating it as a new flake.** The first instinct was to tune the measurement: more samples, a larger input, a lower ceiling. Any of these would have been a second fix for a problem that had already been solved once.
- **Reproducing it by load.** Running many copies at once locally did not push the ratio down, so a timing-based reproduction gave no signal. The failure depends on the CI runner, not on how busy the machine is.

## Solution

`git log -S'medianOf' -- tests/china-policy-events.test.mts` found the history:

1. A September fix (PR-less commit "stabilize quadratic gate timing") had already solved this exact flake, after an 11.9x failure. The guard kept ratio-of-mins, so one stalled sample could not falsely trip it. The positive control switched to the **median per-attempt ratio**, because ratio-of-mins squeezes a genuine quadratic down whenever one quadrupled sample comes out fast.
2. Four days later, PR #8019, an aviation fix, rewrote the measurement block to time fixed batches. That rewrite removed `medianOf` and pointed the control back at `rejectsScaling` (ratio-of-mins). Nothing failed at the time, because the flake needs an unlucky sample.

PR #9639 restored the median and made the aggregation testable without timing:

```ts
// tests/china-policy-events.test.mts
const controlTripsGate = ({ medianRatio }: { medianRatio: number }): boolean =>
  medianRatio > SCALING_CEILING_RATIO;
const summarizeAttempts = (attempts: Array<[baseMs: number, quadrupledMs: number]>) => {
  // min/min ratio and margin for the guard, median attempt ratio for the control
};
```

The guard still calls `rejectsScaling` (ratio-of-mins). The control calls `controlTripsGate` (median). Both read from one `summarizeAttempts()`, and the diagnostic prints both ratios.

A deterministic test feeds that function a sample set shaped like the CI failure:

```ts
it('judges the positive control on the median attempt, not ratio-of-mins', () => {
  const lucky = summarizeAttempts([
    [16.5, 188.1], [17.0, 240.0], [17.2, 238.0], [17.1, 242.0], [16.9, 236.0],
  ]);
  assert.equal(rejectsScaling(lucky), false, 'min/min alone compresses this quadratic under the gate');
  assert.equal(controlTripsGate(lucky), true);
  // A linear scan with GC noise must not trip it.
  assert.equal(controlTripsGate(summarizeAttempts([
    [10, 41], [10, 98], [10, 44], [10, 101], [10, 40],
  ])), false);
});
```

It was red before the fix. A mutation pointing `controlTripsGate` back at ratio-of-mins fails it.

## Why This Works

The two checks need opposite aggregators:

- **The guard must not fail on noise.** The minimum of each series removes stalls, so ratio-of-mins is right for it.
- **The control must fail on a real quadratic.** The minimum of the quadrupled series is exactly the sample a stall did not slow down, and sometimes it is a sample that ran unusually fast. One fast quadrupled sample against a typical base drops min/min below 12x even though every attempt scaled ~14x. The median attempt ignores that one sample.

The earlier fix was right. It failed only because nothing tied it down: it was a choice inside a timing test, and a timing test can't show that a choice was wrong. The synthetic-sample test fails on any rewrite that changes the aggregation, without depending on the runner.

## Prevention

- **Before fixing a flake, search the test's history** for an earlier fix: `git log -S'<helper or constant>' -- <test file>`, or `git log --format='%h %ad %s' -- <test file>` and read the subjects. A flake that "looks new" may be an old fix that a rewrite removed.
- **Pin the decision a flake fix makes with a deterministic test.** If the fix is "use the median here", test that function on fixed samples that pass under the median and fail under the old aggregator. A timing test alone will not catch the change being reverted.
- **When rewriting a measurement block in someone else's test, keep its stated invariants.** The September comment explained why the control used the median. That comment was deleted with the code. Read the comments you delete.
- A positive control with little headroom over its gate (here ~14x against 12x) fails first. If a control fails near the gate, check the aggregation before touching the threshold.

## Related Issues

- PR #9639: restores the median control and adds the deterministic test.
- PR #8019: the rewrite that removed the earlier fix.
- PR #9633: where the regression surfaced (`unit-shard (1)`).
- [CI runners are CPU-bound](../performance-issues/ci-runners-are-cpu-bound-shard-before-parallel-steps.md): the shard work that was running when it surfaced.
