# GitHub Copilot Instructions — World Monitor

## Project Overview

World Monitor is a real-time OSINT intelligence dashboard built with **Vanilla TypeScript** (no UI framework). It aggregates 30+ external data sources — geopolitics, military activity, financial markets, cyber threats, climate events — rendered on an interactive 3D globe via MapLibre GL and deck.gl, with a grid of specialised data panels.

Deployment: static SPA on Vercel CDN + 60+ Vercel Edge Functions + optional Tauri desktop shell.

---

## Repository Layout

```
src/components/    UI components — Panel subclasses, map, modals (~50 panels)
src/services/      Data fetching modules — sebuf clients, AI, signal analysis
src/config/        Static data and variant configs (feeds, geo, military, pipelines)
src/generated/     Auto-generated sebuf client + server stubs (do NOT edit by hand)
src/types/         TypeScript type definitions
src/locales/       i18n JSON files (14 languages)
src/workers/       Web Workers for ML/signal analysis
server/            Sebuf handler implementations for 17 domain services
api/               Vercel Edge Functions (sebuf gateway + legacy endpoints)
proto/             Protobuf service and message definitions
data/              Static JSON datasets
src-tauri/         Tauri v2 Rust app + Node.js sidecar (desktop)
e2e/               Playwright end-to-end tests
scripts/           Build and packaging scripts
docs/              Documentation + generated OpenAPI specs
```

---

## Variant System

Three app variants share all source code but differ in default panels, map layers, and RSS feeds:

| Variant   | Command              | Audience                                       |
|-----------|----------------------|------------------------------------------------|
| `full`    | `npm run dev`        | Geopolitics, military, conflicts, disaster     |
| `tech`    | `npm run dev:tech`   | Startups, AI/ML, cloud, cybersecurity          |
| `finance` | `npm run dev:finance`| Markets, trading, central banks, commodities   |

Variant configs live in `src/config/variants/`.

---

## Key Technologies

- **TypeScript** — all code (frontend, edge functions, handlers). Avoid `any`; use `unknown` + type guards.
- **Vite** — build tool / dev server
- **Sebuf** — proto-first HTTP RPC framework. Service definitions in `proto/`, generated stubs in `src/generated/`, handlers in `server/worldmonitor/{domain}/v1/`
- **Protobuf / Buf** — 17 domain services
- **MapLibre GL** — base map (tiles, globe mode, camera)
- **deck.gl** — WebGL overlay layers (scatterplot, geojson, arcs, heatmaps)
- **d3** — charts, sparklines, data visualization
- **Vercel Edge Functions** — serverless API gateway
- **Tauri v2** — desktop app (macOS, Windows, Linux)
- **Playwright** — E2E and visual regression testing
- **DOMPurify** — HTML sanitization before any DOM insertion

---

## Build & Test Commands

```bash
npm run dev                 # Start dev server (full variant, port 3000)
npm run dev:tech            # Tech variant
npm run dev:finance         # Finance variant
npm run typecheck           # TypeScript type check (no emit)
npm run typecheck:all       # Typecheck frontend + API tsconfigs
npm run test:sidecar        # Node native test runner — sidecar + API unit tests
npm run test:data           # Data integrity tests
npm run test:e2e            # Playwright E2E tests
npm run build               # Production build (full variant)
npm run build:desktop       # Desktop production build
npm run lockfile:check      # Verify package-lock.json integrity
npm run lint:md             # Markdown linting
```

Run **`npm run typecheck`** and **`npm run test:sidecar`** before every PR.

## Merge And Main-To-Mac Delivery

- Agent branches such as `copilot/*`, `claude/*`, and `codex/*` must go through PRs and GitHub auto-merge. Do not use direct PR merges to bypass required checks.
- `main` is the only merge target.
- Official desktop releases remain tag-driven.
- Bradley's local Mac install path is synchronized from `main` by `npm run main-sync:setup`, which installs a LaunchAgent that polls `macos/main` from a dedicated clean clone at `~/.worldmonitor-main-sync/repo`.
- That sync path must verify GitHub required checks for `main`, then run `npm run lockfile:check`, `npm ci`, `npm run version:check`, `npm run typecheck:all`, `npm run build`, `npm run desktop:build:app:full`, and install via `node scripts/install-built-app.mjs --relaunch`.
- Update `AGENTS.md`, `CLAUDE.md`, and these instructions together whenever the sync contract changes.
- Do not add `self-hosted` jobs to PR-triggered workflows in this public repository.

---

## Coding Conventions

### TypeScript

- `const` by default, `let` only when reassignment is needed
- Prefer functional patterns (`map`, `filter`, `reduce`) over imperative loops
- Export interfaces/types for all public APIs
- JSDoc on all exported functions and non-obvious logic
- No `any` — use proper types or `unknown` with type guards

### HTML / DOM Safety

- All dynamically-generated HTML **must** be passed through `DOMPurify.sanitize()` before DOM insertion. This prevents XSS.
- See `GDACSAlertsPanel` and `VolcanoAlertsPanel` for the established pattern.

### Sanitization Utilities (`src/utils/sanitize.ts`)

- `sanitizeUrl()` — validates URLs, **blocks private/loopback IPs** (SSRF protection)
- `escapeHtml()` — HTML entity escaping for string interpolation
- Import via the barrel: `import { sanitizeUrl, escapeHtml } from '@/utils'`

### Sidecar / API Routes (Vercel Edge + Tauri sidecar)

- Each route follows: fetch → validate → transform → return JSON with `Content-Type: application/json`
- Use `AbortController` with a 10s timeout on every upstream fetch
- Individual upstream failures return partial data, never a 500
- For cached routes, use a `Map<string, {data: unknown, ts: number}>` with a TTL helper; add a `// CACHE PATTERN` comment (see `api/economic-stress.js` for the reference implementation)

### Error Handling

- Wrap all API handlers in try/catch; return `{ error: '...' }` with appropriate status codes
- Never leak upstream error messages to clients

### File Placement

- Static layer/geo data → `src/config/`
- Sebuf handlers → `server/worldmonitor/{domain}/v1/`
- Edge functions → `api/`
- UI panels → `src/components/`
- Service modules → `src/services/`
- Proto definitions → `proto/worldmonitor/{domain}/v1/`

---

## Panel Development Pattern

Panels are class-based TypeScript components that extend a base `Panel` class. Key lifecycle hooks:

1. `render()` — returns an HTML string (must be sanitized before injection)
2. `refresh()` — fetches new data and calls `render()`
3. The panel registers itself in `src/config/panels.ts` and `src/config/feeds.ts`

Panel keys must also be added to the appropriate variant config if they should appear by default.

---

## Sebuf RPC Pattern

1. Define the protobuf message + service in `proto/worldmonitor/{domain}/v1/{service}.proto`
2. Run `make generate` to regenerate stubs in `src/generated/` and `server/`
3. Implement the handler in `server/worldmonitor/{domain}/v1/{ServiceHandler}.ts`
4. The gateway (`api/[[...path]].js`) routes calls automatically — no manual wiring needed
5. **Never edit files in `src/generated/`** — they are overwritten on each `make generate`

---

## AI Provider Chain

AI summarization uses a priority fallback chain:

1. Ollama (local, desktop-first) — if `OLLAMA_API_URL` + `OLLAMA_MODEL` are set
2. Groq (`GROQ_API_KEY`) — 14,400 req/day free tier
3. OpenRouter (`OPENROUTER_API_KEY`) — 50 req/day free tier
4. Browser ONNX model (Transformers.js, ~250MB download, user opt-in)

Anthropic Claude (`ANTHROPIC_API_KEY`) is a secondary cloud provider used for the dedicated Claude AI Panel. All panel summaries use the primary fallback chain above.

---

## Security Guidelines

- **Never commit secrets** — use `.env.local` or Vercel/GitHub environment variables
- This repository is a user-owned repo on GitHub, so GitHub's non-provider patterns and validity checks are unavailable here. The compensating control is the repo-owned secret scan gate in local hooks and CI; keep it enabled and green.
- **SSRF protection** — always use `sanitizeUrl()` from `src/utils` when handling user-supplied URLs
- **XSS protection** — always call `DOMPurify.sanitize()` before injecting HTML into the DOM
- **Rate limiting** — API routes use Upstash Redis (`@upstash/ratelimit`) for per-IP limits
- **CORS** — all edge functions use the `_cors.mjs` helper from `api/`; never set `Access-Control-Allow-Origin: *` on authenticated endpoints

---

## Branding

The application is called **World Monitor**. Do not rename it to anything else (e.g., "Crystal Ball").
