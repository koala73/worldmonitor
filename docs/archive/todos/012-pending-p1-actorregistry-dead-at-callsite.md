---
status: pending
priority: p1
issue_id: "012"
tags: [code-review, deep-forecast, simulation-package, correctness]
---

# `actorRegistry` always `[]` in production — `priorWorldState` not threaded to `writeSimulationPackage` call site

## Problem Statement

`buildSimulationPackageFromDeepSnapshot` accepts `priorWorldState` as its second argument and uses `priorWorldState?.actorRegistry || []` for the highest-fidelity entity extraction path (actorRegistry entries whose `forecastIds` overlap the selected theaters). But the call site in the main seed path never passes `priorWorldState`:

```javascript
writeSimulationPackage(snapshotPayload, { storageConfig: snapshotWrite.storageConfig })
```

`priorWorldState` is available earlier in scope (resolved via `readPreviousForecastWorldState` during snapshot building) but `writeDeepForecastSnapshot` does not return it, so it cannot be passed through. The result: `actorRegistry` is always `[]` in all production runs, the registry-based entity extraction branch is silently dead, and entities degrade to stateUnit actors and evidence table only.

## Findings

- `scripts/seed-forecasts.mjs` — fire-and-forget call site in seed path:
  ```javascript
  const snapshotWrite = await writeDeepForecastSnapshot(snapshotPayload, { runId });
  if (snapshotWrite?.storageConfig && ...) {
    writeSimulationPackage(snapshotPayload, { storageConfig: snapshotWrite.storageConfig })
  ```
- `priorWorldState` is in scope earlier but not accessible at this point
- Entity extraction priority (per gap doc): actorRegistry FIRST, then stateUnit actors, then evidence table, then fallback anchors
- The most specific extraction path (forecastId overlap with registry) never runs in production

## Proposed Solutions

### Option A: Return `priorWorldState` from `writeDeepForecastSnapshot` (Recommended)

```javascript
// In writeDeepForecastSnapshot return:
return { storageConfig, snapshotKey, priorWorldState };
// At call site:
writeSimulationPackage(snapshotPayload, {
  storageConfig: snapshotWrite.storageConfig,
  priorWorldState: snapshotWrite.priorWorldState,
})
```
Effort: Small | Risk: Low

### Option B: Call `writeSimulationPackage` before `writeDeepForecastSnapshot`, where `priorWorldState` is still in scope

Requires restructuring the call order slightly. `writeSimulationPackage` can also accept the already-built snapshot payload.
Effort: Small | Risk: Low

### Option C: Pass `priorWorldState` into the snapshot payload itself

Add `priorWorldState` to `snapshotPayload` and read it in `buildSimulationPackageFromDeepSnapshot`.
Effort: Tiny | Risk: Medium (grows snapshot payload)

## Acceptance Criteria

- [ ] In production runs, `entities[]` contains entries sourced from `actorRegistry` when the registry has relevant actors
- [ ] `priorWorldState.actorRegistry` is passed through to `buildSimulationPackageFromDeepSnapshot`
- [ ] Test: `buildSimulationPackageFromDeepSnapshot(snapshot, { actorRegistry: [{ id: 'actor-1', name: 'Iran', forecastIds: [...], ... }] })` produces entity with `entityId: 'actor-1'` and `relevanceToTheater: 'actor_registry'`

## Technical Details

- File: `scripts/seed-forecasts.mjs` — `writeSimulationPackage` call site in `_isDirectRun` seed path
- Functions: `writeSimulationPackage`, `writeDeepForecastSnapshot`, `buildSimulationPackageFromDeepSnapshot`

## Work Log

- 2026-03-24: Found by compound-engineering:research:learnings-researcher in PR #2204 review
