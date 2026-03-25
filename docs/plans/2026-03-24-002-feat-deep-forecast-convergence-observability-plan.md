---
title: "feat: Deep Forecast Convergence Observability"
type: feat
status: active
date: 2026-03-24
origin: docs/brainstorms/2026-03-24-deep-forecast-convergence-requirements.md
---

# feat: Deep Forecast Convergence Observability

## Overview

Add a `convergence` object to the R2 debug artifact for every deep forecast run. This surfaces whether the autoresearch loop considered the current output "done" (composite ≥ 0.80), how many critique iterations fired, and how many mapped hypotheses each candidate produced. After 5+ runs, an engineer can read R2 artifacts and answer "is the pipeline converging?" without any additional tooling.

(see origin: docs/brainstorms/2026-03-24-deep-forecast-convergence-requirements.md)

## Problem Statement

After the free-form hypothesis rewrite (v4), the pipeline produces structurally valid output but no signal exists to confirm whether successive changes are improving things. `runImpactExpansionPromptRefinement` is fire-and-forget and returns `undefined`. The debug artifact has no quality summary. Every change is a guess.

## Proposed Solution

Three targeted changes to `scripts/seed-forecasts.mjs`:

1. **Return from `runImpactExpansionPromptRefinement`** — add `return { iterationCount, committed }` at each exit path (0 for early exits, 1 when critique call was made).
2. **Reorder call site in `processDeepForecastTask`** — move the two `runImpactExpansionPromptRefinement` calls to happen **before** `buildImpactExpansionDebugPayload` is called, capturing the result.
3. **Inject `convergence` into `buildImpactExpansionDebugPayload`** — pass refinement result + validation in; compute and include the `convergence` object in the returned artifact.

## Technical Considerations

### Architecture: Call Order Inversion

Currently in `processDeepForecastTask` (approximately lines 14050–14090):
```
1. buildImpactExpansionDebugPayload(...)  → writes R2 artifact
2. runImpactExpansionPromptRefinement(...) → fire-and-forget, returns undefined
```

After this change:
```
1. runImpactExpansionPromptRefinement(...) → returns { iterationCount, committed }
2. buildImpactExpansionDebugPayload(..., { refinementResult })  → writes R2 artifact with convergence
```

The refinement function already has an early exit when `composite >= 0.80` (line ~14299), so it's fast when quality is good. Inversion adds at most one LLM call of latency before the artifact write on poor-quality runs, which was already happening anyway.

### `runImpactExpansionPromptRefinement` Return Paths

There are three exit paths; each needs a return value:

| Exit condition | `iterationCount` | `committed` |
|---|---|---|
| Rate-limited (< 30 min since last attempt) | 0 | false |
| Quality already ≥ 0.80 (early quality gate) | 0 | false |
| Critique call made → improvement found | 1 | true |
| Critique call made → no improvement, reverted | 1 | false |

### `convergence` Object Shape

```javascript
{
  converged: boolean,         // finalComposite >= 0.80
  finalComposite: number,     // scoreImpactExpansionQuality(validation).composite
  critiqueIterations: number, // 0 or 1 (from refinement return value)
  refinementCommitted: boolean, // whether the prompt section was updated
  perCandidateMappedCount: {  // candidateStateId → mapped hypothesis count
    [candidateStateId: string]: number
  }
}
```

`perCandidateMappedCount` is derived from `validation.mapped` (each item has `candidateStateId` confirmed present via `flattenImpactExpansionHypotheses`):
```javascript
const perCandidateMappedCount = {};
for (const h of (rawValidation.mapped || [])) {
  const id = h.candidateStateId || 'unknown';
  perCandidateMappedCount[id] = (perCandidateMappedCount[id] || 0) + 1;
}
```

### `buildImpactExpansionDebugPayload` Extension

Current signature: `buildImpactExpansionDebugPayload(data = {}, worldState = null, runId = '')`

The `data` argument is already a bag-of-state object. The cleanest extension is to pass `refinementResult` inside `data`:
```javascript
buildImpactExpansionDebugPayload({
  ...existingData,
  refinementResult: { iterationCount: 1, committed: false },
}, worldState, runId)
```

Inside the function, assemble `convergence` from `data.refinementResult` and `data.rawValidation` (or however the validation is passed — confirm in impl).

## Acceptance Criteria

- [ ] R1. R2 debug artifact includes a top-level `convergence` object on every deep forecast run
- [ ] R2. `convergence.converged` is `true` iff `finalComposite >= 0.80`
- [ ] R3. `convergence.finalComposite` matches `scoreImpactExpansionQuality(validation).composite` for the run
- [ ] R4. `convergence.critiqueIterations` is 0 when quality is already ≥ 0.80 or rate-limited; 1 when critique was invoked
- [ ] R5. `convergence.perCandidateMappedCount` maps every `candidateStateId` that participated to its mapped hypothesis count
- [ ] `runImpactExpansionPromptRefinement` returns `{ iterationCount, committed }` at all exit paths (no undefined)
- [ ] Call order in `processDeepForecastTask` places refinement invocation before artifact assembly
- [ ] Existing tests still pass (no regressions)
- [ ] New test: `convergence.converged === true` when composite ≥ 0.80; `false` when < 0.80
- [ ] New test: `perCandidateMappedCount` correctly groups by candidateStateId

## Implementation Plan

### Step 1 — `runImpactExpansionPromptRefinement`: add return values

File: `scripts/seed-forecasts.mjs`, function at line ~14279.

Add `return { iterationCount: 0, committed: false }` at:

- The rate-limit early exit
- The quality >= 0.80 early exit

Change the critique-invoked branch to:
```javascript
// After commit/revert logic:
return { iterationCount: 1, committed: didCommit };
```

Where `didCommit` is `true` if the improvement check passed and the new section was written to Redis.

### Step 2 — `processDeepForecastTask`: invert call order

File: `scripts/seed-forecasts.mjs`, lines ~14050–14090.

Before (pseudocode):
```javascript
await writeR2DebugArtifact(buildImpactExpansionDebugPayload(data, worldState, runId));
await runImpactExpansionPromptRefinement({ candidatePackets, validation, priorWorldState });
await runImpactExpansionPromptRefinement({ candidatePackets, validation, priorWorldState });
```

After:
```javascript
const refinementResult = await runImpactExpansionPromptRefinement({
  candidatePackets, validation, priorWorldState,
});
await writeR2DebugArtifact(buildImpactExpansionDebugPayload(
  { ...data, refinementResult },
  worldState,
  runId,
));
```

Note: there are two calls to `runImpactExpansionPromptRefinement` (lines 14060, 14087). Determine during implementation whether both are semantically distinct or if one is redundant; collapse to one if identical, keeping both if they serve different scenarios.

### Step 3 — `buildImpactExpansionDebugPayload`: inject `convergence`

File: `scripts/seed-forecasts.mjs`, lines ~4415–4476.

Add `convergence` assembly:
```javascript
const rawValidation = data.rawValidation || data.hypothesisValidation || {};
const qualityScore = scoreImpactExpansionQuality(rawValidation, data.candidatePackets || []);
const refinementResult = data.refinementResult || { iterationCount: 0, committed: false };

const perCandidateMappedCount = {};
for (const h of (rawValidation.mapped || [])) {
  const id = h.candidateStateId || 'unknown';
  perCandidateMappedCount[id] = (perCandidateMappedCount[id] || 0) + 1;
}

const convergence = {
  converged: qualityScore.composite >= 0.80,
  finalComposite: qualityScore.composite,
  critiqueIterations: refinementResult.iterationCount,
  refinementCommitted: refinementResult.committed,
  perCandidateMappedCount,
};
```

Add `convergence` to the returned object alongside `gateDetails`.

### Step 4 — Tests

File: `tests/forecast-trace-export.test.mjs`

- **T-conv-1**: Build a validation with composite ≥ 0.80 → assert `convergence.converged === true`, `convergence.critiqueIterations === 0`
- **T-conv-2**: Build a validation with composite < 0.80 + mock refinement returning `{ iterationCount: 1, committed: false }` → assert `convergence.converged === false`, `convergence.critiqueIterations === 1`
- **T-conv-3**: Build mapped hypotheses for 3 candidates (2/1/0 each) → assert `perCandidateMappedCount` has correct counts, missing candidate not present (or zero), dominant candidate visible

## System-Wide Impact

- **Interaction graph**: `runImpactExpansionPromptRefinement` mutates Redis (`PROMPT_LEARNED_KEY`, `PROMPT_BASELINE_KEY`, `PROMPT_LAST_ATTEMPT_KEY`) — these mutations still happen; only the call order relative to the R2 write changes. R2 write is not in Redis critical path.
- **Error propagation**: If `runImpactExpansionPromptRefinement` throws, it currently propagates up from fire-and-forget (would be swallowed by the `await` in caller). After inversion, the throw happens before artifact write — confirm the call site wraps in try-catch to preserve artifact write on refinement failure.
- **State lifecycle**: No new Redis state. No new R2 keys. `convergence` is additive to existing artifact — no breaking change for consumers that read R2 artifacts.
- **API surface**: `buildImpactExpansionDebugPayload` signature changes via `data` bag (backwards compatible). `runImpactExpansionPromptRefinement` now returns a value (callers that ignore it are unaffected).

## Dependencies & Risks

- **Two calls at lines 14060 and 14087**: Determine if both are needed or if one is a duplicate. If both run, `iterationCount` should accumulate: `totalIterationCount = result1.iterationCount + result2.iterationCount`.
- **`rawValidation` access inside `buildImpactExpansionDebugPayload`**: The validation data is passed via `data` — confirm the key name matches how it's assembled at the call site before writing.
- **`scoreImpactExpansionQuality` already called upstream**: Avoid double-computing. If the quality score is already computed before `buildImpactExpansionDebugPayload` is called, pass it in via `data` rather than recomputing inside the function.

## Success Metrics

After merge, reading 5 consecutive R2 debug artifacts should show:

- `convergence.finalComposite` trending toward or staying above 0.80
- `convergence.critiqueIterations` at 0 on good runs (the base prompt is working)
- `convergence.perCandidateMappedCount` spread across multiple candidates (no single candidate with 10× the others)

## Sources & References

### Origin

- **Origin document:** [docs/brainstorms/2026-03-24-deep-forecast-convergence-requirements.md](../brainstorms/2026-03-24-deep-forecast-convergence-requirements.md)
  Key decisions carried forward: (1) convergence = final pass ≥ 0.80 not first pass, (2) R2 artifact as signal home with no new Redis/scripts, (3) critiqueIterations over first-pass score

### Internal References

- `runImpactExpansionPromptRefinement`: `scripts/seed-forecasts.mjs` line ~14279
- `buildImpactExpansionDebugPayload`: `scripts/seed-forecasts.mjs` line ~4415
- `scoreImpactExpansionQuality`: `scripts/seed-forecasts.mjs` line ~14134
- `flattenImpactExpansionHypotheses` (where `candidateStateId` is set): `scripts/seed-forecasts.mjs` line ~10162
- Call sites: `processDeepForecastTask` lines ~14060 and ~14087
- R2 storage: `scripts/_r2-storage.mjs`
- Tests: `tests/forecast-trace-export.test.mjs`
