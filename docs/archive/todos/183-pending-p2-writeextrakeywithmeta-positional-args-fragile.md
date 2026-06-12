---
status: pending
priority: p2
issue_id: 183
tags: [code-review, phase-0, regional-intelligence, api-design, refactor]
dependencies: []
---

# writeExtraKeyWithMeta call site uses 6 positional args including ttl repeated twice

## Problem Statement
`seed-regional-snapshots.mjs:207-214` passes 6 positional args to `writeExtraKeyWithMeta`: `(canonicalKey, payload, ttlSec, persisted, metaKey, ttlSec)`. `ttlSec` appears in slots 3 and 6. A future refactor swapping slots 4/5 silently corrupts. The helper signature is pre-existing in `_seed-utils.mjs` but this is the most complex invocation in the repo.

## Findings
- Positional signature with duplicated value is a foot-gun
- 6-arg positional calls are hard to audit
- No test asserts which slot receives what

## Proposed Solutions

### Option 1: Wrapper helper in seed-regional-snapshots
Add a named-argument wrapper in this file only; leaves the shared helper signature alone.

**Pros:** Smallest change; isolates risk
**Cons:** Shared helper remains fragile for other callers
**Effort:** Small
**Risk:** Low

### Option 2: Refactor writeExtraKeyWithMeta to options-object signature
Change `_seed-utils.mjs` to accept `{ canonicalKey, payload, ttlSec, persisted, metaKey }`.

**Pros:** Fixes all current and future callers
**Cons:** Touches more files; needs audit of every call site
**Effort:** Medium
**Risk:** Low

## Recommended Action


## Technical Details
`scripts/seed-regional-snapshots.mjs:207-214` - the 6-arg call site.
`scripts/_seed-utils.mjs` - defines `writeExtraKeyWithMeta`.

## Acceptance Criteria
- [ ] File a follow-up issue to refactor writeExtraKeyWithMeta to options-object signature
- [ ] OR add a wrapper helper in seed-regional-snapshots that names the arguments

## Work Log

## Resources
- PR #2940
- PR #2942
