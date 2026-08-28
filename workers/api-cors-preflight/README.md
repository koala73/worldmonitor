# api-cors-preflight

Cloudflare Worker bound to `api.worldmonitor.app/*`. Owns CORS at the edge:
short-circuits OPTIONS preflights (without forwarding to Vercel) and stamps
matching CORS headers onto every non-OPTIONS response on the way back to the
browser.

## Why this exists separately from `api/_cors.js`

Three CORS surfaces sit in front of every browser request to `api.worldmonitor.app`:

1. **Cloudflare Worker (this directory)** — sees the request first; the
   preflight response the browser actually checks comes from here.
2. **Vercel edge function `api/_cors.js#getCorsHeaders`** — runs per-request
   for non-OPTIONS, and supplies CORS headers that the Worker then overrides
   with its own copy on the way out.
3. **`vercel.json`** — no longer pins static `/api/*` CORS headers (removed in
   PR #3923 because the wildcard `ACAO: *` was incompatible with credentialed
   requests).

When the app switched to `credentials: 'include'` (HttpOnly cookies, PR #3913),
the Worker's preflight response was missing
`Access-Control-Allow-Credentials: true`. Repo-side fixes (PR #3923) could not
close the outage because the preflight never reaches Vercel. Moving the Worker
source in-repo means future CORS changes:

- Show up in `git log` / `git blame` / code review / greptile.
- Get unit-tested in this directory (`index.test.mjs`).
- Get smoke-tested against live prod (`tests/cors-preflight-live.test.mjs`).
- Deploy from CI on merge (`.github/workflows/deploy-worker.yml`).

## Deploy

### From CI (preferred)

Merge to `main` → `.github/workflows/deploy-worker.yml` runs `wrangler deploy`
automatically when `workers/api-cors-preflight/**` changes. Requires repo
secrets:

- `CLOUDFLARE_API_TOKEN` — token with `Workers Scripts:Edit` + `Workers
  Routes:Edit` for the `worldmonitor.app` zone.
- `CLOUDFLARE_ACCOUNT_ID` — the CF account that owns the Worker.

### From your laptop (fallback)

```sh
cd workers/api-cors-preflight
npm install
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
npm run deploy
```

## Tests

```sh
# Unit tests against the Worker module directly (fast, deterministic).
cd workers/api-cors-preflight && npm test

# Live smoke test against prod. Gated by env var so it doesn't run in PR gates
# (false positives during deploys). Run this AFTER a Worker deploy: it is the
# only guard that reads the bytes users receive, including the KV-served
# bootstrap tiers that never reach api/bootstrap.js.
LIVE_SMOKE=1 tsx --test tests/cors-preflight-live.test.mjs
```

## Keep in sync

The Worker's allowlist + Allow-Headers list **must be a superset of** what
`api/_cors.js#getCorsHeaders` returns. If the Worker rejects an origin that the
function would accept, the browser sees a mismatched origin echo and CORS
rejects the request. Drift between the two is the load-bearing trap this
package exists to make visible. Update both files together.

### The public bootstrap tiers are the exception

`GET /api/bootstrap?tier=<fast|slow>&public=1` is answered with the **public**
shape — ACAO `*`, no `Access-Control-Allow-Credentials`, no `Vary: Origin` —
mirroring `api/bootstrap.js#getPublicBootstrapHeaders()`. The payload is the
shared seed bundle, identical for every caller, so keying it by Origin costs a
cache entry per origin and buys nothing, and advertising credentialed access on
a response no credential can change is what #7308 was filed about. Both edge
paths use it: the KV-served bytes and the origin pass-through, so the shape does
not depend on which one answered.

Two deliberate carve-outs inside that exception:

- **A disallowed Origin is never served from KV and keeps the credentialed
  bag.** `api/bootstrap.js` refuses those with 403 before it reads a payload;
  handing one ACAO `*` at the edge would widen access the origin denies.
- **The KV-served response stays `Cache-Control: no-store` with no
  `CDN-Cache-Control`.** A Worker-generated `Response` is never stored by the
  Cloudflare cache, so this path's shared lifetime is the POP-local KV read
  (`TIER_CACHE_TTL_S`) bounded by `classifyKvEnvelope`'s staleness gate — not a
  CDN entry. Declaring an `s-maxage` nothing honours would be worse than saying
  `no-store`. The origin fallback for the same URL does sit behind Vercel's CDN
  and keeps its `CDN-Cache-Control` shield untouched.

`tests/cors-preflight-live.test.mjs` asserts all of this against a **deployed**
URL. The handler-level guard in `api/bootstrap-auth.test.mjs` cannot: it calls
`handler()` directly, so it never sees what the edge does to the bytes
afterwards. Both read the same assertions from
`tests/helpers/public-bootstrap-contract.mjs`.

## Related learning

`~/.claude/skills/worldmonitor-architecture-gotchas/reference/cloudflare-worker-overrides-vercel-cors-for-preflight.md`
captures the full post-mortem of the 2026-05-27 CORS outage that motivated
pulling the Worker into the repo. Read it before touching this Worker.
