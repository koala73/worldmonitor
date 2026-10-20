# World Monitor threat model (OSS Scanner)

## What this project does and where untrusted input enters

World Monitor is a real-time geopolitical and markets intelligence dashboard
(worldmonitor.app), with a free tier, a paid Pro tier, a public REST/RPC API,
an MCP server, and a Tauri desktop app. One repository holds every deployed
component:

| Component | Path | Runs on |
|---|---|---|
| SPA (vanilla TS + Vite) | `src/`, `index.html`, `public/` | browser |
| Edge API handlers | `api/` (Vercel Edge functions), `middleware.ts`, `vercel.json` | Vercel |
| Proto-first RPC gateway and domain handlers | `server/`, `proto/` | Vercel Edge (via `api/`) |
| MCP server + OAuth 2.1 authorization server | `api/mcp*`, `api/mcp/`, `api/oauth/`, `api/oauth-*.ts` | Vercel Edge |
| Accounts, API keys, billing, entitlements, notifications | `convex/` | Convex Cloud |
| Relay (RSS proxy, AIS WebSocket, Telegram, notification delivery) and seeders | `scripts/` (`ais-relay.cjs`, `notification-relay.cjs`, `seed-*.mjs`) | Railway |
| Consumer-prices scraper/API | `consumer-prices-core/` | Railway |
| Desktop shell and local API sidecar | `src-tauri/` (Rust), `src-tauri/sidecar/local-api-server.mjs` | user's machine |
| Self-hosted image | `Dockerfile`, `docker/` | anyone's server |
| CORS preflight worker | `workers/api-cors-preflight/` | Cloudflare |

Untrusted input:

- **Any HTTP request** to `api/**` and the RPC gateway: path, query, headers
  (`Origin`, `Authorization`, `X-WorldMonitor-Key`, `X-Forwarded-For`), body.
  Callers range from anonymous browsers to holders of free or Pro API keys,
  Clerk session JWTs, and MCP OAuth tokens.
- **Upstream feed content**: RSS/Atom, GDELT, Telegram, news APIs, market and
  ship/flight feeds. Treat every field as attacker-controlled. It is rendered in
  the SPA and stored in Redis; some of it is passed to LLM prompts.
- **URLs supplied by users**: notification webhook targets, MCP proxy targets,
  RSS URLs through the RSS proxy.
- **Payment and email webhooks** (Dodo Payments, Resend) into `convex/http.ts`.
- **Desktop**: web content loaded into Tauri windows (including the YouTube
  login window) and other local processes that can reach the sidecar's
  localhost port.

## Security properties we rely on

- Server secrets (provider API keys, Upstash/Convex credentials, webhook
  signing secrets, the Clerk secret) never reach a client, a log line or a
  response.
- One user cannot read or change another user's data: API keys, notification
  channels, alert rules, saved state, billing, MCP grants.
- Pro-only RPCs, MCP tools, and quotas are enforced server-side. The client
  hiding a button is not the check (`api/_api-key.js`, `server/gateway.ts`,
  `convex/entitlements.ts`, `api/mcp/quota.ts`).
- Server-side fetches cannot reach private, loopback, link-local or cloud
  metadata addresses. The RSS proxy only fetches allowlisted domains,
  re-checked on every redirect (`api/_rss-allowed-domains.js`,
  `api/_notification-webhook-ssrf.ts`, `api/mcp-proxy.ts`).
- Feed content cannot execute script on worldmonitor.app. CSP is
  `script-src 'self'`, and HTML is only written through the safe-HTML helpers
  enforced by `scripts/enforce-safe-html.mjs`.
- OAuth and MCP grants: redirect URIs, PKCE, `state`, and token audience are
  validated. Tokens are scoped to the user who consented.
- Desktop: only trusted windows can call the secret, cache and token IPC
  commands. Every renderer→sidecar request needs the per-session
  `LOCAL_API_TOKEN`.

`SECURITY.md` lists known and accepted residual risks. One example is the
DNS-rebinding window in the MCP proxy (issue #5061). Do not report those as
new findings unless you can show they are worse than described.

## Components that matter most / least

Highest value, in order:

1. Authentication and authorization: `server/_shared/auth-session.ts`,
   `api/_api-key.js`, `api/_user-api-key*`, `api/agent-auth.ts`,
   `api/oauth/`, `api/mcp/auth.ts`, `convex/apiKeys.ts`, `convex/mcpProTokens.ts`,
   `api/desktop-auth/`.
2. Billing and entitlements: `convex/payments/` (webhook signature checks,
   checkout, subscription state), `convex/entitlements.ts`,
   `api/create-checkout.ts`, `api/customer-portal.ts`.
3. SSRF surfaces: `api/rss-proxy*`, `scripts/ais-relay.cjs` RSS path,
   `api/mcp-proxy.ts`, notification webhook delivery
   (`scripts/notification-relay.cjs`, `api/notification-channels.ts`).
4. XSS in the SPA from feed/news/LLM content (`src/components/`, `src/services/`).
5. Desktop trust boundary: `src-tauri/src/main.rs`, `src-tauri/capabilities/`,
   `src-tauri/sidecar/local-api-server.mjs`.
6. Cache and rate-limit integrity: a per-user or Pro response served to
   another caller via Redis or CDN keys; rate-limit bypass via spoofed client IP
   (`api/_client-ip.js`, `api/_rate-limit.js`).

Lower value but in scope: seeders in `scripts/seed-*.mjs` (they fetch public
data with server credentials, so watch for credential leaks and SSRF via
upstream-controlled redirects), `consumer-prices-core/`, `workers/`.

Out of scope: `blog-site/`, `pro-test/` (static marketing pages), `demos/`,
`docs/`, `e2e/`, `tests/` (except as harnesses), generated files
(`*.generated.*`, `convex/_generated/`, `src/generated/`), and anything under
`node_modules/`.

## How to exercise it

The image has `/src`, an unmodified checkout, with all npm trees installed
(root, `scripts/`, `consumer-prices-core/`, `pro-test/`), the frontend built
into `dist/`, and Rust crates fetched for `src-tauri/`.
`/opt/worldmonitor-runtime` is a copy of the tree in which
`docker/build-handlers.mjs` has bundled `api/**` for the local API server. Read
and patch source in `/src`, never in the runtime copy.
There is no network, and no production credentials are present. Tests stub
Redis, Convex and upstream fetches.

- Node unit/integration tests: `node --import tsx --test tests/<file>.test.mjs`
  (about 2,200 files under `tests/`; `npm run test:data` runs them all).
- API, sidecar and relay security tests: `npm run test:sidecar`.
- Convex functions (auth, billing, API keys) under `convex-test`:
  `npm run test:convex`.
- DOM-level rendering tests: `npm run test:dom`.
- Run the API locally. Apart from the unauthenticated liveness route
  `/api/sidecar-health`, the server rejects every request unless
  `LOCAL_API_TOKEN` is set and sent back in `x-worldmonitor-local-token`:

  ```sh
  export LOCAL_API_TOKEN=scan-local-token
  cd /opt/worldmonitor-runtime && LOCAL_API_MODE=docker LOCAL_API_PORT=46123 \
    LOCAL_API_RESOURCE_DIR=/opt/worldmonitor-runtime \
    node src-tauri/sidecar/local-api-server.mjs &
  curl -H "x-worldmonitor-local-token: $LOCAL_API_TOKEN" \
    http://127.0.0.1:46123/api/product-catalog
  ```

  Without the header, the server answers 401. In this mode the native
  administration routes (`/api/local-*`) always return 403. Handlers that need Redis or
  upstream data return degraded responses offline. Auth, validation, CORS and
  routing logic still run. With no DNS, the SSRF guard rejects every outbound
  feed URL with 403 `Could not resolve hostname`. Exercise fetch paths through
  the tests, which stub `fetch` and DNS. The runtime
  copy holds bundles, which inline the helpers they import. After patching
  `/src`, run `sh /src/.oss-scanner/build-runtime.sh` to recreate the copy
  from source, then restart the server.
- Rust: `cargo check --offline --manifest-path src-tauri/Cargo.toml`.

## How we rate severity

- **Critical**: unauthenticated remote code execution in any deployed component;
  authentication bypass giving access to arbitrary users' accounts or data;
  disclosure of server-side secrets; forging payment webhooks or granting Pro
  entitlements without paying.
- **High**: cross-user read or write (IDOR) of API keys, notification channels,
  alert rules or billing state; SSRF reaching internal, loopback or metadata
  addresses, or bypassing the RSS allowlist; stored XSS on worldmonitor.app
  executing despite CSP; Pro-only data or MCP tools reachable without a Pro
  entitlement; OAuth/MCP token theft or grant confusion; another local process
  or an untrusted window reaching desktop secrets or the sidecar; one user's
  cached response served to another.
- **Medium**: reflected XSS or open redirect that needs user interaction and
  leaks no tokens; quota or rate-limit bypass for free-tier abuse; log or
  analytics injection; SSRF limited to public hosts outside the allowlist.
- **Low**: missing hardening headers where CSP still holds, verbose error
  messages without secrets, issues needing a compromised renderer or local root.

A finding is only as severe as its demonstrated reachability. Trace it from a
real entry point through the gateway, middleware and validators in front of
it. A missing check in a helper that every caller guards elsewhere is not a
vulnerability.

## Reports and patches

Include the entry point, the caller position (anonymous, free key, Pro key,
signed-in user, local process), a reproducer (a `curl` against the local sidecar
or a failing `node --test` case), and the impact. Patches should match the
surrounding style and include a regression test under `tests/` (or the
adjacent `*.test.mjs`) that fails before the fix.

## Anything to leave alone

- Denial of service, resource exhaustion and missing rate limits on endpoints
  that serve only public data (out of scope per `SECURITY.md`).
- Inaccurate, biased or false content from upstream feeds, unless it becomes
  code execution or crosses a trust boundary.
- Obvious placeholder keys and tokens in tests, fixtures and `.env.example`
  (dummy strings such as `test-key`, `sk-test-...`, `xxx`). Report any value
  there that looks like a live credential.
- Prompt injection that only changes LLM-generated text shown to the same user
  who supplied the input.
- Vulnerabilities in third-party services we call (report them upstream), and
  in forks or user-modified self-hosted configurations.
