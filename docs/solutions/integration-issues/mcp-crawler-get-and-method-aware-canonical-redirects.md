---
title: "Make MCP endpoints crawler-accessible without letting a CDN replay discovery to transport clients"
date: 2026-07-20
category: integration-issues
module: "MCP HTTP transport and canonical host routing"
problem_type: integration_issue
component: assistant
severity: high
symptoms:
  - "Google Search Console reported https://www.worldmonitor.app/mcp and the variant-subdomain /mcp URLs as inaccessible because a plain GET returned 405 Method Not Allowed"
  - "A cacheable discovery 200 on /.well-known/mcp was served by the Vercel edge (x-vercel-cache: HIT) to a GET carrying Accept: text/event-stream, which the MCP transport contract requires to be 405"
root_cause: wrong_api
resolution_type: code_fix
tags:
  - mcp
  - google-search-console
  - crawler-access
  - canonical-url
  - content-negotiation
  - http-caching
  - vary-header
  - cache-poisoning
  - http-transport
  - json-rpc
---

# Make MCP endpoints crawler-accessible without letting a CDN replay discovery to transport clients

## Problem

Google Search Console could not access `/mcp` — on `www`, on the apex, and on every variant subdomain (`happy`, `tech`, `finance`, `commodity`, `energy`). The route is not a conventional page: `vercel.json` rewrites `/mcp` to an Edge Function implementing MCP Streamable HTTP, and a plain crawler-style `GET` fell into the transport's spec-correct `405 Method Not Allowed`.

Baseline, confirmed by probing production before any change:

```
GET https://worldmonitor.app/mcp        → 405, no-store
GET https://happy.worldmonitor.app/mcp  → 405, no-store
```

The obvious fix — answer a plain `GET` with a document — is where the real hazard lives, and it is the reason this write-up exists.

## The trap: a cacheable 200 on a content-negotiated transport URL

`/mcp` and the `/.well-known/mcp` aliases branch on **request headers**, not on path:

| Request shape | Intended response |
|---|---|
| `GET`, no `Last-Event-ID`, no `text/event-stream` | discovery document |
| `GET` with `Accept: text/event-stream` | `405` + `Allow` (the "no standalone stream" signal) |
| `GET` with `Last-Event-ID` | authenticated SSE replay |
| `POST` | JSON-RPC |

A first attempt served the JSON server card on a plain `GET` with `Cache-Control: public, max-age=3600` and **no `Vary`**. That shipped on `/.well-known/mcp`, which made the failure directly observable in production:

```
# warm the cache with a plain GET
GET /.well-known/mcp  Accept: application/json
  → 200, x-vercel-cache: HIT, age: 15, vary: accept-encoding

# the SSE stream-open on the SAME URL
GET /.well-known/mcp  Accept: text/event-stream
  → 200, x-vercel-cache: HIT, age: 15
    content-type: application/json
    {"name":"worldmonitor","kind":"product",...}
```

The edge keys on URL alone unless the origin says otherwise. An MCP SDK client opening the optional standalone stream received a **200 JSON body where the transport contract requires 405**. That is the #4937 failure class — an uncorrelatable response that hangs a strict client to its 30s timeout — reintroduced through the cache layer rather than the handler.

Extending the same cacheable-200 pattern to `/mcp` would have moved this onto the actual transport URL.

## Solution

### 1. Split the two discovery representations by audience

The well-known aliases keep serving the **JSON server card** (machine discovery). `/mcp` itself serves the **markdown server guide** — the same document already published at `/mcp-server.md` — so a human or crawler opening the endpoint gets something readable:

Both the handler and middleware use `clientAcceptsSse`, the shared parser that treats media types case-insensitively and honors `q=0`. A raw substring check does neither.

```ts
const WELL_KNOWN_MCP_PATHS = new Set(['/.well-known/mcp', '/.well-known/mcp.json']);
const MCP_TRANSPORT_PATH = '/mcp';

if (
  req.method === 'GET' &&
  !req.headers.get('last-event-id') &&
  !clientAcceptsSse(req)
) {
  const pathname = new URL(req.url).pathname;
  if (WELL_KNOWN_MCP_PATHS.has(pathname)) return serveServerCard(req, corsHeaders);
  if (pathname === MCP_TRANSPORT_PATH) return serveMcpGuide(req, corsHeaders);
}
```

The branch runs **before** the transport GET branch and is defined by request semantics, never by user-agent sniffing.

### 2. Make the cache key match the negotiation

```ts
const DISCOVERY_VARY = 'Accept, Last-Event-ID';
```

- The well-known card **stays cacheable** (`public, max-age=3600`) and adds `Vary: Accept, Last-Event-ID`.
- `/mcp` stays **`no-store`** (it inherits `no-store, no-transform` from the MCP CORS bundle) and also declares `Vary`.

The asymmetry is deliberate. `Vary` is the correct fix, but it only works if every intermediary honors it. The transport URL is where a mistake is most expensive, so its correctness does not depend on that: it never emits a cacheable body at all. The cacheable copy of the guide still lives at `/mcp-server.md`. Crawler volume on `/mcp` is negligible, so there is nothing to gain by caching it there.

### 3. Canonicalize variant hosts to the apex — apex, not www

`ARCHITECTURE.md:72` documents the Cloudflare apex→www dynamic redirect whose exemption list is load-bearing: `/.well-known/*`, `/robots.txt`, `/security.txt`, `/mcp`, `/mcp/*`, `/oauth/*` are **served on the apex, never redirected**. The agent-discovery corpus is apex by design, and the server card advertises `https://worldmonitor.app/mcp`.

So variant-host canonicalization targets the apex, and only for retrieval methods:

```ts
if (
  path === '/mcp' &&
  (request.method === 'GET' || request.method === 'HEAD') &&
  VARIANT_HOST_MAP[host] &&
  !request.headers.get('last-event-id') &&
  !clientAcceptsSse(request)
) {
  return new Response(null, {
    status: 308,
    headers: {
      Location: 'https://worldmonitor.app/mcp',
      Vary: 'Accept, Last-Event-ID',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
```

Built by hand rather than with `Response.redirect()` precisely so it can carry `Vary` — a `308` is cacheable by default (RFC 9110 §15.4.9), so the same cache-key discipline applies to the redirect. `POST` and `OPTIONS` fall through unchanged to the `/api/mcp` rewrite; redirecting them would convert the JSON-RPC handshake into a `GET` (the #4938 fingerprint).

The guide response also declares `Link: <https://worldmonitor.app/mcp>; rel="canonical"`, so `www` and apex agree on one indexable URL.

## Why the tests could not have caught this

The transport conformance suite binds the handler to a localhost listener. The handler was **always correct** — it computed `405` for the SSE GET every time. The bug lived entirely in the edge cache between the handler and the client, exactly like #4938 ("no in-process test can see a CDN redirect rule").

The regression net therefore has two layers:

- `tests/mcp-transport-conformance.test.mjs` locks the *contract*: markdown guide on a plain `GET /mcp`, JSON card on the aliases, `405` preserved for SSE GETs, `HEAD` advertising the representation its `GET` returns, the card cacheable **only** with `Vary`, and the transport URL never cacheable.
- `scripts/mcp-live-smoke.mjs` (6-hourly cron) probes *production*: it warms the cache with a plain GET, then issues the SSE GET and fails if the answer is anything but `405` — naming `x-vercel-cache: HIT` explicitly when it is a cache replay. It also asserts the variant `308` and that variant `POST` is not redirected.

Run against un-fixed production, the new probe reproduced all three defects independently, including the cache HIT.

## Landmines

### `\bAccept\b` matches `accept-encoding`

The first version of the `Vary` assertion was `/\bAccept\b/i`. `-` is a word boundary, so it matches the `accept-encoding` that the edge adds on its own — the check passed against an origin sending no `Vary` at all. It must be:

```js
/\bAccept\b(?!-)/i
```

A check written to catch a specific bug that passes on the un-fixed system is worse than no check. Always run a new probe against the broken state and confirm it fails.

### Header order in the response constructor

`getMcpCorsHeaders()` carries `Cache-Control: no-store, no-transform` for the live endpoint. The card's `public, max-age=3600` must come **after** the `...corsHeaders` spread or it is clobbered back to `no-store`. Conversely the guide deliberately does **not** override it.

### `/mcp-server.md` is not apex-exempt

`fetch(new URL('/mcp-server.md', req.url))` from an apex-origin function 301s to `www` before resolving — `/mcp-server.md` is not in the Cloudflare exemption list, unlike `/.well-known/*`. Redirect-following makes it work; the module-scope cache means it costs one extra hop per instance, not per request.

## Prevention

Any response on a URL that branches on request headers must satisfy:

```
cacheable(response) ⇒ Vary ⊇ {every header the branch reads}
```

and for a **live protocol endpoint**, prefer the stronger invariant: emit no cacheable body at all. State the negotiation matrix (host × method × headers) in the test suite, and probe it over the public edge — Cloudflare, Vercel middleware, the rewrite, and the handler only compose in production.

## Related Issues

- [Issue #4802](https://github.com/koala73/worldmonitor/issues/4802) / [PR #4808](https://github.com/koala73/worldmonitor/pull/4808): removed an overly narrow Origin allowlist from `/mcp`.
- [PR #4809](https://github.com/koala73/worldmonitor/pull/4809): made the static MCP server card cacheable. This fix keeps that cacheability and adds the `Vary` that makes it safe.
- #4937 / #4938: the uncorrelatable-response and redirected-POST outages that `mcp-live-smoke.mjs` was built for. The cache replay found here is #4937's failure mode arriving through the CDN.
