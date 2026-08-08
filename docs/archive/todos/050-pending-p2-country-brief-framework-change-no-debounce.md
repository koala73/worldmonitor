---
status: pending
priority: p2
issue_id: "050"
tags: [code-review, performance, analytical-frameworks]
dependencies: []
---

# `country-intel.ts` framework change fires full RPC immediately — no debounce, extra LLM cost

## Problem Statement
`country-intel.ts` subscribes to framework changes for the `'country-brief'` panel and immediately calls `openCountryBriefByCode()` on every change. `openCountryBriefByCode()` initiates a full LLM-backed country brief RPC. There is no debounce. If a user rapidly switches frameworks (common when exploring options), multiple RPC calls fire to the server. The `briefRequestToken` cancels stale renders but the first LLM call runs to completion and bills tokens even though its result is discarded.

## Findings
- **`src/app/country-intel.ts:72-78`** — subscription fires `openCountryBriefByCode()` immediately
- No debounce wrapper on the callback
- Under rapid switching: N framework changes = N LLM API calls = N × token cost
- Flagged by: performance-oracle

## Proposed Solutions

### Option A: 400ms debounce on the subscription callback (Recommended)
```ts
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
this.frameworkUnsubscribe = subscribeFrameworkChange('country-brief', () => {
  const page = this.ctx.countryBriefPage;
  if (!page?.isVisible()) return;
  const code = page.getCode();
  const name = page.getName() ?? code;
  if (!code || !name) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void this.openCountryBriefByCode(code, name), 400);
});
```
**Pros:** Coalesces rapid switches into one call, 400ms is imperceptible to deliberate selection | **Effort:** Small | **Risk:** Low

### Option B: Cancel the pending LLM call server-side (not just the render)
Pass an `AbortSignal` to the RPC and cancel it when a new framework change fires.
**Pros:** Saves server compute too | **Cons:** RPC client may not support AbortSignal in current implementation | **Effort:** Medium | **Risk:** Medium

## Technical Details
- File: `src/app/country-intel.ts`
- PR: koala73/worldmonitor#2380

## Acceptance Criteria
- [ ] Rapid framework switching triggers only one RPC call (after debounce settles)
- [ ] Single deliberate selection still triggers the RPC within ~400ms
- [ ] Debounce timer is cleared on panel destroy / unsubscribe

## Work Log
- 2026-03-27: Identified during PR #2380 review by performance-oracle
