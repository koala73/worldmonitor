# World Monitor — By the time it's news, you already knew.

Free real-time global intelligence dashboard. World Monitor streams the world's raw signals — ships, jets, sirens, cables, markets — onto one live map, with AI that flags when they converge into something that matters.

Open-source (AGPL-3.0), used by 2M+ people across 190+ countries, as featured in WIRED. Runs as a web app, installable PWA, and native desktop app for macOS, Windows, and Linux. No signup required.

## What you get

- Real-time global map with 56 data layers and 500+ curated news feeds
- Country Instability Index across 196 countries, live conflict tracking
- Market quotes, sector heatmaps, and macro indicators
- 13 shipping chokepoints with live AIS vessel-transit intelligence
- Satellite tracking, GPS jamming zones, submarine cables, AI datacenters
- Daily AI brief, Scenario Engine, custom monitors and breaking alerts
- 39-tool MCP server so AI agents can query everything above

## Live instances

- [World Monitor](https://www.worldmonitor.app/dashboard) — geopolitics, military, conflicts, infrastructure
- [Tech Monitor](https://tech.worldmonitor.app/dashboard) — startups, AI/ML, cloud, cybersecurity
- [Finance Monitor](https://finance.worldmonitor.app/dashboard) — global markets, trading, central banks
- [Commodity Monitor](https://commodity.worldmonitor.app/dashboard) — mining, metals, energy, supply chains
- [Happy Monitor](https://happy.worldmonitor.app/dashboard) — positive news, breakthroughs, conservation
- [Energy Monitor](https://energy.worldmonitor.app/dashboard) — power grids, LNG, renewables

## For AI agents

- **MCP server:** `https://worldmonitor.app/mcp` (Streamable HTTP) — server card at [/.well-known/mcp/server-card.json](https://worldmonitor.app/.well-known/mcp/server-card.json)
- **A2A:** agent card at [/.well-known/agent-card.json](https://worldmonitor.app/.well-known/agent-card.json) — JSON-RPC endpoint at `https://www.worldmonitor.app/a2a`
- **REST API:** base `https://api.worldmonitor.app` — OpenAPI spec at [/openapi.json](https://worldmonitor.app/openapi.json)
- **Agent guidance:** [/llms.txt](https://worldmonitor.app/llms.txt) · skills at [/.well-known/agent-skills/index.json](https://worldmonitor.app/.well-known/agent-skills/index.json)
- **CLI:** `npx worldmonitor tools` — [npm package](https://www.npmjs.com/package/worldmonitor)
- **Auth:** [/auth.md](https://worldmonitor.app/auth.md) · plans and limits at [/pricing.md](https://worldmonitor.app/pricing.md)

## Documentation

- [Product & API docs](https://www.worldmonitor.app/docs/documentation)
- [Pricing](https://www.worldmonitor.app/pro) · [GitHub](https://github.com/koala73/worldmonitor)
