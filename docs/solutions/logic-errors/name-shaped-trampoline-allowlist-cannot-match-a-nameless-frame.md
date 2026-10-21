---
title: "Vite's fourth trampoline rename was no name at all — fn: '' defeats a name-shaped allowlist"
date: 2026-08-13
category: logic-errors
module: Sentry error filtering
problem_type: logic_error
component: tooling
severity: medium
symptoms:
  - "Sentry WORLDMONITOR-Y4 (`TypeError: Failed to fetch`, 28 events / 27 users, error level) kept firing despite the beforeSend suppression gate shipped 2026-08-04 (PR #6129)"
  - "Replaying the shipped predicate against all 28 production events split 100% clean on the previous fix's deploy time: 14/14 pre-deploy suppressed by current code, 14/14 post-deploy surfaced"
  - "Every surfaced event was blocked by exactly one panel-storage chunk frame with fn: null (normalized to ''), which no name-shaped regex can match"
  - "isTrampolineFrameFunction('') returned false, so one nameless frame defeated the .every() allowlist and the whole event surfaced"
root_cause: logic_error
resolution_type: code_fix
related_components: [testing_framework, development_workflow]
tags: [sentry, before-send, stack-gating, vite-minification, debugbear, fetch-wrapper, anonymous-frame, regression-testing]
---

# Vite's fourth trampoline rename was no name at all — fn: '' defeats a name-shaped allowlist

> **Correction (same day, WORLDMONITOR-Z6):** the `''` tolerance below was necessary but not sufficient — it shipped, deployed, and the class kept firing from builds that contained it. The anonymous hop's **runtime** value in `beforeSend` is `'?'`, because `@sentry/core` stamps every parsed frame with `function || UNKNOWN_FUNCTION` (`node_modules/@sentry/core/build/cjs/utils/stacktrace.js:115`) before user code sees it; Sentry **ingest** then displays `'?'` as a null function. A replay or fixture built from API events therefore tests `''` and passes while production tests `'?'` and fails. The corrected predicate admits both (`fn === '' || fn === '?'`), each bounded by the same fetch-free-chunk invariant, with the runtime shape pinned by its own fixture. Lesson appended to Prevention: **the ingest event is not the SDK event** — validate `beforeSend` fixtures against the SDK's frame representation, not the API's.

> Merge state: the `''` half merged in PR #6547; the `'?'` correction is unmerged as of this writing (2026-08-13, branch `fix/y4-unknown-function-sentinel`). File:line citations are against that branch's working tree.

## Problem

Sentry issue WORLDMONITOR-Y4 ("TypeError: Failed to fetch", 28 events / 27 users, error level) kept firing even though a suppression gate for exactly this class had shipped on 2026-08-04 in PR #6129. The gate in `src/bootstrap/sentry-init.ts` suppresses a bare `Failed to fetch` only when a DebugBear RUM collector frame is present AND every non-infra frame is either that collector or a trampoline-shaped frame confined to the two fetch-free Vite chunks (`panel-storage` / `widget-store`) — see the gate at `src/bootstrap/sentry-init.ts:616-623`.

The hole: the trampoline test was purely name-shaped. A later Vite build emitted one `panel-storage-*.js` hop with **no function name at all** — Sentry records `function: null`, which the gate coalesces to `''` via `f.function ?? ''` (`src/bootstrap/sentry-init.ts:621`). The empty string matched neither the fetch-anchored pattern nor the bare-minified-name pattern, so a single nameless frame defeated the `.every()` and the entire class re-surfaced as new events under the same issue.

This is the **fourth build-rename** of one wrapper class. Each prior fix was correct for the shape it saw; each was defeated by the next minifier output:

1. **VC** (PR #5143, the original gate): trampoline named `window.fetch` — anchored match.
2. **VQ** (PR #5293): same trampoline emitted as `Rt.window.fetch` — fix added an optional bounded (≤3-char) minified receiver prefix (`src/bootstrap/sentry-init.ts:589-594`). That PR's body already recorded the half-lesson: "a filter keyed on a minified frame's function name is build-fragile … the chunk-filename gate is the durable half of that predicate."
3. **Y4** (PR #6129): one hop emitted as a bare ≤2-char minified name (`t`) with no `fetch` in it at all — fix admitted bare names at ≤2 chars, only inside the two chunks (`src/bootstrap/sentry-init.ts:595-604`), and introduced the fetch-free-chunk guard test.
4. **Y4 recurrence** (this session): the hop emitted **anonymously** — no name-shaped pattern can ever match `''`.

## Symptoms

- The issue's event stream continued past the prior fix's deploy, with fresh events daily (e.g. 2026-08-13T05:18:41Z), despite the filter "already existing."
- Every post-deploy event's stack was fully consistent with the suppressed class — DebugBear collector frames plus panel-storage/widget-store trampoline hops — except for exactly one `function: null` frame in a `panel-storage-*.js` chunk.
- 8 distinct `panel-storage` chunk hashes appeared across the 14 post-deploy events: multiple production builds, all emitting the anonymous hop.

## What Didn't Work

**The name-shape lineage (VC → VQ → Y4).** Three consecutive fixes each widened a regex to admit the newest minifier spelling of the same trampoline: `window.fetch`, then `Rt.window.fetch` (bounded receiver), then bare `t` (≤2-char bound). All three were locally correct and individually well-bounded — and all three shared the same structural flaw: they anchored a suppression allowlist on the *shape of a name the minifier happens to emit*. The minifier owes no stability there, and the fourth rename produced the one shape (`''` — no name at all) that no name pattern, however widened, can match. The lineage was a treadmill: each fix guaranteed only that the *previous* build's spelling was covered. Nor is this DebugBear-specific: the sibling extension-wrapper gate was defeated the same way by Sentry's aliased-property annotation on `window.fetch` frames (PR #6028).

**Widening past the observed shape (prior session).** The 2026-08-03 session that shipped PR #6129 first tried a broader widening — and two existing `tests/sentry-beforesend.test.mjs` cases went red. Its recorded verdict: the failures were "deliberate safety bounds — my widening was too broad and would have created a real blind spot," and the gate was narrowed to exactly the observed shape (session history). That is the operating rule for this gate: the beforeSend suite is adversarial to widening by design; when it goes red on a widening, the widening is wrong, not the tests.

**Checking frames via the Sentry issue-events LIST endpoint (this session's near-miss).** The first "is every post-deploy event really all-DebugBear?" verification queried the issue's events list endpoint — which **omits `entries`/stacktraces entirely**. A frame predicate evaluated against those payloads is vacuous: it sees zero frames and can "confirm" anything. The real check required fetching **each event individually** via `/projects/{org}/{proj}/events/{id}/`, which is the only representation that carries the stacktrace. (The same trimming hides `extra` fields like `interactionTarget` — a trap independently hit during the 2026-08-05 INP field pull.)

## Solution

One line in the predicate at `src/bootstrap/sentry-init.ts:614-615` — admit the empty name on the same bound as the bare minified name:

```ts
// before
const isTrampolineFrameFunction = (fn: string) =>
  /^(?:\w{1,3}\.)?(?:window\.)?fetch$/.test(fn) || /^\w{1,2}$/.test(fn);

// after
const isTrampolineFrameFunction = (fn: string) =>
  /^(?:\w{1,3}\.)?(?:window\.)?fetch$/.test(fn) || /^\w{1,2}$/.test(fn) || fn === '';
```

The diagnosis that justified it is the durable technique: **replay the shipped predicate against every production event, split by the prior fix's deploy time.** A Python script re-implemented the exact shipped gate and ran it over all 28 Y4 events (each fetched individually — see the near-miss above). Split at the 2026-08-04T05:06Z merge of PR #6129: 14/14 pre-deploy events suppressed by current code; 14/14 post-deploy events blocked, each by exactly one `fn: ''` panel-storage frame. A 100% clean split on deploy time is the signature of a *recurrence with a new shape* (the old fix works on everything it saw), versus a mixed split, which would mean the original fix was incomplete. After adding `|| fn === ''`, the replay suppressed 28/28.

Regression coverage (red before the fix, green after; suite 256/256) in the "Y4 anonymous trampoline hop" describe at `tests/sentry-beforesend.test.mjs:1486-1521`:

- the **exact production stack** — fixture frames verbatim from event 2026-08-13T05:18:41Z (`tests/sentry-beforesend.test.mjs:1488-1497`) — is suppressed;
- an anonymous frame in a **non-allowlisted** chunk (`runtime-*.js`) still surfaces (`:1504-1513`);
- an anonymous trampoline frame **without a collector frame** still surfaces (`:1515-1520`).

Sentry issue handling: plain resolve — never `inNextRelease` on this project.

## Why This Works

Admitting `''` looks like the widest possible tolerance, but the safety of this gate was never carried by the name regex. It is carried by an **enforced invariant**: neither `src/utils/panel-storage.ts` nor `src/services/widget-store.ts` issues any network call, so a frame attributed to those chunks *cannot* be the real fetch caller — whether or not the minifier kept a name for it. That invariant is not asserted in a comment; it is enforced by `tests/debugbear-trampoline-chunks.test.mjs:30-54`, which fails the suite if either module ever gains `fetch`/`XMLHttpRequest`/`EventSource`/`WebSocket`/`sendBeacon` (comment-stripped source scan, `:39-41`), and by a wiring guard (`:56-68`) that fails if the gate stops keying on those chunk names — so the guard cannot silently outlive the thing it protects.

The anchors themselves are deliberately WM-controlled: the gate keys on this repo's own Vite code-split chunk names — Rollup derives `panel-storage`/`widget-store` from the first-party module filenames behind their dynamic imports, not from `manualChunks` entries — so nothing DebugBear's deploys can rename is part of the identity (session history — both prior fixing sessions verified the chunk-name wiring in `vite.config.ts` as the pre-flight before touching the gate).

The other two load-bearing halves are untouched: the empty name is admitted **only** inside the two allowlisted chunks (any other first-party module can emit anonymous frames, and most of them do fetch), and a DebugBear collector frame is still **required** (it is the only reason these trampolines appear in a stack at all). `fetchContent` and `apiClient.fetch` — real callers that earlier fixes were careful not to swallow — still surface, and their tests still assert it.

## Prevention

- **Treat minifier output shape as adversarial and unstable.** Never anchor a security- or suppression-relevant allowlist on name shape alone — a build tool will eventually emit the one shape your regex family cannot express (here: no name at all). Four renames of one wrapper class, plus the sibling extension-gate defeat (PR #6028), are the empirical proof.
- **Bound tolerances by an enforced invariant, not by regex tightness.** The honest bound here is "these chunks are fetch-free," proven continuously by a guard test that fails when the invariant breaks — not "the name looks trampoline-ish." When you widen a tolerance, ask what *enforced* fact makes the widening safe; if the answer is only "the regex is still narrow," the widening is not safe.
- **When a filter "already exists" but the issue still fires, replay the shipped predicate against ALL events and split by the fix's deploy time.** Re-implement the exact shipped logic as a script, run it over every production event, and partition at the deploy timestamp. 100% clean split = recurrence with a new shape (name the exact blocking frame); mixed results = the original fix was incomplete. Either way you get the hole named with evidence, not a guess.
- **The Sentry issue-events LIST endpoint omits `entries`/stacktraces (and trims `extra`).** Any frame-level check against list payloads is vacuous. Fetch each event individually via `/projects/{org}/{proj}/events/{id}/` before asserting anything about frames.
- **The ingest event is not the SDK event — anonymous frames are `'?'` at runtime, null at ingest.** `@sentry/core` stamps `function || '?'` into every parsed frame *before* `beforeSend` runs; ingest displays `'?'` back as a null function. Any `beforeSend` predicate, fixture, or replay built from API event data therefore tests a value production never sees for anonymous frames. Pin gate fixtures to the SDK representation (grep the installed SDK for `UNKNOWN_FUNCTION` when in doubt), and treat a "fixed" filter that keeps firing *from builds containing the fix* as the signature of exactly this representation gap (WORLDMONITOR-Z6: the `''` tolerance was live in every reporting build's source while the events sailed through as `'?'`).
- **Decide explicitly what `f.function ?? ''` means.** Sentry records anonymous frames as `function: null`; gate code that coalesces to `''` must make the empty name an explicit branch of the predicate, or the decision is made by omission (here it failed closed for suppression — the event surfaced — but by accident, not by design).
- **Respect the adversarial suite.** `tests/sentry-beforesend.test.mjs` is deliberately hostile to over-widening — a red preservation test on a widening means the widening is wrong. Pair every new suppression fixture with the counter-fixtures that must keep surfacing.
- **Resolve with plain resolve** — never `inNextRelease` on this project (it pins to a release that browser events can never order past, permanently muting the issue).

## Related Issues

- `docs/solutions/best-practices/sentry-noise-filtering-with-stack-gating-and-signature-matching.md` — the general stack-gating discipline (WR/TZ era). This doc is the build-fragility sequel: that one answers "how to classify third-party noise correctly," this one answers "how to keep a classification alive across builds." Its name-regex-centric guidance is nuanced by the lineage here.
- `docs/solutions/logic-errors/one-route-401-declared-the-whole-anon-session-dead.md` — sibling use of the population-replay diagnostic style against Sentry events (WORLDMONITOR-WG).
- PR #5143 (VC, original gate) → PR #5293 (VQ, receiver prefix) → PR #6129 (Y4, bare-name bound + the fetch-free-chunk guard test) — the lineage, all merged.
- PR #6028 — the same name-shape failure class on the sibling extension-wrapper gate (aliased-property annotation).
- Issue #5388 — why the DebugBear RUM collector runs in production (100% sample at the time); the `window.fetch` wrapping itself is documented in PR #5143's body.
