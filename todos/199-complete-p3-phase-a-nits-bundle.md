---
status: complete
priority: p3
issue_id: 199
tags: [code-review, digest-dedup, phase-a, nits]
dependencies: []
---

# Phase A nits bundle (constants bag, mocked-golden overlap, apiKey dep rename, tools/ convention, gazetteer JSON, unique-hash precondition)

## Problem Statement

Six P3 items across the reviewers. None of them block merge; several are "consider in Phase B/C".

### 1. `__constants` test-bag is redundant
`scripts/lib/brief-dedup-consts.mjs:64-74` exposes a frozen object used by `tests/brief-dedup-jaccard.test.mjs:27,33,37` to read three constants. A direct named import is identical and shorter. The bag's original purpose ("replace the regex-extraction harness") is already served by normal imports.

### 2. `brief-dedup-golden.test.mjs` (138 LOC) largely mirrors scenarios in `brief-dedup-embedding.test.mjs`
The mocked-embedder path tests with crafted vectors are structurally forced — they're testing the mock. The real value of "golden pairs" is the LIVE-embedder nightly workflow + `tests/fixtures/brief-dedup-golden-pairs.json`. Consider removing the mocked test file; keep the fixture + workflow.

### 3. `deps.apiKey` override in `brief-embedding.mjs:228` shares the shape with prod wiring
A future caller spreading unvalidated user data into `deps` could inject an attacker-controlled API key that goes to `openrouter.ai` in the `Authorization: Bearer` header. Currently unreachable. Rename to `deps._apiKey` or gate on a test-only `Symbol` to make misuse noisy.

### 4. `scripts/tools/` is a new top-level directory
No prior precedent in the repo; ops scripts have historically been `scripts/backfill-*.mjs`, `scripts/benchmark-*.mjs` at top level. A `tools/` subdir is defensible for these three related utilities but worth documenting in `AGENTS.md` ("anything not on the cron lives in tools/").

### 5. `entity-gazetteer.mjs` as two inline `Set`s
Fine for v1. For auditability and NER-pluggability consider promoting `LOCATION_GAZETTEER` / `COMMON_CAPITALIZED` to `scripts/shared/location-gazetteer.json` with a tiny loader. Non-code reviewers can diff entries; easier to publish to `shared/` if a future CJS consumer needs it.

### 6. `diffClustersByHash` assumes unique story hashes
`brief-dedup.mjs:126-148` builds hash→cluster-id maps. If two stories share a hash, the second silently overwrites the first. Safe today (upstream dedup guarantees uniqueness) but a JSDoc `@pre stories have unique .hash` would future-proof.

## Findings
All six are convergent or single-reviewer items. Each is independent.

## Proposed Solutions

### Option 1 — address as Phase B/C prep work (recommended)
Do #1 and #3 now (tiny renames / deletions), defer #2 and #5 until Phase B/C validates the feature is shipping, document #4 in AGENTS.md during the next cleanup pass, add #6 as a one-line JSDoc.

**Pros:** reflects the risk profile; doesn't churn Phase A for cosmetic wins.
**Cons:** leaves some nits on `main`.
**Effort:** Small for the now-items; negligible otherwise.
**Risk:** Low

### Option 2 — do everything now
Single "Phase A nits" commit.

**Pros:** closes all the follow-ups.
**Cons:** #2 and #5 touch enough surface that they should have their own PR.
**Effort:** Medium
**Risk:** Low

### Option 3 — defer all
Track for Phase B.

**Pros:** zero churn.
**Cons:** accumulates debt.
**Effort:** zero
**Risk:** Low

## Recommended Action
_To be filled during triage._

## Technical Details
- `scripts/lib/brief-dedup-consts.mjs:64-74` (#1)
- `tests/brief-dedup-golden.test.mjs` (#2, whole file)
- `scripts/lib/brief-embedding.mjs:228` (#3)
- `AGENTS.md` + `scripts/tools/*` (#4)
- `scripts/lib/entity-gazetteer.mjs` → `scripts/shared/location-gazetteer.json` (#5)
- `scripts/lib/brief-dedup.mjs:126-148` (#6 — one-line JSDoc)

## Acceptance Criteria
- [ ] (#1) `__constants` bag removed; jaccard test imports constants directly.
- [ ] (#3) `deps.apiKey` renamed to a less spreadable name.
- [ ] (#6) `diffClustersByHash` has an `@pre` JSDoc about unique hashes.
- [ ] (#2 / #4 / #5) captured as Phase B/C todos or deferred with rationale.

## Work Log
_Empty — awaiting triage._

## Resources
- Review commit: `cdd7a124c`
- Reviewers: code-simplicity, security-sentinel, architecture-strategist, kieran-typescript
