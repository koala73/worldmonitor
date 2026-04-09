---
status: complete
priority: p1
issue_id: "020"
tags: [code-review, typescript, simulation-runner, type-safety]
---

# Unvalidated `as` cast on `getRawJson` result in `get-simulation-outcome.ts`

## Problem Statement

`getRawJson` returns `Promise<unknown | null>`. The handler casts the result with `as { runId: string; outcomeKey: string; ... } | null` — a TypeScript compile-time assertion with no runtime enforcement. If Redis contains a malformed value (wrong shape, missing fields, renamed keys from a schema migration), `pointer.runId`, `pointer.outcomeKey`, etc. would be `undefined`, and the handler returns a partially-populated `GetSimulationOutcomeResponse` with `undefined` values spread into proto fields. The same pattern exists in `get-simulation-package.ts` and should be fixed in both files simultaneously.

## Findings

**F-1 (P1):** TypeScript `as` cast provides zero runtime protection:
```typescript
// server/worldmonitor/forecast/v1/get-simulation-outcome.ts line 21
const pointer = await getRawJson(SIMULATION_OUTCOME_LATEST_KEY) as {
  runId: string; outcomeKey: string; schemaVersion: string; theaterCount: number; generatedAt: number;
} | null;
// If Redis has { run_id: 'x', outcome_key: 'y' } (snake_case), pointer.runId === undefined
// Handler returns { found: true, runId: undefined, ... } — malformed response
```

**F-2 (P2):** Same pattern in `get-simulation-package.ts` line ~21 — fix both together.

## Proposed Solutions

### Option A: Add a type guard function (Recommended)

```typescript
// server/worldmonitor/forecast/v1/get-simulation-outcome.ts

function isOutcomePointer(v: unknown): v is {
  runId: string; outcomeKey: string; schemaVersion: string; theaterCount: number; generatedAt: number;
} {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return typeof p['runId'] === 'string'
    && typeof p['outcomeKey'] === 'string'
    && typeof p['schemaVersion'] === 'string'
    && typeof p['theaterCount'] === 'number'
    && typeof p['generatedAt'] === 'number';
}

// In handler:
const raw = await getRawJson(SIMULATION_OUTCOME_LATEST_KEY);
if (!isOutcomePointer(raw)) {
  markNoCacheResponse(ctx.request);
  return NOT_FOUND; // treat malformed as not-found
}
const pointer = raw; // fully typed, no cast
```

Effort: Small | Risk: Low — safe degradation to NOT_FOUND on invalid data

### Option B: Use zod schema validation (heavier but more maintainable)

Add a `z.object({...}).safeParse()` call. Only viable if zod is already in the project dependencies.

## Acceptance Criteria

- [ ] `get-simulation-outcome.ts` uses a type guard instead of `as` cast
- [ ] Malformed Redis value returns `NOT_FOUND` response (not a partially-populated response)
- [ ] `get-simulation-package.ts` receives the same fix simultaneously
- [ ] TypeScript strict mode still passes after the change (no `any` introduced)
- [ ] Test: mocked `getRawJson` returning `{ run_id: 'x' }` (wrong key names) → handler returns `found: false`

## Technical Details

- File: `server/worldmonitor/forecast/v1/get-simulation-outcome.ts` lines 21-23
- File: `server/worldmonitor/forecast/v1/get-simulation-package.ts` lines ~21-23 (same pattern)
- `getRawJson` return type: `Promise<unknown | null>` — correct to return unknown

## Work Log

- 2026-03-24: Found by compound-engineering:review:kieran-typescript-reviewer in PR #2220 review
