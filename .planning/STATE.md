# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-18)

**Core value:** Every API integration is defined in a .proto file with generated type-safe TypeScript clients and server handlers, eliminating hand-written fetch boilerplate.
**Current focus:** Phase 2C: Seismology Migration

## Current Position

Phase: 2C (Seismology Migration)
Current Plan: 00 of 00 (context gathered, not yet planned)
Status: Phase 2C context gathered — ready for planning
Last activity: 2026-02-18 -- Phase 2C context captured (discuss-phase)

Progress: [██████░░░░] ~35%

## Performance Metrics

**Completed Phases:**
- Phase 1: Proto Foundation (2 plans, 7min total)
- Phase 2A: All Domain Protos (1 session)
- Phase 2B Plan 01: Server Infrastructure (2 tasks, 2min, 4 files created)
- Phase 2B Plan 02: Gateway Integration (2 tasks, 2min, 2 files created, 2 files modified)
- Phase 2B Plan 03: Sidecar Sebuf Bundle (2 tasks, 3min, 1 file created, 4 files modified)

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
- [2B-03]: esbuild over tsc for bundling: tsc produces per-file .js output, sidecar needs single self-contained module
- [2B-03]: Gitignore bracket escaping: used [[] character class pattern since backslash escaping is unreliable for brackets

### Pending Todos

- None for Phase 2B (complete)

### Blockers/Concerns

- `int64` time fields generate as `string` in client code — will need sebuf INT64_ENCODING_NUMBER support or manual mapping
- @sentry/browser missing from dependencies (pre-existing, unrelated)

## Session Continuity

Last session: 2026-02-18
Stopped at: Phase 2C context gathered — ready for planning
Resume file: .planning/phases/2C-seismology-migration/2C-CONTEXT.md
PR: #106 (draft) — https://github.com/koala73/worldmonitor/pull/106
Next steps: /gsd:plan-phase 2C → research + plan seismology migration
