# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-18)

**Core value:** Every API integration is defined in a .proto file with generated type-safe TypeScript clients and server handlers, eliminating hand-written fetch boilerplate.
**Current focus:** Phase 2B: Server Runtime

## Current Position

Phase: 2B complete (Server Runtime)
Current Plan: 02 of 02 (all complete)
Status: Phase 2B complete — all plans executed
Last activity: 2026-02-18 -- Completed Plan 02 (catch-all gateway + Vite plugin)

Progress: [██████░░░░] ~35%

## Performance Metrics

**Completed Phases:**
- Phase 1: Proto Foundation (2 plans, 7min total)
- Phase 2A: All Domain Protos (1 session)
- Phase 2B Plan 01: Server Infrastructure (2 tasks, 2min, 4 files created)
- Phase 2B Plan 02: Gateway Integration (2 tasks, 2min, 2 files created, 2 files modified)

## Accumulated Context

### Decisions

- [2A]: Dropped dual-mode adapter approach entirely — no feature flags, no parity testing, direct migration per domain
- [2A]: 17 domains + core types (79 proto files total)
- [2A]: `enum_value` and `INT64_ENCODING_NUMBER` sebuf annotations not yet available in v0.6.0 — using plain enums and int64 for now
- [2A]: Enums follow existing TS union values as comments for future mapping
- [2A]: military_vessel.proto imports military_flight.proto for shared enums (MilitaryOperator, MilitaryConfidence, MilitaryActivityType)
- [2A]: No `oneof success/error` in responses — throw errors in handler, map with `onError`
- [2A]: All RPCs use POST, kebab-case paths under `/api/{domain}/v1/`
- [2A]: Test domain protos removed (served their Phase 1 purpose)
- [2B-01]: Defined RouteDescriptor locally in router.ts instead of importing from a generated file
- [2B-01]: Hardcoded CORS methods to 'POST, OPTIONS' since all sebuf routes are POST-only
- [2B-01]: Network/fetch errors detected via TypeError + message check for 502 upstream-down mapping
- [2B-02]: Dynamic imports in Vite plugin to lazily load handler modules inside configureServer
- [2B-02]: Separate tsconfig.api.json with empty types array to exclude vite/client from edge runtime code
- [2B-02]: sebufApiPlugin placed after youtubeLivePlugin in plugin array for correct middleware ordering

### Pending Todos

- None for Phase 2B (complete)

### Blockers/Concerns

- `int64` time fields generate as `string` in client code — will need sebuf INT64_ENCODING_NUMBER support or manual mapping
- @sentry/browser missing from dependencies (pre-existing, unrelated)

## Session Continuity

Last session: 2026-02-18
Stopped at: Completed 02-02-PLAN.md (catch-all gateway + Vite plugin) -- Phase 2B complete
Resume file: .planning/phases/02-server-runtime/02-CONTEXT.md
PR: #106 (draft) — https://github.com/koala73/worldmonitor/pull/106
Next steps: Phase 2C+ domain handler migration (one phase per domain)
