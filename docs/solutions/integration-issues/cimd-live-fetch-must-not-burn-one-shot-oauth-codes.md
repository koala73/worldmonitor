---
title: "A live client-metadata fetch must not burn a one-shot OAuth code or sign users out"
date: 2026-10-17
category: integration-issues
module: "MCP OAuth 2.1 authorization server (api/oauth)"
problem_type: integration_issue
component: authentication
symptoms:
  - "POST /oauth/token answered 503 with Retry-After during a vendor outage, and the retry returned 400 invalid_grant because the code was already deleted"
  - "A vendor 403, HTML challenge page, or truncated JSON body at refresh time answered 401 invalid_client, which makes MCP clients drop a working connection"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [mcp, oauth, cimd, client-id-metadata-document, token-endpoint, getdel, retryable-errors, vscode]
---

# A live client-metadata fetch must not burn a one-shot OAuth code or sign users out

## Problem

Client ID Metadata Document support (#9244, PR #9280) made client validation depend on a network fetch: a URL `client_id` resolves by fetching the vendor's JSON document (`api/oauth/_client-metadata.js`). The token endpoint called that validation after it had already consumed the authorization code, and the fetcher treated several temporary vendor failures as permanent.

## Symptoms

- Code exchange during a vendor blip returned `503` with `Retry-After: 5`, but the code was gone, so the retry returned `invalid_grant` and the user had to authorize again. The independent Codex review reproduced this against the real `tokenHandler`.
- VS Code serves its document as `no-store`, so every one of its code exchanges refetches it, and this path does not need a cache expiry to be reached.
- A `403`, an HTML bot-challenge page, or a truncated `application/json` body was classified as an invalid document. At refresh that answers `401 invalid_client`, which MCP clients treat as "connection revoked".

## What Didn't Work

- **Keeping DCR's order and only resolving earlier for everyone.** Moving `checkClientExists` before `GETDEL` for all clients changed DCR's error precedence: an unknown DCR client with a bad code started returning `401 invalid_client` instead of `400 invalid_grant`, and `tests/oauth-token.test.mjs` ("rotating identifiers cannot bypass the IP limit") went red. The issue required DCR to stay unchanged, so the earlier resolve is gated on the `client_id` being a URL.
- **Treating only `429` and `5xx` as retryable.** That was the first cut. A vendor's edge returning `403` or a challenge page from Vercel's egress is just as temporary, and the cost of misclassifying it (every user of that client signed out) is far higher than a few extra `503`s.

## Solution

Resolve a CIMD client before consuming the code; keep DCR's original order (`api/oauth/token.ts`, `handleAuthorizationCode`):

```ts
const cimdClient = isClientMetadataDocumentId(clientId);
if (cimdClient) {
  const clientCheck = await checkClientExists(deps, clientId);
  if (clientCheck) return clientCheck;   // 503 on a vendor blip, code untouched
}
codeData = await deps.redisGetDel(`oauth:code:${code}`);
// ... client_id / redirect_uri / PKCE checks ...
if (!cimdClient) {
  const clientCheck = await checkClientExists(deps, clientId);
  if (clientCheck) return clientCheck;
}
```

Only a missing document is permanent (`fetchDocument` in `api/oauth/_client-metadata.js`):

```js
if (resp.status === 404 || resp.status === 410) throw new ClientMetadataError('document_not_found');
if (resp.status !== 200) throw new ClientMetadataError('document_fetch_failed', true);
// non-JSON content type and JSON.parse failure are both thrown with transient = true
```

The refresh path already restored the consumed refresh token on a failed client check (`restoreRefreshAttempt`, stage `client-validation`), so once these failures are transient, `checkClientExists` answers `temporaryAuthFailure()` (503) and the same refresh token works on retry.

## Why This Works

A one-shot artifact (a `GETDEL`ed code, a consumed nonce) can only be spent once, so any check that can fail temporarily has to run before it, or the "retryable" answer is a lie. Before CIMD, client validation was a Redis read whose failure mode was the same storage the code lived in; the CIMD fetch added a third party whose outages are independent of ours. Classifying fetched-document failures by what the server can prove (a `404`/`410` says the document is gone; anything else might be the network) keeps a vendor's bad minute from becoming a forced sign-out.

## Prevention

- When a validation step gains a network dependency, find every one-shot resource consumed before it (`GETDEL`, nonce consumption, single-use grants) and move the validation ahead of it, or restore the resource on a transient failure, as refresh already does.
- Default fetched-dependency failures to retryable; make an outcome permanent only when the response proves it.
- Pin the behavior with tests that drive the real handler: `tests/oauth-cimd.test.mjs` has "a vendor outage at code exchange leaves the code redeemable on retry" and "a vendor 403 or HTML challenge during refresh is retryable and keeps the token" (the latter also covers a truncated JSON body).
- Two related CIMD rules from the same review: the consent warning must key on whether the redirect in use is loopback (`clientDisplayInfo(client, redirectUri)`), not on whether the document lists only loopback callbacks, because any local app can send a published `client_id` with a loopback redirect. And `Cache-Control` values may be quoted (`max-age="300"`, RFC 9111); strip the quotes before parsing, or caching silently turns off.
- The same rule applied to the consent POST and `authorize-pro` in #9285: the consent POST answers a transient CIMD failure with a fresh nonce (`retryConsent`), and `authorize-pro` reads `oauth:nonce:<n>` without consuming it and resolves a CIMD client before either GETDEL.

## Related Issues

- #9244 and PR #9280: CIMD support
- [MCP OAuth registration rejected every hosted MCP client except Claude](mcp-oauth-dcr-rejected-hosted-mcp-clients.md): the DCR callback allowlist that CIMD sits beside
- GHSA-f6gj refresh-family revocation: the restore and finalize contract in `api/oauth/_refresh-recovery.ts` that the refresh fix relies on
