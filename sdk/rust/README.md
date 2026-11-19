# World Monitor Rust SDK

The official Rust client for [World Monitor](https://worldmonitor.app), a global intelligence dashboard for geopolitical risk, markets, conflict, news, and other live data.

This blocking client calls any [World Monitor MCP tool](https://www.worldmonitor.app/docs/mcp-overview) and host-relative REST endpoints. It uses `reqwest` with Rustls and `serde_json`. It does not require the desktop app or a system OpenSSL installation.

## Install

Registry installation requires a published release. If the crate is not yet published on crates.io, use a path dependency from this repository:

```toml
[dependencies]
worldmonitor = { path = "sdk/rust" }
serde_json = "1"
```

After the first release is verified, install with `cargo add worldmonitor`. The intended registry name is `worldmonitor`, and the Rust import is `worldmonitor`.

## List tools and query source data

```rust,no_run
use serde_json::json;
use worldmonitor::{Client, Config};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let public = Client::new(Config::default())?;
    let tools = public.list_tools()?;
    let sources = public.call_tool("get_sources", json!({"view": "summary"}))?;
    println!("{sources}");

    let client = Client::from_env()?;
    // Requires a subscription API key in WORLDMONITOR_API_KEY.
    let risk = client.country_risk("IR")?;
    let markets = client.call_tool("get_market_data", json!({"asset_class": "crypto"}))?;
    Ok(())
}
```

`list_tools`, `list_prompts`, and `list_resources` are public. `get_sources` is the only data tool that needs no key and consumes no daily quota. Anonymous source requests have a separate limit of 10 calls per minute per IP. Other data tools require a subscription API key from [World Monitor Pro](https://worldmonitor.app/pro).

Tool arguments must be a JSON object. `call_tool` returns the unwrapped JSON-RPC `result`, preserving MCP `content`, `structuredContent`, and `isError`. Inspect `isError` for tool-level failures. JSON-RPC failures return `Error::Mcp`, including code, message, and optional data. HTTP failures return `Error::Http`, including status and body. Network, JSON, and protocol failures have separate error variants.

Use `call_tool` for parameters such as `jmespath`, `limit`, and country filters. `country_risk` is a convenience method for `get_country_risk`. JSON and finite SSE responses are supported. Session management, streaming subscriptions, and automatic retries are not provided.

## Configure the client

`Client::from_env()` reads these variables:

| Variable | Default |
| --- | --- |
| `WORLDMONITOR_API_KEY` | Anonymous. `WM_API_KEY` is a fallback. |
| `WORLDMONITOR_BASE_URL` | `https://api.worldmonitor.app` |
| `WORLDMONITOR_MCP_URL` | `https://worldmonitor.app/mcp` |

Empty variables use the defaults. For explicit configuration, pass a `Config` to `Client::new`. `Config::default()` never reads environment variables. Set `api_key` to `Some("wm_...".into())` to authenticate, and set `timeout` to change the 30-second request deadline. The REST base must be an origin without a path. Use HTTPS for remote endpoints. HTTP is available for local testing and self-hosted servers.

Every request sends `worldmonitor-rust/<version> (+https://worldmonitor.app)` as its User-Agent and an `X-WorldMonitor-Key` header when configured. Redirects are disabled to prevent forwarding that key to another destination. The client does not implement `Debug`, and the credential header is marked sensitive.

This is a synchronous SDK. In an async application, create, use, and drop it within the runtime's blocking-task facility.

## Query a REST endpoint

```rust,no_run
use worldmonitor::{Client, Config};

let client = Client::new(Config::default())?;
let health = client.health()?;
let response = client.get("/api/health", &[("detail", "true")])?;
# Ok::<(), worldmonitor::Error>(())
```

Paths must start with a single `/`. Pass query parameters separately. Absolute URLs, query strings in the path, and fragments are rejected.

## Verify from source

From `sdk/rust`, run:

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo package --locked
```

`cargo run --locked --example sources` makes one anonymous live data request. Tests use local HTTP fixtures and do not need an API key.

See [the first-release runbook](https://github.com/koala73/worldmonitor/blob/main/sdk/rust/RELEASING.md) for account setup and publication. The package metadata links back to the official repository and product domain.
