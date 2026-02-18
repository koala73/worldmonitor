---
phase: 02-server-runtime
plan: 01
subsystem: api
tags: [typescript, web-standards, cors, routing, usgs, edge-runtime, sebuf]

# Dependency graph
requires:
  - phase: 02A-domain-protos
    provides: Generated SeismologyServiceHandler interface, RouteDescriptor, ServerOptions, ApiError types
provides:
  - Map-based route matcher (createRouter) for generated RouteDescriptor arrays
  - CORS header generation (getCorsHeaders, isDisallowedOrigin) ported from api/_cors.js
  - Error-to-HTTP-response mapper (mapErrorToResponse) for ServerOptions.onError
  - SeismologyServiceHandler implementation proxying USGS earthquake API
affects: [02-server-runtime-plan-02, catch-all-gateway, vite-plugin, domain-handlers]

# Tech tracking
tech-stack:
  added: []
  patterns: [web-standard-request-response, map-based-routing, upstream-proxy-handler]

key-files:
  created:
    - api/server/router.ts
    - api/server/cors.ts
    - api/server/error-mapper.ts
    - api/server/worldmonitor/seismology/v1/handler.ts
  modified: []

key-decisions:
  - "Defined RouteDescriptor locally in router.ts instead of importing from a generated file, avoiding coupling to any specific domain"
  - "Hardcoded CORS methods to 'POST, OPTIONS' since all sebuf routes are POST-only"
  - "Network/fetch errors detected via TypeError + message check for 502 upstream-down mapping"

patterns-established:
  - "Handler pattern: implement generated XxxServiceHandler interface, proxy upstream API, transform to proto-shaped response"
  - "CORS pattern: identical ALLOWED_ORIGIN_PATTERNS in cors.ts and _cors.js, TS version for sebuf, JS version for legacy"
  - "Error mapping pattern: ApiError with statusCode for upstream errors, TypeError for network errors, catch-all for unknowns"

requirements-completed: [SERVER-01, SERVER-02, SERVER-06]

# Metrics
duration: 2min
completed: 2026-02-18
---

# Phase 2B Plan 01: Server Infrastructure Summary

**Map-based router, CORS port, error mapper, and seismology handler implementing generated SeismologyServiceHandler against USGS GeoJSON API**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-18T13:21:02Z
- **Completed:** 2026-02-18T13:23:00Z
- **Tasks:** 2
- **Files created:** 4

## Accomplishments
- Built three shared server infrastructure modules (router, CORS, error mapper) using only Web Standard APIs
- Implemented first domain handler (seismology) proving the generated interface can be implemented to proxy upstream APIs
- All four files typecheck cleanly with strict TypeScript

## Task Commits

Each task was committed atomically:

1. **Task 1: Create shared server infrastructure (router, CORS, error mapper)** - `b650005` (feat)
2. **Task 2: Implement seismology handler as first end-to-end proof** - `e1c0682` (feat)

## Files Created/Modified
- `api/server/router.ts` - Map-based route matcher from RouteDescriptor[] arrays; createRouter returns { match(req) } interface
- `api/server/cors.ts` - TypeScript port of api/_cors.js with identical ALLOWED_ORIGIN_PATTERNS; POST/OPTIONS methods
- `api/server/error-mapper.ts` - onError callback handling ApiError (statusCode), network errors (502), unknown (500)
- `api/server/worldmonitor/seismology/v1/handler.ts` - SeismologyServiceHandler implementation; fetches USGS 4.5_day GeoJSON, maps features to Earthquake[]

## Decisions Made
- Defined `RouteDescriptor` interface locally in `router.ts` instead of importing from a generated file -- avoids coupling router to any specific domain's generated types while remaining structurally compatible
- Hardcoded CORS methods to `'POST, OPTIONS'` since all sebuf routes are POST-only (unlike `_cors.js` which takes methods as parameter)
- Used `TypeError` message check containing "fetch" for upstream-down detection (502) -- this covers both `fetch failed` and similar network errors in edge runtimes

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- All four modules ready to be wired into the catch-all gateway (Plan 02)
- Router accepts any `RouteDescriptor[]` array -- just spread all `createXxxServiceRoutes()` results
- CORS headers ready to wrap all gateway responses
- Error mapper ready as `ServerOptions.onError` callback
- Seismology handler proves the pattern works end-to-end

## Self-Check: PASSED

All 4 files verified on disk. Both commit hashes (b650005, e1c0682) verified in git log.

---
*Phase: 02-server-runtime*
*Completed: 2026-02-18*
