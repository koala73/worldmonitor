---
title: Cloudflare on api.worldmonitor.app sorts query values, so a key-only canonical query broke the internal MCP signature
date: 2026-11-07
category: integration-issues
module: mcp internal hmac
problem_type: integration_issue
component: authentication
symptoms:
  - "Sentry WORLDMONITOR-1CJ: Pro MCP tool calls fail with invalid_internal_mcp_signature (401)"
  - "get_stock_research history with symbols in non-alphabetical order fails; the same call with 1-3 alphabetical symbols succeeds"
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components:
  - mcp gateway
  - cloudflare edge
tags: [mcp, hmac, signature, cloudflare, query-string, canonicalization, repeated-params]
---

# Cloudflare on api.worldmonitor.app sorts query values, so a key-only canonical query broke the internal MCP signature

## Problem

The MCP server signs each downstream Pro data fetch with an HMAC over a canonical form of the request (`server/_shared/mcp-internal-hmac.ts`). The downstream origin is `https://api.worldmonitor.app`. Cloudflare in front of that host sorts the query string, including the values of a repeated key, before the request reaches Vercel. The canonicaliser sorted entries by key only, with a stable sort, so it kept the caller's order of repeated values. The signer hashed `symbols=NVDA&symbols=AAPL`, the verifier hashed `symbols=AAPL&symbols=NVDA`, and the signature failed.

Any Pro MCP call with a repeated query parameter whose values were not already sorted failed for every user.

## Symptoms

- Sentry WORLDMONITOR-1CJ: `invalid_internal_mcp_signature` from the gateway's internal-MCP verifier.
- Failures depended on argument order. One symbol, or symbols already in alphabetical order, verified.

## What Didn't Work

- Reading the code alone. The signer and verifier import the same `canonicalQueryString`, so a pure code review shows no drift. The difference comes from a proxy outside the repo.
- Treating it as clock skew or nonce replay. Neither depends on argument order. The gateway answers every failure with the same 401 body (`invalid_internal_mcp_signature`); the specific reason (`internal_mcp_ts_window`, `internal_mcp_sig_mismatch`, `internal_mcp_replay`) is recorded only in the gateway's usage telemetry (`server/gateway.ts`).

## Solution

Sort entries by key, then by value (PR #10264):

```ts
// before: key-only stable sort keeps the caller's order of repeated values
entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

// after: key, then value — matches what the edge delivers
entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
```

Already-sorted queries produce the same bytes as before, so existing signatures stay valid.

The regression test in `tests/mcp.test.mjs` signs an unsorted request, delivers it edge-sorted with the gateway's `rpc=` echo, and asserts that it verifies. A second request with a changed value set must still fail with `signature_mismatch`. The test fails on the old sort.

## Why This Works

Once the canonical form sorts values, a proxy that reorders them produces the same canonical bytes on both sides. The hash still detects a changed value set, but no longer binds the order of a repeated key's values. That is safe for the MCP signer because the parameters it repeats (such as `symbols`) are sets. A handler that reads only the first value of a key (for example `limit_per_symbol`) is order-sensitive. The MCP server sends those keys once, so their order is never in play.

## How It Was Proven

Production behaviour was tested with a signed-probe oracle, because the edge's rewrite cannot be seen from the repo:

1. Pull the production signing secret into the scratchpad (`vercel link` + `vercel env pull --environment=production`). Never print it, and delete it afterwards.
2. Sign requests for a fake userId, each with a fresh nonce, and send each within the 30-second timestamp window. `insufficient_entitlement` means the signature verified and only the entitlement check refused. `invalid_internal_mcp_signature` alone does not prove a mismatch, because an expired timestamp, a malformed header and a reused nonce return the same body. Fresh nonces and timestamps do not rule out a malformed header. For each failed probe, either confirm `internal_mcp_sig_mismatch` in usage telemetry, or run a control with the same signer and header format that verifies. Here, sorted symbols and the `www.` host were that control.
3. Vary one dimension at a time:
   - 1–3 alphabetical symbols verified.
   - 4 or more unsorted symbols failed through `api.`.
   - Every case verified through `www.`.
4. Sign candidate rewrites of the sent URL. Only a signature over the value-sorted query verified against the `api.` origin, which identifies the edge's rewrite.

After deploy, a `get_stock_research` `history` call with five unsorted symbols (NVDA, AAPL, TSLA, AMZN, MSFT) returned data through the hosted connector.

## Prevention

- Assume a proxy in front of `api.worldmonitor.app` may reorder repeated query values. Sort values in a signature, cache key or dedupe hash only for keys whose values form a set. If the order of a repeated key's values carries meaning, send it in a form a reorder cannot change, such as a single comma-joined value.
- When a signature check fails only for some argument shapes, compare `api.` with `www.` first. That splits edge rewrites from code drift in one probe.
- Keep regression tests that deliver the request in a different order from the one that was signed.

## Related

- `docs/solutions/integration-issues/apierror-400-reaches-mcp-as-internal-error.md`: a different MCP dispatch failure that also hid behind a generic error.
