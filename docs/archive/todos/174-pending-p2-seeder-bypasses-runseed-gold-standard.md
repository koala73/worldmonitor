---
status: pending
priority: p2
issue_id: 174
tags: [code-review, phase-0, regional-intelligence, seeder, redis, gold-standard]
dependencies: []
---

# Snapshot seeder bypasses runSeed gold-standard (no lock, no TTL extension, summary TTL only 2x)

## Problem Statement

`scripts/seed-regional-snapshots.mjs:167-230` reimplements its own `main()` instead of using `runSeed()` from `_seed-utils.mjs`. It loses several gold-standard guarantees per `feedback_seeder_gold_standard.md`:

1. **No distributed lock** via `acquireLockSafely` — two Railway container restarts could double-execute.
2. **`writeExtraKeyWithMeta` called UNCONDITIONALLY** at line 207 even when `persisted=0` — that overwrites a healthy seed-meta with `recordCount=0`.
3. **No `extendExistingTtl`** on transient Redis failures — a 20-minute outage surfaces as `STALE_SEED` even though good last-known snapshots exist.
4. **Summary key TTL is 12h** = 2x the 6h interval. Gold standard says 3x (18h+).

## Findings

- `scripts/seed-regional-snapshots.mjs:181` — no lock acquired before the work loop.
- `scripts/seed-regional-snapshots.mjs:207` — unconditional `writeExtraKeyWithMeta` call; runs even when 0 regions succeeded.
- `scripts/seed-regional-snapshots.mjs:206` — summary TTL of 12h (= 2x cron interval), should be ≥3x.
- `scripts/_seed-utils.mjs:606` — `runSeed` signature showing canonical lock + TTL-extension + empty-data-guard pattern.

## Proposed Solutions

### Option 1: Retrofit gold-standard guarantees directly

Acquire a lock keyed `regional-snapshots` at the start of `main()`; only call `writeExtraKeyWithMeta` when `persisted > 0`; bump summary TTL to 18h or 24h (3x); add `extendExistingTtl` on partial failure paths.

**Pros:** Surgical; doesn't fight the multi-key architecture; preserves existing per-region logic.
**Cons:** Still not using the shared `runSeed` harness, so future gold-standard updates need to be mirrored.
**Effort:** Medium.
**Risk:** Low-medium (lock contention edge cases).

### Option 2: Refactor to use runSeed() pattern entirely

Rewrite the seeder as a `runSeed()` consumer.

**Pros:** Full alignment with the rest of the fleet.
**Cons:** Doesn't fit the architecture — `runSeed` is built for "fetch+publish one canonical key" but this seeder writes 8 regional + 1 summary key. Would require extending `runSeed` itself.
**Effort:** Large.
**Risk:** Medium-high (changes shared utility).

## Recommended Action

Option 1. Retrofit lock, guard the meta write, bump TTL to 24h, add TTL extension on partial failure. Defer Option 2 until we have a second multi-key seeder that would justify extending `runSeed`.

## Technical Details

Gold standard pattern from `feedback_seeder_gold_standard.md`:
- TTL ≥ 3× cron interval (so a missed run still leaves data within `maxStaleMin`).
- Retry in 20 min on failure (prevents rapid re-attempt storms).
- `upstashExpire` on both failure paths (preserve existing good data during outages).
- Clear retry timer on success.
- Health `maxStaleMin = 2× interval` (alert only after 2 missed cycles).

The current seeder fails 1, 2, 3 above. The summary key at line 206 violates #1 with a 12h TTL against a 6h cron — a single missed run blows past `maxStaleMin`.

## Acceptance Criteria

- [ ] Distributed lock prevents double-execution across parallel Railway container restarts.
- [ ] Summary key TTL = 18h or 24h (≥3× cron interval).
- [ ] When all regions dedup-skipped, existing seed-meta is preserved (recordCount not overwritten with 0).
- [ ] Per-region failures trigger `extendExistingTtl` on the `:latest` key for that region.
- [ ] Health check still reports OK after a partial failure.

## Work Log

## Resources

- PR #2940
- Spec: `docs/internal/pro-regional-intelligence-upgrade.md`
- Feedback: `feedback_seeder_gold_standard.md`
