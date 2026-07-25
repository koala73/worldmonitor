---
title: "Give Your AI Agent Eyes on the World: The World Monitor MCP Server"
description: "Connect Claude, Cursor, or any MCP client to 41 live geopolitical intelligence tools. Real-time country risk, conflicts, chokepoints, and markets for AI agents."
metaTitle: "Real-Time Intelligence MCP Server | World Monitor"
keywords: "MCP server real-time data, Claude MCP server, Model Context Protocol geopolitics, AI agent live data, geopolitical data for LLMs, real-time intelligence API for AI"
audience: "AI engineers, agent builders, Claude power users, developers, intelligence analysts automating workflows"
heroImage: "/blog/images/blog/worldmonitor-mcp-server-ai-agents-real-time-intelligence.jpg"
pubDate: "2026-06-10"
modifiedDate: "2026-07-22"
---

Ask any LLM what is happening in the Strait of Hormuz right now and you get a polite version of "my training data ends months ago." Large language models are brilliant reasoners with no eyes. They cannot see today's vessel traffic, this morning's conflict events, or the country risk score that moved overnight.

The Model Context Protocol (MCP) fixes the plumbing problem: it gives AI assistants a standard way to call live tools. World Monitor fixes the data problem: it exposes the entire intelligence platform, the same one behind the [free real-time dashboard](/blog/posts/what-is-worldmonitor-real-time-global-intelligence/), as an MCP server with **41 live tools**.

Connect the two and your agent can answer questions like "Which of my supplier countries got riskier this week, and why?" with real numbers instead of vibes.

## What the Server Exposes

The endpoint is a single URL:

```
https://worldmonitor.app/mcp
```

It speaks streamable HTTP (JSON-RPC 2.0), handles OAuth automatically on first connection, and serves 41 tools across six domains. The flagship ones:

| Tool | What your agent gets |
|------|----------------------|
| `get_country_risk` | Country Instability Index score (0–100), component breakdown, travel advisory, sanctions exposure |
| `get_world_brief` | AI-synthesized brief of the global situation |
| `get_country_brief` | Per-country geopolitical and economic assessment |
| `get_chokepoint_status` | Live maritime chokepoint transit counts and risk posture |
| `get_conflict_events` | Active conflict and unrest events with coordinates |
| `get_market_data` | Equities, commodities, crypto, FX, fear-greed composite |
| `analyze_situation` | Ad-hoc geopolitical deduction from a query, with confidence and supporting signals |
| `generate_forecasts` | Fresh probability estimates for developing situations |

The rest cover sanctions, cyber threats, energy intelligence, displacement, natural disasters, aviation status, prediction markets, supply chains, and more. Your agent can call `describe_tool` to pull the full definition of any tool. That call is quota-exempt, so exploration is free.

## Connect in Five Minutes

**Claude Desktop:** add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "worldmonitor": { "url": "https://worldmonitor.app/mcp" }
  }
}
```

**Claude web (claude.ai):** Settings → Connectors → Add custom connector → name it WorldMonitor, paste `https://worldmonitor.app/mcp`.

**Cursor:** same JSON shape in `~/.cursor/mcp.json`.

**Anything else:** test the connection with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector https://worldmonitor.app/mcp
```

On first use, the client walks you through "Sign in with WorldMonitor Pro." MCP access requires a [Pro account](https://www.worldmonitor.app/pro); API Starter and Enterprise keys (`X-WorldMonitor-Key`) also work for server-to-server agents. OAuth clients do not need copied keys because the protocol handles token exchange and refresh.

## Six Pre-Built Workflows

You do not have to design prompts from scratch. The server ships six prompt templates, discoverable via `prompts/list` (quota-exempt):

- **country-briefing:** risk score, AI intelligence brief, and macro indicators for one country
- **conflict-pulse:** active conflict events plus alert-flagged news, globally or per country
- **market-open-prep:** equity, commodity, and crypto movers before the bell
- **energy-shock-watch:** active energy disruptions, fuel shortages, crisis policies
- **route-risk-check:** chokepoint transit summary and risk posture for a shipping corridor
- **freshness-audit:** verifies the underlying data caches are current before you trust them

Each template pre-bakes the right tool calls and projections, so the first execution lands on the right data shape instead of burning a round-trip on discovery.

A practical pattern: schedule your agent to run `country-briefing` for your watchlist countries every morning and post the result to Slack. That turns the [15-minute manual briefing workflow](/blog/posts/daily-intelligence-briefing-workflow-15-minutes/) into a zero-minute one.

## JMESPath: The Token Economy Feature

Live intelligence payloads are big. A full market data response can be tens of kilobytes, most of it fields your agent does not need and all of it billed as context tokens.

Every World Monitor tool accepts an optional `jmespath` argument. The server applies the expression server-side and returns only the projection:

```json
{
  "name": "get_market_data",
  "arguments": {
    "jmespath": "data.\"stocks-bootstrap\".quotes[0:3].{s:symbol,p:price,chg:change}"
  }
}
```

Result: `[{"s":"AAPL","p":300.23,"chg":0.68}, ...]`, typically an **80–95% payload reduction**. Expressions are capped at 1,024 bytes; a malformed expression returns a soft-error envelope with the response's `original_keys`, so the agent can self-correct on the next call instead of failing blind.

If you have ever watched an agent blow its context window on one verbose API response, this is the feature that makes long-running intelligence agents economical.

## Built for Agent Discovery

World Monitor treats autonomous agents as first-class clients. From the root URL, an agent can discover everything by itself:

- `/llms.txt`: LLM-friendly markdown briefing of the whole platform
- `/.well-known/api-catalog`: RFC 9727 linkset bundling every discovery URL
- `/.well-known/mcp/server-card.json`: transport, endpoint, OAuth scopes, capability flags
- `/openapi.yaml`: one bundled OpenAPI 3.1 spec covering all 34 REST services

So an agent that has never heard of World Monitor can start from `https://worldmonitor.app/`, read the Link headers, and wire itself up without a human in the loop. If you prefer raw REST over MCP, the same data is available through the [developer API](/blog/posts/build-on-worldmonitor-developer-api-open-source/), and the two share authentication.

## Quotas, Honestly

- **60 requests per minute** per user or key
- **50 quota-consuming tool calls per UTC day** on Pro OAuth
- Metadata calls (`tools/list`, `prompts/list`, `describe_tool`) are exempt from the daily cap
- Hitting the cap returns a clean `429` with a `Retry-After` header

Fifty calls sounds tight until you use JMESPath and the prompt templates: a complete morning briefing across five countries, chokepoints, and markets costs about eight calls. Agents that batch and project comfortably live inside the quota; API tiers lift it for production workloads.

## What People Are Building

- **Morning briefing agents** that compile country risk deltas, top conflicts, and market movers into one Slack message before you wake up
- **Supply-chain copilots** that check `route-risk-check` before confirming shipment routings, the agent version of a [supply-chain early-warning system](/blog/posts/build-supply-chain-early-warning-system-api/)
- **Research assistants** that ground geopolitical claims in live `analyze_situation` output instead of stale training data
- **Trading checklists** that pull `market-open-prep` plus prediction market odds before the open

## Protocol Reference

World Monitor follows the official [Model Context Protocol specification](https://modelcontextprotocol.io/specification/latest). Client support and transport behavior can vary, so verify the client's current MCP documentation when configuring production access.

## Frequently Asked Questions

**What is an MCP server?**

The Model Context Protocol is an open standard that lets AI assistants call external tools over a uniform interface. An MCP server exposes capabilities (tools, prompts, resources); clients like Claude, Cursor, and custom agents discover and invoke them automatically.

**Does the World Monitor MCP server work with ChatGPT or other non-Claude clients?**

Any client that implements MCP over streamable HTTP with OAuth can connect. The server is client-agnostic. Claude Desktop, claude.ai connectors, Cursor, and the MCP Inspector are documented paths; custom agents can use an API key instead of OAuth.

**Is there a free tier for MCP access?**

MCP requires a Pro subscription ($39.99/month) or an API plan. The dashboard itself stays free; MCP is the programmatic surface on top of it. Metadata and discovery endpoints (`llms.txt`, the OpenAPI spec, `describe_tool`) are open.

---

**Add `https://worldmonitor.app/mcp` to your MCP client and ask your agent what changed in the world today. Setup docs at [worldmonitor.app/docs/mcp-quickstart](https://www.worldmonitor.app/docs/mcp-quickstart).**
