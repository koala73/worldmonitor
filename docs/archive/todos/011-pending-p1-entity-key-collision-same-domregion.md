---
status: pending
priority: p1
issue_id: "011"
tags: [code-review, deep-forecast, simulation-package, correctness]
---

# Entity key collision: same `dominantRegion` across multiple candidates silently drops entities + wrong `relevanceToTheater`

## Problem Statement

`buildSimulationPackageEntities` uses `su:${actorName}:${candidate.dominantRegion}` and `ev:${name}:${candidate.dominantRegion}` as Map dedup keys. When two selected theater candidates share the same `dominantRegion` (e.g., Bab el-Mandeb and Suez Canal both map to "Red Sea"), an actor appearing in both candidates (e.g., "US Navy Fifth Fleet") produces identical keys. The `addEntity` guard silently drops the second entry, and the kept entity has `relevanceToTheater` pointing to whichever candidate was processed first — not the one it is most relevant to.

## Findings

- `scripts/seed-forecasts.mjs` — `buildSimulationPackageEntities`, `su:` and `ev:` key construction:
  ```javascript
  const key = `su:${actorName}:${candidate.dominantRegion}`;
  // and
  const key = `ev:${name}:${candidate.dominantRegion}`;
  ```
- Red Sea / Bab el-Mandeb / Suez Canal all share `dominantRegion: 'Red Sea'` in `CHOKEPOINT_MARKET_REGIONS`
- The dropped entity causes incorrect `relevanceToTheater` assignment with no log
- This is a data correctness issue in the exported schema — downstream simulators/LLMs get wrong theater attribution

## Proposed Solutions

### Option A: Include `candidateStateId` in the dedup key (Recommended)

```javascript
const key = `su:${actorName}:${candidate.candidateStateId}`;
// and
const key = `ev:${name}:${candidate.candidateStateId}`;
```
Effort: Tiny | Risk: Low — `candidateStateId` is always unique per candidate

### Option B: Use actor name only as dedup key, merge `relevanceToTheater` as array

Allow the same actor to appear once with `relevanceToTheater: ['theater-1', 'theater-2']`. This is semantically richer for Phase 2 but changes the schema contract.
Effort: Small | Risk: Medium (schema change)

## Acceptance Criteria

- [ ] Two candidates with same `dominantRegion` and overlapping actors produce separate entities per candidate in the output
- [ ] Each entity's `relevanceToTheater` correctly references its source candidate
- [ ] `[...seen.values()].slice(0, 20)` cap still applies
- [ ] Test: two theater candidates sharing `dominantRegion: 'Red Sea'`, same actor in `stateSummary.actors` — assert both entities present with correct `relevanceToTheater`

## Technical Details

- File: `scripts/seed-forecasts.mjs` — `buildSimulationPackageEntities`

## Work Log

- 2026-03-24: Found by compound-engineering:review:kieran-typescript-reviewer in PR #2204 review
