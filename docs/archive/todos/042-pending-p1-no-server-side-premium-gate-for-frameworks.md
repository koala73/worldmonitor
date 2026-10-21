---
status: pending
priority: p1
issue_id: "042"
tags: [code-review, security, premium-gating, analytical-frameworks]
dependencies: []
---

# Missing server-side premium gate — free users can pass arbitrary `framework` text to LLM

## Problem Statement
The framework feature is premium-gated client-side via `hasPremiumAccess()` in `analysis-framework-store.ts`. However, neither `get-country-intel-brief.ts` nor `deduct-situation.ts` checks premium status on the server. A free user can craft a raw RPC request (or use the browser dev tools to bypass the locked `FrameworkSelector`) and pass any `framework` string directly to the API, getting framework-injected LLM responses without a PRO subscription. The client-side gate is trivially bypassable.

## Findings
- **`server/worldmonitor/intelligence/v1/get-country-intel-brief.ts`** — reads `req.framework`, truncates to 2000 chars, passes to `callLlm` as `systemAppend`. No entitlement check.
- **`server/worldmonitor/intelligence/v1/deduct-situation.ts`** — same pattern, no entitlement check.
- **`server/worldmonitor/news/v1/summarize-article.ts`** — reads `req.systemAppend`, no entitlement check.
- The gateway (`server/gateway.ts`) validates auth tokens but does not strip or block `framework`/`systemAppend` fields for free-tier callers.
- Flagged by: security-sentinel, architecture-strategist, learnings-researcher (worldmonitor-pro-panel-gating skill)

## Proposed Solutions

### Option A: Server-side entitlement check via session/JWT (Recommended)
Each RPC handler has access to the request context including the auth token. Check `isPremiumUser(req)` (however it's expressed server-side) and silently ignore `framework`/`systemAppend` if the caller is free-tier:
```ts
const frameworkRaw = isPremiumUser(ctx) && typeof req.framework === 'string'
  ? req.framework.slice(0, 2000)
  : '';
```
**Pros:** Server-enforced, cannot be bypassed client-side | **Effort:** Small | **Risk:** Low — framework is simply ignored for free users

### Option B: Gateway-level stripping
In `server/gateway.ts`, strip `framework` and `systemAppend` fields from the request body when the caller's entitlement is free-tier, before the handler runs.
**Pros:** Single enforcement point | **Cons:** Gateway must know about all field names across RPCs | **Effort:** Medium | **Risk:** Medium

### Option C: Accept as-is (NOT recommended)
Premium gate is UI-only. The feature degrades gracefully (free users just don't see the selector). Framework injection is a quality-of-life feature, not a billing-critical one.
**Cons:** Paywall bypass, revenue impact, inconsistent with other gated features | **Risk:** High (billing abuse)

## Technical Details
- Files: `server/worldmonitor/intelligence/v1/get-country-intel-brief.ts`, `server/worldmonitor/intelligence/v1/deduct-situation.ts`, `server/worldmonitor/news/v1/summarize-article.ts`
- PR: koala73/worldmonitor#2380
- Reference: worldmonitor-pro-panel-gating skill (4-layer checklist)

## Acceptance Criteria
- [ ] `get-country-intel-brief.ts` ignores `framework` field for non-premium callers
- [ ] `deduct-situation.ts` ignores `framework` field for non-premium callers
- [ ] `summarize-article.ts` ignores `systemAppend` field for non-premium callers
- [ ] Server-side gate cannot be bypassed by crafting raw RPC requests

## Work Log
- 2026-03-27: Identified during PR #2380 review by security-sentinel and architecture-strategist
