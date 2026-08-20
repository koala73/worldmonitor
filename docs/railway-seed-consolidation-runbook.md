# Railway Seed Consolidation Runbook

**Date:** 2026-04-10
**PR:** #2891
**Current services:** 100 (at Railway limit)
**Target services:** 65 (~35 slots freed)

> **Single source of truth for Railway-deployed scripts:** `scripts/railway-services.json`.
> When adding a new Railway service (nixpacks or Dockerfile), add an entry to the
> registry before merging. Both `tests/scripts-railway-nixpacks-no-escape-import.test.mts`
> and `tests/dockerfile-digest-notifications-imports.test.mjs` derive their entry
> lists from the registry, and `tests/railway-services-registry-coverage.test.mts`
> fails if a `Dockerfile.*` CMD, runbook "Start command:" entry, or standalone
> service row references a script the registry doesn't know about. The
> scripts-root guard also conservatively scans unregistered legacy seeders.

---

## Prerequisites

1. Merge PR #2891 to `main`
2. Verify the bundle scripts are in the deployed branch
3. Have Railway dashboard access and `gh` CLI authenticated

---

## Deployment safety guardrails

### Native autodeploy target and quiesced rollback surface

The normal deployment architecture is intentionally small:

| Boundary | Authority | Normal-operation rule |
|---|---|---|
| Merge safety | GitHub protected `main` | Require a PR, current-base checks with `strict=true`, administrator enforcement, zero required human approvals, and no bypass actors. |
| Service selection | Railway's native watch paths, backed by `scripts/railway-services.json`, its closure audit, and the exact identity roster in `scripts/railway-native-autodeploy-fleet.json` | A source migration may change `source.checkSuites` only. It must not change watch paths, fleet identity, or another service field. |
| Deployment creation | Railway's native GitHub integration on explicit branch `main` | No GitHub Actions workflow dispatches, retries, leases, or repairs a normal deployment. |
| Drift detection | One six-hourly, read-only Railway workflow after the monitor migration | Missing, detached, replaced, unexpected, unknown, failed, skipped, overdue, or contradictory state is red. The monitor has no mutation token, dispatch permission, retry, reviewer, or acceptance baseline. |
| Recovery | Operator diagnosis followed by an explicit Railway action or batch rollback | Recovery is never automatic and never turns missing evidence green. Seed/ingestion freshness remains a separate acceptance surface. |

The permanent monitor uses a credential issued to a dedicated Railway
`VIEWER` identity. The legacy token names described later in this rollback
section are not proof of read-only capability and are deleted with the old
control plane; never reuse a deploy-capable project token for the target
monitor.

During the bounded rollback window, **Railway Deploy Trigger (Manual Rollback
Only)** and **Railway Deploy Trigger Watchdog (Manual Rollback Only)** retain
`workflow_dispatch` as an emergency surface. They have no `schedule`, `push`,
`workflow_run`, repository-dispatch, heartbeat, or replacement dispatcher. Keep
both `RAILWAY_RECONCILE_CUTOVER_ACTIVE=false` and
`RAILWAY_RECONCILE_AUTO_RECOVERY_ENABLED=false` in normal operation. The first
flag continues to guard every legacy mutation; the watchdog can authorize a
dispatch only when both flags are exactly `true` and an operator explicitly
runs it in `dispatch` mode.

No recovery environment is approved in normal operation. In particular, do
not approve a pending deployment for
`ingestion-acceptance-production-breakglass`, the manual-recovery workflow, the
Watchdog, or the legacy control worker just to clear a queue or alarm. A pending
approval is itself a stop condition: leave it unapproved, stop the cutover,
identify the originating run, and cancel or resolve it without granting
recovery authority. Normal viewer/ingestion environments retain zero required
reviewers so ordinary PRs and native Railway deployments never wait for a
person.

#### Exact native-cutover stop conditions

Stop before the next service or batch, preserve sanitized evidence, and roll
back only the current bounded batch when any of these is true:

1. `main` protection is not `strict=true`, PR-required, administrator-enforced,
   zero-approval, no-bypass, or its required contexts differ from the captured
   set.
2. Either legacy activation flag is unexpectedly true, or any Trigger mutation,
   verifier, Watchdog dispatch/bind/reject, manual recovery, or control-worker
   deployment is active, waiting, or ambiguous.
3. A recovery environment has a pending approval. Never approve it to continue
   a normal cutover.
4. The watch/config audit is nonzero, incomplete, unauthorized, contradictory,
   or emits unsanitized data; the live repository fleet differs from
   `scripts/railway-native-autodeploy-fleet.json`; a repository-linked service
   is not on explicit `main`; or `source.checkSuites` is not a boolean.
5. A scoped source patch changes watch paths, cron, root directory, Dockerfile,
   variables, repository, branch, or any field other than the selected
   services' `source.checkSuites`; selected readback is not exact.
6. A relevant merge produces no deployment, an unexpected service deploys, a
   build fails or exceeds its grace window, or a deployment SHA/ancestry cannot
   be proved. An unrelated merge must create no deployment for the service.
7. GitHub, Railway, or Git ancestry cannot be read completely, or any other
   evidence is missing, truncated, timed out, or contradictory. Unknown means
   stop; there is no baseline or “warn and continue” path.

#### Temporary native-autodeploy batch tool

`scripts/configure-railway-native-autodeploy.mjs` is the trusted-operator U2
cutover utility. It is temporary and must be deleted in U6 after the bounded
rollback window. It is not a workflow, must not receive a repository secret,
and has no GitHub, recovery-controller, dispatch, lease, or deployment
authority.

Run a whole-cohort preview first. Preview is the default and never calls
`railway environment edit`:

```bash
node scripts/configure-railway-native-autodeploy.mjs \
  --project-id <world-monitor-project-id> \
  --environment production \
  --json
```

Before every mutation, separately prove the protected-main, disabled legacy
flags, no-active-legacy-run, no-control-lease, no-pending-approval, and clean
deployment-state gates above. The utility deliberately has no credentials for
those systems. It independently resolves the explicit Railway project and
environment, pins every subsequent read and edit to that resolved environment
ID, runs the live watch/config audit, requires every repository
source to be `koala73/worldmonitor` on `main`, and rejects duplicate, unknown,
malformed, or oversized selections.

Preview a named batch before applying it. An apply or rollback requires one to
five repeated `--service` flags:

```bash
node scripts/configure-railway-native-autodeploy.mjs \
  --project-id <world-monitor-project-id> \
  --environment production \
  --service <service-one> \
  --service <service-two> \
  --json

node scripts/configure-railway-native-autodeploy.mjs \
  --project-id <world-monitor-project-id> \
  --environment production \
  --service <service-one> \
  --service <service-two> \
  --apply \
  --json
```

`--apply` writes only `source.checkSuites=false` for selected services that are
currently `true` or missing. `--rollback` writes the exact inverse,
`source.checkSuites=true`, and accepts only selected services currently proven
`false`. The tool freezes the full config again immediately before the edit,
polls bounded readback, and fails on drift observed during any poll—even if a
later poll would look clean. Any non-converged selected value, changed
unselected service, or selected field change outside `source.checkSuites` is a
hard failure.

If `railway environment edit` reports an error, the tool still performs the
same bounded exact readback because Railway can commit before a CLI timeout or
disconnect. Verified convergence is accepted. An unproven result returns an
ambiguous-outcome error: run preview and repeat every preflight gate before any
retry; never replay the mutation blindly.

Run one operator and one batch at a time; never overlap apply and rollback.
Mutation is forbidden from CI and GitHub Actions. Use only an authenticated
Railway CLI session or exactly one explicitly supplied short-lived
`RAILWAY_TOKEN` or `RAILWAY_API_TOKEN` in the trusted shell. The sanitized
summary contains service names, IDs, and before/after states only; it never
prints environment-variable names or values.

### Watch paths are a live contract, and an accurate one

Railway stores watch paths in each service's environment configuration, not in
the repository. The repo-side contract is
`scripts/railway-services.json`: every registry-managed production seeder pins
its cron and the exact repository-relative files in its runtime dependency
closure. `tests/railway-watch-path-audit.test.mjs` walks each entry point's
imports and fails when that closure grows without a matching registry update.
This keeps the declared closure complete without making unrelated changes under
`scripts/**` or `shared/**` rebuild every seeder.

**The filter matches accurately — read `meta.skippedReason` before concluding
otherwise.** Railway records a refused push as a `SKIPPED` deployment carrying
`meta.commitHash` and a reason, and the two reasons it uses mean opposite
things. Re-measured 2026-08-04 across all 77 repository-backed services and 600
commits of main, of 7,391 `No changes to watched files` skips, 7,331 were
plainly correct, 57 matched a pattern pointing **outside the service's build
context** (a `rootDirectory: scripts` container cannot see repository-root
`shared/`, so the `shared/**` several of them carry is unreachable by
construction), and 3 were a registry closure not yet applied to Railway. None
were unexplained.

The lag comes from the other reason. `CI check suite failed` — 1,504 skips —
is Railway refusing to build a commit whose **whole** GitHub check suite is
failing, including scheduled workflows that re-report onto main's head SHA long
after the merge gates went green. Over closure-relevant merges that is p90
**4.7h** against p90 **0.01h** when Railway simply builds, and it is
self-reinforcing: the freshness monitor goes red exactly when the fleet is
behind.

So the closures stay. The target is Railway's native GitHub integration on
`main`, with `source.checkSuites=false` only after strict pre-merge protection
and bounded readback have passed. The legacy
`.github/workflows/railway-deploy-trigger.yml` is manual rollback only; it is
not the normal deployment owner. Clearing the filters fleet-wide remains
rejected on cost: roughly 75 build-minutes per push across 77 services at ~30
merges a day, and three always-on services (ais-relay, notification-relay,
scenario-worker) restarting on every merge, dropping the AIS websocket
connections among them — and it would not fix the dominant cause anyway. The
full measurement is in
[Railway defers deploys on a red check suite, not on watch paths](solutions/integration-issues/railway-seeder-watch-paths-can-skip-deployments.md).

The always-on bootstrap publisher is the deliberate exception: its empty watch
path list means Railway watches the whole repository. That broader trigger
covers its Dockerfile and future bootstrap inputs without rebuilding the cron
seeder fleet.

`scripts/audit-railway-watch-paths.mjs` compares the registry with live
production configuration. It reports exact watch-path and cron drift, missing
registered services, and missing required source-routing variables. Apply mode
refuses a partial mutation while a service or required variable is absent.

The deployment-only audit and deploy-drift check first compare the unfiltered
Railway inventory with `scripts/railway-native-autodeploy-fleet.json`. That file
contains the 80 service names and IDs proven by terminally accepted run
`31696921882` at `a3e735a089c66448c29c2f8c000249f31470956c`. It is an identity
contract, not an exception or acceptance baseline: an expected service that is
missing, renamed, replaced, detached from `koala73/worldmonitor`, or joined by
an unregistered repository service fails the run before source filtering. Edit
the roster only with evidence for an intentional Railway inventory change; do
not use it to acknowledge drift.

After linking the CLI to the `world-monitor` production environment, audit the
live settings with:

```bash
node scripts/audit-railway-watch-paths.mjs
```

To reconcile only drifted seeders and verify the read-back:

```bash
node scripts/audit-railway-watch-paths.mjs --apply
```

The apply mode changes only drifted `build.watchPatterns`,
`build.dockerfilePath` and `deploy.cronSchedule` fields, uses one environment
config commit, and waits for
Railway's eventually consistent config read-back before reporting success. It
does not assign a cron to explicitly always-on services such as the bootstrap
publisher, while still auditing their watch paths and required environment.
Run the audit after adding or replacing a standalone seeder, changing a bundle
dependency, or changing a production cron.

The audit only proves the trigger config matches the registry. Proving a merge
actually reached production is the separate
[deploy-drift check](#deploy-drift-check) below.

The six-hourly `Railway Native Deploy Health` workflow performs this audit in
deployment-only mode and runs the deployment-history check from the same
Viewer projection. `Seed Freshness Monitor` owns ingestion acceptance only.
Create the dedicated GitHub Actions environment
`ingestion-acceptance-production`, restrict its deployment branch policy to
`main`, and configure:

- environment secret `RAILWAY_PRODUCTION_VIEWER_API_TOKEN`: an account token for
  a dedicated Railway identity whose project role is Viewer;
- environment variable `RAILWAY_PROJECT_ID`: the `world-monitor` project ID.

Do not define the Viewer token as a repository or organization secret:
`workflow_dispatch` can target another ref, while the environment's server-side
branch policy keeps the production credential unavailable there. The workflow
references the environment with deployment tracking disabled and maps the token
to `RAILWAY_API_TOKEN` only on the combined read step. It never links a checkout,
requests variables, or passes `--apply`. Missing or inaccessible context fails
the monitor rather than silently skipping the live audit. See
[Deploy-drift check](#deploy-drift-check) for the exact workflow contract.

### Legacy reconciliation control plane (rollback window only)

The reconciliation controller is a temporary legacy rollback surface backed by
a Cloudflare Worker and one SQLite Durable Object. It is not part of normal
native-autodeploy operation and must not receive automatic traffic. Keep both
`RAILWAY_RECONCILE_CUTOVER_ACTIVE` and
`RAILWAY_RECONCILE_AUTO_RECOVERY_ENABLED` set to `false` unless an operator has
explicitly chosen the bounded legacy rollback path after a stop condition.

Until final deletion, retain these GitHub Actions environments with a
`main`-only deployment branch policy. Do not approve or invoke them in normal
operation:

Set the non-secret repository variable `RAILWAY_RECONCILE_CONTROL_URL` to the
dedicated HTTPS origin compiled into the shipped control client; the client
rejects every other host even if a workflow variable is misconfigured.

| Environment | Capability |
|---|---|
| `railway-reconcile-control-production` | Cloudflare deploy token, account ID, fixed control scope, and all four pairwise-distinct HMAC values |
| `ingestion-acceptance-production-watchdog` | Watchdog HMAC only; no Railway credential |
| `ingestion-acceptance-production` | Mutation HMAC, `RAILWAY_RECONCILE_DEPLOY_TOKEN_V2`, and project ID |
| `ingestion-acceptance-production-verification` | Verifier HMAC, `RAILWAY_RECONCILE_VIEWER_TOKEN`, project ID, and GitHub read evidence |
| `ingestion-acceptance-production-breakglass` | Operator HMAC plus the same `RAILWAY_RECONCILE_VIEWER_TOKEN`; main-only secret boundary with no required reviewer |

Both Railway tokens are distinct project tokens with identical capability; the
names record intended use, not an enforced boundary. See the scope note below.

The ordinary lease-aware mutation and verifier jobs receive only their own
HMAC roles in their separately protected environments.

The Viewer token is **read-only by convention, not by credential scope.**
Railway issues exactly two token types and neither accepts a role or scope:
`apiTokenCreate` takes only `{name, workspaceId}` and inherits the creating
user's permissions, and `projectTokenCreate` takes only
`{projectId, environmentId, name}`. The `VIEWER` value on `ProjectRole` and
`TeamRole` applies to project *members* — user accounts — not to tokens. A
genuinely read-only token would require a separate Railway user account joined
to the project as a `VIEWER` member, which this project does not maintain.

So mint the Viewer and deploy tokens as two distinct project tokens on the one
owner account: distinct tokens still give independent revocation, a separate
audit trail, and blast-radius containment if one leaks. What they do not give
is an inability to deploy. That property is enforced instead by the
`--workflow-authorized` fence in `scripts/trigger-railway-deploys.mjs` and the
workflow contract tests, so treat any change to those guards as a change to a
security boundary. Note also that `projectTokenCreate` rejects a CLI session
with `Not Authorized`; both tokens must be created from the Railway dashboard.

Breakglass authorization is **one-person by deliberate choice during the
bounded rollback window only.** The environment
keeps its `main`-only branch policy and isolated secrets, but has no required
reviewer. Requiring that same operator to review their own dispatch adds no
independent authorization and sends one approval email for every recovery
attempt. The `approver` workflow input records the delegated operator identity
in the immutable controller audit and can equal the dispatch actor; it is not a
verified second party. Real
two-person control requires a second named operator and `prevent_self_review`.

The protected resolver deliberately repeats the GitHub, convergence, and
provider-inactivity reads after environment approval; the earlier proof is not
fresh enough to authorize a state transition by itself.

`GET /version` proves only that the expected Worker revision propagated.
Authenticated `/v1/watchdog/status` is the readiness check because it also
opens the canonical Durable Object and exercises the deployed watchdog HMAC.

HMAC rotation is a coordinated maintenance operation. First disable automatic
recovery, confirm authenticated status has no lease, barrier, or dispatch hold,
and confirm no target mutation or verifier job is active. Then update the
Worker and the one matching consumer environment together and repeat both the
version and authenticated status probes. Never rotate across an active lease,
hold, or barrier: the old run would lose its only authorization path and the
result would require protected operator recovery.

#### Quiescing and exceptional rollback

Normal operation keeps both activation flags false and the two legacy workflows
manual-only. Confirm the current `main` head has an exact green `gate`, no
mutation, verifier, Watchdog, manual-recovery, or control-worker job is active,
and authenticated controller status has no lease, barrier, attempt, or dispatch
hold. A stale hold is diagnosed and resolved as an incident; it is not a reason
to re-enable automatic entrants.

If an operator explicitly selects legacy rollback during the bounded rollback
window, change one flag at a time, run exactly the named manual workflow, and
restore both flags to false immediately after the terminal result is captured.
`RAILWAY_RECONCILE_AUTO_RECOVERY_ENABLED` may be true only for an explicit
manual Watchdog `dispatch` invocation while
`RAILWAY_RECONCILE_CUTOVER_ACTIVE=true`; there is no scheduled retry. Stop on
any active/ambiguous provider call, stale or contradictory controller state,
unexpected deployment, failed readback, or pending environment approval. Do
not use an acceptance baseline to authorize rollback or to make its result
green.

The native Railway source integration is not the lease-aware mutation path. It
can continue to accept ordinary builds: the reconcile trigger reads the live
deployment inventory and treats an accepted or in-progress build for the exact
commit as a no-op. The repository has no separate legacy GitHub workflow that
deploys with `RAILWAY_PRODUCTION_TOKEN`; that token remains only in read paths.
If either fact changes, disable and drain the new competing mutation path before
the native-autodeploy cutover.

During rollback diagnosis only, print the authenticated raw controller state
without dispatching anything by running the Watchdog's manual `status` mode
from `main`:

```bash
gh workflow run railway-deploy-trigger-watchdog.yml --ref main -f mode=status
```

The resulting `Read or classify reconciliation control state` log contains the
closed `STATUS_REPORTED` envelope. An operator with the separately provisioned
watchdog environment variables can run the same reader locally with
`node scripts/dispatch-stale-railway-reconcile.mjs --phase status`; never copy
the watchdog HMAC into an issue, command history, or shared shell profile.

#### Manual recovery evidence contract

`evidence_json` is a closed JSON object: unknown or omitted fields fail the
request. Every decision uses these common fields:

```json
{
  "version": 1,
  "evidenceId": "incident-evidence-0001",
  "runEvidenceId": "github-run-evidence-0001",
  "environmentEvidenceId": "breakglass-review-0001",
  "priorKind": "dispatch_hold",
  "priorCreatedAt": "2026-08-08T08:00:00.000Z",
  "targetRunId": null,
  "targetRunAttempt": null,
  "decisionEvidence": {
    "kind": "pre_mutation_hold",
    "mutationBoundaryCrossed": false
  }
}
```

The decision-specific `decisionEvidence` schemas are:

| Decision | `priorKind` | Target run | Exact decision evidence |
|---|---|---|---|
| `resolve_pre_mutation_hold` | `attempt` or `dispatch_hold` | Null for an unbound hold; otherwise exact run ID and attempt | `{"kind":"pre_mutation_hold","mutationBoundaryCrossed":false}` |
| `accept_observed_convergence` | `attempt` | Required | `{"kind":"observed_convergence","resultManifest":{...}}`, where `resultManifest` is the unmodified artifact from that exact target run |
| `authorize_current_main_retry` | `attempt` | Required unless the outage-wait form is used | `{"kind":"current_main_retry","providerCallsActive":false,"retryEvidence":...}` |

The target must be an exact run of the Railway deploy-trigger workflow on the
`main` branch. All decisions separately require an exact current green main
authorization. The target can be an older main run: observed convergence is
verified against that run's immutable manifest and exact incident head, while
the protected resolution also records the separately revalidated current head.
This separation keeps the convergence-acceptance route reachable after main
moves, including when it must reset a full 64-run mutation lineage.

The protected retry hold carries an immutable capability that is the only path
that can replace a same-head Railway deployment in `FAILED`. Ordinary runs and
watchdog-created recovery holds continue to report that failure without
retrying it. A recovery still adopts any active same-head deployment, or a
running same-head replacement newer than the failure, so the one-use controller
hold cannot duplicate work that Railway already accepted.

`retryEvidence` has exactly one of these forms. Its `evidenceId` must differ
from the outer evidence ID:

```json
{"kind":"terminal_inactive","evidenceId":"retry-audit-0001","auditedAt":"2026-08-08T08:45:00.000Z"}
```

```json
{
  "kind": "outage_wait",
  "evidenceId": "retry-audit-0002",
  "automaticEntrantsDisabledAt": "2026-08-08T08:00:00.000Z",
  "allJobsTerminatedAt": "2026-08-08T08:02:00.000Z",
  "lastPossibleLeaseAcquiredAt": "2026-08-08T08:01:00.000Z",
  "auditedAt": "2026-08-08T08:44:00.000Z"
}
```

The protected resolver rebuilds all GitHub and Railway proof after environment
approval, then rechecks it immediately before recording the immutable
resolution. The operator HMAC is removed from the process environment before
either read-only Railway subprocess can start.

#### Watchdog outcome decisions

| Outcome | Automatic decision | Required evidence or next action |
|---|---|---|
| `HEALTHY` | No dispatch | Fresh accepted attempt and no active lease, hold, or barrier |
| `WAITING_FOR_ACTIVE_RUN` | Defer | Exact active-run inventory, including runs older than 24 hours |
| `RECOVERY_ELIGIBLE_OBSERVE_ONLY` | Defer | Recovery predicates passed, but activation flags do not authorize a hold |
| `RECOVERY_AUTHORIZED` | Dispatch once | Durable hold bound to target head plus the source workflow's separate frozen head |
| `RECOVERY_DISPATCH_ACCEPTED` | Bind exact run | GitHub returned and the helper re-read the exact run ID, attempt, workflow, branch, and head |
| `RECOVERY_DISPATCHED` | Wait for target acceptance | Controller confirmed `RUN_BOUND` |
| `PRE_DISPATCH_NOT_STARTED` | Close hold, fail workflow | Positive evidence that no POST began |
| `DISPATCH_CONFIRMED_REJECTED` | Close hold, fail workflow | One definitive non-retryable GitHub 4xx response |
| `DEFERRED_NON_GREEN_MAIN` | Defer | Main moved or its newest exact `gate` is not green |
| `DEFERRED_AMBIGUOUS` | Preserve hold and defer | Any incomplete history, budget exhaustion, timeout, 5xx, 408/409/429, or post-send ambiguity |
| `MANUAL_REQUIRED_AFTER_MUTATION` | Block automation | Durable mutation marker or barrier; use the protected manual recovery evidence above |

### Bootstrap R2 publisher contract

The public bootstrap tiers use the dedicated private bucket
`worldmonitor-bootstrap`. Managed `r2.dev` access stays disabled and the bucket
has no custom domain; clients continue to enter through `/api/bootstrap` so the
WAF, origin policy, rate limits, telemetry, and future access controls remain in
the request path.

This service is an always-on publisher, not a Railway cron. Configure it with
`Dockerfile.publish-bootstrap-tiers` (the root application Dockerfile does not
contain the publisher) and start command
`node scripts/publish-bootstrap-tiers.mjs --loop`, **no cron schedule**, and
an empty watch-path list (whole-repository watching). It publishes both tiers
on startup, then fast every two minutes and slow every ten minutes. Keep Redis
authoritative: until the publisher and later rollout gates pass,
`/api/bootstrap` continues to serve its existing Redis assembly.

The environment contract is deliberately split by consumer:

| Scope | Variables | Install in | Capability |
|---|---|---|---|
| Shared routing and tier shape | `R2_ACCOUNT_ID`, optional `R2_ENDPOINT`, `R2_BOOTSTRAP_BUCKET=worldmonitor-bootstrap`, `IRAN_EVENTS_ENABLED` | Railway production and Vercel production | Names plus the feature flag that controls `iranEvents` tier membership; values must match |
| Publisher | `R2_BOOTSTRAP_ACCESS_KEY_ID`, `R2_BOOTSTRAP_SECRET_ACCESS_KEY` | Railway production publisher only | Publisher can PUT and GET only in `worldmonitor-bootstrap` |
| Edge reader | `R2_BOOTSTRAP_READ_KEY_ID`, `R2_BOOTSTRAP_READ_SECRET` | Vercel production only | Edge can GET; it cannot PUT or DELETE, and cannot read `worldmonitor-data` |

Preview and development do not receive either credential; missing credentials
must use the Redis path. The publisher must not fall back to any
`CLOUDFLARE_R2_*` account, bucket, key, secret, or API token. Never copy the
publisher credential into Vercel or the edge credential into Railway, and never
add a `VITE_` alias for any bootstrap R2 credential. Set
`IRAN_EVENTS_ENABLED` explicitly to the same value in both production services;
otherwise the publisher and edge handler resolve different tier contents.

Provision and release in this order:

1. Create the repo-root Railway service, install only the shared and publisher
   variables above, and confirm the live watch paths and lack of a cron schedule.
2. Deploy the publisher before enabling shadow measurement or serving from R2.
3. Parse both `fast.json` and `slow.json`, then verify `generatedAt` advances in
   two successive publishes for each tier.
4. Install only the shared and read-only variables in Vercel production. Keep
   them absent from preview and development.
5. Run the negative permission probes: publisher cannot access
   `worldmonitor-data`; edge cannot write/delete in `worldmonitor-bootstrap` and
   cannot read `worldmonitor-data`.

Rotate one consumer at a time: create a replacement token, update that consumer,
verify its publish or read with the replacement, then revoke the old token. On
suspected compromise, revoke first; Redis fallback preserves availability while
a replacement is issued. Never log, commit, or copy credential values into an
incident note.

### Merged does not mean deployed

`.github/workflows/seed-freshness-monitor.yml` runs every 15 minutes on the
default branch. Scheduled runs prefer the latest `main` commit whose `gate`
status is success. If HEAD is missing, pending, failed, or errored, the job
walks first-parent history and monitors the newest gated ancestor inside a
6-hour / 25-commit window. That is not a skip: the probe still runs against a
revision the repository gates accepted. The run fails closed only when no such
ancestor exists, or the newest one is older than the bound. Manual runs
execute directly.
Its one `monitor` job checks ingestion operational acceptance through
`scripts/check-seed-freshness.mjs`. It does not install Railway, audit Railway
configuration, classify deployment history, or imply that a merge reached a
container.

The probe is strict on every run, but the workflow conclusion is
transition-based. `scripts/update-seed-health-statuses.mjs` publishes one
durable `ingestion/seed/<source>` status on the historical operational anchor
`b93afd05d0f4ea2c465e79fd064e87fc1f9fb2f3`. The exact gated revision remains
the revision being observed, but it does not receive source-health statuses.
This separation prevents a continuing data incident from making Railway read
an unrelated deployable commit as a failed check suite.
A new failure, a changed failure class, an expired acknowledgement, a probe
transport error, or a malformed observation fails the workflow. The same
unchanged incident remains red on the anchor, appends no new status, and does
not create another generic failed run. This preserves the alarm while
separating "still broken" from "broke again".

Recovery is not inferred from a merge, image build, or elapsed time. The
publisher posts success only after the live compact-health observation stops
reporting that source. The first run after this status lifecycle is activated
imports the newest trusted legacy projection before it initializes the anchor,
so an incident that already exists does not become a false new alert. Later
exact repeats are quiet. The publisher also proves that the anchor is an
ancestor of the monitored revision before it writes any status.

The acceptance context is the completion marker and is always written last. If
GitHub accepts only part of a projection, the next poll overlays those trusted
partial statuses on the last complete projection, repairs the anchor, and does
not report an already-written source transition again.

Read the separate six-hourly `Railway Native Deploy Health` workflow for
production source, build, trigger, and deployment conclusions. A red Seed
Freshness run says the ingestion observation failed or could not be authorized.
A red Railway Native Deploy Health run says the fleet configuration or
deployment evidence failed. Neither workflow hides or gates the other's
conclusion.

The probe classifies every actionable problem, including `SEED_ERROR`,
`STALE_SEED`, `STALE_CONTENT`, and degraded composed coverage. Statuses that
explicitly end in `_ON_DEMAND` remain informational. It deliberately does not
run on an ingestion push because Railway may not have deployed or executed
that revision yet. This is the operational acceptance gate for the "merged and
green, but production data is still unhealthy" gap. A workflow failure means
new operational information or an unreadable control plane; the durable source
statuses on the operational anchor remain the current incident inventory
between transitions. A genuinely new or changed incident can still fail one
scheduled run; persistent incident state cannot be copied onto later main
commits.

#### Deploy-drift check

The permanent read-only surface is `.github/workflows/railway-deploy-drift.yml`
(`Railway Native Deploy Health`). It runs at minute 17 every six hours and on
explicit manual dispatch. One job reads the Viewer-safe source/build/deploy
projection once, audits it, and reuses the same evidence to check deployment
history and Git closure. It normally makes one bounded fleet-history request
after the per-service projection and performs direct history fallback only when
a service has no stable active-deployment baseline.

The job runs only for the literal `refs/heads/main`. It freezes the event SHA
against the checkout SHA, uses full Git history with a blobless filter, and
fails if the exact comparison commit cannot be fetched. It passes that
immutable commit with `--head`; a local manual
invocation without `--head` first refreshes the explicit `origin/main`
tracking ref and then resolves it, never the current feature-branch `HEAD`.

The workflow maps `RAILWAY_PRODUCTION_VIEWER_API_TOKEN` to
`RAILWAY_API_TOKEN` only on the combined read step. The
credential must belong to the dedicated Railway Viewer identity. It must not
be exposed to checkout, setup, dependency installation, or any command with
mutation authority. The deployment-only audit cannot query variables and
refuses `--apply`. It requires every repository source to keep
`source.checkSuites=false`; `true` is direct configuration drift because it
restores the check-suite deferral that this cutover removes. `Seed Freshness`
remains a separate ingestion monitor and must not install Railway, read Railway
configuration, or classify deployments.

```bash
node scripts/check-railway-deploy-drift.mjs --audit-deployment-config # add --json for the machine-readable form
```

The deployment check does not rediscover the live image by scanning through
days of skipped pushes. The same Viewer-safe service projection supplies each
service's `activeDeployments` as the running baseline. A fleet-wide deployment
stream then reads only far enough to cross the frozen comparison commit's
timestamp, which preserves newer `SKIPPED`, `FAILED`, and in-flight evidence.
Only a service with no active running source, or one whose source changes while
the two read-only snapshots are taken, falls back to a direct history read. If
the recent stream cannot cross the comparison timestamp, the check still fails
closed; it does not turn a capped or rate-limited read into health.

The watch-path filter is one way a merge fails to reach production; a GitHub
integration that stopped delivering (#6064) and a build that failed after the
merge landed are others. This check is deliberately agnostic about which. For
every service whose Railway source is this repository it takes the newest
deployment that actually reached a running state, reads `meta.commitHash` off
it, and asks whether that source contains everything that can reach the service.
Four verdicts can be healthy — `CURRENT`, `CURRENT_FOR_CLOSURE`, `AHEAD`,
`PENDING_BUILD` — but `AHEAD` is accepted only when the running commit is proven
reachable from the authorized current `main` ref. The problem set is derived
from the accepted verdicts by negation, so the
reported verdicts are `REJECTED_PUSH`, `BEHIND`, `CLOSURE_UNKNOWN`,
`BUILD_FAILED`, `UNKNOWN_SOURCE`, `UNKNOWN_STATUS`, `NO_DEPLOYMENTS`,
`NO_BUILD_IN_WINDOW`, `QUERY_FAILED`, and `AHEAD_LINEAGE_UNPROVEN`. The file's
header comment and exported constants are the exact semantics.

`CURRENT_FOR_CLOSURE` is what makes this compatible with watch-path filtering:
the service is not on head, and that is correct, because nothing it can see has
changed since. `REJECTED_PUSH` now means Railway refused a push that **did**
reach the service, and the reason Railway gave is printed with it — a
`CI check suite failed` refusal and a path refusal have different owners.

Two questions need local history: ancestry (`git merge-base --is-ancestor`) and
the diff between the commit each service is **running** and head. A service
legitimately weeks behind sits outside any fixed depth, so both workflows check
out full history with `filter: blob:none` — the diff walks trees and never needs
blobs. Never re-fetch with `--depth` afterwards: that re-shallows the clone and
strands exactly those commits. An unanswerable question reports the service
(`CLOSURE_UNKNOWN`) rather than excusing it.

The native-autodeploy target accepts no deploy-drift baseline. The legacy
baseline file and its application path are deleted. Every unknown, failed,
skipped, overdue, contradictory, or otherwise unaccepted result is directly
blocking; do not add a replacement suppression or a “warn and continue” path.

#### Recovering a stale service

In normal native-autodeploy operation, diagnose the red read-only monitor and
choose an explicit Railway action or roll back only the current migration
batch. Nothing retries or dispatches recovery automatically.

During the bounded legacy rollback window only, use **Railway Deploy Trigger
(Manual Rollback Only)**. Its manual dry-run reports the closure plan without
mutation; a non-dry-run dispatch is possible only while
`RAILWAY_RECONCILE_CUTOVER_ACTIVE=true`. Do not run the trigger script directly
for production recovery:

```bash
# Local inspection only; this cannot authorize a production mutation.
node scripts/trigger-railway-deploys.mjs --only <service-name> --dry-run
```

The workflow builds from an exact green `main` commit, so the resulting
deployment carries a SHA the drift check can compare. It is a no-op for a
service Railway already took. After the lease-aware cutover, non-dry-run direct
invocation fails closed: only the protected workflow can acquire the 30-minute
non-renewing owner lease and bind the attempt manifest. The script's remaining
local guarantees are still useful for previews:

- The deployed commit defaults to **`origin/main`**, never your local `HEAD`, so
  standing on a feature branch cannot ship it to production.
- A `--head` that is not reachable from `origin/main` is refused outright.
- `--only` throws on a name the fleet does not have rather than silently
  selecting nothing — a typo that reported "no service needs a build" would read
  exactly like a healthy fleet.

Run `git fetch origin` before a local preview so `origin/main` is current.

The rollback-only reconciliation control plane distinguishes two legacy
failure states:

- A runner-less or pre-mutation attempt owns no unbounded GitHub lock. Once any
  bounded `LEASED`/`PREPARED` lease expires and no dispatch hold is ambiguous,
  an operator may explicitly run the manual-only Watchdog in `dispatch` mode
  with both activation flags true. It never cancels the old run and has no
  schedule.
- Once `MUTATION_STARTED` is durable, a project/environment-wide barrier blocks
  every subsequent legacy mutation until the exact result passes terminal
  deployment convergence plus strict zero drift, or the protected **Railway
  Reconcile Manual Recovery** workflow records an audited resolution. Lease
  expiry alone never clears this barrier.

The Watchdog cannot create a hold or dispatch a new recovery unless both
`RAILWAY_RECONCILE_CUTOVER_ACTIVE` and
`RAILWAY_RECONCILE_AUTO_RECOVERY_ENABLED` are exactly `true`. Classification is
deliberately read-and-repair: if an earlier authorized watchdog or manual
recovery dispatch left a `DISPATCH_HELD` record, an explicit manual run may
bind its exact accepted workflow run or close it after definitive pre-dispatch
rejection. That repair is independent of both flags because it completes an
authorization that already exists; it never creates a hold or sends a dispatch.
The first flag enables the lease-aware mutation contract, while the second
permits the operator-invoked Watchdog to authorize one recovery.
`RECOVERY_AUTHORIZED`
means the controller persisted a one-use dispatch hold but has not yet
dispatched it;
`RECOVERY_DISPATCHED` means GitHub accepted the request and the controller
durably bound its exact workflow run and attempt. A green
watchdog run means only that observation did not poison `main`; authoritative
success is the replacement's final strict-acceptance step, including a verified
no-op. The run summary prints the current prior attempt or hold ID for protected
manual recovery.

The observer combines run summaries from the preceding 24 hours with separate
queries for every active target status, including runs that started before that
window. It repeats the active sweep around the history read and defers if the
inventory changes. With a durable mutation barrier, it reads attempt jobs only
for active and durably referenced runs because the barrier already forbids
recovery. After strict terminal acceptance, `lastAccepted.acceptedAt` retires
older failures while a failure that finishes after the watermark is still read.
Before the first trusted acceptance, it keeps the full fail-closed non-success
scan. It follows at most 10 pages per query, makes at most 250 GitHub API
requests, and bounds each request to 10 seconds. Durable barriers and dispatch
holds remain authoritative beyond that window; exhausting any read budget
defers recovery rather than dispatching on partial history.

Do **not** use `railway redeploy`: Railway documents it as rebuilding the most
recent deployment with the same code, so it cannot pick up a newer fixed commit.

`railway up` is not an ordinary recovery path. If the control plane itself is
unavailable, first disable every automated mutation entrant, inventory all
mutation jobs, wait for them to terminate, and preserve the durable state. A
separately audited manual action may be considered only after the 30-minute
lease plus the documented 5-minute termination grace, 1-minute clock/network
margin, and 6-minute safety margin have elapsed. Time does not override a
restored `MUTATION_STARTED` barrier. If an approved break-glass recovery still
requires `railway up`, use a **clean detached worktree at `origin/main`**:

```bash
git fetch origin
git worktree add --detach /tmp/railway-deploy origin/main
cd /tmp/railway-deploy
git rev-parse HEAD                       # must equal origin/main
railway up --service <service-name> --environment production --detach
```

An upload carries no commit SHA, so `check-railway-deploy-drift.mjs` reports
that service as `UNKNOWN_SOURCE` until the next git-triggered build replaces it.
That is expected after a recovery upload, not a second failure — and the deploy
trigger treats it as a reason to deploy, so it self-heals on the next run.

After any recovery path, verify the deployment commit SHA and the relevant
compact-health problem have both advanced. See Railway's official
[redeploy CLI reference](https://docs.railway.com/cli/redeploy) and
[deployment actions reference](https://docs.railway.com/deployments/deployment-actions).

`railway run` is also not production-network evidence: Railway documents it as
executing locally after injecting service variables. For an immediate long-cron
backfill, use a controlled temporary Railway cron execution, verify its terminal
run plus seed metadata and compact health, then restore the captured command and
schedule and rerun the operational-config audit. The full rollback-safe sequence
is documented in
[A merged seeder fix is not live until its cron fires](solutions/integration-issues/merged-is-not-ran-long-cron-seeders.md).

---

## How It Works

Each "bundle" is a single Railway cron service that replaces N individual services. The bundle script spawns each member seed sequentially via `child_process.execFile`, checking Redis `seed-meta:` timestamps to skip seeds that ran recently. Original seed scripts are unchanged.

The `derived-signals` bundle also owns the final China composition
(`seed-china-decision-signals.mjs`). It runs after the cross-Strait source lane,
calls the public six-domain RPC, publishes
`intelligence:china-decision-signals:v1`, and records
`seed-meta:intelligence:china-decision-signals`. It does not add providers or
recompute any source-domain method. Before rollout, run
`node scripts/audit-china-decision-parity.mjs`; after staging is deployed, pass
`--require-live --url <public-staging-api-base>`. Against production that live
probe is already enforced every six hours by
`.github/workflows/china-decision-parity-live.yml`, so the manual run is for
pre-production environments that workflow does not reach. The probe output is
intentionally sanitized to reachability, latency, generation time, and group
states.

**Graceful fetch failures:** `runSeed` now treats transient upstream fetch
failures as non-zero graceful failures after extending the last-good Redis TTL.
This applies to bundled members and standalone `runSeed` cron seeders: Railway
may mark that cron run failed, but `/api/health` and seed-contract probes still
read the preserved `seed-meta:` freshness. Alerting should either tolerate these
transient cron failures or key sustained data-health pages off those freshness
checks. Bundle member logs use `status=GRACEFUL_FAIL`; external log consumers
that match only `status=FAILED` should include `GRACEFUL_FAIL`. The bundle
summary still reports these under `failed:N`, so use per-section status when
distinguishing graceful upstream outages from hard failures.

**Standalone follow-up:** `scripts/seed-military-flights.mjs` and
`scripts/seed-service-statuses.mjs` still have manual graceful failure paths
that exit `0`. Track those separately if the standalone graceful-failure
contract needs to be made fully uniform beyond shared `runSeed` users.

**Per-bundle migration:**

1. Delete ONE old member first (to free a slot under the 100 limit)
2. Create the bundle service on Railway
3. Wait 2-3 cron cycles, verify `/api/health` shows OK for all member seeds
4. Delete remaining old member services
5. Monitor 24h before proceeding to next bundle

**Rollback:** Delete the bundle service, re-create individual services. Scripts are unchanged in the repo.

---

## Services to DELETE (46 total)

### Standalone service retired before bundle restoration

| # | Service Name | Service ID | Reason |
|---|---|---|---|
| 1 | seed-defense-patents (DISABLED) | `6f8bfd1b-7ccc-4db5-b03c-a2075b173e91` | Standalone remains deleted; producer restored in `seed-bundle-static-ref` using USPTO ODP |

### Replaced by seed-bundle-ecb-eu

| # | Service Name | Service ID | Original Cron |
|---|---|---|---|
| 2 | seed-ecb-fx-rates | `9cc81d27-745f-4925-a956-d9e0acacc8a2` | daily |
| 3 | seed-ecb-short-rates | `b695dd14-12fd-4493-a41b-30d50a9519d5` | daily |
| 4 | seed-yield-curve-eu | `b372da1c-e67d-44c0-ae23-4e391e75709b` | daily |
| 5 | seed-fsi-eu | `9c67552d-0a0a-409a-bf4f-571ac3f741c3` | weekly |

### Replaced by seed-bundle-portwatch

| # | Service Name | Service ID | Original Cron |
|---|---|---|---|
| 6 | seed-portwatch | `72b553c9-bf63-4905-ab47-706b0cc674e8` | every 6h |
| 7 | seed-portwatch-disruptions | `cb0aea5d-806b-49f9-85f3-b0a0e1372a26` | hourly |
| 8 | seed-portwatch-chokepoints-ref | `7907937c-5730-4768-a3cc-f4a3f555a9c5` | weekly |
| 9 | seed-portwatch-port-activity | `334303bb-41a2-4e66-9add-b1762fda9a1a` | every 12h |

### Replaced by seed-bundle-static-ref

| # | Service Name | Service ID | Original Cron |
|---|---|---|---|
| 10 | seed-submarine-cables | `fde66e2c-e542-47e0-8ff5-49026b229949` | weekly |
| 11 | seed-chokepoint-baselines | `de51db71-3492-4521-873c-90b9c08dd8b4` | infrequent (400d TTL) |
| 12 | seed-military-bases | `54b44749-c318-4392-aebe-aaf8308db1e9` | infrequent (one-time) |

### Replaced by seed-bundle-resilience

| # | Service Name | Service ID | Original Cron |
|---|---|---|---|
| 13 | seed-resilience-scores | `e87c212a-eab6-4a85-9e43-b855ca207823` | every 6h |
| 14 | seed-resilience-static | `e0709305-0270-4f53-b133-7d74e8260400` | annual window |

### Replaced by seed-bundle-derived-signals

| # | Service Name | Service ID | Original Cron |
|---|---|---|---|
| 15 | seed-correlation | `6cb62419-f354-419a-835c-67f494347680` | every 5min |
| 16 | seed-cross-source-signals | `57708db4-37a9-490e-98ee-dcdc783ce0f9` | every 15min |

### Replaced by seed-bundle-climate

| # | Service Name | Service ID | Original Cron |
|---|---|---|---|
| 17 | seed-climate-zone-normals | `01d57359-bccd-46f7-8b78-351040058f5f` | monthly |
| 18 | seed-climate-anomalies | `90095ed3-c9a8-4e42-b955-3b66fe288edb` | every 3h |
| 19 | seed-climate-disasters | `7a8e2384-925a-42c3-9767-c4cf14822985` | every 6h |
| 20 | seed-climate-ocean-ice | `05c54150-226f-471d-9938-90fde67a8f11` | daily |
| 21 | seed-co2-monitoring | `2a1cd437-fed3-4f74-b327-f2336ffcbb3f` | every 3 days |

### Replaced by seed-bundle-energy-sources

| # | Service Name | Service ID | Original Cron |
|---|---|---|---|
| 22 | seed-gie-gas-storage | `70a43803-f91e-4306-973c-b99ce29fb055` | daily |
| 23 | seed-gas-storage-countries | `a8dd33d5-ed2a-4462-97ef-3e9654920e19` | daily |
| 24 | seed-jodi-gas | `7b7c7198-60e0-48b4-8f9c-33036d530586` | monthly |
| 25 | seed-jodi-oil | `c0d829a5-42ce-4644-bd7d-94f93bf92e26` | monthly |
| 26 | seed-owid-energy-mix | `31303e69-ec86-4fa0-b956-0c5524f038a1` | monthly |
| 27 | seed-iea-oil-stocks | `8a05aaa6-8802-4221-ab3b-59001a4df5d3` | monthly |

### Replaced by seed-bundle-macro

| # | Service Name | Service ID | Original Cron |
|---|---|---|---|
| 28 | seed-bis-data | `8a2896ea-207e-4bef-8cd0-c6871df09a1d` | every 12h |
| 29 | seed-bls-series | `cf6f0bd4-3b09-4e77-b720-f2d08cb2c04f` | daily |
| 30 | seed-eurostat-country-data | `9314f05a-c9d6-4d5a-8af6-575da09174b0` | daily |
| 31 | seed-imf-macro | `5634de02-83ff-4ab1-8b88-aef73c4055e7` | monthly |
| 32 | seed-national-debt | `7ca57c8b-5d26-4a47-ba76-ae8f465eb0f3` | monthly |
| 33 | seed-fao-food-price-index | `c923b38f-3a52-4933-96d1-89443c8deda1` | daily |

### Replaced by seed-bundle-health

| # | Service Name | Service ID | Original Cron |
|---|---|---|---|
| 34 | seed-health-air-quality | `7be8c278-1c00-4761-adb5-85336ee4661b` | hourly |
| 35 | seed-disease-outbreaks | `12c8681b-6e82-464d-b6e5-6b397123643d` | daily |
| 36 | seed-vpd-tracker | `bd286f94-39f2-4341-895d-4ea6ea4d1905` | daily |
| 37 | seed-displacement-summary | `fed916c2-97bc-434b-ad2d-636121bcd70d` | daily |

### Replaced by seed-bundle-market-backup

| # | Service Name | Service ID | Original Cron | Also in ais-relay? |
|---|---|---|---|---|
| 38 | seed-crypto-quotes | `3bf34a40-e4dc-4fac-9fa6-8438118d0f53` | every 5min | Yes (Market loop) |
| 39 | seed-stablecoin-markets | `0410d0eb-81ee-46e0-a50f-8fd9de334ef8` | every 10min | Yes (Market loop) |
| 40 | seed-etf-flows | `6d907720-b274-4b4c-a2e5-a37e9161f349` | every 15min | Yes (Market loop) |
| 41 | seed-gulf-quotes | `ba1ad92b-1813-412d-b6e5-6c37f3f741c2` | every 10min | Yes (Market loop) |
| 42 | seed-token-panels | `a975dc1a-6ac3-4db0-89bf-bdcdecb92fde` | every 30min | Yes (Market loop) |

### Replaced by seed-bundle-relay-backup

| # | Service Name | Service ID | Original Cron | Also in ais-relay? |
|---|---|---|---|---|
| 43 | seed-climate-news | `c4875401-90b5-4738-ba64-6f27496d41a0` | every 30min | Yes (child spawn) |
| 44 | seed-usa-spending | `f420ca72-c41d-46aa-a151-0315ce45df2d` | hourly | Yes (Spending loop) |
| 45 | seed-ucdp-events | `6bce510f-d3a9-4252-b896-45aef3521cac` | every 6h | Yes (UCDP loop) |
| 46 | seed-wb-indicators | `ad9df8af-f27c-41db-a89d-f68f2fab2cf6` | daily | Yes (WB loop) |

---

## Services to CREATE (11 total)

All new services share these settings:

- **Root directory:** `.` (repo root, so `npm ci` installs all deps)
- **Build command:** (default nixpacks, uses `scripts/nixpacks.toml`)
- **Source branch:** `main`
- **Resources:** 1 vCPU / 1 GB RAM
- **NODE_OPTIONS:** `--dns-result-order=ipv4first`

**Watch paths:** Use `scripts/**`, `shared/**` for all bundles. `scripts/**` covers all seed scripts and their helpers. `shared/**` is needed because `loadSharedConfig()` in `_seed-utils.mjs` resolves `../shared/` (repo root) before `./shared/` (scripts dir), so config JSON files like `country-names.json`, `iso3-to-iso2.json`, and others live at the repo root `shared/` directory. Without `shared/**`, config-only edits won't trigger redeploys.

### Bundle 1: seed-bundle-ecb-eu

| Setting | Value |
|---|---|
| **Service name** | `seed-bundle-ecb-eu` |
| **Start command** | `node scripts/seed-bundle-ecb-eu.mjs` |
| **Cron schedule** | `0 13 * * *` (daily 13:00 UTC) |
| **Watch paths** | `scripts/**`, `shared/**` |
| **Replaces** | 4 services (ecb-fx-rates, ecb-short-rates, yield-curve-eu, fsi-eu) |
| **Net savings** | 3 slots |
| **Members** | ECB FX Rates (daily), ECB Short Rates (daily), Yield Curve EU (daily), FSI EU (daily) |

> **Why 13:00 UTC (not 06:00):** the daily ECB SDMX series (€STR, yield curve,
> CISS) are rebuilt during ECB's early-morning refresh window. A `0 6 * * *`
> run (08:00 CEST — exactly €STR's publication moment) intermittently hit that
> window and got empty/incomplete datasets, so those three sections failed
> gracefully (TTL extended, no data loss) while the bundle exited non-zero and
> showed red on Railway. 13:00 UTC (15:00 CEST) clears €STR (08:00 CET), the
> yield curve (~12:00 CET) and CISS morning publication. Changed 2026-07-01.

### Bundle 2: seed-bundle-portwatch

| Setting | Value |
|---|---|
| **Service name** | `seed-bundle-portwatch` |
| **Start command** | `node scripts/seed-bundle-portwatch.mjs` |
| **Cron schedule** | `0 */1 * * *` (hourly) |
| **Watch paths** | See `scripts/railway-services.json` (exact runtime closure; run `node scripts/audit-railway-watch-paths.mjs`) |
| **Replaces** | 4 services |
| **Net savings** | 3 slots |
| **Members** | Disruptions (hourly), Main (6h), Port Activity (12h), Chokepoints Ref (weekly) |

### Bundle 3: seed-bundle-static-ref

| Setting | Value |
|---|---|
| **Service name** | `seed-bundle-static-ref` |
| **Start command** | `node scripts/seed-bundle-static-ref.mjs` |
| **Cron schedule** | `0 3 * * *` (daily at 03:00 UTC) |
| **Watch paths** | `scripts/**`, `shared/**` |
| **Replaces** | 4 services (including the retired defense-patents producer) |
| **Net savings** | 3 slots |
| **Members** | Defense Industrial Base (10d), Submarine Cables (weekly), Defense Patents (weekly), Chokepoint Baselines (400d, runs rarely), Demographics Capability (20d) |
| **Wall-time budget** | `maxBundleMs: 570_000` in `scripts/seed-bundle-static-ref.mjs`. The five members reserve 545s in total, including the runner's 10s kill grace for each member (110 + 100 + 190 + 70 + 75). The runner starts every freshness gate concurrently; its heartbeat plus the slowest three-read gate have 20s of bounded preflight, leaving 5s for process overhead. Therefore **every due member is admissible on every tick**. Do not add another member without moving or reducing measured work; that would restore the starvation the split removed. |
| **Required variable** | `USPTO_API_KEY=${{shared.USPTO_API_KEY}}` |

Defense Patents is an intentional data-series migration, not a continuation of
the former grant/issue series. USPTO ODP Patent File Wrapper records represent
applications, so `date` is the application filing date and `abstract` remains
empty for wire compatibility. The producer marks the discontinuity with
`sourceVersion: uspto-odp-v1` and `schemaVersion: 2`; operational comparisons
must not treat pre-migration grant dates and post-migration filing dates as one
continuous metric.

Defense Industrial Base writes `military:industrial-base:v1` from World Bank
`MS.MIL.*` series and `military:arms-suppliers:v1` from SIPRI-derived five-year
supplier shares. Both values have a 30-day TTL. Each source is eligible every
10 days, and the daily service evaluates that interval before day 10, which
keeps the canonical TTL above the three-refresh safety floor. The sources run
as separate bounded processes under a 570-second bundle budget, so one failure
cannot block the other source's publication. A SIPRI portal failure preserves
last-good supplier rows with their original timestamps. A separate
SIPRI-completion marker stays old after a partial pass, so the next daily tick
retries the portal instead of treating the partial pass as complete.
Strict health-probe registration is a staged follow-up after the first Railway
run publishes both seed-meta keys; the follow-up must cite real Railway
pre-seed evidence under the health-probe cutover contract.

Demographics Capability publishes `demographics:capability:v1` from three
independently settled stages: UN WPP age structure, UNESCO UIS indicators via
World Bank WDI, and ILOSTAT industrial workforce data. A failed stage retains
only its prior section and its original fetch timestamp. The 20-day eligibility
window keeps the 30-day data TTL alive while the observation-year content clock
detects old source material.

### Bundle 3 heavy: seed-bundle-static-ref-heavy (live, #6806)

Arms-Suppliers (460s worst case) and Military-Bases (410s) cannot share a 570s
tick — Railway kills a cron container at 10 minutes, so that ceiling is not
negotiable. They CAN share a bundle: the runner defers whichever loses the tick
to the next daily fire, and at 10-day and 30-day cadences a one-day deferral
costs nothing. One service carries all three heavy members instead of three
1-section services, because Railway caps a project at 100 and the fleet is at 82.

| Setting | Value |
|---|---|
| **Service name** | `seed-bundle-static-ref-heavy` |
| **Start command** | `node scripts/seed-bundle-static-ref-heavy.mjs` |
| **Cron schedule** | `0 4 * * *` (daily 04:00 UTC, staggered off leftover's 03:00) |
| **Lifecycle** | active — service `6285c37b-1327-46f1-bfd0-7454612764fb`, provisioned 2026-08-19, first tick published `bundle:heartbeat:static-ref-heavy` at 2026-08-20T04:01:04Z |
| **Members** | Mineral-Production (180s / 60d), Arms-Suppliers (370s / 14d), Military-Bases (400s / 30d) |
| **Wall-time budget** | `maxBundleMs: 570_000` |
| **Required variable** | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `CLOUDFLARE_R2_ACCOUNT_ID` and one of `CLOUDFLARE_R2_TOKEN` / `CLOUDFLARE_API_TOKEN`. `USPTO_API_KEY` stays on leftover. The R2 pair is NOT optional here: `scripts/data/military-bases-final.json` is gitignored and the service has no volume, so without it Military-Bases falls back to the published version and exits non-zero once that is past its 30-day interval (#6845). |
| **Heartbeat** | `bundle:heartbeat:static-ref-heavy` |

**The lead slot rotates by day and that is load-bearing.** A member that never
publishes never stops being due, so a fixed order hands it the first slot every
single tick. That is not hypothetical: Arms-Suppliers has never written
`seed-meta:military:arms-suppliers-complete`, and on 2026-08-18 it took 371s of
leftover's budget, leaving 177s against Mineral-Production's 190s reservation —
deferring it by 13 seconds on the tick its acknowledgement expired. The bundle
rotates `dayIndex % 3` (days since epoch, not `getUTCDay()`, which stutters
across the week boundary and would give one member two consecutive lead days),
so each member leads every third tick and a permanently failing member can
consume at most one lead slot in three. `seed-bundle-macro.mjs` uses the same
device for the same reason.

Start commands in this table keep the `scripts/` prefix so they match the other
bundle rows and the registry-coverage grep. Railway's actual start command is
`node seed-bundle-static-ref-heavy.mjs` because `deployMode:
nixpacks-root-scripts` sets `rootDirectory` to `scripts/`. It was cloned from
`seed-bundle-static-ref` and carries its own service id
`6285c37b-1327-46f1-bfd0-7454612764fb`, not leftover's
`4dd3934d-e5f7-4af8-b34b-c1796226800b`. The 04:00 stagger is intentional — a
400s job at 03:00 would contend Redis / R2 / upstreams with leftover.

Provisioning a repository-backed service is only half the job: it must also be
enrolled in `scripts/railway-native-autodeploy-fleet.json` and lose its
`lifecycle: planned` row, or `Railway Native Deploy Health` fails closed with
`unexpected repository service(s)` and stops checking the whole fleet. Set
`source.checkSuites` to `false` at the same time — a clone inherits Railway's
`true` default, and wait-for-CI reads the head commit's entire check suite, so
any red check anywhere strands this service's builds.

### Bundle 4: seed-bundle-resilience

| Setting | Value |
|---|---|
| **Service name** | `seed-bundle-resilience` |
| **Start command** | `node scripts/seed-bundle-resilience.mjs` |
| **Cron schedule** | `0 */6 * * *` (every 6h) |
| **Watch paths** | `scripts/**`, `shared/**` |
| **Replaces** | 2 services |
| **Net savings** | 1 slot |
| **Members** | Resilience Scores (6h), Resilience Static (annual window Oct 1-3, skips most runs), Food Stocks (monthly USDA PSD + FAOSTAT fill; needs `USDA_FAS_PSD_API_KEY`) |
| **Wall budget** | 570 seconds, below Railway's 10-minute container kill. Section timeouts are 240s / 420s / 480s, so each fits the budget once the runner's 10s kill grace is added. Resilience Scores stays first in the array: it is the member that keeps `resilience:ranking:v27` and `resilience:intervals:v10:*` alive between cron fires, so it must be offered the budget before the heavier annual and monthly members. |
| **Do not** | raise any section timeout above `maxBundleMs - 10_000`. A section whose timeout plus kill grace exceeds the budget is deferred on **every** tick while the bundle still exits 0 — #6556 ran this service dead for six hours behind a green badge. `tests/bundle-budget-admission.test.mjs` fails the PR, and `runBundle` refuses to start, but the arithmetic is worth knowing before you edit. |

### Bundle 5: seed-bundle-derived-signals

| Setting | Value |
|---|---|
| **Service name** | `seed-bundle-derived-signals` |
| **Start command** | `node scripts/seed-bundle-derived-signals.mjs` |
| **Cron schedule** | `*/5 * * * *` (every 5 min) |
| **Watch paths** | See `scripts/railway-services.json` (exact runtime closure; run `node scripts/audit-railway-watch-paths.mjs`) |
| **Replaces** | 2 services |
| **Net savings** | 1 slot |
| **Members** | Correlation (5min), Cross-Source Signals (15min), Cross-Strait Activity (3h), China Decision Signals (15min), Regional Snapshots (6h) |
| **Required env** | `JAPAN_MOD_PROXY_URL` or `PROXY_URL` (Cross-Strait Activity's Japan MOD exit; the section declares an any-of group, so either satisfies it and only an environment with neither fails as `CONFIG_ERROR`) |
| **Note** | Cross-Strait Activity is the only direct external-source member; it uses bounded MND/Japan MOD requests and a 3h freshness gate. China Decision Signals validates and republishes the bounded public composition after reading its domain lanes. Other members are Redis-derived. The bundle enforces a 570s wall-time admission budget so a non-fitting due section defers before Railway's 10-minute container limit. |

#### Staged correlation runtime modes

Correlation uses one Redis control key, `correlation:runtime-mode:v1`, whose
value is a JSON object with one strict field, for example
`{"mode":"legacy"}`, `{"mode":"exact"}`, or `{"mode":"fuzzy"}`.
The browser reads the public `GET /api/correlation-runtime-mode` contract with
`cache: "no-store"` at startup and before every correlation refresh. The
correlation seeder reads the Redis key again on every compute cycle; it does not
reuse a previous cycle's decision.

Every missing key, malformed JSON or shape, unknown mode, missing Redis
credentials, failed Redis request, non-OK browser response, or failed browser
payload parse resolves to `legacy`. `legacy` remains the current keyword
clustering behavior. Exact entity clustering and fuzzy resolution are staged
follow-ups owned by #5984 and #5989; this control slice does not activate either
mode or change live configuration.

Changing the key is an operational activation or rollback and requires separate
operator approval. Keep that approval, the observed validation evidence, and
the rollback decision outside the code deployment; the code path is only the
fail-closed read and hand-off contract.

#### Japan MOD discovery surface and recovery gate

The official discovery URL is the Japanese Joint Staff homepage,
`https://www.mod.go.jp/js/`. The runtime makes one direct request and, after a
transport failure or an empty allowlisted index, one request through
`JAPAN_MOD_PROXY_URL` (falling back to `PROXY_URL`). It never downloads linked
PDFs during a scheduled run.

**Japan MOD's Cloudflare rule is path-level, not egress-level.** Measured
2026-08-01, from both direct egress and the configured Decodo path:

| Path | Result |
|---|---|
| `https://www.mod.go.jp/js/` | 200, 33,419 bytes, 9 `/js/pdf/2026/` links |
| `https://www.mod.go.jp/js/pdf/2026/*.pdf` | 200, `application/pdf` |
| `https://www.mod.go.jp/js/press/index-en.html` | 403 `Just a moment...` |
| `https://www.mod.go.jp/js/index-en.html` | 403 |
| `https://www.mod.go.jp/js/index.html` | 403 |
| `https://www.mod.go.jp/js/press/` | 403 |
| `https://www.mod.go.jp/js/en/` | 403 |

Note that `/js/` succeeds while `/js/index.html` does not. Cloudflare fronts the
succeeding path too — the 200 response carries a `window.__CF$cv$params` beacon —
so this is a rule that exempts `/js/`, not a zone the CDN does not cover.
Changing the discovery URL to any other path on this host is a regression, not a
refinement. This is the general lesson for other Japanese government sources:
probe the bare directory before concluding the host is blocked.

**Do not derive an English companion PDF by inserting `e` before `.pdf`.** The
English series carries its own counter, so the mapping resolves to unrelated
releases. Measured 2026-08-01:

| Document | Content |
|---|---|
| `p20260730_01.pdf` (JA) | 中国海軍艦艇の動向について — Chinese Navy, Renhai/Jiangkai II |
| `p20260730_01e.pdf` | "Russian aircraft activity around Japan" (July 27) |
| `p20260730_03e.pdf` | "Chinese Military Activities" — the real counterpart |

That day Japanese published `_01`/`_02` while English published `_01e`–`_05e`.
Every check that mapping would be validated against — HTTP 200,
`application/pdf`, `%PDF` magic, Joint Staff publisher marker — passes on the
*wrong* document, so it cannot be validated into correctness. The correct
counterpart is only resolvable from the English index, which is the surface
Cloudflare blocks. `parseJapanModIndex` therefore accepts only
`/js/pdf/<year>/p<YYYYMMDD>_<NN>.pdf`, which structurally excludes the English
series, and the source reports
`companionResolution: english_index_blocked_no_derivable_companion`.

Discovery records candidates for manual review; it never admits an observation.
`admittedDocumentCount` counts hand-reviewed rows and `unreviewedCandidateCount`
counts the discovered backlog. A 200 carrying no allowlisted release is
`JMOD_INDEX_EMPTY`, not success.

The blocked English index stays wired as `shadowIndexUrl`: a direct probe that
runs at most once per 24 hours, only after the homepage request already
succeeded. It is diagnostic only — it never contributes to `requestCount`,
`errorCodes`, `transportStatus`, or `lastSuccessAt`. Watch
`shadowIndexProbe.status` flip from `blocked` to `reachable`; that is the signal
that English provenance can be restored and the `+e` constraint above revisited.
`candidates` and `shadowIndexProbe` are operator-only and stripped from the
anonymous bootstrap projection.

If a future provider change is needed instead, the concrete external dependency
for the current provider is an active
[Decodo Site Unblocker](https://help.decodo.com/docs/site-unblocker-quick-start)
subscription with source-specific credentials and a successful target test. The
ordinary residential gateway credential is not a substitute for that product. If
the provider requires disabling TLS verification, do not weaken the adapter;
provision a trusted provider CA or use an approved authenticated HTTPS
integration instead.

Recovery is accepted only when:

1. `crossStraitActivityJapanMod` reports `OK` for two consecutive scheduled
   three-hour runs from distinct scheduled executions;
2. `lastSuccessAt` is non-null, later than the deploy, and advances between
   those two successful runs;
3. the published `_seed.sourceVersion` reads
   `taiwan-mnd-html+japan-joint-staff-homepage-v3`, proving the resilient
   homepage-discovery adapter is the code that ran rather than a
   merged-but-not-deployed PR;
4. the source reports `transportMode: japanese_homepage_candidate_discovery`
   and at least one newly discovered candidate tied to each successful fetch —
   retained rows do not count;
5. the combined cross-Strait publication remains available and explicitly
   source-degraded when a later Japan MOD request fails.

### Bundle 6: seed-bundle-climate

| Setting | Value |
|---|---|
| **Service name** | `seed-bundle-climate` |
| **Start command** | `node scripts/seed-bundle-climate.mjs` |
| **Cron schedule** | `0 */3 * * *` (every 3h) |
| **Watch paths** | `scripts/**`, `shared/**` |
| **Replaces** | 6 services |
| **Net savings** | 5 slots |
| **Members** | Natural Events (3h, EONET/GDACS/NHC/HKO), Zone Normals (monthly, skips ~359/360), Anomalies (3h, depends on zone-normals), Disasters (6h), Ocean Ice (daily), CO2 Monitoring (3 days) |
| **Note** | Zone-normals runs before anomalies (dependency ordering) |

### Bundle 7: seed-bundle-energy-sources

| Setting | Value |
|---|---|
| **Service name** | `seed-bundle-energy-sources` |
| **Start command** | `node scripts/seed-bundle-energy-sources.mjs` |
| **Cron schedule** | `30 7 * * *` (daily 07:30 UTC) |
| **Watch paths** | `scripts/**`, `shared/**` |
| **Replaces** | 6 services |
| **Net savings** | 5 slots |
| **Members** | GIE Gas Storage (daily), Gas Storage Countries (daily), JODI Gas (monthly), JODI Oil (monthly), OWID Energy Mix (monthly), IEA Oil Stocks (monthly) |

### Bundle 8: seed-bundle-macro

| Setting | Value |
|---|---|
| **Service name** | `seed-bundle-macro` |
| **Start command** | `node scripts/seed-bundle-macro.mjs` |
| **Cron schedule** | `0 8 * * *` (daily 08:00 UTC) |
| **Watch paths** | `scripts/**`, `shared/**` |
| **Replaces** | 6 services |
| **Net savings** | 5 slots |
| **Members** | BIS Data (12h), CBR Rates (daily), BoC Valet (daily), StatCan WDS (daily), China Macro (36h), China Release Calendar (36h), China Policy Events (6h), BIS Extended (12h), BLS Series (daily), Eurostat (daily), Eurostat House Prices (7d), Eurostat Government Debt (2d), Eurostat Industrial Production (daily), IMF Macro (30d), National Debt (30d), FAO FFPI (daily), World Bank External Debt (30d), BIS LBS (7d), FATF Listing (30d), Education Attainment (7d) |
| **Wall budget** | 570 seconds. The runner defers a section when its timeout plus 10-second kill grace cannot fit before Railway's 10-minute limit. Education stays last on six UTC days so a persistent failure in the new flag-dark producer cannot starve established production members; it gets first priority each Sunday UTC so sustained production load cannot defer its first envelope forever. |

### Bundle 9: seed-bundle-health

| Setting | Value |
|---|---|
| **Service name** | `seed-bundle-health` |
| **Start command** | `node scripts/seed-bundle-health.mjs` |
| **Cron schedule** | `0 */1 * * *` (hourly) |
| **Watch paths** | `scripts/**`, `shared/**` |
| **Replaces** | 4 services plus the China control-plane evaluator |
| **Net savings** | 3 slots |
| **Members** | China Coverage (hourly), Air Quality (hourly), Disease Outbreaks (daily), VPD Tracker (daily), Displacement (daily) |

### Bundle 10: seed-bundle-market-backup

| Setting | Value |
|---|---|
| **Service name** | `seed-bundle-market-backup` |
| **Start command** | `node scripts/seed-bundle-market-backup.mjs` |
| **Cron schedule** | `*/5 * * * *` (every 5 min) |
| **Watch paths** | See `scripts/railway-services.json` (exact runtime closure; run `node scripts/audit-railway-watch-paths.mjs`) |
| **Replaces** | 5 services |
| **Net savings** | 4 slots |
| **Members** | Crypto Quotes (5min), Hyperliquid Flow (5min), Stablecoin Markets (10min), ETF Flows (15min), Market Correlation Series (15min), China Corporate Disclosures (30min), China Stock Connect (60min), Gulf Quotes (10min), Token Panels (30min), Gold ETF Flows (2h), Gold CB Reserves (daily), SEC CIK Map (daily), SEC 8-K Stream (30min) |
| **Required env** | `PROXY_URL` (required independently by Gulf Quotes / ETF Flows and selected for an exchange only when its source-specific setting is absent). Proxy configuration precedence is `SSE_PROXY_URL` → `SZSE_PROXY_URL` → `PROXY_URL` for SSE and `SZSE_PROXY_URL` → `PROXY_URL` for SZSE; the process selects the first non-empty setting rather than attempting each URL sequentially. This is the deployment contract; production provisioning and live fallback acceptance require separate verification. |
| **Note** | Crypto Quotes, Stablecoin Markets, ETF Flows, Gulf Quotes, and Token Panels back up ais-relay inline loops. Hyperliquid Flow, Market Correlation Series, China Corporate Disclosures, China Stock Connect, Gold ETF Flows, Gold CB Reserves, SEC CIK Map, and SEC 8-K Stream are primary in this bundle. China Corporate Disclosures reads official metadata only: SSE uses direct then the selected proxy, while SZSE uses direct then distinct port attempts within the selected proxy. China Stock Connect reads aggregate exchange statistics over direct then the selected proxy only — it stops short of the edge hop, because a seeder fetches upstream data and the web tier serves it from Redis, and borrowing an edge function's egress for acquisition inverts that. It additionally caps every `www.szse.cn` request in a run under one shared 100s wall-clock budget, because its SZSE endpoints are date-keyed and the number of probes depends on how many sessions the exchange has published. Gulf Quotes uses Alpha Vantage (richer than relay's Yahoo-only). |

### Bundle 11: seed-bundle-relay-backup

| Setting | Value |
|---|---|
| **Service name** | `seed-bundle-relay-backup` |
| **Start command** | `node scripts/seed-bundle-relay-backup.mjs` |
| **Cron schedule** | `*/30 * * * *` (every 30 min) |
| **Watch paths** | `scripts/**`, `shared/**` |
| **Replaces** | 4 services |
| **Net savings** | 3 slots |
| **Members** | Climate News (30min), USA Spending (hourly), Global Tenders (hourly), UCDP Events (6h), WB Indicators (daily) |
| **Note** | Existing members are backups for ais-relay inline loops/child spawns; Global Tenders is hosted directly in this bundle. Each seed's freshness gate skips when the canonical data is already fresh. |

---

## Registry-covered live resilience services

These live Country Resilience services are not slot-saving consolidation
migrations and should not be counted in the 35-slot savings plan above. They
are listed here so their Railway start commands are first-class registry-covered
entries.

### seed-bundle-resilience-recovery

| Setting | Value |
|---|---|
| **Service name** | `seed-bundle-resilience-recovery` |
| **Start command** | `node scripts/seed-bundle-resilience-recovery.mjs` |
| **Cron schedule** | Monthly recovery cadence; use the active Railway schedule for the existing service |
| **Watch paths** | `scripts/**`, `shared/**` |
| **Purpose** | Dedicated Country Resilience recovery inputs bundle |
| **Members** | Fiscal Space, Reserve Adequacy, External Debt, Import HHI, Fuel Stocks, Re-export Share, Sovereign Wealth |
| **Note** | This is the service referenced by the Import-HHI controls below. It is registry-covered so nixpacks packaging and start-command drift are tested. |

### seed-bundle-resilience-energy-v2

| Setting | Value |
|---|---|
| **Service name** | `seed-bundle-resilience-energy-v2` |
| **Start command** | `node scripts/seed-bundle-resilience-energy-v2.mjs` |
| **Cron schedule** | `0 6 * * *` (daily 06:00 UTC; per-slot interval gates real seeds to 7 days) |
| **Watch paths** | `scripts/**`, `shared/**` |
| **Purpose** | Dedicated Country Resilience energy-v2 input bundle |
| **Members** | Low Carbon Generation, Fossil Electricity Share, Power Losses |
| **Note** | Daily cron avoids the weekly dead window described in `scripts/seed-bundle-resilience-energy-v2.mjs`; the bundle's 7-day section intervals prevent unnecessary World Bank polling. |

---

## Services that STAY unchanged (54 total)

### Infrastructure (4)

| Service | ID | Type |
|---|---|---|
| Postgres | `8a5871b9-5ca9-4551-8343-aef7fa67b8a4` | Database |
| Postgres-azIG | `3ea8ae20-44f4-49bd-a363-76b0adec8dcd` | Database |
| Valkey | `651a4b62-e224-47c2-9f7c-64e35908c44a` | Cache |
| umami | `d7620480-e05a-4c09-b210-05166c3c0e59` | Analytics |

### Long-running services (4)

| Service | ID | Type |
|---|---|---|
| worldmonitor (ais-relay) | `a5f66d97-217f-44a0-a42d-5f3b67752223` | AIS relay + inline seeds |
| notification-relay | `aa37bd8e-c28d-4e9b-9d1e-0961f1b63d97` | Notification dispatch |
| simulation-worker | `67264e35-0b51-457b-984f-4ef20e36a117` | Forecast simulations |
| deep-forecast-worker | `750bc68f-9840-49a3-95eb-7c8bcc060485` | Deep forecast tasks |

### Consumer prices pipeline (3)

| Service | ID | Type |
|---|---|---|
| seed-consumer-prices | `2a369c41-cc5c-486a-a8d7-f0ca552e27a8` | Scraper |
| seed-consumer-prices-publish | `4492a338-cb37-40da-9e98-95a8d67e49c9` | Redis publisher |
| seed-consumer-aggregate | `4fdd1078-7884-48f8-92fc-06b390d0fdc4` | Index calculator |

### Standalone seed crons (43, not bundled)

| # | Service | ID | Why not bundled |
|---|---|---|---|
| 1 | digest-notifications | `01d644b8-057f-4040-a50e-500bd684daa8` | Notification dispatch, not a data seed |
| 2 | seed-airport-delays | `444e9cc0-4eb2-4820-b430-3228e6ce9568` | Unique aviation domain |
| 3 | seed-aviation | `a8e49386-64c1-4e1e-9f82-4eb69a55fce3` | Different keys from relay's aviation loop |
| 4 | seed-bigmac | `e8269317-c717-498b-adcf-be693a2bb8d3` | Weekly, web scraping via Exa |
| 5 | seed-chokepoint-exposure | `12e8e87d-1214-4ba3-a813-709f279a5ba9` | Derived from Comtrade flows |
| 6 | seed-conflict-intel | `e4188e09-ae3b-4398-bb24-04f4b4b48b52` | Fast cadence (15min), notifications |
| 7 | seed-cot | `23b2597f-1989-4904-9018-b3722a9e1bc2` | Weekly CFTC data |
| 8 | seed-cyber-threats | `fd27928b-0b9b-45d6-b056-92fa2f5d60a6` | Relay disabled its loop, cron is sole source |
| 9 | seed-earnings-calendar | `cd07f48e-6433-4847-9f7b-1f05d062e619` | Finnhub, different domain |
| 10 | seed-earthquakes | `5a953848-0678-4946-8ea0-b2269914ea12` | Independent seismology |
| 11 | seed-economic-calendar | `555fc987-a043-4f64-bfa3-c827157ec706` | FRED + Eurostat + Fed/ECB scrape |
| 12 | seed-economy | `565a66c1-662d-4a3a-b8e2-83b79d75dbe4` | Already multi-section (11+ keys) |
| 13 | seed-electricity-prices | `1aee77cd-3af9-4640-a78d-e957c322adc0` | ENTSO-E + EIA, large dataset |
| 14 | seed-ember-electricity | `67e01a64-d3cb-4b53-bf7d-cd5d223323b3` | Large CSV download |
| 15 | seed-energy-intelligence | `9c2135c6-d638-4137-955a-8819c4d969f6` | RSS parsing |
| 16 | seed-energy-spine | `a6c1d05f-a639-4470-829d-9337ffbdcbbe` | Composite from other seeds |
| 17 | seed-fear-greed | `fcff514b-7b32-46c2-9413-0a48bcf4968e` | Composite index, unique sources |
| 18 | seed-fire-detections | `1ebe342b-074b-4fb5-b012-c1dbfdef1971` | Feeds thermal-escalation |
| 19 | seed-forecasts | `9bcbf89e-2785-452b-b59f-144b4863bd95` | LLM-heavy, long runtime |
| 20 | seed-fuel-prices | `8d966e58-e01c-42cf-8d28-b85fd5d45460` | EU XLSX download |
| 21 | seed-fx-rates | `5221253d-a22e-4560-a3db-ea4634c2049a` | Shared dependency for other seeds |
| 22 | seed-gdelt-intel | `3472577e-dff4-49f9-bc17-f32c2f366f75` | 15-minute bulk GKG/export materializer |
| 23 | seed-gpsjam | `16949dc7-b908-4740-bfbe-74a213db7c0b` | GPS interference monitoring |
| 24 | seed-grocery-basket | `c8438692-843d-46ae-bee7-8c19e6847fa4` | Web scraping via Exa |
| 25 | seed-hormuz | `e6156007-e917-4139-90bd-71b6333a6d0e` | Power BI scraping |
| 26 | seed-infra | `c615c211-1237-47cc-8d90-e23657437838` | Warm-ping to Vercel |
| 27 | seed-insights | `d1e092bb-6a5b-4225-8043-8ed93ccff268` | LLM-dependent |
| 28 | seed-internet-outages | `5a07e099-14d8-42aa-ad6e-e66631fdd19f` | Cloudflare Radar |
| 29 | seed-iran-events | `5d294bd6-7943-4454-aa9c-eb90bd9d9124` | Iran-focused aggregation |
| 30 | seed-military-flights | `7953a066-0627-4550-b72c-d2aceb33fbd3` | Real-time tracking, live/stale keys |
| 31 | seed-military-maritime | `88768189-f80b-4615-87d1-dbc7803a6a28` | USNI warm-ping |
| 32 | seed-natural-events | `7119c932-05f5-4727-a54f-e4e2de2a907f` | NASA EONET + GDACS + NHC |
| 33 | seed-prediction-markets | `96fabace-d56d-4854-8096-3f5bcfe0d88a` | Polymarket anti-bot measures |
| 34 | seed-radiation-watch | `3b76bb85-637c-43b7-ab90-5dee288f8bca` | EPA + Safecast |
| 35 | seed-regulatory-actions | `249ae8df-5746-4cdb-9978-ec61dce9121f` | Financial regulator RSS |
| 36 | seed-research | `ab850199-4d48-4af8-9681-aafbe2f31b8e` | arXiv + HN + GitHub |
| 37 | seed-sanctions-pressure | `e1686cdf-980f-426d-b5f2-a7757729fe9b` | 120MB+ XML streaming |
| 38 | seed-security-advisories | `8fb9c6b7-0ae9-441b-ae02-0f31baa3aed6` | 24 advisory feeds |
| 39 | seed-supply-chain-trade | `d7cc29f0-691b-40fd-84f2-ce8e8f12b567` | Already multi-section |
| 40 | seed-thermal-escalation | `71d124d5-a4fb-42c3-9c5b-2fb0e5645e5b` | Derived from fire detections |
| 41 | seed-trade-flows | `dd3097f7-df65-4b0e-89ca-86a5fac7d558` | UN Comtrade, 6 reporters |
| 42 | seed-unrest-events | `33c8c2a1-ad66-45ec-ac7e-609d69a59455` | ACLED + materialized GDELT bulk events |
| 43 | seed-webcams | `2bf93afa-1922-4f9c-936d-f5054051b8a5` | Paginated across 8 regions |

**Inventory check:** 4 infra + 4 long-running + 3 consumer + 46 delete + 43 standalone = **100**

---

## Standalone seed crons added after this snapshot

> These data seeds were added **after** the 2026-04-10 inventory above. The rows
> marked **planned** are registry/documentation entries for services that are
> not provisioned in production; they remain excluded from the live audit and
> `--apply` until an explicit lifecycle activation. The four planned rows below
> are repository-root `nixpacks-root-repo` cron candidates (root directory
> `.`, start command `node scripts/<file>`), so their eventual packaging can
> include valid imports outside `scripts/`. Active rows must instead follow the
> deploy mode and exact `watchPatterns` recorded in `scripts/railway-services.json`.
> These rows are intentionally **not** part of the 100-service inventory count
> above and are registered in `scripts/railway-services.json` with deploy mode
> `nixpacks-root-repo`.
>
> **Cadence below is inferred from each seed's cache TTL** as a documentation
> aid; confirm the live cron schedule and Service ID against the Railway
> dashboard before relying on it. Rows showing a **bold cron expression with a
> verified date** were read from the Railway API rather than inferred.
>
> To verify one yourself (reads `cronSchedule` for every service in the
> project; the CLI stores the token at `~/.railway/config.json`):

```bash
railway whoami   # confirm you are logged in, then query the API:
node -e "const c=require(require('os').homedir()+'/.railway/config.json');
fetch('https://backboard.railway.com/graphql/v2',{method:'POST',
 headers:{'Content-Type':'application/json',Authorization:'Bearer '+(c.user.token||c.user.accessToken)},
 body:JSON.stringify({query:'query(\$id:String!){project(id:\$id){services{edges{node{name serviceInstances{edges{node{cronSchedule}}}}}}}}',
 variables:{id:'29419572-0b0d-437f-8e71-4fa68daf514f'}})})
 .then(r=>r.json()).then(d=>d.data.project.services.edges.forEach(e=>{
   const cs=e.node.serviceInstances.edges.map(x=>x.node.cronSchedule).filter(Boolean);
   if(cs.length)console.log(e.node.name.padEnd(40),cs.join(','));}))"
```

| Service | Start command | Inferred cadence | Domain |
|---|---|---|---|
| seed-aaii-sentiment | `node scripts/seed-aaii-sentiment.mjs` | weekly (7d TTL) | AAII bull/bear investor sentiment survey |
| seed-market-quotes | `node scripts/seed-market-quotes.mjs` | **planned — not provisioned** | Equity index / stock bootstrap quotes (Yahoo + Finnhub + Alpha Vantage) |
| seed-commodity-quotes | `node scripts/seed-commodity-quotes.mjs` | ~30 min (30m TTL) | Commodity + extended-gold bootstrap quotes |
| seed-crypto-sectors | `node scripts/seed-crypto-sectors.mjs` | **planned — not provisioned** | CoinGecko crypto sector performance |
| seed-market-breadth | `node scripts/seed-market-breadth.mjs` | daily (30d history window) | S&P 500 breadth (% above 20/50/200-day, Barchart) |
| seed-weather-alerts | `node scripts/seed-weather-alerts.mjs` | **planned — not provisioned** | NWS active weather alerts |
| seed-fx-yoy | `node scripts/seed-fx-yoy.mjs` | daily (25h TTL) | Wide-coverage FX YoY + 24m drawdown (resilience FX-stress inputs) |
| seed-comtrade-bilateral-hs4 | `node scripts/seed-comtrade-bilateral-hs4.mjs` | **`0 6 1 * *` (monthly, verified 2026-07-27)** | UN Comtrade bilateral HS4 trade flows — only scheduled consumer of the keyed 500/mo Comtrade quota |
| seed-hs2-chokepoint-exposure | `node scripts/seed-hs2-chokepoint-exposure.mjs` | periodic (TTL-extended) | HS2 chokepoint trade-exposure (derived) |
| seed-service-statuses | `node scripts/seed-service-statuses.mjs` | **planned — not provisioned** | Service-status warm-ping; primary seeder is the AIS relay loop |

The bilateral HS4 cron uses `COMTRADE_API_KEYS` and a 480-request hard budget
under the provider's 500-call monthly quota. The authenticated route requests
one four-year window (`Y-2` through `Y-5`) in each of two HS4 batches and keeps
the newest row per product/partner. The public-preview fallback cannot accept
that period list and tries `Y-2`, then `Y-3`. A 24-day freshness gate prevents
accidental repeat runs; health reports `COVERAGE_PARTIAL` below 110 country
shards and stale after 35 days. Country payloads live for 40 days so a missed
monthly tick becomes visible before last-good data expires.

**Not standalone services (documented here to avoid confusion):**

- `scripts/seed-chokepoint-flows.mjs` — spawned in-process by the AIS relay
  (`ais-relay.cjs`), not deployed as its own cron.
- `scripts/seed-military-maritime-news.mjs` — this is the script behind the
  existing `seed-military-maritime` standalone cron (USNI/NGA warm-ping) listed
  in the inventory above.

---

## Execution Order (recommended)

Start with lowest-risk, highest-savings bundles.

| Order | Bundle | Slots Freed | Risk | Cron Frequency |
|---|---|---|---|---|
| 1 | seed-bundle-ecb-eu | 3 | Low (daily, same API) | Daily |
| 2 | seed-bundle-static-ref | 3 | Low (daily tick, static data) | Daily |
| 3 | seed-bundle-resilience | 1 | Low (6h, annual window) | 6h |
| 4 | seed-bundle-portwatch | 3 | Medium (hourly, 4 members) | Hourly |
| 5 | seed-bundle-climate | 4 | Medium (3h, 5 members) | 3h |
| 6 | seed-bundle-energy-sources | 5 | Medium (daily, 6 members) | Daily |
| 7 | seed-bundle-macro | 5 | Medium (daily, 18 members) | Daily |
| 8 | seed-bundle-health | 3 | Medium (hourly, 5 members) | Hourly |
| 9 | seed-bundle-derived-signals | 1 | Medium (5min bundle; one bounded 3h external member) | 5min |
| 10 | seed-bundle-market-backup | 4 | Low (backup for relay) | 5min |
| 11 | seed-bundle-relay-backup | 3 | Low (backup for relay) | 30min |

**Running total:** 3 + 3 + 1 + 3 + 4 + 5 + 5 + 3 + 1 + 4 + 3 = **35 slots freed**

---

## Verification Checklist (per bundle)

After deploying each bundle and before deleting old services:

- [ ] Bundle service shows "Active" in Railway dashboard
- [ ] First cron fire produced logs (check Railway logs)
- [ ] Logs show expected `[Bundle:X] Starting (N sections)` and `Finished` lines
- [ ] Each member seed shows `Done` or `Skipped` (not all `failed`)
- [ ] `/api/health` shows OK for all member seed-meta keys (not STALE_SEED)
- [ ] Wait at least 2 full cron cycles before deleting old services
- [ ] After deleting old services, verify health still shows OK on next cycle

---

## Env Vars

Each bundle service inherits the same env vars as the individual seeds it replaces. Copy these from any existing seed service in Railway:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `NODE_OPTIONS=--dns-result-order=ipv4first`
- Plus any API keys used by member seeds (GIE_API_KEY, ICAO_API_KEY, etc.)
- `SAM_GOV_API_KEY` for the Global Tenders SAM.gov adapter. The other initial procurement adapters do not require credentials.

The simplest approach: use Railway's "shared variables" or copy all env vars from the `worldmonitor` (ais-relay) service, which has a superset of all API keys.

---

## Import-HHI Comtrade 429 Runbook

Issue #3979 covers the residual operational failure mode for the Country Resilience Index `importConcentration` dimension: AE/RU/NO/CH can still remain absent from `resilience:recovery:import-hhi:v1` when UN Comtrade rejects the monthly recovery bundle for key budget, pacing, or reporter metadata reasons.

**Decision:** treat this as Comtrade quota/pacing while the seed logs show HTTP 429 or quota-exhausted HTTP 403 responses. Do not change `importConcentration` scoring until the rate-limit path has been addressed and a force-refresh proves that Comtrade is returning non-quota responses for the watched reporters.

### Controls

Set these on the Railway service that runs `node scripts/seed-bundle-resilience-recovery.mjs`:

| Variable | Default | Use when |
|---|---:|---|
| `COMTRADE_API_KEYS` | required | Add keys first when multiple reporters are missing with 429s or quota-exhausted 403s. |
| `IMPORT_HHI_PER_KEY_DELAY_MS` | `1500` | Increase to `10000`-`15000` if logs still show import-HHI 429s. `PER_KEY_DELAY_MS` is accepted as a legacy alias. |
| `IMPORT_HHI_MAX_CONCURRENCY` | key count | Set to `1` if quota failures look IP-level or global, not per-key. |
| `IMPORT_HHI_VERBOSE` | unset | Set to `1` only for a diagnostic force-refresh; logs per-reporter status. |

Reporter cohort splitting is the last resort. Prefer more `COMTRADE_API_KEYS`, then wider per-key delay, then lower concurrency. The import-HHI seeder fetches the watched #3979 reporters first when they are missing, so a replenished force-refresh should recover AE/RU/NO/CH before unrelated registry backfill can consume the hourly provider budget. Aggressive incident pacing such as `IMPORT_HHI_PER_KEY_DELAY_MS=15000` with `IMPORT_HHI_MAX_CONCURRENCY=1` can exceed the 30-minute bundle window; that mode intentionally relies on checkpoint/resume across ticks, not one-pass completion. Cohort splitting should only be used if a single full pass still exhausts the provider budget after the first three controls.

The import-HHI publish gate requires AE/RU/NO/CH as well as the normal country-count floor. If one of those watched reporters is still absent, the seed run fails validation with `emptyDataIsFailure: true`, does not refresh seed-meta, and leaves the bundle eligible to retry instead of stranding a fresh-but-incomplete canonical payload for the full monthly interval.

If a watched reporter is still missing and the seed log says `status=200 rows=0`, stop treating that reporter as a key-budget problem. Inspect Comtrade reporter metadata, data availability, and query-shape filters (`customsCode`, `motCode`, `cmdCode`) before considering any scoring change. The known non-M49 reporter-code exceptions are pinned in `scripts/shared/comtrade-reporter-overrides.json`; as of the #3979 follow-up this includes Norway (`NO=579`) and Switzerland (`CH=757`). Russia (`RU=643`) currently needs the seed-only stale period fallback (`Y-5..Y-8`) because Comtrade returns zero annual import rows for the standard `Y-1..Y-4` window but still exposes 2018 rows.

### Force-Refresh

After deploying a pacing/key-budget change, bypass the 30-day freshness gate:

```bash
IMPORT_HHI_VERBOSE=1 FORCE_RESEED=true node scripts/seed-recovery-import-hhi.mjs
```

Then warm live scores so `importConcentration` reads the refreshed canonical key:

```bash
API_BASE_URL=https://api.worldmonitor.app \
WORLDMONITOR_SEED_REFRESH_KEY=<seed-refresh-key> \
WORLDMONITOR_API_KEY=<read-key> \
node scripts/seed-resilience-scores.mjs
```

`WORLDMONITOR_SEED_REFRESH_KEY` is required: the resilience score seeder uses it
for the seed-only `get-resilience-ranking?refresh=1` recompute path. Keep
`WORLDMONITOR_API_KEY` or `WORLDMONITOR_VALID_KEYS` available too so laggard
per-country score warms can fall back to the normal premium read endpoint. In
Railway, the service environment should already provide the Upstash Redis
credentials; for a local force-run, export `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN` as well.

If the run is fixing missing interval data, the success signal is the
`seed_complete` log for `domain="resilience:scores"` with
`intervalsWritten > 0` and no `status="ERROR"`. A failed interval recovery
sets `status="ERROR"` plus `intervalFailureReason` and includes the diagnostic
counts `intervalMissingScorePayloadCount`, `intervalStaleScorePayloadCount`,
`intervalInvalidScorePayloadCount`, `intervalMalformedScorePayloadCount`,
`intervalFormulaSkipCount`, and `intervalPayloadSkipCount`.

Verify the public audit surfaces after the run:

```bash
curl -fsS https://api.worldmonitor.app/api/resilience/v1/get-runtime-manifest \
  | jq '{formulaTag, rankingCache, constructVersions, intervals}'
curl -fsS https://api.worldmonitor.app/api/health \
  | jq '.checks.resilienceIntervals'
```

Pass condition for interval recovery: runtime manifest reports
`intervals.available=true`, and `/api/health` reports
`resilienceIntervals.status="OK"` with `records > 0`.

### Verification

Verify both Redis and the live score API:

```bash
WORLDMONITOR_API_KEY=<key> node scripts/verify-import-hhi-coverage.mjs
```

Pass condition for AE/RU/NO/CH:

- `resilience:recovery:import-hhi:v1.countries.<ISO2>` is present.
- `seed-meta:resilience:recovery:import-hhi` is fresh.
- Live `GetResilienceScore` has `importConcentration.coverage > 0`.
- Live `importConcentration.imputationClass` is empty.

If the live API key is not available during Redis-only triage, use:

```bash
IMPORT_HHI_VERIFY_REDIS_ONLY=1 node scripts/verify-import-hhi-coverage.mjs
```

Redis-only verification is not sufficient to close #3979; it only confirms that the seeder recovered the canonical payload before score warmup.
