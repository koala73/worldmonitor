# worldmonitor-sdk

Official Python SDK for the [World Monitor](https://worldmonitor.app) global-intelligence API — country briefs, risk scores, conflict / cyber / market / news feeds, and every MCP tool, without writing an HTTP integration.

Stdlib-only (zero dependencies), MCP-first: the same design as the official [`worldmonitor` npm CLI](https://www.npmjs.com/package/worldmonitor). The [MCP server](https://www.worldmonitor.app/docs/mcp-overview) is the live, documented agent surface; a small REST escape hatch rounds it out.

## Install

```sh
pip install worldmonitor-sdk
```

## Quickstart

```python
from worldmonitor_sdk import Client

client = Client(api_key="wm_...")  # or set WORLDMONITOR_API_KEY

client.list_tools()                          # public — no key needed
client.country_risk("IR")                    # curated helper
client.conflict_events(country="IR", limit=5)
client.call_tool("get_market_data", asset_class="crypto")  # any MCP tool
client.get("/api/health")                    # raw REST GET
```

Data calls (`tools/call`) need a user API key — get one at [worldmonitor.app/pro](https://www.worldmonitor.app/pro). Listing tools, prompts, and resources is public.

## Server-side projection

Every tool accepts an optional `jmespath` argument that projects the response server-side (typically an 80–95% size cut):

```python
client.world_brief(jmespath="hotspots[].name")
```

See the [JMESPath guide](https://www.worldmonitor.app/docs/mcp-jmespath) for worked examples.

## Errors

- `worldmonitor_sdk.MCPError` — the MCP server returned a JSON-RPC error (`.code`, auth failures carry a key hint).
- `worldmonitor_sdk.APIError` — a REST/transport failure (`.status`, `.body`).

Both derive from `worldmonitor_sdk.WorldMonitorError`.

## Configuration

| Constructor arg | Environment variable | Default |
| --- | --- | --- |
| `api_key` | `WORLDMONITOR_API_KEY` (or `WM_API_KEY`) | — |
| `base_url` | `WORLDMONITOR_BASE_URL` | `https://api.worldmonitor.app` |
| `mcp_url` | `WORLDMONITOR_MCP_URL` | `https://worldmonitor.app/mcp` |
| `timeout` | — | `30.0` seconds |

The source lives in [`sdk/python/`](https://github.com/koala73/worldmonitor/tree/main/sdk/python) in the main repository. Docs: [worldmonitor.app/docs/sdks](https://www.worldmonitor.app/docs/sdks). License: MIT (thin client; the World Monitor platform itself remains AGPL-3.0).
