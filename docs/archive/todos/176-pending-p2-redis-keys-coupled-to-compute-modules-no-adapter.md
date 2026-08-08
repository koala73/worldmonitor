---
status: pending
priority: p2
issue_id: 176
tags: [code-review, phase-0, regional-intelligence, architecture, redis]
dependencies: []
---

# Compute modules tightly coupled to raw Redis key strings - no adapter or invariant test

## Problem Statement

Each compute module under `scripts/regional-snapshot/*.mjs` has inline string literals like `sources['risk:scores:sebuf:stale:v1']`. The same key strings live in `freshness.mjs:FRESHNESS_REGISTRY`. When a data seed bumps its key version (v2 → v3), the update has to happen in multiple modules plus the registry. This drift has ALREADY caused two bugs (issues #167 OREF zombie, #168 4 unused keys).

Nothing enforces that the registry and consumers stay in sync.

## Findings

- `scripts/regional-snapshot/balance-vector.mjs` — hardcodes source key strings.
- `scripts/regional-snapshot/trigger-evaluator.mjs` — hardcodes source key strings.
- `scripts/regional-snapshot/evidence-collector.mjs` — hardcodes source key strings.
- `scripts/regional-snapshot/actor-scoring.mjs` — hardcodes source key strings.
- `scripts/regional-snapshot/scenario-builder.mjs` — hardcodes source key strings.
- `scripts/regional-snapshot/freshness.mjs:FRESHNESS_REGISTRY` — parallel, drift-prone list.
- Related already-landed bugs: issue #167 (OREF zombie), issue #168 (4 unused keys).

## Proposed Solutions

### Option 1 (minimal): Static-analysis invariant test

Write a test that uses regex extraction of all `sources['...']` literals from compute modules and asserts each appears in `FRESHNESS_REGISTRY`.

**Pros:** Zero refactor; pure test addition.
**Cons:** Static-analysis tests reading source as strings are notoriously fragile — see the `static-analysis-test-fragility` skill. They catch one class of drift but miss aliasing, template literals, computed indexers.
**Effort:** Small.
**Risk:** Medium (brittle; false positives on refactor).

### Option 2 (proper): Extract sources-adapter.mjs

Create `sources-adapter.mjs` with typed accessors (`getCiiScores(sources)`, `getForecasts(sources)`, etc.). Compute modules depend only on the adapter. The adapter is the single place where keys are referenced and enforces registry ↔ accessor match at module load.

**Pros:** Correct architectural boundary; future key bumps are a one-file change; unit-testable; loss of string-literal surface area eliminates drift classes entirely.
**Cons:** Touch every compute module.
**Effort:** Medium.
**Risk:** Low (mechanical substitution, tests cover behavior).

## Recommended Action

Option 2. The fragile static-test approach has caused real maintenance burden elsewhere (see skill doc), and we already have two shipped bugs from drift. Fix the structure.

## Technical Details

Current drift surface:
```js
// in balance-vector.mjs
const cii = sources['risk:scores:sebuf:stale:v1'];
// in freshness.mjs
FRESHNESS_REGISTRY = { 'risk:scores:sebuf:stale:v1': {...} };
```

Target:
```js
// sources-adapter.mjs
export const KEYS = {
  ciiScores: 'risk:scores:sebuf:stale:v1',
  forecasts: 'forecast:predictions:v2',
  // ...
};
export const getCiiScores = (sources) => sources[KEYS.ciiScores];
// freshness.mjs imports KEYS, builds registry from it
// compute modules import getCiiScores, never see the string
```

At module load, `freshness.mjs` can assert `Object.keys(FRESHNESS_REGISTRY)` equals `Object.values(KEYS)`, giving a load-time guarantee.

## Acceptance Criteria

- [ ] Compute modules contain zero string literals matching `sources\['[^']+'\]`.
- [ ] Adapter module is the only place where Redis key constants live.
- [ ] Load-time assertion verifies `FRESHNESS_REGISTRY` and adapter keys match.
- [ ] Unit tests for each accessor.

## Work Log

## Resources

- PR #2940
- Spec: `docs/internal/pro-regional-intelligence-upgrade.md`
- Skill: `static-analysis-test-fragility`
- Related: issue #167, issue #168
