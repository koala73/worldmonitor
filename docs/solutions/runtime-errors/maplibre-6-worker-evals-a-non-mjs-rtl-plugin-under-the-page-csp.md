---
title: "MapLibre 6's worker evals a non-.mjs RTL plugin under the page CSP — and ignoreErrors made a universal break look Firefox-only"
date: 2026-09-16
category: runtime-errors
module: Map basemap (MapLibre worker) and Sentry error filtering
problem_type: runtime_error
component: tooling
severity: high
symptoms:
  - "WORLDMONITOR-12T `Error: call to eval() blocked by CSP` — 354 events in the first six hours after a deploy, every event Firefox (140–156), all OSes, zero frames, via `onunhandledrejection`"
  - "`firstSeen` sat 7 minutes after the merge of #8209, a PR titled as a Sentry noise-filter change"
  - "Arabic, Hebrew and Persian map labels rendered unshaped and left-to-right in every browser, with nothing in Sentry for Chromium users"
  - "Sibling zero-frame issues WORLDMONITOR-12V/12X `Object.hasOwn is not a function` appeared on the same release from iOS 15.3 and a Chromium fork"
root_cause: wrong_api
resolution_type: code_fix
related_components:
  - development_workflow
  - testing_framework
tags:
  - maplibre
  - csp
  - web-worker
  - sentry
  - ignoreErrors
  - dependency-upgrade
  - rtl
---

# MapLibre 6's worker evals a non-.mjs RTL plugin under the page CSP

## Problem

PR #8209 bumped `maplibre-gl` from 5.16 to 6.x while presenting itself as a Sentry noise-filter change, and left the `setRTLTextPlugin('/mapbox-gl-rtl-text.min.js', true)` call in `DeckGLMap.initMapLibre` untouched. Under MapLibre 6 that call breaks every right-to-left label on the map, in every browser, and Sentry reported it as a Firefox-only problem.

## Symptoms

- A new zero-frame issue, `call to eval() blocked by CSP`, appeared within minutes of the deploy and only ever carried Firefox user agents.
- The Chromium side was silent: no Sentry issue, no CSP report. The dashboard's `securitypolicyviolation` handler suppresses `blocked-uri: eval` on purpose (`src/main.ts`), so the only Chromium signal would have been the exception itself.
- Two more zero-frame issues on the same release — `Object.hasOwn is not a function` from iOS 15.3 and a Whale build — showed MapLibre 6 had also raised the engine floor.

## What Didn't Work

- **Reading it as extension noise.** The workflow's default for a zero-frame CSP eval error is "browser extension, filter it". The tag spread killed that: 354 events across four Firefox versions and four OSes in one morning is a population, not a user, and `firstSeen` was pinned to a deploy.
- **Grepping the installed MapLibre for `eval`.** `grep -o "[^a-zA-Z_.]eval("` over `node_modules/maplibre-gl/dist/*.mjs` found nothing, because the call is `globalThis.eval(` and the character class excludes the dot. A scan of the 199 deployed production chunks with the same pattern missed it for the same reason and only turned up three.js's guarded `Function("return this")`.
- **Treating the worker as CSP-exempt.** A dedicated worker fetched from the network takes its CSP from the worker script's own response headers, not from the page. That is not an exemption here: the Vercel catch-all sends the dashboard CSP on `/assets/*.js` too, verified with `curl -I` on the deployed `maplibre-gl-worker-*.js`.

## Solution

Delete the plugin registration and the self-hosted plugin file. MapLibre 6 shapes Arabic and reorders bidirectional text itself (bidi-js is bundled into its worker) and marks `setRTLTextPlugin` deprecated with the note that a plugin set there *replaces* the built-in implementation.

```ts
// src/components/DeckGLMap.ts — before (#8209 left this in place)
maplibregl.setWorkerUrl(maplibreWorkerUrl);
if (maplibregl.getRTLTextPluginStatus() === 'unavailable') {
  maplibregl.setRTLTextPlugin('/mapbox-gl-rtl-text.min.js', true);
}

// after (#8224): nothing to register — MapLibre 6 shapes RTL text in its worker
maplibregl.setWorkerUrl(maplibreWorkerUrl);
```

`public/mapbox-gl-rtl-text.min.js` (207 KB) went with it, and `tests/map-locale.test.mts` now fails if either the call or the file comes back. Two Sentry rules rode along in the same PR: the marketing surface gained the `ClerkJS: Network error` entry the dashboard already had, and `beforeSend` gates the zero-frame `Object.hasOwn is not a function` rejection on `!hasFirstParty`, because a main-thread polyfill would never reach the worker where MapLibre calls it. Fix opened in #8224, unmerged as of this writing.

## Why This Works

MapLibre 6's worker loads a plugin URL in three tiers. The relevant loader in the deployed `maplibre-*.js` chunk reads, deminified:

```js
async function loadScript(url) {
  if (url.endsWith('.mjs')) { await import(url); return; }
  const text = await (await fetch(url, { credentials: 'same-origin' })).text();
  if (/^[ \t]*(import|export)\s/m.test(text)) { /* blob URL + import() */ return; }
  globalThis.eval(text);
}
```

The mapbox plugin is a classic UMD script, so it takes the third branch. The worker's CSP is the dashboard CSP, which has `script-src` without `'unsafe-eval'`, so the eval throws. The rejection travels back over MapLibre's actor channel to the main thread with no frames, lands in `onunhandledrejection`, and Firefox words it `call to eval() blocked by CSP`. Chromium words the same failure `Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive: ...`, which matches the long-standing `/(?:unsafe-eval.*Content Security Policy|Content Security Policy.*unsafe-eval)/` entry in `ignoreErrors` (`src/bootstrap/sentry-init.ts`), so the browser Sentry SDK captures the event and drops it before transport; Sentry's servers never receive it. The two engines had one bug and one issue; the filter split them.

Removing the registration removes the eval. The built-in shaping never touches a plugin URL, so there is no loader path left to block.

## Prevention

- **When a zero-frame issue's `firstSeen` is minutes after a deploy, diff that deploy's `package.json` and lockfile before classifying it.** A major dependency bump can hide in a PR whose title says something else entirely. Here the bump was 402 lockfile lines inside a "filter two third-party noise tails" PR.
- **Read a browser-specific Sentry issue as possibly a browser-specific *wording* of a universal failure.** Before accepting "Firefox only", search `ignoreErrors` for the other engine's phrasing of the same message. If it is there, the population you can see is the minority.
- **Grep for member-call evals too.** `\.eval\(` and `globalThis.eval` are how library loaders call it; a `(?<![\w.$])eval\(` pattern is blind to both.
- **Worker CSP is the worker script's response CSP.** Check it with `curl -I` on the deployed worker asset rather than reasoning from the page. Where it matches the page, anything the worker evals is blocked, and a main-thread polyfill or shim never reaches it.
- **After a MapLibre (or any map engine) major bump, re-read the deprecation notes on every `maplibregl.*` call the app still makes.** `setRTLTextPlugin` did not merely become unnecessary; keeping it replaced the built-in implementation with a loader that could not run. The source-scan test in `tests/map-locale.test.mts` pins the removal.
- **The dedicated `worker&url` build has a different failure surface from the blob-inlined worker of MapLibre 5.** Anything that used to work because the worker was a `blob:` URL inheriting the page's `worker-src blob:` now has to survive as a same-origin fetched script.

## Related

- [Sentry noise filtering with stack gating and signature matching](../best-practices/sentry-noise-filtering-with-stack-gating-and-signature-matching.md) — why generic wordings belong in `beforeSend` with a frame gate rather than in `ignoreErrors`; this incident is the blind spot that rule exists to prevent.
- [A suppression layer above beforeSend cannot see your ownership tag](../logic-errors/a-suppression-layer-above-beforesend-cannot-see-your-ownership-tag.md) — the same `ignoreErrors` layering trap from the checkout side.
- [Vite drops the entry stylesheet link when CSS lives in a shared chunk](vite-drops-entry-stylesheet-link-when-css-lives-in-a-shared-chunk.md) — the other build-output landmine from the same week.
