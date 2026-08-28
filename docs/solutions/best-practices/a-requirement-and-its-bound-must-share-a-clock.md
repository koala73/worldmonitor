---
title: When a requirement and its bound are anchored to different clocks, the failure is deterministic — not a retry candidate
date: 2026-08-28
category: best-practices
module: scripts/seed-forecast-resolutions, scripts/_forecast-evidence-archive
problem_type: best_practice
component: background_job
severity: high
applies_when:
  - "A job retries an item whose success depends on data with a retention window"
  - "A requirement is expressed relative to the item (deadline, created_at) but the fetch bound is expressed relative to now"
  - "Entries pile up in a queue and the diagnosis reaches for capacity or throughput"
  - "A retry budget exists but nothing distinguishes 'not yet' from 'never again'"
tags:
  - retry-semantics
  - retention-windows
  - clock-anchoring
  - fail-closed
  - queue-starvation
  - forecast
---

# When a requirement and its bound are anchored to different clocks, the failure is deterministic — not a retry candidate

## Context

The judged forecast lane (#7068) had 144 entries pending judge, 91 of them past deadline, and eight that had ended as `judge_retry_exhausted` after 14 attempts each. The obvious reading was capacity: a backlog that the daily run could not drain.

It was not capacity. Two numbers in the same subsystem were anchored to different clocks:

- The evidence a judged entry **requires** starts at `deadline - JUDGED_EVIDENCE_LOOKBACK_MS` (7d) — anchored to the *entry* (`scripts/seed-forecast-resolutions.mjs:773`, `judgedArchiveWindowForEntry`).
- The evidence the archive **can serve** starts at `now - JUDGED_EVIDENCE_MAX_LOOKBACK_MS` (14d) — anchored to the *clock*, and backed by a real 15-day TTL (`scripts/_forecast-evidence-archive.mjs:31`).

Coverage therefore holds only while:

```
now - maxLookback <= deadline - evidenceLookback
  ⇔  now <= deadline + (maxLookback - evidenceLookback)
```

With the shipped defaults that is `deadline + 7d`. The coverage gate (`archiveCoversEntryWindow`, `scripts/seed-forecast-resolutions.mjs:763`) fails from that instant onward, and — because the archive's reach slides forward with the clock while the entry's requirement stays pinned to its deadline — **the condition is monotone: once crossed it never recovers.**

The retry loop had no way to express that. Every attempt returned the same `archive_unavailable` / `archive_window_incomplete`, indistinguishable from a transient outage, so the entry burned its full 14-attempt budget over 14 days and expired as `judge_retry_exhausted` with a receipt showing `archive: []`.

## Guidance

**1. When a job retries against data with a retention window, check whether the requirement and the bound share a clock.** If the requirement is anchored to the item and the bound is anchored to `now`, there is an instant past which the item is permanently unsatisfiable. Derive it explicitly rather than discovering it as retry exhaustion:

```js
// The instant past which required evidence can never again be served.
// Monotone: the archive's reach slides forward, the requirement does not.
export function judgedArchiveHorizonMs(entry, options = {}) {
  const deadline = toFiniteNumber(entry?.deadline ?? entry?.spec?.deadline);
  if (!Number.isFinite(deadline)) return undefined;
  const maxLookbackMs = /* archive retention */;
  const evidenceLookbackMs = Math.min(/* requirement */, maxLookbackMs);
  return deadline + (maxLookbackMs - evidenceLookbackMs);
}
```

**2. Give the deterministic case its own terminal state.** `beyond_archive_horizon` seals on the first attempt instead of the fourteenth. It is cost control, not a resolution — count it as a failure state, never as a success.

**3. Gate the terminal on evidence, not on the clock alone.** The horizon math is provable from configuration, but sealing on it unconditionally would convert a transient archive outage into permanent data loss. The terminal fires only when a *live, available* read confirms it cannot cover the window:

```js
if (beyondHorizon && !archiveComplete) { /* terminal */ }
```

An unavailable read proves nothing and stays pending. This is the difference between "provably unrecoverable" and "not recovered yet."

**4. Alert on the lead window, not the crossing.** By the time an entry crosses, the only remaining outcome is a VOID. The alert that matters fires while the entry can still be judged — `deadline + maxLookback - evidenceLookback` minus a lead time.

**5. Instrument before choosing the fix.** The per-attempt record (stage + failure class) is what turns "144 pending" into "N attempts died at the archive stage with class `archive_incomplete`." Without it, capacity is the plausible-looking answer and the tuning is wasted.

## Why This Matters

A monotone failure retried on a timer is the worst of both worlds: it consumes the retry budget, occupies queue slots that could serve recoverable work, and produces a terminal receipt whose reason (`judge_retry_exhausted`) names the *symptom* rather than the cause. Every operator reading that receipt reaches for throughput.

The reproduction made the point sharply: 20 daily runs, **both judges agreeing YES**, relevant in-window evidence present in the archive — and the entry still exhausted 14 attempts, because the guarantee it needed reached one day further back than the store could ever prove.

The fail-closed gate itself was correct and stays correct: missing evidence must never be judged as absence. What was missing was the ability to say *this gate will never open again*.

## When to Apply

- A retry loop whose success depends on a store with a TTL, retention window, or rolling read clamp.
- Any pair of "how far back we need" and "how far back we can reach" where one is item-relative and the other is now-relative.
- A queue where entries accumulate and the first hypothesis is capacity. Check for a monotone gate before tuning throughput.
- Terminal states whose reason names elapsed budget (`*_retry_exhausted`, `max_attempts`, `timeout`) rather than a cause — they often hide a deterministic failure.

## Examples

**Before** — every attempt is indistinguishable, so the budget decides the outcome:

```js
const archiveComplete = archiveCoversEntryWindow(entry, archiveInput, nowMs);
if (!archiveItems.length) {
  if (!archiveComplete) {
    // Same answer on attempt 1 and attempt 14. Nothing here can ever change.
    return { status: 'pending', reason: 'archive_unavailable' };
  }
  ...
}
```

**After** — the deterministic case is named and sealed once, and the transient case still retries:

```js
const horizonMs = judgedArchiveHorizonMs(entry, options);
const beyondHorizon = Number.isFinite(horizonMs) && nowMs > horizonMs;

if (!archiveInput.available) {
  // An unavailable read proves nothing about the horizon.
  return { status: 'pending', stage: 'archive', reason: 'archive_unavailable' };
}
if (beyondHorizon && !archiveComplete) {
  return terminal('VOID', 'beyond_archive_horizon');  // one attempt, not fourteen
}
```

**The boundary test that pins it** — the last recoverable instant still seals normally; one millisecond later it does not:

```js
it('still seals normally at the last recoverable instant', /* nowMs = HORIZON_MS */);
it('terminates one millisecond past the horizon instead of exhausting retries', /* nowMs = HORIZON_MS + 1 */);
it('does not launder a transient archive outage into a horizon VOID', /* available: false */);
```

Shipped in PR #7254 (unmerged as of this writing).

Related: [checks-must-fail-closed-when-they-lose-their-target](checks-must-fail-closed-when-they-lose-their-target.md) — the sibling failure, where a check that can no longer observe its target reports success instead of erroring.
