---
status: complete
priority: p1
issue_id: 169
tags: [code-review, phase-0, regional-intelligence, types, persistence]
dependencies: []
---

# SnapshotDiff field serialized into persisted snapshot (proto contract leak)

## Problem Statement
`scripts/seed-regional-snapshots.mjs:164` returns `{...tentativeSnapshot, meta: finalMeta, diff}` from `computeSnapshot`. The `diff` field is NOT part of the `RegionalSnapshot` type defined in `shared/regions.types.d.ts`. The persist layer in `persist-snapshot.mjs:48` then `JSON.stringifies` the full object including `diff` and writes it to 3 Redis keys.

When Phase 1 generates the proto from `RegionalSnapshot` and server handlers deserialize Redis values, they will either:
1. Error on the unknown `diff` field with strict parsers (Buf/Connect-ES is strict)
2. Silently drop it with permissive parsers
3. Serialize it back out, propagating the contract leak to clients

The architectural commitment is "the persisted snapshot is canonical". The disk shape must match the typed shape.

## Findings
- `scripts/seed-regional-snapshots.mjs:164`: `return { ...tentativeSnapshot, meta: finalMeta, diff }`.
- `shared/regions.types.d.ts` has no `diff` field on `RegionalSnapshot`.
- `scripts/regional-snapshot/persist-snapshot.mjs:47-48` stringifies the full object and writes to 3 Redis keys.
- Phase 1 proto generation will pull from `RegionalSnapshot`, creating a drift between the runtime value and the typed contract.

## Proposed Solutions

### Option 1: Return diff as sibling, not spread
Change `computeSnapshot` to return `{snapshot, diff}` separately. Persist only `snapshot`. Use `diff` for `inferTriggerReason` and for Phase 2 alert emission.

**Pros:** Keeps persisted shape aligned to type; diff remains available for runtime use.
**Cons:** Small refactor of the call site and any consumers.
**Effort:** Small
**Risk:** Low

### Option 2: Add diff to the type
Add `diff` as an optional field in `RegionalSnapshot` type.

**Pros:** Zero runtime change.
**Cons:** Couples persistent shape to a runtime detail; grows the proto surface area; violates the "persisted = canonical" commitment.
**Effort:** Small
**Risk:** Medium

## Recommended Action
(leave blank for triage)

## Technical Details
- Affected files:
  - `scripts/seed-regional-snapshots.mjs:164`
  - `scripts/regional-snapshot/persist-snapshot.mjs:47-48`
  - `shared/regions.types.d.ts`
- Components: snapshot compute, persist layer, type contract, future proto generation
- Touched Redis keys: 3 keys written by `persistSnapshot`

## Acceptance Criteria
- [ ] `computeSnapshot` returns `{snapshot, diff}` as separate fields
- [ ] `persistSnapshot` receives only the snapshot, not the wrapper
- [ ] JSON inspection of any persisted `intelligence:snapshot:*` key has no `diff` property
- [ ] Test added: `JSON.parse(persistedSnapshot)` matches the `RegionalSnapshot` type exactly

## Work Log
(empty)

## Resources
- PR #2940
- Spec: docs/internal/pro-regional-intelligence-upgrade.md
