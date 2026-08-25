---
module: "scripts/bundle-budgets.mjs (client bundle-size CI gate, #7111)"
date: 2026-08-24
problem_type: workflow_issue
component: tooling
severity: high
applies_when:
  - "Seeding or re-seeding a committed snapshot that CI will compare a fresh build against (bundle-size budgets, generated-output diffs, size/perf baselines)"
  - "The build reads any import.meta.env.VITE_* (or similar build-time env) variable in a conditional that affects what code ships, not just what string gets inlined"
  - "The local dev environment has env files (.env, .env.local) that CI's clean checkout does not — in worktrees they are symlinks and silently present"
symptoms:
  - "Local Vite build measured the protomaps chunk at 55.6 KB with .env/.env.local present, vs 18.1 KB in an env-clean build"
  - "A bundle-size budget seeded with local .env files present reds CI on numbers CI itself never produced, on unrelated PRs"
root_cause: config_error
resolution_type: tooling_addition
related_components:
  - "vite build config"
  - "CI test workflow (test.yml unit job)"
tags:
  - vite
  - env-parity
  - bundle-size
  - dead-code-elimination
  - ci-gate
  - dotenv
  - worktree-symlinks
---

# Local .env presence silently changes Vite bundle output shape — seed CI budgets from an env-clean build

## Context

PR #7117 (fixing issue #7111, "dashboard JS payload grew +151 KB (+11.4%) in five weeks and no CI gate can see it") added a merge-blocking client bundle-size gate, `scripts/bundle-budgets.mjs`, with two modes wired into `package.json`: `bundle:budgets` (write mode, regenerates the committed snapshot `scripts/shared/bundle-budgets.json`) and `bundle:check` (check mode, compares a fresh `dist/` against that snapshot). `.github/workflows/test.yml`'s `unit` job runs `npm run bundle:check` immediately after building `/pro` (`npm run build:pro`) and the dashboard variant (`VITE_VARIANT=full ./node_modules/.bin/vite build`).

While building this gate, seeding the snapshot from a normal local build (with the worktree's usual `.env`/`.env.local` present) produced numbers that would have failed on GitHub's clean CI checkout. The `protomaps` chunk alone moved from 18.1 KB to 55.6 KB depending on whether those env files were present at build time — a 3x difference in one chunk, not a rounding difference in a few bytes. The header of `scripts/bundle-budgets.mjs` documents this directly:

> "ENV PARITY MATTERS: budgets are seeded from a build with no .env/.env.local present, because that is what CI builds. Local VITE_ vars change dead-code elimination, not just inlined strings — a populated .env moved the protomaps chunk from 18.1 KB to 55.6 KB."

The committed snapshot's `protomaps` entry records `"raw": 18571` — 18.1 KB, the env-clean number — confirming the snapshot was in fact seeded env-clean, not from a convenience local build. The re-seed recipe in the script header is `npm run build:pro && VITE_VARIANT=full ./node_modules/.bin/vite build` run with `.env`/`.env.local` moved aside — because in a WorldMonitor worktree those two files are symlinks into the main checkout, so they're silently present unless you deliberately move them.

Because the script cannot prove how an arbitrary `dist/` was built, write mode degrades this into a warning rather than a refusal: it checks `existsSync('.env') || existsSync('.env.local')` and prints "bundle-budgets: WARNING — .env/.env.local present; if dist/ was built with them, the snapshot will not match CI. Move them aside and rebuild before seeding." on every write-mode run where either file exists. Check mode has no equivalent env-awareness — it only validates and compares the numbers already in the snapshot, so a wrongly-seeded snapshot fails loudly only when a later PR's CI run — built with genuinely clean env — diffs against it. That CI run is also the proof the fix works: PR #7117's `unit` job ran `bundle:check` against GitHub's own build and passed against the env-clean-seeded snapshot, confirming the seeding recipe actually matches what CI produces.

## Guidance

Vite's `import.meta.env.VITE_*` substitution is a **static, build-time replacement**, not a runtime lookup. When a `VITE_*` variable gates a conditional (`if (import.meta.env.VITE_FOO) { ... }`, a ternary, a dynamic `import()` branch), Vite's bundler resolves that conditional at build time and dead-code-eliminates the branch that can't run — the losing branch's code doesn't ship at all, in either direction. This means:

- A variable set locally but unset in CI (or vice versa) doesn't just change an inlined string value somewhere — it can silently retain or eliminate entire code paths, shifting chunk *composition*, not just chunk content.
- Any committed artifact meant to represent "what CI's build produces" (a size snapshot, a generated manifest, a golden diff) must be seeded from a build whose env matches CI's, not from whatever a developer's local checkout happens to have lying around.
- In a git-worktree-based dev setup, env files are frequently symlinks back to a shared main checkout, so "no .env present" is not the default state of a fresh worktree — it has to be arranged deliberately (move the files aside, or build in a container/checkout that never had them).

The general seeding recipe this PR established: build once normally (or however you'd usually build), then build again with the env files moved aside, and diff the two builds' outputs chunk-by-chunk. The itemized delta between the two builds **is** the env divergence — it tells you exactly which code paths are env-conditional, not just that "something changed." That diff technique generalizes beyond bundle sizes to any build-time-env-sensitive artifact.

## Why This Matters

A snapshot seeded from the wrong environment doesn't fail at seed time — it fails later, on someone else's PR, in CI, for a reason that has nothing to do with what that PR changed. Debugging "why did my unrelated PR fail the bundle-size gate" by rediscovering that the snapshot itself was seeded wrong is expensive and non-obvious, because the failure signature (a chunk grew/shrank past tolerance) looks identical to a real regression. The fix is procedural, not code: always reproduce CI's env when seeding a CI-comparison baseline, and treat any local env file as a build input that has to be accounted for, exactly like a dependency version.

## When to Apply

- Before running any `*:budgets`, `*:snapshot`, or "regenerate the golden output" command that CI will later diff against — check what env CI's build uses and reproduce it, especially in a worktree where env files may be symlinks to a shared source.
- When auditing why a size/output gate is flaky or fails only on certain PRs despite no relevant code change — check whether the snapshot was seeded with local-only env vars present.
- When adding a new build-time-conditional `VITE_*` (or equivalent) flag — verify both the "present" and "absent" builds are exercised somewhere (locally and in CI, or in the seeding recipe) so dead-code elimination differences are caught before they reach a snapshot.
- Generalizes past Vite: any bundler/compiler that resolves environment-gated conditionals at build time (webpack `DefinePlugin`, esbuild `define`, Next.js `NEXT_PUBLIC_*`) has the same failure mode for any committed build-output artifact.

## Examples

- `scripts/bundle-budgets.mjs` (header comment) — documents the env-parity requirement, the concrete 18.1 KB -> 55.6 KB protomaps measurement, and the exact env-clean build command (`npm run build:pro && VITE_VARIANT=full ./node_modules/.bin/vite build`) required before seeding.
- `scripts/bundle-budgets.mjs` (write mode in `main()`) — the `existsSync('.env') || existsSync('.env.local')` guard, which warns (not refuses) when seeding with local env files present.
- `scripts/shared/bundle-budgets.json` — the committed `protomaps` chunk entry (`"raw": 18571`, i.e. 18.1 KB), matching the env-clean number the header documents rather than the env-populated 55.6 KB figure.
- `.github/workflows/test.yml` (`unit` job) — the build-then-gate ordering: `build:pro`, then `VITE_VARIANT=full vite build`, then `bundle:check` — the exact sequence the seeding recipe has to mirror for the snapshot to mean anything in CI. The ordering is pinned by `tests/dashboard-build-guards.test.mjs`.
- PR #7117 ("perf(bundle): merge-blocking client bundle-size gate with committed per-chunk budgets") and issue #7111.

## Related

- [A --check gate that rebuilt its expectation from the artifact it was checking](../logic-errors/a-check-gate-that-rebuilt-its-expectation-from-the-artifact-it-was-checking.md) — closest structural analog: a gate's baseline must come from an independent, canonical source, not whatever is incidentally available.
- [Checks must fail closed when they lose their target](../best-practices/checks-must-fail-closed-when-they-lose-their-target.md) — the fail-closed framing this gate's exit-code contract follows.
- [Closed-world classification gate for config completeness](../design-patterns/closed-world-classification-gate-for-config-completeness.md) — the sibling VITE_*-env incident class (#5905: missing vars in a hand-maintained allowlist), an orthogonal failure mode in the same territory.
- Issue #7119 — the /pro subapp payload and embed.js remain outside the bundle-size gate (scope follow-up to PR #7117).
