---
title: "A flake fix was traded away in a later PR, and the flake came back"
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

# A flake fix was traded away in a later PR, and the flake came back

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
2. Four days later, PR #8019 (an aviation fix that squashed in several china-policy test commits) changed the control twice. First, under 16-way CI load the **median itself** fell to 11.8x, so the control got an 11x floor. Then a commit titled "make quadratic control exercise the real scaling guard" rewrote the block to time fixed batches and pointed the control back at `rejectsScaling` (ratio-of-mins). That was a deliberate trade: the control again proved the guard's own predicate can fail, at the cost of the flake the median had fixed. The squashed PR title named neither change, so the history read as unrelated.

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
- **The control must fail on a real quadratic.** The minimum of the quadrupled series is the fastest quadrupled sample observed. One unusually fast quadrupled sample against a typical base drops min/min below 12x even though every other attempt scaled ~14x. The median attempt ignores that one sample.

The synthetic-sample test fails if the control goes back to ratio-of-mins, without depending on the runner, so that particular trade can no longer happen without a red test. It does not reject every aggregation: a mean-ratio control also passes these samples (~13.5x lucky, ~6.5x linear).

### Limits of this fix

- **It pins the aggregation choice. It does not prove the timing test cannot flake.** The median fell to 11.8x once under 16-way load. The CI shards now run `test:data` at concurrency 4, but a median control with ~14x typical headroom over a 12x gate can still fail on a slow runner.
- **The median control proves a different predicate trips than the one the guard uses.** The guard fails on ratio-of-mins; the control now passes on the median. That is the trade #8019 reversed. A stronger control would give the quadratic more headroom (a larger base input makes the quadratic term dominate, pushing it toward 16x) so the guard's own predicate trips reliably, at the cost of a slower test.

## Prevention

- **Before fixing a flake, search the test's history** for an earlier fix, and read the full squashed commit message, not just the PR title: `git log -S'<helper or constant>' -- <test file>`, or `git log --format='%h %ad %s' -- <test file>` and read the subjects. A flake that "looks new" may be an old fix that a rewrite removed.
- **Pin the decision a flake fix makes with a deterministic test.** If the fix is "use the median here", test that function on fixed samples that pass under the median and fail under the old aggregator. A timing test alone will not catch the change being reverted.
- **When a change trades one property of a test for another, say so where the next reader will look.** #8019 deliberately gave up the median for a control that exercises the guard's own predicate, and deleted the comment explaining the median. The trade lived only in a squashed commit body. Keep the comment, rewritten to state the new trade.
- A positive control with little headroom over its gate (here ~14x against 12x) fails first. If a control fails near the gate, check the aggregation before touching the threshold.

## Related Issues

- PR #9639: restores the median control and adds the deterministic test.
- PR #8019: lowered the control to an 11x floor after an 11.8x median failure, then moved it back onto the guard's ratio-of-mins.
- PR #9633: where the regression surfaced (`unit-shard (1)`).
- [CI runners are CPU-bound](../performance-issues/ci-runners-are-cpu-bound-shard-before-parallel-steps.md): the shard work that was running when it surfaced.
