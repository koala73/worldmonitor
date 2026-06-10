---
status: pending
priority: p3
issue_id: 191
tags: [code-review, phase-0, regional-intelligence, cleanup, helpers]
dependencies: []
---

# Helper, freshness, and config cleanups (round helper duplication, num() over-coercion, generateSnapshotId entropy, matchesHorizon regex, getRegionCountries scan)

## Problem Statement
Several minor cleanups across helpers and config:

1. `_helpers.mjs:num()` uses `parseFloat` for strings, accepts `"42abc"` as `42`. Just use `Number(value)`.
2. `_helpers.mjs:clip()` checks `Number.isNaN` AND `!Number.isFinite` - the latter handles NaN.
3. `_helpers.mjs:generateSnapshotId()` uses `Math.random` (not CSPRNG). Use `crypto.randomUUID()` instead. Comment claims "UUID v7-ish" - it's not.
4. `round()` helper duplicated in 3+ modules (balance-vector, actor-scoring, scenario-builder, snapshot-meta). Move to `_helpers.mjs`.
5. `scenario-builder.mjs:matchesHorizon()` regex has duplicate alternatives (`/h24|24h|day|24h/`).
6. `geography.js:getRegionCountries()` does `Object.entries` scan per call. Precompute `COUNTRIES_BY_REGION` at module load.
7. `balance-vector.mjs:cVessel = 0` hardcoded with 0.30 weight - dead weight that caps `coercive_pressure` at 0.70, making `escalation_ladder` regime structurally unreachable.
8. `_helpers.mjs:percentile()` doesn't clamp `p` to `[0,100]`.
9. `triggers.config.mjs:russia_naval_buildup` uses `theater:eastern_europe:...` (snake_case) but other theater IDs use kebab-case (`eastern-europe`).
10. Test comment at `tests/regional-snapshot.test.mjs:429` has trailing "let's check actual output" exploration text.

## Findings
- Batch of minor cleanups, each independently safe
- #7 is structurally important: `cVessel = 0` forces coercive_pressure below the threshold that would trigger escalation_ladder regime - Phase 0 can never produce that regime even on extreme input
- #9 creates ID drift that may break theater lookups silently
- Others are quality-of-life but reduce bug surface

## Proposed Solutions

### Option 1: Do all 10 in one PR
Small and mechanical; review them together.

**Pros:** Single follow-up eliminates a category of debt
**Cons:** Mix of concerns in one change
**Effort:** Small (each item)
**Risk:** Low

### Option 2: Split into 3 PRs
(a) helper fixes (num/clip/generateSnapshotId/round/percentile), (b) perf+config (getRegionCountries/matchesHorizon/triggers.config/test comment), (c) cVessel renormalization.

**Pros:** Cleaner history; smaller blast radius per change
**Cons:** More PR overhead
**Effort:** Small
**Risk:** Low

## Recommended Action


## Technical Details
Files touched:
- `scripts/regional-snapshot/_helpers.mjs` - num, clip, generateSnapshotId, round, percentile
- `scripts/regional-snapshot/balance-vector.mjs` - cVessel weight, duplicated round
- `scripts/regional-snapshot/actor-scoring.mjs` - duplicated round
- `scripts/regional-snapshot/scenario-builder.mjs` - duplicated round, matchesHorizon regex
- `scripts/regional-snapshot/snapshot-meta.mjs` - duplicated round
- `shared/geography.js` - getRegionCountries scan
- `scripts/regional-snapshot/triggers.config.mjs` - russia_naval_buildup theater ID
- `tests/regional-snapshot.test.mjs:429` - stray comment

For #7: renormalize the `coercive_pressure` formula so that with `cVessel` stubbed at 0 the remaining weights sum to 1.0 (or drop the cVessel term entirely until Phase 1 provides data).

## Acceptance Criteria
- [ ] num() drops parseFloat branch (use Number)
- [ ] clip() drops redundant isNaN check
- [ ] generateSnapshotId uses crypto.randomUUID
- [ ] round() centralized in _helpers
- [ ] matchesHorizon regex deduplicated
- [ ] getRegionCountries precomputed
- [ ] coercive_pressure renormalized so escalation_ladder is reachable in Phase 0
- [ ] percentile clamps p
- [ ] triggers.config theater names consistent
- [ ] Test comment cleaned up

## Work Log

## Resources
- PR #2940
- PR #2942
