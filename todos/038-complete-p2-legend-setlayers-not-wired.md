---
status: complete
priority: p2
issue_id: "038"
tags: [code-review, bug, map, legend]
dependencies: ["036"]
---

# `setLayers()`, `enableLayer()`, `toggleLayer()` don't call `updateLegendVisibility()`

## Problem Statement
`updateLegendVisibility()` is only called from the checkbox `change` handler.
The programmatic mutation paths `setLayers()` (line 4653), `enableLayer()`, and `toggleLayer()`
don't call it, so the legend stays stale after any programmatic layer change
(e.g. URL state restore, panel preset, layer limit enforcement).

## Proposed Solutions

### Option A: Add call sites
Call `updateLegendVisibility()` at the end of `setLayers()`, `enableLayer()`, `toggleLayer()`.

**Effort:** Small | **Risk:** Low

## Technical Details
- File: `src/components/DeckGLMap.ts`
- `setLayers()` line ~4653
- PR: koala73/worldmonitor#2370

## Acceptance Criteria
- [ ] Legend updates when layers are changed programmatically (URL restore, presets)

## Work Log
- 2026-03-27: Identified during PR #2370 review
