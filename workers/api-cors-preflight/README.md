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
# (false positives during deploys).
LIVE_SMOKE=1 tsx --test tests/cors-preflight-live.test.mjs
```

## Keep in sync

The Worker's allowlist + Allow-Headers list **must be a superset of** what
`api/_cors.js#getCorsHeaders` returns. If the Worker rejects an origin that the
function would accept, the browser sees a mismatched origin echo and CORS
rejects the request. Drift between the two is the load-bearing trap this
package exists to make visible. Update both files together.

## Related learning

`~/.claude/skills/worldmonitor-architecture-gotchas/reference/cloudflare-worker-overrides-vercel-cors-for-preflight.md`
captures the full post-mortem of the 2026-05-27 CORS outage that motivated
pulling the Worker into the repo. Read it before touching this Worker.
