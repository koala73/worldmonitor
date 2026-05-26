---
status: complete
priority: p2
issue_id: "022"
tags: [code-review, architecture, simulation-runner, correctness]
---

# `pkgPointer.runId` never compared to task `runId` — can silently simulate wrong package

## Problem Statement

In `processNextSimulationTask`, after claiming a task for `runId=A`, the code reads `SIMULATION_PACKAGE_LATEST_KEY` which returns the *latest* package pointer — not necessarily the one for run A. If a new simulation package for run B is written to Redis while task A is still queued, the worker picks up task A but processes run B's package data. The outcome is written under run A's `runId` but contains run B content. No warning is logged, no error is returned. This is especially relevant in Phase 3 when per-run lookup becomes active.

## Findings

**F-1 (HIGH):** `pkgPointer.runId` is read but never compared to the task's `runId`:
```javascript
// scripts/seed-forecasts.mjs ~line 15697
const pkgPointer = await redisGet(url, token, SIMULATION_PACKAGE_LATEST_KEY);
if (!pkgPointer?.pkgKey) { ... return { status: 'failed', reason: 'no_package_pointer' }; }
// Missing: if (pkgPointer.runId && pkgPointer.runId !== runId) { ... abort ... }

const pkgData = await getR2JsonObject(storageConfig, pkgPointer.pkgKey);
// pkgData.runId !== runId — proceeds to simulate and write outcome under wrong runId
```

## Proposed Solutions

### Option A: Add explicit runId mismatch guard (Recommended)

```javascript
const pkgPointer = await redisGet(url, token, SIMULATION_PACKAGE_LATEST_KEY);
if (!pkgPointer?.pkgKey) { ... return failed; }

// Guard: skip if package is for a different run
if (pkgPointer.runId && pkgPointer.runId !== runId) {
  console.warn(`  [Simulation] Package mismatch: task=${runId} pkg=${pkgPointer.runId} — skipping`);
  await completeSimulationTask(runId);
  return { status: 'skipped', reason: 'package_run_mismatch', runId };
}
```

This is non-breaking: if `pkgPointer.runId` is absent (old format), the guard is skipped and behavior is unchanged.

Effort: Small | Risk: Low

### Option B: Accept current behavior, document explicitly

Add a comment explaining that "latest wins" is intentional and document the Phase 3 migration path. Safe for Phase 2 where only one run stream exists.

## Acceptance Criteria

- [ ] Guard added: if `pkgPointer.runId !== runId`, task is completed and `{ status: 'skipped', reason: 'package_run_mismatch' }` returned
- [ ] Log line emitted on mismatch for operational visibility
- [ ] Test: enqueue task for runId A, set package pointer to runId B — processNextSimulationTask returns `skipped/package_run_mismatch`

## Technical Details

- File: `scripts/seed-forecasts.mjs` — `processNextSimulationTask` (~line 15697)

## Work Log

- 2026-03-24: Found by compound-engineering:review:architecture-strategist in PR #2220 review
