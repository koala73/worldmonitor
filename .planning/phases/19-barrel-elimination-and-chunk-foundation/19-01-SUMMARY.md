---
phase: 19-barrel-elimination-and-chunk-foundation
plan: 01
subsystem: infra
tags: [vite, rollup, manualChunks, barrel-file, code-splitting, bundle-optimization]

requires:
  - phase: none
    provides: existing barrel file and monolithic panels chunk
provides:
  - Direct imports for all panel consumers (no barrel indirection)
  - Variant-based panel chunk grouping (core, happy, finance, full, tech)
  - Foundation for Phase 20 dynamic import work
affects: [20-dynamic-panel-loading, vite-build, panel-loading]

tech-stack:
  added: []
  patterns: [variant-based-manual-chunks, direct-component-imports]

key-files:
  created: []
  modified:
    - src/app/panel-layout.ts
    - src/App.ts
    - src/app/search-manager.ts
    - src/app/data-loader.ts
    - src/app/event-handlers.ts
    - src/app/app-context.ts
    - vite.config.ts

key-decisions:
  - "Panels in 3+ variants assigned to core-panels; variant-specific panels to their own chunk"
  - "Non-Panel components (VirtualList, MapPopup, SignalModal, etc.) assigned to core-panels"
  - "Unassigned Panel files default to core-panels to avoid orphan chunks"
  - "Workbox maximumFileSizeToCacheInBytes bumped to 5 MiB temporarily until Phase 20 splits core-panels"

patterns-established:
  - "Direct imports: always import from '@/components/XxxPanel' not from '@/components' barrel"
  - "Variant chunk sets: CORE_PANEL_FILES, HAPPY_PANEL_FILES, FINANCE_PANEL_FILES, FULL_PANEL_FILES, TECH_PANEL_FILES in vite.config.ts"

requirements-completed: [BNDL-01, BNDL-05]

duration: 8min
completed: 2026-04-15
---

# Phase 19 Plan 01: Barrel Elimination and Chunk Foundation Summary

**Eliminated src/components/index.ts barrel file, converted 7 consumer files to direct imports, and split monolithic 2.2 MiB panels chunk into 5 variant-based chunks (core/happy/finance/full/tech)**

## Performance

- **Duration:** 8 min
- **Started:** 2026-04-15T12:21:00Z
- **Completed:** 2026-04-15T12:29:40Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- Deleted barrel file that forced all 93 panels into a single Rollup chunk
- Converted 7 consumer files (panel-layout.ts, App.ts, search-manager.ts, data-loader.ts, event-handlers.ts, app-context.ts, plus an inline type ref in panel-layout.ts) from barrel imports to direct imports
- Replaced catch-all `'panels'` manualChunks rule with 5 variant-based sets producing: core-panels (4.28 MB), full-panels (159 KB), finance-panels (94 KB), happy-panels (25 KB), tech-panels (22 KB)
- Vite build succeeds and produces all 5 expected chunk files

## Task Commits

Each task was committed atomically:

1. **Task 1: Convert all barrel consumers to direct imports and delete barrel file** - `c0f29a87` (feat)
2. **Task 2: Replace catch-all manualChunks panels rule with variant-based chunk grouping** - `de1ffbb6` (feat)

## Files Created/Modified
- `src/components/index.ts` - DELETED (barrel file eliminated)
- `src/app/panel-layout.ts` - 73 barrel imports replaced with 58 direct imports
- `src/App.ts` - 3 barrel imports replaced with direct imports
- `src/app/search-manager.ts` - 3 barrel imports + 1 inline type ref replaced with direct imports
- `src/app/data-loader.ts` - 2 barrel import blocks replaced with 20 direct imports
- `src/app/event-handlers.ts` - 2 barrel import blocks replaced with 7 direct imports
- `src/app/app-context.ts` - 10 inline barrel type references replaced with direct module paths
- `vite.config.ts` - Added 5 panel file sets and variant-based manualChunks logic

## Decisions Made
- Panels appearing in 3+ variants go to core-panels to avoid duplication across chunks
- Non-Panel components (VirtualList, MapPopup, SignalModal, etc.) assigned to core-panels since they are shared infrastructure
- Unassigned Panel files (e.g., CustomWidgetPanel, McpDataPanel) default to core-panels via fallback rule
- Workbox precache limit bumped from 4 MiB to 5 MiB temporarily (core-panels is 4.28 MB; Phase 20 dynamic imports will reduce it)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed barrel imports in app-context.ts (not listed in plan)**
- **Found during:** Task 1 (TypeScript check after initial conversions)
- **Issue:** app-context.ts uses inline `import('@/components').X` type references throughout the AppContext interface -- these also resolve through the barrel
- **Fix:** Converted all 10 inline barrel type references to direct module paths
- **Files modified:** src/app/app-context.ts
- **Verification:** `npx tsc --noEmit` passes with no barrel-related errors
- **Committed in:** c0f29a87 (Task 1 commit)

**2. [Rule 3 - Blocking] Fixed inline barrel type ref in panel-layout.ts line 1411**
- **Found during:** Task 1 (TypeScript check)
- **Issue:** `import('@/components').TimeRange` inline type reference on filterItemsByTimeRange method
- **Fix:** Changed to `import('@/components/MapContainer').TimeRange`
- **Files modified:** src/app/panel-layout.ts
- **Verification:** TypeScript check passes
- **Committed in:** c0f29a87 (Task 1 commit)

**3. [Rule 3 - Blocking] Bumped Workbox maximumFileSizeToCacheInBytes from 4 MiB to 5 MiB**
- **Found during:** Task 2 (vite build failed due to Workbox precache limit)
- **Issue:** core-panels chunk at 4.28 MB exceeds the existing 4 MiB Workbox limit
- **Fix:** Increased limit to 5 MiB with comment noting Phase 20 will reduce core-panels size
- **Files modified:** vite.config.ts
- **Verification:** vite build completes successfully with PWA service worker generated
- **Committed in:** de1ffbb6 (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (3 blocking)
**Impact on plan:** All auto-fixes necessary to complete the planned work. Two additional barrel consumer files were discovered beyond the 5 listed in the plan. No scope creep.

## Issues Encountered
None beyond the deviations documented above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Barrel file eliminated -- Rollup can now tree-shake individual panel modules independently
- Variant-based chunks are in place, ready for Phase 20 dynamic import conversion
- core-panels (4.28 MB) is the largest chunk and primary target for Phase 20 splitting
- All direct import paths established as the pattern going forward

---
*Phase: 19-barrel-elimination-and-chunk-foundation*
*Completed: 2026-04-15*
