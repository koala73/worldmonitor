---
status: pending
priority: p1
issue_id: "107"
tags: [code-review, redis, cache-keys, architecture]
---

# CHOKEPOINT_EXPOSURE_SEED_META_KEY constant has wrong value — future consumers will read an empty key

## Problem Statement
`server/_shared/cache-keys.ts:72` exports `CHOKEPOINT_EXPOSURE_SEED_META_KEY = 'supply-chain:exposure:seed-meta:v1'`. The seeder writes to `'seed-meta:supply_chain:chokepoint-exposure'` (different namespace, hyphens vs underscores). The constant is orphaned (zero usage in codebase). If any future code imports it to check seeder health, it will silently read a nonexistent Redis key and conclude the seeder is in an unknown state.

## Findings
`cache-keys.ts:72` — exported constant value does not match the key the seeder actually writes. Seeder `META_KEY` on line 20 of `seed-hs2-chokepoint-exposure.mjs` has the real value `'seed-meta:supply_chain:chokepoint-exposure'`. Current grep confirms zero consumers of `CHOKEPOINT_EXPOSURE_SEED_META_KEY`.

## Proposed Solutions

### Option A: Delete the orphaned constant (Recommended)
- Remove `CHOKEPOINT_EXPOSURE_SEED_META_KEY` from `server/_shared/cache-keys.ts` (it has no consumers)
- Use `META_KEY` inside the seeder directly; `health.js` already references the correct string literal
- Eliminates the silent wrong-key trap before any consumer is added
- Effort: Small | Risk: Low

### Option B: Correct the constant value and add a comment
- Change the value to `'seed-meta:supply_chain:chokepoint-exposure'` to match the seeder
- Add a comment noting it is reserved for future health check use
- Effort: Small | Risk: Low (but leaves an unused export)

## Acceptance Criteria
- [ ] No orphaned constant with wrong value exists in `cache-keys.ts`
- [ ] `grep` confirms the key string used in `health.js` matches what the seeder writes
- [ ] TypeScript compilation passes after removal

## Resources
- PR: #2870
