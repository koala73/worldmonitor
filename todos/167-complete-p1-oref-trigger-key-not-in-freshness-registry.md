---
status: complete
priority: p1
issue_id: 167
tags: [code-review, phase-0, regional-intelligence, triggers, dead-code]
dependencies: []
---

# OREF cluster trigger reads Redis key not in freshness registry (silently always-dormant)

## Problem Statement
The `oref_cluster` trigger in `triggers.config.mjs:68-80` resolves the metric `oref:active_alerts_count` by reading `sources['intelligence:oref-alerts:v1']` in `trigger-evaluator.mjs:97`. But that key is NOT in `FRESHNESS_REGISTRY` (`scripts/regional-snapshot/freshness.mjs:16-32`) and therefore not in `ALL_INPUT_KEYS` consumed by `readAllInputs()` in the seed entry. The trigger always returns 0 from undefined data, fails the `value > 10` threshold, and is permanently dormant.

This is a silent dead trigger that ships as part of the Phase 0 trigger set but never fires. Same class of bug as `feedback_empty_data_ok_keys_bootstrap_blind_spot.md`.

## Findings
- `scripts/regional-snapshot/trigger-evaluator.mjs:95-99` reads `sources['intelligence:oref-alerts:v1']`.
- `scripts/regional-snapshot/freshness.mjs:16-32` does NOT include this key.
- `scripts/regional-snapshot/triggers.config.mjs:68-80` declares the `oref_cluster` trigger expecting this metric.
- Because the key is not in `ALL_INPUT_KEYS`, `readAllInputs()` never fetches it, `sources[...]` is undefined, metric resolves to 0, threshold never trips.

## Proposed Solutions

### Option 1: Wire the input
Add `intelligence:oref-alerts:v1` to `FRESHNESS_REGISTRY` with `maxAgeMin` matching the OREF relay cadence (~5 min).

**Pros:** OREF data is genuinely useful for MENA coercive pressure scoring. Minimal change, enables the trigger as designed.
**Cons:** Adds one more key to the input pipeline.
**Effort:** Small
**Risk:** Low

### Option 2: Remove the dead trigger
Delete the `oref_cluster` trigger from `triggers.config.mjs` until Phase 1 wires the input.

**Pros:** Fewer moving parts shipped in Phase 0.
**Cons:** Loses MENA signal; trigger has to be reintroduced later.
**Effort:** Small
**Risk:** Low

## Recommended Action
(leave blank for triage)

## Technical Details
- Affected files:
  - `scripts/regional-snapshot/freshness.mjs`
  - `scripts/regional-snapshot/trigger-evaluator.mjs`
  - `scripts/regional-snapshot/triggers.config.mjs`
- Components: regional snapshot trigger evaluation, freshness registry, OREF source wiring
- Related key: `intelligence:oref-alerts:v1`

## Acceptance Criteria
- [ ] `FRESHNESS_REGISTRY` includes `intelligence:oref-alerts:v1` (or the trigger is removed)
- [ ] Test added that verifies `oref_cluster` fires when `sources` contains a payload with >10 active alerts
- [ ] Phase 0 snapshot for MENA region includes `oref_cluster` in active or watching list when synthetic data is provided

## Work Log
(empty)

## Resources
- PR #2940
- Spec: docs/internal/pro-regional-intelligence-upgrade.md
- Related memory: `feedback_empty_data_ok_keys_bootstrap_blind_spot.md`
