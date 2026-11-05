---
title: AbortSignal.timeout rejects as TimeoutError, so an AbortError-only check misses every deadline
date: 2026-11-05
category: logic-errors
module: Relay feed handlers
problem_type: logic_error
component: service_object
symptoms:
  - "Relay deadlines on /api/telegram-feed and /api/x-feed answered 500 instead of 504"
  - "Routine relay timeouts were captured at Sentry error level instead of the warning-level canary"
root_cause: wrong_api
resolution_type: code_fix
severity: medium
tags: [abortsignal, timeouterror, aborterror, timeout, relay, sentry-level]
---

# AbortSignal.timeout rejects as TimeoutError, so an AbortError-only check misses every deadline

## Problem

The Telegram and X feed handlers, along with the shared relay failure classifier, recognised a timeout by `error.name === 'AbortError'`. Their relay fetches use `AbortSignal.timeout(...)`. That signal rejects with a `DOMException` named `TimeoutError`, so no real deadline ever matched. Every relay timeout fell through to the generic failure branch.

## Symptoms

- A relay deadline returned 500 instead of the documented 504.
- `relayFailureLevel` rated the deadline `error`, not `warning`. Routine relay slowness therefore landed in error totals instead of the warning-level canary.

## What Didn't Work

- The existing tests built their timeout as `new DOMException('...', 'AbortError')`. That matched the check, so they passed against the broken code. Whenever a test fakes a timeout, it has to fake the error the real signal produces.

## Solution

Accept both names wherever the signal can come from `AbortSignal.timeout` (PR #10189):

```js
// api/_relay-failure-level.js
// AbortSignal.timeout (fetchWithTimeout in _relay.js) rejects as TimeoutError.
if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'warning';

// api/telegram-feed.js, api/x-feed.js
const isTimeout = error?.name === 'AbortError' || error?.name === 'TimeoutError';
```

Browser code already has the same check as a shared helper: `isTimeoutOrAbortError` in `src/services/timeout-signal.ts`.

Regression tests in `tests/telegram-feed-relay-timeout-canary.test.mts`:

- "treats an AbortSignal.timeout deadline on the `<mode>` relay as a timeout" drives each relay mode with a real `TimeoutError`.
- A companion test pins the warning level and the 504 response.

## Why This Works

The two names mean different things:

- `controller.abort()` with no reason rejects with `AbortError`.
- `AbortSignal.timeout(ms)` rejects with `TimeoutError`, so callers can tell a deadline from a cancellation.

Mobile Safari is the exception. It has reported `AbortSignal.timeout` as `AbortError` (Sentry WORLDMONITOR-10F, recorded in the helper's docstring). A check that must catch every deadline therefore needs both names; checking only `TimeoutError` would miss Safari.

## Prevention

- **Choose the check by where the signal comes from, not by habit.**
  - A signal from a manual `new AbortController()` plus `setTimeout(() => controller.abort())` does reject as `AbortError`. `api/rss-proxy.js` and `server/_shared/usage.ts` are built this way, so their `AbortError`-only checks are correct.
  - A signal from `AbortSignal.timeout` or `AbortSignal.any([... AbortSignal.timeout(...)])` needs both names.
- **Sweep before trusting an old check, and read the next line.** On 2026-11-05 a one-line `git grep` of `api/ server/ scripts/ src/` returned 34 `name === 'AbortError'` checks. Three of them (`api/_bootstrap-r2.js` twice, `scripts/seed-natural-events.mjs`) test `TimeoutError` on the following line, so a single-line grep overcounts. Of the sites read so far, only `scripts/lib/gtfsrt.mjs` was wrong. Its fetch uses `AbortSignal.timeout`, so a deadline was labelled `FETCH_FAILED` instead of `TIMEOUT`, and PR #10189 fixed it with a test in `tests/gtfsrt-adapter.test.mjs`. Nothing branched on that code, so only the logged label was affected. The other unread sites are wrong only if their signal can come from `AbortSignal.timeout`.
- **Fake timeouts with the real error.** In tests, use `new DOMException('The operation was aborted due to timeout', 'TimeoutError')`, as `tests/digest-send-loop-isolation.test.mts` does, or a real expired `AbortSignal.timeout(1)`.
- **Related trap in the same PR:** passing a static `AbortSignal` to `@upstash/redis` does not reject on abort. The client returns a synthetic 200 `{result: 'Aborted'}`, which a rate limiter treats as "allowed". Pass `signal: () => AbortSignal.timeout(ms)` instead. `tests/upstash-redis-signal-form.test.mjs` enforces that form for every `new Redis({...})` in `api/` and `server/`.
