---
status: pending
priority: p2
issue_id: "055"
tags: [code-review, reliability, seeding, social-velocity, ttl, pr-2375]
dependencies: []
---

## Problem Statement

The `seedSocialVelocity` loop in `scripts/ais-relay.cjs` seeds with a TTL of 1800 seconds (30 minutes) and runs on a 10-minute interval, giving a TTL ratio of exactly 3×. The seed gold standard (MEMORY.md) requires TTL≥3×interval, so this is technically compliant — but it is at the minimum acceptable boundary. Any seed delay, relay restart, or deployment gap longer than 30 minutes will cause the key to expire before the next successful seed, serving stale data to users. A TTL of 2700s (45 min, 4.5× interval) would provide a meaningful safety margin.

## Findings

- **File:** `scripts/ais-relay.cjs` — `seedSocialVelocity`: TTL = 1800s, interval = 10min (600s), ratio = 3.0×
- **Gold standard:** TTL≥3×interval — current value is exactly at the floor with no margin
- **Contrast:** `seedShippingStress` uses TTL = 3600s, interval = 15min (900s), ratio = 4.0× (healthy margin)
- **Risk scenario:** If relay is restarted during a deployment (takes 2-3 min), two consecutive seed failures could exhaust the 30min TTL window

## Proposed Solutions

**Option A: Increase TTL to 2700s (Recommended)**

Change `socialVelocity` Redis TTL from 1800 to 2700 seconds (4.5× interval). Provides ~15min safety buffer for seed delays.

- **Effort:** Trivial (change one number)
- **Risk:** None — slightly older data shown at most (45min vs 30min max age)

**Option B: Increase interval to match (keep 3× ratio but with more room)**

Keep 1800s TTL but reduce interval to 8min. Increases Reddit API call frequency.

- **Effort:** Trivial
- **Risk:** Low — more frequent Reddit calls, slightly higher rate-limit risk

## Acceptance Criteria

- [ ] `socialVelocity` Redis TTL ≥ 4× seed interval (2400s minimum, 2700s recommended)
- [ ] `maxStaleMin` in health.js updated to 2-3× interval (20-30min) if applicable

## Work Log

- 2026-03-27: Identified by code-review agents during PR #2375 review. Borderline compliance with gold standard.
