---
title: "Superseded CI runs burned 59% of gated-workflow runs"
category: performance-issues
module: ci-gated-workflows
date: 2026-09-21
problem_type: performance_issue
component: development_workflow
severity: high
symptoms:
  - "Merges felt like they took 25 minutes while every individual job looked fast"
  - "CI was intermittently slow with no single job getting slower"
  - "Across the last 300 runs of each gated workflow, 177 (59%) completed on an already-superseded SHA and zero were ever cancelled"
  - "Per-job queue waits reached 327s against an observed peak of 43 concurrent jobs"
root_cause: config_error
resolution_type: config_change
related_components:
  - testing_framework
  - tooling
tags: [ci-performance, github-actions, concurrency, runner-contention, deploy-gate, measurement-methodology]
---

# Superseded CI runs burned 59% of gated-workflow runs

## Problem

Four of the six workflows feeding the deploy gate declared no top-level `concurrency` block, so a new push to a PR never cancelled the run it superseded. Every superseded run finished its full job-minute cost, competing for runners with the live commit that replaced it.

## Symptoms

The presenting complaint was that commits took 25 minutes to merge, and the test suite was the obvious suspect. Measured across the last 25 merged PRs, anchored on the first check run's `started_at`:

| milestone | median |
| --- | --- |
| all non-skipped checks green | 7.6 min |
| `gate` status posted | 7.2 min |
| merged | 12.8 min |

The check wall was 7.6 minutes, not 25. The 25-minute cases were real but intermittent, which is the signature of contention rather than of a slow suite.

The diagnostic query that broke it open was asking, of the last 300 runs of each gated workflow, how many completed on a SHA a later push had already superseded.

```
test.yml             300 runs   177 on a dead SHA (59%)   0 cancelled
typecheck.yml        300 runs   177 (59%)   0 cancelled
lint-code.yml        300 runs   177 (59%)   0 cancelled
security-audit.yml   300 runs   177 (59%)   0 cancelled
```

Zero cancellations across 300 runs does not mean the pipeline is stable. It means nothing is configured to cancel. Per branch it was worse than the aggregate. `fix/notify-field-validation-8397` ran Test 12 times with 11 already dead.

## What Didn't Work

**Blaming the tests.** A 2026-09-06 test-efficiency audit had already filed seven issues under the `testaudit` label and all seven shipped. The test content was already squeezed, which is exactly why the remaining cost lived in the pipeline. See `./test-suite-idle-waits-and-redundant-parsing.md` and `./ci-test-selection-and-shards.md` for that half of the problem.

**Anchoring latency on the commit timestamp.** The obvious anchor looks completely reasonable and is wrong.

```bash
gh pr view <n> --json commits --jq '.commits | last | .committedDate'
```

That field is authoring time, not push time. A branch that sat unpushed on a laptop reports that dwell as CI latency. It produced figures of 605 and 1466 minutes for PRs whose checks finished in under ten. Those numbers survive averaging because they are all biased the same direction. The correct anchor is the moment CI first saw the SHA.

```bash
gh api repos/{owner}/{repo}/commits/<sha>/check-runs --paginate \
  --jq '[.check_runs[].started_at] | min'
```

**Testing the text instead of the value.** The first version of the guard asserted `/^\s*cancel-in-progress:/m` against raw workflow source, which tests spelling. A workflow setting `cancel-in-progress: false` satisfied it. Proven rather than assumed: running the pre-fix test against `typecheck.yml` mutated to `false`, the assertion reported green.

## Solution

Workflow-level `concurrency` on each of the four (`.github/workflows/test.yml:14-16`, `typecheck.yml:10-12`, `lint-code.yml:12-14`, `security-audit.yml:14-16`).

```yaml
concurrency:
  group: test-${{ github.event.pull_request.number || github.run_id }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

The guard at `tests/ci-workflow-coverage.test.mts:1939` does two separate things. It pins the exact group expression and cancellation condition per file. Then it reads `on.workflow_run.workflows` out of `.github/workflows/deploy-gate.yml:19` and requires every workflow named there to cancel superseded runs. The second assertion is the one that keeps paying, because the gate's own trigger list is the definition of "blocks a merge."

The hardened check parses rather than greps. It requires a non-empty top-level `concurrency.group` and a `cancel-in-progress` that is literal `true` or an expression, which rejects a missing block, a literal `false`, and a job-level-only group.

## Why This Works

**Nobody reads a superseded run's verdict.** Branch protection evaluates the head SHA only. So does the gate. `discover()` at `.github/scripts/deploy-gate.sh:291` sweeps open PRs and collects `headRefOid`, so a cancelled dead SHA is not any open PR's head and never enters the 24-hour retry sweep.

**The reason does not generalize, and the same repo pins the opposite invariant.** `tests/ci-workflow-coverage.test.mts:482` asserts that `mcp-live-smoke.yml` applies concurrency only at job level and requires `cancel-in-progress: false`. Workflow-level concurrency evaluates before job-level `if:` gates, so an evicted probe there reads as neither pass nor fail, and a detection net that silently loses coverage is worse than one that fails loudly.

So the rule is not "add concurrency to CI workflows." It is to evict a run only when no consumer will ever read its verdict, established by reading the consumers.

**The `github.run_id` fallback is load-bearing.** On a `push`, `schedule` or `workflow_dispatch` event there is no pull request number. Without the fallback every such run collapses into one group named `test-` and they serialize into a single queue. A push to main still owes the deploy gate a verdict, and the weekly lint cron and nightly audit are standalone detection nets.

**A job-level group would not have been enough.** It evicts one job while the rest of the superseded run keeps burning, and a gated workflow has several jobs feeding the gate by construction.

## Prevention

**Decompose the interval before optimizing any part of it.** "Merge takes N minutes" is four measurements with four different owners.

1. Queue wait, from job creation to a runner picking it up. Owned by concurrency and capacity. Invisible in every per-job duration readout.
2. Check wall, the slowest path through the actual work. Owned by test and build content.
3. Gate verdict, from the last check going green to the aggregating status being posted.
4. Post-green tail, from a mergeable PR to an actual merge. Owned by whoever clicks merge.

Produce all four before touching anything, or you will optimize the one the UI shows you, which is the check wall.

**Never anchor a latency measurement on a timestamp a developer's machine wrote.** Anchor on one the system under measurement wrote.

**Measure job-minutes when you suspect contention.** Wall clock hides contention because it is not visible in any single run. One PR cycle here costs about 40 non-skipped jobs and 59.4 job-minutes, of which Test is 35.0 and CodeQL is 14.9.

**Find a control PR.** A busy window is also a window where more of everything happens, so correlation is not enough. PR #8432 was pushed with nothing else in flight, saw a 38-second maximum queue wait, and was green at 7.0 minutes. Same tests, same runners, against 19 to 27 minutes in the contended window. Note what the control isolates. It is barely better than the 7.6-minute median, so it explains the tail rather than the typical case.

**Verification that closed this one.** The guard was written first and observed red. Mutations before hardening (`cancel-in-progress: true` unconditional, and dropping `|| github.run_id`) were both caught, and after hardening a literal `false`, a removed block, and a missing group were all caught. Full `npm run test:data` passed 33,590 with 0 failures. End to end, commit 1 was pushed, all four workflows reached queued or in_progress, then commit 2 was pushed, and all four commit-1 runs returned conclusion `cancelled`. That reclaimed 12.3 of the 43.6 job-minutes those four workflows cost in a full cycle, though the exact figure is specific to one two-commit experiment and depends entirely on how far the first runs had progressed when the second push landed.

## Related

- Issue #8443, PR #8444.
- `../conventions/a-gate-required-check-must-be-an-if-gated-job-not-a-path-filtered-workflow.md` uses the same technique of deriving the gate-relevant set from `deploy-gate.yml` instead of hardcoding names.
- `./test-suite-idle-waits-and-redundant-parsing.md` and `./ci-test-selection-and-shards.md` cover per-job wall time. This doc covers the separate queue-capacity lever, and optimizing job content did not move the contended figures.

### Still open, measured during this investigation

Re-measure before acting. These numbers predate the fix, which changed the contention picture.

- Merges are manual. No `auto_merge_enabled` events appeared on any recent PR, leaving roughly 5 minutes between the median gate and the median merge.
- CodeQL costs 6 jobs and 14.9 job-minutes per PR and is absent from the required list at `.github/scripts/deploy-gate.sh:154`, so no merge waits on it. It is GitHub default setup across 8 languages with no workflow file, so it cannot be path-filtered without converting to advanced setup.
- `npm ci` costs about 51 seconds in each of roughly 10 Test jobs even though `cache: 'npm'` is already set. The npm cache saves download time, not install time.
- All three unit shards rebuild `/pro` and the dashboard although only 23 test files need built output.
- `proto-check.yml` cancels unconditionally with no non-PR fallback in its group, so on a mainline push the group collapses to a single shared name and two rapid pushes can evict each other. It publishes a name the gate requires. `stacked-merge-guard.yml` gets this right. The guard added here does not catch it, because it accepts an unconditional `true` without checking the group degrades safely off a change proposal. Tracked as issue #8445.
