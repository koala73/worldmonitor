---
status: pending
priority: p3
issue_id: "054"
tags: [code-review, quality, analytical-frameworks]
dependencies: []
---

# `fetch-agentskills.ts` — dead rate-limiting stub with `void ip` is misleading

## Problem Statement
`api/skills/fetch-agentskills.ts` contains 5 lines that extract the client IP, comment that rate limiting should be implemented, and then `void ip` (discarding the value). This code implies rate limiting is in place when it isn't. It also leaks internal phasing language (`"not supported in phase 1"`) in what would be a user-facing error message. This is dead code that should either be implemented or removed.

## Findings
- **`api/skills/fetch-agentskills.ts:17-21`** — IP extraction + `void ip` placeholder
- **`api/skills/fetch-agentskills.ts:62`** — `"not supported in phase 1"` user-visible error string

## Proposed Solutions

### Option A: Remove the dead stub, add a TODO comment (Recommended)
```ts
// TODO: Add Vercel Firewall rate limit rule for /api/skills/fetch-agentskills
```
Remove the `void ip` block. Replace `"not supported in phase 1"` with `"not supported"`.
**Effort:** Trivial | **Risk:** Low

### Option B: Implement rate limiting via Vercel Firewall
Add a Vercel Firewall rule in the dashboard capping requests per IP per minute for the `/api/skills/` path. No code needed.
**Effort:** Small (dashboard config) | **Risk:** Low

## Technical Details
- File: `api/skills/fetch-agentskills.ts:17-21, 62`
- PR: koala73/worldmonitor#2380

## Acceptance Criteria
- [ ] No dead `void ip` block in the codebase
- [ ] No "phase 1" language in user-visible strings
- [ ] Either a Vercel Firewall rule documented or a clear TODO for future implementation

## Work Log
- 2026-03-27: Identified during PR #2380 review by code-simplicity-reviewer
