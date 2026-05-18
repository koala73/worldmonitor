---
status: complete
priority: p2
issue_id: 181
tags: [code-review, phase-0, regional-intelligence, freshness, confidence]
dependencies: []
---

# Present-but-undated inputs treated as fresh - inflates snapshot_confidence on stale data

## Problem Statement
`scripts/regional-snapshot/freshness.mjs:56-59` returns "fresh" when an input payload is present but has no extractable timestamp. This is the wrong default for a confidence-scoring system. If an upstream seeder crashes and leaves an old payload with no timestamp, the snapshot will silently score it as fresh and produce high-confidence snapshots from stale data.

## Findings
- Freshness evaluation defaults to "fresh" for undated-but-present inputs
- snapshot_confidence depends on input freshness
- No observability on how often inputs arrive undated
- Upstream seeder crash → stale payload with missing timestamp → scored fresh

## Proposed Solutions

### Option 1: Flip default to stale
Return "stale" when a payload is present but undated.

**Pros:** Safer default; forces timestamp discipline upstream
**Cons:** May initially flag legitimate inputs as stale if some seeders never emit timestamps
**Effort:** Small
**Risk:** Low

### Option 2: Log a warning on first undated input per run
Keep "fresh" default but emit a warning.

**Pros:** Visibility without behavior change
**Cons:** Doesn't solve the underlying confidence inflation
**Effort:** Small
**Risk:** Low

### Option 3: Metric/counter for undated proportion
Track `undated_inputs / total_inputs` per cron run and surface in health.

**Pros:** Data-driven signal
**Cons:** Requires additional wiring; still doesn't fix the default
**Effort:** Small
**Risk:** Low

## Recommended Action
Option 1 — flip the default to stale. Safest choice for a confidence score: a value that cannot be proven fresh should not inflate the confidence number that downstream consumers rely on.

## Technical Details
`scripts/regional-snapshot/freshness.mjs:classifyInputs()` — undated branch previously pushed to `fresh[]`, now pushes to `stale[]`. Resolved alongside the sibling defect in `snapshot-meta.mjs` (hardcoded `valid_until = now + 6h` ignored per-input `maxAgeMin`).

## Acceptance Criteria
- [x] Default for present-but-undated inputs is "stale" (not fresh)
- [x] Tests in `tests/regional-snapshot.test.mjs` + `tests/regional-snapshot-mobility.test.mjs` cover the new default

## Work Log
- 2026-05-18: Fixed in PR for #3728. Flipped undated default to stale in `classifyInputs`. Pre-existing mobility test that asserted "undated + missing meta → fresh" was updated to assert the new "→ stale" behavior. Added `buildPreMeta treats present-but-undated inputs as stale` test in `tests/regional-snapshot.test.mjs`. Sibling fix (`valid_until` derivation) shipped in the same PR.

## Resources
- PR #2940 (origin)
- PR #2942
- Issue #3728 (resolution)
