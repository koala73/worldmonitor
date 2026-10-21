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
# (false positives during deploys). CI already runs it after every Worker deploy
# (the live-smoke job); run it by hand to check the currently-deployed Worker.
# It is the only guard that reads the bytes users receive, including the
# KV-served bootstrap tiers that never reach api/bootstrap.js.
LIVE_SMOKE=1 tsx --test tests/cors-preflight-live.test.mjs
```

## Keep in sync

The Worker's allowlist + Allow-Headers list **must be a superset of** what
`api/_cors.js#getCorsHeaders` returns. If the Worker rejects an origin that the
function would accept, the browser sees a mismatched origin echo and CORS
rejects the request. Drift between the two is the load-bearing trap this
package exists to make visible. Update both files together.

### Explicit public bootstrap URLs are the exception

The origin and Worker share `classifyPublicBootstrapRequest()` for these URLs:

- `?tier=<fast|slow>&public=1`
- `?keys=weatherAlerts&public=1`
- `?keys=<on-demand key>&public=1`

They return ACAO `*`, no `Access-Control-Allow-Credentials`, and no
`Vary: Origin`. The payload is identical for every caller, so an Origin-specific
cache entry buys nothing. The single-key classifier reads the generated
bootstrap registry. A registry change therefore deploys the Worker through
`api/_bootstrap-tier-keys.js`.

The marker does not make an arbitrary key public. For example,
`?keys=marketQuotes&public=1` stays credentialed and returns 401 without a key.
The unmarked `?keys=weatherAlerts` URL also stays outside the edge classifier
because its origin auth kind depends on attached credentials.

Two deliberate carve-outs inside the exception:

- **A disallowed Origin keeps the credentialed bag.** For tier URLs, the request
  still uses KV. Header policy and routing remain separate, so an Origin header
  cannot force Vercel or Redis work.
- **The KV-served response stays `Cache-Control: no-store` with no
  `CDN-Cache-Control`.** Rationale lives with the code it explains —
  `src/kv-serve.js#serveFromKv`. The origin fallback for the same URL does sit
  behind Vercel's CDN and keeps its `CDN-Cache-Control` shield untouched.

Note the second carve-out means the browser cache directive for one URL differs
by which path answered (`no-store` from KV, `TIER_CACHE[tier]` from the origin).
The CORS shape is unified; caching deliberately is not.

`tests/cors-preflight-live.test.mjs` asserts all of this against a **deployed**
URL, and the `live-smoke` job in `.github/workflows/deploy-worker.yml` runs it
automatically after every Worker deploy. The handler-level guard in
`api/bootstrap-auth.test.mjs` cannot: it calls `handler()` directly, so it never
sees what the edge does to the bytes afterwards. Both read the same assertions
from `tests/helpers/public-bootstrap-contract.mjs`.

## Related learning

`~/.claude/skills/worldmonitor-architecture-gotchas/reference/cloudflare-worker-overrides-vercel-cors-for-preflight.md`
captures the full post-mortem of the 2026-05-27 CORS outage that motivated
pulling the Worker into the repo. Read it before touching this Worker.
