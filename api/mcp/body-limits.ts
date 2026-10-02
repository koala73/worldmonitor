// Shared JSON-RPC POST body cap for `/api/mcp` and sibling MCP entry
// points that opt in. Kept in a leaf module so Edge facades
// (`api/docs-mcp.ts`, `api/mcp-proxy.ts`) can import the number without
// pulling the broader MCP constants / upgrade graph.
//
// Untrusted clients — including confused LLM hosts pasting large blobs
// into tool arguments — reach every method's string args through one
// parse site. Without a gate there, any handler that does super-linear
// work on a string argument is reachable at whatever size a caller
// sends (#7406; see also the per-designator gate in
// shared/country-code-resolve.ts). Sized to match JMESPATH_MAX_OUTPUT_BYTES
// (256 KiB): large enough for real tools/call envelopes, small enough to
// bound Edge CPU before method dispatch.
export const MAX_JSON_RPC_BODY_BYTES = 256 * 1024;

// Foreign MCP servers are outside our trust boundary. Bound each response
// before JSON or SSE parsing so the proxy cannot amplify an authenticated
// request into an unbounded Edge allocation.
export const MAX_MCP_PROXY_RESPONSE_BYTES = 1024 * 1024;
