---
title: "GitHub's DST fall-back hour hid passing check runs and stranded the gate"
date: 2026-11-01
category: integration-issues
module: deploy-gate
problem_type: integration_issue
component: development_workflow
symptoms:
  - "`gate` stays pending for hours with 'Waiting for required PR gates (16): changes,docs-stats,unit,...' although every Test job passed"
  - "`gh pr checks` lists no Test jobs at all for the head commit"
  - "`GET /actions/runs/<id>/jobs` returns total_count 0 for a run that reports conclusion success"
  - "The run's created_at is later than its updated_at (e.g. created 09:59:37, updated 09:03:32)"
  - "The 30-minute Deploy Gate sweep logs 'attempt 1: changes=pending ... unit=pending' every pass and never recovers"
root_cause: logic_error
resolution_type: workflow_improvement
severity: medium
related_components: [tooling, testing_framework]
tags: [deploy-gate, ci-gate, github-actions, status-check-rollup, check-runs, dst, timestamps, rerun]
---

# GitHub's DST fall-back hour hid passing check runs and stranded the gate

## Problem

On 2026-11-01 US clocks fell back at 09:00 UTC (02:00 PDT became 01:00 PST), so the local
hour 01:00-01:59 Pacific happened twice. GitHub stamped objects created during the first
occurrence (08:00-09:00 UTC) as if they belonged to the second one, one hour late. Check
suites, workflow runs, jobs and commit statuses created in that hour all read `09:xx`.

A check suite created just before 09:00 UTC was stamped about an hour late. Its jobs,
created a few seconds later but after 09:00, got correct timestamps. On paper every such
job looked an hour older than its own suite, and GitHub's "latest check runs" views left
those jobs out. Deploy Gate reads exactly that view, saw the required jobs as missing,
and kept `gate` pending indefinitely on PR #9964.

## Symptoms

- PR #9964, head pushed 08:59 UTC. All 27 Test jobs finished green by 09:03:32
  (`GET /actions/runs/41291134252/attempts/1/jobs`), yet `gate` stayed
  `pending` from 09:02 until the head was replaced at about 12:30.
- `gh pr checks` showed Lint, Typecheck, Proto and app checks but **no** Test jobs and no
  `security-audit`.
- `GET /actions/runs/41291134252/jobs` returned `total_count: 0` while the run said
  `conclusion: success`.
- Timestamps disagreed with ID order. Test run IDs 41289913946..41291134252 (really
  08:41-08:59 UTC) read `09:41`-`09:59`, and no Test run in the repo read
  between 07:52 and 09:41. That run's `created_at` (09:59:37) was later than its
  `updated_at` (09:03:32).
- Deploy Gate's event run after Test completed logged `gate unchanged for <sha> (pending)`.
  Every 30-minute sweep for the next three hours logged
  `attempt 1: changes=pending ... docs-stats=pending unit=pending ...`.

## What Didn't Work

- **Waiting for the sweep.** `.github/workflows/deploy-gate.yml:11` re-evaluates
  pending gates for 24 hours, which recovers stale reads (#5479). Here the read was not
  stale, though: it was consistently wrong, and every sweep re-read the same rollup.
- **`gh run rerun` of the old Test run.** It created attempt-2 check runs with fresh
  timestamps, so they became visible, but the rerun tests the original merge commit, which
  was then three hours old. `tests/mcp-alias.test.mjs:120` (`readBaseNames`) compares the
  registry against the *current* `origin/${GITHUB_BASE_REF}`. A tool merged to main in the
  meantime (`report_issue`, #9958) therefore failed
  `coverageGap › matches the sorted registry and the base revision` with
  `+ ['report_issue'] - []`, turning `unit-built-output` and `unit` red. That red was
  caused by re-running stale code, not by the PR.
- **Blaming GitHub "losing" the runs.** The runs were not lost.
  `GET /commits/<sha>/check-runs?filter=all` and `.../attempts/1/jobs` listed every job
  with its success.

## Solution

Push a fresh head. Rebasing onto current `main` produced new check suites and runs with
correct timestamps and a current merge ref, and the gate went green on its next
evaluation (PR #9964: 41 checks passed, including `gate`).

```bash
git fetch origin main
before=$(git rev-parse HEAD)
git rebase origin/main
# Already on main's tip: the rebase is a no-op and pushing the same SHA starts no checks.
[ "$(git rev-parse HEAD)" = "$before" ] && git commit --allow-empty -m "ci: re-run checks on a fresh head"
git push --force-with-lease origin <branch>
```

Prefer the rebase when main has moved: it also clears the gate's base-drift check and gives
tests that compare against `origin/main` a matching tree. Re-running the old run does make
fresh check runs visible, but it tests the stale merge tree (see What Didn't Work).

No change to Deploy Gate. The window is one hour a year, and only pushes whose suite is
created before 09:00 UTC with jobs created after it are affected (a few minutes of pushes).
One re-push per incident is cheaper than adding a second check-run source to the merge gate.

## Why This Works

`fetch_required_check_runs` in `.github/scripts/deploy-gate.sh:238` reads
`statusCheckRollup` over GraphQL (`:250`). It falls back to REST `check-runs` only when
GraphQL errors (`:268`), and that REST call uses the default `filter=latest`. Both views
returned the same incomplete set.

Which jobs disappeared is consistent with one rule: the rollup drops a check run that
looks older than its own check suite. A control from the same hour shows the boundary.
PR #9966 head `abaed1a` had its suite created around 08:58. Its 25 jobs created before
09:00 were stamped late along with the suite and stayed visible. Its two jobs created
after 09:00, `unit` and `variant-smoke-full`, disappeared from both the rollup and the
REST default view, and its gate stuck on exactly those two names. On #9964 the suite was
created at 08:59:37 and every job at 09:00:01 or later, so all 27 disappeared, plus
`security-audit` from the Security Audit suite.

A new push creates new suites and jobs with consistent timestamps, so the rule no longer
excludes anything.

## Prevention

- **Diagnose before re-running.** When `gate` waits on jobs that look finished, compare
  `GET /actions/runs/<id>/attempts/1/jobs` (complete) with `gh pr checks` or the rollup
  (incomplete). A run with `created_at > updated_at`, or IDs out of order with their
  timestamps, points at this timestamp bug rather than a CI failure.
- **Fix a stranded head by pushing, not re-running.** Re-running a run hours later tests
  an old merge tree against a moved base, and tests that read `origin/main` (such as
  `mcp-alias` `coverageGap`) fail on code the PR never touched.
- **Expect a repeat** on the next US fall-back: the first Sunday of November, 08:00-09:00
  UTC. A push in the last minutes before 09:00 UTC that day is the case to watch.

## Related

- `docs/solutions/integration-issues/npm-registry-outage-reds-the-security-audit-gate.md`
  covers another third-party fault that blocked the same gate.
- `docs/solutions/conventions/a-gate-required-check-must-be-an-if-gated-job-not-a-path-filtered-workflow.md`
  explains why the gate requires named jobs.
