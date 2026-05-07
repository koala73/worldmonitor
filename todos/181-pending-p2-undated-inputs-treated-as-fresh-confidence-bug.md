---
status: pending
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


## Technical Details
`scripts/regional-snapshot/freshness.mjs:56-59` - current behavior returns fresh on missing timestamp.

## Acceptance Criteria
- [ ] Default for present-but-undated inputs is "stale" (not fresh)
- [ ] OR a warning is logged the first time an undated input is observed
- [ ] OR a counter tracks the proportion of undated inputs per cron run

## Work Log

## Resources
- PR #2940
- PR #2942
