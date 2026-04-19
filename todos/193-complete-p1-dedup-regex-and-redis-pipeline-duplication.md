---
status: complete
priority: p1
issue_id: 193
tags: [code-review, digest-dedup, phase-a, maintenance, dry]
dependencies: []
---

# Duplicated regex + duplicated Redis pipeline helper in digest-dedup Phase A

## Problem Statement

Two convergent duplication findings from the Phase A review (commit `cdd7a124c`) — both are silent-divergence risks because the unit tests cover each module in isolation.

1. **`stripSourceSuffix` regex appears verbatim in TWO files.**
   - `scripts/lib/brief-embedding.mjs:60-64` inside `normalizeForEmbedding`
   - `scripts/lib/brief-dedup-jaccard.mjs:32-36` as the exported `stripSourceSuffix`
   - Adding a new outlet (e.g. `Bloomberg`) to one and not the other means the veto/embed input and the Jaccard fallback input quietly drift. The plan's "normalization contract" explicitly calls out that these MUST agree.

2. **`defaultRedisPipeline` reimplemented in TWO new files.**
   - `scripts/lib/brief-dedup.mjs:74-94`
   - `scripts/lib/brief-embedding.mjs:77-97`
   - The repo already exports a canonical `redisPipeline()` from `api/_upstash-json.js:88` (imported by `seed-digest-notifications.mjs:32`). The new lib/ modules avoid importing from `api/` on purpose — but the existing `scripts/lib/` convention is to share via `scripts/lib/_*.mjs` helpers.

## Findings

- **Embedding regex collision**: `brief-embedding.mjs:60` and `brief-dedup-jaccard.mjs:33` keep the same outlet allow-list in two places.
- **Pipeline helper trio**: three copies of essentially the same 20-line `fetch('{url}/pipeline', …)` exist (the two above + the canonical one). Any fix to timeout / User-Agent / error shape has to touch all three.

## Proposed Solutions

### Option 1 — consolidate into brief-dedup-consts.mjs (lightest)
Move `stripSourceSuffix` + its outlet list into `brief-dedup-consts.mjs` as the source of truth. Have both `brief-embedding.mjs` and `brief-dedup-jaccard.mjs` import from there. Extract `defaultRedisPipeline` into `scripts/lib/_upstash-pipeline.mjs`.

**Pros:** single-sourced, small diff.
**Cons:** mixes data + function in consts (plan called consts "pure data"); may need a `scripts/lib/_wire-suffixes.mjs` instead.
**Effort:** Small
**Risk:** Low

### Option 2 — dedicated shared-helpers module
Add `scripts/lib/_dedup-shared.mjs` exporting `stripSourceSuffix`, `defaultRedisPipeline`, `normalizeForEmbedding` (which currently calls stripSourceSuffix inline).

**Pros:** cleaner separation.
**Cons:** another file.
**Effort:** Small
**Risk:** Low

### Option 3 — defer to a follow-up (not recommended)
Ship Phase A as-is; clean up in Phase B.

**Pros:** ship faster.
**Cons:** two independent outlet lists on `main` makes the first production drift-incident hard to diagnose.
**Effort:** zero now
**Risk:** Medium — divergence is silent.

## Recommended Action
_To be filled during triage._

## Technical Details

Affected files:
- `scripts/lib/brief-embedding.mjs`
- `scripts/lib/brief-dedup-jaccard.mjs`
- `scripts/lib/brief-dedup.mjs`
- `scripts/lib/brief-dedup-consts.mjs`
- `api/_upstash-json.js` (canonical `redisPipeline`)

No schema or DB changes.

## Acceptance Criteria
- [ ] `stripSourceSuffix` regex exists in exactly ONE place; both consumer sites import from there.
- [ ] `defaultRedisPipeline` (or equivalent) exists in exactly ONE place within the new modules.
- [ ] Regression test asserts `normalizeForEmbedding("Foo - Reuters") === "foo"` and `normalizeForEmbedding` uses the same outlet list the Jaccard path uses (same-file import, guaranteed).
- [ ] `npm run test:data` still 5825/5825.

## Work Log
_Empty — awaiting triage._

## Resources
- Review commit: `cdd7a124c`
- Plan: `docs/plans/2026-04-19-001-feat-embedding-based-story-dedup-plan.md`
- Reviewers: kieran-typescript-reviewer, security-sentinel, code-simplicity-reviewer, architecture-strategist
