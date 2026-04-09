---
status: pending
priority: p1
issue_id: "103"
tags: [code-review, security, pro-gate, cdn]
---

# get-country-chokepoint-index missing from PREMIUM_RPC_PATHS — CDN serves PRO data to free users

## Problem Statement
`get-country-chokepoint-index` is absent from `PREMIUM_RPC_PATHS` in `server/shared/premium-paths.ts`. The `isPremium` flag is therefore `false`, causing `CDN-Cache-Control: public, s-maxage=900` to be set. A PRO user's full exposures response can be cached by Vercel CDN and served to a free user who hits the same iso2+hs2 pair before the edge cache expires.

## Findings
`server/gateway.ts` — `isPremium` check references `PREMIUM_RPC_PATHS`; path `/api/supply-chain/v1/get-country-chokepoint-index` is absent from that set.

## Proposed Solutions

### Option A: Add path to PREMIUM_RPC_PATHS (Recommended)
- Add `'/api/supply-chain/v1/get-country-chokepoint-index'` to `PREMIUM_RPC_PATHS` in `server/shared/premium-paths.ts` (1 line)
- Sets `isPremium=true` → `cdnCache=null` → no CDN caching of PRO responses
- Effort: Small | Risk: Low

### Option B: Add per-handler CDN override
- In the handler itself, explicitly set `CDN-Cache-Control: no-store` regardless of `isPremium`
- Effort: Small | Risk: Low (but diverges from the shared pattern)

## Acceptance Criteria
- [ ] `PREMIUM_RPC_PATHS` includes `/api/supply-chain/v1/get-country-chokepoint-index`
- [ ] After fix, `CDN-Cache-Control` header is absent or `no-store` on this endpoint
- [ ] PRO response for iso2+hs2 pair is never cached at the Vercel edge

## Resources
- PR: #2870
