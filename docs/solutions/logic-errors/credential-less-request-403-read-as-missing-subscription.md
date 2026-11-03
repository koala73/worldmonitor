---
title: "A credential-less request's 403 read as a missing subscription — the offline Widget Builder told Pro users to upgrade"
module: widget-builder
date: 2026-09-29
problem_type: logic_error
component: authentication
severity: medium
symptoms:
  - "Opening the Pro Widget Builder offline showed 'Pro subscription required. If you just upgraded, refresh the page; otherwise contact support.'"
  - "A paying user saw the upgrade copy while the network, or only Clerk, was unreachable"
  - "No request error was shown, because the health check did return; it returned 403"
root_cause: logic_error
resolution_type: code_fix
related_components:
  - frontend
  - testing_framework
tags:
  - widget-builder
  - clerk-token
  - offline
  - entitlement-denial
  - preflight
  - stale-async-result
---

# A credential-less request's 403 read as a missing subscription

## Problem

The Widget Builder's preflight sent its health check with **no credentials** whenever `getClerkToken()` returned `null`. That happens when Clerk cannot mint a token, for example when the browser is offline or Clerk is unreachable. `/api/widget-agent` answers a request with neither a Bearer token nor a tester key with a `403` (the `Forbidden` branch in `api/widget-agent.ts`). The modal's `resolvePreflightMessage` treats every non-tester-key 403 as an entitlement verdict, so a Pro user saw "Pro subscription required. If you just upgraded, refresh the page". Fixed in PR #8715.

## Symptoms

- Reported copy: *"Pro subscription required. If you just upgraded, refresh the page; otherwise contact support."* (`widgets.preflightProSubscriptionRequired`).
- It appeared only when connectivity failed. A fully failed `fetch` took the `catch` path and showed "Widget agent is temporarily unavailable." The misleading copy needed the token fetch to fail while the health request still got through. That happens with a flaky or partial connection, or when Clerk is unreachable but the origin is not.

## What Didn't Work

- **Reasoning from "offline means fetch throws".** In the fully offline case the health `fetch` rejects, and the modal already showed a generic error. That path could not produce the reported copy. The upgrade copy came from the step before it: a `null` token turned into an **empty headers object**, and the server reads empty headers as "no entitlement".
- **Adding new, clearer copy (`widgets.preflightOffline`, `widgets.preflightSessionUnavailable`).** It passed locally, then turned CI unit shards 2 and 3 red. Every literal `widgets.*` key in a component must also ship in `src/locales/en.shell.json`, whose byte budget had about 13 bytes free. New keys also need a real translation pass, not English placeholders. See [the shell-budget convention](../conventions/i18n-shell-namespaces-are-byte-budgeted-first-paint-surface.md). The fix reuses keys that already ship in the shell and are already translated.

## Solution

All changes are in `src/components/WidgetChatModal.ts`.

1. **Never send a request that cannot reach an entitlement verdict.** `buildWidgetAuthHeaders` now reports `sessionUnavailable` when a signed-in user (`getAuthState().user !== null`) has no token. `connectivityProblem()` maps the two cases to existing copy:

   ```ts
   function connectivityProblem(auth?: BuiltAuthHeaders): string | null {
     if (!navigator.onLine) return t('connectivity.offlineUnavailable');
     if (auth?.sessionUnavailable) return t('widgets.preflightUnavailable');
     return null;
   }
   ```

   `runPreflight` checks it before building headers, so no token call is made while offline. It checks again after building headers, and returns without sending a request if either applies. The generate (`submit`) path does the same. Its `catch` prefers the offline copy over a raw `Failed to fetch`.

2. **Recover without a reopen.** A `window` `online` listener re-runs the preflight. Clerk token recovery fires no browser event, so a missing token while `navigator.onLine` is true schedules a retry after `PREFLIGHT_RETRY_MS` (15 s). `closeWidgetChatModal` removes both the listener and the timer.

3. **Discard superseded results.** Retries let two preflights overlap, and an older one could overwrite a newer "Connected" result and disable Send. Each run takes a generation and bails out once stale:

   ```ts
   const gen = ++preflightGen;
   const isStale = () => gen !== preflightGen || !modal.isConnected;
   // ...after every await:
   if (isStale()) return;
   ```

   The `!modal.isConnected` half matters. Without it, a check still pending when the modal closes schedules a retry that keeps calling `getClerkToken()` against a detached modal forever.

## Why This Works

The underlying defect was reading a **transport failure as a policy verdict**. A 403 means "not entitled" only if the request carried the credential being judged. By refusing to send a credential-less request for a signed-in user, the client never gets a 403 it would misread. Real denials still arrive with a token, and a genuine entitlement 403 keeps the upgrade copy; a regression test covers that.

## Prevention

- When a client maps HTTP status to user-facing policy copy (upgrade, sign in, lapsed), check that the request actually carried the credential being judged. `null` from a token getter is a connectivity or session state, not "anonymous".
- Any async check that can be re-triggered (online events, timers, auth changes) needs a generation or abort guard, including a guard for teardown.
- Regression coverage lives in `tests/dom/widget-chat-offline-preflight.test.mts` (happy-dom via `npm run test:dom`). It has 8 cases: offline, signed-in with no token, fetch failing after going offline, recovery on `online`, a superseded preflight, a 15 s token retry, no retry after close, and a real 403 keeping the upgrade copy. The close case was checked by removing `!modal.isConnected`, which turns the test red.
- `navigator.onLine` can be mocked in happy-dom with `vi.spyOn(navigator, 'onLine', 'get')`. A browser check used Playwright `context.setOffline(true)` after preloading the modal module, because offline mode also blocks `localhost`.

## Related

- [i18n shell namespaces are a byte-budgeted first-paint surface](../conventions/i18n-shell-namespaces-are-byte-budgeted-first-paint-surface.md). This is why the fix reuses existing copy.
- [Key-existence checks cannot detect stale translations](key-existence-checks-cannot-detect-stale-translations.md). This covers the translation-provenance gate that rejected English placeholder values.
- PR #8715.
