---
status: pending
priority: p1
issue_id: "104"
tags: [code-review, security, redis, input-validation]
---

# Unvalidated iso2 and hs2 params used as Redis cache key segments — cache pollution risk

## Problem Statement
`server/worldmonitor/supply-chain/v1/get-country-chokepoint-index.ts` uses `req.iso2` and `req.hs2` directly as segments of the Redis cache key with no format validation. An attacker can pass arbitrary strings (e.g. `US/../something`, `*`, or very long strings), generating unbounded distinct cache entries and polluting Redis. The seeder already validates `k.length === 2` before writing; the handler must apply the same constraint.

## Findings
`get-country-chokepoint-index.ts:68-69` — `CHOKEPOINT_EXPOSURE_KEY(req.iso2, hs2)` called with no prior validation of `req.iso2` or `hs2` format.

## Proposed Solutions

### Option A: Add format guards before cache key construction (Recommended)
- Add `if (!/^[A-Z]{2}$/.test(req.iso2)) return emptyResponse(req.iso2, hs2);` before cache key construction
- Add `if (!/^\d{1,4}$/.test(hs2)) hs2 = '27';` to fall back to the default HS2 chapter
- Mirrors the `k.length === 2` guard already present in the seeder
- Effort: Small | Risk: Low

### Option B: Sanitize at the RPC request schema level
- Add a Zod/joi schema to the handler's request validation layer that enforces ISO2 and numeric HS2 formats upstream
- Effort: Medium | Risk: Low

## Acceptance Criteria
- [ ] Handler rejects (returns empty response) for non-uppercase-2-letter `iso2` values
- [ ] Handler rejects or coerces invalid `hs2` values
- [ ] No garbage/arbitrary keys appear in Redis under the exposure namespace
- [ ] Existing valid requests (e.g. `iso2=US&hs2=27`) continue to work correctly

## Resources
- PR: #2870
