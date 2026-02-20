# Requirements: WorldMonitor Sebuf Integration

**Defined:** 2026-02-18
**Core Value:** Every API integration is defined in a .proto file with generated type-safe TypeScript clients and server handlers, eliminating hand-written fetch boilerplate.

## v1 Requirements

Requirements for full sebuf integration. Each maps to roadmap phases.

### Proto Foundation

- [x] **PROTO-01**: Buf toolchain configured (buf.yaml, buf.gen.yaml) with sebuf plugin dependencies (buf.build/sebmelki/sebuf, buf.build/bufbuild/protovalidate)
- [x] **PROTO-02**: Proto directory structure created following sebuf multi-service pattern (proto/models/ for shared types, proto/services/{domain}/v1/ for service definitions)
- [x] **PROTO-03**: Shared proto messages defined for cross-domain types (GeoCoordinates, TimeRange, PaginationRequest/Response, ErrorResponse)
- [x] **PROTO-04**: Code generation pipeline runs via `buf generate` producing TypeScript clients and server handlers
- [x] **PROTO-05**: OpenAPI v3 specs auto-generated from proto definitions via protoc-gen-openapiv3

### Domain Proto Definitions

- [x] **DOMAIN-01**: Environmental domain proto (USGS earthquakes, NASA FIRMS fires, GDACS cyclones, EONET natural events) with service RPCs and HTTP annotations
- [x] **DOMAIN-02**: Markets domain proto (Finnhub stocks, Yahoo Finance indices/forex, CoinGecko crypto, Polymarket predictions, stablecoins, ETF flows) with service RPCs and HTTP annotations
- [x] **DOMAIN-03**: Cyber domain proto (URLhaus, ThreatFox, AlienVault OTX, AbuseIPDB) with service RPCs and HTTP annotations
- [x] **DOMAIN-04**: Economic domain proto (FRED series, USA Spending, World Bank indicators, EIA oil/energy) with service RPCs and HTTP annotations
- [x] **DOMAIN-05**: Research domain proto (arXiv papers, GitHub trending, Hacker News) with service RPCs and HTTP annotations
- [x] **DOMAIN-06**: Infrastructure domain proto (Cloudflare Radar outages, PizzINT, NGA maritime warnings) with service RPCs and HTTP annotations
- [x] **DOMAIN-07**: Geopolitical domain proto (ACLED conflicts, UCDP events, GDELT tensions, HAPI humanitarian, UNHCR refugees) with service RPCs and HTTP annotations
- [x] **DOMAIN-08**: Military domain proto (OpenSky flights, Wingbits enrichment, FAA airport status, ADS-B exchange) — HTTP-only RPCs, excluding WebSocket streams
- [x] **DOMAIN-09**: News domain proto (RSS feed aggregation — single GetFeedItems RPC with server-side domain validation, feed categories)
- [x] **DOMAIN-10**: Proto messages match existing TypeScript interfaces in src/types/index.ts (not upstream API response shapes)

### Client Generation

- [x] **CLIENT-01**: TypeScript sebuf clients generated for all 9 domain services via protoc-gen-ts-client
- [x] **CLIENT-02**: Generated clients use relative URLs (/api/v1/...) to work with existing fetch patch (runtime.ts) across Vercel, Vite dev, and Tauri
- [x] **CLIENT-03**: Generated clients support custom fetch function injection for circuit breaker wrapping
- [x] **CLIENT-04**: Generated client response types align with existing TypeScript interfaces used by components

### Migration Infrastructure

- [x] **MIGRATE-01**: ~~Dual-mode adapter modules~~ — Superseded: roadmap chose direct per-domain cutover instead of dual-mode adapters
- [x] **MIGRATE-02**: ~~Feature flags for per-domain sebuf toggle~~ — Superseded: direct cutover, no flags needed
- [x] **MIGRATE-03**: ~~Circuit breaker wrapping~~ — Satisfied differently: circuit breakers applied at service-module level via `createCircuitBreaker` (11/17 domains covered)
- [x] **MIGRATE-04**: ~~Parity test harness~~ — Superseded: per-phase VERIFICATION.md reports replaced parity testing
- [x] **MIGRATE-05**: ~~Cache layer transparency~~ — Superseded: cache layer works at service-module level, no special sebuf integration needed

### Server Implementation

- [x] **SERVER-01**: TypeScript server handler interfaces generated for all 9 domains via protoc-gen-ts-server (sebuf's own TS server codegen)
- [x] **SERVER-02**: Handler implementations for each domain that proxy requests to upstream external APIs and return proto-typed responses
- [x] **SERVER-03**: Vite dev server plugin that mounts generated RouteDescriptor[] for local development
- [x] **SERVER-04**: Vercel catch-all edge function that mounts generated RouteDescriptor[] for production deployment
- [x] **SERVER-05**: Tauri sidecar adapter that mounts generated RouteDescriptor[] for desktop deployment
  (closed via gap plan 02-03: esbuild compiles api/[[...path]].ts to .js bundle for sidecar discovery)
- [x] **SERVER-06**: Server handlers preserve existing CORS, rate limiting, and caching patterns from current api/*.js edge functions

### Cleanup & Consolidation

- [x] **CLEAN-01**: Legacy service files deleted after verified parity per domain (dual-mode adapter collapses to sebuf-only)
- [x] **CLEAN-02**: Legacy api/*.js Vercel edge functions removed after catch-all handler covers their functionality
- [x] **CLEAN-03**: ~~src/types/index.ts consolidated~~ — Superseded: port/adapter architecture decouples internal domain types from proto wire types. Service modules re-export adapted types; components import from `@/services/{domain}`, not from generated code. Dead domain types already removed during per-domain migrations.
- [x] **CLEAN-04**: ~~Dual-mode feature flags removed~~ — Superseded: roadmap chose direct migration, no dual-mode flags were ever created.

## v2 Requirements

### Enhanced Features

- **V2-01**: buf.validate annotations for request validation on all server endpoints
- **V2-02**: Generated mock servers for testing using protoc-gen-ts-server generate_mock option
- **V2-03**: WebSocket service migration (AIS vessel tracking, OpenSky relay) — requires sebuf WebSocket support or custom wrapper
- **V2-04**: Automated proto-to-type comparison CI check (generated types vs consumed types drift detection)

## Out of Scope

| Feature | Reason |
|---------|--------|
| gRPC/binary protobuf transport | sebuf is HTTP/JSON focused — wire format stays JSON |
| Go server implementation | Using sebuf's protoc-gen-ts-server (TypeScript), not Go |
| WebSocket service migration | sebuf handles HTTP only — AIS/OpenSky WS streams stay as-is for v1 |
| New data source integrations | Migration only — no new APIs added during this work |
| UI/component changes | Presentation layer untouched — only data-fetching layer changes |
| Changing upstream API contracts | We wrap what exists, protos match our domain types |
| Mobile app or new deployment targets | Migration scoped to existing Vercel + Tauri + Vite targets |
| Authentication system changes | API key management stays as-is |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| PROTO-01 | Phase 1 | Complete |
| PROTO-02 | Phase 1 | Complete |
| PROTO-03 | Phase 1 | Complete |
| PROTO-04 | Phase 1 | Complete |
| PROTO-05 | Phase 1 | Complete |
| MIGRATE-01 | Phase 2 | Superseded |
| MIGRATE-02 | Phase 2 | Superseded |
| MIGRATE-03 | Phase 2 | Superseded |
| MIGRATE-04 | Phase 2 | Superseded |
| MIGRATE-05 | Phase 2 | Superseded |
| CLIENT-03 | Phase 4 | Complete |
| DOMAIN-01 | Phase 2D, 2E | Complete |
| DOMAIN-02 | Phase 2F, 2M-2S | Complete |
| DOMAIN-03 | Phase 2M-2S | Complete |
| DOMAIN-04 | Phase 2M-2S, 3 | Complete |
| DOMAIN-05 | Phase 2I | Complete |
| DOMAIN-06 | Phase 2L, 2M-2S | Complete |
| DOMAIN-07 | Phase 2G, 2J, 2K | Complete |
| DOMAIN-08 | Phase 2H, 2M-2S | Complete |
| DOMAIN-09 | Phase 2M-2S, 3 | Complete |
| DOMAIN-10 | Phase 2C-3 | Complete |
| CLIENT-01 | Phase 2C | Complete |
| CLIENT-02 | Phase 2C | Complete |
| CLIENT-04 | Phase 2C | Complete |
| SERVER-01 | Phase 2B | Complete |
| SERVER-02 | Phase 2B | Complete |
| SERVER-03 | Phase 2B | Complete |
| SERVER-04 | Phase 2B | Complete |
| SERVER-05 | Phase 2B | Complete |
| SERVER-06 | Phase 2B | Complete |
| CLEAN-01 | Phase 2C-3 | Complete |
| CLEAN-02 | Phase 3 | Complete |
| CLEAN-03 | — | Superseded |
| CLEAN-04 | — | Superseded |

**Coverage:**
- v1 requirements: 34 total
- Complete: 25
- Superseded: 7 (MIGRATE-01-05, CLEAN-03, CLEAN-04)
- Partial: 1 (CLIENT-03 — Phase 4 gap closure)
- Pending: 1 (CLIENT-03 circuit breaker coverage assigned to Phase 4)
- Unmapped: 0

---
*Requirements defined: 2026-02-18*
*Last updated: 2026-02-20 after gap closure planning*
