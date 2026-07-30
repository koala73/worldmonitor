---
title: Inverting a primary/fallback order silently transfers the shared time budget to the new primary
module: seed-conflict-intel
date: 2026-07-30
problem_type: design_pattern
component: background_job
severity: high
applies_when:
  - "Swapping which of two data sources is primary vs fallback inside a deadline-bounded fetch phase"
  - "A budget/deadline invariant test models the two paths ADDITIVELY (primary window + fallback worst-case)"
  - "The demoted path keeps a launch-cutoff computed from an absolute deadline anchored before either path runs"
tags:
  - fallback-ordering
  - time-budget
  - deadline-invariant
  - gdelt
  - seeder
  - review-checklist
related_components:
  - testing_framework
---

# Inverting a primary/fallback order silently transfers the shared time budget

## Context

Issue #5849 (PR #5855) inverted `seed-conflict-intel`'s GDELT sourcing: the bulk
export became primary and the DOC per-country sweep became the fallback. The
sweep's launch cutoff (`scripts/seed-conflict-intel.mjs:489-490`) is derived
from an absolute `deadlineAt` anchored at fetch-phase start — under the old
order the sweep ran first and consumed that window directly, and the bulk
attempt's worst case was budgeted ON TOP of it: the deadline invariant test
computes `max(HAPI, SWEEP_BUDGET + worstBatch) + GDELT_BULK_WORST_NETWORK_MS + slack`
(`tests/seed-fetch-deadline-budget-invariants.test.mjs:105-107`) — the two
paths are modeled ADDITIVELY. A naive inversion (move the bulk block above the
sweep, change nothing else) makes the bulk attempt eat the sweep's window: a
slow-failing mirror (up to ~60s of `GDELT_BULK_WORST_NETWORK_MS` timeouts,
`scripts/_conflict-gdelt-bulk.mjs:22-23`) hands the healthy fallback an
already-expired budget, so the sweep's `overBudget` check trips on iteration
zero and every 15-minute tick reports a combined "no usable source" failure
without a single fallback request being made. The reliability reviewer caught
this in review; it never reached production.

## Guidance

When inverting which path is primary, transfer the budget explicitly:

1. **Credit the new primary's elapsed time back to the demoted path's cutoff,
   clamped to the constant the invariant models:**

   ```js
   const bulkStartedAt = now();            // before the primary attempt
   // ... primary attempt fails ...
   const launchCutoffAt = deadlineAt != null
     ? deadlineAt + Math.min(now() - bulkStartedAt, GDELT_BULK_WORST_NETWORK_MS)
     : now() + GDELT_SWEEP_BUDGET_MS;
   ```

   (`scripts/seed-conflict-intel.mjs:415` and `scripts/seed-conflict-intel.mjs:489-490`.) The credit restores exactly
   the window the demoted path had under the old order; the clamp keeps the
   code's worst case equal to the constant the invariant test asserts, so
   model and reality cannot drift apart silently.

2. **Prove it with an injected-clock test** where the primary consumes most of
   the window before failing, asserting the fallback still attempts its full
   sweep — and a companion test where the deadline expired *before* entry,
   asserting the credit cannot resurrect a dead window (algebraically the
   credited cutoff equals "budget remaining at function entry", so aux-stage
   overruns still cancel the sweep). Both are in `tests/conflict-gdelt.test.mjs`
   ("slow-failing bulk export does not starve" / "cannot resurrect a window").

## Why This Matters

The failure mode is invisible in every ordinary test: synchronous mock failures
consume zero clock, so the fallback always appears to get its full window. In
production it means a *slow* (not down) primary permanently disables the
emergency fallback — the exact insurance the fallback exists to provide — while
each tick degrades to a preserved-last-good no-publish and freshness quietly
ages toward the health threshold. The pre-inversion code never had this bug
because the fallback ran first; the inversion *created* it without touching a
line of the fallback.

## When to Apply

Any reorder of attempt sequence inside a deadline- or lock-bounded phase:
seeders with primary/fallback data sources, retry ladders with per-rung
budgets, multi-provider fetch chains. Trigger question for review: "whose
clock does the demoted path now run on, and does the total-envelope invariant
model these paths additively or shared?"

## Examples

The rest of the inversion checklist from the same review (two model families
converged on these independently):

- **Cold-start thin-window floor** — the promoted path's success predicate was
  weaker than the demoted path's (any non-empty window vs. a 16/20 coverage
  floor). With no retained rolling window, a partially-degraded source serving
  a single-country handful would overwrite last-good and suppress the fallback.
  Fix: `scripts/seed-conflict-intel.mjs:439` gates cold-start publishes on
  ≥3 countries with events, falling through to the fallback instead.
- **Snapshot-shape consumers** — the promoted path published different
  pagination telemetry; audit every reader of the snapshot before dropping the
  demoted path's fields (none read them here, verified by repo-wide grep).
- **Stateful-window coupling** — the promoted path's rolling window is rebuilt
  from the previous snapshot, and a fallback tick publishing a different
  `source` tag erases it on recovery. Pre-existing mechanism, tracked as
  issue #5852 rather than fixed in the inversion PR (its acceptance criteria
  pinned merge semantics unchanged).

Fix state: opened in PR #5855 (CI green), unmerged as of this writing.
