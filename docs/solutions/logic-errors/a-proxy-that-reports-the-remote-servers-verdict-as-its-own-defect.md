---
title: A proxy that reports the remote server's verdict as its own defect
date: 2026-10-14
last_updated: 2026-10-20
category: logic-errors
module: mcp-proxy
problem_type: logic_error
component: service_object
symptoms:
  - "Sentry WORLDMONITOR-172 `Initialize error: MCP server rejected request` regrew to 226 events / 69 IPs in two weeks after the 401/403 exclusion shipped"
  - "Every event targets one remote host; the Axiom audit log shows one browser IP with `header_names: []` (a panel saved without its key)"
  - "Sentry WORLDMONITOR-17A `API 504: /api/mcp-proxy` at `error` level from the browser while the server already captured `MCP server timed out` at `warning`"
  - "WORLDMONITOR-17A kept firing from releases that contained the #9140 marker skip; the live `Access-Control-Expose-Headers` on api.worldmonitor.app did not list `X-Wm-Upstream-Timeout`"
root_cause: logic_error
resolution_type: code_fix
severity: medium
related_components: [tooling]
tags: [sentry, mcp-proxy, upstream-outcome, json-rpc, canary, double-report, exposed-headers, axiom-audit-log, triage, cloudflare-worker, cors-parity]
---

# A proxy that reports the remote server's verdict as its own defect

## Problem

`api/mcp-proxy.ts` relays a caller-chosen remote MCP server. Two of that server's outcomes reached Sentry as if the proxy had failed: a JSON-RPC `error` object answered on HTTP 200, and the proxy's own 504 relaying the remote's timeout. Both are the remote server's verdict on the caller's request, not a WorldMonitor defect, and together they produced the two noisiest edge issues of the 2026-10-14 triage. Fixed in #9140. The 504 half only took effect with #9453, because a third CORS layer hid the marker header (see "Third regrowth" below).

## Symptoms

- WORLDMONITOR-172 had already been triaged once: HTTP 401/403 from the remote were excluded as "the caller's credential". It regrew anyway because the remote answered `{"jsonrpc":"2.0","error":{...}}` with HTTP **200**, which `proxyFailureFor()` still reported.
- Every one of the 226 events named `search.parallel.ai/mcp`. The Sentry `user` tag showed 69 AWS IPs, which looked like a fleet of agents; the Axiom audit log told a different story.
- WORLDMONITOR-17A: `premium-fetch.reportServerError` captured `API 504: /api/mcp-proxy` at `error` level from the finance dashboard. The proxy had already captured the same incident server-side as `MCP server timed out` at `warning`.

## What Didn't Work

- **Reading Sentry alone.** The Sentry events carry `target_host` in `extra` and an IP in the `user` tag, but no header names, no upstream status, and not the JSON-RPC body. The IPs were Vercel-side addresses, not the caller. Only the proxy's structured audit log (`[mcp-proxy] { event: 'mcp_proxy_call', ... }` in the Axiom dataset `vercel_platform_logs`, the one Vercel route whose logs are retained there) had `ip`, `header_names`, `status` and `upstream_status`. Aggregating 400 rows showed one IP, one referer, `header_names: []`, 98% HTTP 200 and 2% 422.
- **Assuming a bad key.** A live probe of the remote with a bogus `x-api-key` answered HTTP 401, which the existing exclusion already covers. A keyless `initialize` and `tools/call` both succeeded. So the rejections were the remote's free-tier quota answering as a JSON-RPC error, which the proxy had no way to classify.
- **Treating the browser 504 as an origin outage.** The 504 is minted by the proxy itself (`failure.isTimeout ? 504 : 422`), and the Axiom row for it has `upstream_status: null`. It never came from our origin.

## Solution

1. **Carry the remote's JSON-RPC verdict on the error and stop reporting it.** `McpProxyUpstreamError` accepts `upstreamRpcError`, sets `upstreamRpcRejected` and a bounded integer `upstreamRpcCode` (`api/mcp-proxy.ts:260`). All eight `rejected request` throw sites go through one `upstreamRpcRejection(step, error)` helper. `proxyFailureFor().report` is false for a JSON-RPC rejection, in the same clause as the 401/403 exclusion (`api/mcp-proxy.ts:306-307`). The caller's 422 body is unchanged.
2. **Keep the signal in the audit log instead.** `logProxyCall` gains `upstream_rpc_code`, so a proxy-wide regression (every remote answering `-32602` to our `initialize`) is still visible in Axiom even though it no longer pages.
3. **Mark the relayed timeout so the browser does not re-report it.** The proxy's timeout 504 carries `X-Wm-Upstream-Timeout: 1` (`api/mcp-proxy.ts:1118`); the header is exposed in every CORS layer: `api/_cors.js`, `server/cors.ts` and, since #9453, the `api-cors-preflight` Worker (`workers/api-cors-preflight/src/index.js:58`); `reportServerError` returns early on it (`src/services/premium-fetch.ts:87`), next to the existing `X-Wm-Session-Degraded` and `X-RateLimit-Mode: degraded` skips. An unmarked 504 on the same path is still reported, pinned by test.

```ts
// api/mcp-proxy.ts — the remote answered; its JSON-RPC error is its verdict, not ours
report: !(error instanceof McpProxyUpstreamError
  && (UPSTREAM_CALLER_REJECTIONS.has(error.upstreamStatus) || error.upstreamRpcRejected)),
```

## Why This Works

The proxy's Sentry contract is "report proxy defects". A remote MCP server has three ways to say no to a caller: an HTTP 4xx, a JSON-RPC `error` on 200, or a timeout. The first exclusion handled only the HTTP shape, so the JSON-RPC shape, which is how MCP servers express quota, unknown tool, and invalid params, still looked like a defect. Classifying on the error's provenance (`upstreamRpcRejected`, `upstreamStatus`) rather than its message keeps the exclusion narrow: a transport failure, an SSE stream with no result, or a thrown non-`McpProxyUpstreamError` still reports.

The 504 double-report is the same class one hop later: the proxy correctly recorded the remote's timeout at `warning`, then the browser canary, which cannot know who minted a 504, promoted it to an origin `error`. A fixed-value response header is the only channel that survives the cross-origin hop, which is why `Access-Control-Expose-Headers` is part of the fix and not an afterthought.

## Second regrowth: HTTP 429

The exclusion above still missed a shape. Two days after #9140 deployed, WORLDMONITOR-172 regrew as `tools/call failed: HTTP 429`: 1,019 events on 2026-10-16, all against `search.parallel.ai`, with no distinct Sentry users. A remote that rate-limits a keyless caller can answer with an HTTP 429 instead of a JSON-RPC error on 200. The set of excluded statuses is now `UPSTREAM_CALLER_REJECTIONS = [401, 403, 429]`. Upstream 5xx, 404 and 400 still report, pinned by `tests/mcp-proxy.test.mjs`, and the audit row keeps `upstream_status: 429`.

## Third regrowth: the Worker replaces Expose-Headers

WORLDMONITOR-17A kept firing after #9140 deployed: 7 more `API 504: /api/mcp-proxy` events from 2026-10-14 to 2026-10-20. The proxy was doing its part:

- **The events came from builds that had the skip.** `git merge-base --is-ancestor <#9140 commit> <event release>` was true for every event after 2026-10-14. The browser-side check in `premium-fetch` was deployed and still did not fire.
- **The server set the marker.** Each Sentry event matched an Axiom `wm_api_usage` row for `/api/mcp-proxy` with status 504, to the second. Each took 3.5 to 21 s, which is the proxy's own timeout path. That path is the only 504 the handler mints, and it always sets `X-Wm-Upstream-Timeout: 1` (`api/mcp-proxy.ts:1117-1118`).
- **The browser could not read it.** A live `POST https://api.worldmonitor.app/api/mcp-proxy` with `Origin: https://finance.worldmonitor.app` returned an `Access-Control-Expose-Headers` value that did not contain `X-Wm-Upstream-Timeout`. Without that, `res.headers.get('X-Wm-Upstream-Timeout')` returns `null` cross-origin, so `reportServerError` reported every relayed timeout.

The served list came from neither CORS helper. It came from the Cloudflare Worker `workers/api-cors-preflight/src/index.js`, which is bound to `api.worldmonitor.app/*`. The Worker keeps its own hardcoded `EXPOSE_HEADERS` and replaces the function's header on every non-public `/api/` response. #9140 updated `api/_cors.js` and `server/cors.ts` but not the Worker. Nothing in CI caught it, for two reasons:

- `tests/cors-fail-closed.test.mts` already included the Worker as a CORS surface, but it asserted named headers one suite at a time (`X-Billing-Verification`, `X-RateLimit-Mode`, the IETF RateLimit fields). No suite named `X-Wm-Upstream-Timeout`.
- The Worker's own `workers/api-cors-preflight/index.test.mjs` compared against a third hardcoded copy of the list. It runs only in `deploy-worker.yml`, on pushes to `main` that touch the Worker's paths. A PR that changes `api/_cors.js` never runs it.

The same gap hid `Location` from browser callers on `api.worldmonitor.app`. `Location` is the poll URL on the gateway's 202 Accepted async jobs (#4810), and only `server/cors.ts` listed it.

#9453 fixed this. The Worker's list now includes `X-Wm-Upstream-Timeout` and `Location`, and `api/_cors.js` includes `Location`. A new suite, `every CORS surface exposes the same header set` (`tests/cors-fail-closed.test.mts:235`), requires all four surfaces (`server/cors.ts`, `api/_cors.js` private and public, the Worker) to expose exactly the set `api/_cors.js` does. It runs in `unit-shards` on every PR, and it failed on both gaps before the fix. After `deploy-worker.yml` ran on the merge commit, the same live probe listed both headers.

## Prevention

- **When excluding an upstream outcome from Sentry, enumerate every shape that outcome takes.** For MCP: HTTP status, JSON-RPC `error`, timeout. Excluding one shape and resolving the issue just defers the regrowth.
- **Every captured upstream outcome must have an audit-log twin.** If a class of failure stops reporting, add the discriminating field (`upstream_status`, `upstream_rpc_code`) to the structured log in the same change, and pin it with a test that reads the log entry (`tests/mcp-proxy.test.mjs` "audits the JSON-RPC code of an upstream rejection").
- **Diagnose proxy issues from the Axiom audit row, not the Sentry event.** `vercel_platform_logs`, `message contains '<target host>'`, regex the `[mcp-proxy] {...}` object literal for `ip`, `header_names`, `status`, `upstream_status`. A single IP with empty `header_names` is a keyless panel, not a fleet.
- **Probe the remote before assuming the failure mode.** One `curl` with no key, one with a bogus key, tells you which shape the remote uses for each refusal.
- **A browser-side 5xx canary needs a way to tell relayed from origin.** Any new route that mints a 5xx on behalf of an upstream should set a fixed marker header, expose it in every CORS layer, and skip it in `reportServerError`, following the three existing skips. There are three layers: `api/_cors.js`, `server/cors.ts`, and the `api-cors-preflight` Worker. The Worker's list is the one browsers on `api.worldmonitor.app` actually see, and the set-equality suite in `tests/cors-fail-closed.test.mts` fails until all three match.
- **When a fix ships but the issue keeps firing, find which layer drops the signal.** Check that the event's `release` contains the fix (`git merge-base --is-ancestor`). Match the server's audit rows to the Sentry events. Then probe production and print the full response header. Truncating the printed header nearly hid the missing entry during this triage.

## Related Issues

- #9140 (this fix), #9453 (Worker Expose-Headers and the CORS set-equality test), #9127 (same triage, intel-history timeout level), #9136 (same triage, checkout `Invalid JSON` classification)
- `docs/solutions/logic-errors/a-suppression-layer-above-beforesend-cannot-see-your-ownership-tag.md` for the browser-side suppression precedent
- `docs/solutions/security-issues/relay-rss-proxy-fetched-allowlisted-hosts-without-vetting-dns.md` for the proxy's other failure class (SSRF), kept reporting on purpose
