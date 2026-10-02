---
title: "Sentry's fetch stack backfill makes a stackless abort reason look first-party — a foreign extension's leaked rejection passed hasFirstParty"
date: 2026-09-17
last_updated: 2026-09-17
category: logic-errors
module: Sentry error filtering
problem_type: logic_error
component: tooling
severity: medium
symptoms:
  - "Sentry WORLDMONITOR-125 (2 events, first 2026-09-09) and WORLDMONITOR-12Z (1 event, 2026-09-16) fired `TimeoutError: signal timed out` via `auto.browser.global_handlers.onunhandledrejection`, handled:no, from Chrome/Edge 151-152 on Windows — ~10 events from >=6 IPs across the WORLDMONITOR-125/12Z/11N family"
  - "The innermost frames pointed at `insights-loader.ts:190` `await fetch(...)` and `:204` `})();`, even though that call is wrapped in `try { ... } catch { return null; }` — a rejection should never have escaped there"
  - "The earlier WORLDMONITOR-11N fix (a `.catch` plus `panel_call_rejected` report added to `pending-panel-data.ts` `invokePanelMethod`) was a real bug but not the whole story: 125's captured stack still ran through the now-fixed `invokePanelMethod` frame, and events kept arriving after it shipped"
  - "The `/signal timed out/` `beforeSend` suppression in `src/bootstrap/sentry-init.ts`, which drops only events with no first-party frames (`!hasFirstParty`), should have dropped these events, but `hasFirstParty` read true because the mutated stack carried first-party frame names"
  - "Only the JS-built `DOMException` abort reason from `insights-loader.ts` ever surfaced this way; native `AbortSignal.timeout()` leaks through the same foreign fetch hook parsed to zero frames and were silently (and correctly) dropped, which is why just one call site kept generating issues"
root_cause: logic_error
resolution_type: code_fix
related_components:
  - development_workflow
  - testing_framework
tags:
  - sentry
  - before-send
  - stack-gating
  - abort-signal
  - fetch-wrapper
  - unhandled-rejection
  - browser-extensions
  - regression-testing
---

# Sentry's fetch instrumentation backfills a stackless abort reason with the fetch call site, so an extension's leaked rejection read as ours

## Problem

`src/services/insights-loader.ts` aborted its shared request with a hand-built `DOMException('signal timed out', 'TimeoutError')`. Chromium gives a JS-built DOMException no `stack`. Sentry's fetch wrapper fills in a missing `stack` by writing onto the rejected error object itself. So when a browser extension's `window.fetch` hook leaked an unhandled copy of that rejection, the event carried insights-loader frames. It got past the `signal timed out` suppression, which drops only events with no first-party frames, and showed up as an unhandled first-party rejection from code that visibly catches it.

## Symptoms

- Per this session's Sentry pull: WORLDMONITOR-125 (2 events, first seen 2026-09-09), WORLDMONITOR-12Z (1 event, 2026-09-16) and the older WORLDMONITOR-11N (7 events), all `TimeoutError: signal timed out`, mechanism `auto.browser.global_handlers.onunhandledrejection`, `handled: no`, Chrome/Edge 151-152 on Windows, about 10 events from at least 6 IPs.
- The innermost frames were the loader's own `const resp = await fetch(...)` (column 26) and its closing `})();`. At the pre-fix line numbers those were `:190` and `:204`. In the current tree they are `src/services/insights-loader.ts:205` and `:219`. Below them were `InsightsPanel.ts:195` (`paintCachedBriefEarly`) or `:309` (`updateInsights`), then `invokePanelMethod`, then `data-loader.ts`.
- The stack didn't make sense: that same `await` sits inside `try { ... } catch { return null; }` (`src/services/insights-loader.ts:204-214`), so the loader's own promise can't be the unhandled one.
- Only this one call site ever showed up. Timeouts from native `AbortSignal.timeout()` that the same kind of hook leaked were dropped without a trace.

## What Didn't Work

**Treating it as a missing `.catch`.** The WORLDMONITOR-11N fix was real: `invokePanelMethod` now attaches `.catch` and reports `panel_call_rejected` with a `kind` tag (`src/app/pending-panel-data.ts:37-55`, tag at `:18`, called from `src/app/data-loader.ts:480`). But WORLDMONITOR-125's stack runs *through* that fixed frame, and events kept coming after it shipped. The rejected promise wasn't the panel's at all. The frames came from V8's async stack at the moment Sentry's wrapper was entered, not from the promise chain that actually leaked.

**Hunting for a forked promise in our own fetch wrappers.** Reading every wrapper found nothing: `fetch-failure-attribution.ts`, `runtime.ts` `installWebApiRedirect` (including `fetchWithRedirectFallback` and the billing retry/sleep path), `wm-session.ts` `installWmSessionFetchInterceptor` and `analytics-collector-transport.ts` `installCollectorFetchGate`. In this investigation, the real wrapper chain was run under tsx and in Chromium 145 and Chrome 152 with the real `fetchServerInsights()` aborted in five scenarios (hang, abort during session mint, 401 replay, 503 billing retry asleep, two concurrent callers). Every run gave 0 unhandled rejections, 0 Sentry events and a `null` return.

**Suspecting DebugBear RUM or the service worker.** DebugBear only calls `fetch` for its beacon and never wraps `window.fetch`. A rejection inside the service worker lives in the worker's context and never receives the page's abort reason object.

## Solution

PR #8296 (merged) makes the reason look like the native one: a stack that is only the header line, with no frames.

Before:

```ts
inFlightAbort.abort(
  typeof DOMException === 'function'
    ? new DOMException('signal timed out', 'TimeoutError')
    : undefined,
);
```

After (`src/services/insights-loader.ts:120-139`, line comments omitted). The stamp sits in its own `try`, added under issue #8300 and explained under Prevention:

```ts
let reason: DOMException | undefined;
if (typeof DOMException === 'function') {
  reason = new DOMException('signal timed out', 'TimeoutError');
  try {
    Object.defineProperty(reason, 'stack', {
      value: 'TimeoutError: signal timed out',
      configurable: true,
      writable: true,
    });
  } catch {
    /* engine pins `stack`; an unstamped reason must still abort below */
  }
}
inFlightAbort.abort(reason);
```

The stamp is attempted on every engine, not only Chromium. Where a JS-built DOMException does get a stack, that stack holds the construction frames, which here are `abortInFlightRequest` called from the `setTimeout` at `src/services/insights-loader.ts:155`. Those frames are first-party too. On Node v24.15.0 in this session, `new DOMException(...).stack` included the calling frames. This investigation found Firefox's DOMException carries a stack too.

The same PR also fixed a false comment in `src/bootstrap/sentry-init.ts`. It used to say "our shipped code cannot synthesize the literal 'signal timed out'". Our code does build that reason: in insights-loader and in the fallback at `src/services/timeout-signal.ts:40-63`. The new comment (`src/bootstrap/sentry-init.ts:945-956`) names both places.

## Why This Works

The whole bug is three facts combined:

1. **Sentry writes onto the error object.** In `@sentry/core` 10.46.0 (`node_modules/@sentry/core/package.json:3`), `instrumentFetch` creates `virtualError = new Error()` when fetch is called (`node_modules/@sentry/core/build/esm/instrument/fetch.js:56`). In the rejection handler it runs `if (isError(error) && error.stack === undefined) { error.stack = virtualError.stack; addNonEnumerableProperty(error, 'framesToPop', 1); }` (`fetch.js:100-106`). That mutates the shared reason object, so anything else holding it sees the backfilled stack.
2. **One abort reason reaches every hook.** The hook shape reproduced here was `const p = orig(...); p.then(onOk); return p;`. The forked `p.then(onOk)` promise rejects with the same object and has no handler. The original `p` travels up our wrappers to Sentry's outermost wrapper, which backfills the stack during the same microtask turn. `unhandledrejection` fires only after that turn ends, so Sentry's global handler reads a reason that already has insights-loader frames. Production evidence, per this session's pull: one affected user's console breadcrumbs showed two different browser extensions' content scripts each wrapping `window.fetch` (`chrome-extension://<extension-a>/…` calling `chrome-extension://<extension-b>/…` calling our `main-*.js`), with one of them logging that the fetch request had failed. Adding that one hook in the browser reproduction produced the exact production event.
3. **The suppression only applies to events with no first-party frames.** It keys on `!hasFirstParty`, not on the total frame count, so frames from a vendor chunk or an extension alone do not stop it. `hasFirstParty` is true when any frame not from the SDK comes from a `.ts` file or a non-vendor `/assets/*.js` chunk (`src/bootstrap/sentry-init.ts:468-474`). The `/signal timed out/` drop requires `!hasFirstParty && event.tags?.kind === undefined` (`src/bootstrap/sentry-init.ts:997-1005`).

A native `AbortSignal.timeout` reason already has `stack === "TimeoutError: signal timed out"` (checked in Chromium in this investigation). That value isn't `undefined`, so the check at `fetch.js:100` skips it, the SDK parses zero frames, and the suppression drops it. That's why only the hand-built reason ever surfaced. Once the loader's reason has the same shape, a leaked rejection is filtered the same way. A first-party failure reported with a `kind` tag still gets through, because the tag exempts it at `src/bootstrap/sentry-init.ts:1003`.

Trade-off: if our own code ever left this reason unhandled, Sentry would now drop it too. The stamp creates no blind spot that a native `AbortSignal.timeout` rejection doesn't already have, but a tag protects only the paths that set one. Not every caller does: the `InsightsPanel` constructor starts the early brief paint with a bare `void this.paintCachedBriefEarly()` (`src/components/InsightsPanel.ts:90`), which bypasses `invokePanelMethod` and its `panel_call_rejected` tag. That path is safe today for a different reason: `fetchServerInsights` catches its own aborted fetch and resolves `null` (`src/services/insights-loader.ts:204-214`), so the reason never propagates to any first-party caller. The containment comes from that catch, not from a tag.

## Prevention

**Diagnostic signature.** Suspect a foreign fetch hook plus Sentry's stack backfill, not a missing catch, when all of these hold:

- the event came from `onunhandledrejection`
- its innermost first-party frame is a `fetch(` call
- the code around that `await` visibly catches it

Next, check the event's console breadcrumbs for `chrome-extension://` or `moz-extension://` URLs in a `window.fetch` chain. A frame stack that runs through a call site you already fixed means the frames describe where fetch was entered, not which promise leaked.

**Rule for JS-built abort reasons.** A timeout reason we build ourselves in the native `signal timed out` wording should look like the native one: a `stack` that is only the header line, set with `Object.defineProperty` inside its own `try`. The stamp only improves telemetry, while the abort *is* the deadline. If the stamp shares the abort's swallowing `catch`, an engine that refuses to redefine `stack` skips the abort, and the fetch never times out at all. That is worse than any misattribution. A `stack` of `undefined` invites Sentry to backfill it. A real stack with frames makes a foreign leak look first-party. Matching the native shape only removes the misattribution; it does not make our own leaks visible. So the rule has a precondition: every first-party consumer of the reason either catches it or reports through a `kind`-tagged capture. A leak that is left unhandled and untagged is invisible whether the reason is native or stamped.

The rule also covers the fallback in `src/services/timeout-signal.ts:40-63`, which runs where `AbortSignal.timeout` is missing (`src/services/timeout-signal.ts:27-29`). Issue #8300 (PR #8304) stamps it the same way, in both bundles, because the marketing bundle carries a byte-identical copy pinned by `tests/marketing-mirror-parity.test.mts`. It changes only legacy-engine behavior, bringing it in line with what native engines already produce. `tests/pro-timeout-signal.test.mts` pins both copies against both engine shapes: the stackless Chromium one and the framed one Node and Firefox build. It adds a third shape, a DOMException whose `stack` refuses redefinition, and requires the signal to abort anyway. `tests/insights-loader.test.mjs` holds the same refusal case for the loader. Before the stamp moved into its own `try`, all three refusal tests (one per bundle, plus the loader's) timed out because the signal never aborted.

**Regression test pattern.** Node's DOMException already has a stack, so the test has to recreate Chromium's stackless one. Otherwise it passes before the fix too. `tests/insights-loader.test.mjs:320-353` swaps in a stackless subclass, asserts that precondition, and reads the reason through a stubbed `fetch`:

```js
class StacklessDOMException extends NativeDOMException {
  constructor(...args) { super(...args); delete this.stack; }
}
assert.equal(new StacklessDOMException('x', 'TimeoutError').stack, undefined);
globalThis.DOMException = StacklessDOMException;
globalThis.fetch = (_url, init) => new Promise((_, reject) => {
  init.signal.addEventListener('abort', () => reject(reason = init.signal.reason), { once: true });
});
assert.equal(await fetchServerInsights(10), null);
assert.equal(reason?.stack, 'TimeoutError: signal timed out');
```

Before the fix this failed because `reason.stack` was `undefined`. After the fix it passes. Run it with `npx tsx --test tests/insights-loader.test.mjs`. In this session the test passed on the current tree.

**Proving a leak path without production.** Bundle the real wrapper chain with the real `@sentry/browser` default integrations and run it in Chromium. Confirm the clean chain gives 0 events, then add one extension-style fetch hook installed before app code. If the production event appears only once the hook is added, the leak is outside our code.

## Related Issues

- `docs/solutions/logic-errors/a-suppression-layer-above-beforesend-cannot-see-your-ownership-tag.md`: why `kind` tags exempt the no-first-party-frames gate, and the Chromium probe showing the native header-only `AbortSignal.timeout` stack.
- `docs/solutions/best-practices/sentry-noise-filtering-with-stack-gating-and-signature-matching.md`: the `hasFirstParty` stack-gating model this bug slipped past.
- Sentry WORLDMONITOR-125, WORLDMONITOR-12Z, WORLDMONITOR-11N; PR #8296.
