---
status: pending
priority: p3
issue_id: "017"
tags: [code-review, deep-forecast, simulation-package, architecture]
---

# Phase 2 prerequisites: `getSimulationPackage` RPC + Redis existence key

## Problem Statement

The simulation package is a write-only black box: agents cannot read it, trigger it, verify its existence, or discover its schema through any runtime interface. This is acceptable for Phase 1, but Phase 2 (MiroFish integration) requires a read path before it can proceed.

## Findings

From the agent-native review:

- **0/4 simulation-package capabilities are agent-accessible** (trigger, read, check existence, discover schema)
- There is no `getSimulationPackage(runId)` RPC handler in `server/worldmonitor/forecast/v1/`
- The R2 key is deterministic and computable from `(runId, generatedAt)` but no handler exposes it
- `schemaVersion` is written as R2 object metadata but never returned through any read path
- `writeSimulationPackage` returns `{ pkgKey, theaterCount }` but this result is discarded at the fire-and-forget call site — nothing writes a Redis existence key

Phase 2 gate: MiroFish or any LLM scenario-analysis workflow that consumes the package must reach it through the server layer, not by directly importing `buildSimulationPackageKey` from the seed script.

## Proposed Solutions

### Option A: Add `getSimulationPackage(runId)` RPC (Recommended for Phase 2)

Create `server/worldmonitor/forecast/v1/get-simulation-package.ts` that reads from R2 using `buildSimulationPackageKey(runId, generatedAt)`. Follows the same pattern as the deep-snapshot replay handler.

### Option B: Write Redis existence key on successful write

When `writeSimulationPackage` resolves successfully, write a Redis key:
```
forecast:simulation-package:latest → { runId, pkgKey, schemaVersion, theaterCount, generatedAt }
```
This gives agents a cheap existence check and gives health monitoring a probe point at zero R2 cost.

Both options are Phase 2 work, not Phase 1 blockers.

## Acceptance Criteria (Phase 2)

- [ ] `getSimulationPackage(runId)` RPC handler exists in `server/worldmonitor/forecast/v1/`
- [ ] Handler reads from R2 using `buildSimulationPackageKey`
- [ ] `schemaVersion` is included in the RPC response
- [ ] Redis key `forecast:simulation-package:latest` written on successful `writeSimulationPackage`
- [ ] Health check or bootstrap key added for existence monitoring

## Technical Details

- New file needed: `server/worldmonitor/forecast/v1/get-simulation-package.ts`
- Wire in: `server/worldmonitor/handler.ts` (gateway registration)
- Follow pattern of: `server/worldmonitor/forecast/v1/get-forecasts.ts`

## Work Log

- 2026-03-24: Found by compound-engineering:review:agent-native-reviewer in PR #2204 review
- Phase 1 only — do not block PR #2204 merge on this item
