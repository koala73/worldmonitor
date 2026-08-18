---
module: seed-defense-industrial-suppliers
date: 2026-08-18
problem_type: logic_error
component: background_job
severity: high
symptoms:
  - "`military:arms-suppliers:complete:v1` has never existed, despite the seeder running on every daily tick for months"
  - "Every run logs `FETCH FAILED: fetch phase exceeded 390000ms deadline` then `Failed gracefully (390554ms)` and exits 75"
  - "The guard that exists to prevent exactly this passes green: it asserts `(200 / 8) * 10.6s = 265s < 390s`"
  - "The 390s failure consumes the bundle budget, so every later section defers — `needs 190s but only 178s left`"
root_cause: config_error
resolution_type: code_fix
related_components: [testing_framework, tooling]
tags: [green-while-dead, hardcoded-constant, external-latency, drifted-measurement, two-sided-assertion, railway-cron, chunked-sweep, sipri, seed-bundle-static-ref-heavy]
---

# A guard that hardcodes an external service's measured latency goes green precisely when that latency drifts

## Problem

`scripts/seed-defense-industrial-suppliers.mjs` issues one POST per mapped SIPRI importer (~200 of a 385-entry catalog; the rest are non-state actors that map to no ISO2). The fetch phase never finished, so `military:arms-suppliers:complete:v1` was never written — not once, across months of daily ticks.

A guard existed for this exact failure. It passed on every run.

## Symptoms

```
[Arms-Suppliers] FETCH FAILED: military:arms-suppliers fetch phase exceeded 390000ms deadline
[Arms-Suppliers] === Failed gracefully (390554ms) ===  exit 75
[Bundle:static-ref-heavy] section=Arms-Suppliers status=GRACEFUL_FAIL elapsed=390.9s
  [Military-Bases]     Deferred, needs 410s but only 178s left in bundle budget
  [Mineral-Production] Deferred, needs 190s but only 178s left in bundle budget
[Bundle:static-ref-heavy] Finished in 392.3s, ran:0 deferred:2 graceful:1
```

The blast radius is the giveaway: a 390.9s failure inside a 570s budget leaves 179s, and every remaining section reserves ≥190s. One section's silent failure starved the whole bundle — `mineralProduction` was deferred by **11 seconds** on the exact tick its acceptance acknowledgement expired.

## What Didn't Work

**Raising concurrency (shipped, didn't help).** An earlier fix moved `concurrency` 4 → 8 on the arithmetic in the source comment: 200 importers ÷ 8 workers × 10.6s ≈ 265s, comfortably inside the 390s deadline. Production still failed at 390.9s. The change was correct reasoning applied to a wrong input.

**Raising the deadline (considered, rejected).** The obvious next move — give the fetch more time — cannot work, and the reason is worth internalising: **Railway hard-kills a cron container at 600s.** The fetch needs ~800s at measured latency. No `fetchPhaseTimeoutMs` value fits, and raising it toward the ceiling makes things strictly worse, because the section then consumes the entire bundle budget before failing anyway.

**Raising concurrency further (considered, rejected).** Sequential latency samples climbed `23.2s → 29.0s → 32.6s → 34.5s → 36.5s → 37.3s` as they accumulated. That shape reads as upstream throttling, so more parallelism plausibly increases total wall time — and these POSTs share a host with `seed-defense-industrial`, so a block takes that seeder down too.

## Solution

**First, measure.** The whole diagnosis turned on one command that nobody had re-run:

| | per importer POST |
|---|---|
| modelled in the guard | 10.6s |
| **measured 2026-08-18** | **mean 31.8s, p90 37.3s** |

Three times the modelled figure. At concurrency 8 that is ~800s for a full pass, against a 600s container ceiling.

**Then chunk.** Each tick refreshes the slice of importers whose rows are oldest and lets the rest stand (`scripts/_defense-industrial-source.mjs:39`, `SIPRI_SWEEP_CHUNK = 56`). The published snapshot *is* the cursor — no separate cursor key, because a cursor can disagree with the data after a crash or a restore and then skip a slice forever.

Completion is sweep-scoped, not tick-scoped:

```js
// 'ok' writes the completion marker, and the marker is what stops the section
// being due. It must mean "the sweep finished", not "this tick finished".
const sweepComplete = sweep ? sweep.unfetched === 0 : true;
const status = failures.length === 0 && sweepComplete ? 'ok' : 'partial';
```

**Then rewrite the guard so it cannot go green the same way** (`tests/seed-defense-industrial.test.mjs:190`). It now pins **both** directions — the chunk must fit *and* a whole-catalog pass must not:

```js
const fullPassS = (MAPPED_IMPORTERS / concurrency) * SIPRI_LATENCY_P90_S;
assert.ok(
  fullPassS > RAILWAY_CONTAINER_KILL_S,
  `a full ${MAPPED_IMPORTERS}-importer pass is ${Math.round(fullPassS)}s at concurrency ${concurrency}. `
  + 'If that now fits Railway\'s 600s container kill, the sweep may be unnecessary — re-measure and simplify deliberately.',
);
```

Verified in production (#6893): `Arms-Suppliers status=OK durationMs=196757 records=43`, `stage.sweep {catalogCount: 200, refreshedThisTick: 43, remaining: 144, complete: false}`, completion marker correctly absent. First time that key has ever held data.

## Why This Works

The original guard was not wrong about its own arithmetic — it was wrong about an input it had frozen. `OBSERVED_SIPRI_LATENCY_S = 10.6` carried the comment *"measured 2026-08-16 against live SIPRI"*, which is honest and useless: a measurement of an external service is true on the afternoon it is taken and decays silently afterwards.

The failure mode is specifically nasty because it is **anti-correlated with need**. While upstream behaves, the constant matches reality and the guard is redundant. When upstream degrades — exactly when you want to be told — the constant is stale, the arithmetic still passes, and the guard actively certifies the broken configuration. Its green is loudest when it is most wrong.

The two-sided assertion fixes this because the *second* claim is falsified by the same drift that falsifies the first. A latency change that makes the chunk stop fitting also makes the "full pass doesn't fit" claim start failing if someone removes the chunking. There is no single constant whose drift leaves both assertions satisfied.

## Prevention

**When a guard encodes a measurement of something you do not control, assert a relationship, not a threshold.** A bare `measured < limit` is a snapshot. Pin the structural fact the design depends on — here, "the unchunked pass does not fit" — so drift breaks an assertion instead of quietly satisfying one.

**Date the measurement and say what re-measuring costs.** `SIPRI_LATENCY_P90_S = 37.3; // measured 2026-08-18, was modelled at 10.6` tells the next reader both the vintage and that it has moved before. The previous comment recorded the vintage but not the volatility, so nobody re-ran it.

**Distinguish "stops taking work" from "stops working."** A soft budget that halts a worker pool cannot cancel a request already in flight. A live tick took 135s for a single batch of 8 because two importers returned HTTP 500 and retried, making the worst in-flight chain ~110s. Size the gap between the soft budget and the hard deadline to cover that chain (`SIPRI_SWEEP_SOFT_BUDGET_MS = 220_000` at `scripts/_defense-industrial-source.mjs:51`, against a 340s `fetchPhaseTimeoutMs`) — otherwise the hard deadline aborts the phase and discards every row the tick already paid for.

**A staleness rule needs both bounds pinned, and both are livelocks.** The sweep horizon (`scripts/_defense-industrial-source.mjs:77`) must exceed the sweep duration or the head expires before the tail lands and the marker is never written; it must fall under the refresh interval or every row still reads current when the section comes due and the sweep "completes" having fetched nothing. Neither bound fails visibly anywhere else, so a test asserts both.

**A selector over "stale" rows must exclude fresh ones explicitly.** A draft of this fix filtered `age > 0`, which is true of every row ever written — nothing would have been current, `unfetched` could never reach zero, and the completion marker would never have been written. That is the original bug relocated inside its own fix. The test that catches it asserts the inverse: a fully current catalog selects **nothing**.

## Related

- [A static admission gate that ignores the runtime's own pre-consumption](an-admission-guard-that-ignores-prior-runtime-cost-repeats-the-bug-it-guards.md) — sibling failure in the same bundle runner: that one is about admission *arithmetic* missing headroom, this one about a sizing *input* that drifted. Both surface as a green signal over a bundle that published nothing.
