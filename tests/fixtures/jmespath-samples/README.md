# JMESPath measurement fixtures

These three captured tool responses feed `scripts/measure-jmespath-savings.mjs`
(the U6 reproducible token-savings A/B). They are real responses from the
production MCP endpoint, captured ONCE via `scripts/capture-mcp-fixture.mjs`
and committed verbatim so the script is fully deterministic — re-running on
the committed fixtures produces byte-identical numbers.

## Files

| File | Tool | Class |
|---|---|---|
| `fat-get-market-data.response.json` | `get_market_data` | fat (~5–10 KB raw) |
| `medium-get-conflict-events.response.json` | `get_conflict_events` | medium (~2–5 KB raw) |
| `thin-get-chokepoint-status.response.json` | `get_chokepoint_status` | thin (~0.5–1 KB raw) |

## How to (re)capture

```bash
# Use either a wm_live_... env key or a wm_pro_... Pro MCP token.
export WM_MCP_BEARER="wm_live_..."

# Fat — no filter args, full bootstrap.
node scripts/capture-mcp-fixture.mjs --tool get_market_data \
  --name fat-get-market-data

# Medium — no filter args.
node scripts/capture-mcp-fixture.mjs --tool get_conflict_events \
  --name medium-get-conflict-events

# Thin — no filter args. Deterministic cache-backed thin tool (NOT
# get_world_brief, which is a different response class and would
# mix in LLM/network variance if it were RPC).
node scripts/capture-mcp-fixture.mjs --tool get_chokepoint_status \
  --name thin-get-chokepoint-status
```

The capture script hits the prod MCP HTTP endpoint, unwraps the
`content[0].text` JSON envelope, and writes pretty-printed JSON to disk.
Override `WM_MCP_ENDPOINT` for staging.

## Refresh policy

Recapture when:

- A tool's payload schema changes (new fields, renamed fields)
- A cache key is added or removed from one of the three tools
- The default `limit` or `summary` semantics change in a way that
  alters the unfiltered response shape

When recapturing, re-run `npx tsx scripts/measure-jmespath-savings.mjs`
and paste the markdown table into the next PR description that touches
this feature.

## Why direct fixture invocation (not `mcpHandler`)?

`executeTool()` reads cache via `readJsonFromUpstash` which calls
`fetch()` directly, not `deps.redisPipeline`. Mocking `deps` doesn't
intercept the cache reads, so we'd have to mock `globalThis.fetch`
keyed by each tool's `_cacheKeys + _seedMetaKey` to get the cache path
to feed our fixtures. Calling `applyJmespath` directly on the
already-assembled tool response is simpler AND uniquely correct for
what we measure — the projection delta, not the cache-path overhead.
