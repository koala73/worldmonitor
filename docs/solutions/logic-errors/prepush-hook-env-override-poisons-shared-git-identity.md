---
title: "Git-exported hook env vars override cwd, letting un-isolated test fixtures poison the shared git identity"
date: 2026-08-30
category: logic-errors
module: pre-push-identity-gate
problem_type: logic_error
component: development_workflow
severity: high
symptoms:
  - "Commits land on main and PR branches authored/committed as test <test@example.com>, Fixture <fixture@example.invalid>, WorldMonitor Test, or e <e@e.co> -- none of them real contributors"
  - "git config --global user.name always shows the correct identity while the poisoned value lives in the repo-local SHARED .git/config"
  - "A commit carries a fixture's fake identity even from a worktree that never ran a git-fixture test (the poison is in config every linked worktree shares)"
  - "A fixture's cd <tempdir> && git init && git config user.name writes into the real repo whenever it executes as a child of the pre-push hook"
root_cause: test_isolation
resolution_type: workflow_improvement
related_components:
  - tooling
  - testing_framework
tags:
  - pre-push
  - husky
  - git-identity
  - env-var-leak
  - shared-git-config
  - test-isolation
  - worktree
  - fixture-authorship
---

# Git-exported hook env vars override cwd, letting un-isolated test fixtures poison the shared git identity

## Problem

Commits were repeatedly landing under fake test-fixture identities instead of the real
contributor — `Fixture <fixture@example.invalid>` (2026-08-30), `test <test@example.com>`
(2026-08-29/30, this one reached `main`), `WorldMonitor Test <test@worldmonitor.app>`, and
`e <e@e.co>`. The identities didn't come from a misconfigured `git config --global`; they came
from git itself.

**Root cause.** During a push, git exports `GIT_DIR`, `GIT_WORK_TREE`, and `GIT_INDEX_FILE` into
the environment of the pre-push hook's child processes. Those three variables **override a
child's `cwd`** for the purposes of git repo discovery — a process can `cd` into an unrelated
temp directory and still have every git command it runs resolve back to the *original* repo
because the env vars win.

WorldMonitor's `.husky/pre-push` hook runs the tests touched by the push
(`scripts/prepush-changed-tests.sh`, invoked at `.husky/pre-push:576` and `:583`). Several of
those test files spin up throwaway git fixtures — `git init` in a tempdir, then
`git config user.name <fixture>` to give the fixture repo an identity — as ordinary test setup.
Under a normal `npm test` invocation this is harmless: the fixture's `cwd` is honored and the
config write lands in the fixture's own `.git/config`. Run the *same* fixture code from inside a
git hook, though, and the inherited `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` redirect that
`git config user.name` write straight into the **real, shared `.git/config`** of the repository
being pushed — the common config that every linked worktree reads. From that point on, every
commit made from *any* worktree of that repo silently carries the fixture's fake author until
someone notices.

This is a shared-worktree amplifier: WorldMonitor runs on the order of a hundred linked
worktrees off one common `.git` directory (113 at the time of this incident), so one hook run in one worktree poisons identity for all of them.

## Symptoms

- Commits landing on `main` and PR branches authored/committed as `test <test@example.com>`,
  `Fixture <fixture@example.invalid>`, `WorldMonitor Test <test@worldmonitor.app>`, or
  `e <e@e.co>` — none of them real contributors.
- `git config --global user.name`/`user.email` always showed the correct identity, which is
  misleading and delayed diagnosis — the poison lives in the **repo-local shared config**
  (`.git/config` in the common git dir), not the global one. `git config --show-origin
  user.name` (and `user.email`) attributes the value to its source file instantly and would
  have shortened the hunt.
- The bad identity could appear on a commit made in a worktree that had never itself run a git
  fixture test — because the poison sits in config shared across every worktree, not in any one
  worktree's state.

## What Didn't Work

1. **Suspecting the currently-checked-out tests.** Every test file at HEAD was already isolated
   from git's hook-exported env — running canaries for the 6 suspect test files under a forced
   `GIT_DIR` all came back clean. The actual leak was coming from **stale worktrees** (the repo
   carries them by the dozen) still running an old copy of the pre-push hook against an
   un-hardened, older copy of the test files. Auditing only the live tree's code missed it
   entirely; the offending code no longer existed at HEAD but was still being executed elsewhere.

2. **Grepping for the isolation pattern by regex.** A search for `local-env-vars|GIT_DIR`
   produced false "unhardened" positives, because tests use several different, equally valid
   isolation idioms — filtering by a `GIT_` prefix, or hand-deleting a fixed list of override
   vars — not just the `--local-env-vars` idiom. One file that the grep flagged as having "NO
   ISOLATION" was actually a false negative caused by a missing file being read behind
   `2>/dev/null`; the absence of output was misread as evidence of a gap rather than as a
   swallowed error.

3. **Checking only `git config --global user.name`.** This was always correct and led away from
   the bug. The poisoned value lives in the repo-local **shared** config (the common `.git/config`
   used by every linked worktree), which `--global` never touches.
   `git config --show-origin user.name` (and the same for `user.email`) surfaces the poisoned
   value and its source file in one call and should be the first diagnostic run, not the last.

## Solution

PR #7432 (`fix/prepush-git-env-identity-leak`; open as of this writing) adds three pieces:

### 1. `.husky/pre-push` — strip git's exported env before anything runs

`.husky/pre-push:43-57` (the "Git-env hygiene + identity gate" block):

```bash
# --- Git-env hygiene + identity gate (the "Fixture author" incident class) ---
# During a push git exports GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE to this hook,
# and those OVERRIDE cwd for every child process. A test fixture run below that
# shells out to `git config user.name` without stripping them writes its fake
# identity into the SHARED .git/config — poisoning every worktree's future
# commits (2026-08-30 "Fixture <fixture@example.invalid>" incident; also
# "test@example.com", "WorldMonitor Test", "e@e.co" before it). The hook needs
# none of these vars: cwd-based discovery works in every worktree. Capture the
# push stdin first (the gate consumes it), then strip the list git publishes.
WM_PUSH_STDIN=$(cat || true)
printf '%s\n' "$WM_PUSH_STDIN" | bash scripts/prepush-identity-gate.sh || exit 1
for _git_env in $(git rev-parse --local-env-vars 2>/dev/null); do
  unset "$_git_env" 2>/dev/null || true
done
unset _git_env
```

The push's stdin (`<local ref> <local sha> <remote ref> <remote sha>` lines) is captured into
`WM_PUSH_STDIN` first, since the identity gate needs to read it, then the env strip runs
**before** the hook does anything else — critically, before `scripts/prepush-changed-tests.sh`
is invoked at `.husky/pre-push:576` and `:583`, which is what selects and runs the test files
that create git fixtures. Because every later child process (including the changed-test runner)
inherits an environment with `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/etc. already removed, an
un-isolated fixture that does `cd <tempdir> && git init && git config user.name ...` now
correctly resolves `<tempdir>` as its repo, because there's no override left to redirect it back
to the real one.

### 2. `scripts/prepush-identity-gate.sh` — a backstop that catches whatever the strip misses

New file, `scripts/prepush-identity-gate.sh:1-87`. Two independent checks:

- **Outgoing-commit check** (`scripts/prepush-identity-gate.sh:36-61`): for each pushed ref, walks
  the new commits (`remote_sha..local_sha` for updates, `local_sha --not --remotes=origin` for new
  branches) and blocks the push if any author or committer email matches the fixture pattern
  defined at `scripts/prepush-identity-gate.sh:25`:

  ```bash
  BAD_EMAIL_RE='@example\.(invalid|test|com)$|^e@e\.co$|^fixture@|^test@worldmonitor\.app$'
  ```

- **Shared-config check** (`scripts/prepush-identity-gate.sh:63-73`): reads
  `user.email` directly out of the **common** git config
  (`git rev-parse --path-format=absolute --git-common-dir`) and fails the push if it currently
  holds a fixture-pattern address — even when the commits being pushed are themselves clean —
  because the *next* commit made from any worktree would silently inherit the poison.

This is deliberately a second, independent layer: the env-strip in the hook prevents the write at
current SHAs, but the gate is what stops a leak from a **stale worktree** running old, un-hardened
test code (exactly the failure mode from "What Didn't Work" item 1) from ever reaching GitHub.

On failure it prints the exact repair recipe (`scripts/prepush-identity-gate.sh:75-86`).

### 3. `tests/prepush-identity-gate.test.mts` — 8 tests, including a policy test

`tests/prepush-identity-gate.test.mts` (169 lines) covers:

- 5 behavioral tests on `prepush-identity-gate.sh` (`:82-127`): blocks a fixture-authored new
  branch, blocks a fixture-authored commit inside an update range, passes a clean push, ignores
  branch deletions, and blocks when the shared config is currently poisoned even with clean
  commits.
- 2 wiring tests on the hook itself (`:130-145`): asserts `.husky/pre-push` unsets
  `$(git rev-parse --local-env-vars)` **before** any test invocation (`hook.indexOf('--local-env-vars')` must precede the index of `npx tsx --test|prepush-changed-tests`), and asserts the
  gate script is wired on the push stdin.
- 1 **policy test** (`:147-169`): scans every `tests/*.test.m[jt]s` file, flags any that write a
  git identity (`git config user.name` or equivalent) via a `git` invocation, and asserts each one
  carries a recognized isolation idiom — `--local-env-vars`, a `GIT_` prefix filter, explicit
  `GIT_CONFIG_GLOBAL`, or the hand-listed `GIT_DIR` delete idiom. This is what prevents the class
  of bug from being reintroduced by a future fixture that forgets to isolate itself, closing
  exactly the gap that let the original leak happen in the first place.

The test file also documents (`:35-48`) that it is itself a git-identity-writing fixture and
practices what the policy test enforces — using `--local-env-vars` to build an `isolatedEnv()`
helper for its own git spawns.

## Why This Works

The bug had one true cause with two exposure surfaces, so the fix addresses both:

- **Prevention at the source** — stripping `git rev-parse --local-env-vars` in the hook, before
  any test runs, removes the actual mechanism (`GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`
  overriding a child's `cwd`). Once those vars are gone, a fixture's `git config user.name` call
  can only ever write into the fixture's own tempdir repo, because plain `cwd`-based discovery is
  all that's left, and that's exactly what a hook needs anyway (per the comment at
  `.husky/pre-push:49-50`: "The hook needs none of these vars: cwd-based discovery works in every
  worktree").
- **Detection at the boundary** — the identity gate doesn't assume the strip is sufficient. It
  independently re-checks both the outgoing commits *and* the shared config's current state right
  before the push leaves the machine. This is what makes the fix robust against the actual failure
  mode diagnosed in "What Didn't Work": code at HEAD can be perfectly hardened while a stale
  worktree's stale hook still runs stale, unhardened test code. The gate catches that leak
  regardless of which worktree or which version of the hook produced it, because it checks the
  state that matters (the config that will be read, the commits that will be published) rather
  than trusting that every code path upstream was isolated correctly.
- **Regression-proofing** — the policy test converts "isolate your git fixture" from a convention
  someone has to remember into something CI enforces on every new test file that touches git
  identity, so the next fixture author can't reintroduce the same class of bug undetected.

## Prevention

- **Diagnose git-identity leaks with `git config --show-origin`, not `--global`.** A poisoned
  shared config is invisible to a `--global` check; `--show-origin` attributes the value to its
  actual config file (worktree-common vs. global) in one call.
- **Any process that shells out to `git config user.name`/`user.email` as test scaffolding must
  isolate itself from git's hook-exported environment** — strip `$(git rev-parse
  --local-env-vars)`, filter to a `GIT_` prefix, or set `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` to
  `/dev/null` plus an explicit local-only config. `tests/prepush-identity-gate.test.mts`'s policy
  test (`:147-169`) now enforces this for every git-identity-writing file under `tests/`.
  Understand this as a repo-wide pattern, not a one-file fix: any hook, script, or CI job that
  spawns children while inside a git hook context inherits the same `GIT_DIR`/`GIT_WORK_TREE`/
  `GIT_INDEX_FILE` override risk, not just test fixtures.
- **Reproduction recipe for this class of bug** — a minimal canary that reliably reproduces the
  leak without needing a real hook run, useful for verifying any future fix or new isolation
  idiom:

  ```bash
  # Poisons <canary>/.git/config from inside an unrelated tempdir, simulating
  # what an un-isolated fixture does when run as a hook child:
  GIT_DIR=<canary>/.git bash -c 'cd <tempfixture> && git init && git config user.name LeakyFixture'

  # The strip neutralizes it — it must run INSIDE the child that inherited the
  # override (stripping in the parent and re-exporting GIT_DIR would still leak):
  GIT_DIR=<canary>/.git bash -c '
    for v in $(git rev-parse --local-env-vars); do unset "$v"; done
    cd <tempfixture> && git init && git config user.name LeakyFixture'
  # -> canary stays clean; the write lands in <tempfixture>/.git/config
  ```

- **When a leak does land** (a stale worktree, an unpatched hook elsewhere, or before this fix
  existed), the repair recipe — verified live against a real leaked commit on PR #7431 — is
  printed directly by the gate (`scripts/prepush-identity-gate.sh:75-86`):

  ```bash
  git config --file <main>/.git/config --unset user.name
  git config --file <main>/.git/config --unset user.email
  git rebase origin/main --exec 'git commit --amend --reset-author --no-edit'
  git push --force-with-lease
  ```

- **Stale worktrees are a standing risk, not just a diagnostic red herring.** They can keep
  running an old, un-hardened hook and old, un-isolated test copies indefinitely, silently
  reintroducing a class of bug that was already fixed at HEAD. Periodic worktree hygiene (prune or
  update stale worktrees) reduces this surface independent of any single code fix.

## References

- Fix: PR #7432 (`.husky/pre-push` env strip + `scripts/prepush-identity-gate.sh` + `tests/prepush-identity-gate.test.mts`)
- Incident that surfaced it: PR #7431's original commits published as `Fixture <fixture@example.invalid>` (2026-08-30); repaired live with the recipe above
- Same shared-`.git`-state-poisoning family, different key/mechanism: [git-push-timeout-stale-core-hookspath](../performance-issues/git-push-timeout-stale-core-hookspath.md) (stale absolute `core.hooksPath` welds every worktree's push to one checkout's hook; issues #5810, #6104)
- Same file, different silent pre-push defect: [pre-push-green-tree-cache-attested-a-tree-the-gates-never-ran](./pre-push-green-tree-cache-attested-a-tree-the-gates-never-ran.md)
