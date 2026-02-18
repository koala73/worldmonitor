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

- [ ] **DOMAIN-01**: Environmental domain proto (USGS earthquakes, NASA FIRMS fires, GDACS cyclones, EONET natural events) with service RPCs and HTTP annotations
- [ ] **DOMAIN-02**: Markets domain proto (Finnhub stocks, Yahoo Finance indices/forex, CoinGecko crypto, Polymarket predictions, stablecoins, ETF flows) with service RPCs and HTTP annotations
- [ ] **DOMAIN-03**: Cyber domain proto (URLhaus, ThreatFox, AlienVault OTX, AbuseIPDB) with service RPCs and HTTP annotations
- [ ] **DOMAIN-04**: Economic domain proto (FRED series, USA Spending, World Bank indicators, EIA oil/energy) with service RPCs and HTTP annotations
- [ ] **DOMAIN-05**: Research domain proto (arXiv papers, GitHub trending, Hacker News) with service RPCs and HTTP annotations
- [ ] **DOMAIN-06**: Infrastructure domain proto (Cloudflare Radar outages, PizzINT, NGA maritime warnings) with service RPCs and HTTP annotations
- [ ] **DOMAIN-07**: Geopolitical domain proto (ACLED conflicts, UCDP events, GDELT tensions, HAPI humanitarian, UNHCR refugees) with service RPCs and HTTP annotations
- [ ] **DOMAIN-08**: Military domain proto (OpenSky flights, Wingbits enrichment, FAA airport status, ADS-B exchange) — HTTP-only RPCs, excluding WebSocket streams
- [ ] **DOMAIN-09**: News domain proto (RSS feed aggregation — single GetFeedItems RPC with server-side domain validation, feed categories)
- [ ] **DOMAIN-10**: Proto messages match existing TypeScript interfaces in src/types/index.ts (not upstream API response shapes)

### Client Generation

- [ ] **CLIENT-01**: TypeScript sebuf clients generated for all 9 domain services via protoc-gen-ts-client
- [ ] **CLIENT-02**: Generated clients use relative URLs (/api/v1/...) to work with existing fetch patch (runtime.ts) across Vercel, Vite dev, and Tauri
- [ ] **CLIENT-03**: Generated clients support custom fetch function injection for circuit breaker wrapping
- [ ] **CLIENT-04**: Generated client response types align with existing TypeScript interfaces used by components

### Migration Infrastructure

- [ ] **MIGRATE-01**: Dual-mode adapter modules per domain that route calls to either legacy service or sebuf client based on feature flag
- [ ] **MIGRATE-02**: Feature flags added to RuntimeFeatureId for per-domain sebuf toggle (e.g., sebufEnvironmental, sebufMarkets, etc.)
- [ ] **MIGRATE-03**: Circuit breaker pattern preserved — generated sebuf clients wrapped with existing createCircuitBreaker utility
- [ ] **MIGRATE-04**: Parity test harness that calls both legacy and sebuf paths, compares responses, and reports differences
- [ ] **MIGRATE-05**: Persistent cache layer works transparently with sebuf client responses (same serialization format)

### Server Implementation

- [x] **SERVER-01**: TypeScript server handler interfaces generated for all 9 domains via protoc-gen-ts-server (sebuf's own TS server codegen)
- [x] **SERVER-02**: Handler implementations for each domain that proxy requests to upstream external APIs and return proto-typed responses
- [x] **SERVER-03**: Vite dev server plugin that mounts generated RouteDescriptor[] for local development
- [x] **SERVER-04**: Vercel catch-all edge function that mounts generated RouteDescriptor[] for production deployment
- [x] **SERVER-05**: Tauri sidecar adapter that mounts generated RouteDescriptor[] for desktop deployment
  (closed via gap plan 02-03: esbuild compiles api/[[...path]].ts to .js bundle for sidecar discovery)
- [x] **SERVER-06**: Server handlers preserve existing CORS, rate limiting, and caching patterns from current api/*.js edge functions

### Cleanup & Consolidation

- [ ] **CLEAN-01**: Legacy service files deleted after verified parity per domain (dual-mode adapter collapses to sebuf-only)
- [ ] **CLEAN-02**: Legacy api/*.js Vercel edge functions removed after catch-all handler covers their functionality
- [ ] **CLEAN-03**: src/types/index.ts consolidated — domain types imported from generated proto types instead of hand-written interfaces
- [ ] **CLEAN-04**: Dual-mode feature flags removed once all domains verified and legacy code deleted

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
| MIGRATE-01 | Phase 2 | Pending |
| MIGRATE-02 | Phase 2 | Pending |
| MIGRATE-03 | Phase 2 | Pending |
| MIGRATE-04 | Phase 2 | Pending |
| MIGRATE-05 | Phase 2 | Pending |
| CLIENT-03 | Phase 2 | Pending |
| DOMAIN-01 | Phase 3 | Pending |
| DOMAIN-10 | Phase 3 | Pending |
| CLIENT-01 | Phase 3 | Pending |
| CLIENT-02 | Phase 3 | Pending |
| CLIENT-04 | Phase 3 | Pending |
| SERVER-01 | Phase 4 | Complete |
| SERVER-02 | Phase 4 | Complete |
| SERVER-03 | Phase 4 | Complete |
| SERVER-04 | Phase 4 | Complete |
| SERVER-05 | Phase 4 | Complete |
| SERVER-06 | Phase 4 | Complete |
| DOMAIN-02 | Phase 5 | Pending |
| DOMAIN-03 | Phase 6 | Pending |
| DOMAIN-04 | Phase 6 | Pending |
| DOMAIN-05 | Phase 6 | Pending |
| DOMAIN-06 | Phase 6 | Pending |
| DOMAIN-07 | Phase 7 | Pending |
| DOMAIN-08 | Phase 7 | Pending |
| DOMAIN-09 | Phase 7 | Pending |
| CLEAN-01 | Phase 8 | Pending |
| CLEAN-02 | Phase 8 | Pending |
| CLEAN-03 | Phase 8 | Pending |
| CLEAN-04 | Phase 8 | Pending |

**Coverage:**
- v1 requirements: 34 total
- Mapped to phases: 34
- Unmapped: 0

---
*Requirements defined: 2026-02-18*
*Last updated: 2026-02-18 after roadmap creation*
