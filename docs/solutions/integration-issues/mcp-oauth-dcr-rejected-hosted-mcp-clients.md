---
title: "MCP OAuth registration rejected every hosted MCP client except Claude"
date: 2026-09-17
category: integration-issues
module: "MCP OAuth 2.1 authorization server (api/oauth)"
problem_type: integration_issue
component: authentication
severity: high
symptoms:
  - "POST /oauth/register returned 400 invalid_redirect_uri for https://www.cursor.com/agents/mcp/oauth/callback while Cursor desktop (loopback callback) worked"
  - "Pro subscribers could not connect from Cursor Agents or Grok Bot and had no API-key fallback, because Pro MCP access is OAuth-only"
  - "VS Code could never register: it sends four redirect_uris in one request and the cap was three"
root_cause: missing_validation
resolution_type: code_fix
related_components:
  - documentation
  - testing_framework
tags:
  - mcp
  - oauth
  - dynamic-client-registration
  - redirect-uri-allowlist
  - rfc-9207
  - issuer
  - cursor
  - chatgpt
---

# MCP OAuth registration rejected every hosted MCP client except Claude

## Problem

Dynamic Client Registration accepted only the two Claude callbacks plus http loopback. Every hosted MCP client (Cursor Agents, Grok Bot, ChatGPT, Grok, VS Code for the Web) was refused before sign-in. Pro accounts have no API-key path, so those customers had no workaround short of buying API Starter (#8303, reported by a Pro subscriber by email).

## Symptoms

- `POST https://api.worldmonitor.app/oauth/register` with `redirect_uris: ["https://www.cursor.com/agents/mcp/oauth/callback"]` returned `400 {"error":"invalid_redirect_uri","error_description":"Redirect URI not allowed: … Allowed: claude.ai/claude.com callbacks and localhost."}` on both `api.worldmonitor.app` and `worldmonitor.app`.
- Cursor desktop worked, because it registers `http://localhost:8787/callback`, which the loopback branch already accepted.
- Grok Bot failed even though its loopback entry was allowed. Cursor staff confirmed it registers `cursor://anysphere.cursor-mcp/oauth/callback`, `https://www.cursor.com/agents/mcp/oauth/callback`, and `http://localhost:8787/callback` in one request, and a single disallowed entry rejects the whole registration.
- The docs listed Cursor as a supported client. That was true only for desktop.

## What Didn't Work

- **Allowlisting only the reported URL.** The Cursor Agents callback alone does not fix Grok Bot, which also sends the `cursor://` deeplink. Registration is all-or-nothing per request, so every URI a client sends together must be accepted.
- **Trusting a third-party issue for a vendor callback.** A GitHub issue on another MCP server (dinglebear-ai/unraid#390) gave Grok's callback as `https://grok.com/connectors/oauth/callback`, and a first research pass repeated it. It is wrong. Grok publishes its client metadata at `https://grok.com/oauth/mcp-client.json`, and that file lists `https://grok.com/connectors-oauth-exchange-code/` and `https://console.x.ai/connectors-oauth-exchange-code/`, both with a trailing slash.
- **Allowlisting ChatGPT's callback without RFC 9207.** OpenAI's auth docs state that ChatGPT uses its stable `https://chatgpt.com/connector_platform_oauth_redirect` only when the authorization server advertises `authorization_response_iss_parameter_supported` and returns `iss` on every authorization response. Otherwise it uses a per-connection `https://chatgpt.com/connector/oauth/{callback_id}`, which an exact-match list cannot hold.
- **Deriving `iss` from the responding host.** Metadata `issuer` is host-derived (`resolveMetadataOrigin` in `api/_agent-metadata.ts`), but the authorization response does not always leave from the host the client discovered. The native consent form posts to `api.worldmonitor.app`, and the Pro sign-in bounce always finishes on `api.worldmonitor.app/oauth/authorize-pro`. A client that discovered `https://www.worldmonitor.app` would receive `iss=https://api.worldmonitor.app`. Strict RFC 9207 clients reject that, so the bug would break Claude, which worked before.
- **Sharing the display formatter by importing a sibling route.** The first cut had `api/oauth/authorize.js` import `./register.js`. Codex flagged it (P1) against AGENTS.md: legacy `api/*.js` entries share code only through `_`-prefixed helpers or packages.

## Solution

Fixed in PR #8305.

**1. Exact-match allowlist of vendor-owned callbacks** in `api/oauth/_redirect-uri.js` (`ALLOWED_REDIRECT_URIS`, `isAllowedRedirectUri`), imported by `register.js` and re-checked by `api/internal/mcp-grant-mint.ts` before a Pro grant is minted. Loopback stays `http:` on `localhost` or `127.0.0.1` with any port and path.

| Client | Callback(s) | Evidence |
|---|---|---|
| Claude | `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback` | pre-existing |
| Cursor Agents, Cursor web, Grok Bot | `https://www.cursor.com/agents/mcp/oauth/callback`, `cursor://anysphere.cursor-mcp/oauth/callback` | cursor.com/docs/mcp; Cursor forum staff reply |
| ChatGPT | `https://chatgpt.com/connector_platform_oauth_redirect` | developers.openai.com/plugins/build/auth |
| Grok | `https://grok.com/connectors-oauth-exchange-code/`, `https://console.x.ai/connectors-oauth-exchange-code/` | grok.com/oauth/mcp-client.json (fetched live) |
| VS Code for the Web | `https://vscode.dev/redirect`, `https://insiders.vscode.dev/redirect` | [microsoft/vscode `fetchDynamicRegistration`](https://github.com/microsoft/vscode/blob/main/src/vs/base/common/oauth.ts) |
| Perplexity | `https://www.perplexity.ai/rest/connections/oauth_callback`, `https://enterprise.perplexity.ai/rest/connections/oauth_callback` | Perplexity help center |
| Mistral Le Chat | `https://callback.mistral.ai/v1/integrations_auth/oauth2_callback` | **documented exception** — no vendor doc or client source found; 7+ independent MCP servers allowlist this exact URL, including `aws-samples/mistral-on-aws`, and one reports observing it on live traffic |
| Devin | `https://api.devin.ai/mcp/oauth/callback` | docs.devin.ai |
| Google Antigravity | `https://antigravity.google/oauth-callback` | antigravity.google/docs/mcp |

Mistral is the one entry admitted without evidence from the client itself, so it is marked as an exception in the table above. What made it admissible is not the number of repositories citing it: it is that the URL is on a host the vendor owns, several independent implementations agree on it byte for byte, and a wrong entry here cannot grant anything — an exact-match string either matches what a client sends or never fires, and only Mistral can receive a code sent to `callback.mistral.ai`. Excluded for failing that same test: LobeHub, Linear Agent, and Amp, each resting on one uncorroborated third-party mention; Gemini custom apps and Copilot Studio, whose callbacks are generated per user or per tenant and cannot be matched exactly; and M365 Copilot, which needs a confidential client.

**2. Registration cap 3 → 8** (`MAX_REDIRECT_URIS` in `api/oauth/register.js`). VS Code sends four URIs in one request. Every entry still has to pass the allowlist, so the cap only bounds the stored record.

**3. RFC 9207 `iss`, captured when the flow starts.** `api/oauth-authorization-server.ts` advertises `authorization_response_iss_parameter_supported: true`. `GET /oauth/authorize` stores the issuer in the server-held nonce, and both redirects replay it:

```js
// api/oauth/authorize.js — GET: capture the issuer of the host whose metadata named this endpoint
const iss = resolveAuthorizationIssuer(req);
await redisSet(`oauth:nonce:${nonce}`, { client_id, redirect_uri, code_challenge, state, iss, created_at: Date.now() }, 600);

// POST (API-key consent) — may run on api.* even when the flow started on www
if (iss) redirectUrl.searchParams.set('iss', iss);
```

```ts
// api/oauth/authorize-pro.ts — always served on api.*, so never use this host
if (typeof nonceData.iss === 'string' && nonceData.iss) {
  redirectUrl.searchParams.set('iss', nonceData.iss);
}
```

`resolveAuthorizationIssuer` mirrors `resolveMetadataOrigin`, because the edge `.js` entry does not import TypeScript. `tests/oauth-authorize-iss.test.mjs` pins the two against each other across ten hosts, including spoofed, uppercase, and port-bearing ones. A nonce written before the deploy carries no `iss` and redirects without the parameter. The bad-key retry path (`retryConsent`) copies the whole nonce, so the retry keeps the original issuer.

**4. Consent screens show a custom-scheme callback with its scheme.** `redirectDisplayHost` renders `cursor://anysphere.cursor-mcp` instead of the bare `anysphere.cursor-mcp`, which reads like a web host.

## Why This Works

The allowlist was right to be closed. A registered callback is where the authorization code is delivered, so accepting arbitrary URIs would let anyone send a victim's code to their own server. The defect was that the list covered one vendor. Each new entry is a vendor-owned callback matched byte for byte, so the *threat class* is the one the claude.ai entry already carried: an attacker starts a flow in their own account on that platform and phishes a user into approving it. The consent page shows the redirect host, and the token endpoint binds the code to the PKCE verifier, `client_id`, and `redirect_uri`, so a code delivered to a platform is useless to anyone who did not initiate that flow.

The trusted surface did grow, though, and that is the cost of the fix. Nine more platforms can now receive an authorization code for a WorldMonitor account, which means nine more places where such a flow can be started and nine more vendors whose own callback handling we now depend on. That is the trade for supporting hosted clients at all; it is bounded by keeping entries exact, vendor-owned, and few, and by the fact that each addition is a deliberate, recorded decision rather than a pattern that admits a family of URLs.

The `iss` bug class is a mismatch between where the issuer is decided and where the response is sent. Capturing it at the start of the flow ties it to the only host whose metadata the client could have used, whichever host finishes the flow.

## Prevention

- **Take callback URLs from the client itself:** vendor docs, the client's source (VS Code), or its published client metadata document (Grok). Third-party issues and blog posts give leads, not answers. For each entry, record where the URL came from, in the PR description or in the "Redirect URI allowlist" table in `docs/mcp-overview.mdx`.
- **Admit an exception only against the stated bar, and mark it as one.** When the client publishes nothing, an entry is admissible only if the URL is on a host the vendor owns and several independent implementations agree on it byte for byte, and it must be labelled an exception where it is recorded, with what is missing. Two things that do *not* qualify it: a count of citations, and a claim you could not trace to a specific repository or document. Re-check an exception whenever the vendor publishes its own list.
- **Test the exact multi-URI arrays clients send, not single URIs.** `tests/oauth-register-redirect-allowlist.test.mjs` registers Grok Bot's three-URI array and VS Code's four-URI array verbatim, and rejects lookalikes (`wwwxcursor.com`, `cursor.com` without `www`, `www.grok.com`, trailing-slash and query variants).
- **Any response value that must equal a host-derived identifier gets captured at the request that fixed the host.** Never recompute it on a later hop. This applies to `iss`, and to any future `resource` or audience value.
- **Route entries never import each other.** `tests/edge-functions.test.mjs` ("imports no sibling route entry") fails any `api/*.js` or `api/oauth/*.js` entry whose relative import is not `_`-prefixed.
- **Validate in production after the deploy, not only in tests.** The recipe used for #8305:
  1. Register test clients for the new callback sets and one arbitrary URI, which must return 400.
  2. Fetch `/.well-known/oauth-authorization-server` on apex, `www`, and `api`, with a cache-buster and without one.
  3. Open `GET /oauth/authorize` on each host and parse `_nonce` from the consent HTML.
  4. Read `oauth:nonce:<n>` from Upstash and assert `iss` equals `https://<host>`.
  5. Delete the test client and nonce keys.

  `/oauth/register` is limited to 5 requests per minute per IP, and rejected probes count, so wait out the window between a polling probe and the validation run. All 16 checks passed on the production deploy of #8305.
- A Vercel production build for this repo took about 13 minutes on the #8305 merge (merged 17:36 UTC, live 17:49), against about 7 on the #8293 merge earlier that day. Poll for the new behavior (for example, the new error text on a rejected registration) rather than assuming a fixed deploy time.

## Related Issues

- #8303: the Cursor Agents / Grok Bot report
- PR #8305: the fix
- #5818 (open at time of writing): adopt the MCP 2026-07-28 authorization changes. The spec deprecates Dynamic Client Registration in favor of Client ID Metadata Documents, where the `client_id` is a URL on the client's own domain that publishes its `redirect_uris` (Grok already publishes one). Supporting that would replace most of this hand-maintained callback list with a domain trust decision.
- #4938: an earlier outage on the same `POST /oauth/register` endpoint, caused by edge routing rather than validation
- PR #8267 (open at time of writing): registration payload size bounds. Its test expects 4 `redirect_uris` to be rejected and imports `isAllowedRedirectUri` from `register.js`; both need updating after #8305.
- [MCP endpoints crawler-accessible without CDN replay](mcp-crawler-get-and-method-aware-canonical-redirects.md): documents the apex exemption for `/oauth/*` and `/.well-known/*` that keeps the authorize request on the discovered host.
