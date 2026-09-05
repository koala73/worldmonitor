---
title: "MCP Server for Geopolitical Intelligence: Connect World Monitor to Claude, Cursor, or Any AI Agent"
description: "World Monitor is now an MCP server with 40+ tools for geopolitical, economic, military, and market data. Connect it to Claude Desktop, Cursor, or any MCP-compatible agent in two minutes."
metaTitle: "MCP Server for Geopolitical & Market Data | World Monitor"
keywords: "MCP server geopolitical data, Model Context Protocol, Claude MCP integration, geopolitical data API, AI agent intelligence tools, Claude Desktop MCP, OSINT API, country risk API, real-time intelligence API"
audience: "AI engineers, developers, quant analysts, intelligence automation teams, LLM application builders"
heroImage: "/blog/images/blog/mcp-server-geopolitical-data-api-claude-integration.png"
pubDate: "2026-04-18"
---

> **Key takeaway:** World Monitor is now an MCP server with 40+ tools. Connect it to Claude Desktop, Cursor, or any MCP-compatible agent and get structured geopolitical, military, economic, and market data as tool calls. Two auth options: API key or OAuth 2.1. One query per second. Connect in two minutes.

You built an AI agent that monitors geopolitical risk. It can read the news. It can summarize. But when you ask it "what is the current military posture in the Eastern Mediterranean?" it hallucinates a plausible-sounding but completely fabricated answer.

**Without MCP:** *"Military tensions are elevated in the Eastern Mediterranean, with several naval deployments reported in recent weeks."* (Vague. Possibly wrong. No source.)

**With World Monitor MCP:** *"get_military_posture returned: USS Eisenhower carrier group deployed to Eastern Med, 3 Russian frigates in Tartus, French Charles de Gaulle transiting Suez, 47 military flights tracked in theater over 24h."* (Specific. Sourced. Current.)

The problem was never the model. The problem is that the model had no data source to call.

World Monitor is now a **Model Context Protocol (MCP) server**. That means Claude Desktop, Cursor, Windsurf, LangChain agents, and any MCP-compatible tool can call World Monitor's live intelligence layer directly. No scraping. No custom API wrappers. Just structured, real-time geopolitical data available as tool calls.

## Why This Matters Now

There are thousands of MCP servers for code, databases, and documents. Real-time geopolitical intelligence is one of the hardest data domains to access programmatically: the sources are fragmented (ACLED, AIS feeds, FRED, IMF PortWatch, Polymarket, government RSS), the formats vary, and most require individual API keys, custom parsers, and rate-limit handling.

World Monitor aggregates 100+ upstream sources into a single MCP endpoint. Your agent gets one connection, one auth flow, and 40+ tools that return consistent, structured JSON.

Your agent stops hallucinating about conflict events because it can *look them up*. It stops guessing commodity prices because it can *check them*. It stops fabricating [country risk scores](/blog/posts/country-resilience-score-risk-index-methodology/) because it can *query them*.

## 40+ Tools Across Every Intelligence Domain

World Monitor's MCP server exposes over 40 tools organized by intelligence domain. Here are the most-used ones:

### Geopolitical, Military, and Security

| Tool | What It Returns |
|------|----------------|
| `get_world_brief` | Global situation summary with top threats and developments |
| `get_country_brief` | AI-generated intelligence brief for any country |
| `get_country_risk` | Per-country [resilience and risk scores](/blog/posts/country-resilience-score-risk-index-methodology/) across multiple dimensions |
| `get_conflict_events` | Active conflict data from ACLED with location, actors, and fatality counts |
| `get_military_posture` | Theater-level force posture assessments |
| `get_airspace` | Live military and civilian flight tracking data |
| `get_news_intelligence` | Classified and scored news headlines with geo-attribution |
| `get_sanctions_data` | Active sanctions regimes and entity-level data |
| `get_cyber_threats` | DDoS patterns, traffic anomalies, APT group activity |

### Economic, Market, and Supply Chain

| Tool | What It Returns |
|------|----------------|
| `get_market_data` | Live equity, commodity, and crypto prices |
| `get_economic_data` | Macro indicators, central bank rates, debt metrics |
| `get_country_macro` | Per-country macro aggregates (GDP, inflation, debt, trade balance) |
| `get_supply_chain_data` | [Chokepoint disruption scores](/blog/posts/supply-chain-scenario-engine-chokepoint-closure-cost/), freight indices, critical minerals |
| `get_maritime_activity` | Vessel traffic, port activity, disruption alerts |
| `get_prediction_markets` | Polymarket odds for geopolitical events |
| `get_commodity_geo` | Commodity production geography and concentration risk |

### AI Inference, Climate, and Aviation

| Tool | What It Returns |
|------|----------------|
| `analyze_situation` | AI-generated analysis of a specific geopolitical scenario |
| `generate_forecasts` | Simulation-backed geopolitical [forecasts](/blog/posts/prediction-markets-ai-forecasting-geopolitics/) with confidence levels |
| `get_climate_data` | CO2 levels, ocean ice, air quality, WMO normals, climate news, disaster events |
| `get_natural_disasters` | Earthquakes, volcanic eruptions, wildfires, GDACS alerts |
| `search_flights` | Flight availability and routing between cities |
| `get_aviation_status` | Airport operational status and NOTAM closures |

Plus `get_radiation_data`, `get_infrastructure_status`, `get_positive_events`, `get_social_velocity`, `get_research_signals`, `get_forecast_predictions`, `search_flight_prices_by_date`, and more. Every tool returns structured JSON with consistent field naming. Your agent does not need to parse HTML, handle pagination, or deal with rate-limit retries. World Monitor handles caching and fallbacks server-side.

## Connect in Two Minutes

### Option 1: API Key (simplest)

If you are building your own agent or using a tool that supports MCP with API key auth:

1. Get a World Monitor PRO API key from [worldmonitor.app/pro](https://worldmonitor.app/pro)
2. Add the server to your MCP client config:

```json
{
  "mcpServers": {
    "worldmonitor": {
      "url": "https://api.worldmonitor.app/mcp",
      "headers": {
        "X-WorldMonitor-Key": "your-api-key"
      }
    }
  }
}
```

3. Start calling tools. Your agent auto-discovers all 40+ tools.

### Option 2: OAuth 2.1 (for Claude Desktop and registered apps)

World Monitor implements **full OAuth 2.1 compliance** with Authorization Code flow, PKCE, and Dynamic Client Registration (DCR). This is the standards-compliant path for first-party integrations.

When you connect World Monitor as an MCP server in Claude Desktop:

1. Open Claude Desktop settings, add a new MCP server
2. Enter the World Monitor MCP endpoint
3. Complete the OAuth consent flow in your browser
4. Claude now has access to all 40+ tools

No tokens to copy-paste. No environment variables to set. The OAuth flow handles token refresh automatically.

### Rate Limits

The MCP server allows **one query per second** (60/min) per API key, sufficient for real-time monitoring dashboards, scheduled briefing agents, and interactive research sessions. If you are building a high-frequency production pipeline, contact us for higher throughput.

## What Your Agent Can Do Now

Here are concrete examples of agent workflows that World Monitor's MCP server enables:

### Daily Intelligence Brief

```
Agent prompt: "Every morning at 7am, generate a brief covering:
1. Top 3 geopolitical developments (get_world_brief)
2. Any new conflict events in the Middle East (get_conflict_events)
3. Market implications of overnight developments (get_market_data)
4. Changes in chokepoint disruption scores (get_supply_chain_data)
Format as a 500-word email to the team."
```

The agent calls four tools, synthesizes the structured data, and produces a brief that is grounded in live intelligence rather than the model's training data.

### Country Risk Monitoring

```
Agent prompt: "Monitor these 12 countries for risk changes.
When any country's risk score changes by more than 10 points,
alert me with the specific dimensions that shifted."
```

Using `get_country_risk` on a schedule, the agent can track risk evolution and flag only the changes that cross your threshold. Because the scores come from World Monitor's composite engine (conflict, economic, military, social indicators), the agent is monitoring dozens of underlying signals through a single tool call.

### Supply Chain Impact Assessment

```
Agent prompt: "I source components from Taiwan, Malaysia, and Vietnam.
Check current supply chain risks for each country, including
chokepoint exposure, maritime disruptions, and trade policy changes."
```

The agent calls `get_supply_chain_data`, `get_maritime_activity`, and `get_country_macro` for each country, then compares the results against your specific supply chain dependencies.

### Research Assistant

```
Agent prompt: "I'm writing a report on LNG vulnerability in Europe.
Get me: EU gas storage levels, current chokepoint disruptions
affecting LNG routes, relevant prediction market odds, and
any climate policy developments that affect gas demand."
```

Four tool calls. Structured data. No hallucination about storage levels or shipping routes because the data comes from GIE AGSI+, IMF PortWatch, Polymarket, and World Monitor's climate feed respectively.

## MCP vs. Traditional APIs

If you have used REST APIs for intelligence data before, here is what MCP changes:

| Traditional API | MCP Server |
|----------------|------------|
| Build a client per data source | One connection, all tools discovered automatically |
| Parse different JSON schemas per provider | Consistent structured responses |
| Manage auth tokens for each service | Single auth flow (API key or OAuth) |
| Write glue code to combine sources | Agent synthesizes across tools natively |
| Manual rate limiting and retry logic | Server-side caching and circuit breakers |
| Static integration, breaks on API changes | Tool schemas auto-discovered, self-describing |

The fundamental shift: your agent *discovers* what data is available and *decides* which tools to call based on the question. You do not need to pre-wire every data path.

## What Developers Are Building

The MCP server opens the same data layer that powers the World Monitor dashboard. If you can see it on worldmonitor.app, your agent can query it through MCP. Some patterns:

- **Slack bots** that answer "what's the risk in country X?" with live conflict events, risk scores, and market data instead of stale summaries
- **Trading desk monitors** that call `get_supply_chain_data` and `get_market_data` on a schedule and alert when chokepoint disruption scores cross a threshold
- **Automated country dossiers** that combine `get_country_brief`, `get_country_risk`, `get_country_macro`, and `get_conflict_events` into a formatted PDF on demand
- **Research agents** that use `analyze_situation` and `generate_forecasts` alongside your proprietary data to produce weekly intelligence products

The same analyst workflows described in the [WM Analyst blog post](/blog/posts/ai-geopolitical-analyst-chat-market-signals/) are available programmatically through MCP. What the chat panel does interactively, your agent can do on a schedule.

## Data Freshness and Reliability

Every tool response includes freshness metadata. Your agent can check when data was last updated and decide whether to trust it or flag it as stale.

Under the hood, World Monitor's data pipeline runs on **Railway cron services** that seed data from 100+ upstream sources into Redis. The MCP server reads from Redis with circuit breakers that fall back to cached data when upstream sources are unavailable. This means your agent always gets a response, even if a specific upstream source is temporarily down.

Data update frequencies vary by domain:

- **Conflict events**: Hourly
- **Market data**: Real-time during trading hours
- **Chokepoint traffic**: Every 2 hours
- **Country risk scores**: Daily
- **Macro indicators**: Weekly/monthly (follows source cadence)
- **News intelligence**: Every 15 minutes

## Frequently Asked Questions

**Is the MCP server free?**
The MCP server is a PRO feature. A World Monitor PRO subscription includes API access and the MCP server endpoint. The [dashboard itself remains free](/blog/posts/what-is-worldmonitor-real-time-global-intelligence/) for visual exploration.

**Which AI tools support MCP?**
Claude Desktop, Claude Code, Cursor, Windsurf, Cline, Continue, and any tool that implements the Model Context Protocol specification. The ecosystem is growing rapidly. If your tool speaks MCP, it connects to World Monitor.

**Can I use the MCP server without Claude?**
Yes. MCP is an open protocol. Any MCP-compatible client can connect. You can also build your own client using the MCP SDK (available in Python and TypeScript).

**What data formats do tools return?**
All tools return structured JSON with consistent field naming. Arrays of events, objects with typed fields, and metadata including freshness timestamps.

**Is there a rate limit?**
One query per second (60/min) per API key. Sufficient for real-time dashboards, scheduled agents, and interactive research sessions.

**Can I use MCP alongside the web dashboard?**
Yes. The MCP server and the dashboard read from the same data layer. Use the dashboard for visual exploration and scenario modeling; use the MCP server for automated workflows and agent integration.

**How does auth work for Claude Desktop?**
World Monitor implements OAuth 2.1 with Authorization Code + PKCE + Dynamic Client Registration. In Claude Desktop, you add the MCP server URL and complete a one-time browser-based consent flow. Token refresh is automatic.

**What if I just want a REST API?**
The MCP server is the recommended path because agents auto-discover tools. If you need direct REST access, the same endpoints that back the MCP tools are available as standard HTTP calls via the World Monitor [developer API](/blog/posts/build-on-worldmonitor-developer-api-open-source/).

---

**Connect World Monitor as an MCP server and give your AI agent real-time geopolitical intelligence. Start at [worldmonitor.app/pro](https://worldmonitor.app/pro). Connection takes two minutes.**
