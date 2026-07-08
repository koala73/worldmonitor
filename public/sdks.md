# World Monitor SDKs

Last updated: July 7, 2026

World Monitor ships official client libraries in four language ecosystems so you can script country briefs, risk scores, market data, and every one of the 39 [MCP tools](https://worldmonitor.app/mcp-server.md) without writing an HTTP integration. All of them are **zero-dependency**, MCP-first mirrors of the [`worldmonitor` npm CLI](https://www.worldmonitor.app/docs/cli), with a small REST escape hatch for host-relative and self-hosted use.

## Official SDKs

| Language | Package | Install | Source |
| --- | --- | --- | --- |
| Python | [`worldmonitor-sdk` on PyPI](https://pypi.org/project/worldmonitor-sdk/) | `pip install worldmonitor-sdk` | [`sdk/python/`](https://github.com/koala73/worldmonitor/tree/main/sdk/python) |
| Ruby | [`worldmonitor` on RubyGems](https://rubygems.org/gems/worldmonitor) | `gem install worldmonitor` | [`sdk/ruby/`](https://github.com/koala73/worldmonitor/tree/main/sdk/ruby) |
| Go | [`github.com/koala73/worldmonitor/sdk/go` on pkg.go.dev](https://pkg.go.dev/github.com/koala73/worldmonitor/sdk/go) | `go get github.com/koala73/worldmonitor/sdk/go` | [`sdk/go/`](https://github.com/koala73/worldmonitor/tree/main/sdk/go) |
| JavaScript / CLI | [`worldmonitor` on npm](https://www.npmjs.com/package/worldmonitor) | `npm install worldmonitor` | [`cli/`](https://github.com/koala73/worldmonitor/tree/main/cli) |

Every package sets its homepage to `worldmonitor.app` — that is how you (or your agent) verify it is the official SDK and not a look-alike.

## Shared design

All four clients expose the same surface with language-native naming:

- **Any MCP tool** via `call_tool` / `CallTool` with named arguments; the result is the unwrapped JSON-RPC `result`.
- **Curated helpers** for the highest-traffic tools: world brief, country brief/risk, markets, conflicts, cyber, news, disasters, sanctions, forecasts, maritime.
- **Public listings** — `list_tools`, `list_prompts`, `list_resources` — need no key.
- **REST escape hatch** — `get("/api/…")` and `health()` against `https://api.worldmonitor.app`.
- **Configuration** via constructor arguments or the `WORLDMONITOR_API_KEY` (alias `WM_API_KEY`), `WORLDMONITOR_BASE_URL`, and `WORLDMONITOR_MCP_URL` environment variables.
- Every tool accepts an optional `jmespath` argument for [server-side projection](https://www.worldmonitor.app/docs/mcp-jmespath) — typically an 80–95% response-size cut.

## Quick start (Python)

```python
from worldmonitor_sdk import Client

client = Client(api_key="wm_...")  # or set WORLDMONITOR_API_KEY
client.list_tools()                # public — no key needed
client.country_risk("IR")
client.call_tool("get_market_data", asset_class="crypto")
```

Get an API key at https://worldmonitor.app/pro. The full per-language guide — Ruby, Go, and JavaScript examples included — is at https://www.worldmonitor.app/docs/sdks.

## Learn more

- [Developer Portal](https://worldmonitor.app/developers.md) · [MCP Server](https://worldmonitor.app/mcp-server.md) · [OpenAPI Specification](https://worldmonitor.app/openapi.md) · [CLI guide](https://www.worldmonitor.app/docs/cli) · [agents.md](https://worldmonitor.app/agents.md)

## Important query matches

- World Monitor SDK
- World Monitor Python / Ruby / Go / JavaScript SDK
- World Monitor client library
- pip install worldmonitor-sdk
- Official World Monitor API client libraries
