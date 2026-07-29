---
module: pre-push-gate
date: 2026-07-29
problem_type: logic_error
component: build_system
severity: high
symptoms:
  - "A changed test file is in the pushed commit but never appears in any runner invocation, and the gate exits 0"
  - "A push whose branch diff contains a unicode or backslash path runs nothing for that path"
  - "A tree that only ever passed the origin/main-unresolvable fallback later cache-hits and skips every gate"
root_cause: logic_error
resolution_type: workflow_improvement
related_components: [development_workflow, tooling, testing_framework]
tags: [pre-push, husky, green-while-dead, quotepath, nul-delimited, worktree-drift, attestation, bash, git-diff]
---

# The pre-push green-tree cache attested a tree the gates never ran against

## Problem

`.husky/pre-push` caches `HEAD^{tree}` after a green run and, on a later push of that tree, skips every tree-dependent gate. Three separate defects let it write that entry after a run that never exercised the pushed bytes — so each one was not "a bad run" but **a bad run that suppresses all future runs of that tree** (#5800, fixed in PR #5809).

## Symptoms

The unifying tell is silence: a file is unmistakably in the push, and no runner invocation ever names it, and the gate exits 0.

```
# committed diff says two tests changed
tests/alpha.test.mjs
tests/beta.test.mjs

# what the gate actually ran
tests/alpha.test.mjs
exit=0                       # beta.test.mjs never ran, tree stamped green
```

## What Didn't Work

**Reading the hook and reasoning about it.** All three defects are invisible in the source — every line is individually plausible. `[ -f "$file" ] || continue` reads as sensible deletion handling; `git diff --name-only` reads as the obvious way to list changed paths; the cache write sits under a comment that confidently explains why it is safe. Each was only provable by building a git fixture and watching the gate return 0 over a file it should have run.

**Trusting a green push as verification of the fix.** After landing the change, the push succeeded and printed `All pre-push gates passed — tree cached.` — the *old* hook's wording. `core.hooksPath` in the shared `.git/config` was an absolute path to the main checkout, so the worktree's hook never ran (see [Why the verification almost lied](#why-the-verification-almost-lied)).

## Solution

### 1. The gates run the WORKTREE; the cache claims HEAD

`CHANGED_FILES` came from `git diff origin/main...HEAD` (the committed tree) but the runners execute against the worktree, and the cache records `HEAD^{tree}`. Existence was then inferred from the filesystem:

```sh
[ -f "$file" ] || continue          # "the push deleted it" — or the worktree drifted
```

Those two states are indistinguishable to `[ -f ]`, and the second one is the bug: an unstaged `rm` of a changed test dropped it from the run; an unstaged **fix** made the suite pass over the broken bytes actually being pushed. Either way `HEAD^{tree}` went into the cache.

Deletion is now git's answer, not the filesystem's, and drift is measured explicitly:

```sh
# scripts/prepush-attest.sh — "paths that exist in the pushed commit"
git diff --name-only -z --no-renames --diff-filter=d "$base...HEAD"
```

`--diff-filter=d` is the lowercase *exclude* form ("everything except deletions"), chosen over an `ACMR` allow-list so a status letter git adds later lands on the "exists" side rather than vanishing from the run.

Two tiers, because they cost differently:

- Drift **inside the branch diff** blocks the push. `WM_ALLOW_WORKTREE_DRIFT=1` opts out and still cannot cache — a drifted worktree is dirty by definition, and the cache write refuses on that.
- Dirt **anywhere else** (including a non-ignored untracked file — a forgotten `git add` the gates can import and the push cannot deliver) only forfeits the attestation. Blocking every push carrying an unrelated scratch edit would be a gate nobody passes.

### 2. `core.quotePath` silently renamed paths out of existence

Git's **default** `core.quotePath=true` C-quotes non-ASCII paths in `--name-only`, and backslash/quote/newline paths are C-quoted regardless of that setting. The quoted form matches no file, so `[ -f ]` dropped it:

```
$ git diff --name-only origin-main...HEAD
tests/alpha.test.mjs
"tests/back\\slash.test.mjs"        -> DROPPED
"tests/caf\303\251.test.mjs"        -> DROPPED
tests/with space.test.mjs
```

`core.quotePath=false` is **not** the fix — it only governs the non-ASCII case. `-z` is:

```sh
git diff --name-only -z --no-renames "$base...HEAD"
```

Since command substitution cannot carry NUL bytes, the string variable had to go: the list is a bash array end to end, moved between the hook and `scripts/prepush-changed-tests.sh` through temp files, with `read -r -d ''` on both sides. That also removed a live word-splitting bug — `npx tsx --test $SEED_TESTS` turned `tests/trade flows-seed.test.mjs` into two nonexistent arguments.

`--no-renames` for a related reason: rename detection reports only the *destination*, so moving any `scripts/seed-NAME.mjs` to `tests/NAME-seed.test.mjs` left nothing under `scripts/` for the seed category to scope on. Every gate here scopes by path prefix, so a path that stopped existing is exactly as interesting as one that started.

### 3. The fallback cached a partial run as fully green

When `origin/main` is unresolvable the hook sets `RUN_ALL`, and `RUN_ALL` **explicitly skips** the local unit suite — yet the write fired anyway, under a comment asserting the opposite:

```sh
# Writes stay enabled: a fallback run executes everything, the strongest attestation.
```

It does not execute everything. The write now refuses when the branch diff was unresolvable, and the refusal states its reason.

### Why the decisions moved into a script

Every one of these is a "can this report green while the thing is dead" question, and the hook is the one file that cannot be executed cheaply in a test (it runs tsc, esbuild, vite). Grepping its source is not a substitute — a source guard stays green when a `true` becomes `false`. So the git-facing decisions live in `scripts/prepush-attest.sh` with three-valued exits (`0` yes / `3` no / `2` usage / `1` internal), and two test files cover it from both sides:

- `tests/prepush-attest.test.mjs` — executes each mode against real git fixtures.
- `tests/prepush-hook-gate.test.mjs` — runs the **real hook** end to end in a fixture repo with `npm`/`npx`/`node`/`gh`/`make` stubbed, then asserts what it dispatched and whether it cached.

## Why This Works

The invariant is one sentence: **the cache attests `HEAD^{tree}`, so it may only be written when the gates ran against `HEAD^{tree}`.** Everything else follows — a dirty worktree is not that tree, and a fallback run that skipped the unit suite did not gate that tree.

The exit codes matter as much as the logic. "The gate says no" and "the gate could not run" must never collapse into the same status as "the gate says yes", which is why `dirty` returning non-zero for *any* reason leaves `ATTESTABLE=false`.

## Prevention

**Never infer a git fact from the filesystem.** `[ -f ]` cannot distinguish "the push deleted it" from "your worktree is not what you are pushing". Ask git; it knows both.

**`git diff --name-only` is not a path list.** It is a *display* format, lossy by default. Any consumer that will `test`, `open`, or `exec` those paths needs `-z`. If the surrounding design cannot carry NUL (command substitution cannot), that design has to change — files and pipes carry it fine.

**Prove a gate by making it fail.** Each fix here was mutation-checked: revert it, confirm a test goes red, restore. Drift check removed -> 2 red; unconditional cache write -> 6; `-z` dropped -> 13; silent `[ -f ]` skip restored -> 1; `--no-renames` dropped -> 2. A guard nobody has watched fail is not known to work.

```sh
# the shape of the harness that made the hook itself testable
for cmd in npm npx node gh make; do printf '#!/bin/sh\necho "%s $*" >> "$LOG"\nexit 0\n' "$cmd" > "$BIN/$cmd"; done
PATH="$BIN:$PATH" WM_ALLOW_FOREIGN_HOOKS=1 bash .husky/pre-push origin <url>
```

Keep the stub directory and its log **outside** the fixture repo — untracked stub files inside it make the worktree dirty, and the gate correctly refuses to attest.

**A green push is not evidence your hook change ran.** Confirm `git config --show-origin --get core.hooksPath` is relative *first*, clear `$(git rev-parse --git-dir)/wm-prepush-green`, then invoke the hook directly. The fastest tell that a foreign hook executed is its **last output line**: stale copies betray themselves with wording the current source no longer contains. See [git-push-timeout-stale-core-hookspath](../performance-issues/git-push-timeout-stale-core-hookspath.md) — the in-hook self-identity tripwire cannot catch this case, because a stale copy that predates the tripwire does not contain it (tracked as #5810).

**Watch for the unmatched-glob `&&`/`||` trap**, found by this harness in the same file:

```sh
for f in scripts/*.cjs; do
  [ -f "$f" ] && node -c "$f" || exit 1   # no .cjs files -> exit 1, no message
done
```

An unmatched glob expands to the literal pattern, `[ -f ]` fails, and the `||` fires — so "there is nothing to check" failed every `RUN_ALL` push silently. Split the test from the action: `[ -f "$f" ] || continue` then `node -c "$f" || exit 1`.

## Related

- [Pre-push fed vitest DOM tests to the node:test runner](../test-failures/pre-push-fed-vitest-dom-tests-to-the-node-test-runner.md) — the same hook; its cross-model review is what surfaced these three.
- [git-push-timeout-stale-core-hookspath](../performance-issues/git-push-timeout-stale-core-hookspath.md) — the absolute `core.hooksPath` that hid this fix's verification.
