# World Monitor

[![Version](https://img.shields.io/github/v/release/bradleybond512/worldmonitor-macos?label=version)](https://github.com/bradleybond512/worldmonitor-macos/releases/latest)
<a href="https://github.com/bradleybond512/worldmonitor-macos/releases/latest"><strong>Download Latest Release</strong></a>

World Monitor is a multi-runtime intelligence platform: one codebase, four web variants, three desktop targets, a proto-first API layer, and a local-first desktop runtime that can keep working when cloud paths are unavailable.

At the product level, it is a real-time situational-awareness dashboard for geopolitics, infrastructure, markets, and technology. At the engineering level, it is a systems project: geospatial rendering, typed contracts, desktop security boundaries, AI fallback orchestration, and operational documentation all living in the same repo.

## Why This Repo Is Interesting

This is not just a map UI with a long feed list. The repo is designed to show full-stack judgment:

- A single TypeScript frontend powers four distinct product variants without forking the architecture.
- API behavior is contract-driven through Buf, Protobuf, Sebuf, and generated clients and handlers.
- The desktop app is local-first: a Tauri shell starts a localhost sidecar, stores secrets in the OS keychain, and treats cloud fallback as an explicit boundary instead of an assumption.
- AI features are built with graceful degradation in mind: local endpoints, multiple cloud providers, browser fallback, and cache-aware request handling.
- The documentation is meant to read like production documentation, not a weekend-project README.

## By The Numbers

Current code-backed snapshot:

| Metric | Current value | Source of truth |
| --- | --- | --- |
| Web variants | `4` | `src/config/variant.ts`, `src/config/panels.ts` |
| Desktop build targets | `3` | `package.json`, `src-tauri/*.json` |
| Generated OpenAPI service specs | `21` | `docs/api/*.openapi.json` |
| Locales | `18` | `src/services/i18n.ts` |
| Desktop secret keys | `25` | `src-tauri/src/main.rs` |
| Default panel inventory | `62 full / 35 tech / 31 finance / 10 happy` | `src/config/panels.ts` |

## Variants

| Variant | Web | Desktop | Focus |
| --- | --- | --- | --- |
| `full` | Yes | Yes | Geopolitics, infrastructure, cyber, conflict, disasters |
| `tech` | Yes | Yes | AI, startups, cloud, service health, developer ecosystems |
| `finance` | Yes | Yes | Markets, commodities, macro signals, central banks |
| `happy` | Yes | No | Positive news, progress, science, conservation |

Desktop configs exist for `full`, `tech`, and `finance`. The release packaging helper currently wraps `full` and `tech`.

## Technical Highlights

### 1. Variant architecture, not duplicate apps

World, Tech, Finance, and Happy are not separate frontends glued together at deploy time. They share the same application shell, service layer, and component system, then swap panel defaults, feeds, and map-layer presets through configuration.

### 2. Proto-first API contracts

The API layer is driven by Protobuf and Sebuf rather than handwritten request wiring. That gives the project:

- generated TypeScript clients for the frontend
- generated server bindings for handlers
- generated OpenAPI output for external inspection
- a tighter contract between UI, runtime, and backend behavior

### 3. Local-first desktop runtime

The desktop build runs through Tauri with a localhost Node.js sidecar. The renderer resolves the sidecar port dynamically, authenticates to it with a short-lived local token, and only falls back to remote API paths when the request is allowed to cross that boundary.

### 4. AI orchestration with real fallback behavior

Summarization is not hard-coded to one provider. The system can use Ollama, Groq, Claude, OpenRouter, or browser inference depending on runtime availability and feature configuration. That makes the feature useful in both fully connected and privacy-sensitive environments.

### 5. Geospatial UI with product-specific intelligence layers

The UI combines MapLibre GL and deck.gl for a globe-style monitoring experience, then layers product-specific overlays for conflicts, cables, ports, outages, markets, datacenters, and more. The goal is not just visual density; it is useful correlation between feeds, location, and operator context.

## Architecture Snapshot

| Layer | Stack |
| --- | --- |
| Frontend | TypeScript, Vite, i18next, MapLibre GL, deck.gl, D3 |
| Contracts | Buf, Protobuf, Sebuf, generated TypeScript clients and handlers |
| Web backend | Vercel routes in `api/` plus generated RPC gateway |
| Desktop | Tauri v2, Rust shell, Node.js sidecar, OS keychain integration |
| Verification | Type checks, data tests, sidecar tests, Playwright runtime and visual coverage |

## Quick Start

```bash
npm ci
npm run dev
```

The default dev server runs at [http://localhost:3000](http://localhost:3000).

### Variant commands

```bash
npm run dev:tech
npm run dev:finance
npm run dev:happy
```

### Desktop commands

```bash
npm run desktop:dev
npm run desktop:build:full
npm run desktop:build:tech
npm run desktop:build:finance
```

### Verification commands

```bash
npm run lint:strict
npm run typecheck:all
npm run test:data
npm run test:sidecar
npm run test:e2e:runtime
```

For release bundles and signing, use the packaging guide linked below.

## Recommended Reading

If you want the fastest path through the repo:

| Read this | Why |
| --- | --- |
| [docs/DOCUMENTATION.md](docs/DOCUMENTATION.md) | Curated map of the repository docs |
| [docs/API_KEY_DEPLOYMENT.md](docs/API_KEY_DEPLOYMENT.md) | Cloud/API trust boundary and origin rules |
| [docs/DESKTOP_CONFIGURATION.md](docs/DESKTOP_CONFIGURATION.md) | Desktop runtime capabilities and secret model |
| [docs/RELEASE_PACKAGING.md](docs/RELEASE_PACKAGING.md) | Packaging and release workflow |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contributor workflow and extension points |
| [docs/ADDING_ENDPOINTS.md](docs/ADDING_ENDPOINTS.md) | How the contract-driven API layer is extended |
| [docs/api](docs/api) | Generated OpenAPI output from the current proto surface |

## Documentation

| Guide | Purpose |
| --- | --- |
| [docs/DOCUMENTATION.md](docs/DOCUMENTATION.md) | Entry point for product, architecture, and repo docs |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contributor workflow, checks, and PR expectations |
| [SECURITY.md](SECURITY.md) | Vulnerability reporting and security scope |
| [docs/ADDING_ENDPOINTS.md](docs/ADDING_ENDPOINTS.md) | Proto and Sebuf workflow for new RPC endpoints |
| [docs/DESKTOP_CONFIGURATION.md](docs/DESKTOP_CONFIGURATION.md) | Desktop secret keys, feature availability, and fallback behavior |
| [docs/API_KEY_DEPLOYMENT.md](docs/API_KEY_DEPLOYMENT.md) | Cloud API access rules and origin/key requirements |
| [docs/RELAY_PARAMETERS.md](docs/RELAY_PARAMETERS.md) | Relay and transport environment variables |
| [docs/RELEASE_PACKAGING.md](docs/RELEASE_PACKAGING.md) | Desktop packaging and signing workflow |
| [docs/TAURI_VALIDATION_REPORT.md](docs/TAURI_VALIDATION_REPORT.md) | Desktop validation notes and failure classification |
| [research/README.md](research/README.md) | Narrow autoresearch loop for alerting, source trust, and map performance |

## Contributing

If you change product behavior, API contracts, or operational workflows, update the docs in the same branch. The project is much easier to evaluate when the implementation and the documentation move together.

## License and Attribution

Licensed under AGPL-3.0-only. This desktop project builds on top of [koala73/worldmonitor](https://github.com/koala73/worldmonitor) by Elie Habib.
