# worldmonitor

[![npm version](https://img.shields.io/npm/v/worldmonitor?logo=npm)](https://www.npmjs.com/package/worldmonitor)
[![npm downloads](https://img.shields.io/npm/dm/worldmonitor)](https://www.npmjs.com/package/worldmonitor)
[![license](https://img.shields.io/npm/l/worldmonitor)](https://github.com/koala73/worldmonitor/blob/main/cli/LICENSE)

Official command-line client for the [World Monitor](https://worldmonitor.app)
global-intelligence API. Script country briefs, risk scores, and
conflict / cyber / market / news feeds — plus any of the 39 MCP tools — from
your shell or an agent, without writing an API integration.

The CLI is a thin, dependency-free wrapper over the
[MCP server](https://worldmonitor.app/mcp) (the recommended agent surface) with
a REST escape hatch. It ships as ESM and runs on Node 18+.

📖 **Full documentation:** [worldmonitor.app/docs/cli](https://worldmonitor.app/docs/cli)

## Install

```sh
npm install -g worldmonitor   # installs the `worldmonitor` command (alias: `wm`)
# or run without installing:
npx worldmonitor tools
```

## Quick start

```sh
# Discover every tool — public, no key needed
worldmonitor tools

# Data commands need a user API key (get one at https://worldmonitor.app/pro)
export WORLDMONITOR_API_KEY=wm_xxxxxxxx

worldmonitor world                       # live global situation brief
worldmonitor country IR                  # AI strategic brief for a country
worldmonitor risk DE                      # country risk / resilience scores
worldmonitor conflicts --country IR --limit 5
worldmonitor markets --asset_class crypto
worldmonitor call get_cyber_threats --min_severity 7
```

## Commands

Data commands map to MCP `tools/call` and require `--api-key`:

- `world` — live global situation brief
- `country <ISO>` — AI strategic brief for a country (ISO 3166-1 alpha-2)
- `risk <ISO>` — country risk / resilience scores
- `markets` — equities, commodities, crypto, FX quotes
- `conflicts` — recent conflict events (`--country`, `--min_fatalities`, `--limit`)
- `cyber` — cyber-threat indicators (`--min_severity`, `--threat_type`, `--country`)
- `news` — classified news intelligence (`--topic`, `--country`, `--alerts_only`)
- `disasters` — earthquakes, fires, storms (`--dataset`, `--active_only`)
- `sanctions` — sanctions designations (`--country`, `--query`)
- `forecasts` — scenario forecasts (`--domain`, `--region`)
- `maritime <ISO>` — maritime / port activity for a country

MCP and REST:

- `tools` — list every MCP tool (public — no key needed)
- `call <tool> [--arg val]` — call any MCP tool (`--args '<json>'` for typed args)
- `prompts` / `resources` — list MCP prompt / resource templates
- `health` — API status / health check (requires `--api-key`)
- `get <path> [--param val]` — call a raw REST path (host-relative `/api/…`)
- `list [service]` — list documented REST operations from the live OpenAPI spec

Any `--key value` pair you pass that is not a recognised flag becomes a tool or
request parameter, so every tool argument is reachable without special wiring.

Every tool also accepts a `jmespath` argument that projects the response
server-side before it crosses the wire — typically 80–95% smaller:

```sh
worldmonitor markets --jmespath 'data."stocks-bootstrap".quotes[?symbol==`AAPL`].{s:symbol,p:price}'
```

See the [JMESPath guide](https://worldmonitor.app/docs/mcp-jmespath) for worked examples.

## Flags

- `--api-key <key>` — user API key (or env `WORLDMONITOR_API_KEY`)
- `--mcp-url <url>` — MCP endpoint (default `https://worldmonitor.app/mcp`)
- `--base-url <url>` — REST base (default `https://api.worldmonitor.app`)
- `--args <json>` — typed arguments object for a tool call
- `--timeout <ms>` — request timeout (default 30000)
- `--raw` — print the response body verbatim
- `--compact` — print single-line JSON
- `-h, --help` / `-v, --version`

## Exit codes

- `0` — success
- `1` — request or transport error (the response body is written to stderr)
- `2` — usage error

## Programmatic use

```js
import { run } from 'worldmonitor/run';

const code = await run(['risk', 'IR'], { env: process.env });
```

## License

AGPL-3.0-or-later. Part of the
[World Monitor](https://github.com/koala73/worldmonitor) project.
