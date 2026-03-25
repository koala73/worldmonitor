# Contributing to World Monitor

Thanks for contributing. This repository accepts fixes, features, data-source improvements, docs updates, and testing work.

The project is easiest to work in if you preserve three traits:

- typed interfaces over ad hoc request wiring
- graceful degradation over brittle feature flags
- documentation that stays close to the implementation

## Before You Start

- Read [README.md](README.md) for the current product and command overview.
- Read [docs/DOCUMENTATION.md](docs/DOCUMENTATION.md) for the docs map.
- If you are changing security-sensitive behavior, read [SECURITY.md](SECURITY.md).
- If you are changing RPC contracts, read [docs/ADDING_ENDPOINTS.md](docs/ADDING_ENDPOINTS.md) before editing code.

## Setup

For most frontend and docs work:

```bash
npm ci
npm run dev
```

The dev server runs at [http://localhost:3000](http://localhost:3000).

If you are touching protobuf contracts, generated clients, or Playwright browsers, install the full toolchain:

```bash
make install
```

That installs Buf, the Sebuf codegen plugins, npm dependencies, proto deps, and the default Playwright browser.

## Common Commands

### Run variants

```bash
npm run dev
npm run dev:tech
npm run dev:finance
npm run dev:happy
```

### Verify changes

```bash
npm run lint:strict
npm run typecheck:all
npm run test:data
npm run test:sidecar
npm run test:e2e:runtime
```

### Desktop

```bash
npm run desktop:dev
npm run desktop:build:full
npm run desktop:build:tech
npm run desktop:build:finance
```

For release bundles and signing, use [docs/RELEASE_PACKAGING.md](docs/RELEASE_PACKAGING.md).

## Repository Map

| Path | Purpose |
| --- | --- |
| `src/` | Frontend app, services, config, workers, and UI components |
| `src/components/` | Dashboard panels, settings UI, maps, and modal flows |
| `src/services/` | Data-fetching, summarization, runtime, analysis, and alert logic |
| `src/config/` | Variant settings, feeds, map data, static datasets, and commands |
| `src/locales/` | 18 language bundles and locale metadata |
| `src/generated/` | Generated Sebuf clients and server bindings. Do not hand-edit |
| `proto/` | Protobuf service and message definitions |
| `server/` | Sebuf handler implementations |
| `api/` | Vercel routes, gateway entrypoints, and legacy non-RPC endpoints |
| `src-tauri/` | Tauri desktop app, Rust shell, and local sidecar integration |
| `docs/` | Public docs plus generated OpenAPI artifacts |
| `research/` | Repeatable evaluation tracks and results history |
| `tests/` and `e2e/` | Data tests, runtime tests, and Playwright coverage |

## Working on APIs

All JSON RPC endpoints should go through Sebuf.

If you change `.proto` files:

```bash
make check
```

That lints the contracts and regenerates the TypeScript clients, server bindings, and OpenAPI output.

When adding a new endpoint, follow [docs/ADDING_ENDPOINTS.md](docs/ADDING_ENDPOINTS.md). Keep generated files in sync with the proto definitions in the same branch.

## Working on Desktop Features

- Desktop secrets and feature availability are documented in [docs/DESKTOP_CONFIGURATION.md](docs/DESKTOP_CONFIGURATION.md).
- Relay-specific environment variables live in [docs/RELAY_PARAMETERS.md](docs/RELAY_PARAMETERS.md).
- Cloud API access rules are documented in [docs/API_KEY_DEPLOYMENT.md](docs/API_KEY_DEPLOYMENT.md).

## Documentation Expectations

- Update the relevant docs when behavior, commands, or public interfaces change.
- Prefer linking to a focused guide instead of copying large feature lists into multiple files.
- Run `npm run lint:md` when you touch Markdown.
- Run `npm run lint:strict` before opening a PR.

## Pull Requests

Before opening a PR:

1. Run the checks that cover your change.
2. Update docs for any user-facing, operational, or API changes.
3. Call out which variants are affected: `full`, `tech`, `finance`, and/or `happy`.
4. Keep the branch focused on one change set.

In your PR description, include:

- What changed
- Why it changed
- How you verified it
- Any follow-up work or risks

## Coding Expectations

- Follow the existing TypeScript and file-organization patterns in the repo.
- Keep new code and docs as small and direct as possible.
- Avoid hand-editing generated output unless the generation step explicitly requires it.
- Prefer source-backed statements in docs over marketing copy that can drift.

## Code of Conduct

Participation in this project is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
