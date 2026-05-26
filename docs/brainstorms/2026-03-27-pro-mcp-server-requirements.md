---
date: 2026-03-27
topic: pro-mcp-server
---

# WorldMonitor PRO MCP Server

## Problem Frame

WorldMonitor accumulates, curates, and caches real-time intelligence across 25+ domains. PRO users currently access this data only through the web UI or desktop app. They cannot query it from Claude Desktop, Cursor, Windsurf, or any MCP-compatible AI agent. This creates a hard wall between WorldMonitor's data layer and AI workflows. The MCP server removes that wall: PRO API key holders point their MCP client at `https://api.worldmonitor.app/mcp` and WorldMonitor data becomes natively queryable from any AI agent.

## Requirements

- R1. A new Vercel edge function at `api/mcp.ts` implements the MCP Streamable HTTP transport (protocol version `2025-03-26`), handling `initialize`, `tools/list`, and `tools/call` JSON-RPC methods.
- R2. All requests require a valid PRO API key via `X-WorldMonitor-Key` header, validated against `WORLDMONITOR_VALID_KEYS` using the existing `validateApiKey()` helper. Unauthenticated requests return a JSON-RPC error (code -32001).
- R3. The server exposes one MCP tool per logical domain group. Tools read from the Redis bootstrap cache (Upstash) — no upstream API calls during tool execution.
- R4. Rate limiting reuses the existing per-key Redis rate limiter (same mechanism as the widget agent), enforced before tool execution. Exceeded limit returns a JSON-RPC error (code -32029).
- R5. `tools/list` returns all tools regardless of which domains have fresh cache data. Stale or empty cache is a tool-call concern, not a registration concern.
- R6. Each tool response includes a `cached_at` timestamp and a `stale` boolean (true when cache age exceeds the domain's expected refresh interval) so agents can reason about data freshness.
- R7. Tool call errors (stale cache, Redis unavailable, unknown domain) return structured JSON-RPC errors with human-readable `message` fields, never raw exceptions.

## Tool Inventory (v1 — all domains)

| Tool name | Data sources | Description |
|-----------|-------------|-------------|
| `get_market_data` | stocks, commodities, crypto, sectors, ETFs, gulf | Equity quotes, commodity prices, crypto prices, sector performance |
| `get_conflict_events` | ACLED, UCDP, unrest scores | Active conflict events with geo coordinates and country risk scores |
| `get_aviation_status` | FAA delays, NOTAM, military flights | Airport delays, airspace closures, tracked military aircraft |
| `get_news_intelligence` | news threat summaries, CII, top headlines | AI-classified threat news, country instability index, top geopolitical signals |
| `get_natural_disasters` | USGS seismology, FIRMS wildfire, thermal | Earthquakes, wildfires, thermal anomalies |
| `get_maritime_status` | NGA warnings, AIS snapshot, vessel data | Navigation warnings, vessel positions and anomalies |
| `get_military_posture` | military bases, GPS jamming, satellites | Tracked assets, GPS degradation zones, satellite positions |
| `get_cyber_threats` | URLhaus, CISA KEV, Feodotracker | Active malware IOCs, CISA known exploited vulnerabilities |
| `get_economic_data` | FRED, EIA, consumer prices, central banks | Macro indicators, energy prices, inflation, central bank rates |
| `get_prediction_markets` | Polymarket | Active event contracts and probabilities |
| `get_sanctions_data` | OFAC SDN | Sanctioned entities with name-search support |
| `get_climate_data` | Open-Meteo, NASA EONET, GDACS | Temperature anomalies, environmental alerts, disaster alerts |
| `get_displacement_data` | UNHCR | Refugee and IDP counts by country |
| `get_infrastructure_status` | Cloudflare Radar, submarine cables | Internet health, cable disruptions |
| `get_supply_chain_data` | shipping stress, trade routes | Dry bulk shipping stress index, chokepoint pressure |
| `get_positive_events` | positive geo-events bootstrap | Diplomatic, humanitarian, and development positive signals |
| `get_webcams` | live webcam feeds | Active public webcam feed URLs by region |

## Success Criteria

- A PRO user can add WorldMonitor as an MCP server in Claude Desktop using only their API key and `https://api.worldmonitor.app/mcp` as the URL — no install, no CLI.
- `tools/list` response is < 500ms (served from in-memory registry, no Redis calls).
- Tool calls that hit warm Redis cache respond in < 800ms end-to-end.
- All 17 tools return valid JSON-RPC responses (not 500s) even when cache is empty (return empty arrays with `stale: true`).
- Rate limit enforcement blocks runaway agents without affecting normal usage patterns (< 60 calls/min per key).

## Scope Boundaries

- No write tools (no mutations, no user-specific state).
- No streaming or SSE tool responses — standard JSON-RPC request/response only.
- No new data sources added for MCP; tools surface existing bootstrap cache only.
- No tool-level ACL beyond the PRO gate (all PRO keys get all tools).
- No MCP resource or prompt primitives in v1 — tools only.
- `api/mcp-proxy.js` (external MCP proxy for the widget agent) is unrelated and untouched.

## Key Decisions

- **Vercel edge endpoint**: Zero new infrastructure. Reads from existing Upstash Redis. Same auth as desktop app. 60s timeout is acceptable since all tool calls read from Redis (no upstream API I/O).
- **One tool per domain group**: ~17 tools is optimal for AI discoverability. Fine-grained tools would create a naming/documentation surface area problem and offer no real benefit when the data is already colocated in the bootstrap cache.
- **All domains in v1**: Bootstrap cache already seeds all domains. There is no engineering reason to phase domains — they all read from Redis identically.
- **Reuse existing rate limiter**: Consistency with the widget agent. Avoids building a second rate limit system.
- **`stale` flag in responses**: Agents need to know data freshness to decide whether to trust or re-query. The bootstrap intervals are known (market: 5min, conflict: 30min, etc.) so this is computable.

## Dependencies / Assumptions

- All tool domains have active seed scripts or relay loops keeping Redis fresh (true as of 2026-03-27, per health.js BOOTSTRAP_KEYS).
- `WORLDMONITOR_VALID_KEYS` env var is already set in Vercel production (it is — used by desktop auth).
- The Upstash Redis client (`@upstash/redis`) is already in package.json (it is).
- MCP Streamable HTTP transport is supported by Claude Desktop as of protocol version 2025-03-26 (confirmed in `api/mcp-proxy.js`).

## Outstanding Questions

### Deferred to Planning

- [Affects R3][Technical] What is the exact Redis key and shape for each domain's bootstrap entry? Planner should read `api/bootstrap.js` and `api/health.js` BOOTSTRAP_KEYS to map tool → cache key → expected shape.
- [Affects R1][Technical] Should `api/mcp.ts` live at a flat path or use a catch-all route (`api/mcp/[...path].ts`)? Depends on whether the MCP client sends sub-paths (e.g. `/mcp/sse`). Planner should check the MCP 2025-03-26 spec for path requirements.
- [Affects R4][Technical] The existing rate limiter is in `api/_rate-limit.js`. Planner should verify it's edge-compatible (no Node.js APIs) before wiring it in.
- [Affects R6][Needs research] What is the expected refresh interval per domain? Planner should extract `maxStaleMin` from `api/health.js` BOOTSTRAP_KEYS to compute `stale` flag per tool.

## Next Steps

→ `/ce:plan` for structured implementation planning
