---
title: "Codex's OAuth discovery probe was refused with 400 because rmcp sends a fixed 2024-11-05 MCP-Protocol-Version"
date: 2026-10-24
category: integration-issues
module: "MCP server transport auth (api/mcp/handler.ts)"
problem_type: integration_issue
component: authentication
severity: medium
symptoms:
  - "About 12,000 GET /mcp 400s a day in wm_api_usage, all anonymous codex-mcp-client 0.16x, header MCP-Protocol-Version 2024-11-05"
  - "Each GET arrived right after the same client's anonymous POST initialize got a 401"
  - "The 400 began on 2026-10-21 together with a spike of POST refusals, so it looked like part of the protocol-version incident"
root_cause: logic_error
resolution_type: code_fix
related_components:
  - testing_framework
  - documentation
tags:
  - mcp
  - oauth
  - rmcp
  - codex
  - rfc-9728
  - mcp-protocol-version
  - www-authenticate
---

# Codex's OAuth discovery probe was refused with 400 because rmcp sends a fixed 2024-11-05 MCP-Protocol-Version

## Problem

Codex checks whether an MCP server needs sign-in with the Rust SDK's OAuth discovery. That code sends a plain `GET` to the server URL with a hard-coded `MCP-Protocol-Version: 2024-11-05` header and looks for a `401` whose `WWW-Authenticate` names the protected-resource metadata. `/mcp` validated the version header before anything else and answered `400 -32600 Unsupported MCP-Protocol-Version`. Every Codex status check logged a protocol failure.

## Symptoms

- `wm_api_usage`, route `/mcp`, `method == 'GET'`, `status == 400`, `mcp_protocol_version == '2024-11-05'`: about 12,000 rows a day, every one `auth_kind == 'anon'` and `user_agent` `codex-mcp-client/0.16x`.
- Per IP the pattern was `POST initialize → 401`, then `GET /mcp → 400`.
- The rows started at 2026-10-21 12:00 UTC, the same moment as a spike of `POST` protocol-version refusals (fixed in #9563 and the follow-ups). That made the `GET` look like the same bug. It is a different client path.

## What Didn't Work

- **Reading the `2024-11-05` header as the client's protocol choice.** Codex's own repository (`openai/codex`) contains `2024-11-05` only in a test fixture, in `codex-rs/rmcp-client/src/auth_status.rs`. The value comes from the dependency, rmcp (`modelcontextprotocol/rust-sdk`): `discovery_get` in that repository's `crates/rmcp/src/transport/auth.rs` sets `MCP-Protocol-Version: 2024-11-05` on every OAuth discovery request, whatever version the client speaks.
- **Treating it as a sign-in outage.** It was not one. Replaying rmcp's request sequence against production showed the fallback still worked: `GET /mcp` gave 400, then the next candidate, `GET /.well-known/oauth-protected-resource/mcp`, gave 200 with the right `resource`. So `codex mcp login` was never blocked; it lost one hop and the direct pointer.
- **Answering 405 or the markdown guide instead.** An anonymous plain `GET /mcp` with a supported header got the guide (200), and an SSE `GET` got 405. Neither carries a challenge. rmcp's `probe_resource_endpoint_for_challenge` reads only a `401`'s `WWW-Authenticate`. Anything else just sends it to the well-known guesses.

## Solution

#9601: an anonymous plain `GET` on the transport that carries any `MCP-Protocol-Version` is treated as an OAuth discovery probe and gets the standard challenge. "Plain" means no `Last-Event-ID` and no `text/event-stream` Accept. The challenge is the same `401` and `WWW-Authenticate: Bearer realm="worldmonitor", resource_metadata=".../.well-known/oauth-protected-resource/mcp"` that an anonymous `initialize` gets. It is decided before the version gate, so the probe's unsupported `2024-11-05` no longer short-circuits it. In `api/mcp/handler.ts` the condition is `anonymousAuthProbe`:

```ts
const anonymousAuthProbe = req.method === 'GET'
  && protocolVersion !== null
  && !aliasRequest
  && !WELL_KNOWN_MCP_PATHS.has(requestPathname)
  && !hasCredentials(req)
  && !req.headers.get('last-event-id')
  && !clientAcceptsSse(req);
if (unsupportedProtocolVersion && req.method !== 'POST' && !anonymousAuthProbe) return rejectProtocolVersion();
// ...after resourceMetadataUrl is resolved:
if (anonymousAuthProbe) {
  usage.phase = 'auth';
  return authRequiredResponse(null, resourceMetadataUrl, corsHeaders);
}
```

These keep their current behaviour:

- Browsers and crawlers never send the header, so they still get the guide.
- A credentialed `GET` with an unsupported header is still a 400.
- The well-known paths still serve the server card.
- The product aliases are excluded on purpose. Their `GET` answer is a 308 from `www` to the apex. rmcp follows only same-origin redirects and turns a cross-origin one into a hard `CrossOriginRedirect` error. The old 400 lets its discovery continue.

Verified in production after deploy: replaying the probe gave `401` with the expected `resource_metadata`, a browser `GET /mcp` still returned `text/markdown`, and the `GET` rows moved from 400 to `auth_401`.

## Why This Works

RFC 9728 §5.1 has a protected resource advertise its metadata through the `resource_metadata` parameter of a `401` challenge. rmcp probes for exactly that before guessing well-known URLs. The server's job is to recognise the probe. The only marker that separates it from a person opening `/mcp` in a browser is the `MCP-Protocol-Version` header, which no browser sends. Recognising the probe has to happen before the version gate, because the probe's version is fixed and not one we support.

## Prevention

- **Read the client's dependency before reading a header as intent.** Find the request in the SDK the client depends on, not only in the client's own repository. Here the value lived in rmcp, and Codex's tree only had it in a test.
- **Replay the client's discovery sequence against production before calling it an outage.** A small script that issues the same `GET`s with the same headers (`/mcp`, then `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`) showed in seconds that sign-in still worked and only the first hop was wrong.
- **Check redirect origins on any path an SDK probes.** A cross-origin redirect is fatal to rmcp discovery, unlike a 4xx. Do not "fix" an alias probe by redirecting it to the apex.
- Tests that pin the behaviour, in `tests/mcp-transport-conformance.test.mjs`:
  - "challenges an anonymous MCP client probing GET /mcp, whatever version it names" (anonymous `2024-11-05` and `2025-11-25` probes get the 401 with the path-scoped `resource_metadata`; a credentialed probe keeps the guide; a credentialed unsupported version keeps the 400);
  - "rejects unsupported transport versions before dispatching a request" (its `GET` case now carries credentials).

## Related

- [Hosted MCP connectors could never sign in because the unauthenticated initialize answered 200](mcp-hosted-connectors-never-sign-in-when-initialize-answers-200.md): the connect-time challenge this probe complements. Its 2026-10-24 follow-up section covers the generic HTTP-library exemption (#9604).
- [MCP crawler GET and method-aware canonical redirects](mcp-crawler-get-and-method-aware-canonical-redirects.md): why a plain `GET /mcp` serves the guide, and the alias-versus-transport split this fix respects.
- [MCP OAuth registration rejected every hosted MCP client except Claude](mcp-oauth-dcr-rejected-hosted-mcp-clients.md): the registration half of hosted sign-in.
- #9563, #9566, #9567, #9578: the `POST` protocol-version refusals that started the same day and made this look like the same bug.
