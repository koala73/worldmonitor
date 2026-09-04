---
title: "Hermetic against the env file is not hermetic against the environment"
date: 2026-09-02
category: conventions
module: test and CI verification infrastructure
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - "Reasoning about whether a test can reach production credentials or a paid upstream"
  - "Reading a hermeticity guard's guarantee and inferring what it implies about the wider blast radius"
  - "Writing a code comment that claims a code path fails closed under a test runtime"
  - "Adding a test seam whose uninjected fallback leg would reach a real network transport"
  - "A guard blocks one acquisition path for a secret while another path reads the same value directly"
related_components:
  - testing_framework
  - development_workflow
  - background_job
tags:
  - hermeticity
  - test-isolation
  - partial-guarantee
  - credentials
  - ambient-environment
  - seeder-testing
---

## Context

Seeder modules call `loadEnvFile(import.meta.url)` at module scope, so importing one from a test used to hydrate `process.env` from the developer's `.env.local` — production Redis credentials included. `scripts/_seed-utils.mjs:284` closes that: `loadEnvFile` returns early when `isTestRuntime()` is true (`:234`, keyed on markers including `NODE_TEST_CONTEXT`, which both `node --test` and `tsx --test` set), unless `WM_ALLOW_ENV_LOAD_IN_TESTS=1`. `tests/seed-env-hermeticity.test.mjs` pins that and two sibling invariants.

The guarantee is precise, and its header comment says so: importing a seeder does not **load** a `.env` file. It is not a claim that a test process cannot see production credentials.

The difference bit twice in one session, in opposite directions:

1. First, asserting that importing the PortWatch seeder hydrates `PROXY_URL` from `.env.local`, and therefore that an uninjected proxy fallback in a test would make a real, billable Decodo request. Wrong — `loadEnvFile` is inert under the test runner.
2. Then, over-correcting into a code comment claiming the same path "fails closed with no proxy configured" under a test runtime, full stop. Also wrong — `resolveProxyStringConnect` reads `process.env.PROXY_URL` directly at call time (`scripts/_proxy-utils.cjs:100`). A developer with `PROXY_URL` exported in their shell, or CI with it set as a job variable, hands it straight to the seeder. The env file was never the only way in.

## Guidance

**A hermeticity guard covers the acquisition path it intercepts, and says nothing about the others.** `loadEnvFile` blocks file-sourced credentials. It cannot block ambient ones, because it is not in that path at all — the consumer reads `process.env` itself.

Before relying on such a guard, name the *specific* path it closes, then enumerate the other ways the same value arrives:

- the env file the guard intercepts,
- the ambient shell environment of whoever runs the suite,
- CI job/secret variables,
- a wrapper script or task runner that exports before invoking,
- a private copy of the loader that opted out (the third invariant in `tests/seed-env-hermeticity.test.mjs` exists precisely because a second copy of the loader once did).

**When writing the claim into a comment, write the precondition with it.** "Fails closed under a test runtime" is the sentence that misleads. "Fails closed under a test runtime unless `PROXY_URL` is exported in the ambient environment, which `resolveProxyForConnect` reads directly" is the sentence that survives the next reader. A partial guarantee stated absolutely is worse than no comment, because it stops the reader from checking.

**The general shape:** a guard that makes something *usually* unreachable reads, to everyone downstream, as making it unreachable. The gap between "usually" and "always" is where the billable request, the production write, or the flaky test lives.

## Why This Matters

This class of error is self-reinforcing. The guard is real, the test that pins it is real, and both are cited in good faith — so the overstated conclusion inherits their credibility. Nothing in the guard's own test contradicts the wider claim, because the guard's test correctly scopes itself to the guard.

It also degrades quietly across environments. A conclusion that holds on CI (no `.env.local`, no exported `PROXY_URL`) fails on the one developer machine that exports it — the machine most likely to be running an ad-hoc test against a paid upstream.

## When to Apply

- A comment or doc is about to state that a code path is safe, inert, or fails closed under some condition.
- A test seam is added whose uninjected fallback would reach a real transport. Ask what happens when that leg is hit, and under whose environment.
- A guard's name generalizes further than its implementation (`isTestRuntime`, `hermetic`, `safe`, `isolated`) — read the implementation for the path it actually intercepts.
- Any secret or endpoint config reachable through more than one mechanism.

## Examples

**The narrow, true claim** (`scripts/_seed-utils.mjs:284`):

```js
if (isTestRuntime() && process.env.WM_ALLOW_ENV_LOAD_IN_TESTS !== '1') {
  return;   // importing a seeder does not LOAD .env.local
}
```

**The other path, unaffected by it** (`scripts/_proxy-utils.cjs:100`):

```js
return parseProxyConfig(process.env.PROXY_URL || '');   // reads whatever is already there
```

**The check that settles it,** rather than reasoning about it: run the suite with the variable both unset and exported, and see whether behaviour changes. If it does, the guard does not cover that path — regardless of what the guard's name suggests.

## Related

- [assert-what-a-branch-produces-not-what-a-lenient-classifier-concludes-from-it](assert-what-a-branch-produces-not-what-a-lenient-classifier-concludes-from-it.md) — sibling from the same session: there an assertion was too coarse to separate branches, here a guarantee was read wider than its implementation. Both are cases of a real mechanism credited with more than it does.
