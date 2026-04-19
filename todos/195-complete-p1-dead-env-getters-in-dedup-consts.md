---
status: complete
priority: p1
issue_id: 195
tags: [code-review, digest-dedup, phase-a, dead-code, yagni]
dependencies: []
---

# Dead env-getter API in brief-dedup-consts.mjs

## Problem Statement

`scripts/lib/brief-dedup-consts.mjs:37-58` exports five env-reader functions:
- `getMode()`
- `isRemoteEmbedEnabled()`
- `isEntityVetoEnabled()`
- `getCosineThreshold()`
- `getWallClockMs()`

None of them are imported by any other file (`grep` across `scripts/`, `server/`, `api/`, `tests/` returns zero hits). The orchestrator (`scripts/lib/brief-dedup.mjs:51-70`) reimplements every single one inline in `readOrchestratorConfig`. Flagged convergently by the simplicity + architecture + kieran-typescript reviewers.

Two parallel parsers for the same five env vars is the classic "one will drift" setup. And the consts module's own header comment claims it's "Pure data, no network" — env readers violate that boundary.

## Findings
- `brief-dedup-consts.mjs:36-58`: 22 LOC of unreachable code.
- `brief-dedup.mjs:51-70`: `readOrchestratorConfig` is the only real env-reader.
- No drift risk today (no callers), but guaranteed drift the first time someone adds a knob to one path and forgets the other.

## Proposed Solutions

### Option 1 — delete the dead getters (recommended)
Remove `getMode`, `isRemoteEmbedEnabled`, `isEntityVetoEnabled`, `getCosineThreshold`, `getWallClockMs` from consts. Leave consts as pure data + the `__constants` bag.

**Pros:** removes 22 LOC of unreachable code; matches the module's stated purpose.
**Cons:** none.
**Effort:** Small
**Risk:** Zero (no callers).

### Option 2 — delete the inline `readOrchestratorConfig`, have it call the getters
Keep the consts-module getters, wire `readOrchestratorConfig` to compose them.

**Pros:** one env-parse implementation.
**Cons:** muddies consts; every call now does 5 separate env reads instead of one pass; the module-init vs per-call semantics get surprising.
**Effort:** Small
**Risk:** Low

### Option 3 — ship as-is, add a TODO comment
Flag for Phase B cleanup.

**Pros:** zero churn now.
**Cons:** ships known dead code.
**Effort:** Tiny
**Risk:** Low

## Recommended Action
_Option 1. Deleting a dead surface that nothing imports is the safest change._

## Technical Details
- Delete lines 36-58 of `scripts/lib/brief-dedup-consts.mjs`.
- Keep the static constants + `__constants` bag.
- No test changes required.

## Acceptance Criteria
- [ ] `scripts/lib/brief-dedup-consts.mjs` exports only pure constants + the `__constants` bag.
- [ ] `grep -r "getMode\b\|isRemoteEmbedEnabled\b\|isEntityVetoEnabled\b\|getCosineThreshold\b\|getWallClockMs\b"` finds 0 hits outside the orchestrator's inline body.
- [ ] All 64 dedup tests still green.

## Work Log
_Empty — awaiting triage._

## Resources
- Review commit: `cdd7a124c`
- Reviewers: code-simplicity-reviewer, architecture-strategist, kieran-typescript-reviewer
