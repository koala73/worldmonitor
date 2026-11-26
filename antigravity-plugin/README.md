# WorldMonitor for Antigravity

WorldMonitor is a real-time global intelligence service covering geopolitics, armed conflict, country risk, maritime shipping, natural hazards, energy and markets. This plugin connects Antigravity to the WorldMonitor MCP server and adds skills that turn its data into source-backed answers. Every answer keeps observation times, sources and data gaps visible.

## What it bundles

**MCP servers** (`mcp_config.json`, Streamable HTTP):

- `worldmonitor`: `https://worldmonitor.app/mcp`, the live data tools. Sign in with your WorldMonitor account through OAuth.
- `worldmonitor-docs`: `https://www.worldmonitor.app/docs/mcp`, public documentation search. No sign-in.

**Skills:**

| Skill | Use it to ask |
|---|---|
| `world-brief` | "What are the main global developments today?" |
| `country-briefing` | "Give me a risk briefing on Japan." |
| `conflict-pulse` | "What is the latest fighting in Sudan?" |
| `chokepoint-check` | "Is shipping through Hormuz disrupted right now?" |
| `hazard-watch` | "Any major earthquakes in the last week?" |
| `market-snapshot` | "How are markets moving this morning?" |

## Install

From the Marketplace, once listed:

```
agy plugin install worldmonitor@antigravity-plugins-official
```

From GitHub:

```
agy plugin install https://github.com/koala73/worldmonitor/tree/main/antigravity-plugin
```

Then sign in: open `/plugin`, expand worldmonitor under Installed, and choose Sign in. Antigravity runs WorldMonitor's OAuth flow in your browser.

## Account and access

A free account can use the cached-data tools within a small daily allowance. The AI-written world brief, country assessments and country risk scores need a WorldMonitor subscription. When a tool is not available on your account, the skills say which part could not load and answer with what did. Plans and limits: https://www.worldmonitor.app/docs/mcp-overview

## What the plugin runs and sends

- No hooks, scripts, local servers or executables. The plugin contains only `plugin.json`, `mcp_config.json`, this README, the logo and the skill files.
- Antigravity sends tool calls, with the arguments shown in each skill (country codes, chokepoint names, coordinates, filters), to `https://worldmonitor.app/mcp` over HTTPS.
- Sign-in uses WorldMonitor's OAuth flow. The plugin never asks for, stores or reads an API key or any other credential from your machine.
- The plugin does not trade, publish, send messages or change account settings.

## Limits of the data

Sources can be partial, delayed or temporarily unavailable, and the tools report stale or missing data explicitly. Conflict datasets lag events by hours to days. Market quotes cover a curated symbol list. None of the output is investment, travel or security advice.

## Links

- Setup guide: https://www.worldmonitor.app/docs/gemini-antigravity
- Privacy: https://www.worldmonitor.app/docs/privacy
- Terms: https://www.worldmonitor.app/docs/terms
- Support: support@worldmonitor.app

## License

AGPL-3.0-only, the same license as the WorldMonitor repository: https://github.com/koala73/worldmonitor
