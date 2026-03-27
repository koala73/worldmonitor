---
title: "feat: PRO MCP Server — WorldMonitor data via Model Context Protocol"
type: feat
status: active
date: 2026-03-27
origin: docs/brainstorms/2026-03-27-pro-mcp-server-requirements.md
---

# PRO MCP Server — WorldMonitor Data via Model Context Protocol

## Overview

Add a Vercel edge function at `api/mcp.ts` that implements the MCP Streamable HTTP transport (protocol `2025-03-26`). PRO API key holders point any MCP client (Claude Desktop, Cursor, Windsurf, etc.) at `https://api.worldmonitor.app/mcp` and WorldMonitor's cached intelligence becomes natively queryable from their AI workflows — no install, no separate service.

The server exposes 17 tools covering all major data domains. Every tool reads from the existing Redis bootstrap cache (Upstash). No upstream API calls happen during tool execution. Auth reuses `validateApiKey()`. Rate limiting uses a new per-key Upstash sliding window.

## Problem Statement

WorldMonitor accumulates, curates, and caches real-time intelligence across 25+ domains. PRO users access this data only through the web UI or desktop app. There is no programmatic interface for AI agents. This adds a PRO MCP server that turns WorldMonitor from "a dashboard to look at" into "a data source AI agents query directly."

(see origin: docs/brainstorms/2026-03-27-pro-mcp-server-requirements.md)

## Proposed Solution

Single new edge function `api/mcp.ts` implementing MCP Streamable HTTP. All supporting helpers (`_api-key.js`, `_rate-limit.js`, `_upstash-json.js`, `_cors.js`, `_json-response.js`) already exist in `api/`. No new infrastructure, no new npm packages beyond what is already in `package.json`.

## Technical Approach

### Architecture

```
MCP Client (Claude Desktop / Cursor / etc.)
  │
  │  POST https://api.worldmonitor.app/mcp
  │  X-WorldMonitor-Key: wm_xxx
  │
  ▼
api/mcp.ts (Vercel Edge Runtime)
  ├── validateApiKey(req, { forceKey: true })  ← api/_api-key.js
  ├── perKeyRatelimit.limit(apiKey)             ← @upstash/ratelimit (new instance)
  ├── dispatch(method)
  │     ├── initialize → { result, Mcp-Session-Id }
  │     ├── notifications/initialized → 202
  │     ├── tools/list → TOOL_REGISTRY (in-memory, no Redis)
  │     └── tools/call → readJsonFromUpstash(key[]) → format → { content }
  └── jsonResponse(jsonRpcPayload)              ← api/_json-response.js
        │
        ▼
  Upstash Redis (read-only, existing bootstrap keys)
```

### MCP Protocol (Streamable HTTP, version 2025-03-26)

The protocol is already implemented client-side in `api/mcp-proxy.js`. The server-side mirror:

| Method | Server behavior |
|--------|----------------|
| `initialize` | Return `{ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'worldmonitor', version: '1.0' } }`. Set `Mcp-Session-Id` response header (random UUID). |
| `notifications/initialized` | Return 202 with empty body. |
| `tools/list` | Return `TOOL_REGISTRY` — in-memory module-level constant, never calls Redis. |
| `tools/call` | Execute the named tool: read from Redis, shape response, return `{ content: [{ type: 'text', text: JSON.stringify(data) }] }`. |

All methods use POST. Request body: `{ jsonrpc: '2.0', id, method, params }`. Response: `{ jsonrpc: '2.0', id, result }` or `{ jsonrpc: '2.0', id, error: { code, message } }`.

**JSON-RPC error codes:**

- `-32600` — Invalid request (malformed body)
- `-32601` — Method not found
- `-32602` — Invalid params (unknown tool name)
- `-32001` — Unauthorized (missing or invalid API key)
- `-32029` — Rate limit exceeded

### Rate Limiting (per-key, not per-IP)

The existing `checkRateLimit()` in `api/_rate-limit.js` keys by IP, which is correct for public endpoints but wrong for MCP — multiple AI agent users may share an IP, and each PRO key should have its own budget.

Create a new Upstash Ratelimit instance inside `api/mcp.ts` keyed by the API key value:

```ts
const mcpRatelimit = new Ratelimit({
  redis: new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN }),
  limiter: Ratelimit.slidingWindow(60, '60 s'), // 60 calls/min per key
  prefix: 'rl:mcp',
});

const { success } = await mcpRatelimit.limit(apiKey);
if (!success) return jsonRpcError(id, -32029, 'Rate limit exceeded');
```

60 calls/min is conservative for normal agent usage and prevents runaway loops. Different from the 600/min web rate limit since MCP calls are more expensive (each triggers a Redis read).

### Tool Registry (in-memory constant)

```ts
// Module-level constant — no Redis, no I/O, served from V8 memory
const TOOL_REGISTRY: McpTool[] = [
  {
    name: 'get_market_data',
    description: 'Real-time equity quotes, commodity prices, crypto prices, sector performance, and ETF flows.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    _cacheKeys: ['market:stocks-bootstrap:v1', 'market:commodities-bootstrap:v1', 'market:crypto:v1', 'market:sectors:v1', 'market:gulf-quotes:v1'],
    _seedMetaKey: 'seed-meta:market:stocks',
    _maxStaleMin: 30,
  },
  // ... all 17 tools
];
```

The `_`-prefixed fields are internal to the server — not exposed in `tools/list` responses.

### Tool Inventory & Redis Keys

| Tool | Redis cache key(s) | maxStaleMin |
|------|-------------------|-------------|
| `get_market_data` | `market:stocks-bootstrap:v1`, `market:commodities-bootstrap:v1`, `market:crypto:v1`, `market:sectors:v1`, `market:gulf-quotes:v1` | 30 |
| `get_conflict_events` | `conflict:ucdp-events:v1`, `conflict:iran-events:v1`, `unrest:events:v1`, `risk:scores:sebuf:stale:v1` | 30 |
| `get_aviation_status` | `aviation:delays-bootstrap:v1` | 90 |
| `get_news_intelligence` | `news:insights:v1`, `intelligence:gdelt-intel:v1`, `intelligence:cross-source-signals:v1` | 30 |
| `get_natural_disasters` | `seismology:earthquakes:v1`, `wildfire:fires:v1`, `natural:events:v1` | 30 |
| `get_maritime_status` | _(on-demand, no bootstrap key — returns empty with stale: true in v1)_ | N/A |
| `get_military_posture` | `theater_posture:sebuf:stale:v1` | 120 |
| `get_cyber_threats` | `cyber:threats-bootstrap:v2` | 240 |
| `get_economic_data` | `economic:fred:v1:FEDFUNDS:0`, `economic:econ-calendar:v1`, `economic:fuel-prices:v1`, `economic:ecb-fx-rates:v1` | 30 |
| `get_prediction_markets` | `prediction:markets-bootstrap:v1` | 90 |
| `get_sanctions_data` | `sanctions:entities:v1`, `sanctions:pressure:v1` | 1440 |
| `get_climate_data` | `climate:anomalies:v1`, `natural:events:v1` | 120 |
| `get_displacement_data` | _(no bootstrap key — returns empty with stale: true in v1)_ | N/A |
| `get_infrastructure_status` | `infra:outages:v1`, `infra:service-statuses:v1` | 30 |
| `get_supply_chain_data` | `comtrade:flows:v1`, `trade:customs-revenue:v1` | 2880 |
| `get_positive_events` | `positive_events:geo-bootstrap:v1` | 60 |
| `get_webcams` | `webcam:` _(check server/worldmonitor/webcam/ for correct key)_ | 120 |

**Note:** `get_maritime_status` and `get_displacement_data` have no pre-seeded bootstrap key in `health.js`. These tools return `{ stale: true, data: [] }` in v1. Planner should verify by searching for `maritime` and `displacement` in `api/bootstrap.js`.

### Staleness Computation

Read the `seed-meta:<domain>` key in parallel with the data keys per tool call. The seed-meta value has shape `{ count, ts }` where `ts` is an epoch milliseconds timestamp. Compute:

```ts
const ageMin = (Date.now() - seedMeta.ts) / 60_000;
const stale = ageMin > tool._maxStaleMin;
const cached_at = new Date(seedMeta.ts).toISOString();
```

If seed-meta key returns null, set `cached_at: null` and `stale: true`.

All Redis reads within a tool call run in parallel via `Promise.all`.

### Tool Response Shape

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"cached_at\":\"2026-03-27T10:30:00.000Z\",\"stale\":false,\"data\":{...}}"
      }
    ]
  }
}
```

The `text` field is JSON-stringified. This is the standard MCP tool response pattern — one `text` content block containing the tool's payload as a JSON string.

### Edge Function Constraints

- `export const config = { runtime: 'edge' }` required at top
- No `node:http`, `node:https`, `node:zlib` — use only Web Fetch APIs
- Only import from `api/` siblings and npm packages (Vercel edge-functions constraint, enforced by `tests/edge-functions.test.mjs`)
- 60s execution timeout — acceptable since all tool calls are Redis reads

## Implementation Phases

### Phase 1: Core MCP Endpoint (no tools yet)

**Files to create/modify:**

- `api/mcp.ts` — new file

**Deliverables:**

- Edge runtime config
- CORS setup (import `getCorsHeaders`, `isDisallowedOrigin` from `api/_cors.js`)
- Auth: `validateApiKey(req, { forceKey: true })` — return JSON-RPC error `-32001` on failure
- Per-key rate limiting: new `Ratelimit` instance, `prefix: 'rl:mcp'`, 60 calls/60s, limit by API key value
- Rate limit errors returned as JSON-RPC `-32029` (not raw HTTP 429)
- `initialize` handler: return protocol version + server info + `Mcp-Session-Id: ${crypto.randomUUID()}` header
- `notifications/initialized` handler: return 202
- `tools/list` handler: return empty `{ tools: [] }` (populated in Phase 2)
- Unknown method: return JSON-RPC `-32601`
- Malformed body: return JSON-RPC `-32600`
- OPTIONS preflight: 204 with CORS headers

**Acceptance:** `curl -X POST https://localhost:3000/api/mcp -H 'X-WorldMonitor-Key: <key>' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' returns 200 with valid JSON-RPC result.`

### Phase 2: Tool Registry + Implementations

**Files to create/modify:**

- `api/mcp.ts` — add `TOOL_REGISTRY` constant and `executeTool()` dispatcher

**Deliverables:**

- `TOOL_REGISTRY` module-level constant with all 17 tool definitions (name, description, inputSchema, _cacheKeys, _seedMetaKey, _maxStaleMin)
- `tools/list` returns the registry (minus `_`-prefixed internal fields)
- `tools/call` dispatches to `executeTool(toolName, args)`:
  - `Promise.all` reads for all cache keys + seed-meta key
  - Staleness computation
  - Returns `{ content: [{ type: 'text', text: JSON.stringify({ cached_at, stale, data }) }] }`
  - Returns JSON-RPC `-32602` on unknown tool name
  - Returns empty data (not error) on Redis miss — `{ cached_at: null, stale: true, data: null }`

**Acceptance:** Claude Desktop can discover and call all 17 tools with valid responses.

### Phase 3: Edge Function Test Coverage

**Files to create/modify:**

- `tests/mcp.test.mjs` — new test file
- `tests/edge-functions.test.mjs` — add `api/mcp.ts` to the edge-functions import check

**Test cases:**

- No API key → JSON-RPC error `-32001`
- Invalid API key → JSON-RPC error `-32001`
- Valid key, rate limit exceeded → JSON-RPC error `-32029`
- Valid key, `initialize` → valid result with `Mcp-Session-Id` header
- Valid key, `notifications/initialized` → 202
- Valid key, `tools/list` → array of 17 tool objects, each with `name`, `description`, `inputSchema`
- Valid key, `tools/call` with unknown tool → JSON-RPC error `-32602`
- Valid key, `tools/call` with known tool → `{ content: [{ type: 'text', text: ... }] }`, `text` is valid JSON with `cached_at`, `stale`, `data`
- Unknown method → JSON-RPC error `-32601`
- Malformed body → JSON-RPC error `-32600`

## System-Wide Impact

### Interaction Graph

`api/mcp.ts` → `api/_api-key.js` (validateApiKey) → `process.env.WORLDMONITOR_VALID_KEYS`
`api/mcp.ts` → `@upstash/ratelimit` → Upstash Redis (`rl:mcp:<key>` namespace)
`api/mcp.ts` → `api/_upstash-json.js` (readJsonFromUpstash) → Upstash Redis (read-only, existing keys)

No downstream mutations. No events fired. No shared state except Redis rate limit counters (isolated under `rl:mcp` prefix).

### Error Propagation

All errors terminate at `api/mcp.ts` as JSON-RPC error objects. No errors bubble to the MCP client as HTTP 4xx/5xx — every response is 200 with a JSON-RPC body (per MCP spec), except for 202 on `notifications/initialized` and 204 on OPTIONS.

Exception: if `jsonResponse()` itself throws (should not happen), Vercel edge runtime returns a generic 500. This is acceptable — the MCP client will retry.

### State Lifecycle Risks

- Rate limit counters are written to Redis under `rl:mcp:<key>`. These are TTL'd by the sliding window algorithm — no orphan risk.
- No other state is written. Tool calls are pure reads.
- If Upstash is unavailable, `readJsonFromUpstash` returns `null` — tool returns `{ stale: true, data: null }`, not an error. Rate limit defaults to allow-through on Upstash unavailability (existing `checkRateLimit` behavior — graceful degradation).

### API Surface Parity

- `api/mcp-proxy.js` is the MCP *client* (proxies external servers). Unrelated — do not touch.
- The new `api/mcp.ts` is the MCP *server*. Different file, different concern.
- No existing data endpoints are changed. MCP server reads the same Redis keys that bootstrap.js reads.

### Integration Test Scenarios

1. Claude Desktop connects → `initialize` → `tools/list` → calls `get_market_data` → receives market snapshot with `stale: false`.
2. API key with exhausted rate limit calls `tools/call` → receives `-32029` JSON-RPC error, not 429 HTTP.
3. Redis cache empty for `get_aviation_status` → tool returns `{ stale: true, data: null }` → no 500, no JSON-RPC error.
4. MCP client sends POST with no body → receives `-32600` invalid request.
5. MCP client POSTs `notifications/initialized` (notification, no `id`) → receives 202 with no body.

## Acceptance Criteria

### Functional

- [ ] PRO user adds `https://api.worldmonitor.app/mcp` as MCP server in Claude Desktop config with `X-WorldMonitor-Key` header — discovers 17 tools without any install.
- [ ] All 17 `tools/call` calls return valid JSON-RPC results (not errors) even when Redis cache is empty for that tool.
- [ ] Each tool response includes `cached_at` (ISO string or null) and `stale` (boolean).
- [ ] Unauthenticated request returns JSON-RPC error `-32001`, not HTTP 401.
- [ ] Rate-limited request returns JSON-RPC error `-32029`, not HTTP 429.
- [ ] `tools/list` responds in < 500ms (no Redis calls).
- [ ] Tool calls with warm Redis cache respond in < 800ms end-to-end.

### Non-Functional

- [ ] `api/mcp.ts` only imports from `api/` siblings and npm packages (enforced by `tests/edge-functions.test.mjs`).
- [ ] No `node:` builtins used.
- [ ] Rate limit keys use `rl:mcp` prefix (isolated from web rate limits).
- [ ] `Mcp-Session-Id` header present on `initialize` response.

### Quality Gates

- [ ] `npx tsc --noEmit` passes with no errors.
- [ ] `tests/mcp.test.mjs` all pass (9 test cases).
- [ ] `tests/edge-functions.test.mjs` includes `api/mcp.ts` in the self-contained import check.

## Success Metrics

- WorldMonitor appears as a usable MCP server in Claude Desktop with 0 install steps for PRO users.
- All 17 tools return non-error responses (tool calls may return `stale: true` for domains with no active seed, but never return JSON-RPC errors for missing cache).
- No new Sentry errors from `api/mcp.ts` in the 48h post-deploy window.

## Dependencies

- `@upstash/ratelimit ^2.0.8` — already in `package.json`
- `@upstash/redis ^1.36.1` — already in `package.json`
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` — already set in Vercel env
- `WORLDMONITOR_VALID_KEYS` — already set in Vercel env

## Deferred to Planning (from origin doc)

- **Webcam bootstrap key**: Verify correct Redis key for `get_webcams` tool in `api/bootstrap.js` — `webcam:` key not found in health.js BOOTSTRAP_KEYS during research.
- **Maritime / displacement**: Neither has a BOOTSTRAP_KEY in `health.js`. Confirm these tools should return `{ stale: true, data: null }` in v1 or if there are on-demand endpoint alternatives.
- **Flat vs catch-all route**: `api/mcp.ts` at a flat path is correct for Streamable HTTP (all requests POST to the same URL). No catch-all needed — confirmed by `api/mcp-proxy.js` pattern which uses a single endpoint URL.
- **`stale` timestamp source**: Plan uses `seed-meta:<domain>` keys for `ts`. Verify shape of seed-meta value is `{ count, ts }` in `scripts/ais-relay.cjs` before implementing staleness logic.

## Sources & References

### Origin

- **Origin document:** [docs/brainstorms/2026-03-27-pro-mcp-server-requirements.md](../brainstorms/2026-03-27-pro-mcp-server-requirements.md)
  - Key decisions carried forward: (1) Vercel edge endpoint, no new infra; (2) one tool per domain group (~17 tools); (3) all domains in v1; (4) per-key rate limiting reusing Upstash Ratelimit.

### Internal References

- MCP client implementation (wire format reference): `api/mcp-proxy.js`
- API key validation: `api/_api-key.js:34` (`validateApiKey`)
- Rate limiter: `api/_rate-limit.js:36` (`checkRateLimit`) — pattern to replicate with per-key identifier
- Redis reader: `api/_upstash-json.js:1` (`readJsonFromUpstash`)
- Bootstrap key registry: `api/bootstrap.js:7` (`BOOTSTRAP_CACHE_KEYS`)
- Staleness thresholds: `api/health.js:5` (`BOOTSTRAP_KEYS` with `maxStaleMin`)
- CORS helper: `api/_cors.js`
- JSON response helper: `api/_json-response.js`
- Edge function self-containment test: `tests/edge-functions.test.mjs`

### Related Work

- widget-agent MCP integration: `api/widget-agent.ts` (different use case — MCP client, not server)
- MCP proxy for external servers: `api/mcp-proxy.js` (client proxy — unrelated, do not touch)
