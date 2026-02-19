# Roadmap: WorldMonitor Sebuf Integration

## Overview

This roadmap migrates WorldMonitor's 80+ ad-hoc fetch-based service modules to sebuf-powered, proto-defined domain services. The approach is proto-first: define all domain protos properly from scratch with correct boundaries, generate clients+servers, build a unified server runtime, then switch each service one by one. No dual-mode adapters, no parity harness, no extra feature flags.

## Architecture

One domain directory = one XxxService = one service.proto. 17 domains + core types.

```
proto/worldmonitor/
├── core/v1/          # Shared types (geo, pagination, time, severity, identifiers, etc.)
├── seismology/v1/    # SeismologyService   — USGS earthquakes
├── wildfire/v1/      # WildfireService     — NASA FIRMS fires
├── climate/v1/       # ClimateService      — Open-Meteo anomalies
├── conflict/v1/      # ConflictService     — ACLED + UCDP
├── displacement/v1/  # DisplacementService — UNHCR refugees/IDPs
├── unrest/v1/        # UnrestService       — Protests/riots
├── military/v1/      # MilitaryService     — Flights + vessels
├── aviation/v1/      # AviationService     — FAA/Eurocontrol delays
├── maritime/v1/      # MaritimeService     — AIS + NGA warnings
├── cyber/v1/         # CyberService        — Multi-source threat intel
├── market/v1/        # MarketService       — Stocks, crypto, commodities
├── prediction/v1/    # PredictionService   — Polymarket
├── economic/v1/      # EconomicService     — FRED, World Bank, EIA
├── news/v1/          # NewsService         — RSS + AI summarization
├── research/v1/      # ResearchService     — arXiv, GitHub, HN
├── infrastructure/v1/ # InfrastructureService — Outages, service status
└── intelligence/v1/  # IntelligenceService — Risk scores, PizzINT, GDELT, AI classification
```

## Phases

- [x] **Phase 1: Proto Foundation** - Buf toolchain, shared types, and code generation pipeline
- [x] **Phase 2A: All Domain Protos** - Define all 17 domain proto packages with correct boundaries
- [x] **Phase 2B: Server Runtime** - Router, CORS, error mapper, catch-all gateway, first handler
- [x] **Phase 2E: Climate Migration** - Open-Meteo anomalies with enum-heavy responses (completed 2026-02-18)
- [x] **Phase 2F: Prediction Migration** - Polymarket prediction markets with query params and multi-strategy fetch (completed 2026-02-18)
- [x] **Phase 2G: Displacement Migration** - UNHCR refugees/IDPs with multi-entity responses (completed 2026-02-19)
- [x] **Phase 2H: Aviation Migration** - FAA XML parsing, simulated non-US delays, MONITORED_AIRPORTS config (completed 2026-02-19)
- [x] **Phase 2I: Research Migration** - arXiv, GitHub trending, Hacker News with thin port/adapter (completed 2026-02-19)
- [x] **Phase 2J: Unrest Migration** - ACLED protests/riots with auth token validation and GDELT enrichment (completed 2026-02-19)
- [ ] **Phase 2K: Conflict Migration** - ACLED + UCDP dual-upstream conflict events (in progress)
- [ ] **Phase 2L-2S: Domain Migrations** - Remaining domains, one sub-phase each

## Phase Details

### Phase 1: Proto Foundation (COMPLETE)
**Goal**: Working proto-to-TypeScript code generation pipeline with shared types
**Status**: Complete (2026-02-18)

### Phase 2A: All Domain Protos (COMPLETE)
**Goal**: All 17 domain proto packages defined with entities, RPCs, and service definitions
**Status**: Complete (2026-02-18)
**Deliverables**:
  - 79 proto files across 17 domains + core
  - 34 generated TypeScript files (17 client + 17 server)
  - 34 OpenAPI specs (17 YAML + 17 JSON)
  - Core enhancements: severity.proto, country.proto, expanded identifiers.proto
  - `buf lint` passes with zero errors
  - `make generate` succeeds
  - Generated TypeScript compiles

### Phase 2B: Server Runtime (COMPLETE)
**Goal**: Shared server infrastructure (router, CORS, error mapper) and catch-all gateway, validated with first handler (seismology)
**Depends on**: Phase 2A
**Status**: Complete (2026-02-18)
**Plans:** 3 plans
Plans:
- [x] 02-01-PLAN.md -- Shared server infra (router, CORS, error mapper) + seismology handler
- [x] 02-02-PLAN.md -- Vercel catch-all gateway + Vite dev plugin + tsconfig.api.json
- [x] 02-03-PLAN.md -- Gap closure: esbuild compilation of sebuf gateway for Tauri sidecar (SERVER-05)

### Phase 2C: Seismology Migration (COMPLETE)
**Goal**: First end-to-end domain migration -- enable INT64_ENCODING_NUMBER project-wide, wire frontend to generated SeismologyServiceClient via port/adapter pattern, adapt components to proto types, delete legacy endpoint
**Depends on**: Phase 2B
**Status**: Complete (2026-02-18)
**Plans:** 2/2 plans complete
Plans:
- [x] 2C-01-PLAN.md -- INT64_ENCODING_NUMBER prerequisite: annotate all proto time fields, regenerate, fix handler
- [x] 2C-02-PLAN.md -- Client switchover: rewrite adapter, adapt components, delete legacy endpoint + proxy

### Phase 2D: Wildfire Migration (COMPLETE)
**Goal**: Migrate wildfire/FIRMS domain to sebuf -- enhance proto with region/daynight fields, implement CSV-parsing handler with env-var gating, create service module with real business logic (region stats, flatten, map-compatible output), rewire all consumers, delete legacy
**Depends on**: Phase 2C
**Status**: Complete (2026-02-18)
**Requirements:** [DOMAIN-01, SERVER-02]
**Plans:** 2/2 plans complete
Plans:
- [x] 2D-01-PLAN.md -- Proto enhancement + wildfire handler + gateway wiring + sidecar rebuild
- [x] 2D-02-PLAN.md -- Wildfires service module + consumer rewiring + legacy deletion

### Phase 2E: Climate Migration (COMPLETE)
**Goal**: Migrate climate/Open-Meteo domain to sebuf -- implement handler with 15-zone monitoring, 30-day baseline comparison, severity/type classification, create service module with port/adapter pattern, rewire all consumers (panel, map heatmap, country instability), delete legacy endpoint
**Depends on**: Phase 2D
**Status**: Complete (2026-02-18)
**Requirements:** [DOMAIN-01, SERVER-02]
**Plans:** 2/2 plans complete
Plans:
- [x] 2E-01-PLAN.md -- Climate handler + gateway wiring + sidecar rebuild
- [x] 2E-02-PLAN.md -- Climate service module + consumer rewiring + legacy deletion

### Phase 2F: Prediction Migration
**Goal**: Migrate prediction/Polymarket domain to sebuf -- implement handler proxying Gamma API with query param validation, create service module with port/adapter pattern preserving multi-strategy fetch (direct/Tauri/Railway/proxy), tag-based event aggregation, country market filtering, rewire all consumers, delete legacy endpoint
**Depends on**: Phase 2E
**Status**: Complete (2026-02-18)
**Requirements:** [DOMAIN-02, SERVER-02]
**Plans:** 2/2 plans complete
Plans:
- [x] 2F-01-PLAN.md -- Prediction handler (Gamma API proxy with graceful degradation) + gateway wiring + sidecar rebuild
- [x] 2F-02-PLAN.md -- Prediction service module (multi-strategy fetch, tag aggregation, country markets) + consumer rewiring + yesPrice bug fixes + legacy deletion

### Phase 2G: Displacement Migration
**Goal**: Migrate displacement/UNHCR domain to sebuf -- implement handler proxying UNHCR Population API with multi-entity responses (refugees, IDPs, asylum seekers), create service module with port/adapter pattern, rewire all consumers, delete legacy endpoint
**Depends on**: Phase 2F
**Status**: Complete (2026-02-19)
**Requirements:** [DOMAIN-07, SERVER-02]
**Plans:** 2/2 plans complete
Plans:
- [x] 2G-01-PLAN.md -- Displacement handler (UNHCR API pagination, per-country aggregation, flow computation, country centroids) + gateway wiring + sidecar rebuild
- [x] 2G-02-PLAN.md -- Displacement service module (int64 string->number, GeoCoordinates->flat lat/lon mapping) + consumer rewiring + legacy deletion

### Phase 2H: Aviation Migration
**Goal**: Migrate aviation/FAA domain to sebuf -- implement handler proxying FAA NASSTATUS XML API with XML-to-JSON parsing, enrich with MONITORED_AIRPORTS config for non-US simulated delays, create service module with port/adapter pattern, rewire all consumers, delete legacy endpoint
**Depends on**: Phase 2G
**Status**: Complete (2026-02-19)
**Requirements:** [DOMAIN-08, SERVER-02]
**Plans:** 2/2 plans complete
Plans:
- [x] 2H-01-PLAN.md -- Aviation handler (FAA XML parsing via fast-xml-parser, airport enrichment, simulated delays, severity classification) + gateway wiring + sidecar rebuild
- [x] 2H-02-PLAN.md -- Aviation service module (proto enum reverse mapping, GeoCoordinates unwrap, updatedAt->Date) + consumer rewiring + legacy deletion

### Phase 2I: Research Migration
**Goal**: Migrate research domain (arXiv papers, GitHub trending repos, Hacker News items) to sebuf -- implement handler with 3 RPCs proxying upstream APIs, create service module with port/adapter pattern, rewire all consumers, delete legacy endpoints
**Depends on**: Phase 2H
**Status**: Complete (2026-02-19)
**Requirements:** [DOMAIN-05, SERVER-02]
**Plans:** 2/2 plans complete
Plans:
- [x] 2I-01-PLAN.md -- Research handler (3 RPCs: arXiv XML parsing, GitHub trending with fallback, HN Firebase 2-step fetch) + gateway wiring + sidecar rebuild
- [x] 2I-02-PLAN.md -- Research service module (port/adapter with circuit breakers) + legacy deletion (6 files) + config cleanup

### Phase 2J: Unrest Migration
**Goal**: Migrate unrest domain (ACLED protests/riots/strikes) to sebuf -- implement handler proxying ACLED API with auth token, optional GDELT enrichment, event clustering, severity classification, create service module with port/adapter pattern, rewire all consumers, delete legacy endpoint
**Depends on**: Phase 2I
**Requirements:** [DOMAIN-07, SERVER-02]
**Status**: Complete (2026-02-19)
**Plans:** 2/2 plans complete
Plans:
- [x] 2J-01-PLAN.md -- Unrest handler (ACLED + GDELT dual-fetch, deduplication, severity classification) + gateway wiring + sidecar rebuild
- [x] 2J-02-PLAN.md -- Unrest service module (proto-to-legacy SocialUnrestEvent mapping, 4 enum mappers, ACLED config heuristic) + barrel update + legacy deletion (3 files)

### Phase 2K: Conflict Migration
**Goal**: Migrate conflict domain (ACLED armed conflicts + UCDP events + HAPI humanitarian) to sebuf -- implement 3-RPC handler proxying three upstream APIs, create service module with 4-shape port/adapter pattern, rewire all consumers, delete legacy endpoints
**Depends on**: Phase 2J
**Requirements:** [DOMAIN-07, SERVER-02]
**Plans:** 3/3 plans complete
Plans:
- [x] 2K-01-PLAN.md -- Conflict handler (3 RPCs: ACLED conflicts, UCDP GED events with version discovery, HAPI humanitarian summary) + gateway wiring + sidecar rebuild
- [ ] 2K-02-PLAN.md -- Conflict service module (4-shape proto-to-legacy mapping, UCDP classification derivation, deduplication) + consumer rewiring + legacy deletion (9 files)

### Phase 2L-2S: Remaining Domain Migrations
**Goal**: Each remaining domain migrated one at a time in order of complexity
**Depends on**: Phase 2K

Migration order (one sub-phase each):
1. ~~seismology~~ (complete, Phase 2C)
2. ~~wildfire~~ (Phase 2D)
3. ~~climate~~ (Phase 2E)
4. ~~prediction~~ (Phase 2F)
5. ~~displacement~~ (Phase 2G)
6. ~~aviation~~ (Phase 2H)
7. ~~research~~ (Phase 2I)
8. ~~unrest~~ (Phase 2J)
9. ~~conflict~~ (Phase 2K)
10. maritime -- validates AIS snapshot caching
11. cyber -- validates multi-source aggregation
12. infrastructure -- validates external service fan-out
13. economic -- validates FRED/WorldBank/EIA
14. market -- validates multi-source finance
15. military -- validates OpenSky+Wingbits+Railway
16. news -- validates RSS fan-out + AI summarization
17. intelligence -- final: cross-domain computation

Each migration step:
1. Implement handler in `api/server/worldmonitor/{domain}/v1/handler.ts`
2. Mount routes in catch-all gateway
3. Update frontend to use generated client
4. Delete old `api/*.js` file(s)

### Phase 2T: Legacy Cleanup
**Goal**: Remove shared legacy utilities and consolidate types
- Remove `api/_cors.js`, `api/_upstash-cache.js`, `api/_ip-rate-limit.js`
- Remove legacy types from `src/types/index.ts`
- Remove old OpenAPI specs

## Progress

| Phase | Status | Completed |
|-------|--------|-----------|
| 1. Proto Foundation | Complete | 2026-02-18 |
| 2A. All Domain Protos | Complete | 2026-02-18 |
| 2B. Server Runtime | Complete | 2026-02-18 |
| 2C. Seismology Migration | Complete | 2026-02-18 |
| 2D. Wildfire Migration | Complete | 2026-02-18 |
| 2E. Climate Migration | Complete | 2026-02-18 |
| 2F. Prediction Migration | Complete | 2026-02-18 |
| 2G. Displacement Migration | Complete | 2026-02-19 |
| 2H. Aviation Migration | Complete | 2026-02-19 |
| 2I. Research Migration | Complete | 2026-02-19 |
| 2J. Unrest Migration | Complete | 2026-02-19 |
| 2K. Conflict Migration | 1/2 | In Progress | 2026-02-19 | 2L-2S. Domain Migrations (0/8) | Not started | - |
| 2T. Legacy Cleanup | Not started | - |
