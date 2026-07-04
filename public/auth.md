# WorldMonitor — Agent Authentication (auth.md)

This document tells autonomous agents how to authenticate with the WorldMonitor
API and MCP server. It follows the WorkOS **auth.md** agent-registration
protocol: <https://workos.com/auth-md>.

WorldMonitor exposes a real-time geopolitical, financial, and risk-intelligence
API plus a Model Context Protocol (MCP) server at `https://worldmonitor.app/mcp`.
Public discovery (server info, tool catalog) is available without credentials;
data-returning calls require a bearer token or API key.

The machine-readable pointer to this file lives in the `agent_auth.skill` field
of the authorization-server metadata (see [Discover](#discover)).

---

## Discover

An agent can learn WorldMonitor's auth requirements from a single unauthenticated
request, then follow the discovery chain — no trial and error.

1. **Trigger a challenge.** Call any data method on the API or MCP endpoint
   without credentials and read the `WWW-Authenticate` response header:

   ```http
   POST https://worldmonitor.app/mcp
   Content-Type: application/json

   {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_market_data","arguments":{}}}
   ```

   ```http
   HTTP/1.1 401 Unauthorized
   WWW-Authenticate: Bearer realm="worldmonitor", resource_metadata="https://worldmonitor.app/.well-known/oauth-protected-resource"
   ```

2. **Read the protected-resource metadata** (RFC 9728) named by
   `resource_metadata`:

   ```http
   GET https://worldmonitor.app/.well-known/oauth-protected-resource
   ```

   It returns the `resource` identifier and the `authorization_servers` that
   issue tokens for it.

3. **Read the authorization-server metadata** (RFC 8414) at the advertised
   authorization server. It carries the standard OAuth endpoints plus the
   `agent_auth` discovery block:

   ```http
   GET https://worldmonitor.app/.well-known/oauth-authorization-server
   ```

   ```json
   {
     "issuer": "https://worldmonitor.app",
     "authorization_endpoint": "https://worldmonitor.app/oauth/authorize",
     "token_endpoint": "https://worldmonitor.app/oauth/token",
     "registration_endpoint": "https://worldmonitor.app/oauth/register",
     "grant_types_supported": ["authorization_code", "refresh_token"],
     "code_challenge_methods_supported": ["S256"],
     "token_endpoint_auth_methods_supported": ["none"],
     "scopes_supported": ["mcp"],
     "agent_auth": {
       "skill": "https://worldmonitor.app/auth.md",
       "register_uri": "https://worldmonitor.app/oauth/register",
       "identity_types_supported": ["anonymous"],
       "anonymous": { "credential_types_supported": ["access_token"] }
     }
   }
   ```

   The metadata is served per-host, so the `issuer` and every endpoint match the
   origin you fetched it from (`worldmonitor.app` or `api.worldmonitor.app`).

---

## Pick a method

`identity_types_supported` advertises **`anonymous`** registration. An agent
registers without asserting a user identity up front; a human establishes and
consents to the binding interactively during authorization (see
[Claim](#claim)).

The anonymous identity type issues one `credential_type`:

- **`access_token`** — an OAuth 2.1 bearer token obtained through Dynamic Client
  Registration + the authorization-code + PKCE flow (see [Register](#register)).
  Best for interactive, user-consented agents such as Claude.

A second credential, an **`api_key`**, is also accepted by the API but is *not*
an anonymous credential: it is a long-lived key minted by a signed-in user from
the developer dashboard (see [Register](#register)), so it carries that user's
identity. Best for headless / server-to-server automation.

**`identity_assertion` is not supported.** WorldMonitor does not currently accept
a pre-issued user-identity assertion (for example an
`urn:ietf:params:oauth:token-type:id-jag` ID-JAG token) in exchange for
credentials — there is no identity or token-exchange endpoint. Identity is
always established interactively at the authorization step, so agents should use
the `anonymous` path above.

---

## Register

**OAuth path — RFC 7591 Dynamic Client Registration** at the `register_uri`.
Register a public client, supplying the redirect URIs you will use for the
authorization-code flow:

```http
POST https://worldmonitor.app/oauth/register
Content-Type: application/json

{
  "client_name": "My Agent",
  "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"]
}
```

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "client_id": "…",
  "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
```

Registration is open but the `redirect_uris` are allowlisted: the Claude
(`https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`)
callbacks and `http://localhost` / `http://127.0.0.1` on any port (for local MCP
clients and the MCP inspector). Clients are public — there is no client secret;
protect the flow with PKCE (`S256`).

**API-key path.** Alternatively, sign in and self-issue an API key from the
developer dashboard at <https://worldmonitor.app/developers>. No registration
call is required.

---

## Claim

Anonymous agents are claimed by a user **at authorization time** — there is no
separate machine claim endpoint. Start the authorization-code flow at the
`authorization_endpoint` with a PKCE challenge:

```http
GET https://worldmonitor.app/oauth/authorize?response_type=code&client_id=…&redirect_uri=https://claude.ai/api/mcp/auth_callback&code_challenge=…&code_challenge_method=S256&scope=mcp
```

The user signs in and approves the agent on the WorldMonitor consent screen. That
consent binds the token WorldMonitor subsequently issues to the approving user's
account and entitlements. For API keys, the "claim" is implicit: the key belongs
to the user who created it in the dashboard.

---

## Use the credential

Exchange the authorization code for a bearer token at the `token_endpoint`:

```http
POST https://worldmonitor.app/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&code=…&redirect_uri=https://claude.ai/api/mcp/auth_callback&client_id=…&code_verifier=…
```

```json
{ "access_token": "…", "token_type": "Bearer", "expires_in": 3600, "refresh_token": "…", "scope": "mcp" }
```

Then present the credential on every request. Either header is accepted:

```http
POST https://worldmonitor.app/mcp
Authorization: Bearer <access_token>
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_world_brief","arguments":{}}}
```

```http
POST https://worldmonitor.app/mcp
X-WorldMonitor-Key: <api_key>
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_world_brief","arguments":{}}}
```

The same credentials authorize the REST API. Browse the tool catalog and OpenAPI
schema from the discovery documents linked at
<https://worldmonitor.app/.well-known/api-catalog>.

---

## Errors

- **`401 Unauthorized`** — missing, expired, or invalid credential. The response
  carries the `WWW-Authenticate: Bearer … resource_metadata="…"` hint; restart at
  [Discover](#discover). Over MCP the JSON-RPC error code is `-32001`.
- **`400 invalid_request` / `invalid_redirect_uri`** — malformed registration or
  a redirect URI outside the allowlist.
- **`400 unsupported_grant_type`** — only `authorization_code`, `refresh_token`,
  and (legacy) `client_credentials` grants are accepted at the token endpoint.
- **`400 invalid_grant`** — an expired, consumed, or revoked authorization code
  or refresh token. Revoked tokens are not distinguished from invalid ones.
- **`429 Too Many Requests`** — registration and token endpoints are rate
  limited per IP; back off and retry.

---

## Revocation

- **Expiry.** Access tokens expire after **1 hour**; refresh tokens after
  **7 days**. Short-lived by design — let them lapse to de-authorize an agent.
- **User-initiated revoke.** A signed-in user can revoke an agent's access from
  the developer dashboard (<https://worldmonitor.app/developers>). Revocation is
  authoritative: the bound token is rejected on its next use with `401` /
  `invalid_grant`.
- **Refresh-token rotation.** Refresh tokens rotate on every use with token-family
  revocation, so a stolen refresh token is invalidated once the legitimate client
  next refreshes.

WorldMonitor does not publish a standalone machine revocation endpoint; revoke
through the dashboard or by letting the credential expire.
