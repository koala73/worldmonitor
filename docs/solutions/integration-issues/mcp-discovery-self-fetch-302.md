---
title: "MCP discovery URLs returned a 302 when the handler's self-fetch of its own static files failed"
date: 2026-11-19
category: integration-issues
module: api/mcp/handler.ts
problem_type: integration_issue
component: tooling
severity: medium
symptoms:
  - "MCP Live Smoke: \"GET /mcp (crawler): expected 200, got 302 — Search Console reports this shape as \\\"cannot access\\\"\""
  - "MCP Live Smoke: \"GET /.well-known/mcp: expected 200, got 302\""
  - "The 302 carries x-vercel-id and no content-type; on 2026-11-19 it took 5,079 ms and the HEAD request about 350 ms later was 200"
root_cause: async_timing
resolution_type: code_fix
tags: [mcp, edge-bundle, self-fetch, server-card, discovery, mcp-live-smoke]
---

# MCP discovery URLs returned a 302 when the handler's self-fetch of its own static files failed

## Problem

`GET /mcp` (setup page or markdown guide) and `GET /.well-known/mcp` (server card) loaded their documents by fetching the deployment's own public URL. That request went through Cloudflare's apex→www redirect, and the fetch had a 5,000 ms timeout. When it failed, the handler answered with a 302 to the static file instead of the 200 that crawlers and the smoke test require. The live smoke caught this on 2026-09-04, 2026-11-04 and 2026-11-19, each in one isolated run.

## Symptoms

- One failed check in an otherwise green scheduled `MCP Live Smoke` run. The next request to the same URL succeeds, because the failure was never cached at module scope.
- The run's report artifact (`mcp-live-smoke-report.json` → `requests[]`) shows `status: 302` with an `elapsedMs` just over 5,000. It does not record `Location`.

## What Didn't Work

- Embedding all three documents as strings. The 99 KB server card, 84 KB of which is the `tools` list, put `api/mcp.ts` at 1,046,834 bytes gzip-9. That is over the 1,024,000 budget in `tests/edge-function-size.test.mjs` and about 1.7 KB under the 1 MiB Edge ceiling.
- Loosening or retrying the smoke check. That hides a real 302 that crawlers also see.

## Solution

PR #11046:

- `scripts/generate-mcp-discovery-documents.mjs` is a `npm run generate` step with `--check`. It writes `api/mcp/discovery-documents.generated.ts`, which contains the guide, the setup page, and the server card with `"tools": []`.
- `api/mcp/server-card-tools.ts` projects `TOOL_REGISTRY` into the card's `tools` list. `scripts/generate-public-product-facts.mjs` uses it to write the published card, and the handler uses it to rebuild the served card once per instance.
- The served card must equal `public/.well-known/mcp/server-card.json` byte for byte. That works because the product-facts generator emits canonical `JSON.stringify(card, null, 2)` and its domain-summary rewrite replaces one string value in place.
- Result: `api/mcp.ts` grows from 1,010,185 to about 1,021,500 bytes gzip-9.

## Why This Works

The documents never leave the function, so a cold instance needs no network to serve discovery and there is no 302 path left. Embedding the card without its tools avoids carrying a second copy of every tool description, which the registry already holds in the bundle.

## Prevention

- Do not fetch your own deployment from an Edge handler to read a static file. The fetch is a hidden dependency on the CDN, redirects and the static origin, and its failure path becomes the response.
- Measure `tests/edge-function-size.test.mjs` before embedding anything in `api/mcp.ts`. Headroom is about 2.5 KB after this change.
- A runtime projection shared with a generator must not throw on invariants only the generator enforces. `build:full` does not run `product:facts`, so a tool missing from `TOOL_CATEGORY_BY_NAME` can deploy. The projection leaves the category out, and the generator and `tests/mcp-domains.test.mjs` still reject the mismatch.
- Regression test: `tests/mcp-transport-conformance.test.mjs` "serves every discovery document when the deployment cannot be reached" rejects every asset fetch and requires 200 with the on-disk bodies.

## Related Issues

- `docs/solutions/performance-issues/zod-named-z-import-bloats-edge-bundle.md`: the same `api/mcp.ts` gzip budget.
- PR #11046
