---
module: railway-ops
date: 2026-08-04
problem_type: integration_issue
component: tooling
severity: high
symptoms:
  - "A cron schedule set via serviceInstanceUpdate returns true and reads back correctly, but the service keeps firing on its old schedule"
  - "A scheduled tick produces no new row in the deployments list, so the cron looks like it never ran"
  - "serviceInstanceUpdate with builder: DOCKERFILE fails with a bare 'Problem processing request'"
  - "A service lands in the wrong region despite passing region to serviceInstanceUpdate"
root_cause: config_error
resolution_type: workflow_improvement
related_components: [background_job, documentation]
tags: [railway, cron, graphql, deployment, provisioning, umami]
---

# A Railway cron schedule lives on the deployment manifest, not the service config

## Problem

Provisioning the `umami-retention` Railway cron service for #6148, the schedule
was set with `serviceInstanceUpdate`, the mutation returned `true`, and
`railway environment config --json` read the new value back. The cron then did
not fire at the scheduled minute — twice — while every surface said it was
configured.

## Symptoms

- `serviceInstanceUpdate(input: {cronSchedule: "46 * * * *"})` → `{"data": {"serviceInstanceUpdate": true}}`
- `railway environment config --json` → `"deploy": {"cronSchedule": "46 * * * *"}`
- Minute 46 passes. No container start, no runtime logs, no data change.
- Meanwhile the *deployment's* manifest still read `cronSchedule: "0 4 1 1 *"` —
  the value from when the deployment was created.

## What Didn't Work

- **Re-reading the service config.** It kept confirming the new schedule. The
  service config is not what the scheduler consults, so it can only ever agree
  with itself.
- **Watching the deployments list for a new entry.** Nothing appeared, which
  read as "the cron never fired." That was the wrong instrument — see below.

## Solution

Two distinct mechanics, both of which fail quietly:

**1. The scheduler reads the active deployment's manifest.** A config edit does
not retro-apply to a running deployment. Redeploy after changing the schedule,
then verify on the *deployment*, not the service:

```graphql
mutation($e: String!, $s: String!, $c: String!) {
  serviceInstanceDeployV2(environmentId: $e, serviceId: $s, commitSha: $c)
}
```

```graphql
query($e: String!, $s: String!) {
  deployments(first: 3, input: {environmentId: $e, serviceId: $s}) {
    edges { node { id status createdAt meta } } }
}
```

`meta.serviceManifest.deploy.cronSchedule` is the value that actually fires.
Once the redeploy carried `58 * * * *`, the tick landed at 21:58 on the dot.

**2. A cron tick creates no deployment record.** It re-runs the *active*
deployment. Four scheduled ticks produced zero new rows in the deployments
list; they were visible only in that deployment's runtime logs (one
`Starting Container` + the job's stdout per tick) and in the data itself. Count
ticks by grepping the active deployment's logs, never by polling for new
deployments.

Two adjacent API shapes cost time in the same session:

- **`Builder` has no `DOCKERFILE` member** — the enum is
  `HEROKU | NIXPACKS | PAKETO | RAILPACK`. Passing `builder: "DOCKERFILE"` fails
  with an unhelpful bare `Problem processing request`. Setting `dockerfilePath`
  is what selects the Dockerfile builder, and the config then *reads back* as
  `builder: "DOCKERFILE"` — which is exactly why copying a read-back config
  forward as a write payload fails.
- **`serviceInstanceUpdate`'s `region` field does not place the instance.**
  The service landed in `asia-southeast1-eqsg3a` (not the database's region)
  until `multiRegionConfig: {"us-east4-eqdc4a": {"numReplicas": 1}}` was set
  explicitly.

## Why This Works

A Railway deployment is an immutable snapshot: image plus the manifest that was
current when it was created. The service config is the *template for the next*
deployment. Everything that reads the service config — the CLI, the API, the
dashboard — is reading the template and is therefore consistent with itself and
useless as evidence about the running job. Only the deployment manifest is
evidence.

This is the same failure class as
[merged-is-not-ran-long-cron-seeders.md](./merged-is-not-ran-long-cron-seeders.md)
and the standing note that `scripts/railway-services.json` is documentation
audited by a test, never something applied to Railway: in all three, a
config-shaped surface agrees with your intent while production runs something
else.

## Prevention

- **After changing any deploy-time field, redeploy and assert on the deployment
  manifest.** Treat `serviceInstanceUpdate` returning `true` as "recorded for
  next time," not "applied."
- **Verify a cron by its effect, not by its record.** Ticks show up in runtime
  logs and in the data. For `umami-retention` the check was
  `railway logs -d <deployment-id> | grep -c '^COMMIT'` plus a falling row count
  — both independent of any config surface.
- **Provision an exit-on-completion cron service with a far-future cron pin.**
  `0 4 1 1 *` (1 Jan 04:00) makes Railway build the image and run nothing. That
  buys two things: a Dockerfile service whose command exits is not a
  restart-loop candidate, and the image is proven while a pre-mutation backup is
  still being verified. Confirm the pin held before releasing it — for #6148,
  the deployment produced no runtime logs and the target table's row count and
  oldest row were unchanged. Then set the real schedule and redeploy.
- **Do not round-trip a read-back config into a write payload.** `builder` is
  the concrete case: it is derived on read and rejected on write.
