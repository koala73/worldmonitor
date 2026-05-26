---
status: pending
priority: p1
issue_id: "088"
tags: [code-review, simulation, agent-native, observability, redis]
dependencies: []
---

# `keyActorRoles` missing from `uiTheaters` Redis projection in `writeSimulationOutcome`

## Problem Statement

`writeSimulationOutcome` builds a `uiTheaters` array written to Redis (`SIMULATION_OUTCOME_LATEST_KEY`) and returned by `GetSimulationOutcomeResponse.theaterSummariesJson`. The path map explicitly projects only `pathId`, `label`, `summary`, `confidence`, and `keyActors` — the new `keyActorRoles` field from PR #2582 is omitted. Even if the `get-simulation-outcome` RPC is eventually unblocked for agent access, `keyActorRoles` will always be `undefined` on every path because it is stripped at the Redis write stage.

## Findings

- Found by agent-native-reviewer during PR #2582 review
- Location: `scripts/seed-forecasts.mjs` line ~16823 in `writeSimulationOutcome`
- The `uiTheaters` path projection:
  ```js
  .map((p) => ({
    pathId: p.pathId || '',
    label: p.label,
    summary: p.summary,
    confidence: p.confidence,
    keyActors: (p.keyActors || []).slice(0, 4),
    // keyActorRoles is NOT here
  }))
  ```
- `keyActorRoles` exists in the full R2 artifact (`simulation-outcome.json`) but never reaches the Redis snapshot
- The proto comment for `theater_summaries_json` in `get_simulation_outcome.proto` line 31 also needs updating

## Proposed Solution

Add `keyActorRoles` to the `uiTheaters` path projection:

```js
.map((p) => ({
  pathId: p.pathId || '',
  label: p.label,
  summary: p.summary,
  confidence: p.confidence,
  keyActors: (p.keyActors || []).slice(0, 4),
  keyActorRoles: (p.keyActorRoles || []).slice(0, 8),
}))
```

Update `get_simulation_outcome.proto` comment for `theater_summaries_json` to include `keyActorRoles` in the documented shape.

## Technical Details

- Files: `scripts/seed-forecasts.mjs` (uiTheaters map), `proto/worldmonitor/forecast/v1/get_simulation_outcome.proto`
- Effort: Small | Risk: Low

## Acceptance Criteria

- [ ] `keyActorRoles` appears in `uiTheaters` path projection
- [ ] `redis-cli get forecast:simulation-outcome:latest | jq '.uiTheaters[0].topPaths[0].keyActorRoles'` returns a non-null value after next sim run
- [ ] Proto comment updated

## Work Log

- 2026-03-31: Identified by agent-native-reviewer during PR #2582 review
