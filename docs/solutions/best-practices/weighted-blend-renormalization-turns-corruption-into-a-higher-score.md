---
title: "Renormalizing a weighted blend on a dropped null slot lets data corruption raise the score"
date: 2026-08-12
category: best-practices
module: "resilience-scorer"
problem_type: best_practice
component: service_object
severity: high
root_cause: logic_error
applies_when:
  - "Auditing any weighted-blend or weighted-average aggregator that drops a null-score component and renormalizes its weight onto the surviving components"
  - "Reviewing a scoring pipeline where a malformed or partially-parsed upstream field can silently vanish a component instead of erroring"
  - "Evaluating a candidate fix for a blend-renormalization defect that works by dropping MORE components (coupling sibling slots, widening null propagation)"
symptoms:
  - "Albania's financialSystemExposure score reads 75 -> 86 when the BIS parentCount field fails to parse (a stringified count instead of a raw number)"
  - "A corrupted, missing, or unparseable input component RAISES the published composite score instead of lowering it or leaving it neutral"
  - "No test caught the regression, because every fixture in the suite was well-formed and none exercised the null-drop path"
related_components:
  - "bis-lbs-seeder"
  - "resilience-index-api"
tags:
  - resilience-scoring
  - weighted-blend
  - renormalization
  - null-handling
  - data-quality-regression
  - bis-lbs
  - financial-system-exposure
---

# A dropped component slot renormalises onto the survivors — so corruption can read as strength

## Problem

`weightedBlend` — the primitive every WorldMonitor resilience dimension is built
on — drops any component slot whose score is `null` and divides by the weight
that survived:

```ts
// server/worldmonitor/resilience/v1/_dimension-scorers.ts:861
function weightedBlend(metrics: WeightedMetric[]): ResilienceDimensionScore {
  const totalWeight = metrics.reduce((sum, metric) => sum + metric.weight, 0);
  const available = metrics.filter(hasFiniteMetricScore);              // :863
  const availableWeight = available.reduce((sum, m) => sum + m.weight, 0); // :864
  ...
  const weightedScore = available.reduce(
    (sum, metric) => sum + metric.score * metric.weight, 0) / availableWeight; // :870
```

`hasFiniteMetricScore` is `Number.isFinite(metric.score)`
(`_dimension-scorers.ts:95`), so *any* reason a slot fails to resolve — genuine
absence, a partial upstream payload, a type regression in a seeder — removes it
from both the numerator and the denominator.

That renormalisation has no direction. The published score moves toward the
weighted mean of whatever survived. When the surviving legs read **higher** than
the leg that was lost, **losing data raises the score**. A data-quality
regression is published as an improvement in national resilience.

This was **issue #6528**. The fix keeps the generic blend conservative when a
reader can prove that a field was present but malformed: the slot keeps its
design weight and contributes an explicit fallback score. Genuine absence keeps
the existing coverage-weighted behavior. What follows is the measured mechanism,
the remedies that were rejected, and the diagnostic that separated them.

## Symptoms (measured, not reasoned)

Albania, `financialSystemExposure`. Its production BIS row is
`{ totalXborderPctGdp: 17.6, parentCount: 2 }`
(`tests/helpers/resilience-finsys-fixtures.mts:91`, captured 2026-08-12). The
corruption modelled is the cheapest realistic one: a seeder publishing
`parentCount` as a **string**. `readBisLbsCountry` demands a raw number —

```ts
// server/worldmonitor/resilience/v1/_dimension-scorers.ts:2339-2340
totalXborderPctGdp: typeof rawClaims === 'number' ? safeNum(rawClaims) : null,
parentCount:        typeof rawParentCount === 'number' ? safeNum(rawParentCount) : null,
```

— so `"2"` becomes `null`, and the Component 4 slot
(`_dimension-scorers.ts:2209-2214`) drops out with its 0.15 weight.

Driving the real `scoreFinancialSystemExposure` against the pinned fixture:

| band transform in use | honest | `parentCount` unparseable | inflation |
|---|---|---|---|
| raw band (`normalizeBandLowerBetter`, `:742`) — today's `main` | 75 | 86 | **+11** |
| diversity-conditioned (`normalizeDiversityConditionedBand`, `:818`, PR #6529) | 70 | 80 | **+10** |
| both BIS slots coupled (attempted fix, reverted) | 70 | 83 | **+13** |

Every leg in those figures is an INTEGER: production rounds each component
through `roundScore` before `weightedBlend` divides by the surviving weight, so
Albania's debt leg is 73, not 72.867. That detail is load-bearing here — the
honest raw-band blend lands on exactly 74.50, which rounds to 75. Measuring it
with unrounded legs gives 74.47 → 74 and overstates the inherited inflation by a
point. The first version of this table did exactly that; the mirror in
`tests/resilience-financial-system-exposure.test.mts` now rounds its legs, and
the numbers above are the real scorer's.

The arithmetic behind the +10 row: the freed 0.15 redistributes across **all**
the survivors — debt (73), band (75), FATF (100) — and every one of them sits
far above the redundancy leg (11) that was lost. The denominator shrinks
1.00 → 0.85 and each surviving leg gains share.

The comparison that matters is against the **dropped** leg, not against each
other. Albania's redundancy leg reads 11 because two reporting parents is a
concentrated funding base; losing that reading deletes the one leg that was
dragging the dimension down. That is the general shape of the defect: a slot
is dropped, and the score rises by exactly the amount that slot was arguing
against.

The regression **is** visible in the response — just not in the number anyone
reads. Coverage is computed against the *nominal* design-time weights, never
renormalised (`_dimension-scorers.ts:885-890`), so the same run reports:

```
honest      score 70   coverage 1.00   observedWeight 1.00
half-parsed score 80   coverage 0.85   observedWeight 0.85
```

Coverage tells the truth and falls. The headline score tells the opposite story
and rises. A consumer ranking countries by `score` sees Albania improve.

**No existing test could have caught this**, because every fixture in the suite
was well-formed. The suite proved the happy path across all 23 `weightedBlend`
call sites without once feeding a half-parsed upstream row. (One now exists —
the guard described below feeds a stringified `parentCount` — but it covers a
single dimension, and it was written *because* of this finding, not before it.)

## What didn't work

### 1. Coupling the sibling slots — the intuitive fix, and directionally wrong

The obvious instinct is: a BIS row that half-parsed is untrustworthy, so refuse
to score *either* BIS-derived slot from it. Fail closed. That was implemented
and measured:

```
both BIS slots null   score 83   coverage 0.55
```

**Worse — +13 against the honest 70, versus +10 for doing nothing.** The reason
is mechanical and should have been predictable: dropping *more* slots frees
*more* weight onto the same high legs. The denominator falls from 0.85 to 0.55,
and the debt/FATF pair now carries the entire score.

The general form of the lesson: **any remedy that works by dropping moves the
score in the same direction as the bug.** In a drop-and-renormalise blend,
withholding a slot is not a conservative act — it is a bet that the withheld
slot would have scored *above* the survivors. Sometimes that bet is right: the
FATF empty-listings guard at `_dimension-scorers.ts:2363` drops a leg that reads
100 for nearly every country, so dropping deflates and genuinely fails closed.
That guard is safe by accident of its position in the score distribution, not by
construction. The same reflex applied to a low-reading slot inflates.

The measurement is what killed the coupling fix. Code review did not; it looked
like textbook defensive parsing.

### 2. Reasoning about renormalisation instead of measuring it

An adversarial reviewer of PR #6529 framed the inflation as **caused by** the
new diversity conditioning — a plausible story, since the conditioning is what
makes a missing `parentCount` change the band leg at all
(`_dimension-scorers.ts:824-829`). Accepting that framing would have led to
reverting or patching a change that is not the defect.

Measuring the same corruption through the **unconditioned** band inverted the
verdict: +11 on the raw band versus +10 conditioned. The inflation is
**pre-existing** — it is what `main` does today — and the conditioning
**reduces** it. Reasoning alone would have "fixed" a non-defect while shipping a
strictly worse one.

The margin is one point, not two, and that correction has its own lesson: the
baseline was first measured with an unrounded mirror and read +12. A
counterfactual is only as trustworthy as its fidelity to the real arithmetic —
including the rounding — so the mirror that produces the baseline needs a test
that it still reproduces the real scorer, not just that it is directionally
sensible.

## The diagnostic that settled both

**Measure the counterfactual through the real blend arithmetic — honest versus
corrupted — under every transform in contention.** Not one run: a matrix.

```ts
const honest     = await scoreFinancialSystemExposure('AL', createFinSysFixtureReader());
const halfParsed = await scoreFinancialSystemExposure('AL', createFinSysFixtureReader({
  bis: { AL: { ...real, parentCount: String(real.parentCount) as unknown as number } },
}));
```

Three properties make this work where reasoning failed:

1. **It runs the production scorer**, not a mental model of it. The 0.85
   denominator, the `roundScore` clamp at `:609`, the unrounded-vs-rounded leg
   values — all of it is in the answer for free.
2. **It runs the corrupted payload through the real reader.** The corruption is
   `String(real.parentCount)`, a value a seeder can actually emit, not a
   hand-placed `null`. A hand-placed `null` would have proven the blend
   arithmetic while skipping the question of whether the null is *reachable*.
3. **It scores the same corruption under the old and new transforms.** That is
   the step that assigns blame. Without the raw-band baseline there is no way to
   distinguish "this change caused the inflation" from "this change inherited
   it", and the reviewer's framing wins by default.

When someone asks "what happens if this component goes null?", the answer is a
number from the real blend, per transform, not an argument about
renormalisation.

## Candidate remedies (issue #6528 — decision recorded)

1. **Impute rather than drop.** A missing slot resolves to a conservative score
   at reduced `certaintyCoverage`, keeping its weight in the denominator while
   shrinking coverage visibly. **This construct already does exactly that** for
   the non-DRS debt slot: `IMPUTE.finSysExposureNonDrsShortTermDebt`
   (`_dimension-scorers.ts:195`, `{ score: 75, certaintyCoverage: 0.3,
   imputationClass: 'not-applicable' }`), wired through
   `resolveNonDrsDebtImputation` (`:2240`). Its comment at `:2139-2143` records
   the identical failure caught once before: dropping the 0.35 debt slot
   renormalised the punitive band leg from 30% to 46% of Luxembourg's score. So
   this is an established pattern in the file, not a new mechanism — the bug is
   that the pattern was applied to one slot instead of to the primitive.
2. **Cap the renormalisation gain.** Bound how far a blend may move when weight
   is freed, independent of which slot was lost.
3. **Distinguish absent from corrupt.** A legitimately-absent slot renormalises
   as it does today; a slot that was *present and failed to parse* fails closed.
   This needs readers to report **why** a field is null — `readBisLbsCountry`
   currently collapses "field missing" and "field present but wrong type" into
   the same `null` (`:2339-2340`), so the information does not exist at the
   blend layer today.

The implementation chooses remedy 3 at the reader boundary and uses the
generic blend's explicit fallback path. A malformed BIS claims or parent-count
field contributes zero at its design weight, while coverage still falls. A
legitimately absent field remains unannotated and keeps the prior absence
semantics. This preserves existing call-site behavior while making the
malformed-input path fail closed.

## Scope

This is a property of `weightedBlend`'s drop-and-renormalise semantics, so it is
**not specific to `financialSystemExposure`, to BIS data, or to `parentCount`**.
The primitive now supports an explicit fallback for any reader that can prove
that a null score came from malformed input. There are 23 `weightedBlend` call
sites in `server/worldmonitor/resilience/v1/_dimension-scorers.ts`; readers that
only report genuine absence retain the old behavior until they can provide that
distinction.

**Exposure is proportional to the spread between the dropped slot and the
survivors.** A dimension whose slots cluster tightly barely moves when one
drops. `financialSystemExposure` is a bad case precisely because its legs are
designed to disagree: a redundancy count of 11 sits next to a FATF compliance
score of 100 in the same blend. Rank the dimensions by that spread to rank the
risk.

## What is guarded today — and what is not

`tests/resilience-dimension-scorers.test.mts` pins the generic contract: an
explicit fallback keeps a malformed slot in the denominator, while an
unannotated null still follows the existing absence behavior. The financial
system exposure tests then exercise that contract through a stringified BIS
`parentCount` and assert that the published score does not rise.

```ts
assert.ok(conditionedInflation <= 0, ...);  // malformed input must not raise score
assert.ok(inheritedInflation > 0, ...);     // pre-fix counterfactual stays non-vacuous
```

The second assertion keeps the old counterfactual non-vacuous. The inherited
baseline is computed by a local `blendFinSys` helper (`:61`) that mirrors the
pre-fix drop-and-renormalise semantics for the *unconditioned* side only; the
conditioned side always runs the real `scoreFinancialSystemExposure` and must
stay at or below the honest score.

The generic test constrains the blend primitive; the reader-level test shows how
to connect a real parser failure to that path. It does not claim that a reader
which cannot distinguish absence from corruption is safe by default.

## Prevention

**Ask what a slot going null does to the score, and answer with a number.** For
every new blended component, run the honest and corrupted payloads through the
real scorer. If the corrupted score is higher, the design is publishing
corruption as strength.

**Distrust drop-based defensive parsing in a renormalising blend.** "Refuse to
score from an untrustworthy row" is the correct instinct in most codebases and
the wrong one here. Before adding a `? null` slot guard, check where the
dropped leg sits relative to its siblings — dropping is only conservative when
it removes a leg that reads *above* the survivors. Prefer the impute pattern
(`IMPUTE.*` + `certaintyCoverage`) that already exists in the file.

**Fixtures that are all well-formed prove only the happy path.** The entire
resilience suite passed at every point in this session. A half-parsed upstream
row is not an exotic scenario — it is one seeder emitting `"2"` instead of `2` —
and nothing in the suite exercised it. When a scorer reads external payloads,
one fixture per reader should be *type-corrupted*, not merely absent.

**When a reviewer attributes a defect to your change, measure the baseline
before agreeing.** The strongest available evidence that a change did not cause
something is the same measurement run against the code without it. Here that was
two lines of arithmetic against the unconditioned transform, and it inverted the
conclusion.

## Related

- Issue #6528 — fixed by the explicit malformed-slot fallback path.
- PR #6529 — diversity-conditioned integration premium; carries the one-dimension
  regression guard and now benefits from the blend fix.
- `_dimension-scorers.ts:2139-2143` — the same renormalisation failure caught
  once before on the debt slot (#6459), fixed there by imputing rather than
  dropping.
- [`flag-dark-dimension-still-moves-published-scores`](../logic-errors/flag-dark-dimension-still-moves-published-scores.md) —
  same scorer family, same shape: a path that looks inert still moves the
  published score, and only tracing the real arithmetic exposed it.
