---
status: pending
priority: p2
issue_id: 173
tags: [code-review, phase-0, regional-intelligence, performance, redis]
dependencies: []
---

# Sequential per-region persist pipelines waste ~1600ms wall-clock

## Problem Statement

`scripts/seed-regional-snapshots.mjs:181-203` awaits `persistSnapshot(snapshot)` per region in a sequential `for` loop. Each call issues 2 round-trips (dedup SETNX + data pipeline). 8 regions × 2 round-trips = 16 serial round-trips = ~1600ms wall-clock. Regions are fully independent (dedup keys are region-scoped) so this is safe to parallelize.

## Findings

- `scripts/seed-regional-snapshots.mjs:181-203` — sequential for-loop over regions with `await persistSnapshot` inside.

## Proposed Solutions

### Option 1: Parallelize with Promise.all

Replace the sequential for-loop with `Promise.all(regions.map(async region => ...))`. Saves ~1400ms wall-clock.

**Pros:** Trivial change; region-independent writes make this safe; failures are isolated per region via `Promise.allSettled` pattern.
**Cons:** Partial failure handling needs explicit `allSettled` to not block other regions.
**Effort:** Small.
**Risk:** Low.

### Option 2: Batch pipeline all 8 regions into one redis.pipeline() call

Collect all writes, emit a single multi-region pipeline. Saves ~1500ms.

**Pros:** Single round-trip for writes.
**Cons:** Dedup SETNX results need to be checked before emitting the data writes, so you still need two phases; more invasive refactor.
**Effort:** Medium.
**Risk:** Medium.

## Recommended Action

Option 1 with `Promise.allSettled`. Combined with #172, drops total runtime from ~3.4s to <800ms.

## Technical Details

`persistSnapshot` currently does:
1. `SETNX dedup:{region}:{hash} 1` (1 round-trip)
2. `pipeline: SET by-id, SET latest, EXPIRE...` (1 round-trip)

Each region's dedup key is namespaced by region, so there is no cross-region write ordering constraint. Switching from `for (const r of regions) await persist(r)` to `Promise.allSettled(regions.map(persist))` preserves per-region dedup guarantees while removing the inter-region serialization.

## Acceptance Criteria

- [ ] All 8 regions persisted in parallel.
- [ ] Failed regions don't block other regions (use `Promise.allSettled`).
- [ ] Existing tests still pass.

## Work Log

## Resources

- PR #2940
- Spec: `docs/internal/pro-regional-intelligence-upgrade.md`
