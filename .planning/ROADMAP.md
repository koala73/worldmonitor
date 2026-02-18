# Roadmap: WorldMonitor Sebuf Integration

## Overview

This roadmap migrates WorldMonitor's 80+ ad-hoc fetch-based service modules to sebuf-powered, proto-defined domain services. The migration proceeds in strict dependency order: proto toolchain and shared types first, then dual-mode migration infrastructure, then domain-by-domain migration starting with the simplest (Environmental) and progressing through complex cases (Markets, Geopolitical, Military, News), with server runtime infrastructure built once the client-side pipeline is proven. Legacy code removal is a first-class deliverable, not an afterthought. Throughout the entire migration the app remains fully operational -- dual-mode adapters ensure existing HTTP calls work alongside new sebuf clients until parity is verified and legacy code is explicitly deleted.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Proto Foundation** - Buf toolchain, shared types, and code generation pipeline
- [ ] **Phase 2: Dual-Mode Infrastructure** - Migration adapters, feature flags, circuit breaker wrapping, parity harness
- [ ] **Phase 3: Environmental Domain Migration** - First full end-to-end domain migration proving the entire pipeline
- [ ] **Phase 4: Server Runtime** - Generated server handlers and deployment adapters for Vite, Vercel, and Tauri
- [ ] **Phase 5: Markets Domain Migration** - Complex multi-provider domain proving hard migration cases
- [ ] **Phase 6: Simple Domain Batch** - Cyber, Economic, Research, and Infrastructure domains migrated
- [ ] **Phase 7: Complex Domain Batch** - Geopolitical, Military, and News domains migrated
- [ ] **Phase 8: Legacy Removal** - Dual-mode scaffolding removed, types consolidated, legacy code deleted

## Phase Details

### Phase 1: Proto Foundation
**Goal**: A working proto-to-TypeScript code generation pipeline exists with shared domain types that all subsequent domain protos can import
**Depends on**: Nothing (first phase)
**Requirements**: PROTO-01, PROTO-02, PROTO-03, PROTO-04, PROTO-05
**Success Criteria** (what must be TRUE):
  1. Running `buf generate` produces TypeScript client files and server handler interfaces in the expected output directories with zero errors
  2. Shared proto messages (GeoCoordinates, TimeRange, PaginationRequest/Response, ErrorResponse) are importable by a test domain proto file
  3. Proto directory structure follows the sebuf multi-service pattern (proto/models/ for shared types, proto/services/{domain}/v1/ for services)
  4. OpenAPI v3 spec is auto-generated from proto definitions and viewable
  5. `buf lint` passes on all proto files with zero warnings
**Plans**: TBD

Plans:
- [ ] 01-01: TBD
- [ ] 01-02: TBD

### Phase 2: Dual-Mode Infrastructure
**Goal**: Any domain can be switched between legacy fetch calls and sebuf clients at runtime via feature flags, with circuit breaker protection preserved and a parity test harness ready
**Depends on**: Phase 1
**Requirements**: MIGRATE-01, MIGRATE-02, MIGRATE-03, MIGRATE-04, MIGRATE-05, CLIENT-03
**Success Criteria** (what must be TRUE):
  1. A dual-mode adapter module exists that routes calls to either legacy service or sebuf client based on a feature flag, with no behavioral change when the flag defaults to legacy
  2. Per-domain feature flags (e.g., sebufEnvironmental, sebufMarkets) are registered in RuntimeFeatureId and controllable at runtime
  3. Generated sebuf clients accept a custom fetch function, enabling circuit breaker wrapping via the existing createCircuitBreaker utility
  4. A parity test harness can call both legacy and sebuf paths for any domain and report response differences
  5. Persistent cache layer (IndexedDB/localStorage) works transparently with sebuf client responses without serialization changes
**Plans**: TBD

Plans:
- [ ] 02-01: TBD
- [ ] 02-02: TBD

### Phase 3: Environmental Domain Migration
**Goal**: The Environmental domain (earthquakes, fires, cyclones, natural events) is fully migrated from legacy fetch to sebuf client, proving the end-to-end pipeline from proto definition through generated client to production use
**Depends on**: Phase 2
**Requirements**: DOMAIN-01, DOMAIN-10, CLIENT-01, CLIENT-02, CLIENT-04
**Success Criteria** (what must be TRUE):
  1. Environmental proto file defines RPCs with HTTP annotations for USGS earthquakes, NASA FIRMS fires, GDACS cyclones, and EONET natural events
  2. Generated TypeScript sebuf client for Environmental domain uses relative URLs (/api/v1/...) compatible with the runtime fetch patch across Vite dev, Vercel, and Tauri
  3. Generated client response types align with existing TypeScript interfaces consumed by UI components (no adapter mapping needed)
  4. Toggling the sebufEnvironmental feature flag switches Environmental data fetching between legacy and sebuf paths with identical results
  5. Proto messages model the application's domain types (matching src/types/index.ts), not upstream API response shapes
**Plans**: TBD

Plans:
- [ ] 03-01: TBD
- [ ] 03-02: TBD

### Phase 4: Server Runtime
**Goal**: Server handlers generated from proto definitions serve all migrated domains, deployed identically across Vite dev, Vercel edge, and Tauri sidecar from a single route descriptor array
**Depends on**: Phase 3
**Requirements**: SERVER-01, SERVER-02, SERVER-03, SERVER-04, SERVER-05, SERVER-06
**Success Criteria** (what must be TRUE):
  1. TypeScript server handler interfaces are generated for all defined domain protos via protoc-gen-ts-server
  2. Handler implementations proxy requests to upstream external APIs and return proto-typed responses with correct data
  3. Vite dev server plugin mounts generated RouteDescriptor[] and serves migrated domain endpoints during local development
  4. Vercel catch-all edge function mounts generated RouteDescriptor[] and serves migrated domain endpoints in production
  5. Tauri sidecar adapter mounts generated RouteDescriptor[] and serves migrated domain endpoints on desktop
**Plans**: TBD

Plans:
- [ ] 04-01: TBD
- [ ] 04-02: TBD
- [ ] 04-03: TBD

### Phase 5: Markets Domain Migration
**Goal**: The Markets domain (Finnhub, Yahoo Finance, CoinGecko, Polymarket, stablecoins, ETF flows) is fully migrated, proving that complex multi-provider domains with auth and proxy chains work through the sebuf pipeline
**Depends on**: Phase 4
**Requirements**: DOMAIN-02
**Success Criteria** (what must be TRUE):
  1. Markets proto file defines RPCs with HTTP annotations covering stocks, indices/forex, crypto, predictions, stablecoins, and ETF flows
  2. Polymarket's 4-tier proxy fallback chain is preserved in the Markets server handler with identical behavior to legacy
  3. Toggling the sebufMarkets feature flag switches Markets data fetching with response parity verified by the test harness
**Plans**: TBD

Plans:
- [ ] 05-01: TBD
- [ ] 05-02: TBD

### Phase 6: Simple Domain Batch
**Goal**: Cyber, Economic, Research, and Infrastructure domains are all migrated to sebuf, following the established patterns from Environmental and Markets
**Depends on**: Phase 5
**Requirements**: DOMAIN-03, DOMAIN-04, DOMAIN-05, DOMAIN-06
**Success Criteria** (what must be TRUE):
  1. Proto definitions, generated clients, server handlers, and dual-mode adapters exist for all four domains (Cyber, Economic, Research, Infrastructure)
  2. Each domain's feature flag toggles between legacy and sebuf paths with verified response parity
  3. All four domains serve correctly through the Vercel catch-all edge function, replacing their individual legacy api/*.js edge functions
  4. Existing circuit breaker, caching, and error handling behavior is preserved across all four domains
**Plans**: TBD

Plans:
- [ ] 06-01: TBD
- [ ] 06-02: TBD

### Phase 7: Complex Domain Batch
**Goal**: Geopolitical, Military (HTTP-only), and News domains are migrated, handling multi-source aggregation, WebSocket/HTTP hybrid separation, and RSS fan-out patterns
**Depends on**: Phase 6
**Requirements**: DOMAIN-07, DOMAIN-08, DOMAIN-09
**Success Criteria** (what must be TRUE):
  1. Geopolitical proto defines RPCs for ACLED, UCDP, GDELT, HAPI, and UNHCR with multi-source aggregation handled in the server handler
  2. Military proto covers HTTP-only RPCs (OpenSky flights, Wingbits enrichment, FAA, ADS-B) while WebSocket streams (AIS, OpenSky relay) remain explicitly outside sebuf scope
  3. News proto consolidates RSS feed aggregation into a single GetFeedItems RPC with server-side domain validation, replacing 30+ individual feed proxy entries
  4. All three domains toggle between legacy and sebuf paths with verified response parity
**Plans**: TBD

Plans:
- [ ] 07-01: TBD
- [ ] 07-02: TBD
- [ ] 07-03: TBD

### Phase 8: Legacy Removal
**Goal**: All dual-mode scaffolding, legacy service files, and hand-written type interfaces are removed, leaving a clean sebuf-only codebase
**Depends on**: Phase 7
**Requirements**: CLEAN-01, CLEAN-02, CLEAN-03, CLEAN-04
**Success Criteria** (what must be TRUE):
  1. All legacy src/services/*.ts HTTP service files for migrated domains are deleted with no remaining imports
  2. All individual api/*.js Vercel edge functions are removed, replaced entirely by the catch-all handler
  3. src/types/index.ts re-exports domain types from generated proto types instead of hand-written interfaces
  4. All dual-mode feature flags (sebufEnvironmental, sebufMarkets, etc.) are removed and adapters collapse to sebuf-only paths
  5. The application builds, passes all checks, and runs correctly on Vite dev, Vercel production, and Tauri desktop with zero legacy code paths
**Plans**: TBD

Plans:
- [ ] 08-01: TBD
- [ ] 08-02: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Proto Foundation | 0/TBD | Not started | - |
| 2. Dual-Mode Infrastructure | 0/TBD | Not started | - |
| 3. Environmental Domain Migration | 0/TBD | Not started | - |
| 4. Server Runtime | 0/TBD | Not started | - |
| 5. Markets Domain Migration | 0/TBD | Not started | - |
| 6. Simple Domain Batch | 0/TBD | Not started | - |
| 7. Complex Domain Batch | 0/TBD | Not started | - |
| 8. Legacy Removal | 0/TBD | Not started | - |
