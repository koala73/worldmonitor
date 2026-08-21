---
title: Railway defers deploys on a red check suite, not on watch paths
date: 2026-08-04
category: integration-issues
module: railway-seeders
problem_type: integration_issue
component: development_workflow
symptoms:
  - "A seeder helper changed on green main, but Railway kept running an older source deployment"
  - "Seed metadata became stale even though the repository fix had merged"
  - "Railway recorded the deferral only as a deployment whose status is SKIPPED and whose meta.skippedReason reads 'CI check suite failed'"
  - "The deploy-drift check reported most of the fleet as REJECTED_PUSH on every merge"
root_cause: config_error
resolution_type: workflow_improvement
severity: high
tags: [railway, seeders, watch-paths, deployment, health-monitoring]
---

# Railway defers deploys on a red check suite, not on watch paths

> **Correction (2026-08-04, #6142).** This document first concluded that
> Railway's Watch Paths filter refuses pushes that plainly match its glob, and
> that no closure width was safe. Re-measured across the whole fleet, that is
> wrong — the filter is essentially exact. The real mechanism is Railway's
> *other* skip reason, and the original 100%-of-filtered-services figure was an
> artefact of the drift check demanding that a filtered service run HEAD. The
> superseded reasoning is kept under "What Didn't Work" because the wrong model
> is easy to re-derive from a single service's deployment list.

## Problem

Railway records a refused push as a deployment whose status is `SKIPPED`,
carrying `meta.commitHash` and `meta.skippedReason`. Nothing in the repository
read that reason, so two completely different events looked identical, and the
loud one was the harmless one.

Measured 2026-08-04 across all 77 repository-built services, 7,391 path-reason
skips and 600 commits of `main`:

| `skippedReason` | count | what it is |
|---|---|---|
| `No changes to watched files` | 7,391 | the filter working |
| `CI check suite failed` | 1,504 | a deferral nothing was watching |

**The watch-path filter is not the defect.** Replaying every path-reason skip
against the service's own configuration:

- **7,331** were plainly correct — the commit touched nothing the service
  watches.
- **57** matched a watch pattern but every matched file lay *outside the
  service's build context*. A `nixpacks-root-scripts` service is built with the
  context rooted at `scripts/`, so a repository-root `shared/` change cannot
  alter that image no matter what its patterns say. Several such services list
  `shared/**`, which is unreachable by construction. Skipping them is correct.
- **3** were the registry declaring a closure that had not been applied to
  Railway yet, so Railway matched against its older, narrower filter.
- **0** unexplained.

That is a 0.04% disagreement rate, all of it explained.

**The real lag source is the check suite.** Railway also refuses to build a
commit whose GitHub check suite is failing, and it reads the *whole* suite —
including scheduled workflows that re-report onto `main`'s head SHA long after
the merge gates went green. `monitor` (Seed Freshness Monitor), `security-audit`
and `umami-postgres` were each observed doing exactly this.

Merge-to-build lag over the 6,037 (service, closure-touching commit) pairs in
that window — that is, counting only merges a service actually needed:

| cohort | n | p50 | p90 | max |
|---|---|---|---|---|
| all | 6,037 | 0.01h | 1.40h | 16.0h |
| Railway just built it | 4,966 | 0.01h | 0.01h | 16.0h |
| `CI check suite failed` | 1,068 | 1.04h | 4.70h | 9.9h |
| `No changes to watched files` | 3 | 2.68h | 2.69h | 2.69h |

And it is **self-reinforcing**: the Seed Freshness Monitor goes red precisely
when the fleet is behind, and its redness is then one of the checks that keeps
Railway from deploying the fleet forward.

The 16.0h maximum is `umami`, which has no filter at all — that is the separate
GitHub-webhook outage in #6064, and it is why the drift check is deliberately
agnostic about cause.

**Why the first measurement read 100%.** The original figure counted a service
as behind whenever it was not running `HEAD`. Under a watch-path filter that is
the normal, correct steady state: a filtered service runs the newest commit that
changed something it can see, and every merge since is none of its business.
Every `SKIPPED` record then looked like a rejection, so all 62 filtered services
reported `REJECTED_PUSH` — and the p90 of 19.0h was the wait until an *unrelated*
merge happened to rebuild them, which is not a defect at all.

## Symptoms

- The repository contains the fix while the running Railway deployment still
  points at an older commit.
- Compact health reports `STALE_SEED` after the affected producer misses enough
  scheduled runs.
- A data key may expire before the staleness threshold and surface through the
  existing `EMPTY` health alert instead.
- The only record of the deferral is a `SKIPPED` deployment carrying a
  `meta.commitHash` and a `meta.skippedReason`. It is not an error, not a
  notification, and not visible on the service's status badge.

## What Didn't Work

- **Reading every `SKIPPED` record as a refusal — the conclusion this document
  previously reached.** It produced a 100%-of-filtered-services figure, a
  19.0h p90, and a 62-entry suppression baseline, all of which measured the
  filter doing its job. The tell was available and missed: `meta.skippedReason`
  was right there in the same record, and 17% of skips carried a reason that has
  nothing to do with paths.
- **Concluding "no closure width is safe" from one service.**
  `seed-conflict-intel` has the most careful closure in the fleet (24 exact
  paths) and the highest skip *rate*, which reads as damning until you notice
  that a narrow closure is supposed to skip more. Replayed against its own
  configuration, 173 of its 174 path skips were correct and the last one was
  config-apply lag. A rate is not evidence without the denominator.
- **Clearing every filter.** Considered and rejected on cost: roughly 75
  build-minutes per push to main across 77 services, about 2,250 build-minutes a
  day at ~30 merges, and three always-on services (ais-relay,
  notification-relay, scenario-worker) restarting on every merge, dropping the
  AIS websocket connections among them. It also fixes nothing — the dominant
  cause defers the build regardless of which paths matched.
- Adding a newly missed helper only in Railway fixes one deployment but leaves
  repository and production configuration able to drift again.
- `railway redeploy` rebuilds the most recent deployment with the same source;
  it does not select a newer commit from main. `railway up` uploads a directory
  and records no commit at all, so every service recovered that way reads as
  `UNKNOWN_SOURCE` afterwards.
- Treating a healthy compact-health response without a `problems` field as
  malformed creates a false alert. The endpoint intentionally omits that field
  when there are no problems.

## Decision

1. The closures in `scripts/railway-services.json` **stay as they are**, and now
   for a reason that survives measurement: they are accurate, Railway honours
   them, and they keep unrelated merges from rebuilding the fleet.
2. The drift check becomes **closure-aware**. "Not running HEAD" is not drift
   for a filtered service; "not running everything that can reach it" is. That
   removes the false alarms rather than suppressing them.
3. Change detection moves into CI for the cases Railway defers:
   `scripts/trigger-railway-deploys.mjs` deploys exactly the services whose
   closure changed, gated on `main`'s own required-gate status rather than on
   Railway's reading of the whole check suite. That is
   [#6142](https://github.com/koala73/worldmonitor/issues/6142).

This does not remove the safety Railway's check-suite rule was providing — it
replaces the rule with the repository's own definition of green, which is the
same `gate` status branch protection requires.

## Solution

### Keep operational status off deployable commits

The Seed Freshness Monitor observes the newest gated `main` revision but writes
its durable `ingestion/seed/*` projection to the fixed historical merge commit
`b93afd05d0f4ea2c465e79fd064e87fc1f9fb2f3`. That commit introduced the
transition publisher, is required to be an ancestor of the observed revision,
and cannot become a future deployment candidate.

This keeps the protection without recreating the lag source described above:
a new or materially changed incident still fails one monitor run, the anchor
keeps the source status non-green until live recovery, and unchanged polls
append nothing. The first anchored run imports the newest trusted legacy
projection from recent first-parent history, so already-active incidents move
to the anchor without being reported as new failures. Because the acceptance
context is written last, a later poll can also distinguish an empty anchor from
a partial write, repair that write, and avoid reporting the same transition
twice.

Do not move this projection back to `main`, a gated ancestor selected for the
probe, or any other commit Railway may be asked to deploy. GitHub commit status
is deployment input in this repository, not only an observability surface.

### The audit: the registry contract, unchanged

`scripts/railway-services.json` remains the repository-side contract. Each
managed seeder records its exact cron and repository-relative runtime dependency
closure, and the closure contract test in
`tests/railway-watch-path-audit.test.mjs` walks imports from each entry point
and fails when a new dependency is absent, so a declared closure cannot silently
fall behind the code it claims to cover.

The live guard is `scripts/audit-railway-watch-paths.mjs`. Audit mode compares
the registry with production cron schedules, watch paths, service presence, and
required source-routing variables. `--apply` refuses partial or unroutable
changes, sends one minimal environment-config patch, and waits for the
eventually consistent read-back before succeeding.

Registry coverage is opt-in, so the audit **also** sweeps every live seeder the
registry does not manage (`isSeederService`) and requires it to watch
`BROAD_WATCH_PATTERNS` — `scripts/**` + `shared/**` — or the whole repository,
via `unmanagedWatchPatternDrift`. Without that sweep the audit only ever
inspected the services that had opted in, and still printed "audit passed".

What this layer establishes is that the live trigger configuration matches what
the repository declares. It cannot establish that a merge was delivered. That is
the next layer.

### The closure: one definition, two callers

`scripts/railway-deploy-closure.mjs` answers "can this change reach this
service", and both the drift check and the CI trigger import it, because two
implementations of that question drift into disagreeing about the same service.

Two rules in it are not obvious and are each pinned by a replay test built from
real production verdicts:

- **Build context first.** A changed path outside the service's
  `source.rootDirectory` is not in the image, so no watch pattern can make it
  relevant. This is what explains 57 of the 60 apparent refusals, and skipping
  it makes the matcher disagree with Railway on every scripts-rooted service
  that lists `shared/**`.
- **Registry ∪ live, never one or the other.** The registry is edited in a PR
  and only reaches Railway when someone runs the audit with `--apply`, so
  between those two events each source knows a path the other does not. The
  remaining 3 apparent refusals sat in exactly that window. A union is wrong
  only in the direction that builds too much.

Everything uncertain resolves to "this change reaches the service": an
unsupported glob shape, a commit git cannot reach, a service neither source
describes. Over-reporting costs a build; under-reporting silently strands a
service on old code.

### The CI trigger: deploy what the merge actually changed

`scripts/trigger-railway-deploys.mjs` runs from
`.github/workflows/railway-deploy-trigger.yml` and, per service, asks whether
anything reaching it changed between the commit **it** is running and main's
head. If so, and Railway has not already taken that commit, it deploys via
`serviceInstanceDeployV2`, which pins the exact SHA and returns a deployment id.

It is a reconciler, not a push handler. Judging each service against its own
running commit makes the run idempotent, removes any dependence on
`github.event.before`, and self-heals after a failed trigger, a webhook outage,
or a manual `railway up` recovery — none of which a push-shaped trigger
recovers from.

**What wakes it (#6203, #6378).** One offset ten-minute schedule plus protected
manual dispatch. The former `workflow_run` on every **Deploy Gate** completion
produced 577 target runs in one measured day, including 273 failed or cancelled
runs. The watchdog then exhausted its 250-request budget while reading every
non-success job and became blind to the durable mutation barrier it was meant
to report.

The schedule gives the three-hour liveness window 18 opportunities and every
tick re-reads the exact current `main` SHA and newest `gate` status before it can
touch Railway. GitHub schedules remain best-effort, so missing ticks do not
count as success: a window with no completed strict acceptance stays red. The
bounded cadence also keeps a first-activation 24-hour history below the
watchdog request ceiling.

**Why workflow success is not reconciliation success.** "Railway returned a
deployment ID", "nothing needed a build", and "the fleet reached terminal
zero-drift convergence" can all end in a green GitHub workflow unless the
acceptance boundary is explicit. The lease-aware design records a versioned
intent/result digest chain, waits every triggered or adopted deployment to an
allowed terminal state, then runs strict exact-head drift with no pending-build
acceptance and no baseline suppression. Only the final strict-acceptance step
refreshes reconciliation liveness. A verified no-op also reaches terminal
acceptance; a skipped/contended/trigger-only run does not.

The liveness observer is a separate **Railway Deploy Trigger Watchdog** on an
offset best-effort schedule. It remains observe-only unless both the
lease-aware target cutover flag and `RAILWAY_RECONCILE_AUTO_RECOVERY_ENABLED`
are exactly true. `RECOVERY_AUTHORIZED` names the durable-hold boundary before
the actions-write job; it is not reported as observe-only or dispatched. When
enabled, the watchdog may dispatch one correlated replacement for stale green
`main`, but has no
code path to cancel, force-cancel, rerun, or approve an existing run. A
runner-less orphan may remain visible forever without blocking production: it
owns no workflow-level production lock and any later runner must contend for
the same bounded Durable Object lease.

The watchdog treats the durable control record as its history boundary. An
active mutation barrier needs only active and explicitly referenced run jobs,
because that barrier already forbids recovery. After strict terminal
acceptance, `lastAccepted.acceptedAt` retires older failures while failures that
finish after the watermark are still hydrated. Before the first acceptance it
keeps the full fail-closed non-success scan.

GitHub evidence is bounded instead of rescanning the permanent Actions archive.
The watchdog combines a 24-hour target-workflow summary window with separate
queries for every active status, repeats the active sweep around the history
read, and defers if that inventory changes. Its durable barrier and strict
acceptance watermark bound which attempt jobs need hydration, under a 10-page
ceiling, 250-request ceiling, and 10-second per-request timeout. The protected
recovery reader uses exact run IDs when supplied and applies its own
page/request/time bounds. An exhausted budget fails closed.

The dormant control-plane foundation does not retire the existing
`scripts/check-railway-reconcile-age.mjs` alarm: the unchanged target workflow
and Seed Freshness Monitor continue to require a recent successful reconcile.
Only the lease-aware cutover transfers stale-run ownership to the independent
watchdog, and that cutover must land before either activation flag is enabled.

The safety boundary changes at the first possible provider call. A dead
`LEASED`/`PREPARED` owner becomes recoverable only after its fixed lease expires.
`MUTATION_STARTED` raises one project/environment-wide barrier which lease
expiry cannot clear; failed or unreadable terminal verification leaves every
automatic head blocked until matching strict proof or the protected **Railway
Reconcile Manual Recovery** workflow records an immutable, evidence-bound
resolution. Pre-action observer faults warn without adding another red check to
`main`; post-mutation verification remains truthfully failing.

Rollout is credential-fenced, not inferred from merged YAML. The control Worker,
watchdog, verifier primitives, and manual surface land dormant first. The target
workflow remains on its legacy credential/concurrency contract until operators
disable it, drain every legacy run, provision the protected environments and
independent route credentials, revoke the legacy Railway token, and land the
lease-aware cutover. Keep `RAILWAY_RECONCILE_CUTOVER_ACTIVE=false` through that
drain; operator-authorized retries fail before changing control state while the
target still has the legacy input contract. CI green before those gates is
readiness, not deployed or production-verified recovery.

Two things it deliberately does not do:

- It does not re-trigger a build Railway already ran and **failed**. That is a
  real failure the drift check reports as `BUILD_FAILED`; retrying it here would
  bury the alarm under a retry loop.
- It does not run when `main`'s `gate` status is not green. A *pending* gate
  defers to the next run; a *failed* one reds the workflow.

### The drift check: did the merge actually land

`scripts/check-railway-deploy-drift.mjs` is deliberately agnostic about *why* a
merge did not reach production: a refused push (this issue), a GitHub
integration that stopped delivering (#6064), and a build that failed after the
merge landed all produce the same finding. For every service whose Railway
source is this repository — `isRepositoryService`, shared with the audit so both
files have one definition of "ours" — it takes the newest deployment that
actually reached a running state (`RUNNING_STATUSES`: `SUCCESS`, `REMOVED`,
`CRASHED`, `SLEEPING`), reads `meta.commitHash` off it, and asks whether that
source contains everything that can reach the service.

Four verdicts are healthy — `CURRENT`, `CURRENT_FOR_CLOSURE`, `AHEAD`,
`PENDING_BUILD` — and `isProblemVerdict` derives the problem set from them by
negation rather than enumerating it, so a verdict added later is a problem until
someone decides otherwise. The reported problems are `REJECTED_PUSH`, `BEHIND`,
`CLOSURE_UNKNOWN`, `BUILD_FAILED`, `UNKNOWN_SOURCE`, `UNKNOWN_STATUS`,
`NO_DEPLOYMENTS`, `NO_BUILD_IN_WINDOW` and `QUERY_FAILED`. Read the file's
header comment and exported constants for the exact semantics of each.

`CURRENT_FOR_CLOSURE` is the verdict that makes this check compatible with
watch-path filtering at all: the service is not on head, and that is correct,
because none of the merges since touch anything it contains. `CLOSURE_UNKNOWN`
is its fail-to-noise partner — the checkout could not reach the running commit,
so the question went unanswered and the service stays reported.

`REJECTED_PUSH` now means something sharper than it did: Railway refused a push
that **did** reach this service. A refusal of a commit the container cannot see
is the filter working and no longer produces a verdict, and the reason Railway
gave is carried into the detail line so a check-suite deferral and a path
refusal stay distinguishable.

Three details in that file are load-bearing and easy to get wrong:

- The build grace (`DEFAULT_BUILD_GRACE_MS`, 30 minutes) is spent on a
  **commit**, never on a service. The caller resolves the newest commit older
  than the window and every service must be running that commit or a
  descendant. Excusing a service because head happens to be young would have
  gone green on the whole fleet on any run that followed a merge — including
  for `umami`, which was already a day stale.
- `git merge-base --is-ancestor` cannot answer from a shallow checkout, and its
  non-zero exit means both "no" and "that object is missing". Both collapse to
  "cannot prove it", which keeps the service reported rather than excused.
- The closure comparison needs history back to the commit each service is
  **running**, which for a service legitimately weeks behind on code it does not
  contain sits outside any fixed fetch depth. Both workflows therefore check out
  full history with `filter: blob:none` — the diff walks trees and never needs
  blobs. Re-fetching with `--depth` afterwards would re-shallow the clone and
  strand exactly those commits, so neither workflow does.

The original implementation used
`scripts/railway-deploy-drift-baseline.json` and ran deployment drift inside
`Seed Freshness Monitor`. That design is retired. The permanent monitor accepts
no deployment suppression: every unknown, failed, overdue, contradictory, or
otherwise unaccepted result is directly red.

`.github/workflows/railway-deploy-drift.yml` now owns one combined read-only job:
the Viewer-safe source/build/trigger audit and deployment-history drift share a
single per-service projection. It runs every six hours and on manual dispatch,
only on `main`, with deployment tracking disabled for its GitHub environment.
`Seed Freshness Monitor` owns ingestion acceptance only and no longer installs
Railway or reports a fleet conclusion.

The deployment job checks out full history with `fetch-depth: 0` and a blobless
filter, freezes the event SHA, and refreshes the explicit `origin/main` tracking
ref before evaluating ancestry. An `AHEAD` deployment is healthy only when its
running commit is proven reachable from the authorized current `main` ref;
otherwise it reports `AHEAD_LINEAGE_UNPROVEN`.

### Still true, and unchanged

Routing variables that a source resolves as `SOURCE_SPECIFIC || PROXY_URL`
are declared as a nested any-of group in `requiredEnv`, matching the shape
`scripts/_bundle-runner.mjs` accepts. Declared flat, the gate demands *both* and
reports drift for a service routing perfectly well on its source-specific exit —
stricter than the runtime it guards.

The separate `scripts/check-seed-freshness.mjs` probe accepts the healthy compact
response shape where `problems` is absent and fails for every actionable
production problem, not only `STALE_SEED`. On-demand sources are excused only in
the states being on-demand actually explains — absent, or zero records. A fault
status (`SEED_ERROR`, `STALE_SEED`) on an on-demand key still blocks: softening
those is how `marketImplications` sat at 8.2x its staleness budget for 16+ hours
undetected (see the `ON_DEMAND_KEYS` policy block in `api/health.js`). A
genuinely accepted degradation goes in `scripts/seed-freshness-baseline.json`
instead, where it carries an owner issue and an expiry date.

## Why This Works

The layers answer different questions. The audit bounds what the live trigger
configuration is allowed to be. The closure says what can reach a service. The
trigger acts on that. The drift check reads the SHA Railway is actually running
and does not care which cause produced a gap — a refusal, a webhook outage
(#6064), or a build that failed after the merge landed all produce a finding.

Everything is compared against a positive statement: "this service is running
everything that can reach it". An unreadable status, an unanswerable ancestry
question, a running commit the checkout cannot reach, or a query that failed
reports the service instead of vouching for it. That direction is the reason the
closure change removes false alarms without opening a hole — the *only* value
that excuses a service is a computed, positively-evidenced "nothing reaching it
changed", and every other outcome still reports.

Measured against production on 2026-08-04 at `cf3ac8777`, switching the check to
the closure moved 8 services from `REJECTED_PUSH` to `CURRENT_FOR_CLOSURE` and
left every genuinely-behind service reported — and all 53 remaining
`REJECTED_PUSH` verdicts carried `skippedReason: CI check suite failed`, not one
a path refusal.

`Seed Freshness Monitor` keeps the gate-dependent ingestion acceptance. A
missing, pending, failed, or errored head gate is not a green skip and is not
an ingestion failure: the job monitors the newest gated ancestor in the
window, and fails closed only when none exists. It deliberately does not run
on an ingestion push because Railway may not have deployed or executed that
revision yet.

Its live health probe remains fail-closed on every actionable source problem.
The scheduled workflow now projects that strict result into durable
`ingestion/seed/<source>` statuses. A new or changed problem fails one run;
unchanged later observations keep the source status red without manufacturing
another incident, and live recovery posts success. Transport failures,
malformed health evidence, and expired acknowledgements still fail directly.
This distinction is operationally important: a red status means "still
broken", while a newly failed workflow run means "new information needs
attention".

`Railway Native Deploy Health` is a separate six-hourly workflow and has no
dependency on the Seed Freshness gate. The gate and deployment drift share an
upstream: an ungated or red main is exactly when Railway can refuse a push, so
using the gate to skip the drift probe would hide the blast radius. Its one job
publishes both Railway configuration and deployment conclusions directly,
without changing the ingestion workflow's verdict.

The earlier two-job hourly layout duplicated the expensive Viewer projection:
both jobs queried all 80 services, so each scheduled run produced about 160
per-service GraphQL calls before deployment-history reads. On 2026-08-15 this
exhausted Railway's rolling API allowance and both jobs failed with HTTP 429.
The combined job queries each service once with concurrency two, reuses that
projection for both conclusions, and runs every six hours. A quota failure
still fails closed; lowering request volume prevents the monitor from creating
the condition it is meant to observe.

## Prevention

- **Read `meta.skippedReason` before concluding anything from a `SKIPPED`
  record.** Two very different events share that status, and the harmless one is
  5× more common. Reading the status alone produced a 62-entry suppression
  baseline for a defect that was not happening.
- **Never infer a skip rate without its denominator.** A narrow closure is
  *supposed* to skip more, so "51% of deployments skipped" is a statement about
  how much of the repository the service depends on, not about Railway. Replay
  each skip against the service's own configuration instead.
- Treat a watch-path filter as a cost control, never as a correctness one — but
  do not treat it as unreliable either. It matches accurately; it just cannot
  see outside the service's build context, and a pattern pointing outside that
  context (`shared/**` on a `rootDirectory: scripts` service) is dead weight.
- Run `node scripts/audit-railway-watch-paths.mjs` after adding or replacing a
  Railway seeder, changing its imports, or changing its cron. Keep the registry
  dependency-closure test green.
- Never narrow a seeder's watch paths in the Railway dashboard. Add its closure
  to the registry instead — a dashboard-only narrowing is drift the audit will
  push back to the broad contract on the next `--apply`.
- Run `node scripts/check-railway-deploy-drift.mjs` whenever a merge looks like
  it did not take effect; `--json` gives the machine-readable form. A
  `REJECTED_PUSH` verdict names the SHAs Railway refused **and the reason it
  gave**, and widening or clearing the filter does not build them — the service
  still needs a deploy.
- To force that deploy, run `node scripts/trigger-railway-deploys.mjs
  --dry-run` first to see the plan, then without the flag. It only deploys
  services whose closure genuinely changed, so it is safe to run at any time and
  is a no-op when the fleet is caught up.
- Keep the healthy compact-response case in monitor tests; absence of
  `problems` is success when `status` is `HEALTHY`.
- Keep the Railway project token in the main-only
  `ingestion-acceptance-production` GitHub Actions environment. Do not move it
  to repository or organization secret scope, where a manually dispatched
  non-default ref could access it.
- Keep operational details in
  `docs/railway-seed-consolidation-runbook.md` aligned with the executable audit.

### Recovering a service that is running stale code

`railway up` uploads the **current working directory**, not a commit. Run it
only from a clean detached worktree at `origin/main`, never from your own
worktree, or you deploy your uncommitted state to production:

```bash
git worktree add --detach /tmp/railway-deploy origin/main
cd /tmp/railway-deploy
git rev-parse HEAD                       # must equal origin/main
railway up --service <service-name> --environment production --detach
```

An upload also produces a deployment with **no commit SHA**, so
`check-railway-deploy-drift.mjs` reports that service as `UNKNOWN_SOURCE` until
the next git-triggered build replaces it. That verdict is expected after a
recovery upload and is not a second failure. Railway's dashboard **Deploy Latest
Commit** action avoids it by building from git, and is preferable whenever the
service's source is healthy enough to use it. After either path, verify the
deployment commit SHA and compact health have both advanced.

## Related Issues

- [Issue #5288](https://github.com/koala73/worldmonitor/issues/5288)
- [Issue #6141](https://github.com/koala73/worldmonitor/issues/6141)
- [Issue #6142](https://github.com/koala73/worldmonitor/issues/6142)
