---
status: complete
priority: p1
issue_id: "036"
tags: [code-review, bug, map, legend]
dependencies: []
---

# Legend `layerToLabels` keys don't match `MapLayers` — feature is near-complete no-op

## Problem Statement
`updateLegendVisibility()` in PR #2370 builds a `layerToLabels` map using wrong key names.
13 of 17 keys don't exist on `MapLayers`, so `this.state.layers[key]` is always `undefined` (falsy).
The method silently marks no labels as visible and hides every legend item on the tech/finance variants.

## Findings

Wrong keys vs actual `MapLayers` keys (from `src/types/index.ts`):

| Key in PR | Actual MapLayers key |
|---|---|
| `startupHub` | `startupHubs` |
| `techHQ` | `techHQs` |
| `accelerator` | `accelerators` |
| `cloudRegion` | `cloudRegions` |
| `datacenter` | `datacenters` |
| `stockExchange` | `stockExchanges` |
| `financialCenter` | `financialCenters` |
| `centralBank` | `centralBanks` |
| `commodityHub` | `commodityHubs` |
| `waterway` | `waterways` |
| `aircraft` | `flights` |
| `naturalEvents` | `natural` |
| `conflictZones` | `conflicts` |
| `aiDataCenters` | doesn't exist at all |

Only `techEvents`, `cyberThreats`, `positiveEvents`, `nuclear` are correct.

Also: the type `Record<string, string[]>` with `layer as keyof MapLayers` cast suppresses the TS error
instead of catching it. Should be `Partial<Record<keyof MapLayers, string[]>>`.

## Proposed Solutions

### Option A: Fix key names in the PR (Quick fix)
Fix all 13 wrong keys, remove `aiDataCenters` (not in MapLayers), change type to `Partial<Record<keyof MapLayers, string[]>>`.

**Pros:** Minimal change, contributor can fix
**Cons:** Still has the i18n breakage (see todo 037), still duplicates LAYER_REGISTRY
**Effort:** Small | **Risk:** Low

### Option B: Replace text-matching with `data-legend-layer` attributes (Recommended)
In `createLegend()`, add `data-legend-layer="${layerKey}"` to each `<span class="legend-item">`.
`updateLegendVisibility()` then uses `item.dataset.legendLayer` for direct `MapLayers` lookup.
Eliminates both the key mismatch AND the i18n problem in one move.

**Pros:** Locale-independent, no parallel string table, future-proof
**Cons:** Requires touching `createLegend()` template
**Effort:** Small-Medium | **Risk:** Low

## Recommended Action
Option B. Stamp `data-legend-layer` at creation, eliminate the string map entirely.

## Technical Details
- File: `src/components/DeckGLMap.ts`
- Method: `updateLegendVisibility()` (new, PR #2370) and `createLegend()` (line ~4494)
- PR: koala73/worldmonitor#2370

## Acceptance Criteria
- [ ] All legend items show/hide correctly when toggling layers on tech, finance, full, happy variants
- [ ] TypeScript compiles without casts to `keyof MapLayers`
- [ ] Works with any SITE_VARIANT

## Work Log
- 2026-03-27: Identified during PR #2370 review via architecture-strategist + kieran-typescript-reviewer agents
