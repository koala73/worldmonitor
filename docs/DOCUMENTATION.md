# World Monitor Documentation

This repo is easiest to understand in layers: product surface first, runtime boundaries second, then extension points and release mechanics. The guides below are organized that way so a reviewer can move quickly from "what is this?" to "how is this built?" without digging through the whole tree.

## Fastest Way To Evaluate The Project

If you have ten minutes, read these in order:

| Read this | Why it matters |
| --- | --- |
| [../README.md](../README.md) | Product overview, architecture thesis, and repo-level capabilities |
| [API_KEY_DEPLOYMENT.md](API_KEY_DEPLOYMENT.md) | Clear view of the cloud trust boundary and origin rules |
| [DESKTOP_CONFIGURATION.md](DESKTOP_CONFIGURATION.md) | Desktop secret model, runtime capabilities, and graceful degradation |
| [RELEASE_PACKAGING.md](RELEASE_PACKAGING.md) | Evidence that the desktop target is treated like a real deliverable |

## Product Snapshot

World Monitor currently ships:

- `4` web variants
- `3` desktop build targets
- `21` generated OpenAPI specs
- `18` locale bundles
- `25` desktop secret slots backed by the OS keychain

Those numbers come from the current codebase, not aspirational copy.

## Architecture Reading Path

| Guide | Focus |
| --- | --- |
| [../README.md](../README.md) | High-level system overview and technical posture |
| [../SECURITY.md](../SECURITY.md) | Security scope, reporting path, and desktop/runtime boundaries |
| [local-backend-audit.md](local-backend-audit.md) | Desktop sidecar parity matrix and fallback behavior |
| [TAURI_VALIDATION_REPORT.md](TAURI_VALIDATION_REPORT.md) | Validation outcomes and failure classification |

## Runtime and Operations Docs

| Guide | Focus |
| --- | --- |
| [DESKTOP_CONFIGURATION.md](DESKTOP_CONFIGURATION.md) | Desktop secret keys, feature availability, and degraded behavior |
| [API_KEY_DEPLOYMENT.md](API_KEY_DEPLOYMENT.md) | Vercel API access rules, trusted origins, and key requirements |
| [RELAY_PARAMETERS.md](RELAY_PARAMETERS.md) | Relay environment variables for AIS and OpenSky paths |
| [RELEASE_PACKAGING.md](RELEASE_PACKAGING.md) | Tauri packaging, signing, and clean-machine validation |

## API and Extension Docs

| Guide | Focus |
| --- | --- |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Contributor workflow, verification, and repo map |
| [ADDING_ENDPOINTS.md](ADDING_ENDPOINTS.md) | How to add or extend Sebuf RPC endpoints |
| [api](api) | Generated OpenAPI specs from the live proto surface |

The generated specs under `docs/api/` are the canonical output of the current contract layer. If you change `.proto` files, regenerate them with:

```bash
make generate
```

## Research Docs

| Guide | Focus |
| --- | --- |
| [../research/README.md](../research/README.md) | Repeatable autoresearch loop and track execution |

## Verification Commands

For docs or product-surface updates, these are the most useful baseline checks:

```bash
npm run lint:strict
npm run typecheck:all
npm run test:data
npm run test:sidecar
npm run test:e2e:runtime
```

If you touch contracts, also run:

```bash
make check
```
