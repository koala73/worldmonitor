---
phase: 02-server-runtime
plan: 02
subsystem: api
tags: [typescript, vercel-edge, vite-plugin, cors, catch-all-gateway, sebuf]

# Dependency graph
requires:
  - phase: 02-server-runtime-plan-01
    provides: Router (createRouter), CORS (getCorsHeaders, isDisallowedOrigin), error mapper (mapErrorToResponse), seismology handler
  - phase: 02A-domain-protos
    provides: Generated createSeismologyServiceRoutes, ServerOptions, RouteDescriptor types
provides:
  - Vercel catch-all edge function (api/[[...path]].ts) mounting all sebuf routes with CORS
  - Vite dev server plugin (sebufApiPlugin) intercepting /api/{domain}/v1/* in local dev
  - TypeScript config for api/ directory (tsconfig.api.json) with typecheck:api script
affects: [domain-handler-additions, production-deployment, tauri-sidecar]

# Tech tracking
tech-stack:
  added: []
  patterns: [vercel-catch-all-edge-function, vite-middleware-plugin-with-web-request-conversion, separate-tsconfig-for-edge-runtime]

key-files:
  created:
    - api/[[...path]].ts
    - tsconfig.api.json
  modified:
    - vite.config.ts
    - package.json

key-decisions:
  - "Used dynamic imports in Vite plugin to lazily load handler modules inside configureServer, avoiding module resolution issues at config load time"
  - "Separate tsconfig.api.json with empty types array to exclude vite/client types from edge runtime code"
  - "sebufApiPlugin placed after youtubeLivePlugin but before VitePWA in plugin array for correct middleware ordering"

patterns-established:
  - "Gateway pattern: catch-all mounts all domain routes via spread, each domain adds createXxxServiceRoutes() call"
  - "Vite dev plugin pattern: regex match /api/{domain}/v1/*, convert Connect req to Web Request, run same handler pipeline"
  - "CORS everywhere pattern: every response path (200, 204, 403, 404) gets CORS headers merged in"

requirements-completed: [SERVER-03, SERVER-04, SERVER-05]

# Metrics
duration: 2min
completed: 2026-02-18
---

# Phase 2B Plan 02: Gateway Integration Summary

**Vercel catch-all edge function and Vite dev plugin wiring all sebuf routes end-to-end with CORS on every response path**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-18T13:27:11Z
- **Completed:** 2026-02-18T13:29:23Z
- **Tasks:** 2
- **Files created:** 2
- **Files modified:** 2

## Accomplishments
- Created Vercel catch-all edge function mounting seismology routes with CORS, origin checking, and 404 handling
- Added Vite dev server plugin that intercepts sebuf API requests and converts Connect IncomingMessage to Web Standard Request
- Set up separate tsconfig.api.json to type-check api/ files without Vite client types
- Verified end-to-end: POST returns USGS earthquake data, OPTIONS returns 204 with CORS, disallowed origins get 403, unknown routes get 404

## Task Commits

Each task was committed atomically:

1. **Task 1: Create Vercel catch-all gateway and tsconfig for api/** - `b680411` (feat)
2. **Task 2: Add Vite dev server plugin for sebuf API routes** - `dfeff7d` (feat)

## Files Created/Modified
- `api/[[...path]].ts` - Vercel catch-all edge function; static imports of router, CORS, error mapper, and seismology routes; CORS headers on all response paths
- `tsconfig.api.json` - Extends base tsconfig with empty types array and includes api/ + src/generated/
- `vite.config.ts` - Added sebufApiPlugin() Vite plugin intercepting /api/{domain}/v1/* with lazy dynamic imports
- `package.json` - Added typecheck:api script

## Decisions Made
- Used dynamic `import()` inside Vite plugin's `configureServer` hook rather than static top-level imports -- vite.config.ts loads before the dev server starts, and the handler modules may not resolve cleanly at config load time
- Created tsconfig.api.json with `"types": []` to override the base config's `"types": ["vite/client"]` -- edge runtime code shouldn't reference Vite client types
- Placed `sebufApiPlugin()` after `youtubeLivePlugin()` in the plugins array -- sebuf plugin only intercepts `/api/{domain}/v1/*`, so the YouTube live handler (which checks `/api/youtube/live`) runs first and is unaffected

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Full end-to-end sebuf pipeline working: HTTP request through catch-all gateway to seismology handler and back
- Adding new domain handlers requires only: (1) implement the generated handler interface, (2) add `...createXxxServiceRoutes()` to allRoutes in both api/[[...path]].ts and sebufApiPlugin
- Tauri sidecar automatically picks up the new catch-all (no sidecar changes needed)
- Phase 2B server runtime is complete

## Self-Check: PASSED

All 2 created files and 2 modified files verified on disk. Both commit hashes (b680411, dfeff7d) verified in git log.

---
*Phase: 02-server-runtime*
*Completed: 2026-02-18*
