---
title: Sentry noise filtering with stack gating and signature matching
module: Sentry error filtering
date: 2026-07-17
category: best-practices
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - Triaging third-party SDK, browser-extension, or monkeypatched runtime errors in Sentry
  - Filtering generic network failures that could also originate in first-party code
  - Adding or broadening Sentry ignoreErrors or beforeSend suppression rules
symptoms:
  - Unresolved Sentry issues are dominated by third-party UI chunk failures or browser-extension fetch wrappers
  - Generic Failed to fetch rejections cannot be safely suppressed by message alone
  - Extension stack frames use chained receiver names that narrow function-name regexes miss
root_cause: logic_error
resolution_type: workflow_improvement
related_components:
  - development_workflow
  - testing_framework
tags:
  - sentry
  - error-filtering
  - noise-triage
  - before-send
  - stack-gating
  - browser-extensions
  - clerk
  - regression-testing
---

# Sentry noise filtering with stack gating and signature matching

## Context

Sentry noise filters must distinguish errors the application owns from errors that merely pass through application frames. Two production events illustrated the two different kinds of evidence this requires:

- **WORLDMONITOR-WR** was a Clerk SDK error loading Clerk’s own UI bundle from `clerk.worldmonitor.app`. Although the stack named the locally bundled `clerk-*.js` asset, the message itself carried a stable, SDK-owned prefix: `[clerk] failed to load …`.
- **WORLDMONITOR-TZ** was a bare `Failed to fetch` rejection whose stack contained both a first-party Vite chunk and `chrome-extension://…/frame_ant.js`. The extension frame’s function was `r.class.c.value.window.fetch`, showing that an injected fetch wrapper—not necessarily the first-party caller—owned the orphan rejection.

The fixes were merged in [PR #5360](https://github.com/koala73/worldmonitor/pull/5360) on July 17, 2026. The implementation puts the Clerk signature in `ignoreErrors` and keeps the fetch-wrapper classification in `beforeSend`, where stack provenance is available (`src/bootstrap/sentry-init.ts:321-324`, `src/bootstrap/sentry-init.ts:525-550`).

## Guidance

### Choose the filtering layer based on the strength of the evidence

Use `ignoreErrors` only when the message is a narrow, stable signature that is unambiguously owned by browser infrastructure, an injected script, or a third-party SDK. The Clerk rule matches the SDK-specific `[clerk] failed to load` signature rather than the generic phrase `failed to load` (`src/bootstrap/sentry-init.ts:321-324`). Its regression tests prove both halves of that contract: the observed Clerk UI-chunk failure is ignored, while `Failed to load dashboard config` remains reportable (`tests/sentry-beforesend.test.mjs:93-106`).

Use `beforeSend` when suppression depends on event structure—especially filenames, frame functions, and whether first-party frames are present. A generic `Failed to fetch` is actionable when it comes from application code, so it must not be suppressed by message alone. The fetch-wrapper rule requires all of the following:

1. The message is exactly `Failed to fetch`, optionally prefixed by `TypeError:`.
2. At least one stack frame comes from a Chrome, Firefox, Safari, or Safari Web Extension URL.
3. That extension frame’s function is an exact fetch/apply wrapper form, including a receiver chain ending in `.window.fetch`.

Those gates are implemented together at `src/bootstrap/sentry-init.ts:547-550`.

### Treat first-party frames as evidence, not proof of ownership

The general extension rule deliberately suppresses extension frames only when no first-party frame exists, because a mixed stack normally deserves investigation (`src/bootstrap/sentry-init.ts:521-524`). A monkeypatched global is the important exception: an extension can wrap `window.fetch`, call through the application’s fetch machinery, and leak its own unhandled promise rejection. In that case, `hasFirstParty` is true even though the extension created the reportable failure. The dedicated rule therefore permits suppression with first-party frames present, but only when the extension URL and exact wrapper function jointly establish provenance (`src/bootstrap/sentry-init.ts:525-548`).

### Match the terminal operation, not a substring

Do not use a loose `/fetch/` test for extension function names. The anchored receiver-aware expression recognizes `fetch`, `window.fetch`, `Object.apply`, `apply`, and chained names such as `r.class.c.value.window.fetch`, while rejecting unrelated functions such as `prefetch`, `fetchContent`, and `fetchUserData` (`src/bootstrap/sentry-init.ts:538-548`). This makes the filter broad enough for real extension naming variants without turning every mixed extension/application stack into noise.

### Pair every suppression test with a preservation test

A Sentry noise fix is incomplete if it only proves that the target event disappears. Add negative tests showing that neighboring first-party failures still reach Sentry. The fetch-wrapper suite covers the observed chained receiver, a non-fetch extension frame, and function names that merely contain `fetch` (`tests/sentry-beforesend.test.mjs:577-610`). The Clerk suite similarly pairs the exact SDK case with a generic first-party load failure (`tests/sentry-beforesend.test.mjs:93-106`).

## Why This Matters

Overbroad Sentry filtering creates a silent-failure channel: genuine API outages, broken application loaders, and product regressions can disappear along with the intended noise. Under-filtering has the opposite cost: repeated SDK and extension failures consume attention, distort issue frequency, and make real regressions harder to see.

The core lesson is that stack provenance is compositional. An error can contain a first-party frame because application code was called, a vendor chunk was bundled under the application origin, or an extension wrapped a browser global. No single signal—message text, origin, or `hasFirstParty`—is sufficient for every class of event. Reliable filtering combines the narrowest stable evidence available:

- stable SDK-owned message signature for `ignoreErrors`;
- extension URL plus exact wrapper function for `beforeSend`;
- explicit negative cases that preserve nearby application failures.

This approach reduces known noise without converting Sentry from an error detector into an allowlist of assumptions.

## When to Apply

Apply this pattern when triaging a recurring Sentry event and one of these conditions holds:

- The error has a stable, namespaced third-party signature that the application does not emit, such as an SDK prefix plus an SDK-controlled resource URL.
- The message is generic, but stack frames provide strong provenance such as an extension scheme and a recognizable monkeypatched-global trampoline.
- First-party frames appear only because a browser global wrapper calls through application runtime code, so the usual `!hasFirstParty` extension gate cannot classify the event correctly.
- A broader candidate regex can be constrained by anchoring it to the terminal operation and covered with adversarial preservation tests.

Do not apply message-only suppression to generic phrases such as `Failed to fetch` or `failed to load`. Do not suppress a mixed first-party/extension stack merely because an extension frame exists. If extension ownership cannot be established with a specific scheme, function, host, or SDK signature, keep the event visible and gather more examples.

## Examples

### Stable SDK-owned load failure

Observed event:

```text
Error: [clerk] failed to load https://clerk.worldmonitor.app/npm/@clerk/ui@1/dist/ui.browser.js
```

Recommended classification: `ignoreErrors`, using the namespaced Clerk prefix. The implementation does exactly that at `src/bootstrap/sentry-init.ts:321-324`. The positive test uses the production-shaped URL, and the adjacent negative test proves that a generic application message such as `Failed to load dashboard config` is not matched (`tests/sentry-beforesend.test.mjs:93-106`).

### Chained extension receiver around `window.fetch`

Observed relevant frames:

```text
/assets/main-B1YHLdCi.js:401 h
chrome-extension://hoklmmgfnpapgjgcpechhaamimifchmp/frame_ant/frame_ant.js:2 r.class.c.value.window.fetch
```

Recommended classification: `beforeSend`, because the bare message is generic and the decisive evidence lives in the stack. The receiver-aware regex accepts the chain ending in `.window.fetch`, and the production-shaped regression test locks in that behavior (`tests/sentry-beforesend.test.mjs:577-587`).

### Extension present, but ownership unproven

```text
/assets/panels-wF5GXf0N.js:100 MyApiCall
chrome-extension://…/content.js:1 inject
```

Recommended classification: keep the event. An extension frame named `inject` does not prove that the extension owns the failed request. The negative test requires this mixed stack to survive filtering (`tests/sentry-beforesend.test.mjs:589-598`).

### Fetch-like name that is not a fetch wrapper

```text
chrome-extension://…/inject.js:1 prefetch
```

Recommended classification: keep the event. Substring matching would incorrectly suppress `prefetch`, `fetchContent`, or `fetchUserData`; the anchored function matcher and its preservation tests prevent that regression (`src/bootstrap/sentry-init.ts:538-548`, `tests/sentry-beforesend.test.mjs:600-610`).

## Related Issues

- [PR #5360](https://github.com/koala73/worldmonitor/pull/5360) — filters implemented and regression-tested
- [Issue #4417](https://github.com/koala73/worldmonitor/issues/4417) — earlier work deferring Sentry SDK load; touches the same `src/bootstrap/sentry-init.ts` file but addresses bundle cost rather than filtering correctness
