---
title: "CORS"
description: "How cross-origin request protection works and what to do when adding new API endpoints."
---

# CORS

How cross-origin request protection works and what to do when adding new API endpoints.

---

## Overview

Every API response must include CORS headers so browsers allow the frontend to read it. Two parallel implementations exist — one for standalone edge functions, one for the sebuf gateway — but they share the same origin allowlist and logic.

| File | Used by | Methods |
| --- | --- | --- |
| `api/_cors.js` | Standalone edge functions (`api/*.js`) | `GET, OPTIONS` (configurable) |
| `server/cors.ts` | Sebuf gateway (`api/[domain]/v1/[rpc].ts`) | `GET, POST, OPTIONS` |

## Allowed Origins

Both files use the same regex patterns:

| Pattern | Matches |
| --- | --- |
| `(*.)?worldmonitor.app` | Production + subdomains (`tech.`, `finance.`, etc.) |
| `worldmonitor-*-elie-*.vercel.app` | Vercel preview deploys |
| `localhost:*` / `127.0.0.1:*` | Local development |
| `tauri.localhost:*` / `*.tauri.localhost:*` | Desktop app (Tauri v2) |
| `tauri://localhost` / `asset://localhost` | Desktop app (Tauri v1 / asset protocol) |

Requests from any other origin receive a 403 response. Requests with **no** `Origin` header (server-to-server, curl) are allowed through — the `isDisallowedOrigin` check only blocks when an origin is present and not on the allowlist.

## Adding CORS to a New Edge Function

Every standalone edge function in `api/` must handle CORS manually. Follow this pattern:

```js
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

export default async function handler(req) {
  const cors = getCorsHeaders(req);

  // 1. Block disallowed origins
  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  // 2. Handle preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  // 3. Spread cors into every response
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
```

Key rules:

1. **Every response** must include `...cors` in its headers — including errors, rate-limit 429s, and 500s.
2. **Preflight** (`OPTIONS`) must return `204` with CORS headers and no body.
3. **`getCorsHeaders(req, methods)`** — pass a custom methods string if the endpoint supports more than `GET, OPTIONS` (e.g., `'POST, OPTIONS'`).

## Sebuf Gateway (RPC Endpoints)

RPC endpoints defined in `.proto` files do **not** need manual CORS handling. The gateway (`server/gateway.ts`) calls `getCorsHeaders()` and `isDisallowedOrigin()` from `server/cors.ts` automatically for every request. CORS headers are injected into all responses including error boundaries.

## Adding a New Allowed Origin

To allow a new origin:

1. Add a regex pattern to `ALLOWED_ORIGIN_PATTERNS` in **both** `api/_cors.js` and `server/cors.ts`.
2. Update the test in `api/_cors.test.mjs`.
3. If the origin is a new production subdomain, also add it to the Cloudflare R2 CORS rules (see MEMORY.md notes on R2 CORS in the repo root).

## Allowed Headers

Both implementations allow these request headers:

- `Content-Type`
- `Authorization`
- `X-WorldMonitor-Key` (API key for desktop/third-party access)

To allow additional headers, update `Access-Control-Allow-Headers` in both files.

## Railway Relay CORS

The Railway relay (`scripts/ais-relay.cjs`) has its own CORS handling with the `ALLOW_VERCEL_PREVIEW_ORIGINS` env var. See [RELAY_PARAMETERS.md](/RELAY_PARAMETERS) for details.
