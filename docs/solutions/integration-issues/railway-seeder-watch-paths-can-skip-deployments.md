---
title: Railway seeder watch paths can skip or over-trigger deployments
date: 2026-07-13
category: integration-issues
module: railway-seeders
problem_type: integration_issue
component: development_workflow
symptoms:
  - "A seeder helper changed on green main, but Railway kept running an older source deployment"
  - "Seed metadata became stale even though the repository fix had merged"
root_cause: config_error
resolution_type: workflow_improvement
severity: high
tags: [railway, seeders, watch-paths, deployment, health-monitoring]
---

# Railway seeder watch paths can skip or over-trigger deployments

## Problem

Railway watch paths are live service configuration rather than repository
configuration. A seeder that enumerates its current entry point and helper files
can therefore miss a newly added transitive dependency: main is green, but the
service never builds the commit that changed its behavior. Replacing every
filter with `scripts/**` and `shared/**` fixes that omission but creates the
opposite problem: an unrelated helper change rebuilds every seeder.

## Symptoms

- The repository contains the fix while the running Railway deployment still
  points at an older commit.
- Compact health reports `STALE_SEED` after the affected producer misses enough
  scheduled runs.
- A data key may expire before the staleness threshold and surface through the
  existing `EMPTY` health alert instead.
- Unrelated merges create repeated Railway deployments for seeders whose runtime
  dependency graph did not change.

## What Didn't Work

- Adding a newly missed helper only in Railway fixes one deployment but leaves
  repository and production configuration able to drift again.
- Applying `scripts/**` and `shared/**` to every seeder prevents omissions but
  causes broad, unnecessary deployment waves.
- `railway redeploy` rebuilds the most recent deployment with the same source;
  it does not select a newer commit from main.
- Treating a healthy compact-health response without a `problems` field as
  malformed creates a false alert. The endpoint intentionally omits that field
  when there are no problems.

## Solution

Use `scripts/railway-services.json` as the repository contract. Each managed
seeder records its exact cron and repository-relative runtime dependency
closure. The registry contract test walks imports from each entry point and
fails when a new dependency is absent, so exact watch paths remain complete
without rebuilding on unrelated directory changes.

The live guard is `scripts/audit-railway-watch-paths.mjs`. Audit mode compares
the registry with production cron schedules, watch paths, service presence, and
required source-routing variables. `--apply` refuses partial or unroutable
changes, sends one minimal environment-config patch, and waits for the
eventually consistent read-back before succeeding.

Registry coverage is opt-in, so the audit **also** sweeps every live seeder the
registry does not manage and requires it to watch `scripts/**` + `shared/**`, or
the whole repository. Exact closures are strictly better, but they are a
per-service investment; the broad contract is the floor that keeps an
unregistered seeder from silently regaining the narrow filter this whole
document is about. Narrowing a service is therefore a deliberate act: add its
dependency closure to the registry, which the closure contract test then keeps
complete. Without that sweep the audit only ever inspected the services that had
opted in, and still printed "audit passed".

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

The registry and its import-closure test make a seeder's dependency boundary
reviewable in git. A new helper requires the same small registry change as the
code that imports it, while unrelated helpers no longer trigger the service.
Live introspection covers registry-managed Nixpacks and Dockerfile seeders with
their exact closures and every other live seeder against the broad floor, so
"audit passed" means the whole fleet was inspected rather than the subset that
opted in. Read-back verification prevents a Railway CLI no-op from being
mistaken for a successful mutation.

The scheduled workflow checks operational health only after the current main
commit has a successful `gate` status. It deliberately does not run on an
ingestion push because Railway may not have deployed or executed that revision
yet. That separates a code failure from the operational case this guard
targets: repository checks are green while a Railway producer or composed
coverage is still unhealthy.

## Prevention

- Run `node scripts/audit-railway-watch-paths.mjs` after adding or replacing a
  Railway seeder, changing its imports, or changing its cron.
- Keep the registry dependency-closure test green; do not restore directory-wide
  watch patterns to a *registry-managed* service as a shortcut.
- Never narrow a seeder's watch paths in the Railway dashboard. Add its closure
  to the registry instead — a dashboard-only narrowing is drift the audit will
  push back to the broad contract on the next `--apply`.
- Keep the healthy compact-response case in monitor tests; absence of
  `problems` is success when `status` is `HEALTHY`.
- Recover stale source deployments with a clean current-main `railway up` or
  Railway's **Deploy Latest Commit** action, then verify both deployment SHA and
  compact health.
- Keep operational details in
  `docs/railway-seed-consolidation-runbook.md` aligned with the executable audit.

## Related Issues

- [Issue #5288](https://github.com/koala73/worldmonitor/issues/5288)
