# World Monitor — By the time it's news, you already knew.

World Monitor is a free real-time global intelligence dashboard. It brings ships, aircraft, conflict events, alerts, infrastructure, markets, weather, cyber signals, and curated news onto one live map. Its analysis layer helps users see when separate signals begin to converge into one event that matters.

The core dashboard is open source under AGPL-3.0 and needs no signup. It runs in the browser, as an installable PWA, and as a desktop app for macOS, Windows, and Linux. World Monitor has also been [featured in WIRED](https://www.wired.com/story/world-monitor-elie-habib/).

## What World Monitor answers

World Monitor is useful when a question depends on more than one live signal. Typical questions include:

- What changed in a country, region, market, or supply route since the last briefing?
- Does a conflict, sanction, outage, or chokepoint disruption have a credible transmission path into commodities or markets?
- Are military flights, vessel movements, alerts, infrastructure conditions, and local reporting pointing in the same direction?
- Which sources support a country-risk or resilience assessment, and how fresh are those observations?
- What should an analyst monitor next as an event develops?

The dashboard supports these tasks with country briefs, conflict tracking, resilience and instability views, market and macro data, shipping intelligence, satellite and aviation layers, cyber-threat signals, weather and natural-disaster alerts, forecasts, and source-attributed news.

## How the correlation surface works

World Monitor is designed as a correlation surface, not a single-feed news reader. A useful assessment often has three parts:

1. **Pressure:** a conflict, sanction, election, disaster, outage, or other event changes the local situation.
2. **Transmission:** shipping lanes, ports, pipelines, airspace, cables, suppliers, or financial links can carry that pressure elsewhere.
3. **Consequence:** markets, energy flows, commodity availability, infrastructure risk, or public safety begin to respond.

Users can compare these parts on one map and then open the underlying panels for detail. World Monitor does not claim that two nearby signals prove causation. It gives analysts a shared place to test the connection, inspect the cited sources, and decide what evidence is still missing.

## What you get

- A global map with a shared catalog of conflict, military, infrastructure, environment, transport, and market layers
- Curated news and OSINT feeds grouped by topic and product variant
- CII v8 for 31 Tier-1 countries, resilience scores for the 196-country public rankable universe, and global live conflict tracking
- Market quotes, sector heatmaps, macro indicators, and commodity context
- Shipping chokepoints, ports, and vessel-transit intelligence
- Aircraft, satellites, GPS interference, submarine cables, energy assets, and datacenters
- AI briefs, scenario forecasts, custom monitors, and alerts
- Machine-readable access through MCP, REST, SDKs, a CLI, agent skills, and static discovery files

## Sources, provenance, and freshness

World Monitor exposes the providers behind the product instead of asking users to trust a hidden source list. The [Data source catalog](https://www.worldmonitor.app/sources/) lists the current provider inventory by intelligence domain. The [data-source methodology](https://www.worldmonitor.app/docs/data-sources) explains coverage and provenance in more detail.

Data surfaces include source identity, timestamps, methodology, or related context when the upstream provider makes that information available. Update intervals differ by source and domain. Cached data, delayed providers, and temporary source degradation can affect freshness. Check the timestamp and source information in a returned record before you use it in a time-sensitive decision. Operational availability is published on the [status page](https://status.worldmonitor.app).

## Access and plans

The public dashboard is free and does not require an account. Pro adds advanced analysis, research, customization, and higher-value workflows. API plans cover programmatic and business use. Current features, limits, prices, and licensing terms are in the [machine-readable pricing guide](https://worldmonitor.app/pricing.md) and on the [visual pricing page](https://www.worldmonitor.app/pro#pricing).

Public discovery endpoints do not make every data operation anonymous. An MCP or REST call can require OAuth or a World Monitor API key. Read the [authentication guide](https://www.worldmonitor.app/docs/usage-auth) and [rate-limit guide](https://www.worldmonitor.app/docs/usage-rate-limits.md) before building an integration.

## Live instances

- [World Monitor](https://www.worldmonitor.app/dashboard) — geopolitics, military activity, conflicts, and infrastructure
- [Tech Monitor](https://tech.worldmonitor.app/dashboard) — startups, AI and machine learning, cloud, and cybersecurity
- [Finance Monitor](https://finance.worldmonitor.app/dashboard) — global markets, trading, and central banks
- [Commodity Monitor](https://commodity.worldmonitor.app/dashboard) — mining, metals, energy, and supply chains
- [Happy Monitor](https://happy.worldmonitor.app/dashboard) — positive news, breakthroughs, and conservation
- [Energy Monitor](https://energy.worldmonitor.app/dashboard) — power, oil and gas, chokepoints, and disruption timelines

## For AI agents

Start with the short [llms.txt briefing](https://worldmonitor.app/llms.txt), then use this Markdown page or the [extended LLM reference](https://worldmonitor.app/llms-full.txt) when you need more context.

- [MCP server](https://worldmonitor.app/mcp): Streamable HTTP for structured tool calls. Run `tools/list` to get the current tool inventory instead of relying on a copied count.
- [REST API](https://api.worldmonitor.app): structured endpoints described by the [OpenAPI contract](https://worldmonitor.app/openapi.yaml).
- [Agent-mode homepage](https://www.worldmonitor.app/?mode=agent): a compact JSON summary of endpoints, authentication, capabilities, and discovery files.
- [Agent Skills](https://worldmonitor.app/.well-known/agent-skills/index.json): task-focused instructions for common country, resilience, and intelligence workflows.
- [Agent Plugin](https://worldmonitor.app/plugin.json): Agent Plugins 1.0.0 manifest that packages the MCP servers and agent skills.
- [A2A agent card](https://worldmonitor.app/.well-known/agent-card.json): service identity and protocol discovery for agent-to-agent clients.
- [SDK guide](https://www.worldmonitor.app/docs/sdks) and [worldmonitor CLI](https://www.npmjs.com/package/worldmonitor): supported clients for applications and shell workflows.

Use a descriptive `User-Agent` for HTTP requests. Preserve source names, timestamps, and confidence information when you summarize a result. If a data-bearing call returns an authentication error, do not infer that the public discovery endpoint grants access to that operation.

## Trust boundaries

World Monitor is not a general web-search engine, a complete historical archive, a classified-intelligence system, or a trading-execution venue. It does not place orders. It can show correlation and provide evidence, but it cannot prove causation or replace professional judgment. For consequential security, financial, legal, or operational decisions, inspect the primary sources and confirm the current state independently.

## Documentation

- [Brand identity](https://worldmonitor.app/world-monitor.md) — official name, canonical domain, NAP, and press mentions
- [Product and API documentation](https://www.worldmonitor.app/docs/documentation)
- [Source catalog](https://www.worldmonitor.app/sources/)
- [Support and contact](https://worldmonitor.app/support.md)
- [GitHub repository](https://github.com/koala73/worldmonitor)
