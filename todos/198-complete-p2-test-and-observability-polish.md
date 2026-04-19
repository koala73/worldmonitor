---
status: complete
priority: p2
issue_id: 198
tags: [code-review, digest-dedup, phase-a, tests, observability]
dependencies: []
---

# Test + observability polish on the Phase A embed path

## Problem Statement

Two small quality items the reviewers flagged.

### 1. Embedding test Scenario 2 only asserts length, not content
`tests/brief-dedup-embedding.test.mjs:164` — `assert.equal(out.length, expected.length)`. A regression that changed Jaccard's merging shape but kept cluster count constant would slip through. The equivalent parity test in `tests/brief-dedup-jaccard.test.mjs:214-220` does a deep per-cluster compare (hash, mergedHashes, mentionCount). Match that pattern in the timeout/outage fallback scenarios.

### 2. Missing API-key path logs an exception every cron tick
If `DIGEST_DEDUP_MODE=embed` is set but `OPENROUTER_API_KEY` is empty (rotated, forgotten, or misconfigured after a Railway env edit), the orchestrator catches the `EmbeddingProviderError('OPENROUTER_API_KEY not configured')` and warns. That's correct behaviour for the all-or-nothing fallback, but it emits the same warn every tick — noisy in Sentry/log search.

Two options:
- Add a pre-flight in `readOrchestratorConfig` that checks the key and short-circuits to jaccard with a ONE-SHOT warn (per process).
- Add `reason=no_api_key` to the warn line so it's filterable.

Option (a) is lower-volume, option (b) is easier to implement and scoped to the overlapping P2 #196 subsection 5 ("warn line missing err.name"). Pick one.

## Findings
Both items surfaced from the kieran-ts reviewer.

## Proposed Solutions

### Option 1 — tighten both (recommended)
- Deep-equal the fallback clusters in Scenario 2 + Scenario 3 (same 6-line pattern as jaccard orchestrator test).
- Add a `reason=` field to the fallback warn (dovetails with #196.5). Skip the one-shot warn; the structured field is enough.

**Pros:** small, covered by existing harness.
**Cons:** none.
**Effort:** Small
**Risk:** Low

### Option 2 — one-shot warn per process
Module-scope `_apiKeyWarned` flag; log only on first miss.

**Pros:** quiet in log.
**Cons:** cross-process: Railway cron each tick forks a new node process, so every cron tick IS a first miss — the flag doesn't help. Conclusion: do NOT implement this; rely on `reason=` labels instead.
**Effort:** trivial
**Risk:** wasted — the flag doesn't persist across cron tick lifetimes.

## Recommended Action
_Option 1._

## Technical Details
- `tests/brief-dedup-embedding.test.mjs:164` (Scenario 2)
- `tests/brief-dedup-embedding.test.mjs:196` (Scenario 3)
- `scripts/lib/brief-dedup.mjs:303-306` (warn log)

## Acceptance Criteria
- [ ] Scenarios 2 and 3 deep-equal the output clusters against the Jaccard expected shape (hash, mergedHashes, mentionCount).
- [ ] Fallback warn line includes a filterable `reason=` field.

## Work Log
_Empty — awaiting triage._

## Resources
- Review commit: `cdd7a124c`
- Reviewer: kieran-typescript-reviewer
