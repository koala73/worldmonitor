# worldmonitor (Go)

Official Go SDK for the [World Monitor](https://worldmonitor.app) global-intelligence API — country briefs, risk scores, conflict / cyber / market / news feeds, and every MCP tool, without writing an HTTP integration.

Stdlib-only (zero dependencies), MCP-first: the same design as the official [`worldmonitor` npm CLI](https://www.npmjs.com/package/worldmonitor). The [MCP server](https://www.worldmonitor.app/docs/mcp-overview) is the live, documented agent surface; a small REST escape hatch rounds it out.

## Install

```sh
go get github.com/koala73/worldmonitor/sdk/go
```

## Quickstart

```go
package main

import (
	"context"
	"fmt"

	worldmonitor "github.com/koala73/worldmonitor/sdk/go"
)

func main() {
	ctx := context.Background()
	client := worldmonitor.New("wm_...") // or "" to read WORLDMONITOR_API_KEY

	tools, _ := client.ListTools(ctx) // public — no key needed
	fmt.Println(string(tools))

	risk, err := client.CountryRisk(ctx, "IR", nil) // curated helper
	if err != nil {
		panic(err)
	}
	fmt.Println(string(risk))

	// Any MCP tool:
	quotes, _ := client.CallTool(ctx, "get_market_data", worldmonitor.Args{"asset_class": "crypto"})
	fmt.Println(string(quotes))

	// Raw REST GET:
	health, _ := client.Get(ctx, "/api/health", nil)
	fmt.Println(string(health))
}
```

Data calls (`tools/call`) need a user API key — get one at [worldmonitor.app/pro](https://www.worldmonitor.app/pro). Listing tools, prompts, and resources is public.

## Server-side projection

Every tool accepts an optional `jmespath` argument that projects the response server-side (typically an 80–95% size cut):

```go
brief, _ := client.WorldBrief(ctx, worldmonitor.Args{"jmespath": "hotspots[].name"})
```

See the [JMESPath guide](https://www.worldmonitor.app/docs/mcp-jmespath) for worked examples.

## Errors

- `*worldmonitor.MCPError` — the MCP server returned a JSON-RPC error (`.Code`, auth failures carry a key hint).
- `*worldmonitor.APIError` — a REST/transport failure (`.Status`, `.Body`).

Use `errors.As` to branch on them.

## Configuration

| Field | Environment variable | Default |
| --- | --- | --- |
| `APIKey` | `WORLDMONITOR_API_KEY` (or `WM_API_KEY`) | — |
| `BaseURL` | `WORLDMONITOR_BASE_URL` | `https://api.worldmonitor.app` |
| `MCPURL` | `WORLDMONITOR_MCP_URL` | `https://worldmonitor.app/mcp` |
| `HTTPClient` | — | `http.Client` with a 30s timeout |

The source lives in [`sdk/go/`](https://github.com/koala73/worldmonitor/tree/main/sdk/go) in the main repository and is versioned with `sdk/go/vX.Y.Z` tags. Docs: [worldmonitor.app/docs/sdks](https://www.worldmonitor.app/docs/sdks). License: MIT (thin client; the World Monitor platform itself remains AGPL-3.0).
