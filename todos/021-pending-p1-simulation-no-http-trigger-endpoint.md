---
status: pending
priority: p1
issue_id: "021"
tags: [code-review, agent-native, simulation-runner, api]
---

# No HTTP endpoint to trigger a simulation run — agents cannot initiate simulations

## Problem Statement

Simulation runs can only be triggered by a human operator running `node scripts/process-simulation-tasks.mjs --once` in the Railway environment. `enqueueSimulationTask(runId)` and `runSimulationWorker` are exported from `scripts/seed-forecasts.mjs` but are only callable from worker processes, not via HTTP. Agents operating through the HTTP API (AI Market Implications panel, future orchestration agents, LLM tool calls) have read-only access to the system — they can discover the latest simulation outcome pointer but cannot trigger a new simulation. For a feature described as AI-driven forecasting, agents being permanently blocked from initiating analysis is a design gap.

## Findings

**F-1 (P1):** No `POST /api/forecast/v1/trigger-simulation` or equivalent endpoint exists.

**F-2 (P1):** `enqueueSimulationTask(runId)` is exported and callable, but only from Node.js processes — no HTTP surface.

**F-3 (P2):** Compounded by `runId` filter being a no-op in `getSimulationOutcome` — even if an agent knew its trigger succeeded, it cannot verify its specific run completed vs. a concurrent run superseding it.

**Capability map:**

| Action | Human | Agent (HTTP) |
|---|---|---|
| Check outcome exists | ✅ | ✅ |
| Read outcome pointer | ✅ | ✅ |
| Trigger simulation run | ✅ (Railway CLI) | ❌ |
| Check if run in progress | ✅ (logs) | ❌ |
| Verify specific run completed | ✅ | ❌ (runId filter no-op) |

## Proposed Solutions

### Option A: Add `POST /api/forecast/v1/trigger-simulation` (Recommended)

A thin Vercel handler following the same proto pattern:

1. New proto message: `TriggerSimulationRequest { string run_id = 1; }`, `TriggerSimulationResponse { bool queued = 1; string run_id = 2; string reason = 3; }`
2. New handler: reads `SIMULATION_PACKAGE_LATEST_KEY` from Redis to derive `runId` if not supplied, calls `enqueueSimulationTask(runId)`, returns `{ queued, runId, reason }`
3. The actual execution remains Railway-side (existing poll loop picks it up) — the endpoint only enqueues
4. Rate-limit to 1 trigger per 5 minutes to prevent spam (can reuse existing rate-limit pattern)

Estimated effort: 1 proto file + 1 handler file + 1 service.proto entry + `make generate` — same scope as `get-simulation-outcome.ts`.

### Option B: Webhook trigger from deep forecast completion

When `processNextDeepForecastTask` completes and writes a simulation package, automatically call `enqueueSimulationTask`. This makes simulation trigger automatic rather than agent-driven. Simpler but removes on-demand triggering flexibility.

Effort: Small | Risk: Low — no new HTTP surface, but agents still can't trigger ad-hoc

## Acceptance Criteria

- [ ] `POST /api/forecast/v1/trigger-simulation` returns `{ queued: true, runId }` when package is available
- [ ] Returns `{ queued: false, reason: 'no_package' }` when no simulation package exists
- [ ] Returns `{ queued: false, reason: 'duplicate' }` when the same runId is already queued
- [ ] Rate limited to prevent spam
- [ ] Agent-native: an agent calling the trigger endpoint then polling `getSimulationOutcome` can complete a trigger-and-verify workflow

## Technical Details

- Would-be handler: `server/worldmonitor/forecast/v1/trigger-simulation.ts`
- Entry point: `enqueueSimulationTask(runId)` in `scripts/seed-forecasts.mjs` (already exported)
- Pattern reference: `get-simulation-outcome.ts` for handler structure, `service.proto` for RPC addition
- Related: todo #029 (runId filter no-op) — fix both for complete trigger-and-verify loop

## Work Log

- 2026-03-24: Found by compound-engineering:review:agent-native-reviewer in PR #2220 review
