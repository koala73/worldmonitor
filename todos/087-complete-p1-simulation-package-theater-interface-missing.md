---
status: pending
priority: p1
issue_id: "087"
tags: [code-review, typescript, type-safety, simulation]
dependencies: []
---

# `SimulationPackageTheater` interface missing — `actorRoles` and pkg-theater shape untyped

## Problem Statement

The theater objects built by `buildSimulationPackageFromDeepSnapshot` and consumed by `buildSimulationRound2SystemPrompt` and `mergedPaths.map()` have no named TypeScript interface in `seed-forecasts.types.d.ts`. The new `actorRoles` field added in PR #2582 is a critical path for the role-overlap bonus — but with `@ts-check` active on a `.mjs` file, a typo on `theater.actorRoles` or any caller passing the wrong shape will fail silently at runtime rather than being caught statically.

## Findings

- Two agents (kieran-typescript-reviewer, architecture-strategist) flagged this independently as the highest-priority gap from PR #2582
- `buildSimulationRound2SystemPrompt(theater, pkg, round1)` receives `theater` typed as inferred plain object — `@ts-check` cannot validate `theater.actorRoles`
- `mergedPaths.map()` IIFE accesses `theater.actorRoles` with a defensive `Array.isArray` guard but no type annotation
- `TheaterResult` (the LLM output shape) is a separate interface — a `SimulationPackageTheater` for the pkg-artifact shape does not exist
- PR #2582 already edits `seed-forecasts.types.d.ts` (adding `keyActorRoles` to `SimulationTopPath`) — the missing interface should have been added in the same PR

## Proposed Solution

Add to `scripts/seed-forecasts.types.d.ts`:

```ts
/** One theater entry in SimulationPackage.selectedTheaters. Distinct from TheaterResult (LLM output shape). */
interface SimulationPackageTheater {
  theaterId: string;
  candidateStateId: string;
  label?: string;
  stateKind?: string;
  dominantRegion?: string;
  macroRegions?: string[];
  routeFacilityKey?: string;
  commodityKey?: string;
  topBucketId: string;
  topChannel: string;
  rankingScore?: number;
  criticalSignalTypes: string[];
  /** Role-category strings from candidate stateSummary.actors. Theater-scoped. Used in Round 2 prompt injection and keyActorRoles guardrail filter. */
  actorRoles: string[];
  theaterLabel?: string;
  theaterRegion?: string;
}
```

Then annotate `theater` param in `buildSimulationRound2SystemPrompt` JSDoc:
```js
/**
 * @param {import('./seed-forecasts.types.d.ts').SimulationPackageTheater} theater
 */
```

## Technical Details

- Files: `scripts/seed-forecasts.types.d.ts`, `scripts/seed-forecasts.mjs`
- Effort: Small | Risk: Low (type-only change, no runtime behavior)

## Acceptance Criteria

- [ ] `SimulationPackageTheater` interface exists in `seed-forecasts.types.d.ts`
- [ ] `buildSimulationRound2SystemPrompt` parameter annotated with the interface
- [ ] `npm run typecheck` passes

## Work Log

- 2026-03-31: Identified by kieran-typescript-reviewer and architecture-strategist during PR #2582 review
