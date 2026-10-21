# Railway reconcile control

Dedicated Cloudflare Worker and SQLite-backed Durable Object for Railway
reconciliation ownership, attempt generations, dispatch holds, terminal
acceptance, and the project/environment-wide mutation uncertainty barrier.

The outer Worker derives the one Durable Object ID exclusively from the secret
`CONTROL_SCOPE` binding. Request data never participates in object routing.
`GET /version` is handled by the outer Worker and returns only
`protocolVersion` and `DEPLOYMENT_SHA`; it is a propagation probe, not a health
or readiness claim, and it never opens the Durable Object. Deployment readiness
is proven separately through an authenticated status read.

## Authentication

The versioned `/v1/` API uses four independent secrets:

- `MUTATION_HMAC_SECRET`
- `VERIFIER_HMAC_SECRET`
- `WATCHDOG_HMAC_SECRET`
- `OPERATOR_HMAC_SECRET`

Clients send `x-wm-control-role`, `x-wm-control-version`, an integer-second
`x-wm-control-timestamp`, a unique `x-wm-control-nonce`, and the raw lowercase
hex `x-wm-control-signature`. The signature covers the method, path, SHA-256 of
the exact body bytes, timestamp, and nonce separated by newlines. Nonces are
replay-protected transactionally in bounded Durable Object state.

`/v1/watchdog/status` is the only authenticated GET route. Mutation, verifier,
watchdog mutation, and operator routes are POST-only and accept closed JSON
schemas. The Worker has no CORS route and is served only from
`railway-reconcile-control.worldmonitor.app`. The shipped client rejects every
other origin before signing a request.

Rotate a role secret only after automatic recovery is disabled, authenticated
status reports no active lease, barrier, or dispatch hold, and GitHub shows no
active mutation or verifier job. Update the Worker and the matching protected
environment as one maintenance operation; rotating through active durable
state intentionally fails closed and requires operator recovery.

## Local verification

```bash
npm test
npm run deploy:dry-run
```

Wrangler secrets and `DEPLOYMENT_SHA` are supplied by the protected deployment
workflow; no secret values belong in `wrangler.toml`.
