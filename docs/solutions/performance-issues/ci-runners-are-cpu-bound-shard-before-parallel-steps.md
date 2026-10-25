---
title: "CI test runners are CPU-bound: shard by measured time, and use parallel steps only for setup"
date: 2026-10-07
category: performance-issues
module: CI tests
problem_type: performance_issue
component: testing_framework
symptoms:
  - "The Test workflow took 273-330s, set by the slower of two variant-smoke shards (432 vs 356 test-seconds)"
  - "GitHub Actions parallel steps (June 2026) looked like a way to cut that wall, but the long steps are single commands"
root_cause: config_error
resolution_type: workflow_improvement
severity: medium
tags: [ci-performance, sharding, parallel-steps, github-actions, playwright, cpu-bound]
---

# CI test runners are CPU-bound: shard by measured time, and use parallel steps only for setup

## Problem

The Test workflow's wall time was set by one Playwright smoke shard. The new
GitHub Actions `parallel:` and `background:` step keywords suggested
restructuring jobs to do more work on each runner. Measurement showed that the
long steps already use almost all of the runner's CPU, so the time has to come
from more runners.

## What the measurements showed

These come from throwaway push-triggered benchmark branches. Each step ran
`vmstat` in the background.

| Change on one 4-vCPU runner | Result |
|---|---|
| Smoke at 2 Playwright workers (the CI default) | 81-85% CPU busy, ~215s |
| Smoke at 4 workers | 90-92% busy, ~185s (about 15% faster), 2 of 6 runs had a flaky retry |
| Vite dev server started early in a `background: true` step | ~210s vs ~215s, within noise |
| `test:data` at concurrency 4 vs 8 | 56-79% vs 77-88% busy. Shards 2 and 3 got ~17% faster; shard 1 got slower |
| Dependency restore beside the apt install in a `parallel:` group | 8-9s saved per job (18 samples per variant) |

Raising workers or concurrency moves an already busy runner closer to 100%.
Splitting the work across more runners is a linear gain. Hosted runners are free
on this public repo, and queue waits were p50 3s and p90 4s across 369 jobs.

## Solution

PR #8966:

- **Four smoke shards, balanced by measured test-seconds.** The list reporter
  prints a duration for every test. Summing them per spec gave 788
  test-seconds, split into four lists of ~197s each in
  `test:e2e:ci-smoke:1..4`. The old split was 432 vs 356.
- **Four unit shards.** `scripts/run-data-tests.mjs` already balances shards
  by recorded file durations, so only the matrix and the `/N` denominator
  changed. The slowest single files (111s, 92s, 81s) set a floor that more
  shards cannot go below.
- **Five unit shards (October 2026).** Once the slowest files were fixed
  (the slowest is now 36s), the unit shards were the slowest Test job again at
  ~207s. Bench run 40083951067 ran `test:data` on the same runners: the slowest
  shard took 123s at five shards and 138-155s at four. Concurrency 6 or 8
  inside a shard gave nothing, because the step is CPU-bound. Each file also
  pays ~0.2-0.3s of import cost that the recorded durations leave out, so the
  wall time per shard is ~30-40s above the duration estimate.
- **Parallel setup.** In the smoke shards, `install-root-deps` runs beside the
  apt install of Playwright's OS libraries. The pro-webmcp OS library install
  runs beside the `/pro` build. `node_modules` does not exist yet in the smoke
  shards, so the apt step reads the Playwright version from
  `package-lock.json` and runs `npx -y "playwright@$v" install-deps chromium`.
  The unit shards ran the Redis apt install beside `install-root-deps` too,
  until #9583. They now install Redis from a package cache with `dpkg`, before
  `install-root-deps`: both composite actions use `actions/cache`, and two
  parallel steps that each pull an action not referenced by the job's
  top-level steps download it at once, so one copy fails (run 39936254975).

Three alternating runs of the old and new workflow on one commit took the wall
from 273-280s to 216-223s, for about 14% more runner-seconds. The PR's own run
took 259s because the longest job, `variant-smoke-pro-webmcp`, waited 39s for a
runner. The cause of that wait was not confirmed. That job is the next one to
shorten.

## Playwright install-deps adds no library on the hosted image

On ubuntu-24.04, `npx playwright install-deps chromium` downloaded 32.5 MB on
every browser job, plus an 11.6 MB `apt-get update`. That came to about 21 MB
of fonts (CJK, Japanese, Thai, GNU FreeFont, Unifont and X11 fonts) and about
11 MB of Mesa upgrades. `ldd` found no missing library on either Playwright
browser binary. One run fetched from the Azure mirror at 228 kB/s, which took
158s and set the run's wall time.

The browser jobs now:

- Run `ldd` on the Playwright browser binaries and call `install-deps` only
  when a library is missing or no binary is found. The 8-minute cap and the
  repair step still apply when the fallback runs.
- Install only the fonts the shipped locales need beyond the image's DejaVu,
  Liberation and Noto Color Emoji: `fonts-wqy-zenhei` (zh, ja and ko),
  `fonts-tlwg-loma-otf` (th) and `fonts-lohit-deva` (hi). The
  `install-browser-fonts` action caches the `.deb` files and installs them with
  `dpkg -i`. Until #9554 it passed them to `apt-get install`, which downloaded
  them again from the mirror on every run (see
  [apt-get-install-local-deb-redownloads-from-mirror.md](apt-get-install-local-deb-redownloads-from-mirror.md)).
  The step takes 3-14s and runs beside the dependency restore. A
  failed font install only warns, because fonts affect only the evidence
  screenshots.

The E2E Visual workflow keeps the full `install-deps`, because its golden
screenshots depend on rendering.

## Parallel-step behavior verified on hosted runners

- `parallel:` and `background: true` parse and run. `cancel: <id>` is rejected
  with "Unexpected value 'cancel'" even though the changelog lists it. Stop a
  background service with `pkill` in a later step.
- Inside a `parallel:` group, `timeout-minutes`, `continue-on-error`, and
  `steps.<id>.outcome` behave as they do for top-level steps. A probe step
  capped at 1 minute was killed at the cap ("The background step ... has timed
  out"), the job stayed green, a later `if: steps.<id>.outcome == 'failure'`
  step ran, and a sibling step's outputs were readable. The apt-hang guard
  (8-minute cap and repair step) therefore still works when the install runs
  in a group.
- A `uses:` composite action can be one item of a group.

## The WebMCP smoke: split the job, not the workers

After the unit shards and smoke shards got faster, `variant-smoke-pro-webmcp`
took ~200s. The strict WebMCP smoke (`npm run test:e2e:webmcp`, 61-81s) ran
last, after the `/pro` build and five separate `/pro` gate runs. Bench run
40097331565 ran the smoke alone at 2, 3 and 4 workers:

- Per-worker test time stayed at 55-76s at every worker count: each test got
  slower in proportion to the worker count. The Vite dev server and Chrome
  share the runner's CPU.
- At 4 workers, `validates monitor switches and opens settings and alerts
  through existing UI` failed on both attempts. That is the contention-
  sensitive race described in
  [idle-auto-open-popover-swallows-an-open-modals-escape](../ui-bugs/idle-auto-open-popover-swallows-an-open-modals-escape.md).
- 100ms `expect.poll` intervals (the default backs off to 1s) were within the
  57-76s run-to-run noise.
- The two legacy-API tests need `npm run build:pro`: they load
  `/pro/welcome.html`. A retry records video, which needs the ffmpeg build in
  `~/.cache/ms-playwright`, so both halves keep the Playwright cache steps.

The job is now a two-entry matrix (`part: [webmcp, pro-gates]`): the WebMCP
smoke and the `/pro` gates run on separate runners, and each part builds
`/pro`. The four `/pro` gates share one Playwright run
(`npm run test:e2e:pro-gates`), because each run spends ~2.5s starting the
dev server and Chrome and ~1s shutting down.

The split exposed one more cost. `setup-node`'s npm cache in this job was keyed
on the root lockfile, so it restored the 583 MB root download cache, which only
serves the pro-test install inside `build:pro` (root `node_modules` comes from
`install-root-deps`). One job pulled it at ~95 MB/s in ~6s. Two jobs pulling the
same blob at the same moment took 12-62s on PR #9626. The job now sets
`cache-dependency-path: pro-test/package-lock.json`.

## Prevention

- **Tests that walk `job.steps` do not see steps nested in a `parallel:`
  group.** A negative assertion such as "no shard step runs `build:pro`" then
  passes without checking anything. Expand groups first:

  ```js
  const steps = job.steps.flatMap((step) => step.parallel ?? [step]);
  ```

- **Tests that match adjacent YAML text break when a step moves into a
  group.** `tests/dashboard-build-guards.test.mjs` pinned the `/pro` build's
  exact text directly above the prehydration step. It now parses the workflow
  and asserts that the build runs before the checks, with only the apt repair
  step between them.
- **Before adding workers or a background service, sample CPU during the
  step.** If the runner is above about 80% busy, add a shard instead.
- **Rebalance smoke shards from measured durations** when a spec grows. The
  list reporter's per-test seconds are the input. By October 2026 the four
  shards measured 218/209/287/277 test-seconds (per-spec medians of three main
  runs). PR #9658 replaced the fixed 8s settle waits in
  `dashboard-news-request-budget` with the `wmInitialDataReady` flag plus a
  1.5s quiet window. Single runs misled: a spec's time moved up to 50%
  between runs (`country-brief` 151-205s) because each shard gets its own
  runner, so one run's totals mostly show which runners were fast. The final
  split uses each spec's median over six runs (three on main, three on the
  PR): 237/238/238/240 of 953 test-seconds.
- **Removing sleeps does not free the seconds they held on CI.** Locally the
  flag set 0.3-0.6s after the first digest. On a runner each 8s wait saved only
  1-5s; the flag time there was not logged. The spec's other tests got slower (3.9s to
  6.5s, 3.6s to 7.6s) because the sleeps had left CPU idle for the second
  worker. Over six runs the spec's median did not move (162s before, 157-172s
  after) and the smoke total stayed at about 953 test-seconds. On a
  CPU-bound runner a sleep overlaps the other worker's work, so removing it
  saves local time but not CI time. Only balance changes the CI wall here.
- **Wait on a readiness signal, not a fixed sleep, to prove a negative.**
  Before shortening a "no second request" wait, find what would cause the
  second request and whether a flag already marks its end. Then remove the
  guard (here `shouldHydrateNews` returning true) and confirm the shortened
  test still fails.
- **Benchmark changes on a throwaway branch.** Use a push trigger on that
  branch and force `emit_all_true` in `changes`. Suites that inspect
  `.github/workflows` and the health-probe cutover gate go red because of the
  extra workflow file. They fail fast and do not change the timings of the
  other jobs.

## Related

- [CI test selection and shards](ci-test-selection-and-shards.md): why the builds run once in `unit-built-output`, and how the data-test sharder works
- [Test-suite idle waits and redundant parsing](test-suite-idle-waits-and-redundant-parsing.md): earlier reductions in per-test time
- [GitHub changelog: Actions steps can now be run in parallel](https://github.blog/changelog/2026-06-25-actions-steps-can-now-be-run-in-parallel/)
