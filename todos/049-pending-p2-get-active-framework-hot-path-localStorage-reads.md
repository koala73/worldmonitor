---
status: pending
priority: p2
issue_id: "049"
tags: [code-review, performance, analytical-frameworks]
dependencies: []
---

# `getActiveFrameworkForPanel` does 2 localStorage reads + JSON parse on every call — hot path issue

## Problem Statement
`getActiveFrameworkForPanel()` in `analysis-framework-store.ts` performs 2 synchronous `localStorage.getItem()` calls plus 2 `JSON.parse()` calls on every invocation: one for `PANEL_KEY` (the per-panel selections) and one inside `loadFrameworkLibrary()` for `LIBRARY_KEY` (the full library including up to 20 imported frameworks). This function is called in `InsightsPanel.updateFromClient()` on every cluster update — a hot path. On low-end mobile browsers, synchronous localStorage reads can block the main thread.

## Findings
- **`src/services/analysis-framework-store.ts:141-147`** — `getActiveFrameworkForPanel`: 2 localStorage reads
- **`src/components/InsightsPanel.ts`** — calls `getActiveFrameworkForPanel('insights')` inside `updateFromClient()` (hot path)
- **`src/components/FrameworkSelector.ts:30`** — calls `getActiveFrameworkForPanel()` in constructor and `refresh()`
- Flagged by: performance-oracle

## Proposed Solutions

### Option A: Module-level in-memory cache (Recommended)
Cache the active framework per panel in a module-level Map, invalidated only when `setActiveFrameworkForPanel()` or `deleteImportedFramework()` is called:
```ts
const _activeFrameworkCache = new Map<AnalysisPanelId, AnalysisFramework | null>();

export function setActiveFrameworkForPanel(panelId, frameworkId) {
  _activeFrameworkCache.delete(panelId); // invalidate
  // ... existing save logic
}

export function getActiveFrameworkForPanel(panelId) {
  if (!hasPremiumAccess()) return null;
  if (_activeFrameworkCache.has(panelId)) return _activeFrameworkCache.get(panelId)!;
  // ... existing slow path, then cache result
  _activeFrameworkCache.set(panelId, result);
  return result;
}
```
**Pros:** O(1) on cache hit, zero localStorage reads | **Effort:** Small | **Risk:** Low

### Option B: Read both keys together in one pass
Merge `loadFromStorage(PANEL_KEY)` and `loadFrameworkLibrary()` into a single function that reads both keys in one initialization step.
**Pros:** Reduces from 2 reads to 1 read per cold call | **Cons:** Still reads on every call | **Effort:** Small | **Risk:** Low

## Technical Details
- File: `src/services/analysis-framework-store.ts`
- PR: koala73/worldmonitor#2380

## Acceptance Criteria
- [ ] `getActiveFrameworkForPanel()` makes zero localStorage calls after the first call per panel
- [ ] Cache is invalidated when selection changes (setActiveFrameworkForPanel) or framework is deleted
- [ ] No regression in framework change propagation to UI

## Work Log
- 2026-03-27: Identified during PR #2380 review by performance-oracle
