---
status: pending
priority: p1
issue_id: "105"
tags: [code-review, seeder, redis, gold-standard]
---

# Seeder lock.skipped early return doesn't call extendExistingTtl — health shows STALE_SEED during Redis transient failure

## Problem Statement
`scripts/seed-hs2-chokepoint-exposure.mjs:123` — `if (lock.skipped) return` exits immediately without extending existing exposure key TTLs. Per the seeder gold standard (documented in project memory `feedback_seed_meta_skipped_path.md`), the skipped path must call `extendExistingTtl` on the existing keys before returning, so that health checks continue to see valid-if-stale data rather than reporting STALE_SEED.

## Findings
Line 123 in `scripts/seed-hs2-chokepoint-exposure.mjs` — bare `return` after `lock.skipped` check. The seed-meta key is never written in this path, so health checks that observe a missed cron window will incorrectly classify the seeder as STALE_SEED rather than degraded-but-alive.

## Proposed Solutions

### Option A: Mirror seed-energy-spine.mjs skipped path pattern (Recommended)
- After `lock.skipped` is true, call `extendExistingTtl` on all existing exposure keys
- Write seed-meta with `count=0` and `status='skipped'` before returning
- Matches the pattern from `seed-energy-spine.mjs`
- Effort: Small | Risk: Low

### Option B: Write seed-meta only (no TTL extension)
- Write seed-meta with `count=0, status='skipped'` without extending TTLs
- Prevents STALE_SEED in health but keys can still expire if multiple cron cycles are skipped
- Effort: Small | Risk: Medium

## Acceptance Criteria
- [ ] Under simulated Redis lock contention, health endpoint shows `degraded` (not `STALE_SEED`) status
- [ ] Existing exposure keys retain their TTL after a skipped cron run
- [ ] seed-meta is written with `count=0` in the skipped path

## Resources
- PR: #2870
