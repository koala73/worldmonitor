---
title: A merged seeder fix is not live until its cron fires — backfill long-cron seeders by hand
date: 2026-07-14
category: integration-issues
module: railway-seeders
problem_type: integration_issue
component: development_workflow
symptoms:
  - "/api/health reports a domain EMPTY (crit) with records=0 and no seedAgeMin, days after the fix merged"
  - "The seeder's Railway service shows only SUCCESS builds — no crashes, nothing red"
  - "A health key goes crit the moment its PR merges, then clears by itself hours or days later"
root_cause: missing_workflow_step
resolution_type: workflow_improvement
severity: high
related_components: [background_job, documentation]
tags: [railway, seeders, cron, health-monitoring, seed-meta, backfill, deployment]
---

# A merged seeder fix is not live until its cron fires

## Problem

`defensePatents` sat at `EMPTY` (crit) on `/api/health` with `records: 0`, and
production overall was `DEGRADED` — *after* the USPTO ODP migration (#5284) had
merged and deployed. The seeder code was correct. It had simply never run.

The same shape appeared twice in one session, so it is a pattern, not an
incident.

## Symptoms

- `/api/health?compact=1` shows the domain as `EMPTY`, `records: 0`, and **no
  `seedAgeMin`** — the seed-meta key is absent entirely, not merely stale.
- The Railway service looks perfectly healthy: no crashes, no red badge.
- Nothing in the repo is wrong. Reading the seeder source proves nothing.

## What Didn't Work

- **Assuming a regression.** The obvious read of "fix shipped, data still
  missing" is that the fix is broken. It was not. A read-only probe of the new
  source path (importing only the pure `scripts/_defense-patents-source.mjs`,
  never the seeder entry point) returned 90 valid records and passed the
  seeder's own `validateDefensePatents`. The code was fine the whole time.
- **Reading Railway's deployment list as a run log.** The service showed a long
  list of `SUCCESS` deployments. Nearly all of them were `buildOnly: true` —
  image builds triggered by pushes to `main`, which run *nothing*. In the last
  100 deployments there was exactly **one** real run against 82 builds. A busy
  deployment list is not evidence that a cron ever fired.

## Solution

Check the seeder's **cron cadence against the fix's merge time** before
concluding anything:

```bash
# The cron schedule lives in Railway service config, not the repo.
# seed-bundle-static-ref: "0 3 * * 0"  => Sunday 03:00 UTC, WEEKLY.
railway status --json   # then query the deployment's serviceManifest.deploy.cronSchedule
```

The timeline that explained everything:

| when | what |
|------|------|
| Sun 2026-07-12 03:00 UTC | last cron tick — **before the fix existed** |
| Mon 2026-07-13 18:07 UTC | #5284 merged and the image rebuilt |
| Sun 2026-07-19 03:00 UTC | next cron tick — **5 days away** |

The fix was baked into the image and had never executed. The remedy is a manual
backfill, which also *verifies* the fix in the real seeder path (publish,
envelope dual-write, Redis verification) rather than only in a probe:

```bash
cd scripts
railway run --service <service> --environment production -- node seed-defense-patents.mjs
# => {"event":"seed_complete","recordCount":90,"state":"OK"}
#    Verified: data present in Redis   ===  Done  ===
```

`/api/health` cleared on the next poll.

## Why This Works

A Railway cron seeder has two independent lifecycles that are easy to conflate:

1. **The image** rebuilds on every push to `main` (`buildOnly: true` deployments).
   This is what makes the service look active.
2. **The code inside it** only executes when the cron schedule fires.

Merging a fix advances (1) immediately and (2) not at all. For an hourly seeder
the gap is invisible. For a **weekly** seeder it is up to **7 days** — long
enough that the fix looks broken.

This is compounded by the fact that a `seed-meta` key does not resurrect itself:
nothing re-seeds an absent key except a run of the seeder that owns it.

## The general rule

**Merged ≠ deployed ≠ ran.** The only ground truth for seeder data is the
`seed-meta` key in Redis, not the PR state, not CI, and not the Railway badge.

A corollary worth internalizing: **shipping a health-key registration in the
same PR as its seeder makes health go crit for exactly one cron period.** The
health endpoint starts grading a key before the seeder that populates it has
ever run. Observed twice on the same day:

- `defensePatents` — weekly cron → would have stayed crit for ~5 days.
- `chinaMacro` / `chinaReleaseCalendar` (#5294) — daily cron (`0 8 * * *`) →
  crit for ~10 hours, then self-healed with no intervention.

The registration is at `api/health.js:211` (data key) and `api/health.js:403`
(seed-meta key); the weekly section is `scripts/seed-bundle-static-ref.mjs:6`
(`intervalMs: WEEK`).

## Prevention

- **Before calling a seeder fix "shipped", check its cron cadence.** If the next
  tick is far away, run a manual backfill. This is not optional cleanup — it is
  the step that makes the fix real *and* proves it end-to-end.
- **When a health key goes crit right after a merge, check the cron before
  hunting for a regression.** Compare the seeder's last real run to the merge
  time. `railway status --json` → `serviceManifest.deploy.cronSchedule`.
- **Do not read `SUCCESS` deployments as runs.** Filter on `meta.buildOnly` —
  `buildOnly: true` deployments build the image and execute nothing.
- **Never import a seeder entry point to smoke-test it.** Import the pure source
  module instead (`scripts/_defense-patents-source.mjs`, not
  `scripts/seed-defense-patents.mjs`). This particular seeder happens to guard
  its `runSeed` behind an `isMain` check, but that is not a repo-wide guarantee —
  an unguarded seeder executes on import and writes production Redis.

## Related

- [Railway seeder watch paths can skip deployments](railway-seeder-watch-paths-can-skip-deployments.md)
  — the sibling failure where the *image* never rebuilds. This doc is the
  opposite: the image rebuilt fine and the *code* never ran.
- PR #5284 (USPTO ODP migration) — the fix that was correct but dormant.
- PR #5294 — the China coverage PR that registered health keys ahead of the
  first `seed-bundle-macro` tick.
