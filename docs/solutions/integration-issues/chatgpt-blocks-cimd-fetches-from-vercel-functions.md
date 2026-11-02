---
title: "chatgpt.com answers every CIMD fetch from Vercel Functions with a 403 page, so ChatGPT and Codex could not connect"
date: 2026-10-18
category: integration-issues
module: "MCP OAuth 2.1 authorization server (api/oauth)"
component: authentication
problem_type: integration_issue
symptoms:
  - "After #9280 advertised client_id_metadata_document_supported, every ChatGPT and Codex consent page said 'The client could not be verified right now'"
  - "The same document URL returned 200 JSON from a laptop and from Vercel Sandbox in iad1 and fra1"
root_cause: incomplete_setup
resolution_type: code_fix
severity: high
tags: [mcp, oauth, cimd, chatgpt, codex, vercel-functions, egress, waf, snapshot-fallback]
---

# chatgpt.com answers every CIMD fetch from Vercel Functions with a 403 page

## Problem

#9280 made WorldMonitor advertise Client ID Metadata Documents. ChatGPT and Codex choose CIMD when it is advertised and do not fall back to registration, so every new connection from them depended on the server fetching `https://chatgpt.com/oauth/client.json` (or `/oauth/codex/client.json`). From Vercel Functions that fetch always fails, so neither client could connect. The 14 other listed clients worked. Existing DCR connections kept refreshing.

## Symptoms

- `GET /oauth/authorize?client_id=https://chatgpt.com/oauth/client.json&...` rendered "Service Unavailable: The client could not be verified right now" on every attempt, in `fra1` and `iad1`.
- Production recorded nothing about why: `resolveOAuthClient` collapsed every fetch failure to `{reason: 'document_fetch_failed', transient: true}`.

## What Didn't Work

- **Assuming an IP block and testing from cloud egress.** `curl` with the production `Accept` and `User-Agent` headers returned 200 from a laptop. A Vercel Sandbox (`create_sandboxes_v4`) in `iad1` and `fra1` also got 200 with `server: cloudflare`. Sandbox egress is not Vercel Functions egress, so it cannot reproduce a block on the functions.
- **Guessing at encodings.** ChatGPT serves `br`, but so do Claude, Cursor, Grok, and Notion, which all worked.

## Solution

1. **Log what the vendor sent.** `fetchDocument` attaches `status`, `content-type`, `cf-mitigated`, `cf-ray`, `server`, the first 200 characters of a rejected body, or the thrown fetch error. `resolveOAuthClient` logs it as `[oauth/cimd] client document unusable`. One preview request then showed the cause: `status: 403`, `text/html`, `cf_ray: null`, `server: null`, body starting `<html> <head> ... <style global>`. That is a block page, and the missing `cf-ray` and `server` headers mean it is not the normal Cloudflare response.
2. **Fall back to a vetted copy.** `api/oauth/_client-metadata-snapshots.js` holds each exact listed document, captured from its live URL and trimmed to the fields `validateDocument` reads. On a *retryable* failure only, `resolveOAuthClient` validates and returns the snapshot. It never caches it, so the live document is tried on every request. A live `404`/`410` or an invalid live document still rejects, so a vendor withdrawing a client or dropping a callback takes effect. Per-connector documents (Vercel Connect) have no snapshot.

Verified on preview `dpl_AfFmHAKCUv99wTCQT7Z9UFMuBZ33`: ChatGPT and Codex consent pages render, and the log line shows `"fallback":"snapshot","status":403`.

## Why This Works

The trusted list already pins exact URLs, so the snapshot is the document that was reviewed when the URL was listed; using it when the vendor's edge refuses us grants nothing the list did not. Keeping the live fetch first, and honouring a definitive answer from it, keeps the vendor in control whenever it can be reached.

## Prevention

- Before advertising a capability that makes the server fetch third-party URLs, probe each target **from the function runtime that will make the call** (a preview deployment), not from a laptop or a sandbox. Here the per-client probe (`GET /oauth/authorize` for every listed URL, spaced under the 10/min limit) found the failure within minutes of looking.
- Never collapse a third-party failure into one reason without logging status, content type, edge headers, and a body prefix. "Retryable" told the caller what to do but told us nothing about the cause.
- `tests/oauth-cimd.test.mjs` pins it: "every listed document has a snapshot that matches the live capture and validates", "ChatGPT connects end to end while its document is blocked, and nothing is cached", and "a withdrawn or invalid live document is not overridden by the snapshot".

## Related Issues

- #9244, #9280 (CIMD support), #9285 (this fix)
- [A live client-metadata fetch must not burn a one-shot OAuth code](cimd-live-fetch-must-not-burn-one-shot-oauth-codes.md)
- [Barchart WAF challenge answers 202 and passes resp.ok](barchart-waf-challenge-answers-202-and-passes-resp-ok.md): another vendor edge that refuses server egress
