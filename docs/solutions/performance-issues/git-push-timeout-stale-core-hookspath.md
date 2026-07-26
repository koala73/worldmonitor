---
title: Stale absolute core.hooksPath ran an ancient pre-push gate from every worktree
date: 2026-07-24
category: performance-issues
module: git-hooks-worktree-tooling
problem_type: performance_issue
component: development_workflow
symptoms:
  - "git push from any worktree takes roughly 4 minutes and usually hits the 120s tool timeout"
  - "pre-push output shows gate steps (unconditional full typechecks, sequential per-file esbuild phase) that do not exist in the current .husky/pre-push on origin/main"
  - "fixing the shared .git/config core.hooksPath does not fix existing worktrees — each config.worktree carries a copied absolute override"
root_cause: config_error
resolution_type: config_change
severity: high
related_components:
  - tooling
  - testing_framework
tags: [git-hooks, husky, core-hookspath, worktree, pre-push, incremental-tsc, esbuild-batching, push-timeout]
---

# Stale absolute core.hooksPath ran an ancient pre-push gate from every worktree

## Problem

`git push` from any WorldMonitor worktree took roughly 4 minutes and usually hit the tool timeout ("pushing to PR takes a lot of time and mostly times out"). This should have been impossible: PR #4800 (merged 2026-07-05) replaced the old unconditional pre-push gate with a diff-scoped tiered gate plus a green-tree cache, so the common push should complete in seconds. The gate on origin/main was fine. The gate that was actually *executing* was not the gate on origin/main.

The root cause had three layers, and each layer independently kept the symptom alive:

1. **Shared config pinned hooks to one working copy.** The shared `.git/config` set `core.hooksPath` to the ABSOLUTE path of the main checkout's `.husky`. Every worktree, no matter how fresh its branch, ran whatever hook files happened to sit in the main checkout's working tree.
2. **That working copy was ancient.** The main checkout was parked detached and dirty on a commit ~816 commits behind origin/main. Its `.husky/pre-push` predated PR #4800 entirely: the OLD unconditional gate — three full `tsc` runs, all invariant lints, and a per-file loop of 47 sequential `npx esbuild` spawns. Measured sequential cost ~244s: typecheck 75.1s, esbuild loop 97.2s, typecheck:api 19.8s, convex tsc 18.8s, unicode 4.4s, premium-fetch 8.0s, md-lint 7.8s, rate-limit 5.2s, remainder under 2s each.
3. **Per-worktree configs silently re-broke the fix.** Even after correcting the shared config, each worktree's `.git/worktrees/<name>/config.worktree` carried its own copied absolute `core.hooksPath` override, stamped by the worktree-creation tooling at creation time. Per-worktree config wins over shared config, so all existing worktrees kept executing the stale hook. This layer was caught live: during a push from a worktree whose shared config was already fixed, `ps` showed the main checkout's hook path still executing.

The general shape of the bug: **an absolute `core.hooksPath` decouples "which hook runs" from "which commit you're pushing."** The hook becomes a mutable file on disk owned by a checkout nobody is looking at, and improvements merged to the hook in the repo never reach anyone.

## Symptoms

- Pushes from any worktree take ~4 minutes wall clock and usually exceed the push timeout, even for trivial diffs that the tiered gate should skip in seconds.
- The pre-push output shows gate steps (unconditional full typechecks, a long sequential esbuild-per-file phase) that do not exist in the current `.husky/pre-push` on origin/main.
- `git config --show-origin core.hooksPath` from a worktree reports an absolute path into a different checkout, originating either from the shared `.git/config` or from `.git/worktrees/<name>/config.worktree`.
- After fixing the shared config, worktrees still misbehave — `ps` during a push shows the main checkout's literal hook path executing.

## What Didn't Work

- **Blaming the gate design.** The first instinct was that the tiered gate itself was slow or broken. It wasn't — the gate on origin/main (post-#4800) was already diff-scoped with a green-tree cache. Time spent optimizing a gate that wasn't the one running would have been wasted; the executing hook had to be identified first (`ps` during a live push, then diffing the resolved hook file against `origin/main:.husky/pre-push`).
- **Fixing only the shared `.git/config`.** Setting the shared `core.hooksPath` correctly looked like a complete fix and silently wasn't: every existing worktree's `config.worktree` retained its own copied absolute override, which takes precedence. All existing worktrees kept the stale behavior; only the live `ps` observation exposed layer 3.
- **Prior sessions' workarounds** (fast-forwarding the main checkout, temp-editing its `.husky`, `--no-verify`) treated the symptom per-push and left the bug class alive — the permanent fix is making hook resolution per-worktree.

## Solution

Shipped as environment repair plus PR #5558.

**Environment (one-time repair):**

- `git config core.hooksPath .husky` — a RELATIVE value, which git resolves against each worktree's own root, so every worktree runs its own checked-out hook at its own commit. Verified twice: first with a real `git push` in a scratch repo (the worktree's own hook fired, not another checkout's), then live in the real repo.
- Refreshed the main checkout's `.husky/*` working copies to origin/main.
- Deleted the `hooksPath` line from all existing `.git/worktrees/<name>/config.worktree` files.

**Repo (PR #5558) — prevention plus making the real gate fast even in the worst case:**

- **Bootstrap auto-heal.** `scripts/bootstrap-worktree.mjs` gains an exported pure decision function `decideHooksPathAction` and a git-wrapper `normalizeWorktreeHooksPath`, invoked during `bootstrapWorktree`. Policy: a per-worktree override pointing outside the worktree is unset (worktree-local, safe to mutate); a foreign absolute value in the SHARED config is loudly warned about with the one-line fix, but never mutated by a bootstrap script. Relative values and absolute values pointing into the current worktree are left alone. Covered by unit tests in `tests/bootstrap-worktree.test.mjs`.
- **Batched edge-bundle check.** The `.husky/pre-push` edge-bundle check now runs ONE multi-entry esbuild invocation with `--outdir` into a `mktemp -d` directory instead of ~47 sequential `npx esbuild` spawns. One process bundles all entries in parallel; errors still attribute per-file because esbuild prefixes each diagnostic with the source path. 97.2s → 2.3s (42x).
- **Incremental TypeScript.** `tsconfig.json`, `tsconfig.api.json`, and `convex/tsconfig.json` gain `incremental: true` with per-config `tsBuildInfoFile` paths under `node_modules/.cache/`. The build-info files must be DISTINCT per config: `tsconfig.api.json` extends the base config, so a shared build-info file would be invalidated on every alternating run and thrash. typecheck 75.1s → 14.2s warm (26.3s after touching `src/App.ts`); typecheck:api 19.8s → 7.0s; convex 18.8s → 8.4s.

**Verification (mutation-tested, not just green-path):**

- M1: planted a type error in `src/App.ts` → warm incremental typecheck FAILED (incremental caching does not produce false greens).
- M2: planted `import { readFileSync } from "node:fs"` in an `api/*.ts` edge entry → the batched esbuild invocation FAILED naming the offending file (batching preserves per-file attribution).
- End-to-end: the same worst-case RUN_ALL push (tsconfig in the diff, so every gate tier runs) went from 4m16s before to 44.8s after. (The 44.8s is an independently measured wall-clock figure for that push, not a sum of the itemized per-check timings — machine load and which checks actually re-ran differ between the profiling runs and the live push.)

## Why This Works

- **Relative `core.hooksPath` restores the invariant that the hook matches the checkout.** `git config core.hooksPath .husky` resolves against whichever worktree the push runs from, so each worktree executes the hook version checked out on its own branch. Hook improvements merged to main propagate the moment a worktree updates — there is no privileged working copy whose staleness silently governs everyone.
- **The bootstrap guard closes the re-infection loop.** The worktree tooling copies config at creation time, so a single bad absolute value keeps resurfacing in every new worktree forever. Auto-unsetting a foreign per-worktree override at bootstrap (and warning on a foreign shared value rather than mutating shared state from a script) means the fix survives future worktree creation rather than depending on someone remembering this incident. The pure/wrapper split (`decideHooksPathAction` vs `normalizeWorktreeHooksPath`) makes the policy unit-testable without a git sandbox.
- **The perf work attacks per-invocation overhead, not the checks themselves.** The 47-spawn esbuild loop paid `npx` startup plus esbuild startup 47 times for work esbuild natively parallelizes in one process; batching removes the overhead while keeping identical failure semantics. Incremental tsc converts "3 full typechecks on every worst-case push" into cheap warm re-checks, and the per-config `tsBuildInfoFile` prevents the extends-related cache thrash that would have silently negated the win. Together they make even the RUN_ALL path (44.8s) comfortably fit inside a normal push timeout, so the gate no longer relies on the diff-scoping alone to be tolerable.

## Prevention

- **Push-time self-identity tripwire.** The first check in `.husky/pre-push` verifies the executing hook file lives in the current worktree's own `.husky/`; if it is running from another checkout (the exact signature of this incident), the push fails immediately with the one-line fix printed. Bootstrap can be skipped; push time cannot. Escape hatch for an intentional central-hook setup: `WM_ALLOW_FOREIGN_HOOKS=1`.
- **Bootstrap auto-heal is in the path of every new worktree.** `bootstrapWorktree` unsets stale per-worktree `core.hooksPath` overrides automatically and prints the one-line shared-config fix (`git config core.hooksPath .husky`) when the shared value is foreign.
- **Diagnostic recipe when a push is mysteriously slow or runs unfamiliar gate steps:**
  1. `git config --show-origin core.hooksPath` from the worktree — the origin file distinguishes a shared-config value from a `config.worktree` override (the two layers need different fixes).
  2. During a live push, `ps` shows the literal hook path executing — ground truth for WHICH file is running, immune to config-reading mistakes.
  3. Diff the resolved hook file against `origin/main:.husky/pre-push` — if they differ, you are debugging a stale copy, not the real gate.
- **Never set `core.hooksPath` to an absolute path into a working copy** in a multi-worktree repo: it welds every worktree's push behavior to one checkout's mutable, possibly-ancient files. Use a relative path so resolution is per-worktree.
- **When a config fix "doesn't take," check every config layer.** Git worktrees have per-worktree config that overrides shared config; tooling that copies config values at creation time turns a one-time bad value into a self-replicating one.
- **Operational guard:** run pushes with a generous (600s) timeout so a regressed gate surfaces as a slow-but-observable push (with readable gate output) instead of an opaque timeout kill.

## Related Issues

- PR #4800 — introduced the tiered pre-push gate + green-tree cache (the gate that should have been running all along).
- PR #5558 — this fix: bootstrap hooksPath guard, batched esbuild check, incremental tsc.
- No prior GitHub issue tracked this; it surfaced as developer-experience friction ("pushes time out") only.
