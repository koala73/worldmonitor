---
title: Railway seeder watch paths can skip deployments
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

# Railway seeder watch paths can skip deployments

## Problem

Railway watch paths are live service configuration rather than repository
configuration. A seeder that enumerates its current entry point and helper files
can therefore miss a newly added transitive dependency: main is green, but the
service never builds the commit that changed its behavior.

## Symptoms

- The repository contains the fix while the running Railway deployment still
  points at an older commit.
- Compact health reports `STALE_SEED` after the affected producer misses enough
  scheduled runs.
- A data key may expire before the staleness threshold and surface through the
  existing `EMPTY` health alert instead.

## What Didn't Work

- Adding only the newly missed helper to the watch list fixes one deployment but
  leaves the same failure mode for the next helper.
- `railway redeploy` rebuilds the most recent deployment with the same source;
  it does not select a newer commit from main.
- Treating a healthy compact-health response without a `problems` field as
  malformed creates a false alert. The endpoint intentionally omits that field
  when there are no problems.

## Solution

Use directory-level watch paths as the repository contract:

```text
scripts/**
shared/**
```

For services rooted at `scripts`, replace non-empty enumerated filters with
exactly those two patterns. For repo-root and Docker services, preserve required
paths outside those directories, such as Dockerfiles or server helpers, and add
the two broad patterns.

The live guard is `scripts/audit-railway-watch-paths.mjs`. Its audit mode reports
drift; `--apply` sends one minimal environment-config patch and waits for the
eventually consistent read-back before succeeding. The separate
`scripts/check-seed-freshness.mjs` probe fails only for `STALE_SEED` problems and
accepts the healthy compact response shape where `problems` is absent.

## Why This Works

The watch contract now follows dependency boundaries rather than today's import
list, so a new helper under either shared directory triggers a deployment
without another dashboard edit. Live introspection covers Nixpacks, repo-root,
and Dockerfile seed services, while read-back verification prevents a Railway
CLI no-op from being mistaken for a successful mutation.

The scheduled workflow checks freshness only after the current main commit has
a successful `gate` status. That separates a code failure from the operational
case this guard targets: repository checks are green while a Railway producer is
still stale.

## Prevention

- Run `node scripts/audit-railway-watch-paths.mjs` after adding or replacing a
  Railway seeder.
- Keep the healthy compact-response case in monitor tests; absence of
  `problems` is success when `status` is `HEALTHY`.
- Recover stale source deployments with a clean current-main `railway up` or
  Railway's **Deploy Latest Commit** action, then verify both deployment SHA and
  compact health.
- Keep operational details in
  `docs/railway-seed-consolidation-runbook.md` aligned with the executable audit.

## Related Issues

- [Issue #5288](https://github.com/koala73/worldmonitor/issues/5288)
