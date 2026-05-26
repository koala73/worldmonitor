---
status: complete
priority: p1
issue_id: 168
tags: [code-review, phase-0, regional-intelligence, freshness, dead-code]
dependencies: []
---

# Four freshness registry keys have no compute consumer (zombie keys drag down confidence score)

## Problem Statement
`scripts/regional-snapshot/freshness.mjs:16-32` lists four keys that the seed script reads on every run but no compute module ever consumes via `sources['...']`:
1. `supply_chain:shipping_stress:v1`
2. `energy:chokepoint-flows:v1`
3. `intelligence:advisories-bootstrap:v2`
4. `market:commodities-bootstrap:v1`

These keys waste a Redis pipeline GET each run, pollute `missing_inputs` when absent, and drag down `snapshot_confidence` for no reason. They also create the false impression that the compute modules consume them, misleading Phase 1 engineers who add new axes.

## Findings
- Verified via grep for each key string across `scripts/regional-snapshot/*.mjs`: zero consumers.
- The keys appear only in `freshness.mjs`.
- Each run still pipelines a GET for these keys (wasted Redis round-trip bytes).
- When any of them is missing, `snapshot_confidence` drops and `missing_inputs` grows without the compute pipeline ever having needed the data.

## Proposed Solutions

### Option 1: Prune to real consumers
Remove all 4 keys from `FRESHNESS_REGISTRY` until they have a real consumer.

**Pros:** Eliminates wasted GETs, prevents confidence-score false negatives, prevents engineer confusion.
**Cons:** Keys must be re-added when genuinely wired.
**Effort:** Small
**Risk:** Low

### Option 2: Wire each into a compute module
Wire each into a specific compute module (e.g., `shipping_stress` into a new transmission enrichment, `advisories` into mobility).

**Pros:** Actually uses the signals that are being fetched.
**Cons:** Large cross-cutting work; out of Phase 0 scope.
**Effort:** Medium per key (4 × Medium)
**Risk:** Medium

## Recommended Action
(leave blank for triage)

## Technical Details
- Affected file: `scripts/regional-snapshot/freshness.mjs`
- Components: freshness registry, snapshot confidence computation, missing_inputs reporting
- Zombie keys:
  - `supply_chain:shipping_stress:v1`
  - `energy:chokepoint-flows:v1`
  - `intelligence:advisories-bootstrap:v2`
  - `market:commodities-bootstrap:v1`

## Acceptance Criteria
- [ ] `FRESHNESS_REGISTRY` has only the keys that compute modules actually read
- [ ] `snapshot_confidence` reaches 1.0 when all remaining keys are present
- [ ] Test added that asserts every key in `FRESHNESS_REGISTRY` appears in at least one `sources['...']` reference (static analysis or convention)

## Work Log
(empty)

## Resources
- PR #2940
- Spec: docs/internal/pro-regional-intelligence-upgrade.md
