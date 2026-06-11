---
status: pending
priority: p2
issue_id: "069"
tags: [code-review, security, ssrf, analytical-frameworks]
dependencies: []
---

# `fetch-agentskills.ts` response fields `name`/`description` have no length cap

## Problem Statement
In `api/skills/fetch-agentskills.ts` lines 66-67, the `name` and `description` fields from the external agentskills.io response are passed through to the caller without any length limit. Only `instructions` has a 2000-char cap (at `analysis-framework-store.ts`'s `MAX_INSTRUCTIONS_LEN`). A malicious or compromised agentskills.io response could return arbitrarily long strings in `name` or `description`, potentially causing downstream issues (UI rendering, storage limits, log flooding).

## Proposed Solution
Add length caps before returning:
```ts
const MAX_NAME_LEN = 200;
const MAX_DESC_LEN = 500;
return Response.json({
  name: String(data.name ?? '').slice(0, MAX_NAME_LEN),
  description: String(data.description ?? '').slice(0, MAX_DESC_LEN),
  instructions: String(data.instructions ?? ''),
});
```

## Technical Details
- File: `api/skills/fetch-agentskills.ts:66-67`
- Effort: Trivial | Risk: Low

## Acceptance Criteria
- [ ] `name` field capped at ≤200 chars before returning
- [ ] `description` field capped at ≤500 chars before returning

## Work Log
- 2026-03-28: Identified by security-sentinel during PR #2386 review
