---
title: "Publishing a formula means tracing each term to its data producer, not to its local variable"
date: 2026-09-04
category: conventions
module: crawlable corpus, chokepoint disruption score
problem_type: convention
component: documentation
severity: high
applies_when:
  - "Writing or reviewing public prose that states how a published number is computed"
  - "Single-sourcing a methodology string that several surfaces had each restated"
  - "A score term is named for its effect (anomalyBonus, threatWeight) rather than its input"
  - "The value reaches the scorer through a cache key or a relay rather than a direct call"
  - "Declaring which displayed metrics are context rather than score inputs"
tags:
  - methodology-prose
  - single-source-of-truth
  - geo
  - crawlable-corpus
  - data-provenance
  - chokepoints
---

# Publishing a formula means tracing each term to its data producer, not to its local variable

## Context

Issue #7614 reported that `/chokepoints/` and `/llms-full.txt` published two
different disruption-score formulas, and that neither let a reader reconstruct
Strait of Hormuz at 70 (Red) while the page showed 0 warnings, 0 AIS
disruptions and normal congestion. The hub FAQ had listed PortWatch
week-over-week movement as a score input and omitted the geopolitical threat
weight — the one term that actually explained the 70.

Fixing it meant naming the four terms once and rendering every surface from
that list. The score line reads clearly enough
(`server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts:451`):

```ts
const disruptionScore = Math.min(100, computeDisruptionScore(threatScore, matchedWarnings.length, maxSeverity) + anomalyBonus);
```

Reading it, the obvious conclusion is that PortWatch belongs to the separate
live-flow model and never touches the badge. That conclusion was published to
the methodology page, the blog explainer and `llms-full.txt` — and it was
false.

## Guidance

**Walk every term to the process that produced its data, then name that
producer in the published label.** A term named for its effect tells you what
it does to the score, never what it reads.

The anomaly bonus takes three hops to reach its source, and only the third one
names PortWatch:

1. `get-chokepoint-status.ts:449` — `const anomaly = ts?.anomaly ?? …`, where
   `ts` is a row from `supply_chain:transit-summaries:v1`.
2. `scripts/ais-relay.cjs:9620` — the relay computes that field as
   `detectTrafficAnomaly(cpData.history, threatLevel)`.
3. `scripts/ais-relay.cjs:9577` — `cpData` comes from
   `supply_chain:portwatch:v1`, whose `history` is built by
   `scripts/seed-portwatch.mjs` from PortWatch `n_total` daily counts.

So PortWatch moves the badge after all. The split is inside PortWatch itself:
`detectTrafficAnomaly` compares the trailing 7 days of daily transits against
the prior 30 (`shared/chokepoint-traffic-anomaly.js:27`), while `wowChangePct`
(`scripts/seed-portwatch.mjs:54`) is the presentation-only figure the page
displays. Naming the source is also what closes the reconstruction gap the
issue reported: a bonus described only by its trigger leaves a reader with no
metric to check it against.

The published label carries the producer:

```js
{ id: 'anomaly', label: 'a transit anomaly bonus when PortWatch daily transits drop sharply under high-threat conditions' }
```

**Corollary — a name shared across surfaces must point at the metric the page
displays.** The same fix found the AIS term published under three names
("AIS disruption severity", "AIS congestion severity", "maximum AIS
severity"). The first pointed a reader at the AIS *disruption count*, which is
context-only and never enters the score; the page's actual score input is the
congestion reading. Three names for one input is a reconstruction failure even
when every one of them is defensible in isolation.

## Why This Matters

Methodology prose is read by people deciding whether to trust a number, and by
assistants answering "how does this work?" on our behalf. A wrong exclusion is
worse than a vague one: "PortWatch never affects the score" is a specific,
checkable claim that a reader can act on, and it was wrong in a way the code
would have shown in three greps.

The failure mode is particular to consolidation work. Restating four scattered
descriptions as one authoritative list feels like a summarisation task, so the
natural move is to reconcile the *existing prose* against itself. That is
exactly the move that ships a confident new falsehood — the surfaces agreed
with each other and disagreed with the code. The correction lands on every
surface at once, because they now render from one list.

## When to Apply

Whenever prose asserts what does or does not feed a published value:

- Consolidating several descriptions of one computation into a single source.
- Adding a "nothing else moves this number" sentence — the strongest and most
  falsifiable claim in any methodology page.
- Reviewing a diff that names a score input, especially one named for its
  effect rather than its input.
- Any term whose value arrives via a cache key, a relay, or a seeder, where
  the producing process is not in the same file as the consumer.

## Examples

Before — reconciled against the other surfaces, contradicted by the code:

```
Those four terms are the whole formula. AIS event counts, relay transit counts,
and PortWatch week-over-week movement are published as context; PortWatch
movement drives the separate live-flow model above and never the score badge.
```

After — traced to `supply_chain:portwatch:v1`:

```
Those four terms are the whole formula. AIS event counts, relay transit counts,
and PortWatch week-over-week movement are published as context and never enter
the score. PortWatch feeds both sides: `anomalyBonus` reads its daily transit
history through `supply_chain:portwatch:v1`, while the week-over-week figure is
presentation only.
```

## Prevention

The canonical list lives in `scripts/chokepoint-page-content.mjs`, the module
reserved for crawlable copy kept out of the browser bundle. The guard in
`tests/crawlable-corpus.test.mjs` ("chokepoint disruption-score methodology")
drives every surface assertion off one join table, so a fifth input reds each
surface until that surface names it, and it sweeps each term's *derivation* for
an undeclared identifier — the check that would have caught an anomaly bonus
reaching into `wowChangePct`.

Two prevention rules from this fix are already documented and were applied
here rather than rediscovered:

- Mutation-test the guard. Every assertion was proved by inducing the drift and
  observing red, which is how the two holes below surfaced. See
  `docs/solutions/conventions/verify-the-verifier-mutation-test-every-detection-layer.md`.
- A presence check certifies a payload that violates the contract. The first
  hub-FAQ assertion checked that each canonical label *appeared* in the answer,
  so a hand-written answer that kept all four inputs and spliced PortWatch back
  in as a fifth passed — the #7614 defect verbatim. Asserting the exact rendered
  clause reds it. Same shape as
  `docs/solutions/design-patterns/contract-gate-field-names-miss-value-axis.md`,
  applied to prose instead of proto.

Shipped in [PR #7653](https://github.com/koala73/worldmonitor/pull/7653) for
[issue #7614](https://github.com/koala73/worldmonitor/issues/7614).
