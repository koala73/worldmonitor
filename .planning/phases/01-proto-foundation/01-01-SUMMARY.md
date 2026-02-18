---
phase: 01-proto-foundation
plan: 01
subsystem: api
tags: [buf, protobuf, sebuf, protovalidate, typescript-codegen, openapi]

# Dependency graph
requires: []
provides:
  - "Buf module configuration (buf.yaml, buf.gen.yaml, buf.lock) with lint/breaking rules and sebuf/protovalidate deps"
  - "Shared core proto types: GeoCoordinates, BoundingBox, TimeRange, PaginationRequest/Response, LocalizableString, HotspotID, EventID, ProviderID, GeneralError with RateLimited/UpstreamDown/GeoBlocked/MaintenanceMode subtypes"
  - "Proto directory structure: proto/worldmonitor/{domain}/v1/ with core/v1/ for shared types"
affects: [01-02, environmental, geopolitical, weather, markets, health, infrastructure, news]

# Tech tracking
tech-stack:
  added: [buf-cli-1.64.0, buf.build/bufbuild/protovalidate, buf.build/sebmelki/sebuf, protoc-gen-ts-client, protoc-gen-ts-server, protoc-gen-openapiv3]
  patterns: [buf-v2-module-config, worldmonitor-proto-directory-structure, typed-id-wrappers, oneof-error-subtypes, cursor-based-pagination]

key-files:
  created:
    - proto/buf.yaml
    - proto/buf.gen.yaml
    - proto/buf.lock
    - proto/worldmonitor/core/v1/geo.proto
    - proto/worldmonitor/core/v1/time.proto
    - proto/worldmonitor/core/v1/pagination.proto
    - proto/worldmonitor/core/v1/i18n.proto
    - proto/worldmonitor/core/v1/identifiers.proto
    - proto/worldmonitor/core/v1/general_error.proto
  modified: []

key-decisions:
  - "buf.yaml at proto/ subdirectory (not project root) -- keeps proto tooling self-contained"
  - "OpenAPI output to docs/api/ (not docs/) -- avoids mixing with existing documentation files"
  - "LocalizableString as simple value+language pair -- WorldMonitor receives pre-localized strings, no full translation system needed"
  - "protoc-gen-ts-server installed from local source (post-v0.6.0) -- not yet released in a tagged version"

patterns-established:
  - "Proto package worldmonitor.{domain}.v1 maps to proto/worldmonitor/{domain}/v1/ directory"
  - "Typed ID wrappers with required+min_len+max_len+example protovalidate annotations for cross-domain references"
  - "GeneralError with oneof error_type for app-wide error conditions, each subtype as separate message"
  - "STANDARD+COMMENTS lint and FILE+PACKAGE+WIRE_JSON breaking change rules"

requirements-completed: [PROTO-01, PROTO-02, PROTO-03]

# Metrics
duration: 4min
completed: 2026-02-18
---

# Phase 1 Plan 1: Buf Toolchain and Core Proto Types Summary

**Buf v2 module with STANDARD+COMMENTS lint, 6 shared core proto types (geo, time, pagination, i18n, identifiers, general_error) passing buf lint and buf build cleanly**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-18T11:31:45Z
- **Completed:** 2026-02-18T11:35:53Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments
- Buf toolchain fully configured with v2 module format, STANDARD+COMMENTS lint rules, FILE+PACKAGE+WIRE_JSON breaking change detection, and dependencies on protovalidate and sebuf
- Six core proto files created at `proto/worldmonitor/core/v1/` with all messages, fields, and enums properly documented (COMMENTS lint rule)
- Code generation pipeline configured for TypeScript client, TypeScript server, and OpenAPI v3 (JSON + YAML) output
- All proto files pass `buf lint` with zero errors and `buf build` succeeds

## Task Commits

Each task was committed atomically:

1. **Task 1: Create buf.yaml and buf.gen.yaml configuration** - `f12e3b9` (chore)
2. **Task 2: Create shared core proto type definitions** - `88b2d71` (feat)

## Files Created/Modified
- `proto/buf.yaml` - Buf v2 module config with lint rules, breaking change detection, and deps
- `proto/buf.gen.yaml` - Code generation plugin config for ts-client, ts-server, and openapiv3
- `proto/buf.lock` - Resolved dependency versions for protovalidate and sebuf
- `proto/worldmonitor/core/v1/geo.proto` - GeoCoordinates (lat/lng with validation) and BoundingBox
- `proto/worldmonitor/core/v1/time.proto` - TimeRange with google.protobuf.Timestamp
- `proto/worldmonitor/core/v1/pagination.proto` - Cursor-based PaginationRequest and PaginationResponse
- `proto/worldmonitor/core/v1/i18n.proto` - LocalizableString for pre-localized upstream API strings
- `proto/worldmonitor/core/v1/identifiers.proto` - Typed ID wrappers: HotspotID, EventID, ProviderID
- `proto/worldmonitor/core/v1/general_error.proto` - GeneralError with RateLimited, UpstreamDown, GeoBlocked, MaintenanceMode subtypes

## Decisions Made
- **buf.yaml placement:** Placed at `proto/buf.yaml` (not project root) to keep proto tooling self-contained. Commands run as `cd proto && buf lint`.
- **OpenAPI output directory:** `docs/api/` (not `docs/`) to avoid mixing generated API specs with existing documentation files.
- **LocalizableString design:** Simple `value` + `language` pair instead of anghamna's `MultilingualString` with repeated translations, because WorldMonitor receives pre-localized strings from upstream APIs.
- **protoc-gen-ts-server installation:** Installed from local sebuf source rather than `go install @v0.6.0` because the ts-server plugin was added after the v0.6.0 tag.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] protoc-gen-ts-server not available at v0.6.0**
- **Found during:** Task 1 (tool verification)
- **Issue:** `protoc-gen-ts-server` was added to sebuf after the v0.6.0 release; `go install ...@v0.6.0` fails with "does not contain package"
- **Fix:** Installed from local sebuf source at `/Users/sebastienmelki/Documents/documents_sebastiens_mac_mini/Workspace/kompani/sebuf.nosync` using `go install ./cmd/protoc-gen-ts-server/`
- **Files modified:** None (binary installed to GOBIN)
- **Verification:** `which protoc-gen-ts-server` succeeds
- **Committed in:** N/A (tool installation, not code change)

**2. [Rule 3 - Blocking] buf dep update requires at least one proto file**
- **Found during:** Task 1 (buf dep update)
- **Issue:** `buf dep update` fails with "Module had no .proto files" when run on an empty proto directory
- **Fix:** Created the core/v1/ directory and a minimal geo.proto before running buf dep update, then replaced it with the full version in Task 2
- **Files modified:** proto/worldmonitor/core/v1/geo.proto (temporary, replaced in Task 2)
- **Verification:** buf dep update completed successfully, buf.lock generated
- **Committed in:** f12e3b9 (part of Task 1 commit)

---

**Total deviations:** 2 auto-fixed (2 blocking)
**Impact on plan:** Both auto-fixes necessary to unblock execution. No scope creep.

## Issues Encountered
None beyond the deviations documented above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Core proto types are ready for import by domain service definitions
- buf.gen.yaml is configured; `buf generate` will produce TypeScript client/server and OpenAPI once domain services with RPCs are defined (Plan 01-02)
- protoc-gen-ts-server should be included in the next sebuf release to avoid local source installation

## Self-Check: PASSED

- All 9 created files verified on disk
- Commits f12e3b9 (Task 1) and 88b2d71 (Task 2) confirmed in git log
- buf lint passes, buf build succeeds

---
*Phase: 01-proto-foundation*
*Completed: 2026-02-18*
