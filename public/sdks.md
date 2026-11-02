---
title: "World Monitor SDKs"
description: "Official client libraries, installation commands, and supported protocols."
canonical: "https://www.worldmonitor.app/sdks.md"
---

# World Monitor SDKs

Last updated: October 20, 2026

World Monitor ships official client libraries in five language ecosystems so you can script country briefs, risk scores, market data, and every registered [MCP tool](https://www.worldmonitor.app/mcp-server.md) without writing an HTTP integration. The clients use MCP like the [`worldmonitor` npm CLI](https://www.worldmonitor.app/docs/cli), with a small REST escape hatch for host-relative and self-hosted use.

## Official SDKs

| Language | Package | Install | Source |
| --- | --- | --- | --- |
| Python | [`worldmonitor-sdk` on PyPI](https://pypi.org/project/worldmonitor-sdk/) | `pip install worldmonitor-sdk` | [`sdk/python/`](https://github.com/koala73/worldmonitor/tree/main/sdk/python) |
| Ruby | [`worldmonitor` on RubyGems](https://rubygems.org/gems/worldmonitor) | `gem install worldmonitor` | [`sdk/ruby/`](https://github.com/koala73/worldmonitor/tree/main/sdk/ruby) |
| Go | [`github.com/koala73/worldmonitor/sdk/go` on pkg.go.dev](https://pkg.go.dev/github.com/koala73/worldmonitor/sdk/go) | `go get github.com/koala73/worldmonitor/sdk/go` | [`sdk/go/`](https://github.com/koala73/worldmonitor/tree/main/sdk/go) |
| JavaScript / CLI | [`worldmonitor` on npm](https://www.npmjs.com/package/worldmonitor) | `npm install worldmonitor` | [`cli/`](https://github.com/koala73/worldmonitor/tree/main/cli) |
| Rust | [`worldmonitor` on crates.io](https://crates.io/crates/worldmonitor) | `cargo add worldmonitor` | [`sdk/rust/`](https://github.com/koala73/worldmonitor/tree/main/sdk/rust) |

## Find and verify the official packages

Use the exact package names in the table. npm, PyPI, RubyGems, and crates.io link to `worldmonitor.app` in their project metadata; compare those links with the source repositories listed here. The Python package is `worldmonitor-sdk`. The PyPI package named `worldmonitor` is an unrelated project.

The Go SDK is the module `github.com/koala73/worldmonitor/sdk/go`, with package name `worldmonitor`. Go modules have no registry homepage field. Verify its module path against the official repository linked above and its product links on pkg.go.dev.

- [Search pkg.go.dev for worldmonitor](https://pkg.go.dev/search?q=worldmonitor).
- [Read the Go module proxy's latest release metadata](https://proxy.golang.org/github.com/koala73/worldmonitor/sdk/go/@latest).
- Install with `go get github.com/koala73/worldmonitor/sdk/go` from your Go project.

Go publishes versions through repository tags (`sdk/go/vX.Y.Z`) and the module proxy. A successful proxy lookup confirms release availability; pkg.go.dev search confirms search visibility. See [how pkg.go.dev adds packages](https://pkg.go.dev/about#adding-a-package).

## Rust

The [`worldmonitor` crate](https://crates.io/crates/worldmonitor) is published on crates.io. Install it with `cargo add worldmonitor`. Read the [Rust API documentation](https://docs.rs/worldmonitor/0.1.0/worldmonitor/) for version 0.1.0.

The blocking client supports public MCP listings, any MCP tool through `call_tool`, a `country_risk` helper, and host-relative REST requests. It uses `reqwest` with Rustls and `serde_json`. The Python, Ruby, Go, and JavaScript clients have no runtime dependencies.

```rust
use worldmonitor::{Client, Config};

fn main() -> Result<(), worldmonitor::Error> {
    let client = Client::new(Config::default())?;
    let tools = client.list_tools()?;
    println!("{tools}");
    Ok(())
}
```

See the [Rust README](https://github.com/koala73/worldmonitor/blob/main/sdk/rust/README.md) for tool-call examples and the [release runbook](https://github.com/koala73/worldmonitor/blob/main/sdk/rust/RELEASING.md) for maintainer instructions.

## Shared design

The clients share the MCP protocol and use language-native APIs:

- **Any MCP tool** via `call_tool` / `CallTool` with named arguments; the result is the unwrapped JSON-RPC `result`.
- **Curated helpers** vary by SDK. Rust includes `country_risk`; use `call_tool` for other tools and optional arguments.
- **Public listings** — `list_tools`, `list_prompts`, `list_resources` — need no key.
- **Free source inventory** — `get_sources` is the sole credential-free, daily-quota-free data tool. Its anonymous path has a separate fail-closed ceiling of 10 calls/minute/IP; all other data tools are subscription-gated.
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

Get an API key at https://www.worldmonitor.app/pro. The full per-language guide — Ruby, Go, JavaScript, and Rust examples included — is at https://www.worldmonitor.app/docs/sdks.

## Learn more

- [Developer Portal](https://www.worldmonitor.app/developers.md) · [MCP Server](https://www.worldmonitor.app/mcp-server.md) · [OpenAPI Specification](https://www.worldmonitor.app/openapi.md) · [CLI guide](https://www.worldmonitor.app/docs/cli) · [agents.md](https://www.worldmonitor.app/agents.md)

## Important query matches

- World Monitor SDK
- World Monitor Python / Ruby / Go / JavaScript / Rust SDK
- World Monitor client library
- pip install worldmonitor-sdk
- cargo add worldmonitor
- Official World Monitor API client libraries
