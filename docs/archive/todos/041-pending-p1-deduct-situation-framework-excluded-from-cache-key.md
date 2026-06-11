---
status: pending
priority: p1
issue_id: "041"
tags: [code-review, security, caching, analytical-frameworks]
dependencies: []
---

# `deduct-situation.ts` framework excluded from cache key — cross-user cache poisoning

## Problem Statement
`deduct-situation.ts` extracts the `framework` field and passes it to `callLlm` as `systemAppend`, but the Redis cache key does NOT include the framework. User A submits query X with no framework; result cached under key K. User B submits same query X with the PMESII-PT framework; gets key K hit and receives the frameworkless response. User B's framework is silently ignored. Meanwhile `get-country-intel-brief.ts` correctly hashes `frameworkRaw` into its cache key on line 40 — the inconsistency was introduced in this PR.

## Findings
- **`server/worldmonitor/intelligence/v1/deduct-situation.ts:29`** — cache key: `deduct:situation:v2:${sha256(query + '|' + geoContext)}` — framework absent
- **`server/worldmonitor/intelligence/v1/get-country-intel-brief.ts:38-40`** — correct pattern: `const frameworkHash = frameworkRaw ? (await sha256Hex(frameworkRaw)).slice(0, 8) : ''; const cacheKey = \`ci-sebuf:v3:...${frameworkHash ? ':' + frameworkHash : ''}\``
- Flagged independently by: kieran-typescript-reviewer, performance-oracle, code-simplicity-reviewer, agent-native-reviewer, architecture-strategist

## Proposed Solutions

### Option A: Mirror get-country-intel-brief.ts pattern (Recommended)
Add `frameworkHash` to the cache key, identical to `get-country-intel-brief.ts`:
```ts
const frameworkRaw = typeof req.framework === 'string' ? req.framework.slice(0, 2000) : '';
const frameworkHash = frameworkRaw ? (await sha256Hex(frameworkRaw)).slice(0, 8) : '';
const queryHash = (await sha256Hex(query.toLowerCase() + '|' + geoContext.toLowerCase())).slice(0, 16);
const cacheKey = `deduct:situation:v2:${queryHash}${frameworkHash ? ':' + frameworkHash : ''}`;
```
**Pros:** Consistent with existing pattern, one-line extension | **Effort:** Small | **Risk:** Low

### Option B: Bump cache key version to v3 and include framework
Same as A but bump version to `v3` to invalidate all existing deduction cache entries (avoids old frameworkless entries being served after deploy).
**Pros:** Clean slate for caches | **Cons:** All existing cached deductions invalidated — extra LLM cost on redeploy | **Effort:** Small | **Risk:** Low

## Technical Details
- File: `server/worldmonitor/intelligence/v1/deduct-situation.ts`
- PR: koala73/worldmonitor#2380
- Related: `server/worldmonitor/intelligence/v1/get-country-intel-brief.ts:38-40` (reference implementation)

## Acceptance Criteria
- [ ] `deduct-situation.ts` cache key includes a hash of `frameworkRaw` when non-empty
- [ ] Pattern mirrors `get-country-intel-brief.ts` frameworkHash approach
- [ ] Two requests with same query/geoContext but different frameworks produce different cache keys

## Work Log
- 2026-03-27: Identified during PR #2380 review by 5 independent agents
