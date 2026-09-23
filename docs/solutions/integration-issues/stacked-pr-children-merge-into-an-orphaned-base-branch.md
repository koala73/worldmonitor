---
title: Stacked PR children merge into an orphaned base branch when the parent's branch survives
date: 2026-09-22
category: integration-issues
module: GitHub PR workflow (stacked PRs)
problem_type: integration_issue
component: development_workflow
symptoms:
  - "A child PR shows MERGED, but its changes are not on main"
  - "The PR page reads 'merged into feat/<parent-branch>' rather than 'merged into main'"
  - "The stacked-merge integration monitor files a 'Stacked merge integration ... is unproven' issue after the merge"
  - "stacked-merge-guard was green on the child when it was merged"
root_cause: missing_workflow_step
resolution_type: workflow_improvement
severity: high
tags: [stacked-prs, github, retarget, squash-merge, stacked-merge-guard, branch-protection]
---

# Stacked PR children merge into an orphaned base branch when the parent's branch survives

## Problem

A stack of PRs was merged in order. The parent (#8518, live-video 3/5) squash-merged into `main`,
but its head branch `feat/live-news-session-v2` was not deleted. The two children (#8519, #8520)
still targeted that branch. They merged into it eight and twelve minutes later, and none of their
changes reached `main`.

## Symptoms

- #8519 and #8520 showed MERGED. `main` still lacked the 4/5 audit workflow
  (`.github/workflows/live-video-source-audit.yml`), and 5/5's scraper removal had not happened:
  `youtubei.js` was still in `package.json`.
- The post-merge monitor filed #8528 and #8529 ("Stacked merge integration: #8519 on main ...
  integration-unproven").
- `stacked-merge-guard` was green on both children when the merge button was pressed.

## What Didn't Work

- **Relying on `stacked-merge-guard`.** It already has the right rule:
  `evaluatePreMergeGuard` in `scripts/check-stacked-merge.mjs` returns `base-pr-merged` when the PR's
  base is the head of a merged PR. Its verdict was stale and could not block the merge:
  - **It never re-ran.** `.github/workflows/stacked-merge-guard.yml` triggers only on the child's own
    `pull_request` events (`opened, synchronize, reopened, edited, ready_for_review`). A parent merging
    emits none of these for the child. The guard last ran on #8519 and #8520 about 50 minutes before
    they merged.
  - **It is not required on stacked branches.** Branch protection requires checks only on `main`. The
    only ruleset covers deletion and non-fast-forward, so even a red guard cannot disable the merge
    button on a non-`main` base.
- **Assuming GitHub retargets children on merge.** It retargets them only when the parent's head branch
  is **deleted**. The repo has `delete_branch_on_merge: false`. In the same stack, the owner deleted
  #8517's branch 5 s after merging and #8518 was retargeted to `main` correctly. #8518's branch was
  not deleted, so its children stayed put.

## Solution

**Recovery (#8533).** The stranded layer is exactly the diff from the parent PR's final head to the
tip of the orphaned branch. The parent's squash commit on `main` has a different identity, so a
three-dot diff against `main` would also sweep in the parent's content.

```bash
PARENT_HEAD=4e9b2b9edacf0b485cf09824dd003b14f8420610   # #8518's final pre-squash head (not reachable from main after the squash; that is expected)
git fetch origin main feat/live-news-session-v2
# Preview: does the stranded layer apply to current main without conflicts?
git merge-tree --write-tree --merge-base="$PARENT_HEAD" origin/main origin/feat/live-news-session-v2
# Apply it on a fresh branch off main
git switch -c fix/live-video-reland-4-5-stranded origin/main
git diff "$PARENT_HEAD" origin/feat/live-news-session-v2 --binary | git apply -3
```

Verify on `origin/main` after the recovery PR merges: the three 4/5 files exist, and `youtubei.js` and
`YOUTUBE_PROXY_URL` are gone. Keep the orphaned branch until then as evidence.

**Prevention (#8534, open as of this writing).** When a PR merges, the monitor moves its open children
to the merged PR's base with `PATCH /pulls/{n}`, which is what GitHub does itself on branch deletion.
It then re-runs each child's guard. The guard also reads the live base from the API, because a
re-run replays the original event with the old base.

## Why This Works

The failure needs three things at once:

- the parent's head branch outlives the merge;
- the child's CI verdict is not recomputed when the parent merges;
- no required check applies to the child's base branch.

Retargeting on merge removes the first condition regardless of the other two: a child based on
`main` cannot merge anywhere else. The existing `base-pr-merged` rule stays as an advisory backstop.

## Prevention

- **Turn on `delete_branch_on_merge`**, or delete each parent branch immediately after it merges.
  GitHub then retargets the children itself. This is the cheapest fix, and it worked for #8517 → #8518.
- **Before merging a stacked child, confirm its base is `main`.** If the PR page says it merges into
  the parent's feature branch and the parent has already merged, retarget first: `gh pr edit <n> --base main`, then merge
  `main` into the child's branch.
- **Treat a green guard on a stacked PR as possibly stale.** Its last run may predate the parent's
  merge.
- **Only a required check can block the merge button on a stacked PR.** That needs a ruleset covering
  all branches that requires `stacked-merge-guard`; `main`'s protection does not reach stacked bases.
- **When handing a stack to someone to merge**, state the retarget or delete-the-branch step next to
  the merge order.

## Related Issues

- #8528, #8529: integration-unproven reports for #8519 and #8520
- #8533: recovery PR that landed the stranded 4/5 and 5/5 on `main`
- #8534: auto-retarget of children on parent merge (open as of this writing)
- #7006: earlier orphaned-stacked-merge incident, the reason the monitor exists
- **The reverse case, in the same stack.** #8164 (2/5) was auto-closed, not rejected, when #8163's
  branch was deleted after it squash-merged, three days after the merge. Contrast #8518, which GitHub
  retargeted when #8517's branch was deleted seconds after its merge. An auto-closed child can look
  abandoned; check the timeline for `base_ref_deleted` before assuming it was rejected.
- **Reviving an old stack.** Re-landing the stack on fresh branches hit the pre-push base guard: a
  branch more than 20 commits ahead of `main` is refused, and #8163's pre-squash history pushed these
  branches over. Squash each layer onto a fresh branch off `main` (#8517 → #8518 → #8519/#8520) rather
  than bypassing the hook.
