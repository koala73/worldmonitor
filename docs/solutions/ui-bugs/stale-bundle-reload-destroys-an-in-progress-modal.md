---
title: "A forced reload on tab-focus destroys the modal the user left the app to serve"
date: 2026-09-24
category: ui-bugs
module: src/bootstrap/stale-bundle-check.ts
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - "A mobile user cannot complete sign-up: leaving the app to read the emailed Clerk verification code and returning closes the modal the code must be entered into"
  - "`[stale-bundle] reload:` appears in the console immediately on returning to the tab, followed by a navigation"
  - "The Clerk backdrop and any typed email are gone after the reload; the sign-up attempt has to be restarted from the beginning"
  - "Reproducible on desktop too, because switching to an email tab raises `visibilitychange` on the dashboard"
  - "Every gate stayed green: the reload is the module's documented purpose and no test asserted anything about in-progress UI"
root_cause: missing_validation
resolution_type: code_fix
severity: high
related_components:
  - authentication
  - testing_framework
tags: [stale-bundle, forced-reload, modal-preservation, clerk-signup, build-hash, visibilitychange, is-modal-open, safety-net-suppression, vacuous-test-fake]
---

## Problem

`installStaleBundleCheck()` hard-reloads the page when the running bundle's hash no longer matches `/build-hash.txt`. Its triggers are window `focus`, document `visibilitychange`, and a periodic timer. Returning to the app is therefore the main trigger, and it is also exactly how a mobile user gets back from their mail app holding a Clerk email verification code. The reload destroyed the sign-up modal the code had to be typed into.

Reported by a user on 2026-09-16; fixed in PR #8580 against issue #8577.

## Symptoms

Reproduced against production before any code changed, on an iPhone viewport driving `https://www.worldmonitor.app/dashboard`. The request for `/build-hash.txt` was intercepted to return a hash different from the bundle's, standing in for a deploy landing while the user is in their mail app. With the Clerk sign-up modal open and an email typed, dispatching the `focus` event the browser raises on return printed the module's reload warning naming the running bundle's SHA and the intercepted value, then navigated.

Main-frame navigations went from two to four, and both `.cl-modalBackdrop` and the typed input value were gone afterwards.

The exposure is wide rather than rare. `main` takes roughly ten to sixty commits a day, each one a deploy that changes the hash, so a page open for tens of minutes is usually running a stale bundle by the time the user comes back.

## What Didn't Work

Three dead ends worth skipping next time.

**Probing `/` for the sign-up button.** The origin root serves `welcome.html` — a separate marketing entry from `pro-test/` — not the dashboard SPA. `.auth-signup-link` does not exist there and the page never hydrates the app bundle. The auth widget lives on `/dashboard`.

**Relying on Playwright's `bringToFront()` to raise `focus`.** In headless Chromium it does not, so the first repro attempt showed zero `/build-hash.txt` requests and no reload, which reads as "the bug is not real". Dispatching the `focus` event directly drives the same listener the browser does and reproduced it immediately.

**Making the test seam compile-enforced.** The fix requires `querySelectorAll` on the injected document type, and the first draft's comment claimed a fake omitting it would be a compile error. It would not: `tsconfig.json` has `include: ["src"]`, so no job typechecks `tests/*.test.mts` unless the file is listed in `tsconfig.contract-tests.json`. Adding it to that registry surfaced four pre-existing errors (an undeclared `__BUILD_HASH__` and two possibly-undefined accesses), so the registry change was reverted and the comment was corrected to claim only what holds.

## Solution

The guard for this class already existed, in exactly one place. `src/bootstrap/sw-update.ts` has refused to auto-reload under an open modal since PR #3184, and its comment names this very case ("Clerk email-code wait"). The shared predicate it uses, `isModalOpen` in `src/utils/open-modal.ts`, already matches Clerk's backdrop. The stale-bundle check simply never got the guard.

A hash mismatch is treated as terminal knowledge. The deployed hash is remembered, the module stops fetching, and each later trigger retries the reload against the live DOM:

```ts
const reloadOrDefer = (deployedHash: string): void => {
  if (documentTarget && isModalOpen(documentTarget)) {
    if (pendingReload === null) {
      console.warn('[stale-bundle] reload deferred, modal open:', currentHash, '→', deployedHash);
      reportDeferral(currentHash, deployedHash);
    }
    pendingReload = deployedHash;
    return;
  }
  pendingReload = null;
  console.warn('[stale-bundle] reload:', currentHash, '→', deployedHash);
  reload();
};
```

Two placement decisions carry the fix.

**The probe sits at the reload, not before the fetch.** Reading the DOM when the hash answer arrives rather than when the trigger fired is what catches a modal that mounts while the request is in flight. A guard ahead of the fetch is the original bug wearing a guard.

**A suppressed reload is not a suppressed check.** The pending path returns before `lastCheckedAt` and `inflight` are consulted, so the dedupe window keeps its only job (rate-limiting the fetch) and the question of whether a suppressed check should advance the timestamp never arises.

A hard ceiling on the deferral was proposed in review and rejected. Reloading anyway after some number of minutes reinstates this exact bug for a user whose verification email is slow, which is the complaint. The deferral stays unbounded, and the first deferral of each episode reports to Sentry so a tab wedged behind a permanently visible overlay is detectable rather than silent.

## Why This Works

The safety property the reload exists for (PR #3466: a tab held across a wire-shape change sits in a permanent retry loop against the newer server) survives, because the reload is deferred rather than cancelled. It lands at most one periodic tick after the modal closes. A mounted-but-hidden overlay and an absent document both still reload at once, so the common cases are unchanged.

Whether the predicate actually fires on a real Clerk modal is not something a faked DOM can answer, so it was checked in a browser against production:

| Probe | Result |
|---|---|
| Dashboard with no modal | zero selector matches, predicate false |
| Clerk sign-up modal open | `.cl-modalBackdrop` matched, `checkVisibility()` true, predicate true |
| Across a Clerk card re-render | backdrop count never dropped below one |

That third row decided a design question. An alternative draft added a settle window to cover a suspected frame where one overlay closes before the next paints. The backdrop does not unmount between Clerk's steps, so the window would have been a timing heuristic guarding nothing, and it was dropped.

## Prevention

**When a guard already exists for a class of bug, check every sibling that needs it.** `isModalOpen` was extracted precisely so the policy would not drift, and its own header explains why a second copy of the selector is dangerous. It still ended up applied to one of the two auto-reload paths. Searching for other callers of the *reload*, not other callers of the predicate, is what finds the gap. `src/bootstrap/chunk-reload.ts` was audited and deliberately left alone: it fires on `vite:preloadError`, where the app genuinely cannot continue, so reloading is the correct recovery.

**A test fake that ignores its arguments can make a whole suite vacuous.** The first draft's fake answered any selector:

```ts
querySelectorAll: () => (env.modal === 'none' ? [] : [/* one synthetic element */]),
```

With that, mutating `isModalOpen` onto its own selector literal left all of the tests green. Pinning the argument, as `tests/sw-update.test.mts` already did, turns the same mutation into five failures:

```ts
querySelectorAll: (sel: string) => {
  if (sel !== OPEN_MODAL_SELECTOR) return [];
  // ...
},
```

**`checkVisibility()` with default options does not check opacity.** Per spec, `checkOpacity` and `checkVisibilityCSS` both default to false. The default check still returns false when the candidate has no associated box or an ancestor has `content-visibility: hidden`; `display: none` is not the only hidden case. Anything matching `OPEN_MODAL_SELECTOR` that hides only via `opacity: 0` or `visibility: hidden` reports visible and would suppress both auto-reload paths for the whole session. The invariant that persistent overlays hide with `display: none` is stated only in prose in `src/utils/open-modal.ts`; an audit of first-party matches found no violation, and new overlays must keep it.

**`role="dialog"` is broader than "a modal holding user state", and accepting that was wrong.** The first fix reasoned that the mission-preset popover (`src/app/event-handlers.ts`) carrying that role was tolerable because it dismisses on any outside click, and because the service-worker updater had carried the identical exposure since PR #3184. Production disagreed within eighteen minutes of merge: WORLDMONITOR-15X recorded eight deferrals from eight different users across four countries and four browsers in four minutes, because the popover auto-opens after first paint for every user with no stored preset. The reload guards were protecting an onboarding prompt while the stale-bundle safety net stayed suppressed for that whole cohort.

The correction splits the predicate by what it protects. `isModalOpen` still answers "is any overlay on screen" for the passkey prompt, which must not mount under a focus trap. `findReloadBlockingModal` answers "would a reload destroy unrecoverable work", excluding surfaces that set `RELOAD_SAFE_ATTR` on themselves. Opting out is the surface's claim about its own state, which is the only place that knowledge lives. The lesson generalises past this selector: a residual risk accepted on the reasoning that *nobody could name a triggering case* is weaker than it sounds, because nobody looked at what auto-opens.

**A passing `lint:boundaries` is not evidence for every directory.** `scripts/lint-boundaries.mjs` tracks only the `types` through `app` layers, so it says nothing about a new `src/bootstrap` to `src/utils` import. That import is fine because `sw-update.ts` established it, not because the linter approved it.
