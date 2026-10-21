---
title: A health metric must report zero when it has no basis, never a flattering number
date: 2026-08-28
category: best-practices
module: scripts/_forecast-scorecard
problem_type: best_practice
component: background_job
severity: high
applies_when:
  - "Adding a rate or ratio that will be read as evidence a system is healthy"
  - "A denominator can include outcomes that are not the success the metric claims to measure"
  - "Instrumentation is added to a system with existing records that predate it"
  - "An acceptance criterion is phrased as 'X must improve without a compensating increase in Y'"
tags:
  - observability
  - metrics-design
  - acceptance-criteria
  - goodharts-law
  - instrumentation-migration
  - forecast
---

# A health metric must report zero when it has no basis, never a flattering number

## Context

While adding judged-lane observability for #7068, two metrics shipped that would each have reported an excellent number under exactly the conditions they were meant to detect. Both were caught in review of PR #7254, and both are the same mistake in different clothing: **the metric reported a number when it had no basis for one, and the number it invented was flattering.**

The issue's own acceptance criteria had warned about this in plain language — *"A renamed/early VOID cannot satisfy acceptance; total scored-within-SLA must improve without a compensating failure-state increase"* — and the implementation still walked into it.

**Metric 1 — the denominator included non-successes.** `resolvedWithinSlaRate` counted every judged entry that reached *any* terminal state inside the SLA window. VOID is a terminal state. So a lane that sealed every entry as an instant VOID — the fastest possible way to resolve nothing — reported a **perfect SLA rate of 1.0**. Voiding is the cheapest path to a green number.

**Metric 2 — the denominator mixed two accounting regimes.** `firstAttemptSealRate` and `attemptsPerResolvedEntry` read `judgeAttempts`. Before this instrumentation, that counter incremented only on *failed* attempts — the sealing attempt was never recorded. So a legacy entry that failed once and then sealed carries `judgeAttempts === 1` and was scored as a **first-attempt seal**, undercounting by one across the entire 180-day rolling window. Every pre-instrumentation entry silently improved the score.

## Guidance

**1. The denominator must be the population, the numerator only the outcome you claim.** If the metric is named "within SLA," decide whether it means *resolved* within SLA or *successfully resolved* within SLA — they are different metrics and only one is a health signal. Keep failures in the denominator so they depress the rate:

```js
// Failures stay in the denominator; only successes reach the numerator.
scoredWithinSlaRate: judgedResolved.length
  ? round(scoredWithinSla / judgedResolved.length)
  : 0,
```

**2. Publish the compensating term next to the rate.** When an acceptance criterion says "X must improve without a compensating increase in Y," Y belongs in the output beside X. A reader should not have to cross-reference two blocks to see the trade:

```js
scoredWithinSla,
voidWithinSla,   // the compensating failure-state increase, in the same view
```

**3. Publish the denominator whenever it can be zero or partial.** `firstAttemptSealRate: 0` is ambiguous — it could mean "nothing ever seals first try" or "nothing measurable yet." Naming the denominator resolves it:

```js
// 0 means not yet measurable, not "the lane never seals on the first attempt".
instrumentedResolved: instrumented.length,
firstAttemptSealRate: instrumented.length ? round(sealed / instrumented.length) : 0,
```

**4. When adding instrumentation, exclude records that predate it.** Do not reuse a pre-existing counter whose semantics changed. Gate the metric on the presence of the new artifact:

```js
const instrumented = judgedResolved.filter(
  (entry) => Array.isArray(entry?.judgeAttemptLog) && entry.judgeAttemptLog.length,
);
```

A smaller honest sample beats a larger one averaging two incompatible definitions.

**5. Ask the adversarial question before shipping the metric: what is the cheapest way to make this number look good?** If the answer is anything other than "do the work well," the metric is wrong. For an SLA rate over terminal states, the cheapest path was to fail faster.

## Why This Matters

These metrics are the evidence an acceptance criterion is judged against. A metric that reports 1.0 while the system does nothing useful does not merely fail to detect the problem — it actively certifies the broken state as healthy, and it does so most confidently at the moment of worst failure.

The instrumentation-migration variant is quieter and therefore worse: nothing looks wrong, the number is plausible, and it drifts toward accuracy only as legacy records age out of the rolling window. Nobody re-examines a metric that has always looked fine.

Both mistakes were introduced in the same change that added the observability, by the same author, in service of an issue that explicitly warned against the first one. Writing the warning into the acceptance criteria was not sufficient; the check that caught it was a reviewer asking what the number does when the system is at its worst.

## When to Apply

- Any new rate, ratio, or percentage that will be read as evidence of health.
- Any metric whose denominator spans outcome classes (resolved vs. succeeded, processed vs. delivered, completed vs. correct).
- Any instrumentation added to a system with existing records — ask what the old counter meant and whether it meant the same thing.
- Rolling-window metrics, where a mixed population takes the full window to flush and looks stable the whole time.

## Examples

**Before** — VOIDs count as SLA successes:

```js
const withinSla = judgedResolved.filter((entry) => {
  const deadline = Number(entry?.deadline ?? entry?.spec?.deadline);
  const resolvedAt = Number(entry?.resolvedAt);
  if (!Number.isFinite(deadline) || !Number.isFinite(resolvedAt)) return false;
  return resolvedAt - deadline <= slaMs;   // VOID passes this
}).length;
resolvedWithinSlaRate: judgedResolved.length ? round(withinSla / judgedResolved.length) : 0,
```

**After** — only scored resolutions count, and the failure term is visible:

```js
const scoredWithinSla = judgedResolved.filter((e) => isScoredEntry(e) && withinSla(e)).length;
const voidWithinSla  = judgedResolved.filter((e) => e?.outcome === 'VOID' && withinSla(e)).length;
```

**The test that pins it** — assert the metric's behavior in the failure state, not the happy path:

```js
it('an instant VOID drives the SLA rate to zero, not one', async () => {
  const lane = voided.scorecard.judgedLane;
  assert.equal(lane.scoredWithinSlaRate, 0, 'voiding everything must not report a perfect SLA rate');
  assert.equal(lane.voidWithinSla, 1, 'the compensating failure-state increase is visible beside the rate');
});

it('excludes pre-instrumentation entries from the attempt metrics', () => {
  assert.equal(lane.instrumentedResolved, 0);
  assert.equal(lane.firstAttemptSealRate, 0, 'not measurable is reported as 0, never as a perfect score');
});
```

A happy-path test passes under both implementations. The failure-state test is the one with teeth.

Shipped in PR #7254 (unmerged as of this writing).

Related: [a-requirement-and-its-bound-must-share-a-clock](a-requirement-and-its-bound-must-share-a-clock.md) — the defect these metrics were built to measure.
