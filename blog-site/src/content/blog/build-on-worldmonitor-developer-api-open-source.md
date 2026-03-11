---
title: "Build on WorldMonitor: Open APIs, Proto-First Architecture, and the Developer Platform"
description: "Build intelligence applications on WorldMonitor's typed API layer. 22 services, 92 proto files, 60+ edge functions, auto-generated TypeScript clients. AGPL-3.0 open source."
metaTitle: "WorldMonitor Developer API: 22 Services, 92 Proto Files, Open Source Intelligence Platform"
keywords: "open source intelligence API, OSINT API free, geopolitical data API, intelligence platform developer, proto-first API architecture"
audience: "Developers, data engineers, startup builders, academic researchers, open-source contributors"
heroImage: "/blog/images/blog/build-on-worldmonitor-developer-api-open-source.jpg"
pubDate: "2026-03-09"
---

Most intelligence platforms are walled gardens. You pay for access, you use their interface, and if you want to build something custom, you're out of luck. The data is locked behind a UI.

WorldMonitor is designed differently. The entire intelligence platform, every data feed, every scoring algorithm, every aggregation pipeline, is built on a **typed API layer** that developers can use, extend, and build upon.

## Proto-First Architecture

WorldMonitor uses **Protocol Buffers (protobuf)** as the single source of truth for all API contracts. The codebase contains:

- **92 proto files** defining every data structure and service
- **22 typed service domains** covering all intelligence verticals
- **Auto-generated TypeScript** clients for type-safe API consumption
- **Auto-generated OpenAPI** documentation for REST compatibility

This means every API endpoint has:

1. A proto definition that specifies exact request/response types
2. An auto-generated TypeScript client with full type safety
3. An OpenAPI spec for language-agnostic access
4. Runtime validation that rejects malformed requests

### Why Proto-First Matters

Protocol Buffers enforce a contract between client and server that can't drift:

- **Type safety:** No more guessing what fields an API returns. The proto file is the contract.
- **Versioning:** Proto files support backward-compatible evolution. Add fields without breaking clients.
- **Code generation:** TypeScript clients are generated, not handwritten. Zero chance of client/server mismatch.
- **Documentation:** The proto file IS the documentation. Field names, types, and comments are the API spec.

For developers building on WorldMonitor, this means you can trust the API contracts completely. If the proto says a field is `int64`, it's `int64`. If it says `repeated string`, it's an array of strings.

## 22 Service Domains

WorldMonitor's API is organized into domain-specific services:

| Domain | What It Covers |
|--------|---------------|
| **Conflict** | ACLED events, UCDP data, hotspot scoring |
| **Military** | Bases, ADS-B flights, AIS vessels, USNI reports |
| **Market** | Stock quotes, forex, commodities, sector performance |
| **Crypto** | BTC signals, stablecoin pegs, ETF flows, Fear & Greed |
| **Aviation** | Airport delays, flight tracking, airspace data |
| **Maritime** | Vessel positions, port status, dark vessel detection |
| **Climate** | Temperature anomalies, precipitation, sea level |
| **Imagery** | Satellite data via STAC API |
| **News** | Aggregated RSS feeds, trending keywords |
| **Intelligence** | CII scores, theater posture, convergence events |
| **Infrastructure** | Cables, pipelines, nuclear facilities, datacenters |
| **Prediction** | Polymarket data, forecast probabilities |
| **Cyber** | Threat feeds, C2 servers, malware URLs |
| **Disaster** | Earthquakes, fires, volcanic events |
| **Displacement** | UNHCR refugee and IDP data |
| **Travel** | Government advisories, risk levels |
| **Central Bank** | Policy rates, BIS data, REER |
| **Tech** | AI labs, startups, accelerators, tech hubs |
| **Commodity** | Mining sites, exchange hubs, energy infrastructure |
| **Regulation** | AI policy tracking, regulatory changes |
| **Health** | System health, data freshness, circuit breaker status |
| **Bootstrap** | Hydration data for initial app load |

Each domain has its own edge function, proto definitions, and TypeScript client.

## 60+ Vercel Edge Functions

The API layer runs on **Vercel Edge Functions**, providing:

- **Global edge deployment:** API responses from the nearest edge node
- **~85% cold-start reduction** through per-domain thin entry points
- **Circuit breakers** per data source (failing upstream won't take down the API)
- **Cache-Control headers** with ETag support for efficient CDN caching
- **Rate limiting** with Cloudflare-aware client IP detection

API endpoints follow the pattern:
```
api.worldmonitor.app/api/{domain}/v1/{rpc}
```

For example:

- `api.worldmonitor.app/api/market/v1/quotes` for stock quotes
- `api.worldmonitor.app/api/conflict/v1/events` for conflict data
- `api.worldmonitor.app/api/intelligence/v1/cii` for Country Instability Index scores

## Building with WorldMonitor's API

### Custom Dashboards

Build a domain-specific dashboard that pulls exactly the data you need. Use the typed TypeScript clients for a seamless development experience:

```typescript
// Auto-generated client with full type safety
const cii = await intelligenceClient.getCII({ countries: ['US', 'CN', 'RU'] });
// cii.scores is typed as CIIScore[] with all fields known at compile time
```

### Data Pipelines

Feed WorldMonitor data into your own analytics:

- Pull conflict events into a data warehouse for historical analysis
- Stream market data alongside geopolitical scores for correlation studies
- Build custom alerting on CII threshold changes

### Research Applications

Academic researchers can use the API programmatically:

- Study the relationship between news velocity and conflict escalation
- Analyze prediction market accuracy against actual outcomes
- Build custom scoring models using WorldMonitor's raw data feeds

### Mobile Apps

Build a mobile app that consumes WorldMonitor's API for a custom mobile intelligence experience. The OpenAPI spec makes it accessible from any language (Swift, Kotlin, Python, Go).

### Slack/Teams Bots

Build alerting bots that post to your team channel when:

- A country's CII crosses a threshold
- A strategic theater posture changes
- A prediction market probability shifts significantly
- A cyber threat spike is detected in your region of interest

## Self-Hosting

WorldMonitor is AGPL-3.0. You can self-host the entire platform:

**Frontend:** React + TypeScript + Vite. Standard `npm install && npm run build`.

**API:** Vercel Edge Functions. Deploy to Vercel with `vercel deploy`, or adapt for Cloudflare Workers, Deno Deploy, or any edge runtime.

**Desktop App:** Tauri. Build with `cargo tauri build` for macOS, Windows, or Linux.

**Data Layer:** Redis for caching, with seed scripts that populate data from public sources.

Self-hosting gives you:

- Complete control over data flows
- Custom domain deployment
- Network isolation for sensitive environments
- Ability to add proprietary data sources

## Contributing

The open-source codebase welcomes contributions:

- **New data sources:** Add proto definitions, implement handlers, wire into the seed pipeline
- **New languages:** Add translation JSON files for additional locale support
- **Bug fixes:** Standard GitHub PR workflow
- **New panels:** Build new visualization panels using the typed data layer
- **Performance:** Edge function optimization, caching improvements, bundle size reduction

The proto-first architecture makes contributing safe: the type system catches contract violations at compile time, and auto-generated clients ensure frontend/backend consistency.

## The Developer Stack

For reference, WorldMonitor is built with:

| Layer | Technology |
|-------|-----------|
| Frontend | React, TypeScript, Vite |
| 3D Globe | globe.gl, Three.js |
| Flat Map | deck.gl, MapLibre |
| API | Vercel Edge Functions |
| Contracts | Protocol Buffers (92 files) |
| Desktop | Tauri (Rust) |
| Sidecar | Node.js |
| Caching | Redis |
| Browser ML | Transformers.js, ONNX |
| Styling | CSS Custom Properties |
| i18n | i18next (21 locales) |
| Testing | Vitest, Playwright |

## Why Build on WorldMonitor?

The intelligence industry has a consolidation problem. A handful of vendors control the data, the algorithms, and the interfaces. Analysts are locked into ecosystems they can't customize, audit, or extend.

WorldMonitor's open, typed, proto-first architecture is the alternative:

- **Audit everything:** Every scoring algorithm, every data pipeline, every API contract is in the codebase
- **Extend anything:** Add data sources, build custom panels, create new service domains
- **Trust the types:** Proto-generated clients mean no runtime surprises
- **Deploy anywhere:** Edge functions, self-hosted, or desktop
- **Own your intelligence:** No vendor lock-in, no API key revocation, no price hikes

The intelligence platform of the future isn't a product. It's an ecosystem. WorldMonitor is building the foundation.

---

**Start building at [github.com/koala73/worldmonitor](https://github.com/koala73/worldmonitor). 22 services, 92 proto files, and a global intelligence dataset waiting for your application.**
