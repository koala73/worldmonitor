---
title: "CodeQL default setup rejects every advanced-workflow upload, so the switch has to happen at the merge"
date: 2026-09-29
category: integration-issues
module: codeql
problem_type: integration_issue
component: development_workflow
severity: medium
symptoms:
  - "Every `Analyze (<language>)` job on the PR that adds `.github/workflows/codeql.yml` goes red after the analysis itself completes"
  - "Failure annotation: `Code Scanning could not process the submitted SARIF file: CodeQL analyses from advanced configurations cannot be processed when the default setup is enabled`"
  - "Warning annotation on every Analyze job: `Please specify an on.push hook to analyze and see code scanning alerts from the default branch on the Security tab.`"
root_cause: incomplete_setup
resolution_type: config_change
related_components:
  - tooling
tags: [codeql, code-scanning, github-actions, default-setup, advanced-setup, ci-performance]
---

# CodeQL default setup rejects every advanced-workflow upload, so the switch has to happen at the merge

## Problem

WorldMonitor ran CodeQL as GitHub **default setup** (no workflow file). It scanned all six languages on every merge to `main` and on every PR push. #8706 moved it to an **advanced** workflow, `.github/workflows/codeql.yml`, which selects languages per PR and scans `main` on a schedule. That landed as PR #8711. The PR's own CodeQL jobs could not go green before the merge, and nothing in the PR could fix that.

## Symptoms

- All six `Analyze` jobs on PR #8711 extracted and analysed normally (JS/TS about 9 min, Rust about 5 min), then failed at upload with the "cannot be processed when the default setup is enabled" annotation above.
- The first push of the PR also carried the "Please specify an on.push hook" warning on every `Analyze` job, because the workflow had only `pull_request`, `schedule` and `workflow_dispatch` triggers.
- The PR showed `mergeStateStatus: UNSTABLE`. The `Analyze` jobs are not required checks (the required checks are `biome`, `typecheck`, `gate` and `unit`), so the merge was not actually blocked. A red PR still looks unmergeable to anyone reading it.

## What didn't work

- **Waiting for a re-run, or pushing a fix.** The rejection comes from the repository setting, not from the workflow. Every run failed the same way while default setup was `configured`.
- **Turning default setup off early to get a green PR.** This was considered and rejected. The advanced workflow exists only on the PR branch until it merges, so `main` and every other open PR would go unscanned for as long as the PR stays open.

## Solution

**1. Scope a push trigger to the workflow file.** This removes the on.push warning without bringing back a scan on every merge (`.github/workflows/codeql.yml:7-9`):

```yaml
on:
  pull_request:
  push:
    branches: [main]
    paths: ['.github/workflows/codeql.yml']
  schedule:
    - cron: '23 3 * * 1-6'   # JS/TS
    - cron: '23 3 * * 0'     # all six
  workflow_dispatch:
```

The language selector treats every event other than `pull_request` as "all languages" unless it is the weekday cron (`.github/workflows/codeql.yml:39-40`). So a push that changes the workflow file scans all six. The merge that activates the workflow therefore starts the first full scan on `main` by itself, and no manual dispatch is needed.

**2. Switch the setting at the merge, not before.** Turn default setup off immediately before merging, then merge:

```bash
gh api -X PATCH repos/OWNER/REPO/code-scanning/default-setup -f state=not-configured
gh api repos/OWNER/REPO/code-scanning/default-setup -q .state   # expect not-configured
gh pr merge <N> --squash --match-head-commit <reviewed-sha>
```

To roll back, do both of these. Re-enabling default setup alone leaves the advanced workflow running, and its uploads are then rejected again:

```bash
gh workflow disable codeql.yml -R OWNER/REPO
gh api -X PATCH repos/OWNER/REPO/code-scanning/default-setup -f state=configured
```

**3. Check parity from the analyses API, not from green jobs.** List the analyses for the merge commit only, then do the same for default setup's last scan (the commit just before it), and compare them category by category:

```bash
SHA=<merge-commit-sha>
gh api "repos/OWNER/REPO/code-scanning/analyses?ref=refs/heads/main&per_page=100" \
  -q ".[] | select(.commit_sha == \"$SHA\") | \"\(.category) results=\(.results_count) error=\(.error)\""
```

The same category list, with every `error` empty, shows every language uploaded. Matching `results_count` values are a count check, not proof that the same alerts were found. For a real comparison, fetch each analysis as SARIF (`gh api -H 'Accept: application/sarif+json' repos/OWNER/REPO/code-scanning/analyses/<id>`) and compare the rule IDs and locations.

On 2026-09-29 the merge commit of #8711 produced all six categories (`/language:javascript-typescript`, `rust`, `go`, `actions`, `python`, `ruby`) with empty `error`. The JS/TS scan reported 583 results and the other five reported 0, the same counts as default setup's final run on the commit just before. The SARIF was not diffed. Default setup's last upload was at 08:30:56 UTC and the advanced run started at 08:32:16 UTC, so there was no gap in coverage.

## Why this works

GitHub allows only one of the two configurations per repository. While default setup is on, SARIF from any advanced workflow is refused at processing time, after the runner time has already been spent. Turning default setup off immediately before the merge limits the window with no scanning to minutes. The path-scoped push trigger makes that merge start the replacement scan.

The on.push warning is codeql-action's lint for a workflow that cannot populate default-branch alerts from pushes. Scheduled runs on `main` do populate the Security tab, so the warning was noise. A push trigger limited to the workflow file satisfies the lint without the cost the migration was meant to remove.

## Prevention

- **Plan the migration as a settings handover.** Expect the PR's `Analyze` jobs to stay red until the merge. Keep them out of the required checks. Write the handover steps (turn off, merge, verify, rollback) into the PR description before asking for review. `CONTRIBUTING.md` has a "CodeQL scan schedule and setup handover" section.
- **Measure default setup before estimating savings.** Default setup names each PR-triggered run `PR #<number>`, with event `dynamic`. The merge scans appear as one workflow, `Push on main`. Grouping Actions runs by workflow name therefore splits the PR scans into hundreds of small groups, and the first estimate in #8706 missed them. Filter by path instead: `path == "dynamic/github-code-scanning/codeql"` catches both. Measured over 7 days before the switch: about 3,200 runner-min on PR scans plus 2,972 on merge scans.
- **Keep the query suite the same.** The default-setup state reported `query_suite: default`, and the advanced workflow sets no `queries:`, so it also runs the default suite. Compare `results_count` per category after the switch. A drop is a signal to diff the two analyses' SARIF, not proof of lost coverage on its own.
- **Budget the overlay-base caches.** Both setups save a CodeQL overlay-base database to the Actions cache on every default-branch run: about 1.37 GB for JavaScript, under a key that includes the commit SHA, run ID and attempt. The action never deletes them (codeql-action `src/trap-caching.ts:228` is its only cache deletion, and it handles TRAP caches).
  - The key's hash comes from the workflow path, job and matrix values. So after the switch, default setup's bases can never be restored again. #8717 deleted 12 of them, about 4.2 GB.
  - The `prune-overlay-bases` job (#8718) now keeps only the newest base per group after each default-branch scan. On its first run, on the #8718 merge, it logged `kept 4, deleted 4, freed 1392298522 bytes`.
  - Without it, eviction by last access lets each fresh base push out idle dependency caches first.

## Related

- `docs/solutions/performance-issues/superseded-ci-runs-burn-runner-capacity.md`, whose CodeQL and `npm ci` items are now resolved.
- #8706 (issue) and #8711 (the PR that made the switch).
- #8717 (issue) and #8718 (the PR that prunes the overlay-base caches).
