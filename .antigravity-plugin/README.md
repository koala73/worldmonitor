# WorldMonitor for Antigravity

Live global intelligence inside your Antigravity agent: source-attributed news, country risk, conflicts, markets, energy, trade, shipping chokepoints and cyber signals.

## What it bundles

- **`worldmonitor` MCP server** (`https://worldmonitor.app/mcp`, Streamable HTTP). Sign in with your WorldMonitor account through OAuth when the server first connects. Some tools need a WorldMonitor Pro subscription; those stay Pro-only here.
- **`worldmonitor-docs` MCP server** (`https://www.worldmonitor.app/docs/mcp`). Public documentation search, no sign-in.
- **Agent skills** from `skills/` for country risk, chokepoints, energy shocks, macro history, news digests and more.

## Install

```
agy plugin install worldmonitor@antigravity-plugins-official
```

Or from a local checkout before the Marketplace listing is live:

```
git clone https://github.com/koala73/worldmonitor
agy plugin install ./worldmonitor
```

## Example prompts

- Show today's world headlines with sources and coverage
- Check the current risk picture for Taiwan and its main drivers
- Which maritime chokepoints are disrupted right now and what is the energy exposure?

## Data and limits

Data can be partial, stale or unavailable; answers keep coverage and attribution. The plugin does not trade, publish, or change account settings.

- Docs: https://www.worldmonitor.app/docs/mcp-overview
- Privacy: https://www.worldmonitor.app/docs/privacy
- Terms: https://www.worldmonitor.app/docs/terms
- Support: support@worldmonitor.app
