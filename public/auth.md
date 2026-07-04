# WorldMonitor — Agent Authentication (auth.md)

How agents authenticate with the WorldMonitor API and MCP server
(`https://worldmonitor.app/mcp`), per the WorkOS **auth.md** spec:
<https://workos.com/auth-md>. Discovery is open; data calls need a bearer token
or API key.

## Discover

Learn the auth requirements from one unauthenticated request, then follow the
chain:

1. Call any data method without credentials; read the `WWW-Authenticate` header:

   ```
   401 Unauthorized
   WWW-Authenticate: Bearer resource_metadata="https://worldmonitor.app/.well-known/oauth-protected-resource"
   ```

2. `GET /.well-known/oauth-protected-resource` (RFC 9728) → the `resource` id and
   its `authorization_servers`.
3. `GET /.well-known/oauth-authorization-server` (RFC 8414) → the OAuth endpoints
   plus the `agent_auth` block that points back here:

   ```json
   { "issuer": "https://worldmonitor.app",
     "agent_auth": {
       "skill": "https://worldmonitor.app/auth.md",
       "register_uri": "https://worldmonitor.app/oauth/register",
       "identity_types_supported": ["anonymous"],
       "anonymous": { "credential_types_supported": ["access_token"] } } }
   ```

   Metadata is per-host: `issuer` and endpoints match the origin you fetched
   (`worldmonitor.app` or `api.worldmonitor.app`).

## Pick a method

`identity_types_supported` advertises **`anonymous`** — register without
asserting a user identity; a human consents interactively at authorization (see
[Claim](#claim)). Two credentials:

- **`access_token`** (anonymous) — OAuth 2.1 bearer via Dynamic Client
  Registration + authorization-code + PKCE (see [Register](#register)). For
  interactive agents such as Claude.
- **`api_key`** — *not* anonymous: a signed-in user mints it from the dashboard,
  so it carries that identity. For headless, server-to-server use.

**`identity_assertion` is not supported.** No pre-issued identity assertion (e.g.
an `urn:ietf:params:oauth:token-type:id-jag` id-jag token) is exchanged for
credentials — there is no identity or token-exchange endpoint. Identity is always
established interactively.

## Register

**RFC 7591 Dynamic Client Registration** at the `register_uri`:

```
POST /oauth/register  {"client_name":"My Agent","redirect_uris":["https://claude.ai/api/mcp/auth_callback"]}
→ 201 {"client_id":"…","token_endpoint_auth_method":"none","grant_types":["authorization_code","refresh_token"]}
```

`redirect_uris` are allowlisted (Claude callbacks + `http://localhost` /
`http://127.0.0.1` on any port). Clients are public — no secret; use PKCE
(`S256`). **API-key path:** self-issue a key at
<https://worldmonitor.app/developers> — no registration call.

## Claim

Anonymous agents are claimed **at authorization time**, not via a separate
endpoint. Start the authorization-code flow with a PKCE challenge:

```
GET /oauth/authorize?response_type=code&client_id=…&code_challenge=…&code_challenge_method=S256&scope=mcp
```

The user signs in and approves; that binds the issued token to their account. For
API keys the claim is implicit — the key belongs to its dashboard creator.

## Use the credential

Exchange the code for a bearer token, then send it on every request:

```
POST /oauth/token  grant_type=authorization_code&code=…&code_verifier=…&client_id=…
→ {"access_token":"…","token_type":"Bearer","expires_in":3600,"refresh_token":"…"}

POST /mcp   Authorization: Bearer <access_token>   (or)   X-WorldMonitor-Key: <api_key>
```

The same credentials authorize the REST API. Catalog:
<https://worldmonitor.app/.well-known/api-catalog>.

## Errors

- **401** — missing/expired/invalid credential; response carries
  `WWW-Authenticate: Bearer … resource_metadata="…"` — restart at
  [Discover](#discover). Over MCP the JSON-RPC code is `-32001`.
- **400** — `invalid_redirect_uri` (outside the allowlist),
  `unsupported_grant_type` (only `authorization_code` / `refresh_token` /
  `client_credentials`), or `invalid_grant` (expired/consumed/revoked token).
- **429** — registration/token endpoints are rate-limited per IP; back off.

## Revocation

- **Expiry** — access tokens last 1 hour, refresh tokens 7 days; let them lapse
  to de-authorize an agent.
- **User revoke** — a signed-in user revokes an agent from the dashboard
  (<https://worldmonitor.app/developers>); the token is then rejected with `401`
  / `invalid_grant`.
- **Refresh rotation** — refresh tokens rotate on every use with token-family
  revocation, so a stolen token dies once the real client next refreshes.

No standalone machine revocation endpoint — revoke via the dashboard or let the
credential expire.
