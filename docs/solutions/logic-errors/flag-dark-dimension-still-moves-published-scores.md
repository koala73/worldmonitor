---
module: resilience-scorer
date: 2026-08-10
problem_type: logic_error
component: service_object
severity: high
category: logic-errors
symptoms:
  - "A dimension shipped flag-dark (score=0, coverage=0) still changed every country's published overallScore"
  - "pillars[].coverage moved as a public field despite the dimension contributing nothing"
  - "The score shift was non-uniform across countries, so ranking positions could reorder"
root_cause: logic_error
resolution_type: code_fix
tags:
  - resilience
  - feature-flag
  - scoring
  - coverage-weighted-mean
  - cache-invalidation
---

# A flag-dark dimension is not inert — verify every aggregation layer, not the obvious two

## Problem

Adding a fifth dimension to a scoring domain behind a default-off feature flag changed the published score for all 196 countries in the WorldMonitor Country Resilience Index, despite the dimension emitting `score=0, coverage=0, observedWeight=0, imputedWeight=0` and contributing nothing.

The change had been reasoned about and verified at two aggregation layers, both of which behaved correctly. A third layer above them did not.

## Symptoms

- `overallScore` moved for every country (measured against committed release-gate fixtures: US 47.37 → 47.47, NO 83.01 → 83.25, YE 15.01 → 15.05).
- `pillars[].coverage`, a public API field, dropped (US 0.85 → 0.75).
- The domain score itself was **unchanged** (66.25 / 84.22 / 31), which is what made the leak hard to localize — the layer everyone checks was innocent.
- The shift was non-uniform (+0.04 to +0.24 across three sample countries), so adjacent countries in a public ranking could reorder.

## What Didn't Work

**Verifying the two obvious layers, and concluding from their correctness.** Both checks passed, and both were the right checks to run:

1. `coverageWeightedMean` in `server/worldmonitor/resilience/v1/_shared.ts` — correctly drops a `coverage=0` dimension from a domain blend. Verified.
2. `isExcludedFromConfidenceMean` in `server/worldmonitor/resilience/v1/_dimension-scorers.ts` — correctly keeps a dark dimension out of `overallCoverage` and `lowConfidence`. This one had to be *added* during the work, because without it a dark dimension dropped countries below the `headlineEligible` coverage gate entirely.

Having fixed a real coverage regression at layer 2 and confirmed layer 1, the invariant felt established. It was written into three places as fact: a runbook, a code comment, and a test comment. All three were wrong.

The failure mode is specific: **fixing a related bug at one layer creates false confidence that the layer class is now handled.**

## Solution

The unguarded layer is the pillar aggregation, one level above both verified layers:

```ts
// server/worldmonitor/resilience/v1/_pillar-membership.ts
function averageDomainDimensionCoverage(domain: ResilienceDomain): number {
  if (domain.dimensions.length === 0) return 0;
  return domain.dimensions.reduce((sum, dim) => sum + dim.coverage, 0) / domain.dimensions.length;
}
```

A **flat mean over `domain.dimensions.length`**, with no exclusion filter. That value then weights each domain inside its pillar:

```ts
const pillarScore = /* ... */ domainCoverages.reduce((sum, item) => {
  return sum + item.domain.score * item.domain.weight * item.coverage;
}, 0) / totalWeightedCoverage;
```

Adding a coverage-0 fifth dimension scales that domain's coverage to 4/5 of its previous value. Its weight inside the pillar drops, the pillar rebalances toward its other member domains, and the overall score moves.

The fix uses a narrow `isFlagDarkDimension` predicate in both confidence and
pillar aggregation. It matches only allow-listed dimensions with the exact
triple-zero shape. Retired and not-applicable dimensions keep their existing
pillar semantics, while a real education outage (`imputedWeight > 0` or
`observedWeight > 0`) remains in the denominator and lowers confidence.

This scope matters. Reusing the broader confidence exclusion helper would also
change how already-retired dimensions affect pillar coverage, causing an
unrelated published-score migration.

## Why This Works

With the narrow exclusion in place, the flag-off scaffold is numerically
invariant. The score cache still rotates because its serialized payload gains
the education row, but history and interval generations stay unchanged until
the flag is activated and the numeric score can move.

The deeper reason the original reasoning failed: **"this value is zero, so it contributes nothing" is only true where the aggregation is weighted by that value.** A flat mean is weighted by *count*, not by the value, so a zero contributes its full share of the denominator. Any `sum / length` in an aggregation chain is a place where a zero-valued member still exerts influence.

## Prevention

**Trace the full aggregation chain, not the layer where the value is consumed.** When adding a member to a scored collection, enumerate every function between the member and the published number, and check each one for how it computes its denominator. In this codebase that chain was: dimension → domain (weighted mean, safe) → pillar (flat mean, unsafe) → overall.

Grep for the shape rather than reasoning about it:

```bash
# Any aggregation dividing by a collection length is a candidate
grep -rn "\.length;" --include='*.ts' server/ | grep -i "reduce\|sum\|average\|mean"
```

**Pin the invariant and its negative case.** The regression lock asserts that a
flag-dark row is inert while a source failure on the same dimension still
changes coverage:

```ts
it('keeps pillar score and coverage identical when education is flag-dark', () => {
  const before = buildPillarList([/* economic 2 dims, social-governance 4 dims */], true);
  const after  = buildPillarList([/* same, plus education triple-zero */], true);
  assert.equal(sr(after).coverage, sr(before).coverage);
  assert.equal(sr(after).score, sr(before).score);
});
```

The paired outage test sets `imputedWeight=1` and asserts that pillar coverage
does fall. Without that negative case, an over-broad `coverage===0` filter could
make the invariant green by hiding real failures.

**Do not write an invariant claim into documentation until the whole chain is checked.** The claim "this change moves no published value" was asserted in a runbook, a code comment, and a test comment before the pillar layer had been examined. Three artifacts then had to be corrected. A claim about what a change does *not* affect is a strong claim and deserves the same evidence bar as a claim about what it does.

**A related-bug fix is not chain coverage.** Fixing the `headlineEligible` coverage regression at the confidence-mean layer felt like it discharged the "dark dimension dilutes things" concern. It discharged exactly one instance of it.
