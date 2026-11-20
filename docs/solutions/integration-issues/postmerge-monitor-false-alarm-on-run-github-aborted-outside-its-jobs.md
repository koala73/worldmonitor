---
title: The post-merge deploy monitor stayed red for hours on a Convex run GitHub aborted outside its jobs
date: 2026-11-10
category: integration-issues
module: check-postmerge-deploys
problem_type: integration_issue
component: development_workflow
symptoms:
  - "`postmerge-deploy ERROR: Convex Deploy [RUN_FAILED] run 42670983808 (docs(blog): ...) concluded failure`"
  - "Post-merge Deploy Monitor failed 43 consecutive ticks, 2026-11-09T18:09Z to 2026-11-10T01:43Z, and cleared only when the next merge produced a new Convex Deploy run"
  - "The failed run page says \"This run likely failed because of a workflow file issue\", though convex-deploy.yml had not changed in a week"
  - "`gh api repos/koala73/worldmonitor/actions/runs/42670983808/attempts/1/jobs` returns `total_count: 0`, and the sibling run 42670918755 lists only a green `convex-changes` job"
root_cause: logic_error
resolution_type: code_fix
severity: medium
related_components: [tooling]
tags: [github-actions, postmerge-monitor, platform-incident, false-alarm, convex-deploy, startup-failure, zero-jobs, deployed-baseline]
---

# The post-merge deploy monitor stayed red for hours on a Convex run GitHub aborted outside its jobs

## Problem

`scripts/check-postmerge-deploys.mjs` judges each monitored workflow by its newest run on `main`. Two Convex Deploy runs concluded `failure` during a GitHub Actions incident, but no job in either run failed. The monitor reported `RUN_FAILED` on every tick until a later merge started a new run. Production was current the whole time.

## Symptoms

- 43 red ticks over 7.5 hours with one unchanging message naming run 42670983808.
- The run's jobs listing is empty, or contains only jobs that concluded `success` or `skipped`.
- Unrelated workflows (Umami Storage Monitor, Analytics Collector Monitor, the styleLayout budget) failed with zero jobs in the same 20-minute window. That points to a GitHub platform problem and rules out the workflow file.
- `git diff --name-only <convex-deployed tag> origin/main -- <skipProofPaths>` was empty. This is the comparison the monitor makes, because `main` can move ahead without a new run.

## What Didn't Work

- The page's "workflow file issue" text sends you to `.github/workflows/convex-deploy.yml`. Its history showed no edit since 2026-11-02, and later runs of the identical file were green.
- The `changes` job log shows no `convex=` value, because the step writes only to `$GITHUB_OUTPUT`. To tell whether a deploy was due, diff the deployed tag against the head.

## Solution

PR #10367. A run that concluded `failure` while every job in its attempt concluded `success` or `skipped` has no failed deploy, even if a job such as `convex-changes` ran. Any other job conclusion, including `neutral` or null, keeps `RUN_FAILED`. For a workflow with a deployed-baseline check (`skipProofPaths` plus `deployedTagRef`), the monitor now asks the question it already asks after a green run: does the tag hold every bundled change on `main`?

- Drift: `ALARM DEPLOY_BEHIND_BASELINE`, unchanged.
- Current: `OK RUN_ABORTED_NOT_DUE`.
- Any failed job, an unreadable or missing job listing, an unset baseline, or a workflow without a baseline check: `ALARM RUN_FAILED`, unchanged.

The baseline block moved into `judgeDeployedBaseline` so the success path and the aborted path share one implementation. `abortedOutsideJobs(jobs)` returns true only for a `Map` whose every job concluded `success` or `skipped`.

Review caught a regression in the first version (Greptile P1). The job read added for failed runs threw on HTTP 5xx or a transport timeout, the per-workflow catch classified that as `UNKNOWN`, and `UNKNOWN` does not fail the job, so a real failed deploy could pass. A read that can only clear a failed run now swallows its own error and leaves `jobs` null, which keeps `RUN_FAILED`:

```js
} else if (run.verdict === 'RUN_FOUND' && run.conclusion === 'failure' && workflow.skipProofPaths) {
  try {
    jobs = readRunJobs({ gh, repository, runId: run.runId, runAttempt: run.runAttempt });
  } catch {
    jobs = null;
  }
}
```

## Why This Works

The monitor exists to answer "did production get every change on `main`". A run's conclusion is only a proxy for that. The `convex-deployed` tag is the workflow's own record of what is live (`readDeployedBaselineSha`), and it does not depend on whether GitHub managed to start a job. Using it lets a platform abort clear as soon as production is proven current, while a real undeployed change still alarms.

I verified the fix against live GitHub. The replay pinned the Convex run listing to each real run and used the real jobs API and real git tags. On `origin/main`, runs 42670918755 and 42670983808 report `ALARM RUN_FAILED`. With the fix they report `OK RUN_ABORTED_NOT_DUE`. Run 37513978211, where `repair-stale-on-hold-derived-state` actually failed, still reports `ALARM RUN_FAILED`.

## Prevention

- When an alarm clears a failure based on a new read, that read's own errors must keep the alarm. In this monitor `UNKNOWN` is a non-failing state, so any throw that reaches the per-workflow catch on a red path silently turns red into a warning. The test 'keeps RUN_FAILED when the failed run job listing is unreadable' covers HTTP 503, a transport timeout and HTTP 404.
- To diagnose a run with no failing step, read `actions/runs/<id>/attempts/<n>/jobs`. If `total_count` is 0, or every listed job is green, check other workflows in the same window before blaming the YAML.
- Workers have no baseline check, so an aborted Worker run still alarms until a newer run succeeds. Do not re-run the aborted run: a re-run deploys that run's original commit, which can be older than the Worker code on `main`. Start a fresh run with `gh workflow run <workflow>.yml --ref main` instead, since both Worker workflows accept `workflow_dispatch`.

## Related Issues

- `docs/solutions/integration-issues/convex-deploy-monitor-outvotes-stale-github-run-listing-snapshot.md` covers a different false alarm in the same monitor, caused by a stale run-listing snapshot.
- PR #10368 fixed the unrelated red `main` found in the same session, where `tests/us-import-duty.test.mts` read the wall clock through a defaulted `today` parameter.
