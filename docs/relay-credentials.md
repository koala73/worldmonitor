# Convex relay credentials

Convex tenant routes use credentials scoped to the calling service. Provision
independent random values through each platform's secret store. Never copy
`RELAY_SHARED_SECRET` into a tenant credential. Convex rejects an ingestion key
or a value reused between tenant roles, and denies access when a key is missing.
There is no fallback to the ingestion credential.

| Credential | Holders | Allowed Convex routes (`/relay/` prefix) |
| --- | --- | --- |
| `CONVEX_TENANT_RELAY_SECRET` | Convex and Vercel user gateways | `notification-channels` (all actions), `create-checkout`, `customer-portal`, `register-referral-code`, `followed-countries` |
| `CONVEX_NOTIFICATION_RELAY_SECRET` | Convex, Railway `notification-relay` and `digest-notifications` | `channels`, `deactivate`, `enabled-rules`, `digest-rules`, `user-preferences`, `entitlement`, `followed-countries` |
| `CONVEX_EMAIL_SUPPRESSION_SECRET` | Convex and an authorized operator running `scripts/import-bounced-emails.mjs` | `bulk-suppress-emails` |
| `RELAY_SHARED_SECRET` | Existing relay/ingestion services | `intel-history` ingestion; existing non-Convex relay uses remain unchanged |
| `RELAY_RETRACT_SECRET` | Convex and authorized retraction operators | Existing history retraction, restoration and retraction listing |

The gateway still validates Clerk identity, OAuth state or the brief capability
before forwarding a user ID. Notification workers need cross-user delivery data;
their key does not grant channel management, payment or suppression authority.
The digest worker retains `RELAY_SHARED_SECRET` solely for its existing analyst
request to Vercel; its Convex requests use the notification credential.

## Deployment order

This is a coordinated, fail-closed cutover. Do not deploy until all required
service configuration and release artifacts are ready. No credentials belong in
browser variables, source code, logs, PR descriptions or screenshots.

1. Provision distinct keys in Convex and their listed consumers. Configure the
   importer key only when that operation is needed. Do not distribute tenant
   keys to ingestion seeders. Leave the existing ingestion and retraction keys
   unchanged for this cutover.
2. Deploy Convex with the new admission rules first. Old tenant callers now get
   401 responses until their releases follow. Schedule this interruption:
   notification delivery, preferences and billing gateways can be unavailable.
3. Deploy Vercel and both notification workers with the migrated callers.
   Update any operator checkout before running the suppression importer.
4. Using approved test accounts, verify channel reads and updates, OAuth channel
   linking, checkout/portal admission, referral registration, brief watchlists,
   notification/digest delivery and suppression if used. Observe the next natural
   history ingestion and confirm retraction remains independently gated. Check
   for relay 401s without recording headers or secret values.

Every deploy in steps 2 and 3 must happen **after** its key is provisioned, and
a key added or rotated later needs a **new deploy on both platforms** — presence
in the store is not enough. Both halves of #8208 were this: a Convex variable
written after the last `convex deploy` reads as `undefined` inside deployed
functions until the next push, and a Vercel variable set after the build never
reaches the running build because a same-commit redeploy is cancelled by the
ignored-build step (#8216). The acceptance signal is `/api/health`: its
`relayGatewayGate` entry sends one credentialed, body-less
`POST /relay/create-checkout` per verdict snapshot and reports
`RELAY_GATE_MISCONFIGURED` (Vercel build cannot see the secret) or
`RELAY_GATE_REJECTED` (Convex gate does not admit it) as a critical problem,
which the 15-minute seed-freshness monitor pages on. Do not consider the cutover
finished until that entry reads `OK` (#8217).

If a consumer fails, repair its configuration or release while keeping Convex's
new gate. Rolling Convex back restores the old broad authority; treat that as a
separate security decision. Removing the new credentials fails closed. Do not
add a temporary old-key fallback to reduce the cutover interruption.

Local fixture tests prove route admission and selected query/mutation behavior.
They do not prove production key separation, deployed configuration, payment
provider effects or successful delivery. Those remain release acceptance checks.

## Design decision

Role-scoped service credentials preserve the existing gateway identity checks and
background worker flow. Per-user signed assertions would require a new identity
protocol for OAuth callbacks, brief capabilities and workers without sessions.
A single tenant key would give delivery workers unnecessary payment and channel
management authority. The role split keeps each route's allowed callers explicit
and shares only the admission check. No payload, storage or provider contract is
changed.
