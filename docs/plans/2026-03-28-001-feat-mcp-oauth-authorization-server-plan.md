---
title: "feat: MCP OAuth 2.0 Authorization Server (spec-compliant)"
type: feat
status: active
date: 2026-03-28
---

# feat: MCP OAuth 2.0 Authorization Server (spec-compliant)

## Overview

Claude.ai's remote MCP connector only accepts OAuth credentials (Client ID + Client Secret) — no custom headers. The current `X-WorldMonitor-Key` header approach is therefore incompatible. This plan implements a minimal, spec-compliant OAuth 2.0 Authorization Server so claude.ai (and any other MCP client) can authenticate using standard OAuth client credentials.

## Problem Statement

The MCP 2025-03-26 spec defines OAuth 2.0 as the standard auth mechanism for remote MCP servers. Claude.ai's connector UI exposes exactly three fields:

1. MCP Server URL
2. Client ID
3. Client Secret

There is no header field, no API key field. If the server does not expose a proper `/.well-known/oauth-authorization-server` discovery document and a `/oauth/token` endpoint, the connector silently fails to authenticate. The current `?key=` query param workaround (PR #2417) is non-standard and not discoverable by OAuth clients.

## Proposed Solution

Implement the **Client Credentials grant** (RFC 6749 §4.4) — the correct grant type for machine-to-machine API access without user interaction:

```
claude.ai → GET /.well-known/oauth-authorization-server
         ← { token_endpoint, grant_types_supported: ["client_credentials"] }

claude.ai → POST /api/oauth/token
              grant_type=client_credentials
              client_id=worldmonitor
              client_secret=<user's API key>
         ← { access_token, token_type: "Bearer", expires_in: 3600 }

claude.ai → POST /mcp
              Authorization: Bearer <access_token>
         ← MCP JSON-RPC response
```

The `client_secret` **is** the existing WorldMonitor API key. No new credential system needed — OAuth is just a wrapper around the existing key validation.

## Technical Approach

### New files

**`public/.well-known/oauth-authorization-server`** (static JSON, served by Vercel as-is):
```json
{
  "issuer": "https://worldmonitor.app",
  "token_endpoint": "https://worldmonitor.app/api/oauth/token",
  "grant_types_supported": ["client_credentials"],
  "token_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic"],
  "response_types_supported": ["token"],
  "scopes_supported": ["mcp"]
}
```

**`api/oauth/token.js`** (Vercel Edge function):

- Parses `grant_type`, `client_id`, `client_secret` from POST body (form-encoded or JSON)
- Also supports HTTP Basic auth (`Authorization: Basic base64(client_id:client_secret)`)
- Validates `client_secret` against `WORLDMONITOR_VALID_KEYS` env var (same logic as `_api-key.js`)
- On success: generates opaque token (`crypto.randomUUID()`), stores in Upstash Redis with key `oauth:token:<uuid>` → `{ apiKey, clientId, issuedAt }`, TTL 3600s
- Returns: `{ access_token, token_type: "Bearer", expires_in: 3600 }`
- On failure: returns RFC 6749 error: `{ error: "invalid_client" }` with HTTP 401

**`api/_oauth-token.js`** (shared helper, importable by `api/mcp.ts`):

- `resolveApiKeyFromBearer(req)` — extracts `Authorization: Bearer <token>`, looks up `oauth:token:<token>` in Redis, returns the stored API key or null
- Used by `mcp.ts` in its auth chain

### Modified files

**`api/mcp.ts`** — extend auth to check Bearer token before falling back to direct key:
```
1. Extract Bearer token from Authorization header
2. If Bearer: resolveApiKeyFromBearer(token) → apiKey
3. If no Bearer: existing ?key= / X-WorldMonitor-Key logic
4. Proceed with apiKey as before
```

**`vercel.json`**:

- Add rewrite: `{ "source": "/oauth/token", "destination": "/api/oauth/token" }` (canonical URL without `/api/` prefix, cleaner for discovery doc)
- Add CORS headers entry for `/api/oauth/token` (allow `*`, `Content-Type, Authorization`)
- Update discovery doc to use `/oauth/token` (no `/api/` prefix)

**`public/.well-known/oauth-authorization-server`** — already in excluded list in SPA regex.

### Auth chain in `mcp.ts` after change

```
Request arrives →
  1. Bearer token present? → Redis lookup → apiKey (or 401 if not found/expired)
  2. ?key= param? → direct key validate
  3. X-WorldMonitor-Key header? → direct key validate
  4. None → 401
```

## Acceptance Criteria

- [ ] `GET /.well-known/oauth-authorization-server` returns valid RFC 8414 JSON with `token_endpoint`
- [ ] `POST /oauth/token` with valid `client_secret` (= any key in `WORLDMONITOR_VALID_KEYS`) returns `{ access_token, token_type: "Bearer", expires_in: 3600 }`
- [ ] `POST /oauth/token` with invalid `client_secret` returns `{ error: "invalid_client" }` + HTTP 401
- [ ] `POST /mcp` with `Authorization: Bearer <valid_access_token>` returns MCP tools list (not 401)
- [ ] `POST /mcp` with `Authorization: Bearer <expired_or_unknown_token>` returns 401
- [ ] `POST /mcp` with direct `X-WorldMonitor-Key` still works (backward compat)
- [ ] `POST /mcp` with `?key=` query param still works (backward compat)
- [ ] Token expires after 3600s (Redis TTL enforced)
- [ ] CORS: token endpoint and discovery doc return `Access-Control-Allow-Origin: *`
- [ ] Claude.ai connector connects successfully using Client ID + Client Secret fields

## Implementation Order

1. Add static `public/.well-known/oauth-authorization-server` JSON file
2. Add `api/oauth/token.js` (token issuance)
3. Add `api/_oauth-token.js` (Bearer resolution helper)
4. Update `api/mcp.ts` auth chain (import + Bearer check)
5. Update `vercel.json` (rewrite `/oauth/token` → `/api/oauth/token`, CORS headers)
6. Test end-to-end with curl before claude.ai

## Curl Test Sequence

```bash
# 1. Discovery
curl https://worldmonitor.app/.well-known/oauth-authorization-server

# 2. Get token
curl -X POST https://worldmonitor.app/oauth/token \
  -d "grant_type=client_credentials&client_id=worldmonitor&client_secret=YOUR_API_KEY"

# 3. Use token with MCP
curl -X POST https://worldmonitor.app/mcp \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

## Dependencies & Risks

- **Upstash Redis** — already used for rate limiting and cache; no new dep needed
- **Token storage** — Redis keys `oauth:token:<uuid>` with 3600s TTL. Tokens are opaque UUIDs, no JWT complexity
- **Client ID semantics** — The Client ID field in claude.ai is just a label; the real auth is `client_secret`. We accept any non-empty string for `client_id`
- **CORS on discovery doc** — static file served from `public/`, Vercel handles it with `Cache-Control` from the static headers rules; `ACAO: *` needed — add to vercel.json headers for `/.well-known/(.*)`
- **No PKCE needed** — Client Credentials grant is machine-to-machine, no browser redirect, no PKCE required
- **Token refresh** — Not needed; claude.ai will re-fetch a token when it gets 401. `expires_in: 3600` is standard and claude.ai handles re-auth automatically

## Out of Scope

- Authorization Code flow (not needed for claude.ai connector)
- Refresh tokens (not needed; client re-authenticates with client_secret)
- Per-scope permissions (MCP server already gates on API key validity)
- JWT tokens (opaque tokens simpler, sufficient, and avoids key management)
- User-facing OAuth consent screens

## Sources & References

- [MCP Spec 2025-03-26 — Authorization](https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/authorization/)
- [RFC 6749 §4.4 — Client Credentials Grant](https://datatracker.ietf.org/doc/html/rfc6749#section-4.4)
- [RFC 8414 — OAuth 2.0 Authorization Server Metadata](https://datatracker.ietf.org/doc/html/rfc8414)
- Current MCP implementation: `api/mcp.ts`
- API key validation: `api/_api-key.js`
- Redis client: `api/_upstash-json.js`
