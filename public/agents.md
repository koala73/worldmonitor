# World Monitor — Agent Guide

> How AI agents should work with worldmonitor.app: machine surfaces, authentication, crawl policy, rate limits, and discovery endpoints. Prefer the structured surfaces below over scraping the HTML dashboard — the dashboard is a WebGL SPA and yields nothing useful to a text parser.

World Monitor is a real-time global intelligence dashboard: 500+ news feeds, 56 map layer types, country risk/resilience scores, AI briefs, forecasts, and market/supply-chain correlation, served as machine-readable JSON with documented methodology and provenance.

## Machine surfaces (use these)

- **MCP server (recommended):** `https://worldmonitor.app/mcp` — Streamable HTTP, 40 tools; issue `tools/list` for the live inventory. Server card: https://worldmonitor.app/.well-known/mcp/server-card.json
- **Docs MCP server:** `https://www.worldmonitor.app/docs/mcp` — Streamable HTTP, public (no auth); search-and-retrieval tools over the documentation. Use it for "how do I…" questions; use the product MCP above for live data.
- **REST API:** base `https://api.worldmonitor.app` — OpenAPI spec: https://worldmonitor.app/openapi.yaml (JSON: /openapi.json) · API catalog: https://worldmonitor.app/.well-known/api-catalog
- **NLWeb:** `POST https://www.worldmonitor.app/ask` (supports SSE) for natural-language questions; machine-readable dashboard view at `https://www.worldmonitor.app/?mode=agent`
- **Agent Skills:** discovery index at https://worldmonitor.app/.well-known/agent-skills/index.json · install via `npx skills add koala73/worldmonitor` (https://skills.sh/koala73/worldmonitor)
- **CLI:** `npx worldmonitor tools` lists every tool (public, no key) — https://www.npmjs.com/package/worldmonitor
- **SDKs:** Python `pip install worldmonitor-sdk` · Ruby `gem install worldmonitor` · Go `go get github.com/koala73/worldmonitor/sdk/go` · JavaScript npm `worldmonitor` — guide: https://www.worldmonitor.app/docs/sdks
- **Sandbox / test environment:** https://www.worldmonitor.app/sandbox/index.json — deterministic, schema-valid sample responses for representative REST operations; no auth, no quota, safe for CI. Guide: https://www.worldmonitor.app/docs/sandbox
- **LLM briefings:** https://worldmonitor.app/llms.txt (overview) · https://worldmonitor.app/llms-full.txt (full reference) · section files: https://worldmonitor.app/api/llms.txt (API) · https://www.worldmonitor.app/docs/llms.txt (docs) · https://worldmonitor.app/developers/llms.txt (developer portal) · https://www.worldmonitor.app/blog/llms.txt (blog)
- **Schema map:** https://www.worldmonitor.app/schemamap.xml — NLWeb schemamap indexing the structured-data surfaces (also advertised via the `Schemamap:` directive in robots.txt)
- **Developer portal:** https://worldmonitor.app/developers.md — links every developer resource by name. Named resource pages: [MCP Server](https://worldmonitor.app/mcp-server.md) · [OpenAPI Specification](https://worldmonitor.app/openapi.md) · [SDKs](https://worldmonitor.app/sdks.md)

## Authentication

- **Anonymous** works for discovery endpoints, `tools/list`, and public data (world brief, product catalog, story pages).
- **API key:** header `X-WorldMonitor-Key: wm_<40-hex>` for REST and MCP data calls — issue one at https://worldmonitor.app/pro. Full agent walkthrough: https://worldmonitor.app/auth.md
- **OAuth2** for MCP (`scope=mcp`), with dynamic client registration at `/oauth/register`. Details in auth.md.

## Crawl & content-usage policy

- **robots.txt** (https://www.worldmonitor.app/robots.txt): AI search/assistant agents (GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-User, Claude-SearchBot, PerplexityBot, Perplexity-User, Google-Extended, Applebot-Extended, DuckAssistBot, MistralAI-User) are explicitly allowed; bulk training-only scrapers (CCBot, Bytespider, anthropic-ai) are disallowed. `/api/` is off-limits to crawlers except the allowlisted story/OG/llms.txt/product-catalog routes.
- **Content-Signal:** `ai-train=no, search=yes, ai-input=yes` — declared as a robots.txt group directive and as an origin-wide HTTP response header. Search indexing and assistant grounding/citation are welcome; bulk model training is opted out.
- **User-Agent:** always send a descriptive `User-Agent` (e.g. `mytool/1.0 (+https://yoursite.example)`). Default HTTP-library UAs (`curl/*`, `python-requests/*`, empty strings) may get a 403 from the edge firewall — a 403 does NOT mean the endpoint is missing; retry with a real UA.

## Rate limits & plans

- Machine-readable pricing and plan limits: https://worldmonitor.app/pricing.md · live JSON catalog: `GET https://www.worldmonitor.app/api/product-catalog` (public, no key)
- Rate-limit documentation: https://www.worldmonitor.app/docs/usage-rate-limits.md · auth matrix: https://www.worldmonitor.app/docs/usage-auth
- Plan-limit responses include upgrade guidance; back off on 429 and honor `Retry-After`.

## Support & escalation

- https://worldmonitor.app/support.md — support@worldmonitor.app (general) · enterprise@worldmonitor.app (sales)
- Status: https://status.worldmonitor.app · Issues: https://github.com/koala73/worldmonitor/issues
- Source (AGPL-3.0): https://github.com/koala73/worldmonitor
