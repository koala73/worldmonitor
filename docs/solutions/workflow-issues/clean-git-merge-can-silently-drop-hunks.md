---
module: git_merge_integrity
date: 2026-09-05
problem_type: workflow_issue
component: development_workflow
severity: high
symptoms:
  - "A test that is green on origin/main fails on the feature branch immediately after `git merge origin/main` reports 'Merge made by the ort strategy' with no conflicts"
  - "The merged test file contains hunks from BOTH parents' versions of the file — e.g. an import added by one parent and a fixture call added by the other — while a line from the second parent silently disappears"
  - "`git diff origin/main -- <file>` on the merged branch shows a diff for a file the feature branch never touched"
root_cause: silent_merge_mangling
resolution_type: workflow_improvement
related_components: [testing_framework, ci_gates]
tags: [git-merge, auto-merge, frankenstate, ort-strategy, both-parents-verification, ci-repair, preview-namespace]
---

# A clean git merge can silently drop hunks — verify the result against BOTH parents

## Problem

Merging `origin/main` into a feature branch with a clean (no-conflict) merge produced a test file that carried changes from both sides of the merge but silently LOST a line (`...altSourcesLiveRedis()` seeding call) that existed in main's version. The branch's CI then failed a test that passes on main, with no git-level signal that the merge had mangled anything.

## Symptoms

- `git merge origin/main` reports `Merge made by the 'ort' strategy` with no conflicts, and the branch's own full test suite may even pass locally (the affected test file's failure mode only shows on a combined run or a specific test).
- On the merged branch, `git diff origin/main -- <untouched-file>` is non-empty for files the feature branch never modified — that diff is the merge mangling made visible.
- CI fails a test that is green on main's own runs, immediately after the merge.

In the concrete case (PR #7694, issue #7674), the merged `tests/temporal-anomalies-cache.test.mts` gained main's `COUNT_SOURCE_KEYS` import from PR #7673's rework but lost the `...altSourcesLiveRedis()` seeding line from a later main commit (#7682's expanded count sources), so the rebuild saw 2 covered sources where the registry now expected 5.

## What Didn't Work

- Trusting `git status` / `git log` on the merge commit: the merge is a normal two-parent commit and the mangled file is a plausible-looking auto-merge result, so nothing looks broken.
- Reasoning from the commit merge-base: with `ours == merge-base` for a file, a merge SHOULD take theirs verbatim — but hunks can still interleave when both parents' histories independently edited the same region across DIFFERENT intermediate commits between the merge-base and each parent's tip. History archaeology of "why did git do this" is not a prerequisite for the fix.

## Solution

After any merge, diff the merge result against BOTH parents for the files that matter, and read the post-merge tree as a whole:

```bash
# What did the merge change relative to my branch?
git diff HEAD^1 HEAD --stat
# What did the merge change relative to main? (should be ONLY my intended changes)
git diff origin/main --stat
```

Anything appearing in the second diff that the branch never intended to change is merge damage: take the correct parent's version explicitly (`git checkout origin/main -- <path>` for files where main is authoritative) rather than hand-editing the frankenstate. Then re-run the suite before pushing.

## Why This Works

The two diffs bracket the merge: the first shows what the merge imported from main, the second shows what remains different from main. A file that appears in the second diff without a matching branch intention means the auto-merge synthesized content from both sides — which is only correct when BOTH edits were wanted. The checkout-from-parent approach replaces the ambiguous interleaved result with a known-good version, and `origin/main`'s version is known-good precisely because main's own CI gates ran on it.

## Prevention

- After EVERY merge into a PR branch, run `git diff origin/main --stat` and reconcile every file that is not part of the branch's intended change set. This one command is the whole detection.
- When a merge-branch CI failure names a test that is green on main, before debugging the test, diff the merged file against origin/main — the failure is usually the merge, not the code.
- Watch for the specific shape: a diff that shows an ADDED import/fixture from one parent and a MISSING sibling line from the other in the same file. That combination is the frankenstate signature; a one-sided merge cannot produce it.

Related: the deployment key-prefix write-ownership contract lives in
`docs/solutions/logic-errors/deployment-key-prefix-is-a-write-ownership-contract.md`
(landed with #7673); the branch this merge damaged was that contract's
implementation PR, so the two learnings travel together.
