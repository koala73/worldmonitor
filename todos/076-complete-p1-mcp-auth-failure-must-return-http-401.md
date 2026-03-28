---
status: complete
priority: p1
issue_id: "076"
tags: [code-review, security, oauth, mcp, agent-native]
dependencies: []
---

# MCP auth failures must return HTTP 401 not HTTP 200

## Problem Statement

`rpcError` in `api/mcp.ts` always returns HTTP 200, including for authentication errors (`-32001`). RFC 6750 requires HTTP 401 + `WWW-Authenticate: Bearer` header on auth failures. Claude.ai's OAuth connector watches for HTTP 401 to trigger token re-authentication. With HTTP 200, an expired token causes a silent tool failure that agents cannot self-heal from.

## Findings

- `api/mcp.ts:379` — `rpcError` hardcodes `200` as HTTP status for all JSON-RPC errors
- `api/mcp.ts:439,443` — auth failure returns `-32001` via `rpcError` → HTTP 200
- Agent-native reviewer: "Must fix — HTTP 200 on auth errors blocks automatic re-auth loop"
- RFC 6750 §3.1: server MUST return HTTP 401 + `WWW-Authenticate: Bearer realm=..., error=...` on token errors
- claude.ai connector specifically monitors HTTP 401 to re-fetch an OAuth token
- A client sending only `Authorization: Bearer <expired>` gets 200 + JSON error — indistinguishable from a tool result to non-parsing callers

## Proposed Solutions

### Option 1: Special-case -32001 in rpcError

**Approach:** Add an optional `httpStatus` parameter to `rpcError`, default 200. Callers that pass auth errors explicitly set 401. In the handler, when `rpcError(null, -32001, ...)` is called via the auth chain, construct the response manually with 401 + `WWW-Authenticate` header.

**Pros:**
- Minimal change — only auth errors get 401
- Other JSON-RPC errors stay HTTP 200 (correct per JSON-RPC spec)
- Clean separation

**Cons:**
- Two call sites for auth errors (lines 439 + 443)

**Effort:** 30 minutes

**Risk:** Low

---

### Option 2: Detect Bearer presence and return proper 401

**Approach:** After Bearer lookup fails (returns null), if a `Bearer` header was present, return a proper HTTP 401 response immediately (not via `rpcError`). This distinguishes "token expired/invalid" from "no credentials at all".

```typescript
const bearerHeader = req.headers.get('Authorization');
const bearerApiKey = await resolveApiKeyFromBearer(req);
if (bearerHeader?.startsWith('Bearer ') && !bearerApiKey) {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Invalid or expired token' } }),
    { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="worldmonitor", error="invalid_token"', ...corsHeaders } }
  );
}
```

**Pros:**
- Correctly distinguishes expired token from missing credentials
- `WWW-Authenticate` header tells clients exactly what to do
- claude.ai re-auth loop fires on the right condition

**Cons:**
- Slightly more code in the auth chain

**Effort:** 1 hour

**Risk:** Low

## Recommended Action

Use **Option 2**. Distinguishing "Bearer present but invalid" from "no auth" is important for agent self-healing. The `WWW-Authenticate` header is RFC 6750 mandatory and claude.ai uses it to trigger re-auth.

## Technical Details

**Affected files:**

- `api/mcp.ts:429-446` — auth chain section

**RFC references:**

- RFC 6750 §3.1 — The use of Bearer tokens: `WWW-Authenticate: Bearer realm="..."` required
- RFC 6750 §3.1 — `error="invalid_token"` for expired/revoked tokens, `error="invalid_request"` for malformed header

## Resources

- **PR:** #2418
- **Agent-native finding:** CRITICAL (agent-native-reviewer)
- **Security finding:** related to H-4 (RFC compliance)

## Acceptance Criteria

- [ ] `POST /mcp` with expired/unknown Bearer token returns HTTP 401 (not 200)
- [ ] HTTP 401 response includes `WWW-Authenticate: Bearer realm="worldmonitor", error="invalid_token"`
- [ ] `POST /mcp` with no credentials returns HTTP 200 with JSON-RPC `-32001` error (existing behavior for non-OAuth clients)
- [ ] `POST /mcp` with valid Bearer token works normally
- [ ] curl test confirms: `curl -si -X POST /mcp -H "Authorization: Bearer invalid" | head -5` shows `HTTP/1.1 401`

## Work Log

### 2026-03-28 — Code Review Discovery

**By:** Claude Code (compound-engineering:ce-review)

**Actions:**

- Agent-native reviewer flagged as CRITICAL for agent re-auth loop
- Security sentinel independently flagged RFC 6750 non-compliance
- Identified `rpcError` always returns 200 as the root cause

### 2026-03-28 — Partial Fix Applied (commit a2cf0df3b)

**Bearer-present-but-invalid path now returns 401:**

```typescript
} else if (bearerHeader.startsWith('Bearer ')) {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: '...' } }),
    { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="worldmonitor", error="invalid_token"', ...corsHeaders } }
  );
```

**Still pending:** The "no credentials at all" path and "invalid direct key" path still return HTTP 200 via `rpcError`. For claude.ai OAuth clients specifically this is acceptable (they always send a Bearer header), but it is a RFC 6750 non-compliance for any client that calls the endpoint without any auth. Full fix requires either: (a) special-casing -32001 in `rpcError` to return 401, or (b) manually constructing the 401 response for the "no candidateKey" and "invalid candidateKey" branches.
