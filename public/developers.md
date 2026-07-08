# World Monitor Developer Portal

Last updated: July 7, 2026

The World Monitor Developer Portal is the single entry point for building on World Monitor — the real-time global-intelligence platform that correlates geopolitics, markets, commodities, shipping, aviation, infrastructure, cyber threats, weather, and live news as source-attributed structured JSON. Every developer surface below shares one authentication model and one tool inventory, so you can start with the MCP server and drop down to the REST API or an SDK without relearning anything.

This page names and links every developer resource type. For the machine-readable companion, see [agents.md](https://worldmonitor.app/agents.md) and the [API llms.txt](https://worldmonitor.app/api/llms.txt).

## Developer Resources

- **[World Monitor MCP Server](https://worldmonitor.app/mcp-server.md):** the recommended agent surface — `https://worldmonitor.app/mcp`, Streamable HTTP, 39 tools. Connect Claude, Cursor, and any MCP-compatible client to live intelligence data. Details: [mcp-server.md](https://worldmonitor.app/mcp-server.md) · [MCP Overview](https://www.worldmonitor.app/docs/mcp-overview) · Server card: https://worldmonitor.app/.well-known/mcp/server-card.json
- **[World Monitor OpenAPI Specification](https://worldmonitor.app/openapi.md):** the OpenAPI 3.1 contract for the REST API — [openapi.yaml](https://worldmonitor.app/openapi.yaml) · [openapi.json](https://worldmonitor.app/openapi.json). Details: [openapi.md](https://worldmonitor.app/openapi.md)
- **World Monitor REST API:** base `https://api.worldmonitor.app` — the same tools and data as the MCP server, exposed as granular endpoints over plain HTTP. Machine-readable [API catalog (RFC 9727)](https://worldmonitor.app/.well-known/api-catalog) · human docs at [/docs/documentation](https://www.worldmonitor.app/docs/documentation)
- **[World Monitor SDKs](https://worldmonitor.app/sdks.md):** official zero-dependency client libraries for Python, Ruby, Go, and JavaScript. Details: [sdks.md](https://worldmonitor.app/sdks.md) · [SDK guide](https://www.worldmonitor.app/docs/sdks)
- **World Monitor CLI:** `npx worldmonitor tools` scripts every tool from a shell — [npm `worldmonitor`](https://www.npmjs.com/package/worldmonitor) · [CLI guide](https://www.worldmonitor.app/docs/cli)
- **World Monitor Agent Skills:** installable skills for agent frameworks — discovery index at https://worldmonitor.app/.well-known/agent-skills/index.json · `npx skills add koala73/worldmonitor`
- **World Monitor API documentation:** the full developer documentation site at [/docs](https://www.worldmonitor.app/docs/documentation), including the [MCP Quickstart](https://www.worldmonitor.app/docs/mcp-quickstart), [tool reference](https://www.worldmonitor.app/docs/mcp-tools-reference), and [JMESPath projection guide](https://www.worldmonitor.app/docs/mcp-jmespath).
- **World Monitor authentication:** the agent auth walkthrough at [auth.md](https://worldmonitor.app/auth.md) — API keys (`X-WorldMonitor-Key: wm_<40-hex>`) and OAuth 2.1 (`scope=mcp`) with dynamic client registration.

## Authentication in one line

Discovery endpoints and `tools/list` are public. Data calls need either an API key header `X-WorldMonitor-Key: wm_<40-hex>` (issue one at https://worldmonitor.app/pro) or OAuth 2.1 with scope `mcp`. The full walkthrough — including dynamic client registration and the Pro sign-in flow — lives at [auth.md](https://worldmonitor.app/auth.md).

## Pricing, limits & support

- **Pricing and plan limits:** [pricing.md](https://worldmonitor.app/pricing.md) · live JSON catalog `GET https://www.worldmonitor.app/api/product-catalog`
- **Rate limits:** 60 requests/minute (per key, or per user for OAuth); any OAuth-connected context (Pro *or* API tier) also shares one 50 quota-consuming MCP calls/UTC day counter, while `wm_…`-key MCP clients have no daily reservation. Honor `Retry-After` on 429.
- **Support:** [support.md](https://worldmonitor.app/support.md) — support@worldmonitor.app · Status: https://status.worldmonitor.app
- **Source (AGPL-3.0):** https://github.com/koala73/worldmonitor · Issues: https://github.com/koala73/worldmonitor/issues

## Important query matches

- World Monitor developer portal
- World Monitor API for developers
- Build on World Monitor
- World Monitor MCP server, OpenAPI, SDK, and CLI
- How to access World Monitor data programmatically
