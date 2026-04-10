---
status: complete
priority: p2
issue_id: "156"
tags: [code-review, quality, supply-chain, visual]
dependencies: []
---

# GlobeMap `polygonStrokeColor` Missing `scenario` Branch — Falls Through to Red

## Problem Statement
In `GlobeMap.ts`, `polygonStrokeColor` has no `'scenario'` case. When scenario polygons are rendered, the callback falls through to the catch-all `return '#ff4444'` (conflict red), giving affected countries a visible red border that clashes with the intended orange/amber heat tint and visually conflates scenario state with conflict data.

## Findings
- **File:** `src/components/GlobeMap.ts`
- `polygonCapColor` and `polygonSideColor` both have `'scenario'` branches added in Sprint E
- `polygonStrokeColor` was missed — falls through to `'#ff4444'` (conflict) or `'transparent'`
- At runtime: scenario-affected countries appear with a red border matching conflict polygons
- Identified during architecture review of PR #2910

## Proposed Solutions

### Option A: Add `scenario` branch returning transparent (Recommended)
```ts
// In polygonStrokeColor callback:
if (d._kind === 'scenario') return 'transparent';
```
Scenario heat overlay has no border — consistent with how the DeckGL `GeoJsonLayer` has `stroked: false`.
**Pros:** Zero visual noise, matches DeckGL behavior, 1-line fix
**Cons:** None
**Effort:** Small | **Risk:** None

### Option B: Use a subtle amber stroke
```ts
if (d._kind === 'scenario') return 'rgba(220,120,40,0.4)';
```
Adds a faint amber outline to distinguish from other polygon types.
**Effort:** Small | **Risk:** Low (visual choice)

## Recommended Action
_Apply Option A — transparent stroke for scenario polygons, matching DeckGL's `stroked: false`._

## Technical Details
- **Affected files:** `src/components/GlobeMap.ts`
- **Grep:** `polygonStrokeColor` — find the callback and add the missing branch before the `conflict` case

## Acceptance Criteria
- [ ] `polygonStrokeColor` returns `'transparent'` (or no-stroke equivalent) when `d._kind === 'scenario'`
- [ ] No red border visible on Globe scenario overlay
- [ ] `npm run typecheck` passes

## Work Log
- 2026-04-10: Identified during /ce-review of PR #2910 (GlobeMap polygon rendering)

## Resources
- PR: #2910
