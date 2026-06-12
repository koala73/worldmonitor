---
status: pending
priority: p1
issue_id: "045"
tags: [code-review, security, caching, analytical-frameworks]
dependencies: []
---

# `summarize-article.ts` — `systemAppend` excluded from cache key — cross-framework cache poisoning

## Problem Statement
`server/worldmonitor/news/v1/summarize-article.ts` reads `req.systemAppend` and appends it to the system message via `callLlm`. However, `getCacheKey(headlines, mode, sanitizedGeoContext, variant, lang)` does NOT incorporate `systemAppend`. Two requests with identical headlines but different frameworks share the same Redis cache entry — the first caller's framework-shaped analysis is served to all subsequent callers. This silently ignores the framework for any request that hits cache, undermining the entire feature for the news summarization path.

## Findings
- **`server/worldmonitor/news/v1/summarize-article.ts`** — cache key construction does not include `systemAppend`
- `getCacheKey(headlines, mode, sanitizedGeoContext, variant, lang)` — `systemAppend` is a 6th parameter that was not added
- Also flagged by code-simplicity-reviewer as a counterpart to the deduct-situation cache key bug
- Flagged by: code-simplicity-reviewer, multi-variant-site-data-isolation learnings

## Proposed Solutions

### Option A: Add systemAppend hash to getCacheKey (Recommended)
Extend `getCacheKey` to accept an optional `systemAppend` parameter and include its hash when non-empty:
```ts
// In _shared.ts
export function getCacheKey(headlines: string[], mode: string, geoContext: string, variant: string, lang: string, systemAppend?: string): string {
  const base = buildSummaryCacheKey(headlines, mode, geoContext, variant, lang);
  if (!systemAppend) return base;
  const appendHash = hashString(systemAppend).slice(0, 8); // sync FNV-1a is fine here
  return `${base}:fw${appendHash}`;
}
```
**Pros:** Consistent, minimal change | **Effort:** Small | **Risk:** Low

### Option B: Use separate cache namespace for framework-aware requests
Store framework-aware summaries under a different key prefix (e.g., `wm-sum-fw:v1:...`) to avoid mixing with the standard cache.
**Pros:** Clean separation, no risk of serving old cache entries after deploy | **Cons:** Two cache namespaces to manage | **Effort:** Small | **Risk:** Low

## Technical Details
- File: `server/worldmonitor/news/v1/summarize-article.ts`, `server/worldmonitor/news/v1/_shared.ts`
- PR: koala73/worldmonitor#2380

## Acceptance Criteria
- [ ] `getCacheKey` (or equivalent) includes a hash of `systemAppend` when non-empty
- [ ] Two summarize-article requests with same headlines but different `systemAppend` produce different cache keys
- [ ] Requests with `systemAppend = ''` continue to use the existing cache key (no invalidation)

## Work Log
- 2026-03-27: Identified during PR #2380 review by code-simplicity-reviewer
