# Cloud API Access

This document describes how the Vercel-hosted API routes decide whether a request may proceed.

## Overview

World Monitor desktop is local-first, but the cloud API remains an explicit trust boundary separate from the localhost sidecar.

- Local desktop calls go to the sidecar first and use `Authorization: Bearer <LOCAL_API_TOKEN>`.
- Vercel-hosted routes use origin-aware validation plus browser fetch metadata checks in `api/_api-key.js`.
- Browser requests from trusted World Monitor origins are allowed without `X-WorldMonitor-Key` only when they look like real same-origin or same-site browser fetches.
- Desktop-origin requests to Vercel routes require `X-WorldMonitor-Key` and must match `WORLDMONITOR_VALID_KEYS`.
- Unknown origins also require a valid key.

## Access Rules

`validateApiKey(req)` in `api/_api-key.js` applies these rules:

| Request origin | Header requirement | Result |
| --- | --- | --- |
| Trusted browser origin (`worldmonitor.app`, `tech.worldmonitor.app`, `finance.worldmonitor.app`, `happy.worldmonitor.app`, allowed Vercel previews, localhost in non-production) with browser fetch metadata (`Sec-Fetch-Site: same-origin` or `same-site`) | None required | Allowed |
| Trusted browser origin with `X-WorldMonitor-Key` | Optional key, but if present it must validate | Allowed only when valid |
| Desktop origin (`tauri.localhost`, `tauri://localhost`, `asset://localhost`) | `X-WorldMonitor-Key` required | Allowed only when valid |
| Unknown origin with `X-WorldMonitor-Key` | Required and validated | Allowed only when valid |
| Unknown origin without key | Missing required key | Rejected |

## Environment Variables

| Variable | Purpose | Required |
| --- | --- | --- |
| `WORLDMONITOR_VALID_KEYS` | Comma-separated allowlist for desktop-origin and unknown-origin access | Required if those callers must reach the Vercel API |
| `NODE_ENV` | Controls whether localhost browser origins are trusted outside production | Platform-managed |

If `WORLDMONITOR_VALID_KEYS` is empty, trusted browser origins still work without a key, but desktop-origin and unknown-origin requests will be rejected when they require validation.

## Architecture

```text
Desktop renderer          Local sidecar                    Vercel routes
-----------------         ---------------------------      ---------------------------
/api/... fetch     ---->  localhost sidecar auth token     api/[domain]/v1/[rpc].ts
                           (LOCAL_API_TOKEN)               api/bootstrap.js
                                  |                        api/claude-agent.js
                                  | optional cloud path    validateApiKey(req)
                                  v
                             remote worldmonitor.app
```

## Source Files

| File | Role |
| --- | --- |
| `src/services/runtime.ts` | Local-first fetch patch and remote fallback selection |
| `api/_api-key.js` | Origin, fetch-metadata, and key validation rules |
| `api/_cors.js` | CORS headers, including `X-WorldMonitor-Key` |
| `api/[domain]/v1/[rpc].ts` | Generated RPC gateway entrypoint |
| `api/bootstrap.js` | Bootstrap route using the same validation helper |
| `api/claude-agent.js` | Claude agent route using the same validation helper |
