---
title: Test guard assertions must exercise the real guard, and test helpers must reset module state
date: 2026-07-18
category: best-practices
module: auth/session tests
problem_type: best_practice
component: testing_framework
severity: medium
applies_when:
  - Writing regression tests for numeric boundary or non-finite value guards
  - Writing test-only escape hatches that mutate module-level state
tags:
  - testing
  - regression-tests
  - json-stringify
  - module-state
  - test-helpers
  - infinity
  - guard-coverage
---

# Test guard assertions must exercise the real guard, and test helpers must reset module state

## Context

PR #5369 hardened the auth/session/bootstrap surface after an adversarial sweep. Greptile's post-merge review flagged two test-quality regressions: the tests looked like they covered production guards, but one test exercised the wrong branch entirely, and a test helper leaked mutated state to later tests in the same process.

## Guidance

### 1. A test that claims to cover a guard must actually reach that guard

When a production check has multiple rejection paths, the regression test must force execution through the path it claims to cover. A common trap is `JSON.stringify`, which silently replaces `Infinity` (and `-Infinity`) with `null` and `NaN` with `null`:

```js
// WRONG: payload.exp is null, not Infinity
const body = Buffer.from(JSON.stringify({ iat: now, exp: Infinity, n: 'x' })).toString('base64url');
```

In `api/_session.js:129`, the validation order is:

1. `typeof payload.exp !== 'number'` -> reject
2. `!Number.isFinite(payload.exp)` -> reject
3. `Date.now() >= payload.exp` -> reject

With `exp: null`, the test stops at step 1 and never reaches `Number.isFinite`. To exercise the non-finite guard, build a JSON literal that `JSON.parse` converts to `Infinity`:

```js
// RIGHT: JSON.parse turns the unquoted literal 1e309 into Infinity
const infiniteBody = Buffer.from(`{"iat":${now},"exp":1e309,"n":"infinite02"}`).toString('base64url');
```

Confirm the guard is actually covered by temporarily removing it: the test must fail.

### 2. Test-only reset helpers must restore every mutable field they touch

A helper that lets tests mutate module-level state (`__setXForTests`) must be paired with a reset helper (`__resetXForTests`) that restores the production default. In `src/services/wm-session.ts`, `__setWmSessionFetchTimeoutForTests(ms)` changed `fetchNewSessionTimeoutMs`, but `__resetWmSessionForTests` reset every other module field without restoring the timeout. Later tests in the same Node.js process inherited the shrunken timeout and could flake.

The fix adds the missing reset:

```ts
export function __resetWmSessionForTests(): void {
  cached = null;
  inflight = null;
  recoveryInFlight = null;
  sessionGeneration = 0;
  interceptorInstalled = false;
  sessionDeadUntil = 0;
  sentryEnqueue = enqueueSentryCall;
  fetchNewSessionTimeoutMs = 10_000; // <- was missing
}
```

Add a regression test that sets the timeout to a small value, calls reset, and verifies production behavior is restored.

## Why This Matters

- **False confidence**: a passing regression test that does not reach the claimed guard hides the fact that the guard can be removed without consequence.
- **Flaky later tests**: leaked module state creates order-dependent failures that are hard to reproduce and debug.
- **Merged PRs still need review**: automated merge plus green CI does not mean the test suite is actually hardened.

## When to Apply

- Any regression test for a guard, boundary, or rejection path with multiple sequential checks.
- Any test helper that exposes a setter for module-level configuration/state.
- Post-merge or post-review follow-ups where an external reviewer (human or bot) flags test-quality issues.

## Examples

### Verifying a non-finite guard

```js
// Builds a body JSON.parse will read as { ..., exp: Infinity }
const infiniteBody = Buffer.from(`{"iat":${now},"exp":1e309,"n":"x"}`).toString('base64url');
const sig = /* sign infiniteBody with the test HMAC key */;
assert.equal(await validateSessionToken(`wms_${infiniteBody}.${sig}`), false);
```

### Reset helper coverage

```ts
const mod = await import('../src/services/wm-session.ts?reset-repro=1');
mod.__setWmSessionFetchTimeoutForTests(50);
mod.__resetWmSessionForTests();

// With the default 10 s timeout restored, a fetch that resolves after 100 ms succeeds.
const outcome = await Promise.race([
  mod.ensureWmSession().then(() => 'settled'),
  after(500, 'still-pending'),
]);
assert.equal(outcome, 'settled');
```

## Related

- PR #5369 — original auth/session/bootstrap adversarial sweep
- PR #5370 — follow-up that fixed the two test-quality regressions
- `api/_session.js:129` — non-finite expiration guard
- `src/services/wm-session.ts:184` — `__resetWmSessionForTests`
