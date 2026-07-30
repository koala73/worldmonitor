---
status: pending
priority: p2
issue_id: 179
tags: [code-review, phase-0, regional-intelligence, performance, redis, cache-stampede]
dependencies: []
---

# getForecasts RPC handler lacks cachedFetchJson coalescing (cache stampede risk)

## Problem Statement

`server/worldmonitor/forecast/v1/get-forecasts.ts:17` calls `getCachedJson(REDIS_KEY)` directly. Per CLAUDE.md ("Cache Stampede: Use cachedFetchJson"), RPC handlers with shared cache should use `cachedFetchJson` to coalesce concurrent misses. With 8 region pills and a user clicking quickly, multiple concurrent edge function invocations could each miss the in-process cache and hit Upstash with the same key.

## Findings

- `server/worldmonitor/forecast/v1/get-forecasts.ts:17` — uses `getCachedJson` directly without `cachedFetchJson` wrapper.
- CLAUDE.md "Cache Stampede: Use cachedFetchJson (Critical Pattern)" — established rule for all RPC handlers with shared cache.

## Proposed Solutions

### Option 1: Wrap in cachedFetchJson

Wrap the read in `cachedFetchJson` with a 30-60s in-process TTL keyed by `forecast:predictions:v2`.

**Pros:** Matches project convention; concurrent identical requests share one Redis round-trip; documented pattern; minimal diff.
**Cons:** None significant.
**Effort:** Small.
**Risk:** Low.

## Recommended Action

Option 1. Separate from PR #2942 scope but highlighted by it — the forecast panel's region pills (see #178) multiply concurrent reads, making the stampede window measurably hit.

## Technical Details

`cachedFetchJson` (in `server/_shared/redis.ts`) coalesces concurrent cache misses via an in-process `Map<key, Promise>`. The first request issues the Redis GET; parallel requests await the same promise. When the promise resolves, all waiters receive the result without additional Redis traffic.

Per CLAUDE.md:
1. Wrap in try-catch for stale/backup fallback.
2. Await stale/backup cache writes (Edge runtimes may terminate isolate).

Cache key: `forecast:predictions:v2` (match the Redis key). In-process TTL: 30-60s is the canonical window used by other handlers in this directory.

## Acceptance Criteria

- [ ] `get-forecasts.ts` uses `cachedFetchJson` per the CLAUDE.md cache stampede rule.
- [ ] Concurrent identical RPC requests share a single in-flight Redis read.
- [ ] Stale/backup fallback path is exercised via try-catch.
- [ ] Test: 10 parallel identical RPC calls produce 1 Redis GET.

## Work Log

## Resources

- PR #2942
- Spec: `docs/internal/pro-regional-intelligence-upgrade.md`
- CLAUDE.md: "Cache Stampede: Use cachedFetchJson (Critical Pattern)"
