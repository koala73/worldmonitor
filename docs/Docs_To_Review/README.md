# Docs To Review (archival)

This directory is **not published by Mintlify** (`.mintignore` excludes it).

Files here are internal / archival / pending-audit. They are **not** the source of truth.

## Canonical docs live at the root of `docs/`

| If you want... | See |
|---|---|
| Architecture overview | `/docs/architecture.mdx` |
| API reference (RPC) | `/docs/api/*.openapi.yaml` + https://docs.worldmonitor.app |
| Non-RPC API endpoints | `/docs/api-{platform,brief,commerce,notifications,shipping-v2,proxies,oauth}.mdx` |
| MCP server | `/docs/mcp-server.mdx` |
| External data sources | `/docs/data-sources.mdx` |
| Release / desktop packaging | `/docs/release-packaging.mdx`, `/docs/desktop-app.mdx` |
| Country instability index | `/docs/country-instability-index.mdx` |

## Removed (2026-04-19)

- `API_REFERENCE.md` — referenced legacy pre-migration endpoints (`/api/acled`, `/api/finnhub`, `/api/fred-data`, etc.) that no longer exist. Superseded by the auto-generated OpenAPI specs under `/docs/api/`.
- `EXTERNAL_APIS.md` — duplicated content now in `/docs/data-sources.mdx`.

## Remaining files

The rest of this directory needs a case-by-case audit — contents may be stale, useful, or mergeable into canonical docs. Don't cite them externally until audited.
