---
status: pending
priority: p2
issue_id: 189
tags: [code-review, phase-0, regional-intelligence, error-handling, ui]
dependencies: []
---

# ForecastPanel refetchForRegion catches errors silently - UI shows stale data with no badge

## Problem Statement
`src/components/ForecastPanel.ts:326-336` has try/catch with empty catch. On failure, the panel shows the previous region's data (or stays empty) with no indication that the refetch failed. Comment says "same pattern as the initial load" but the initial load actually reports failures via the data badge.

## Findings
- Empty catch block swallows all errors
- User has no way to know the refetch failed
- Comment claims parity with initial load, but initial load sets the data badge on failure
- Stale data + no indicator is worse than a clear error state

## Proposed Solutions

### Option 1: Add setDataBadge('unavailable') in catch
Mirror the initial load's failure path.

**Pros:** Consistent UX; clear signal to user
**Cons:** Needs verification that initial load actually does this
**Effort:** Small
**Risk:** Low

### Option 2: Log errors via console.error
Sentry breadcrumbs will capture them; adds observability.

**Pros:** Dev visibility; triage signal
**Cons:** Doesn't improve user experience alone
**Effort:** Small
**Risk:** Low

### Option 3: Combined - badge + log
Do both: set badge to 'unavailable' AND log via console.error.

**Pros:** Full coverage (UX + observability)
**Cons:** None material
**Effort:** Small
**Risk:** Low

## Recommended Action


## Technical Details
File: `src/components/ForecastPanel.ts:326-336`
Pattern to mirror: the initial load's setDataBadge call on the same file.

## Acceptance Criteria
- [ ] On RPC failure, setDataBadge('unavailable') is called
- [ ] Errors are logged via console.error (Sentry breadcrumbs capture them)
- [ ] User sees a clear failed-to-load indicator

## Work Log

## Resources
- PR #2940
- PR #2942
