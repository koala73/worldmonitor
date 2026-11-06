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
- Treating it as clock skew or nonce replay. Those produce different refusal reasons and do not depend on argument order.

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

Repeated-key order is not meaningful to any WorldMonitor handler. Once the canonical form sorts values, any reordering a proxy applies produces the same canonical bytes on both sides. Values stay inside the hash, so tampering is still detected.

## How It Was Proven

Production behaviour was tested with a signed-probe oracle, because the edge's rewrite cannot be seen from the repo:

1. Pull the production signing secret into the scratchpad (`vercel link` + `vercel env pull --environment=production`). Never print it, and delete it afterwards.
2. Sign requests for a fake userId. `insufficient_entitlement` means the signature verified and only the entitlement check refused. `invalid_internal_mcp_signature` means the signature did not match.
3. Vary one dimension at a time:
   - 1–3 alphabetical symbols verified.
   - 4 or more unsorted symbols failed through `api.`.
   - Every case verified through `www.`.
4. Sign candidate rewrites of the sent URL. Only a signature over the value-sorted query verified against the `api.` origin, which identifies the edge's rewrite.

After deploy, a `get_stock_research` `history` call with five unsorted symbols (NVDA, AAPL, TSLA, AMZN, MSFT) returned data through the hosted connector.

## Prevention

- Canonicalise a query fully, by key and by value, before computing any signature, cache key or dedupe hash. Assume a proxy may reorder it.
- When a signature check fails only for some argument shapes, compare `api.` with `www.` first. That splits edge rewrites from code drift in one probe.
- Keep regression tests that deliver the request in a different order from the one that was signed.

## Related

- `docs/solutions/integration-issues/apierror-400-reaches-mcp-as-internal-error.md`: a different MCP dispatch failure that also hid behind a generic error.
