---
title: "Vendor SDK hidden retries nested under an app-level retry ladder multiply provider requests"
module: payments
date: 2026-08-02
problem_type: integration_issue
component: payments
severity: high
symptoms:
  - "Sentry: Uncaught Error: Failed to create checkout session: 429 status code (no body), thrown inside the @dodopayments/convex component action (WORLDMONITOR-WP)"
  - "Rate-limited checkouts bounce users to a retry screen even for short bursts the retry layers should absorb"
  - "Worst-case provider request count per checkout multiplies (outer ladder attempts x SDK internal retries)"
root_cause: config_error
resolution_type: code_fix
related_components:
  - service_object
tags:
  - dodo
  - rate-limit
  - "429"
  - retry
  - stainless
  - max-retries
  - retry-after
  - checkout
  - convex-component
---

# Vendor SDK hidden retries nested under an app-level retry ladder multiply provider requests

## Problem

Fixing #6027 (Dodo 429s escaping the checkout path as uncaught Convex errors), an
app-level bounded retry ladder was added around the `@dodopayments/convex`
component's checkout call. The component constructs its REST client with the
SDK's **default** retry policy, so the ladder silently nested over an invisible
second retry layer.

## Symptoms

- Sentry `WORLDMONITOR-WP`: `Uncaught Error: Failed to create checkout session:
  429 status code (no body)` with a stack entirely inside
  `@dodopayments/convex` / `@dodopayments/core` frames — no app frames.
- The graceful client path (typed rate-limited outcome, HTTP 429 + Retry-After)
  worked, yet the Sentry events kept firing: the component's *own action
  execution* fails and is reported even when the caller catches the propagated
  error.
- With the naive ladder in place: up to 3 outer attempts x 3 SDK-internal HTTP
  calls = **9 raw provider requests per checkout** against the shared
  account-level `DODO_API_KEY` bucket, and an outer wall-clock deadline that
  could not bound an in-flight attempt (the SDK sleeps an uncapped Retry-After
  *inside* one attempt).

## What Didn't Work

- **Wrapping the component call in a bounded ladder** (delays + wall-clock
  deadline). Looked correct in isolation and passed every test — the tests
  mocked the seam (`vi.mock` of the provider module), so the SDK's internal
  retries were invisible to the whole suite. Every in-process reviewer missed
  it too; only a cross-model adversarial review pass (different model family,
  separate process) caught the composition, via a fake-fetch repro showing one
  adapter-level checkout performing three HTTP calls.
- **Trying to bound in-flight attempts from outside.** A deadline check between
  attempts can never preempt an attempt that is internally sleeping a provider
  Retry-After that the SDK honors verbatim.

## Solution

Verified against the pinned source before acting (`dodopayments@2.25.0`,
`node_modules/dodopayments/client.js`): `maxRetries ?? 2` at construction,
`shouldRetry` returns true for status 429, and `retryRequest` honors
`retry-after-ms` / `Retry-After` verbatim with no cap ("If the API asks us to
wait a certain amount of time, just do what it says").

Fix (PR #6032):

1. Bypass the component for session creation and call the direct REST SDK with
   retries pinned off and a per-attempt timeout —
   `convex/lib/dodo.ts` `buildCheckoutClientOptions()` returns
   `{ maxRetries: 0, timeout: CHECKOUT_PROVIDER_ATTEMPT_TIMEOUT_MS }`. A
   no-network production-seam test mocks the SDK constructor, calls the real
   `createDodoCheckoutSession()`, and asserts those options plus exactly one
   `checkoutSessions.create()` call.
   The component's checkout handler was a stateless proxy (it ignores `ctx`
   entirely — zod validation + the same `checkoutSessions.create` call), so
   nothing stateful was lost; webhooks verify separately via
   `@dodopayments/core` and are untouched.
2. The app-level ladder (`convex/payments/checkoutRateLimit.ts`,
   `runCheckoutWithRateLimitRetry`) is now the ONLY retry layer: bounded
   delays, +/-25% jitter, an 8s wall-clock budget that reserves the next
   attempt's full timeout before admitting a retry, and a provider Retry-After
   floor applied after jitter (never reduced by low jitter).
3. Classification is typed-first (`error.status === 429` from the SDK's
   APIError) instead of regex-only on the error message.

Side effect worth knowing: removing the component from the path removed the
component-level "Uncaught Error" Sentry signature entirely — an error thrown
inside a Convex component's action is always reported as a failed component
execution, even when the parent action catches it.

## Why This Works

Exactly one layer owns retry policy. With the SDK pinned to zero retries and a
per-attempt timeout, "one ladder attempt" means exactly one bounded HTTP
request, so the ladder's attempt count, jitter, and wall-clock deadline are
real invariants instead of multipliers over hidden behavior.

The repo already encoded this lesson for a different call site:
`convex/payments/billing.ts` renewal reconciliation constructs its client with
`maxRetries: 0`, with a comment warning that an SDK-honored Retry-After "could
sleep minutes." The checkout path just hadn't inherited the discipline because
the component hid the client construction.

## Prevention

- **Before wrapping ANY vendor SDK call in app-level retry/timeout logic, read
  the SDK's client construction and retry defaults first.** Stainless-generated
  clients (dodopayments, openai, anthropic, many others) default to
  `maxRetries: 2`, retry 429/408/409/5xx, and honor Retry-After verbatim.
  Grep the vendored package for `maxRetries`, `shouldRetry`, `retryRequest`.
- **Pin `maxRetries: 0` (plus a per-attempt `timeout`) wherever an app-level
  ladder owns retries**, and guard the production seam with a no-network test
  that mocks the SDK constructor and calls the real wrapper (see
  `convex/__tests__/dodoCheckoutClient.test.ts`) so a refactor or dependency
  bump cannot silently reintroduce nested retries.
- **A Convex component that constructs its own client cannot be configured from
  the app** — if you need retry control, check whether the component's handler
  is stateless and bypass it with the direct SDK.
- **Mock-seam blindness:** tests that mock the provider module cannot see
  SDK-internal behavior. When retry semantics matter, add at least one test
  that pins the client construction options (cheap) or drives a fake fetch
  through the real client (thorough).
- **Reviewer diversity pays here:** same-family reviewers shared the blind
  spot; the cross-model pass found it. Keep the cross-model adversarial pass
  enabled for payments/reliability diffs.
