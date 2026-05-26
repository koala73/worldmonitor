---
status: complete
priority: p2
issue_id: 196
tags: [code-review, digest-dedup, phase-a, cleanup, quality]
dependencies: []
---

# Orchestrator cleanup bundle (re-exports, materializeCluster, vetoWrapper, double-Jaccard, warn fields, mode validation)

## Problem Statement

Six independent but small `brief-dedup.mjs` orchestrator issues found by the reviewers — grouped because they're all <10 LOC each and one PR makes more sense than six.

### 1. Re-exports create import-graph ambiguity
`brief-dedup.mjs:312-317` re-exports `deduplicateStoriesJaccard`, `normalizeForEmbedding`, and `CACHE_TTL_SECONDS`. `normalizeForEmbedding` can now be pulled from both `brief-embedding.mjs` AND `brief-dedup.mjs`; the tools correctly pull from the source module but new callers can drift.

### 2. `materializeCluster` duplicates Jaccard's representative logic
`brief-dedup.mjs:107-117` and `brief-dedup-jaccard.mjs:90-98` independently sort members by `[currentScore DESC, mentionCount DESC]`, sum mentionCount, project `mergedHashes`. Same contract in two places.

### 3. `clusterWithEntityVeto` is a 6-line wrapper used once
`brief-dedup-embed.mjs:167-179` wraps `completeLinkCluster` with a pre-baked vetoFn. Called from exactly one site (`brief-dedup.mjs:261`). Inlining at the call site removes a function + export + indirection layer.

### 4. Shadow mode runs Jaccard twice
`brief-dedup.mjs:275` calls `jaccardClusterHashesFor(stories)` to derive cluster-hash arrays for the diff; line 295 calls `jaccard(stories)` again to produce the returned value. Both are Jaccard(stories) in original order — compute once, derive `mergedHashes` from the returned reps, return them directly.

### 5. `warn` log on fallback lacks `err.name` for filtering
`brief-dedup.mjs:303-306` emits `"[digest] dedup embed path failed, falling back to Jaccard: {msg}"`. Operators can't grep `reason=timeout` vs `reason=provider_5xx`. Add `err.name` / `err.status` to the structured log.

### 6. Invalid `DIGEST_DEDUP_MODE` silently falls to `'jaccard'`
`brief-dedup.mjs:52-53` — if someone sets `DIGEST_DEDUP_MODE=embbed` (typo), the orchestrator accepts it as jaccard with no warn. Operator expects embed mode, gets Jaccard. Emit a one-shot warn when the raw value is truthy but unrecognised.

## Findings
All six are convergent findings across kieran-ts, architecture, simplicity, and perf reviewers. Each is a <10 LOC change.

## Proposed Solutions

### Option 1 — single "orchestrator polish" commit covering all 6 (recommended)
One small diff per subsection; all test-covered by existing suites.

**Pros:** clear unit of work; one review.
**Cons:** touches 3 files.
**Effort:** Small
**Risk:** Low

### Option 2 — split into three commits
(a) duplication (re-exports + materializeCluster + vetoWrapper); (b) shadow double-Jaccard; (c) observability (warn fields + mode validation).

**Pros:** easier to revert one if something surprises.
**Cons:** more churn.
**Effort:** Small
**Risk:** Low

## Recommended Action
_To be filled during triage._

## Technical Details

Affected files:
- `scripts/lib/brief-dedup.mjs` — re-exports, materializeCluster, shadow double-run, warn log, mode validation
- `scripts/lib/brief-dedup-embed.mjs` — delete `clusterWithEntityVeto`
- `scripts/lib/brief-dedup-jaccard.mjs` — extract shared representative helper (for #2)

## Acceptance Criteria
- [ ] `brief-dedup.mjs` exports exactly `deduplicateStories` + `readOrchestratorConfig` + the types; no re-exports.
- [ ] One shared helper for representative selection; used by both Jaccard fallback and orchestrator materialization.
- [ ] `clusterWithEntityVeto` is deleted; orchestrator inlines the veto wiring.
- [ ] Shadow mode runs Jaccard exactly once per tick; disagreement diff is derived from that single run.
- [ ] Fallback warn line contains `reason={timeout|provider|other}` (or equivalent structured field).
- [ ] Unrecognised `DIGEST_DEDUP_MODE` value emits `warn` once per cron run with the raw value masked.
- [ ] All 64 dedup tests pass; add one new test per sub-fix.

## Work Log
_Empty — awaiting triage._

## Resources
- Review commit: `cdd7a124c`
- Reviewers: all 5 (kieran-typescript, security-sentinel, performance-oracle, architecture-strategist, code-simplicity-reviewer)
