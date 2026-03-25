---
status: complete
priority: p2
issue_id: "027"
tags: [code-review, agent-native, simulation-runner, api]
---

# `runId` filter in `getSimulationOutcome` is a no-op with no OpenAPI documentation

## Problem Statement

`GetSimulationOutcomeRequest.runId` is accepted as a query parameter but explicitly ignored — the handler always returns the latest outcome. The proto file has a comment explaining this ("Currently ignored; always returns the latest outcome. Reserved for Phase 3"), but this comment does not surface in the generated OpenAPI spec's `description` field. Agents and API consumers relying on the OpenAPI spec see a `runId` parameter with no description and no indication that it is non-functional. An agent that triggers a simulation run, notes the `runId`, and passes it to `getSimulationOutcome` will silently receive a different run's outcome with no way to detect the mismatch (except the `note` field, which is easy to overlook).

## Findings

**F-1:** Proto comment exists but does not reach OpenAPI:
```proto
// proto/worldmonitor/forecast/v1/get_simulation_outcome.proto line 9
message GetSimulationOutcomeRequest {
  // Currently ignored; always returns the latest outcome. Reserved for Phase 3 per-run lookup.
  string run_id = 1 [(sebuf.http.query) = { name: "runId" }];
}
```
Generated `docs/api/ForecastService.openapi.yaml` has the `runId` parameter with no `description` field.

**F-2:** Agent trigger-and-verify workflow is unreliable without per-run lookup:

1. Agent calls `POST /api/forecast/v1/trigger-simulation` (when it exists) → gets `runId=A`
2. Agent polls `GET /api/forecast/v1/get-simulation-outcome?runId=A`
3. Run B completes first, writes `found: true, runId: B` to Redis
4. Handler returns run B's outcome with `note: "runId filter not yet active; returned outcome may differ"`
5. Agent receives `note` but may not check it; proceeds to act on wrong run's data

## Proposed Solutions

### Option A: Add description annotation to proto field so it propagates to OpenAPI (Recommended)

Check if sebuf's proto generator picks up leading comments or if it requires a `description` annotation extension. If the generator supports field descriptions, add:
```proto
// IMPORTANT: Currently a no-op. Always returns the latest available outcome regardless of runId.
// Per-run lookup is reserved for Phase 3. Check the response 'note' field when runId is supplied.
string run_id = 1 [(sebuf.http.query) = { name: "runId" }];
```

If the generator does not propagate comments, manually update the generated OpenAPI yaml as a post-generation step.

### Option B: Document in the handler's response `note` more prominently

Current `note` text: "runId filter not yet active; returned outcome may differ from requested run". This is already a reasonable signal. Ensure the proto `note` field also has a description in OpenAPI explaining its purpose.

## Acceptance Criteria

- [ ] OpenAPI `description` for the `runId` parameter in `GetSimulationOutcome` explains it is currently a no-op
- [ ] OpenAPI `description` for the `note` response field explains it is populated when `runId` mismatch occurs
- [ ] Combined with todo #021 (trigger endpoint), a full trigger-and-verify loop is documented

## Technical Details

- File: `proto/worldmonitor/forecast/v1/get_simulation_outcome.proto`
- File: `docs/api/ForecastService.openapi.yaml` (auto-generated — check if manual edits survive `make generate`)

## Work Log

- 2026-03-24: Found by compound-engineering:review:agent-native-reviewer in PR #2220 review
