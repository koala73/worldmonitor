# Contributing to World Monitor

Thank you for your interest in contributing to World Monitor! This project thrives on community contributions — whether it's code, data sources, documentation, or bug reports.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [How to Contribute](#how-to-contribute)
- [Pull Request Process](#pull-request-process)
- [AI-Assisted Development](#ai-assisted-development)
- [Coding Standards](#coding-standards)
- [Working with Sebuf (RPC Framework)](#working-with-sebuf-rpc-framework)
- [Adding Data Sources](#adding-data-sources)
- [Adding RSS Feeds](#adding-rss-feeds)
- [Reporting Bugs](#reporting-bugs)
- [Feature Requests](#feature-requests)
- [Code of Conduct](#code-of-conduct)

## Architecture Overview

World Monitor is a real-time OSINT dashboard built with **Vanilla TypeScript** (no UI framework), **MapLibre GL + deck.gl** for map rendering, and a custom Proto-first RPC framework called **Sebuf** for all API communication.

### Key Technologies

| Technology | Purpose |
|---|---|
| **TypeScript** | All code — frontend, edge functions, and handlers |
| **Vite** | Build tool and dev server |
| **Sebuf** | Proto-first HTTP RPC framework for typed API contracts |
| **Protobuf / Buf** | Service and message definitions across 17 domains |
| **MapLibre GL** | Base map rendering (tiles, globe mode, camera) |
| **deck.gl** | WebGL overlay layers (scatterplot, geojson, arcs, heatmaps) |
| **d3** | Charts, sparklines, and data visualization |
| **Vercel Edge Functions** | Serverless API gateway |
| **Tauri v2** | Desktop app (Windows, macOS, Linux) |
| **Convex** | Minimal backend (beta interest registration only) |
| **Playwright** | End-to-end and visual regression testing |

### Variant System

The codebase produces three app variants from the same source, each targeting a different audience:

| Variant | Command | Focus |
|---|---|---|
| `full` | `npm run dev` | Geopolitics, military, conflicts, infrastructure |
| `tech` | `npm run dev:tech` | Startups, AI/ML, cloud, cybersecurity |
| `finance` | `npm run dev:finance` | Markets, trading, central banks, commodities |

Variants share all code but differ in default panels, map layers, and RSS feeds. Variant configs live in `src/config/variants/`.

### Directory Structure

| Directory | Purpose |
|---|---|
| `src/components/` | UI components — Panel subclasses, map, modals (~50 panels) |
| `src/services/` | Data fetching modules — sebuf client wrappers, AI, signal analysis |
| `src/config/` | Static data and variant configs (feeds, geo, military, pipelines, ports) |
| `src/generated/` | Auto-generated sebuf client + server stubs (**do not edit by hand**) |
| `src/types/` | TypeScript type definitions |
| `src/locales/` | i18n JSON files (14 languages) |
| `src/workers/` | Web Workers for analysis |
| `server/` | Sebuf handler implementations for all 17 domain services |
| `api/` | Vercel Edge Functions (sebuf gateway + legacy endpoints) |
| `proto/` | Protobuf service and message definitions |
| `data/` | Static JSON datasets |
| `docs/` | Documentation + generated OpenAPI specs |
| `src-tauri/` | Tauri v2 Rust app + Node.js sidecar for desktop builds |
| `e2e/` | Playwright end-to-end tests |
| `scripts/` | Build and packaging scripts |

## Getting Started

1. **Fork** the repository on GitHub
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/<your-username>/worldmonitor.git
   cd worldmonitor
   ```
3. **Create a branch** for your work:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Development Setup

```bash
# Install everything (buf CLI, sebuf plugins, npm deps, Playwright browsers)
make install

# Start the development server (full variant, default)
npm run dev

# Start other variants
npm run dev:tech
npm run dev:finance

# Run type checking
npm run typecheck

# Run tests
npm run test:data          # Data integrity tests
npm run test:e2e           # Playwright end-to-end tests

# Production build (per variant)
npm run build              # full
npm run build:tech
npm run build:finance
```

The dev server runs at `http://localhost:3000`. Run `make help` to see all available make targets.

### Environment Variables (Optional)

For full functionality, copy `.env.example` to `.env.local` and fill in the API keys you need. The app runs without any API keys — external data sources will simply be unavailable.

See [API Dependencies](docs/DOCUMENTATION.md#api-dependencies) for the full list.

## How to Contribute

### Types of Contributions We Welcome

- **Bug fixes** — found something broken? Fix it!
- **New data layers** — add new geospatial data sources to the map
- **RSS feeds** — expand our 100+ feed collection with quality sources
- **UI/UX improvements** — make the dashboard more intuitive
- **Performance optimizations** — faster loading, better caching
- **Documentation** — improve docs, add examples, fix typos
- **Accessibility** — make the dashboard usable by everyone
- **Internationalization** — help make World Monitor available in more languages
- **Tests** — add unit or integration tests

### What We're Especially Looking For

- New data layers (see [Adding Data Sources](#adding-data-sources))
- Feed quality improvements and new RSS sources
- Mobile responsiveness improvements
- Performance optimizations for the map rendering pipeline
- Better anomaly detection algorithms

## Pull Request Process

1. **Update documentation** if your change affects the public API or user-facing behavior
2. **Run type checking** before submitting: `npm run typecheck`
3. **Test your changes** locally with at least the `full` variant, and any other variant your change affects
4. **Keep PRs focused** — one feature or fix per pull request
5. **Write a clear description** explaining what your PR does and why
6. **Link related issues** if applicable

### PR Title Convention

Use a descriptive title that summarizes the change:

- `feat: add earthquake magnitude filtering to map layer`
- `fix: resolve RSS feed timeout for Al Jazeera`
- `docs: update API dependencies section`
- `perf: optimize marker clustering at low zoom levels`
- `refactor: extract threat classifier into separate module`

### Review Process

- All PRs require review from a maintainer before merging
- Maintainers may request changes — this is normal and collaborative
- Once approved, a maintainer will merge your PR

## AI-Assisted Development

We fully embrace AI-assisted development. Many of our own PRs are labeled with the LLM that helped produce them (e.g., `claude`, `codex`, `cursor`), and contributors are welcome to use any AI tools they find helpful.

That said, **all code is held to the same quality bar regardless of how it was written**. AI-generated code will be reviewed with the same scrutiny as human-written code. Contributors are responsible for understanding and being able to explain every line they submit. Blindly pasting LLM output without review is discouraged — treat AI as a collaborator, not a replacement for your own judgement.

## Coding Standards

### TypeScript

- Use TypeScript for all new code
- Avoid `any` types — use proper typing or `unknown` with type guards
- Export interfaces/types for public APIs
- Use meaningful variable and function names

### Code Style

- Follow the existing code style in the repository
- Use `const` by default, `let` when reassignment is needed
- Prefer functional patterns (map, filter, reduce) over imperative loops
- Keep functions focused — one responsibility per function
- Add JSDoc comments for exported functions and complex logic

### File Organization

- Static layer/geo data and variant configs go in `src/config/`
- Sebuf handler implementations go in `server/worldmonitor/{domain}/v1/`
- Edge function gateway and legacy endpoints go in `api/`
- UI components (panels, map, modals) go in `src/components/`
- Service modules (data fetching, client wrappers) go in `src/services/`
- Proto definitions go in `proto/worldmonitor/{domain}/v1/`

## Working with Sebuf (RPC Framework)

Sebuf is the project's custom Proto-first HTTP RPC framework — a lightweight alternative to gRPC-Web. All API communication between client and server uses Sebuf.

### How It Works

1. **Proto definitions** in `proto/worldmonitor/{domain}/v1/` define services and messages
2. **Code generation** (`make generate`) produces:
   - TypeScript clients in `src/generated/client/` (e.g., `MarketServiceClient`)
   - Server route factories in `src/generated/server/` (e.g., `createMarketServiceRoutes`)
3. **Handlers** in `server/worldmonitor/{domain}/v1/handler.ts` implement the service interface
4. **Gateway** in `api/[domain]/v1/[rpc].ts` registers all handlers and routes requests
5. **Clients** in `src/services/{domain}/index.ts` wrap the generated client for app use

### Adding a New RPC Method

1. Add the method to the `.proto` service definition
2. Run `make generate` to regenerate client/server stubs
3. Implement the handler method in the domain's `handler.ts`
4. The client stub is auto-generated — use it from `src/services/{domain}/`

Use `make lint` to lint proto files and `make breaking` to check for breaking changes against main.

### Proto Conventions

- **Time fields**: Use `int64` (Unix epoch milliseconds), not `google.protobuf.Timestamp`
- **int64 encoding**: Apply `[(sebuf.http.int64_encoding) = INT64_ENCODING_NUMBER]` on time fields so TypeScript receives `number` instead of `string`
- **HTTP annotations**: Every RPC method needs `option (sebuf.http.config) = { path: "...", method: POST }`

### Proto Codegen Requirements

Run `make install` to install everything automatically, or install individually:

```bash
make install-buf       # Install buf CLI (requires Go)
make install-plugins   # Install sebuf protoc-gen plugins (requires Go)
```

## Adding Data Sources

To add a new data layer to the map:

1. **Define the data source** — identify the API or dataset you want to integrate
2. **Add the proto service** (if the data needs a backend proxy) — define messages and RPC methods in `proto/worldmonitor/{domain}/v1/`
3. **Generate stubs** — run `make generate`
4. **Implement the handler** in `server/worldmonitor/{domain}/v1/`
5. **Register the handler** in `api/[domain]/v1/[rpc].ts` and `vite.config.ts` (for local dev)
6. **Create the service module** in `src/services/{domain}/` wrapping the generated client
7. **Add the layer config** and implement the map renderer following existing layer patterns
8. **Add to layer toggles** — make it toggleable in the UI
9. **Document the source** — add it to `docs/DOCUMENTATION.md`

For endpoints that deal with non-JSON payloads (XML feeds, binary data, HTML embeds), you can add a standalone Edge Function in `api/` instead of Sebuf. For anything returning JSON, prefer Sebuf — the typed contracts are always worth it.

### Data Source Requirements

- Must be freely accessible (no paid-only APIs for core functionality)
- Must have a permissive license or be public government data
- Should update at least daily for real-time relevance
- Must include geographic coordinates or be geo-locatable

## Adding RSS Feeds

To add new RSS feeds:

1. Verify the feed is reliable and actively maintained
2. Assign a **source tier** (1-4) based on editorial reliability
3. Flag any **state affiliation** or **propaganda risk**
4. Categorize the feed (geopolitics, defense, energy, tech, etc.)
5. Test that the feed parses correctly through the RSS proxy

## Reporting Bugs

When filing a bug report, please include:

- **Description** — clear description of the issue
- **Steps to reproduce** — how to trigger the bug
- **Expected behavior** — what should happen
- **Actual behavior** — what actually happens
- **Screenshots** — if applicable
- **Browser/OS** — your environment details
- **Console errors** — any relevant browser console output

Use the [Bug Report issue template](https://github.com/koala73/worldmonitor/issues/new/choose) when available.

## Feature Requests

We welcome feature ideas! When suggesting a feature:

- **Describe the problem** it solves
- **Propose a solution** with as much detail as possible
- **Consider alternatives** you've thought about
- **Provide context** — who would benefit from this feature?

Use the [Feature Request issue template](https://github.com/koala73/worldmonitor/issues/new/choose) when available.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior through GitHub issues or by contacting the repository owner.

---

Thank you for helping make World Monitor better! 🌍
