---
title: Railway watch paths skip deployments, however narrow the pattern
date: 2026-08-04
category: integration-issues
module: railway-seeders
problem_type: integration_issue
component: development_workflow
symptoms:
  - "A seeder helper changed on green main, but Railway kept running an older source deployment"
  - "Seed metadata became stale even though the repository fix had merged"
  - "Railway recorded the refused push only as a deployment whose status is SKIPPED and whose meta.commitHash names the commit it refused"
root_cause: config_error
resolution_type: workflow_improvement
severity: high
tags: [railway, seeders, watch-paths, deployment, health-monitoring]
---

# Railway watch paths skip deployments, however narrow the pattern

## Problem

Railway's per-service **Watch Paths** filter refuses pushes that plainly match
its own glob. The refusal is recorded only as a deployment whose status is
`SKIPPED` and whose `meta.commitHash` carries the commit it refused; nothing
else reports it, and the service keeps running the previous image indefinitely.
Every repository gate stays green while production runs older code.

Measured 2026-08-04 against production, where 77 Railway services are built
from this repository:

- 62 of the 62 services carrying a watch-path filter were running code older
  than a push Railway had refused. That is 100%.
- 13 of the 15 services without a filter were at `origin/main` HEAD. Both
  exceptions are explained: `seed-military-flights` had been recovered with a
  `railway up` upload, which carries no commit SHA at all, and `umami` is the
  separate GitHub-webhook outage tracked in #6064.
- Narrowness does not help. `seed-conflict-intel` pins the most careful closure
  in the fleet — 24 exact paths — and still had its worst skip rate: 51% of its
  last 500 deployments.

**The defect is a lag tail, not a loss rate.** Railway builds the full tree at a
SHA, so a refused commit's changes ride along on the next build that does fire.
Almost nothing is permanently lost — it arrives late. Hours from merge to a
build actually containing the change: p50 **0h** on every service, but p90
**19.0h** and max **62.6h** (`seed-conflict-intel`); p90 3.6h (`seed-gpsjam`);
max 9.9h (`seed-military-flights` — and that maximum *is* the incident above,
ended only by a manual `railway up`).

That distinction decides what to build. Lag is harmless for a copy tweak and an
outage when the delayed commit fixes an active crash loop, and nothing
distinguishes the two from inside the repository: **unmonitored lag is
indistinguishable from loss.** So the fix is not to make every push build — it
is to measure how far behind each service actually is.

The filter is therefore not a reliable deployment trigger at any width. That is
a statement about Railway's matcher, not about the closures in the registry.

## Symptoms

- The repository contains the fix while the running Railway deployment still
  points at an older commit.
- Compact health reports `STALE_SEED` after the affected producer misses enough
  scheduled runs.
- A data key may expire before the staleness threshold and surface through the
  existing `EMPTY` health alert instead.
- The only record of the refused push is a `SKIPPED` deployment carrying a
  `meta.commitHash`. It is not an error, not a notification, and not visible on
  the service's status badge.

## What Didn't Work

- **Exact per-service dependency closures as a *safety* measure — the
  conclusion this document previously reached.** The reasoning was that a filter
  missed pushes because it was incomplete, so the registry pins each service's
  exact runtime dependency closure and a contract test keeps it complete as
  imports grow. The measurement above refutes the safety half of that: every
  filtered service in the fleet was behind a refused push, and the service with
  the most carefully maintained closure was the worst offender. The closures are still in
  the registry and still enforced (see the decision below), but a reader
  arriving from an older link must not read them as a guarantee that a merge
  deploys.
- Applying `scripts/**` and `shared/**` to every seeder. Broad patterns are
  refused exactly as narrow ones are; breadth only changes which merges are
  delayed. `scripts/**` is already maximally coarse for these services — any
  `scripts/` change rebuilds all of them — so today's configuration pays the
  no-filter cost *and* still lags. Narrower per-seeder patterns beat both.
- Adding a newly missed helper only in Railway fixes one deployment but leaves
  repository and production configuration able to drift again.
- `railway redeploy` rebuilds the most recent deployment with the same source;
  it does not select a newer commit from main.
- Treating a healthy compact-health response without a `problems` field as
  malformed creates a false alert. The endpoint intentionally omits that field
  when there are no problems.

## Decision

Clearing every filter is the obvious response to the measurement. It was
considered and rejected on cost: roughly 75 build-minutes per push to main
across 77 services, about 2,250 build-minutes a day at ~30 merges, and three
always-on services (ais-relay, notification-relay, scenario-worker) would
restart on every merge, dropping the AIS websocket connections among them.

So:

1. The closures in `scripts/railway-services.json` **stay as they are** for now.
   They keep unrelated merges from rebuilding the fleet, which is the cost
   problem above. They are not the fix for this issue and must not be described
   as one.
2. What ships today is **detection**: `scripts/check-railway-deploy-drift.mjs`
   reports, within one 15-minute monitor cycle, any service that is not running
   head — whatever the cause.
3. The permanent fix is to move change detection out of Railway entirely:
   compute in CI which services' dependency closures actually changed and call
   `railway redeploy` for exactly those, so the matching happens in code we own
   and test rather than in the component that proved unreliable. That is
   [#6142](https://github.com/koala73/worldmonitor/issues/6142).

Until #6142 lands, the measured fleet is recorded in
`scripts/railway-deploy-drift-baseline.json`: 62 `REJECTED_PUSH` entries against
#6142 plus `umami` at `BEHIND` against #6064, with a file-wide expiry. That list
should shrink as #6142 lands, and the check names each entry that has recovered
so it can be pruned.

## Solution

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
the next layer, and #6142 is the work that would make this one unnecessary.

### The drift check: did the merge actually land

`scripts/check-railway-deploy-drift.mjs` is deliberately agnostic about *why* a
merge did not reach production: a refused push (this issue), a GitHub
integration that stopped delivering (#6064), and a build that failed after the
merge landed all produce the same finding. For every service whose Railway
source is this repository — `isRepositoryService`, shared with the audit so both
files have one definition of "ours" — it takes the newest deployment that
actually reached a running state (`RUNNING_STATUSES`: `SUCCESS`, `REMOVED`,
`CRASHED`, `SLEEPING`), reads `meta.commitHash` off it, and compares that with
main's head.

Three verdicts are healthy — `CURRENT`, `AHEAD`, `PENDING_BUILD` — and
`isProblemVerdict` derives the problem set from them by negation rather than
enumerating it, so a verdict added later is a problem until someone decides
otherwise. The reported problems are `REJECTED_PUSH`, `BEHIND`, `BUILD_FAILED`,
`UNKNOWN_SOURCE`, `UNKNOWN_STATUS`, `NO_DEPLOYMENTS`, `NO_BUILD_IN_WINDOW` and
`QUERY_FAILED`. Read the file's header comment and exported constants for the
exact semantics of each. `REJECTED_PUSH` is this issue seen from the outside:
the named SHAs are merges Railway refused and has built nothing since.

Two details in that file are load-bearing and easy to get wrong:

- The build grace (`DEFAULT_BUILD_GRACE_MS`, 30 minutes) is spent on a
  **commit**, never on a service. The caller resolves the newest commit older
  than the window and every service must be running that commit or a
  descendant. Excusing a service because head happens to be young would have
  gone green on the whole fleet on any run that followed a merge — including
  for `umami`, which was already a day stale.
- `git merge-base --is-ancestor` cannot answer from a shallow checkout, and its
  non-zero exit means both "no" and "that object is missing". Both collapse to
  "cannot prove it", which keeps the service reported rather than excused.

Accepted degradations go in `scripts/railway-deploy-drift-baseline.json`, which
has the same shape as `scripts/seed-freshness-baseline.json` and is split by the
same `applyAcceptanceBaseline` implementation, imported from
`scripts/check-seed-freshness.mjs`. Sharing the function keeps expiry,
prune-on-recovery, and "a service failing with a different verdict than the one
baselined still blocks" from acquiring two meanings — so a baselined
`REJECTED_PUSH` that turns into `BEHIND` still fails the run, which is the case
where someone cleared the filter and the service went stale anyway. Every entry
carries an owner issue and the file carries an expiry, so a suppression cannot
outlive its cause unnoticed.

`.github/workflows/seed-freshness-monitor.yml` runs the drift check in the step
**Check Railway deploy drift against main**, between the config audit and the
compact-health check. Its checkout uses `fetch-depth: 50` and the step re-fetches
main first, for the ancestry reason above.

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

The two layers answer different questions, and only the second one is about this
failure. The audit bounds what the live trigger configuration is allowed to be;
the drift check reads the SHA Railway is actually running and does not care
which of the three causes produced a gap. That is what makes it survive the
decision above: the filters are still in place and still unreliable, so the
guard that matters is the one that reports the outcome rather than the setting.

Everything is compared against a positive statement — "this service is running
head". An unreadable status, an unanswerable ancestry question, or a query that
failed reports the service instead of vouching for it.

The scheduled workflow checks live Railway config and operational health only
after the current main commit has a successful `gate` status. A missing,
pending, or failed gate fails the workflow; it is never converted into a green
skip. It deliberately does not run on an ingestion push because Railway may not
have deployed or executed that revision yet. That separates a code failure from
the operational case this guard targets: repository checks are green while a
Railway producer, deployment trigger, or composed coverage is still unhealthy.

## Prevention

- Treat a watch-path filter as a cost control, never as a correctness one. Do
  not add one to a new service expecting it to deploy reliably, and never
  present a narrower closure as the fix for a skipped merge.
- Run `node scripts/audit-railway-watch-paths.mjs` after adding or replacing a
  Railway seeder, changing its imports, or changing its cron. Keep the registry
  dependency-closure test green.
- Never narrow a seeder's watch paths in the Railway dashboard. Add its closure
  to the registry instead — a dashboard-only narrowing is drift the audit will
  push back to the broad contract on the next `--apply`.
- Run `node scripts/check-railway-deploy-drift.mjs` whenever a merge looks like
  it did not take effect; `--json` gives the machine-readable form. A
  `REJECTED_PUSH` verdict names the SHAs Railway refused, and widening or
  clearing the filter does not build them — the service still needs a recovery
  deploy.
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
