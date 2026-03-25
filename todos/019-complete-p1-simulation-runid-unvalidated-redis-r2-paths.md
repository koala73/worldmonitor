---
status: complete
priority: p1
issue_id: "019"
tags: [code-review, security, simulation-runner, path-traversal]
---

# `runId` flows unvalidated into Redis key construction and R2 path

## Problem Statement

`buildSimulationTaskKey(runId)` and `buildSimulationLockKey(runId)` construct Redis keys via string concatenation using `runId` with no format validation. More critically, `runId` flows into `buildSimulationOutcomeKey` → `buildTraceRunPrefix` which constructs an R2 key of the form `seed-data/forecast-traces/{year}/{month}/{day}/{runId}/simulation-outcome.json`. A `runId` containing `/../` path traversal sequences could produce an R2 key escaping the intended namespace.

## Findings

**F-1 (HIGH):** R2 path uses `runId` directly in `buildTraceRunPrefix`:
```javascript
// scripts/seed-forecasts.mjs — buildTraceRunPrefix (~line 4407)
`${basePrefix}/${year}/${month}/${day}/${runId}`
// runId containing '/../' produces: seed-data/forecast-traces/2026/03/24/../../../evil
```

**F-2 (MEDIUM):** Redis key construction via simple concatenation:
```javascript
function buildSimulationTaskKey(runId) { return `${SIMULATION_TASK_KEY_PREFIX}:${runId}`; }
function buildSimulationLockKey(runId) { return `${SIMULATION_LOCK_KEY_PREFIX}:${runId}`; }
// No format guard — runId from CLI argv or queue member
```

**F-3 (MEDIUM):** ZADD member in task queue uses raw `runId`:
```javascript
await redisCommand(url, token, ['ZADD', SIMULATION_TASK_QUEUE_KEY, String(Date.now()), runId]);
// If queue is poisoned, `listQueuedSimulationTasks` returns the malformed runId
// which then flows into all downstream key construction
```

Entry points: `process.argv` in `process-simulation-tasks.mjs` (operator-controlled, lower risk) and `listQueuedSimulationTasks` (queue member, higher risk if queue is ever written from an untrusted path).

## Proposed Solutions

### Option A: Validate `runId` format before any key operation (Recommended)

The existing `parseForecastRunGeneratedAt` (~line 4414) matches `/^(\d{10,})/`, suggesting `runId` values are timestamp-prefixed. Enforce this:

```javascript
const VALID_RUN_ID = /^\d{13,}-[a-z0-9\-]{1,64}$/i;

function validateRunId(runId) {
  if (!runId || !VALID_RUN_ID.test(runId)) return null;
  return runId;
}

// In enqueueSimulationTask:
const safeRunId = validateRunId(runId);
if (!safeRunId) return { queued: false, reason: 'invalid_run_id_format' };

// In processNextSimulationTask, validate each queuedRunId before processing:
for (const rawId of queuedRunIds) {
  const runId = validateRunId(rawId);
  if (!runId) { console.warn('[Simulation] Skipping malformed runId:', rawId); continue; }
  ...
}
```

Effort: Small | Risk: Low

### Option B: Sanitize R2 path components

Apply `path.normalize` and prefix-check on the constructed R2 key before write:
```javascript
const key = buildSimulationOutcomeKey(runId, generatedAt);
if (!key.startsWith('seed-data/forecast-traces/')) throw new Error('R2 key escaped namespace');
```

Effort: Small | Risk: Low — defense-in-depth after Option A

## Acceptance Criteria

- [ ] `enqueueSimulationTask` validates `runId` matches expected format before Redis write
- [ ] `processNextSimulationTask` validates each `runId` from queue before key construction
- [ ] R2 key is prefix-checked before write in `writeSimulationOutcome`
- [ ] Invalid `runId` produces `{ queued: false, reason: 'invalid_run_id_format' }` not a silent key operation
- [ ] Test: `runId` of `"../../../evil"` is rejected before Redis/R2 operations

## Technical Details

- Files: `scripts/seed-forecasts.mjs` — `enqueueSimulationTask` (~line 15636), `buildSimulationTaskKey` (~line 15633), `processNextSimulationTask` (~line 15682), `writeSimulationOutcome` (~line 15613)
- Related: `buildTraceRunPrefix` (~line 4407) — used by all trace artifact key builders

## Work Log

- 2026-03-24: Found by compound-engineering:review:security-sentinel in PR #2220 review
