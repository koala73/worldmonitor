---
status: complete
priority: p1
issue_id: 166
tags: [code-review, phase-0, regional-intelligence, health, monitoring]
dependencies: []
---

# Health check for regionalSnapshots is dead wiring (not in BOOTSTRAP_KEYS or STANDALONE_KEYS)

## Problem Statement
PR #2940 added `SEED_META.regionalSnapshots` to `api/health.js:225` but the entry is never read. `health.js` only dereferences `SEED_META[name]` inside two loops that iterate `BOOTSTRAP_KEYS` (line ~402) and `STANDALONE_KEYS` (line ~474). There is no `regionalSnapshots` key in either map, so the freshness check silently no-ops. The 12h staleness budget is unobservable: if the seeder falls behind, nothing alerts.

Same failure mode as `feedback_empty_data_ok_keys_bootstrap_blind_spot.md` and the `health-maxstalemin-write-cadence` skill.

## Findings
- `api/health.js:225` has the `SEED_META` entry for `regionalSnapshots`.
- Neither `BOOTSTRAP_KEYS` nor `STANDALONE_KEYS` contains `regionalSnapshots`.
- Verified by grepping for `regionalSnapshots` across `api/health.js`: only one match (the `SEED_META` entry itself).
- Net effect: the health endpoint never exercises the freshness budget for this seed.

## Proposed Solutions

### Option 1: Add to STANDALONE_KEYS
Add `regionalSnapshots: 'intelligence:regional-snapshots:summary:v1'` to `STANDALONE_KEYS`. This is the seeded summary key written by `seed-regional-snapshots.mjs:208`.

**Pros:** Minimal change, matches current phase (Phase 0 seeds but no panel consumer yet).
**Cons:** Will need to move it to `BOOTSTRAP_KEYS` when Phase 1 panel bootstrap lands.
**Effort:** Small
**Risk:** Low

### Option 2: Add to BOOTSTRAP_KEYS now
Add to `BOOTSTRAP_KEYS` directly since Phase 1 will consume this in the panel bootstrap.

**Pros:** Cleaner forward compat, avoids a second migration.
**Cons:** Premature coupling; bootstrap payload grows before consumer exists.
**Effort:** Small
**Risk:** Medium (risks shipping bootstrap field with no consumer)

## Recommended Action
(leave blank for triage)

## Technical Details
- Affected files: `api/health.js`
- Components: health endpoint, seed freshness monitoring
- Related seed: `scripts/seed-regional-snapshots.mjs:208`
- Related key: `intelligence:regional-snapshots:summary:v1`

## Acceptance Criteria
- [ ] `regionalSnapshots` key appears in either `BOOTSTRAP_KEYS` or `STANDALONE_KEYS` in `api/health.js`
- [ ] Hitting `/api/health` on production after first cron cycle returns OK status for `regionalSnapshots`
- [ ] If seeder fails for >720 min, `/api/health` goes red

## Work Log
(empty)

## Resources
- PR #2940
- Spec: docs/internal/pro-regional-intelligence-upgrade.md
- Related memory: `feedback_empty_data_ok_keys_bootstrap_blind_spot.md`
- Related skill: `health-maxstalemin-write-cadence`
