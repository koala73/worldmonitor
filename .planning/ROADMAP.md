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
- [ ] **Phase 2E: Climate Migration** - Open-Meteo anomalies with enum-heavy responses
- [ ] **Phase 2F-2S: Domain Migrations** - Remaining domains, one sub-phase each

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

### Phase 2E: Climate Migration
**Goal**: Migrate climate/Open-Meteo domain to sebuf -- implement handler with 15-zone monitoring, 30-day baseline comparison, severity/type classification, create service module with port/adapter pattern, rewire all consumers (panel, map heatmap, country instability), delete legacy endpoint
**Depends on**: Phase 2D
**Requirements:** [DOMAIN-01, SERVER-02]
**Plans:** 2 plans
Plans:
- [ ] 2E-01-PLAN.md -- Climate handler + gateway wiring + sidecar rebuild
- [ ] 2E-02-PLAN.md -- Climate service module + consumer rewiring + legacy deletion

### Phase 2F-2S: Remaining Domain Migrations
**Goal**: Each remaining domain migrated one at a time in order of complexity
**Depends on**: Phase 2E

Migration order (one sub-phase each):
1. ~~seismology~~ (complete, Phase 2C)
2. ~~wildfire~~ (Phase 2D)
3. ~~climate~~ (Phase 2E)
4. prediction -- validates query params
5. displacement -- validates multi-entity responses
6. aviation -- validates XML upstream parsing
7. research -- validates 3-RPC service pattern
8. unrest -- validates ACLED auth token
9. conflict -- validates dual-upstream
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
| 2E. Climate Migration | Not started | - |
| 2F-2S. Domain Migrations (0/14) | Not started | - |
| 2T. Legacy Cleanup | Not started | - |
