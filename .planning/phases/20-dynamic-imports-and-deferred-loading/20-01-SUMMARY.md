---
phase: 20-dynamic-imports-and-deferred-loading
plan: 01
subsystem: ui
tags: [sentry, requestIdleCallback, IntersectionObserver, skeleton-placeholder, lazy-loading, code-splitting]

# Dependency graph
requires:
  - phase: 19-barrel-elimination-and-chunk-foundation
    provides: "manualChunks grouping, variant-based panel chunks, sentry chunk separation"
provides:
  - "Deferred Sentry init via requestIdleCallback with pre-init error buffer"
  - "IntersectionObserver-gated lazyPanel() with skeleton placeholders"
  - "defaultRowSpan on PanelConfig for CLS-safe skeleton sizing"
  - "Skeleton shimmer CSS for panel loading states"
  - "triggerPanelLoad() public method for settings re-enable"
affects: [20-02-PLAN, panel-layout, main-entry-bundle]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Deferred SDK init: requestIdleCallback + dynamic import() + error buffer flush"
    - "Viewport-gated lazy loading: shared IntersectionObserver + skeleton placeholder + replaceWith"
    - "CLS prevention: defaultRowSpan from config + saved localStorage spans on skeleton elements"

key-files:
  created: []
  modified:
    - "src/main.ts"
    - "src/config/panels.ts"
    - "src/types/index.ts"
    - "src/styles/main.css"
    - "src/app/panel-layout.ts"

key-decisions:
  - "Used any type for Sentry beforeSend to avoid static import dependency on @sentry/browser"
  - "Added defaultRowSpan: 2 to 17 panels (actual constructor defaults) rather than the plan's 12"
  - "Used definite assignment assertion (!) for lazyObserver since it is initialized in init()"

patterns-established:
  - "Deferred SDK pattern: error buffer -> requestIdleCallback -> dynamic import -> flush -> restore handlers"
  - "Skeleton placeholder pattern: createSkeleton -> insertByOrder -> observe -> triggerLoad -> replaceWith"
  - "Shared IntersectionObserver pattern: single observer instance watching all skeleton elements"

requirements-completed: [BNDL-04]

# Metrics
duration: 17min
completed: 2026-04-15
---

# Phase 20 Plan 01: Deferred Loading Infrastructure Summary

**Sentry deferred to requestIdleCallback with error buffer, lazyPanel() enhanced with IntersectionObserver viewport gating and skeleton shimmer placeholders, defaultRowSpan added to 17 panel configs**

## Performance

- **Duration:** 17 min
- **Started:** 2026-04-15T14:10:19Z
- **Completed:** 2026-04-15T14:27:27Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Sentry SDK removed from synchronous imports -- loads via dynamic import() triggered by requestIdleCallback (3s timeout) with setTimeout(1s) fallback
- Pre-Sentry error buffer captures up to 20 errors via window.onerror/onunhandledrejection, flushes all to Sentry.captureException() on init
- lazyPanel() now creates skeleton placeholders with shimmer animation, inserts them into the grid, and uses a shared IntersectionObserver (200px margin) to trigger dynamic imports only when visible
- defaultRowSpan added to PanelConfig type and 17 panel definitions across all variant configs for CLS-safe skeleton sizing
- triggerPanelLoad() public method enables immediate loading when user re-enables a panel in settings

## Task Commits

Each task was committed atomically:

1. **Task 1: Defer Sentry to requestIdleCallback with error buffer** - `d8da6096` (feat)
2. **Task 2: Add defaultRowSpan, skeleton CSS, IntersectionObserver-gated lazyPanel** - `c1ad2706` (feat)

## Files Created/Modified
- `src/main.ts` - Removed eager Sentry import, added error buffer, deferred init via requestIdleCallback + dynamic import
- `src/types/index.ts` - Added defaultRowSpan?: number to PanelConfig interface
- `src/config/panels.ts` - Added defaultRowSpan: 2 to 17 panel configs across FULL, TECH, FINANCE, COMMODITY variants
- `src/styles/main.css` - Added .panel-skeleton, .skeleton-shimmer, @keyframes skeleton-shimmer CSS
- `src/app/panel-layout.ts` - Added shared IntersectionObserver, createSkeleton(), refactored lazyPanel() with viewport gating, added triggerPanelLoad()

## Decisions Made
- **Sentry beforeSend typed as `any`:** The Sentry ErrorEvent type cannot be imported without creating a static dependency on @sentry/browser (defeating the lazy load). Used `any` with a local `_SentryFrame` interface for stack frame typing. This is safe because the function is only passed to Sentry.init() inside the dynamic import callback.
- **17 panels with defaultRowSpan (not 12):** The plan listed 12 panels but actual codebase analysis found 17 panel constructors that pass defaultRowSpan: 2. Added it to all 17 for accuracy: cii, strategic-posture, gdelt-intel, economic, trade-policy, supply-chain, sanctions-pressure, energy-complex, oil-inventories, chat-analyst, energy-crisis, consumer-prices, ucdp-events, displacement, security-advisories, telegram-intel, internet-disruptions.
- **Definite assignment assertion for lazyObserver:** Used `private lazyObserver!: IntersectionObserver` since it is always initialized in init() which is called before any panel creation.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed TypeScript implicit any errors in beforeSend filter**
- **Found during:** Task 1 (Sentry deferral)
- **Issue:** Extracting beforeSend as a standalone function with `any` event parameter caused implicit `any` errors on all frame callback parameters (22 errors)
- **Fix:** Added `_SentryFrame` interface and explicit type annotations for `frames: _SentryFrame[]`, `msg: string`, `excType: string`
- **Files modified:** src/main.ts
- **Verification:** npx tsc --noEmit passes
- **Committed in:** d8da6096 (Task 1 commit)

**2. [Rule 1 - Bug] Added 5 additional panels with defaultRowSpan: 2**
- **Found during:** Task 2 (defaultRowSpan addition)
- **Issue:** Plan listed 12 panels but codebase grep found 17 panels with defaultRowSpan: 2 in their constructors. Missing: chat-analyst, oil-inventories, consumer-prices, energy-crisis, internet-disruptions
- **Fix:** Added defaultRowSpan: 2 to all 17 panels across all variant configs where they appear
- **Files modified:** src/config/panels.ts
- **Verification:** Grep confirms all 17 panels have defaultRowSpan in config
- **Committed in:** c1ad2706 (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (2 bugs)
**Impact on plan:** Both fixes necessary for correctness. The type fix was required for compilation. The additional panels ensure skeleton sizing matches actual runtime behavior. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 02 can now convert all remaining eager panel imports to use the enhanced lazyPanel() with viewport gating
- The lazyPanel() signature is unchanged -- existing ~27 lazyPanel() calls automatically get IntersectionObserver gating
- Sentry chunk (431KB) is now a separate lazy-loaded chunk, not in the initial bundle graph from main.ts
- Main chunk increased slightly (446KB -> 448KB) due to error buffer + deferred init boilerplate
- All 17 panels with defaultRowSpan: 2 in their constructors now have matching config for skeleton sizing

---
*Phase: 20-dynamic-imports-and-deferred-loading*
*Completed: 2026-04-15*
