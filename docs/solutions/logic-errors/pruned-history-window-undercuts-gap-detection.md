---
title: "A time-windowed prune undercuts any check that diffs across the window"
date: 2026-09-05
category: logic-errors
module: ais-relay
problem_type: bug
component: background_job
severity: high
symptoms: "Dark-ship (AIS gap) detection counts zero forever while the algorithm reads correct"
root_cause: "cleanupAggregates prunes the history structure to the 30-min DENSITY_WINDOW, so the >1h gap the check diffs across can never exist in the pruned data"
resolution_type: code_change
tags: [ais-relay, dark-ships, ais-gaps, time-windows, prune, blindspot, detection, temporal-baselines]
---

# A time-windowed prune undercuts any check that diffs across the window

## Problem

`ais-relay.cjs` detects "dark ships" — vessels that returned after more than an hour of AIS silence — by diffing a vessel's last two position fixes: `lastSeen - secondLast > GAP_THRESHOLD` (1h). The same relay prunes that exact history structure every few seconds: `cleanupAggregates()` filters `vesselHistory` down to the 30-minute `DENSITY_WINDOW` (`scripts/ais-relay.cjs`, the `history.filter((ts) => ts >= cutoff)` loop, cutoff = `now - DENSITY_WINDOW`) and caps each vessel at 10 entries. Both the new trusted `ais_gaps` count producer (#7574) and the pre-existing `gap_spike` disruption in the HTTP snapshot were built on top of this check — and both could never fire: by the time any qualifying return (>1h silence) arrives, the prior fix is long gone from the pruned, capped structure, so the diff sees at most a 30-minute span. The signal was structurally dead, and every test that lifted the function out of the relay (the body-extraction test harness) was blind to it because the harness isolates the function from exactly the loop that kills its input.

## Symptoms

- `maritime:ais-gaps:v1` publishes `darkShips: 0` on every cycle, graded `OK_ZERO` — health reads green while the sensor measures nothing.
- The relay's HTTP snapshot never emits a `gap_spike` disruption despite the code path being exercised every heartbeat.
- Unit tests of the counting function pass — they populate the history fixture directly and never run the real `cleanupAggregates` prune.

## What Didn't Work

- **Fixing the check inside its own data structure.** The first #7574 fix recorded sightings "at ingestion" but still read the prior fix FROM `vesselHistory` — the same pruned map. `lastFix` was therefore always ≤30 minutes old, so `now - lastFix > GAP_THRESHOLD` was unreachable. Two reviewers (adversarial persona and the PR's codex-connector) both caught the cascade: a time-windowed prune below the diff threshold makes the check structurally impossible regardless of where you call it from.
- **Testing the function in isolation.** The body-extraction harness (`scripts/ais-relay-ais-gaps.test.cjs`, pattern shared with `ais-relay-seed-fetchedat.test.cjs`) verifies the lifted function against fixtures. If the fixture construction doesn't replay the real maintenance loop (`cleanupAggregates`), the test proves nothing about production. The `countDarkShips`-vs-`cleanupAggregates` interaction needed a test that drives the prune, not just the count.

## Solution

Keep the observation in a dedicated structure whose retention exceeds the gap threshold, updated at ingestion:

```js
// mmsi → timestamp of the vessel's most recent position fix. Retention must
// exceed GAP_THRESHOLD …
const vesselLastFixSeen = new Map();
const LAST_FIX_RETENTION_MS = 6 * 60 * 60 * 1000; // 6h — 6× GAP_THRESHOLD

// in processPositionReportForSnapshot (ingestion time, per position report):
const lastFixAt = vesselLastFixSeen.get(mmsi);
if (lastFixAt && now - lastFixAt > GAP_THRESHOLD) {
  darkShipReturns.set(mmsi, now);      // returned after extended silence
}
vesselLastFixSeen.set(mmsi, now);      // survive the DENSITY_WINDOW prune
```

`cleanupAggregates` retention-prunes and recency-caps the new map (6h window, `evictMapByTimestamp` at `MAX_VESSEL_HISTORY`), so memory stays bounded; `countDarkShips` reads only the 10-minute-fresh `darkShipReturns` entries. Verified by: the pinned source-text assertions in `scripts/ais-relay-ais-gaps.test.cjs` (the last fix MUST come from `vesselLastFixSeen`, not `vesselHistory`), and the relay boot tests.

## Why This Works

A prune is a policy about one structure's display window; a gap detector needs the ENDS of the gap, which are by definition older than any display window shorter than the gap. Detaching the observation (one number per active mmsi) from the presentation structure (the bounded history) gives the detector a data source whose retention policy matches its math. The general rule: **any check that compares timestamps spanning duration D must keep its inputs for at least D plus the sampling period — and the structure holding them must be governed by that retention, not by a shorter display prune or a small entry cap.** The 10-entry cap was the second killer: an active vessel streams positions every few seconds, so even a widened prune window wouldn't keep a >1h-old fix inside 10 entries.

## Prevention

- When adding or reviewing a windowed check, name the retention of EVERY structure it reads and compare against the check's span (prune window AND entry caps). If retention < span + sampling period, the check is dead on arrival regardless of its logic.
- Test the interaction with the maintenance loop, not just the function: drive `cleanupAggregates` (prune → silence → re-see) before asserting a count. Isolation-style body-extraction tests need at least one test that replays the real prune.
- Related: `docs/solutions/design-patterns/multi-source-freshness-clock-must-reduce-with-min.md` (content clocks over independent sources) and the #6775 single-clock rule for envelope writes (`scripts/ais-relay-seed-fetchedat.test.cjs`).
