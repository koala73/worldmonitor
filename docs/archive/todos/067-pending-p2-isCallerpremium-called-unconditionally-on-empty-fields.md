---
status: pending
priority: p2
issue_id: "067"
tags: [code-review, performance, analytical-frameworks]
dependencies: []
---

# `isCallerPremium` called unconditionally even when `framework`/`systemAppend` is empty

## Problem Statement
In all three handlers, `isCallerPremium(ctx.request)` is called at the top of every request before any field check. For the majority of requests where `framework`/`systemAppend` is absent or empty, the PRO check is wasted: the result is discarded because the field is empty anyway. For `summarize-article.ts`, the check runs even before the headlines validation guard at line 89.

On Vercel edge isolates, `validateBearerToken` triggers a `lookupPlanFromClerk` call that hits `api.clerk.com` when the JWT lacks a `plan` claim. The in-memory plan cache provides no protection across edge isolates (ephemeral per-region). At scale, empty-framework requests from standard session users generate unnecessary Clerk API calls and add 100-300ms serial latency before the LLM path on cold isolates. A Clerk 429 silently degrades PRO users to `free` (no error surfaced).

## Proposed Solution
Gate `isCallerPremium` behind a non-empty field check in each handler:

**`summarize-article.ts`:**
```ts
const rawAppend = typeof req.systemAppend === 'string' ? req.systemAppend : '';
const isPremium = rawAppend ? await isCallerPremium(ctx.request) : false;
```

**`deduct-situation.ts` and `get-country-intel-brief.ts`:**
```ts
const frameworkRaw = typeof req.framework === 'string' ? req.framework.slice(0, 2000) : '';
const isPremium = frameworkRaw ? await isCallerPremium(ctx.request) : false;
```

## Technical Details
- Files: `server/worldmonitor/news/v1/summarize-article.ts:42`, `server/worldmonitor/intelligence/v1/deduct-situation.ts:26`, `server/worldmonitor/intelligence/v1/get-country-intel-brief.ts`
- Effort: Small | Risk: Low

## Acceptance Criteria
- [ ] `isCallerPremium` is not called when the relevant field is absent/empty
- [ ] Requests without `framework`/`systemAppend` have identical behavior before and after

## Work Log
- 2026-03-28: Identified by performance-oracle during PR #2386 review
