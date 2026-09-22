---
title: "Hosted MCP connectors could never sign in because the unauthenticated initialize answered 200"
date: 2026-09-18
category: integration-issues
module: "MCP server transport auth (api/mcp/handler.ts)"
problem_type: integration_issue
component: authentication
severity: high
symptoms:
  - "Cursor Agents reported 'Could not obtain authentication URL' when connecting https://worldmonitor.app/mcp"
  - "Grok Bot rendered an Authorize card whose button did nothing, while other OAuth MCP servers worked in the same client"
  - "The server connected and listed about 75 tools with no sign-in, then returned 401 on the first paid tool call"
root_cause: logic_error
resolution_type: code_fix
related_components:
  - documentation
  - testing_framework
tags:
  - mcp
  - oauth
  - initialize
  - www-authenticate
  - rfc-9728
  - hosted-connectors
  - cursor
  - grok
---

# Hosted MCP connectors could never sign in because the unauthenticated initialize answered 200

## Problem

`/mcp` served an unauthenticated `initialize` with `200` and only returned `401` later, when a paid tool was called. Hosted connectors (Cursor Agents, Grok Bot, ChatGPT) decide whether a server needs sign-in from how that opening handshake is answered, so they recorded WorldMonitor as "connected, nothing to authenticate" and had no authorization server on file when the mid-session `401` arrived. Their sign-in control could never work.

## Symptoms

- Cursor Agents: "Could not obtain authentication URL".
- Grok Bot: an Authorize card appeared after the first paid call, and clicking it did nothing. Other OAuth MCP servers worked in the same client, which is what ruled out the client.
- Adding the server asked for no account and listed the full tool catalog; the `401` only appeared when asking for data.
- Production telemetry (Axiom `wm_api_usage`, `domain == 'mcp'`, 48 hours) showed which clients ever managed to authenticate under the old behavior:

| Client (by `user_agent`) | Requests | Authenticated |
|---|---|---|
| Claude | 7,921 | 79% |
| Cursor, including the `Cursor/1.0.0` agent backend | 26,686 | 11% |
| OpenAI (Codex / ChatGPT) | 10,616 | 4% |
| Grok, including `grok-connectors-manager` | 501 | 2%, and 23% of its requests were `401`s |

Only Claude copes with a `401` that arrives mid-session.

## What Didn't Work

- **Blaming the client.** The first read was that Grok Bot's Authorize button was broken. The user had connected several other OAuth MCP servers in Grok Bot successfully, so the difference had to be on our side.
- **Fixing OAuth registration and metadata only.** Widening the redirect allowlist, adding the RFC 9207 `iss` parameter (#8305) and serving path-scoped RFC 9728 metadata (#8309) were all real gaps and all shipped, and Cursor Agents still said "Could not obtain authentication URL". In this session's run against production the MCP SDK client fell back to the root metadata document and completed discovery, so missing path-scoped metadata was not what blocked these clients. None of it matters if the connector never starts an OAuth flow.
- **A second endpoint (`/mcp/auth`) that always challenges.** Rejected by the user: two MCP URLs for one product is more confusion, not less.
- **Challenging every unauthenticated request on `/mcp`.** This was the first version of #8321. It would have broken shipped clients: the published `worldmonitor` CLI and the SDKs default to `https://worldmonitor.app/mcp` (`DEFAULT_MCP_URL` in `cli/src/core.mjs`) and POST `tools/list` and `tools/call get_sources` with no key and no `initialize`. Telemetry showed `worldmonitor-cli/0.1.3` doing exactly that in production, installed versions cannot be updated, and the EULA and Terms promise a credential-free `get_sources`. It also needed 43 test changes across 16 files, against 4 tests in 4 files for the narrow version, which was its own signal that the design was too wide.
- **Keying the behavior on protocol version.** The server negotiates only `2025-03-26` and `2025-06-18`, and nothing in the spec formalizes anonymous discovery, so there was nothing to gate on.

## Solution

Challenge only the handshake, only on the transport (#8321). In `api/mcp/handler.ts`, right after the method is parsed:

```ts
if (method === 'initialize' && !hasCredentials(req) && !WELL_KNOWN_MCP_PATHS.has(requestPathname)) {
  const denied = await resolveAuthContext(req, deps, resourceMetadataUrl, corsHeaders, id);
  if (!denied.ok) {
    usage.phase = 'auth';
    return denied.response;
  }
}
```

The refusal is the same structured `401` an unauthenticated tool call already got: JSON-RPC `-32001`, a JSON body (never SSE), `error.data.reason = "no-account"`, the **request id echoed**, and `WWW-Authenticate` naming the protected-resource document for the route that was called (`/.well-known/oauth-protected-resource/mcp` for `/mcp`, `…/api/mcp` for `/api/mcp`), on whichever host the client used.

What each caller sees:

| Caller | Before | After |
|---|---|---|
| Hosted connector or interactive client, no credential | `initialize` → 200, later paid call → 401 with no way to sign in | `initialize` → 401 + challenge, OAuth starts at connect |
| CLI, SDK or script: no key, no `initialize` | `tools/list`, `get_sources` → 200 | unchanged |
| Any request carrying a credential | normal | unchanged |
| Agent-readiness scanner doing a full anonymous handshake | worked on `/mcp` and the aliases | works on `/.well-known/mcp` and `/.well-known/mcp.json` |

The server card's `authentication.resource` was changed from the bare origin to `https://worldmonitor.app/mcp` so it equals the `resource` in the document the challenge points at; a parity test asserts the two stay equal.

Verified in production after deploy: unauthenticated `initialize` returns `401` with the id echoed on apex, `www` and `api`; keyless `tools/list` returns `200` with 75 tools; keyless `get_sources` returns `200`; both aliases still serve an anonymous `initialize`; `scripts/mcp-live-smoke.mjs` passes 92 of 92. The user confirmed the connectors now sign in.

## Why This Works

`initialize` is the one request every interactive MCP client must open with, and it is the request hosted connectors use to classify a server. Answering it with a spec-correct `401` plus `WWW-Authenticate` hands the connector an authorization server at the only moment it is listening for one. Linear, Sentry and Notion all answered the handshake this way when probed during this work (2026-09-18).

Stateless callers never send `initialize`, so scoping the challenge to that single method leaves every shipped CLI and SDK version untouched. Request sizes in telemetry supported the split before it shipped: `grok-connectors-manager` sent 13 initialize-sized requests paired with 14 small ones, and `Cursor/1.0.0` about one to two.

Echoing the request id matters as much as the status code. An `id: null` refusal is what made strict SDK clients hang until timeout in #4937, because the transport cannot correlate the response to the pending request.

## Prevention

- **When a client "cannot authenticate", first check how the unauthenticated `initialize` is answered**, before touching OAuth metadata, registration or redirect handling. `curl -X POST …/mcp` with an `initialize` body and no credentials should return `401` with `WWW-Authenticate`. A `200` there explains a dead sign-in button on its own.
- **Read the authenticated share per client before theorizing.** One APL query over `wm_api_usage` grouped by `user_agent` and `auth_kind` separated "one client is broken" from "every client except one is broken" in minutes.
- **Before tightening an anonymous surface, find out who calls it without credentials.** Grep the repo's own published clients for the endpoint constant and check telemetry for their user agents. Here that turned a blanket challenge into a one-method challenge.
- **Treat a large test blast radius as design feedback.** 43 tests across 16 files needing migration meant the change altered a contract many callers relied on.
- **Do not send Python's default user agent at production when validating.** Cloudflare bot-filters it and the probe reports failures the server never produced; use curl or a browser-like agent.
- Tests that pin the behavior: `tests/mcp-transport-challenge.test.mjs` (the challenge per host and path, the id echo, JSON body, keyless `tools/list` answering and `get_sources` never hitting the auth wall, aliases still anonymous, `GET` and `OPTIONS` untouched), and the `probeConnectChallenge` and `probeStatelessKeylessList` probes in `scripts/mcp-live-smoke.mjs`, which run against production every 15 minutes.
- **Expect one red smoke run on merge.** "MCP Live Smoke" also runs on push to `main` when its script changes, and that run starts before the production deploy finishes, so a PR that changes both the smoke and the behavior it checks fails once ("expected HTTP 401, got 200") and passes on the deployment-status run minutes later. Re-running the failed job after deploy clears it.

## Related

- [MCP OAuth registration rejected every hosted MCP client except Claude](mcp-oauth-dcr-rejected-hosted-mcp-clients.md): the registration-side half of the same report (#8303). That fix was necessary and not sufficient.
- #8305 (redirect allowlist, `iss`), #8309 (path-scoped RFC 9728 metadata), #8321 (this fix), #8327 (docs method lists synced with the handler; open at the time of writing).
- #4937 (an `id: null` refusal hangs strict SDK clients), #4698 (anonymous discovery design).
- [MCP crawler GET and method-aware canonical redirects](mcp-crawler-get-and-method-aware-canonical-redirects.md): introduced the alias-versus-transport path split for caching reasons; this fix gives the same split a second, auth reason.
- #8328: the next failure the same strict hosts hit once sign-in worked. Every `tools/call` was rejected with `-32600` because tools advertise an `outputSchema` and returned no `structuredContent` (fix opened in #8330, unmerged at the time of writing).
- #4840 (open): carry `WWW-Authenticate` `resource_metadata` on API entry-point 401s. `/mcp` now does this; the non-MCP entry points remain.
