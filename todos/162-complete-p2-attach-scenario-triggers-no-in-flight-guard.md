---
status: complete
priority: p2
issue_id: "162"
tags: [code-review, quality, supply-chain, reliability]
dependencies: []
---

# `attachScenarioTriggers` Has No In-Flight Guard — Concurrent Polling Possible

## Problem Statement
`SupplyChainPanel.attachScenarioTriggers()` launches a polling loop but has no guard against being called while a previous poll is still running. If the user clicks "Simulate Closure" a second time before the first job completes (e.g., after navigating away and back to the chokepoint), two polling loops run concurrently. Both can call `onScenarioActivate`, resulting in a race between two job results applying visual state in an undefined order.

## Findings
- **File:** `src/components/SupplyChainPanel.ts`
- `attachScenarioTriggers()` is called from the "Simulate Closure" button click handler
- No `isPolling` flag or AbortController checked before starting a new poll
- Existing guard: `if (!button.isConnected) break` only exits on DOM removal, not on second click
- Two concurrent polls can overlap and call `onScenarioActivate` with different results
- Identified by kieran-typescript-reviewer during PR #2910 review

## Proposed Solutions

### Option A: AbortController + in-flight flag (Recommended)
```ts
private scenarioPollController: AbortController | null = null;

private async attachScenarioTriggers(button: HTMLButtonElement, cp: Chokepoint): Promise<void> {
  // Cancel any in-flight poll
  this.scenarioPollController?.abort();
  this.scenarioPollController = new AbortController();
  const { signal } = this.scenarioPollController;

  // ... in the polling loop:
  if (signal.aborted || !button.isConnected) break;
  const statusResp = await fetch(`...`, { signal });
}
```
**Pros:** Clean cancellation, prevents concurrent polls, mirrors standard fetch abort patterns
**Cons:** Need to handle `AbortError` gracefully (not show error banner)
**Effort:** Small | **Risk:** Low

### Option B: Simple boolean in-flight flag
```ts
private isScenarioPolling = false;

if (this.isScenarioPolling) return;
this.isScenarioPolling = true;
try { /* poll */ } finally { this.isScenarioPolling = false; }
```
Blocks second trigger rather than cancelling first. Simpler but less responsive (user can't restart a stalled poll).
**Effort:** Small | **Risk:** None

## Recommended Action
_Apply Option A — AbortController for clean cancellation, matching the codebase's existing fetch patterns._

## Technical Details
- **Affected files:** `src/components/SupplyChainPanel.ts`
- Add `private scenarioPollController: AbortController | null = null`
- Handle `AbortError` in the catch block (do not show error banner on abort)

## Acceptance Criteria
- [ ] Second click aborts previous polling loop
- [ ] `AbortError` not surfaced to user as "Error — retry"
- [ ] `npm run typecheck` passes

## Work Log
- 2026-04-10: Identified by kieran-typescript-reviewer during PR #2910 review

## Resources
- PR: #2910
