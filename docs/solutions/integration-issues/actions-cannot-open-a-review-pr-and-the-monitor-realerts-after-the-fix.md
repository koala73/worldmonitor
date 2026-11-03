---
title: A repo setting blocked every automated review PR, and the pulse monitor re-alerted on a remedied failure
date: 2026-09-20
category: integration-issues
module: crawlable-pulse-refresh
problem_type: integration_issue
component: development_workflow
symptoms:
  - "`pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)` on the workflow's final step after a full, passing freeze"
  - "All four crawlable-pulse-refresh runs between 2026-09-02 and 2026-09-14, three scheduled and one dispatched, failed in the rebuild-and-verify step, skipped the PR step, and kept the capture only as a 14-day artifact"
  - "The pulse-freshness monitor opened #8417 with finding refresh-failed the morning after the cited failure was fixed, against a snapshot one day old"
  - "`gh pr list --author app/github-actions` returns nothing; no automation-opened PR has ever existed in this repository"
  - "The monitor only PATCHes the open issue body and never comments or closes it once the verdict is healthy"
root_cause: missing_permission
resolution_type: workflow_improvement
severity: high
related_components: [testing_framework, documentation, tooling]
tags: [github-actions, workflow-permissions, crawlable-pulse, freshness-monitor, scheduled-workflow, pull-request-automation, stale-alert, review-pr-token]
---

# A repo setting blocked every automated review PR, and the pulse monitor re-alerted on a remedied failure

## Problem

The pulse freshness monitor filed issue #8417 the morning after the problem was fixed. It compared nothing but the last refresh run's conclusion, so a failed run from 2026-09-14 still read as a finding against a snapshot captured on 2026-09-19. The investigation into why the weekly refresh kept failing then found a second, older fault. No automated review-PR workflow in this repository has ever opened a pull request, because the repository setting that lets GitHub Actions create pull requests is off.

## Symptoms

- Issue #8417 "Crawlable pulse refresh: snapshot is going stale" opened with finding `refresh-failed` while `docs/snapshots/crawlable-live-pulse-2026-09-19.json` was one day old.
- The failing run it cited was already remedied on main by PR #8345, and the snapshot it protects was already refreshed by PR #8340.
- The monitor only PATCHed the open issue body, which sends no notification, and never closed the issue on recovery.
- Every `crawlable-pulse-refresh.yml` run in the window, three scheduled and one dispatched, failed in the same step, and each failure discarded the capture.

| run date | failing assertion | remedy |
| --- | --- | --- |
| 2026-09-02 | calendar-pinned lastmod regex in `tests/crawlable-corpus.test.mjs` | #7533 |
| 2026-09-07 | `assertPulseFixtureShape` country keys, Tonga added | #7884 |
| 2026-09-09 | `assertPulseFixtureShape` signalConvergence nested shape | freeze + fix |
| 2026-09-14 | title-keyed Map in `tests/welcome-teasers.test.mjs` | #8345 |

The thresholds the monitor works against.

| setting | value | source |
| --- | --- | --- |
| `PULSE_SNAPSHOT_WARN_AGE_DAYS` | 8 | `scripts/check-pulse-freshness.mjs:54` |
| snapshot age ceiling | 10 | `MAX_LIVE_PULSE_SNAPSHOT_AGE_DAYS`, enforced by the corpus build |
| refresh cron | `'41 4 * * 1'` | `.github/workflows/crawlable-pulse-refresh.yml:18` |
| monitor cron | `'17 7 * * *'` | `.github/workflows/pulse-freshness-monitor.yml:22` |

The snapshot never crossed the warning line during those four failures, so the run conclusion was the only live signal, and that signal had no expiry.

- A `workflow_dispatch` on 2026-09-20 (run 35500788519) froze the pulse, rebuilt every artifact, passed the whole verification suite, then died on its last step.

```
pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)
```

- `resilience-snapshot-refresh.yml` run 33473678590 on 2026-09-01 died with the identical message. `github-stars-refresh.yml` has never run.

## What Didn't Work

- Issue #8339 claimed the freeze was manual. The workflow existed and had been running weekly on `'41 4 * * 1'`.
- #8339 also proposed lowering the snapshot age ceiling from 10 days to 3. That reds the build, because `tests/crawlable-corpus.test.mjs` asserts the ceiling sits within one to two times the cadence.
- The monitor added in PR #8346 alerted on a real symptom with a stale-signal design. The signal was a run conclusion with no comparison against the artifact the run produces.
- `gh pr list --author app/github-actions` returned nothing. That empty result was the finding, not a dead end.
- Flipping the repository setting by API from the agent session was blocked by the permission classifier. It needs the repository owner.
- Local lint and YAML tooling was absent. There is no eslint config (the repo lints with biome), and neither pyyaml nor actionlint was installed on the machine used in this session. Ruby Psych and `bash -n` filled in.

Diagnostics that did work.

```bash
gh run list --workflow=crawlable-pulse-refresh.yml --json databaseId,conclusion,createdAt
gh run view <run-id> --json jobs
gh run view <run-id> --log-failed
gh api repos/{owner}/{repo}/actions/permissions/workflow
gh api repos/{owner}/{repo}/branches/main/protection
```

The permissions read returned `{"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}`, which names the exact block in the GraphQL error.

## Solution

Two code changes, both opened in PR #8422, unmerged as of this writing.

First, the monitor learns what supersedes a failure. `readNewestSnapshot` now carries `capturedAtMs` through the verdict (`scripts/check-pulse-freshness.mjs:81`), `capturedInstant` falls back to the capture date at midnight UTC when the field is absent (`scripts/check-pulse-freshness.mjs:100`), and the verdict marks a failed run older than the capture as superseded rather than reporting it (`scripts/check-pulse-freshness.mjs:150`).

```js
const failed = Boolean(lastRun?.conclusion) && lastRun.conclusion !== 'success';
const superseded = failed && capturedInstant(snapshot) > Date.parse(lastRun.createdAt ?? '');
if (failed && !superseded) {
  reasons.push({ kind: 'refresh-failed', detail: /* ... */ });
}
```

A run with no `createdAt` parses to `NaN` and is never superseded, so the alarm fails closed. `publishPulseFreshness` now comments with `renderRecovery` and closes the issue when the verdict is healthy (`scripts/check-pulse-freshness.mjs:207`, `scripts/check-pulse-freshness.mjs:216`, close at `scripts/check-pulse-freshness.mjs:240`).

Second, the refresh workflow keeps the capture when verification drifts. The old single rebuild-and-verify step is split into `Rebuild published artifacts` with `id: build`, which owns `npm run build:crawlable-corpus` and its coverage floor (`.github/workflows/crawlable-pulse-refresh.yml:128`), and `Verify published artifacts` with `id: verify`, which owns the `node --test` run (`.github/workflows/crawlable-pulse-refresh.yml:147`). The prune and PR steps then gate on the build alone.

```yaml
if: ${{ !cancelled() && steps.build.outcome == 'success' }}
```

The PR step reads `VERIFY_OUTCOME: ${{ steps.verify.outcome }}` and opens a draft naming the failed run when verification did not succeed (`.github/workflows/crawlable-pulse-refresh.yml:204`). Both the reconcile step and the PR step now prefer a configured token, `GH_TOKEN: ${{ secrets.REVIEW_PR_TOKEN || github.token }}` (`.github/workflows/crawlable-pulse-refresh.yml:64`, `.github/workflows/crawlable-pulse-refresh.yml:182`).

The repository-level block needs the owner and has two remedies.

1. Enable the repository setting "Allow GitHub Actions to create and approve pull requests".
2. Store a fine-grained PAT as the `REVIEW_PR_TOKEN` secret, with contents write and pull requests write.

Only the second remedy also gives the PR its CI. GitHub documents that events created with the Actions token do not start new workflow runs, so a PR it opens gets no `pull_request` checks, and main's protection requires the checks biome, typecheck, gate and unit with `enforce_admins` true, so a PR opened by `github.token` can pass the setting and still be unmergeable.

This week's capture was published by hand as PR #8421, merged on 2026-09-20, with `gh pr create --head automation/crawlable-pulse-2026-W38`.

## Why This Works

A run conclusion is a point-in-time fact about a process. The artifact that process maintains carries its own timestamp. Comparing the two turns the alarm from "the last attempt failed" into "the last attempt failed and nothing has fixed it since", which is the only version worth paging on. The midnight-UTC fallback keeps a date-only capture from swallowing a run that failed later the same day.

Closing on recovery matters for the same reason a body PATCH was wrong. GitHub notifies on comments and on state changes, not on silent body edits. An issue that is never closed becomes the one nobody watches, so the next real finding lands as an edit to a muted thread.

The build and verify split follows the cost of the two failure modes. A rejected build means the data itself failed the coverage floor, so publishing it would be wrong. A failed verification means a test needs updating for a legitimately fresh capture, and that capture cost roughly 190 index requests and 100 LLM calls. Opening it as a draft puts the fix and the data in the same branch, and a push to that branch runs CI on the PR, which a 14-day artifact never does.

The draft is also the only publication vehicle left for the week. The reconcile step skips any period whose PR already exists, keyed on the ISO year-week branch name, so once the draft is open a test fix, a generator fix and a hand re-capture all have to land in that branch. The draft body says so and names the failed run, which is why the body is built conditionally instead of being a fixed string.

The token preference is not a nicety. It is the difference between a PR that exists and a PR that can merge.

The fix was checked against the real surface, not only fixtures. The patched evaluator run against the repository state on 2026-09-20 returned `alert: false` with `lastRun.superseded` true, where the shipped code returned `refresh-failed`. A dispatch of the fix branch (run 35501660765) parsed on GitHub and took the reconcile skip path against PR #8421.

## Prevention

- `tests/ci-workflow-coverage.test.mts:753` pins the whole workflow contract. It asserts the `build` and `verify` ids, that the verify step has no `continue-on-error`, the exact `!cancelled() && steps.build.outcome == 'success'` condition on both downstream steps, the draft branch, and the `REVIEW_PR_TOKEN || github.token` preference on both `gh` steps.
- `tests/pulse-freshness-monitor.test.mjs` covers 19 cases. Four are new and were red before the fix, at lines 103, 114, 124 and 213. They pin the superseded case, the same-day run that is still reported, the fail-closed fallback when `capturedAtMs` is missing, and the close-with-comment on recovery.
- Recovery from a PR-step failure is cheap and needs no re-freeze. The reconcile step turns an orphan `automation/crawlable-pulse-<week>` branch into a PR on the next run, so a `workflow_dispatch` re-dispatch is enough. The manual fallback is `gh pr create --head automation/crawlable-pulse-<week>`.
- When adding any monitor that alarms on a run conclusion, compare the run's timestamp against the artifact it protects, and make the publisher close its issue on recovery.
- Before trusting a workflow that is supposed to open PRs, check `gh api repos/{owner}/{repo}/actions/permissions/workflow` and confirm at least one such PR exists. An empty `gh pr list --author app/github-actions` means the path has never worked.
- A keyless local freeze exits 0 and writes a snapshot with zero country briefs. Check `coverage.briefCountryCount` before committing, and run both follow-ups, `npm run teasers:welcome` and `npm run build:llms-full` (auto memory [claude]).
- `gh pr checks --watch` exits 0 on failure. Confirm CI through `statusCheckRollup` (auto memory [claude]).

## Related Issues

- Issue #8417, the false alarm and the PR-creation block. Fix opened in PR #8422, unmerged as of this writing.
- PR #8421, this week's capture published by hand, merged on 2026-09-20.
- Issue #8339, the first report of the silent weekly failures, with the two misleading claims corrected above.
- PR #8346, which added `scripts/check-pulse-freshness.mjs` and `.github/workflows/pulse-freshness-monitor.yml`.
- PR #8345 and PR #8340, the per-week remedies merged on main, and issues #7884 and #7533, the earlier per-week failures, closed as completed.
- `.github/workflows/resilience-snapshot-refresh.yml` and `.github/workflows/github-stars-refresh.yml`, the other two review-PR workflows behind the same repository setting.

Related docs in this store.

- [A gate exemption is only as strong as the job that enforces it](../workflow-issues/a-gate-exemption-is-only-as-strong-as-the-job-that-enforces-it.md), a CI step that silently does not run reads as skipping rather than failed, and the same `gh pr checks --watch` trap.
- [A gate required check must be an if-gated job](../conventions/a-gate-required-check-must-be-an-if-gated-job-not-a-path-filtered-workflow.md), the other doc that pins its contract in `tests/ci-workflow-coverage.test.mts`.
- [Cooldown keyed on time since emission drops a genuine escalation](../logic-errors/cooldown-keyed-on-time-since-emission-drops-a-genuine-escalation.md), an alarm keyed on the wrong record, the same shape as a run conclusion with no expiry.
- [Retention that outlives its own alarm](../logic-errors/retention-that-outlives-its-own-alarm.md), two-clock alarm design.
- [Merged is not ran for long-cron seeders](./merged-is-not-ran-long-cron-seeders.md), a merged fix is not live until its cron fires, which is the gap the monitor mis-read.
- [A Railway cron crash behind a failed build never self-heals](./railway-cron-crash-behind-failed-build-never-self-heals.md), a scheduled job that stopped while the routine signals stayed green, diagnosed from CLI JSON.
