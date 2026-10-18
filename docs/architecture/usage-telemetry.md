# Usage telemetry (Axiom)

Operator + developer guide to the gateway's per-request usage telemetry pipeline.
Implements the requirements in `docs/brainstorms/2026-04-24-axiom-api-observability-requirements.md`.

---

## What it is

Every inbound API request that hits `createDomainGateway()` emits one structured
event to Axiom describing **who** called **what**, **how it was authenticated**,
**what it cost**, and **how it was served**. Deep fetch helpers
(`fetchJson`, `cachedFetchJsonWithMeta`) emit a second event type per upstream
call so customer × provider attribution is reconstructible.

It is **observability only** — never on the request-critical path. The whole
sink runs inside `ctx.waitUntil(...)` with a 1.5s timeout, no retries, and a
circuit breaker that trips on 5% failure ratio over a 5-minute window.

## What you get out of it

Two event types in dataset `wm_api_usage`:

### `request` (one per inbound request)

| Field              | Example                                   | Notes                                        |
|--------------------|-------------------------------------------|----------------------------------------------|
| `event_type`       | `"request"`                               |                                              |
| `request_id`       | `"req_xxx"`                               | from `x-request-id` or generated             |
| `route`            | `/api/market/v1/analyze-stock`            |                                              |
| `domain`           | `"market"`                                | strips leading `vN` for `/api/v2/<svc>/…`    |
| `method`, `status` | `"GET"`, `200`                            |                                              |
| `duration_ms`      | `412`                                     | wall-clock at the gateway                    |
| `req_bytes`, `res_bytes` |                                     | `res_bytes` is null when Content-Length is absent (chunked/SSE); never coerce missing → 0 (#8403) |
| `rpc_method`, `tool_name` | `"tools/call"`, `"get_market_data"` | MCP only (#8403). Served JSON-RPC methods only (`_unregistered` otherwise) + registry-bounded tool; null on REST and on MCP rows that never parsed a body |
| `customer_id`      | Clerk user ID, org ID, enterprise slug, or static `widget` label | `null` only for anon                |
| `principal_id`     | user ID or **hash** of API/widget key     | never the raw secret                         |
| `auth_kind`        | `clerk_jwt` \| `user_api_key` \| `enterprise_api_key` \| `widget_key` \| `mcp_oauth` \| `anon` | MCP OAuth bearer (`api/mcp`) is distinct from dashboard `clerk_jwt` |
| `tier`             | `0` free / `1` pro / `2` api / `3` enterprise | `0` if unknown                          |
| `cache_tier`       | `fast` \| `medium` \| `slow` \| `slow-browser` \| `static` \| `daily` \| `no-store` | only on 200/304 |
| `ip`                 | `"203.0.113.7"`                         | Cloudflare client IP only when the edge-proof header is valid; otherwise Vercel's peer IP. IP-scoped endpoint budgets reject unproven `cf-connecting-ip` with 403 (`X-RateLimit-Mode: edge-proof`) rather than sharing a PoP bucket — see `scripts/cloudflare-edge-proof-rule.mjs` for the Transform Rule expression (#8402). |
| `country`            | `"US"`                                  | Cloudflare client country only when edge transit is proven; otherwise Vercel connection country |
| `ip_city`, `ip_region` | `"Johannesburg"`, `"WC"`            | Vercel connection/edge geography, not verified client location |
| `execution_region`   | `"iad1"`                                | Vercel execution region                      |
| `execution_plane`  | `"vercel-edge"`                           |                                              |
| `origin_kind`      | `api-key` \| `oauth` \| `browser-same-origin` \| `browser-cross-origin` \| `mcp` \| `null` | Gateway rows use `deriveOriginKind()` from request headers. Direct MCP emission (`emitMcpRequestEvent` / mcp-proxy) sets `mcp` explicitly — not via `deriveOriginKind()`. `internal-cron` exists in the type for upstream/future use |
| `ua_hash`          | SHA-256 of the UA                         | hashed so PII doesn't land in Axiom          |
| `sentry_trace_id`  | `"abc123…"`                               | join key into Sentry                         |
| `reason`           | `ok` \| `origin_403` \| `rate_limit_429` \| `rate_limit_429_endpoint` \| `rate_limit_429_global` \| `rate_limit_429_direct_llm` \| `rate_limit_degraded` \| `preflight` \| `auth_401` \| `auth_403` \| `tier_403` \| `hmac_secret_unconfigured` \| `internal_mcp_no_user` \| `internal_mcp_malformed_sig` \| `internal_mcp_bad_nonce` \| `internal_mcp_ts_window` \| `internal_mcp_bad_request` \| `internal_mcp_sig_mismatch` \| `internal_mcp_replay` | Scoped 429 reasons identify the rejecting limiter directly; `auth_*` distinguishes auth-rejection paths from genuine successes when filtering on `status` alone is ambiguous. `hmac_secret_unconfigured` is the 500 CONFIGURATION path when `MCP_INTERNAL_HMAC_SECRET` is unset on a signed internal-MCP request — a deploy/config incident, not caller authentication failure. The `internal_mcp_*` reasons split a signed-request rejection by which check failed: the caller still receives one indistinguishable 401 (telling a forge probe which piece failed is the oracle that path must not be), so this field is the only place the modes are separable — query it when a signed MCP call is failing and you need to tell clock skew from a real mismatch from a spent nonce. `internal_mcp_bad_nonce` means the nonce header is missing or invalid; `internal_mcp_replay` means a valid signed nonce was already used |

### `upstream` (one per outbound fetch from a request handler)

| Field                | Example                  |
|----------------------|--------------------------|
| `request_id`         | links back to the parent |
| `provider`, `host`   | `"yahoo-finance"`, `"query1.finance.yahoo.com"` |
| `operation`          | logical op name set by the helper |
| `status`, `duration_ms`, `request_bytes`, `response_bytes` | |
| `cache_status`       | `miss` \| `fresh` \| `stale-while-revalidate` \| `neg-sentinel` |
| `customer_id`, `route`, `tier` | inherited from the inbound request via AsyncLocalStorage |

## What it answers

A non-exhaustive list — copy-paste APL queries are in the **Analysis** section below.

- Per-customer request volume, p50/p95 latency, error rate
- Per-route premium-vs-free traffic mix
- CDN cache-tier distribution per route (calibrate `RPC_CACHE_TIER`)
- Top-of-funnel for noisy abusers (`auth_kind=anon` × `country` × `route`)
- Upstream provider cost per customer (`upstream` join `request` on `request_id`)
- Bearer-vs-API-key vs anon ratio per premium route
- Region heatmaps (`execution_region` × `route`)

---

## Architecture

```
                ┌─────────────────────────────────────────────────────┐
                │                  Vercel Edge handler                │
                │                                                     │
   request ──►  │  createDomainGateway()                              │
                │    auth resolution → usage:UsageIdentityInput       │
                │    runWithUsageScope({ ctx, customerId, route, … }) │
                │      └─ user handler ── fetchJson / cachedFetch... ─┼─► upstream
                │                          (reads scope, emits        │      API
                │                           upstream event)           │
                │    emitRequest(...) at every return point ──────────┼────►  Axiom
                │      └─ ctx.waitUntil(emitUsageEvents(...))         │   wm_api_usage
                └─────────────────────────────────────────────────────┘
```

Code map:

| Concern                                | File                                       |
|----------------------------------------|--------------------------------------------|
| Gateway emit points + identity accumulator | `server/gateway.ts`                    |
| Identity resolver (pure)               | `server/_shared/usage-identity.ts`         |
| Event shapes, builders, Axiom sink, breaker, ALS scope | `server/_shared/usage.ts`  |
| Upstream-event emission from fetch helpers | `server/_shared/cached-fetch.ts`, `server/_shared/fetch-json.ts` |

Key invariants:

1. **Builders accept allowlisted primitives only** — they never accept
   `Request`, `Response`, or untyped objects, so future field additions can't
   leak by structural impossibility.
2. **`emitRequest()` fires at every gateway return path** — origin block,
   OPTIONS, 401/403/404/405, rate-limit 429, ETag 304, success 200, error 500.
   Adding a new return path requires adding the emit, or telemetry coverage
   silently regresses.
3. **`principal_id` is a hash for secret-bearing auth** (API key, widget key)
   so raw secrets never land in Axiom.
4. **Telemetry failure must not affect API availability or latency** — sink is
   fire-and-forget with timeout + breaker; any error path drops the event with
   a 1%-sampled `console.warn`.

---

## Configuration

Two env vars control the pipeline. Both are independent of every other system.

| Var                | Required for | Behavior when missing                     |
|--------------------|--------------|-------------------------------------------|
| `USAGE_TELEMETRY`  | Emission     | Set to `1` to enable. Anything else → emission is a no-op (zero network calls, zero allocations of the event payload). |
| `AXIOM_API_TOKEN`  | Delivery     | Events build but `sendToAxiom` short-circuits to a 1%-sampled `[usage-telemetry] drop { reason: 'no-token' }` warning. |

Vercel project setup:

1. Axiom → create dataset **`wm_api_usage`** (the constant in
   `server/_shared/usage.ts:18`; rename if you want a different name).
2. Axiom → Settings → API Tokens → create an **Ingest** token scoped to that
   dataset. Copy the `xaat-…` value.
3. Vercel → Project → Settings → Environment Variables, add for the desired
   environments (Production / Preview):
   ```
   USAGE_TELEMETRY=1
   AXIOM_API_TOKEN=xaat-...
   ```
4. Redeploy. Axiom infers schema from the first events — no upfront schema
   work needed.

### Plan-limit scanner configuration

The paid-plan notification scanner reads usage from the same observability surfaces but is not on the request path. It runs as a Convex internal cron and writes only compact rollups/notices to Convex; raw request logs stay in Axiom and raw limiter counters stay in Redis.

| Source | Env vars | Used for | Missing behavior |
|--------|----------|----------|------------------|
| Axiom query API | `AXIOM_QUERY_TOKEN` or `AXIOM_API_TOKEN` (`AXIOM_QUERY_URL` optional) | API daily requests and API sustained burst rollups from `wm_api_usage` | Scanner reports `missing_axiom_query_token`; it does not assume zero usage |
| Upstash Redis | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Existing Pro MCP daily counters | Scanner reports `missing_upstash_credentials`; it does not assume zero usage |
| MCP limiter-hit telemetry | `mcp.rate_limit_hit` log event from `api/mcp/auth.ts` | MCP sustained burst notices | No notice is emitted without durable hit buckets |
| Resend | `RESEND_API_KEY`, optional `PLAN_LIMIT_EMAIL_FROM` | Customer notification emails | Notice remains pending/failed; hard enforcement readiness stays blocked |

Operators can inspect the hard-enforcement preflight with the internal Convex query:

```sh
npx convex run apiPlanLimitNotices:getEnforcementReadiness
```

Treat `ready: false` as a stop sign for paid-plan hard enforcement. The readiness report blocks on stale sources, failed or pending email, and self-serve upgrade gaps such as API Starter users who need API Business while API Business is not currently checkout-enabled.

### Failure modes (deploy-with-Axiom-down is safe)

| Scenario                              | Behavior                                             |
|---------------------------------------|------------------------------------------------------|
| `USAGE_TELEMETRY` unset               | emit is a no-op, identity object is still built but discarded |
| `USAGE_TELEMETRY=1`, no token         | event built, `fetch` skipped, sampled warn          |
| Axiom returns non-2xx                 | `recordSample(false)`, sampled warn                 |
| Axiom timeout (>1.5s)                 | `AbortController` aborts, sampled warn              |
| ≥5% failure ratio over 5min (≥20 samples) | breaker trips → all sends short-circuit until ratio recovers |
| Direct gateway caller passes no `ctx` | emit is a no-op (the `ctx?.waitUntil` guard)        |

### Kill switch

There is no in-code feature flag separate from the env vars. To disable in
production: set `USAGE_TELEMETRY=0` (or unset it) and redeploy. Existing
in-flight requests drain on the next isolate cycle.

---

## Local development & testing

### Smoke test without Axiom

Just run the dev server with neither env var set. Hit any route. The path is
fully exercised — only the Axiom POST is skipped.

```sh
vercel dev
curl http://localhost:3000/api/seismology/v1/list-earthquakes
```

In any non-`production` build, the response carries an `x-usage-telemetry`
header. Use it as a wiring check:

```sh
curl -sI http://localhost:3000/api/seismology/v1/list-earthquakes | grep -i x-usage
# x-usage-telemetry: off       # USAGE_TELEMETRY unset
# x-usage-telemetry: ok        # enabled, breaker closed
# x-usage-telemetry: degraded  # breaker tripped — Axiom is failing
```

### End-to-end with a real Axiom dataset

```sh
USAGE_TELEMETRY=1 AXIOM_API_TOKEN=xaat-... vercel dev
curl http://localhost:3000/api/market/v1/list-market-quotes?symbols=AAPL
```

Then in Axiom:

```kusto
['wm_api_usage']
| where _time > ago(2m)
| project _time, route, status, customer_id, auth_kind, tier, duration_ms
```

### Automated tests

Three suites cover the pipeline:

1. **Identity unit tests** — `server/__tests__/usage-identity.test.ts` cover the
   pure `buildUsageIdentity()` resolver across every `auth_kind` branch.
2. **Gateway emit assertions** — `tests/usage-telemetry-emission.test.mts`
   stubs `globalThis.fetch` to capture the Axiom POST body and asserts the
   `domain`, `customer_id`, `auth_kind`, and `tier` fields end-to-end through
   the gateway.
3. **Auth-path regression tests** — `tests/premium-stock-gateway.test.mts` and
   `tests/gateway-cdn-origin-policy.test.mts` exercise the gateway without a
   `ctx` argument, locking in the "telemetry must not break direct callers"
   invariant.

Run them:

```sh
npx tsx --test tests/usage-telemetry-emission.test.mts \
                tests/premium-stock-gateway.test.mts \
                tests/gateway-cdn-origin-policy.test.mts
npx vitest run server/__tests__/usage-identity.test.ts
```

---

## Analysis recipes (Axiom APL)

All queries assume dataset `wm_api_usage`. Adjust time windows as needed.

### Per-customer request volume + error rate

```kusto
['wm_api_usage']
| where event_type == "request" and _time > ago(24h)
| summarize requests = count(),
            errors_5xx = countif(status >= 500),
            errors_4xx = countif(status >= 400 and status < 500),
            p95_ms = percentile(duration_ms, 95)
            by customer_id
| order by requests desc
```

### p50 / p95 latency per route

```kusto
['wm_api_usage']
| where event_type == "request" and _time > ago(1h)
| summarize p50 = percentile(duration_ms, 50),
            p95 = percentile(duration_ms, 95),
            n = count()
            by route
| where n > 50
| order by p95 desc
```

### Premium vs free traffic mix per route

```kusto
['wm_api_usage']
| where event_type == "request" and _time > ago(24h)
| extend tier_bucket = case(tier >= 2, "api+ent", tier == 1, "pro", "free/anon")
| summarize n = count() by route, tier_bucket
| evaluate pivot(tier_bucket, sum(n))
| order by route asc
```

### CDN cache-tier mix per route — calibrates `RPC_CACHE_TIER`

```kusto
['wm_api_usage']
| where event_type == "request" and status == 200 and method == "GET" and _time > ago(24h)
| summarize n = count() by route, cache_tier
| evaluate pivot(cache_tier, sum(n))
| order by route asc
```

A route dominated by `slow-browser` that *should* be CDN-cached is a hint to
add an entry to `RPC_CACHE_TIER` in `server/gateway.ts`.

### Anonymous abuse hotspots

```kusto
['wm_api_usage']
| where event_type == "request" and auth_kind == "anon" and _time > ago(1h)
| summarize n = count() by route, country
| where n > 100
| order by n desc
```

### Authorization-failure fan-out per identity (#8406)

Volumetric rate limits do not catch a slow scanner that fans out across many
routes under the global ceiling. Watch **distinct routes** with
`tier_403` / `auth_401` per authenticated `principal_id` instead. Thresholds are
**split by `auth_kind`** (JWT paywall browsing ≠ free API-key fan-out). Full
decision, measured baseline, and operator runbook:
[`docs/operations/authz-failure-signal.md`](../operations/authz-failure-signal.md).

```kusto
['wm_api_usage']
| where event_type == "request"
  and reason in ("tier_403", "auth_401")
  and isnotnull(principal_id)
  and _time > ago(1h)
| summarize distinct_routes = dcount(route),
            failures = count(),
            sample_routes = make_set(route, 20),
            customer_ids = make_set(customer_id)
            by principal_id, auth_kind
| where (auth_kind in ("clerk_jwt", "mcp_oauth") and distinct_routes >= 8)
     or (auth_kind in ("user_api_key", "enterprise_api_key", "widget_key") and distinct_routes >= 40)
| order by distinct_routes desc
```

Group by `principal_id` + `auth_kind` only — `customer_id` can be the Clerk org
or the user for the same JWT principal, and grouping on it would split one
identity across rows. Anon traffic has `principal_id == null`; use the optional
IP secondary query in the runbook if needed.

### Upstream cost per customer (provider attribution)

```kusto
['wm_api_usage']
| where event_type == "upstream" and _time > ago(24h)
| summarize calls = count(),
            response_bytes_mb = sum(response_bytes) / 1024.0 / 1024.0,
            p95_ms = percentile(duration_ms, 95)
            by customer_id, provider
| order by calls desc
```

### Cache hit ratio per provider (correctness signal)

```kusto
['wm_api_usage']
| where event_type == "upstream" and _time > ago(24h)
| summarize n = count() by provider, cache_status
| evaluate pivot(cache_status, sum(n))
| extend hit_ratio = (fresh + coalesce(['stale-while-revalidate'], 0)) * 1.0 / (fresh + miss + coalesce(['stale-while-revalidate'], 0))
| order by hit_ratio asc
```

### Sentry × Axiom join

When Sentry surfaces an exception, copy its trace ID and:

```kusto
['wm_api_usage']
| where sentry_trace_id == "<paste from Sentry>"
```

…to see the exact request envelope (route, customer, latency, cache outcome).

### Telemetry health watch

```kusto
['wm_api_usage']
| where _time > ago(1h)
| summarize events_per_min = count() by bin(_time, 1m)
| order by _time asc
```

A drop to zero with no corresponding traffic drop = breaker tripped or
Vercel/Axiom integration broken — pair it with the `[usage-telemetry] drop`
warns in Vercel logs to find the cause.

---

## Adding new telemetry fields

1. Add the field to `RequestEvent` (or `UpstreamEvent`) in
   `server/_shared/usage.ts`.
2. Extend the corresponding builder (`buildRequestEvent` /
   `buildUpstreamEvent`) — only allowlisted primitives, no untyped objects.
3. If the value comes from gateway state, set it on the `usage` accumulator
   in `gateway.ts`. Otherwise plumb it through the builder call sites.
4. Axiom auto-discovers the new column on the next ingest. No schema migration.
5. Update this doc's field table.

## Adding a new gateway return path

If you add a new `return new Response(...)` inside `createDomainGateway()`,
**you must call `emitRequest(status, reason, cacheTier, resBytes?)` immediately
before it.** Telemetry coverage is enforced by code review, not lint. The
`reason` field uses the existing `RequestReason` union — extend it if the
return represents a new failure class.
