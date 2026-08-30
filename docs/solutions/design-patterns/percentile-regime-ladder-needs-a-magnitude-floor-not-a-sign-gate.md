---
title: A percentile regime ladder gated on sign, not magnitude, lets any new window high hit the top tier
date: 2026-08-30
category: design-patterns
module: physical-divergence-regime-scoring
problem_type: design_pattern
component: service_object
severity: high
root_cause: logic_error
resolution_type: code_fix
applies_when:
  - "Building a percentile or rolling-quantile ladder that classifies severity/regime tiers (elevated, high, extreme) from a rolling reference window"
  - "The current observation sits inside its own reference window, so percentileRank is self-inclusive and a new high always scores at or near 100"
  - "Tempted to fix by excluding the current point from the window, or by gating every percentile tier behind the same absolute floor used for the base tier"
symptoms:
  - "classifyPhysicalPremiumRegime published regime: extreme, index: 100/100 for a 0.05% gold premium, 20x under the 1% absolute elevated floor"
tags:
  - "percentile"
  - "regime-classification"
  - "magnitude-floor"
  - "statistical-guidance"
  - "physical-divergence"
  - "scoring"
---
# Gate a relative ladder on magnitude, not on sign

## Context

A **hybrid scorer** combines an absolute ladder ("a 3% gold premium is `stressed`, full stop")
with a relative one ("this print is in the 99th percentile of its own trailing history"), then
takes the worse of the two. The absolute half survives a window where the whole baseline is
already stressed; the relative half catches a move that is unusual *for this series* before it
reaches an absolute floor. Both halves earn their place, and the design is deliberate — WorldMonitor
issue #6448 specifies it as "hybrid absolute + relative" for the SGE-vs-COMEX physical premium.

`scripts/lib/physical-divergence.mjs` is this repo's first such scorer. It classifies the gold and
silver physical-vs-paper premium into `normal | elevated | stressed | extreme` and publishes a
0-100 stress index. Absolute floors live at `scripts/lib/physical-divergence.mjs:17` for gold
(elevated 1%, stressed 3%, extreme 5%) and `scripts/lib/physical-divergence.mjs:21` for silver
(elevated 5%, stressed 10%, extreme 20%); the relative ladder is the documented 80 / 95 / 99 percentile split at
`docs/methodology/physical-divergence-index.mdx:45-50`; `higherRegime` at
`scripts/lib/physical-divergence.mjs:75-77` takes the max by rank.

The relative ladder shipped in the first draft of that PR looking like this — **this is the
pre-fix form**, no longer present in the tree (recover it from an early commit on PR #7400,
before its review-fix commit):

```js
let relative = 'normal';
if (premiumPct > 0 && percentile >= 99) relative = 'extreme';
else if (premiumPct > 0 && percentile >= 95) relative = 'stressed';
else if (premiumPct > 0 && percentile >= 80) relative = 'elevated';
return higherRegime(absolute, relative);
```

`premiumPct > 0` is a **sign** test. Everything that went wrong follows from the fact that it was
asked to do a **magnitude** test's job. The fix shipped in PR #7400 (merged 2026-08-30); the
current form is at `scripts/lib/physical-divergence.mjs:101-106`.

## Guidance

**When a scorer combines an absolute threshold with a percentile, gate the relative ladder on a
magnitude floor — a fraction of the absolute floor — never on the sign of the observation.**

Three facts make the sign test collapse, and each of them is ordinary rather than exotic:

1. **The current observation is inside its own reference window.** The seeder's Lua script
   `LPUSH`es the new point and then reads the list back in the same call
   (`scripts/seed-physical-premiums.mjs:162-173`, read at `:254` over
   `TRAILING_WINDOW_POINTS - 1`). The point being ranked is a member of the population it is
   ranked against.
2. **The percentile rank is inclusive.** `percentileRank` counts `value <= current`
   (`scripts/lib/physical-divergence.mjs:68-73`). A new window high therefore scores **exactly
   100** — every value in the window, including itself, is at or below it.
3. **A sign test admits any positive number.** Combine the three and *any* new high, of any size,
   walks straight to the top of the relative ladder.

Then the index amplifies it. The published index is
`Math.max(absoluteStressIndex(metal, premiumPct), REGIME_INDEX_FLOOR[regime])`
(`scripts/lib/physical-divergence.mjs:264`, with the floor resolved at `scripts/lib/physical-divergence.mjs:250`)
and `REGIME_INDEX_FLOOR.extreme` was `100` at the time of the bug
(`scripts/lib/physical-divergence.mjs:26`) — so the top band's floor *was* the top of the
scale. That saturation is a second, separable defect from the sign-vs-magnitude gate this doc
is about, and it is tracked in issue #7423; the constant may have moved since. The lesson here
does not depend on its current value, only on the shape: when a regime label sets a floor under
a published number, a mis-triggered label does not merely mislabel — it rewrites the number.
The regime does not merely label the reading — it sets a floor under the number.

Executed against the pre-fix module, a **0.05% gold premium — 20x below the 1% `elevated` floor —
returned `state: ok, percentile: 100, regime: extreme, index: 100`**, the maximum reading the whole
index can produce, on a window of 249 prior prints that were all *negative*. The same inputs on the
merged code return `regime: normal, index: 2.5`.

That is not a tail case. It fires the first time the spread crosses zero after a sustained
discount — a normal state for a physical-vs-paper basis.

### The two obvious fixes are both wrong

This is the part worth carrying to your next scorer, because both of these will be the first
things you reach for.

**"Rank the observation against `window.slice(1)` so it isn't in its own window."** Does not help.
A value above every other observation ranks 100 whether or not it is a member — excluding it
changes the denominator, not the verdict. Self-inclusion is also the *published convention*: the
ECB CISS defines its empirical CDF over a sample that includes the current observation (CISS
eq. 1b), and `scipy.stats.percentileofscore` ranks a score that is itself a member of the sample.
The standard remedy for "the sample maximum shouldn't get probability 1" is not window surgery but
a plotting-position formula such as Weibull `i/(n+1)`, which caps the maximum below 1 — and even
that only rescales the pin, it does not stop a trivial value from being the maximum.

**"Require the absolute `elevated` floor before any relative escalation."** This one is worse than
useless: it silently deletes a documented tier. Anything clearing the `elevated` floor is *already*
`elevated` absolutely, so `higherRegime` returns `elevated` regardless of percentile, and the
three-tier relative ladder collapses to two. Verified by running that variant: across gold premiums
`0.0000 → 6.0000` at `1e-4` steps (60,001 values), there is **not one** where a percentile of 80
changes the verdict versus a percentile of 50. The repo's own 80th-percentile boundary assertion
(`tests/physical-divergence-classifier.test.mjs:78-79`, `gold 0.5 @ p80 → elevated`) becomes
unreachable under it.

### What shipped

A magnitude floor at **half the metal's `elevated` floor** — gold `0.5`, silver `2.5`
(`scripts/lib/physical-divergence.mjs:101-102`):

```js
const relativeFloor = floors.elevated / 2;
const clearsRelativeFloor = premiumPct >= relativeFloor;
```

Half is not arbitrary. It is the largest gate that keeps all three relative tiers reachable — the
whole band between `elevated/2` and `elevated` is territory where percentile is the only thing that
can escalate — while still requiring a premium of real size before history is allowed to speak.

**The strongest evidence that half matched the original design intent: the author's pre-existing
percentile boundary test already used gold `0.5`.** `tests/physical-divergence-classifier.test.mjs:77-86`
is byte-identical before and after the fix and passes unchanged. The tier that was written to
demonstrate the relative ladder was written at exactly the value the magnitude gate landed on.

## Why This Matters

**A percentile is a statement about rank, not about size, and a regime label is a statement about
size.** Wiring one directly to the other means an arbitrarily small move can produce your loudest
output. In a hybrid scorer this is not a rounding error: `higherRegime` means the relative ladder
can *only* raise the verdict, never lower it, so every defect in the relative half is a false
positive that the absolute half is powerless to veto.

The failure has a published name — the **event/regime reclassification problem** — and the
external indices that use percentiles have explicit defenses against it. The ECB CISS is worth
studying because it looks like a counterexample and is not:

- It is percentile-only *at the indicator level*, but against a long **expanding** sample (back to
  1980, ~1,149 observations before its recursive phase), so a single new print moves the rank
  fractionally rather than pinning it.
- Its **regime** ladder is set on the index *level* via Markov-switching, **never on percentiles**.
- Its 99th percentile over 24 years sits around **0.70 on a 0-1 scale**, not 1.0 — the value is
  diluted by aggregation across 15 indicators.

That last point is the one a single-indicator index cannot borrow. CISS's protection against
pinning is cross-sectional dilution; with one indicator there is nothing to dilute against, so the
magnitude floor has to be explicit. *(CISS specifics here are cited from the published ECB
methodology, not verified in this repo.)*

Magnitude floors under relative triggers are the norm in published stress frameworks, not a local
invention — Basel's countercyclical capital buffer stays at zero below a 2pp credit-to-GDP gap
regardless of where the gap ranks historically; the Cleveland Fed CFSI, the OFR FSI, and the WMO's
SPI drought scale all grade on standardized *levels*. *(External references, attributed.)*

**The symmetry with issue #6448 is the durable lesson.** That issue already banned this, verbatim:
"Percentile-only classification is forbidden: when the trailing window itself is a stress period,
relative banding silently reclassifies crisis as normal," and "Historical percentile refines within
the floors." The issue was worried about the **false negative** — a stressed window making a crisis
look ordinary. What shipped produced the **false positive** — a calm window making trivia look
extreme. Same root cause, opposite direction, and *the same rule prevents both*. When you write a
guardrail against one direction of a rank-vs-level confusion, you have written it against both; when
you violate it, expect the failure to show up in whichever direction you were not watching.

**Finally: the fix is not done until the published methodology says the new rule.** Both
methodology pages still describe the pre-fix sign test —
`docs/methodology/physical-divergence-index.mdx:38` ("Relative thresholds apply only to positive
premiums") and its Chinese mirror `docs/zh/methodology/physical-divergence-index.mdx:26`
("相对阈值只适用于正溢价"). The code now requires half the elevated floor. A published methodology
that contradicts the shipped classifier is a second bug wearing the first one's clothes.

## When to Apply

Reach for this the moment a scorer you are designing has **both** of these:

- A verdict, label, tier, or alert level derived at least partly from where an observation ranks
  within its own history (percentile, quantile band, z-score cut, "highest in N days").
- A trailing or rolling window rather than a long expanding one — and especially a window the
  current observation is written into before being read back.

Concretely, ask four questions:

1. **Is the current point in its own reference window?** Check the write path, not the read path;
   an atomic append-then-read (`LPUSH` + `LRANGE`, an upsert before a `SELECT`) makes this true
   without any line of the scorer saying so.
2. **What is the smallest input that can produce my loudest output?** Not the smallest *plausible*
   input — the smallest input the type allows. Compute the answer; do not reason about it.
3. **Does my relative ladder have a magnitude gate, and is every tier of it still reachable with
   that gate in place?** Both halves matter: a gate set too low admits noise, a gate set at the
   absolute floor deletes tiers. Sweep the input range and count the values where the tier actually
   changes the verdict.
4. **Does the label feed a numeric floor?** A regime that only labels is a smaller problem than a
   regime that sets `index = max(computed, REGIME_FLOOR[regime])`. The floor is what turns a wrong
   label into a wrong number.

Skip it when the scorer is purely absolute — `scoreTier` in
`scripts/seed-cross-source-signals.mjs:198-203` and the component ladders in
`scripts/_fred-seeder.mjs:25-30` with `stressLabel` at `:34-38` both map raw levels to fixed cut
points and have no relative half to gate.

## Examples

**In-repo precedent — `scripts/_ema-threat-engine.mjs`.** This is the repo's one other
relative-to-a-self-inclusive-window scorer, and it is worth reading before you design a new one
because it already carries both defenses:

- Self-inclusive by construction: `const window = [...prevWindow, count].slice(-24)`
  (`scripts/_ema-threat-engine.mjs:22`) — the new count is in the window whose mean and stddev it
  is scored against.
- **Degenerate-window guard:** below `MIN_WINDOW = 6` (`:8`) it returns `risk24h: 0` rather than a
  verdict (`:111-114`).
- **Additive rather than saturating:** `risk24h = clamp(50 + zscore * 20)` (`:117`). A single
  extraordinary point moves the score by a bounded amount instead of snapping it to the ceiling.
  There is no `max(computed, FLOOR[label])` step to pin it.

It is *purely* relative — no absolute ladder — so it never faced the hybrid interaction. But its
two structural choices are exactly what the physical-divergence classifier was missing.

**The regression lock.** `tests/physical-divergence-classifier.test.mjs:88-101` pins all three
behaviors that matter, and the shape generalizes to any hybrid scorer:

```js
assert.equal(classifyPhysicalPremiumRegime('gold', 0.05, 100), 'normal');   // the bug
assert.equal(classifyPhysicalPremiumRegime('gold', 0.4999, 100), 'normal'); // just under the gate
assert.equal(classifyPhysicalPremiumRegime('gold', 0.5, 100), 'extreme');   // just over it
assert.equal(classifyPhysicalPremiumRegime('silver', 2.4999, 100), 'normal');
assert.equal(classifyPhysicalPremiumRegime('silver', 2.5, 100), 'extreme');
```

Note what makes this test have teeth: it asserts a *specific wrong verdict is gone* at a specific
tiny magnitude, and it brackets the gate from both sides on both metals. A test that only checked
"a small premium does not return `extreme`" would pass under the elevated-floor fix that deletes
the 80th-percentile tier. The companion assertion that catches *that* is the untouched boundary
block at `:77-86`, which is only meaningful because it sits at `gold 0.5` — below the absolute
`elevated` floor, so it can only pass if the relative ladder is genuinely live.

**Pairing the two is the pattern.** One test proves the gate blocks what it must block; a second
test, positioned strictly *between* the magnitude gate and the absolute floor, proves the gate did
not silently disable the ladder it was protecting. A hybrid scorer needs both, because the two
obvious fixes each pass one of them alone.
