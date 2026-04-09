---
status: pending
priority: p1
issue_id: "106"
tags: [code-review, seeder, redis, gold-standard]
---

# Seeder data TTL is 1x cron interval — keys expire at the next cron boundary with no buffer

## Problem Statement
`scripts/seed-hs2-chokepoint-exposure.mjs:27` — `TTL_SECONDS = 86400` (24h). The cron runs daily (24h interval). TTL = 1x interval means keys expire exactly when the next cron run is due. Any single missed or delayed cron run causes all 130 country exposure keys to expire before fresh data is written. The seeder gold standard requires TTL >= 2x the cron interval to survive one missed cycle.

## Findings
`TTL_SECONDS = 86400` (line 27) with a daily cron schedule. `seed-energy-spine.mjs` uses `SPINE_TTL_SECONDS = 172800` (48h) as the correct reference implementation.

## Proposed Solutions

### Option A: Change TTL_SECONDS to 172800 (Recommended)
- Set `TTL_SECONDS = 172800` (48h = 2x the 24h cron interval)
- Matches the pattern from `seed-energy-spine.mjs`
- One cron miss no longer causes all 130 country exposure keys to expire
- Effort: Small | Risk: Low

### Option B: Change TTL_SECONDS to 129600 (1.5x interval)
- Set `TTL_SECONDS = 129600` (36h = 1.5x interval)
- Provides some buffer but does not fully survive a missed cron cycle
- Effort: Small | Risk: Medium

## Acceptance Criteria
- [ ] `TTL_SECONDS >= 172800` in `seed-hs2-chokepoint-exposure.mjs`
- [ ] `health.js` `maxStaleMin` value remains valid (must be <= TTL in minutes)
- [ ] After one simulated missed cron run, exposure keys are still present in Redis with positive TTL

## Resources
- PR: #2870
