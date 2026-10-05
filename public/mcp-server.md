---
title: "World Monitor MCP server"
description: "MCP transport, discovery methods, tools, and authentication."
canonical: "https://www.worldmonitor.app/mcp-server.md"
---

# World Monitor MCP Server

Last updated: August 19, 2026

The World Monitor MCP Server exposes World Monitor's real-time global-intelligence stack over the [Model Context Protocol](https://modelcontextprotocol.io), so any MCP-compatible client — Claude Desktop, Claude web, Cursor, MCP Inspector, or a custom agent — can pull live conflict, market, aviation, maritime, economic, cyber, and forecasting data directly into a model's context. It is the recommended way for AI agents to consume World Monitor data.

This persistent hosted server is distinct from [WorldMonitor WebMCP](https://www.worldmonitor.app/docs/webmcp), an experimental, page-local Chrome interface that operates the visible website. WebMCP does not replace the hosted MCP server; remote, background, headless, and direct-data agents should use the endpoint below.

## Endpoint

- **Server URL:** `https://worldmonitor.app/mcp` — Streamable HTTP transport, JSON-RPC 2.0 (JSON responses by default, SSE when the client advertises `text/event-stream`; `initialize` defaults to protocol `2025-03-26`). This is the only advertised product MCP server.
- **Aliases:** `www`, `api`, `tech`, `finance`, `commodity`, `happy`, and `energy` under `worldmonitor.app` are a client-migration surface, not extra installations. Ordinary GET/HEAD `/mcp` and `/api/mcp` redirect (308) to `https://worldmonitor.app/mcp`; ordinary GET/HEAD `/.well-known/mcp` and `/.well-known/mcp.json` redirect (308) to `https://worldmonitor.app/.well-known/mcp` and `https://worldmonitor.app/.well-known/mcp.json`. Query is not forwarded. Transport POST, SSE, and replay answer HTTP 410 with JSON-RPC `-32000` `Use https://worldmonitor.app/mcp`.
- **Server card:** https://worldmonitor.app/.well-known/mcp/server-card.json
- **Docs MCP server:** `https://www.worldmonitor.app/docs/mcp` — a second, public (no-auth) MCP server with search-and-retrieval tools over the documentation. Route "how do I…" questions there; route live-data calls to the product server above.

Use the apex server URL for all product MCP clients. Product-host aliases return a canonical migration response; they do not provide a second MCP transport.

## Tools

The server ships tools covering world and country briefs, country risk and resilience, China decision signals, conflict events, markets, commodities, global procurement opportunities, energy, maritime and aviation activity, cyber threats, sanctions, natural disasters, health signals, prediction markets, and AI forecasts. Issue `tools/list` for the live inventory, `prompts/list` for pre-built workflow templates, and `resources/list` for read-only resources. `tools/list`, `prompts/list`, and `resources/list` are **public** — no key required. General data tools accept an optional `jmespath` argument for [server-side projection](https://www.worldmonitor.app/docs/mcp-jmespath). The closed signed `get_forecast_case` and `get_forecast_theaters` readers preserve original evidence and reject projection arguments.

## MCP Apps

World Monitor supports MCP Apps (`io.modelcontextprotocol/ui`) with interactive `ui://` app shells. The linked tools are `get_country_risk`, `get_world_brief`, `get_country_brief`, `get_market_data`, `get_chokepoint_status`, `get_news_intelligence`, `get_conflict_events`, `get_natural_disasters`, `get_prediction_markets`, `get_forecast_predictions`, `open_news_dashboard`, and `open_country_brief`; their UI resources are:

- `ui://worldmonitor/country-risk-v2.html`
- `ui://worldmonitor/world-brief-v2.html`
- `ui://worldmonitor/country-brief-v2.html`
- `ui://worldmonitor/market-radar-v3.html`
- `ui://worldmonitor/chokepoint-monitor-v2.html`
- `ui://worldmonitor/news-intelligence-v2.html`
- `ui://worldmonitor/conflict-events-v2.html`
- `ui://worldmonitor/natural-disasters-v2.html`
- `ui://worldmonitor/prediction-markets-v3.html`
- `ui://worldmonitor/forecasts-v3.html`
- `ui://worldmonitor/news-dashboard-v3.html`
- `ui://worldmonitor/country-view-v3.html`

Hosts discover the links through `_meta.ui.resourceUri` in `tools/list`, enumerate the shells through `resources/list`, and fetch each template with `resources/read`. `ui://` reads are public and quota-exempt because they return static, data-free HTML; live data still arrives through a normal authenticated `tools/call`. Full contract: [MCP Apps](https://www.worldmonitor.app/docs/mcp-apps).

## Authentication

`get_gold_intelligence` preserves gold quotes and optional COT, ETF and central-bank enrichment with individual observation dates; `unavailable` and absent enrichment remain explicit. `get_internet_activity` reads traffic anomalies (optional country) or global DDoS summaries with `limit` 1..100, default 30. The traffic `totalCount` is global before filtering; DDoS percentages are not country-filtered. Both require subscription access and make one signed downstream GET, charged at weight 2 on API allowances (the MCP request plus the downstream request). Missing internet snapshots return an error; valid empty snapshots retain empty lists.

- **Connecting an MCP client:** an `initialize` with no credentials gets `401` with a `WWW-Authenticate` challenge, which starts your client's OAuth sign-in. A free account is enough.
- **`tools/list` and other stateless discovery calls:** anonymous, no key.
- **`get_sources` via `tools/call`:** no credentials and no daily quota; separate fail-closed limit of 10 anonymous calls/minute/IP. Its `tools/list` and server-card entries carry `_meta["worldmonitor/access"]: "free"`.
- **All other data-bearing `tools/call` and `resources/read`:** need subscription access through an API key or OAuth.
  - **API key:** header `X-WorldMonitor-Key: wm_<40-hex>` — issue one at https://www.worldmonitor.app/pro. Per-minute burst is plan-resolved and shared per user across all of an account's keys and OAuth tokens: 60/minute on Pro, Pro Business and API Starter, 300 on API Business, 1,000 on Enterprise. Legacy operator-issued keys stay at a flat 60/minute/key.
  - **OAuth 2.1 (`scope=mcp`):** Pro and API tiers can both connect via OAuth with no API key. Dynamic Client Registration (RFC 7591) at `https://worldmonitor.app/oauth/register`; authorization and token endpoints follow OAuth 2.1 with PKCE. The daily allowance is plan-resolved and identical on both doors, so a dashboard-issued `wm_…` key gets the same budget as an OAuth token for the same account. Pro has 50 units per UTC day and Pro Business has 250 on a dedicated MCP counter. A standalone data call costs one unit. Country, news, curated market, prediction and Conflict Events panels each cost one unit including authorized internal reads. Prediction and Conflict Events filters and repeated opens share their respective admissions within five minutes. A new refresh UUID costs one new allocation, and the same UUID retries it. An explicit authorized prediction or Conflict Events receipt read queries current usage without another allocation. Unknown usage omits the numeric notice. API and free-account calls reject paid prediction and Conflict Events receipt/refresh controls. Optional `conflict_source.ucdp` preserves correctly typed observations from already-read UCDP metadata; missing fields remain absent. Known partial, missing, malformed, stale or incompatible source observations do not replay as successful conflict snapshots. This metadata does not prove atomic publication or completeness of every unrest provider. API Starter is 1,000 units/day and API Business is 10,000, drawn from the same allowance as their REST requests and charged at a per-tool weight of 1 for a cache read, 2 for a live downstream fetch, 3 for `get_country_brief` and `get_airspace`. Enterprise can be unlimited. Quota-free metadata methods and `get_sources` do not reserve a daily slot.

Full agent walkthrough: [auth.md](https://www.worldmonitor.app/auth.md). Authorization-server metadata: https://worldmonitor.app/.well-known/oauth-authorization-server · protected-resource metadata: https://worldmonitor.app/.well-known/oauth-protected-resource

## Connect in one step

```sh
# Confirm reachability with the public CLI (no key):
npx worldmonitor tools
```

Add the server to Claude Desktop / Cursor via their MCP settings using the URL `https://worldmonitor.app/mcp`, or follow the [MCP Quickstart](https://www.worldmonitor.app/docs/mcp-quickstart) for a five-minute path to a real tool call.

## Learn more

- [MCP Overview](https://www.worldmonitor.app/docs/mcp-overview) — auth modes, plans, OAuth setup, full tool catalog
- [WebMCP](https://www.worldmonitor.app/docs/webmcp) — experimental visible-tab browser tools and their security/debugging contract
- [MCP Apps](https://www.worldmonitor.app/docs/mcp-apps) — interactive `ui://` resources, host flow, view security, and drift checks
- [MCP Quickstart](https://www.worldmonitor.app/docs/mcp-quickstart) · [Tool reference](https://www.worldmonitor.app/docs/mcp-tools-reference) · [JMESPath projection](https://www.worldmonitor.app/docs/mcp-jmespath) · [Error catalog](https://www.worldmonitor.app/docs/mcp-error-catalog)
- [Developer Portal](https://www.worldmonitor.app/developers.md) · [REST API OpenAPI spec](https://www.worldmonitor.app/openapi.md) · [SDKs](https://www.worldmonitor.app/sdks.md) · [agents.md](https://www.worldmonitor.app/agents.md)

## Important query matches

- World Monitor MCP server
- World Monitor Model Context Protocol server
- Connect Claude to World Monitor
- Real-time geopolitical intelligence MCP server
- MCP server for markets, conflicts, and global risk data

## Natural Disasters Panel Requests

On Pro and Pro Business, `get_natural_disasters` opens one Natural Disasters allocation. Repeated opens and dataset, magnitude, activity and limit filters reuse that admission within five minutes. Use its returned `panelRequest.token` as `panel_request` for bounded reads. Explicit refresh needs `refresh: true`, a UUID `request_id`, and no reader token; the same UUID retries the refresh allocation. API and free-account callers keep ordinary per-tool charging and existing filter coercions, and reject the paid refresh controls.

Each uncached execution reads three fixed data keys and the existing seismology metadata key as one logical read within the 64-read admission. Exact successful filtered originals replay before summary or JMESPath only until the earliest observable source or EONET retention deadline. A new filter or unavailable, malformed, known degraded or unknown-clock observation can reread under the same allocation. Blocked regional source decisions remain readable but uncached, including zero-request preflight decisions. This does not establish complete provider coverage. The existing news token still permits only its exact hazard dataset list and limits 100, 20 or 1; it cannot use standalone magnitude or activity filters. Source data and internal deadlines do not add public metadata fields. Confirmed current usage accompanies authorized reads; an unknown counter omits the numeric notice.

### News Intelligence panel admission

On Pro and Pro Business, `get_news_intelligence` opens one News Intelligence allocation. Repeated opens, filters, `summary` and JMESPath views reuse the same complete original within the admission window. The returned `panelRequest.token` is a closed `panel_request` for this tool only; news and country receipts cannot authorize it. Explicit refresh uses `refresh: true`, a UUID `request_id`, and no reader token. The same UUID retries that allocation. Authorized receipt reads query current usage without a new allocation; unknown usage omits the numeric notice. API and free-account calls retain ordinary per-tool charging and reject these paid controls.

Reuse uses the existing four dataset GETs and three metadata GETs. It expires at the earliest of the 30/45/60-minute metadata deadlines, the shared 60-minute Insights generation limit, the assessed GDELT content-age deadline, and admission expiry. Advisory publication time is validated, but this source graph has no independent advisory freshness assessment. Missing, degraded, malformed, old, future or unassessed sources remain retryable. Paid reads expose proven stale generation through `stale` and unassessed clocks through `freshnessUnknown`; source values remain intact. The cross-source producer permits an observed empty signal list; empty Insights and advisory bootstrap lists are not reusable. The 64-read limit counts uncached tool executions, not individual Redis GETs. This does not prove complete provider coverage.

### Chokepoint panel admission

On Pro and Pro Business, `get_chokepoint_status` opens one signed `chokepoints` allocation. Repeated filters, `summary` and JMESPath views share that allocation. Complete effective requested source subsets reuse their uncapped originals; changing the normalized dataset subset or chokepoint selector can reacquire sources under the same allocation. Unknown-only dataset selectors use the full bundle. A keyed filter with no match retains the original map, so it cannot manufacture complete empty coverage. Sparse AIS, unavailable today counts and partial modeled flows remain visible and retryable.

Use the returned `panelRequest.token` as `panel_request` only for this tool. Explicit `refresh: true` requires a UUID `request_id` and no reader token; the same UUID retries that allocation. Authorized receipt reads report current usage without reserving another allocation; unknown usage omits the numeric notice. API and free-account calls retain per-tool accounting and reject these paid controls.

An uncached execution uses the existing six dataset GETs, six metadata GETs and one activation EXISTS command. The 64-read admission bound counts tool executions, not those 13 Redis commands. Reuse checks selected source shapes, availability, publication clocks and CN/HK critical content age, both after lookup and before cache storage. Partial, malformed, unassessed or expired originals are not cached as complete. Reference-year baselines and modeled flow publication dates do not prove current metered oil or fresh underlying history. The private wrapped cache remains 512 KiB; tool output remains 128 KiB. This admission change does not add website details, histories, warnings or provider reads.
