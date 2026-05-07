---
status: complete
priority: p1
issue_id: "153"
tags: [code-review, quality, supply-chain, reliability]
dependencies: []
---

# Missing `statusResp.ok` Guard in Scenario Polling Loop

## Problem Statement
In `SupplyChainPanel.ts:677`, the polling loop calls `statusResp.json()` without first checking `statusResp.ok`. A 429, 500, or network error causes `.json()` to throw or produce garbage, silently burning through all 30 iterations. The button ends up stuck on "Computing…" for 60 seconds before showing "Error — retry" with no useful signal.

## Findings
- **File:** `src/components/SupplyChainPanel.ts`, line 677
- **Code:**
  ```ts
  const statusResp = await fetch(`/api/scenario/v1/status?jobId=${encodeURIComponent(jobId)}`);
  const status = await statusResp.json() as { status: string; result?: ScenarioResult };
  ```
- No check on `statusResp.ok` before consuming body
- 30 × 2s = 60s of silent failure with no feedback to the user

## Proposed Solutions

### Option A: Guard before `.json()` (Recommended)
```ts
const statusResp = await fetch(`/api/scenario/v1/status?jobId=${encodeURIComponent(jobId)}`);
if (!statusResp.ok) throw new Error(`Status poll failed: ${statusResp.status}`);
const status = await statusResp.json() as { status: string; result?: ScenarioResult };
```
**Pros:** Fails fast on server error, exits loop immediately
**Cons:** None
**Effort:** Small | **Risk:** None

### Option B: Retry on non-fatal errors, throw on fatal
Skip 429/503, throw on 4xx. More complex, adds ~10 lines, probably not worth it for this use case.
**Effort:** Medium | **Risk:** Low

## Recommended Action
_Apply Option A — guard before `.json()`. One line._

## Technical Details
- **Affected files:** `src/components/SupplyChainPanel.ts`
- **Line:** 677

## Acceptance Criteria
- [ ] `statusResp.ok` checked before calling `.json()`
- [ ] Loop exits immediately (throws) on non-OK response
- [ ] Button shows "Error — retry" within one polling cycle on server error

## Work Log
- 2026-04-10: Identified by kieran-typescript-reviewer during PR #2910 review

## Resources
- PR: #2910
