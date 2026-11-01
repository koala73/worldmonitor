# World Monitor plugin for Claude

World Monitor is a real-time global intelligence service covering geopolitics, armed conflict, country risk, maritime shipping, natural hazards, energy and markets. This plugin connects Claude to the World Monitor MCP server and adds skills that turn its data into source-backed answers. Every answer keeps observation times, sources and data gaps visible.

## What you get

**Connector.** The plugin adds one remote MCP server, `https://worldmonitor.app/mcp`. It is the same server World Monitor lists as a connector in the Claude directory, so you see one set of tools whether you add the connector, the plugin or both.

**Skills.**

| Skill | Use it to ask |
|---|---|
| `world-brief` | "What are the main global developments today?" |
| `country-briefing` | "Give me a risk briefing on Japan." |
| `conflict-pulse` | "What is the latest fighting in Sudan?" |
| `chokepoint-check` | "Is shipping through Hormuz disrupted right now?" |
| `hazard-watch` | "Any major earthquakes in the last week?" |
| `market-snapshot` | "How are markets moving this morning?" |

## Account and access

The first tool call asks you to sign in to World Monitor through OAuth. A free account can use the cached-data tools within a small daily allowance. The AI-written world brief, country assessments and country risk scores need a World Monitor subscription; when a tool is not available on your account, the skills say which part could not load and answer with what did. Plans and limits: https://www.worldmonitor.app/docs/mcp-overview

## What the plugin runs and sends

- No hooks, scripts, local servers or executables. The plugin contains only `.claude-plugin/plugin.json`, `.mcp.json`, this README and the skill files.
- Claude sends tool calls, with the arguments shown in each skill (country codes, chokepoint names, coordinates, filters), to `https://worldmonitor.app/mcp` over HTTPS.
- Sign-in uses World Monitor's OAuth flow. The plugin never asks for, stores or reads an API key or any other credential from your machine.
- The plugin does not trade, publish, send messages or change account settings.

World Monitor's privacy policy: https://www.worldmonitor.app/docs/privacy

## Limits of the data

Sources can be partial, delayed or temporarily unavailable, and the tools report stale or missing data explicitly. Conflict datasets lag events by hours to days. Market quotes cover a curated symbol list. None of the output is investment, travel or security advice.

## Support

support@worldmonitor.app · https://www.worldmonitor.app

## License

AGPL-3.0-only, the same license as the World Monitor repository: https://github.com/koala73/worldmonitor
