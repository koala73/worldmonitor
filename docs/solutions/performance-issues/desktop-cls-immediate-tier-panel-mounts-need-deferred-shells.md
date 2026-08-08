---
title: "Desktop CLS: immediate-tier panel mounts need deferred shells, not victim fixes"
date: 2026-07-17
category: performance-issues
module: Desktop dashboard panel mount (panel-layout.ts)
problem_type: performance_issue
component: frontend_stimulus
severity: high
symptoms:
  - "Desktop CLS was the only failing Core Web Vital in CrUX (63% good) despite two shift-victim fixes (#5137 banner positioning, #5333 panel height pins) landing with null field effect"
  - "A 2026-07-11 lab reproduction returned a false null: fast anonymous lab loads resolved dynamic imports before the layout-shift window opened, so panel-mount displacement did not reproduce in the lab"
  - "Existing Sentry CLS reports carried no per-panel attribution, so no fix target could be named from field data alone"
  - "The first INITIAL_PANEL_MOUNT_BUDGET_DESKTOP=8 desktop 'immediate-tier' panels mounted via async unplaceheld grid insertions (insertInitialPanelByKey -> mountLazyPanel with no placeholder), while only panels 9+ got footprint-preserving shells"
root_cause: async_timing
resolution_type: code_fix
tags: [cls, core-web-vitals, layout-shift, panel-mount, deferred-shell, sentry-instrumentation, debugbear, desktop-dashboard]
---

# Desktop CLS: immediate-tier panel mounts need deferred shells, not victim fixes

## Problem

Desktop Core Web Vitals for `/dashboard` (koala73/worldmonitor) had one failing metric: Cumulative Layout Shift, stuck at CrUX 63% "good" against a 75% pass bar. Two prior fixes aimed at the panels that Chrome and DebugBear ranked as shifting the most had no field effect, because both rankings name the elements that get pushed, not the element that does the pushing.

## Symptoms

- CrUX: desktop `/dashboard` CLS at 63% good, the only failing axis, non-trending across two prior fix attempts.
- DebugBear RUM `clsSelector` ranking: `#panelsGrid div.panel` as the #1 shifted selector, p75 0.177 on n=4,076 pre-fix views.
- Sentry CLS reports (bad-tail, i.e. reports attached to shifts crossing the "needs improvement" threshold): a dominant single large shift per bad event, `largestShiftTarget` pointing at in-grid panel elements.
- A 2026-07-11 throttled lab reproduction (Slow-4G + 4× CPU, buffered `layout-shift` PerformanceObserver) found **zero** in-grid `[data-panel]` shifts — a clean lab null that the team took as evidence the async-panel-mount mechanism didn't exist, and shipped a different fix instead.

## What Didn't Work

**Fix #5137 — pin the cached-mode banner.** Chrome's `largestShiftTarget` attribution pointed at `#main`/`#panelsGrid` shifting. Investigation traced part of that to `.cached-mode-banner` being in-flow and toggled on slow connections, shoving the column below it. Fixing the banner to `position:fixed` genuinely helped — it removed `#main` from the victim rankings — but it addressed only one of several things capable of shoving the grid. It did not touch the panel-level shifts, because a banner insertion above the grid and an insertion inside the grid are different mechanisms that happen to produce the same symptom (a `#panelsGrid`/`#main` victim entry).

**Fix #5333 — pin the ranked panels' row heights to their row max.** DebugBear's `clsSelector` ranking named `#panelsGrid div.panel` as the dominant shifted element, and specific panels (insights, cii, threat-timeline, etc.) as the worst offenders by selector text. The fix pinned those panels to deterministic row heights so they couldn't grow and shift their neighbors. Field CLS was **unmoved** (`div.panel` p75 held flat at 0.169→0.172-0.175, no early/late trend post-deploy). The reason: DebugBear's selector ranking, like Chrome's `largestShiftTarget`, names the panel whose position moved on screen — the **victim** — not the panel or event that caused the move. The pinned panels were being shoved by something else; pinning their own height removed a growth path that was never the dominant field mechanism. This is the same trap that had already bitten once in the `#4580` investigation at page-element granularity (the banner case) — it recurred here at panel granularity, on prominent above-fold panels that get shifted by *anything* touching the grid above them.

**The 2026-07-11 lab null.** A throttled lab reproduction specifically targeted "async panel-mount displacement" as a hypothesis and found zero in-grid layout-shift entries, so the team treated the mechanism as disproven and moved on to other fixes (#5137, #5333). The lab null was **false**, discovered only after field instrumentation named the real mechanism ten hours after shipping. Root cause of the false negative: anonymous, fast lab page loads resolve the dynamic `import()` calls behind lazy panels *before* the layout-shift measurement window is sensitive to them — the chunks are cached/fast enough that mounting finishes near first paint. Real users on slower devices/networks, and users with persisted panel layouts/settings from localStorage, get those same dynamic imports resolving mid-boot, after first paint, which is exactly when a raw grid insertion registers as a layout shift. A lab environment optimized for reproducibility (fast, cold, anonymous) systematically hides a mechanism that depends on being slow.

## Solution

**Step 1 — instrument at shift time to name movers, not victims (PR #5336, `src/bootstrap/cls-mover-tracker.ts`).** Since two attribution sources (Chrome's native API and DebugBear's RUM) both report victims, the fix was to stop trusting either and measure geometry directly. `src/bootstrap/cls-mover-tracker.ts:1-19` states the thesis:

```
 * `largestShiftTarget`/shifted-content rankings name shift VICTIMS — what
 * moved — not MOVERS — what changed size and pushed them. That distinction
 * was proven the hard way twice: fixing the banner (#5137) removed `#main`
 * from the victim rankings, and pinning the ranked panels' heights (#5333)
 * left field CLS unmoved because the pinned panels were themselves victims.
 *
 * This tracker names movers directly. It keeps a per-panel geometry cache
 * (stable mover key -> {top, height}) and, on every qualifying layout-shift delivery,
 * diffs the current geometry against the cache: a panel whose HEIGHT changed
 * is a mover; a panel whose position changed at constant height is a victim;
 * a panel present now but absent from the cache is an insertion (mount-order
 * suspects).
```

The pure diff core, `diffPanelGeometry` (`src/bootstrap/cls-mover-tracker.ts:57-80`), classifies every currently-visible panel against the cached baseline:

```ts
export function diffPanelGeometry(
  cache: Record<string, PanelRect>,
  current: Record<string, PanelRect>,
): PanelGeometryDiff {
  const heightChangers: Array<{ key: string; delta: number }> = [];
  const movedOnly: string[] = [];
  const inserted: string[] = [];
  const removed = Object.keys(cache).filter((key) => !(key in current));
  for (const [key, rect] of Object.entries(current)) {
    const prev = cache[key];
    if (!prev) {
      inserted.push(key);
      continue;
    }
    const dH = rect.height - prev.height;
    const dTop = rect.top - prev.top;
    if (Math.abs(dH) > GEOMETRY_JITTER_PX) {
      heightChangers.push({ key, delta: Math.round(dH) });
    } else if (Math.abs(dTop) > GEOMETRY_JITTER_PX) {
      movedOnly.push(key);
    }
  }
  return { heightChangers, movedOnly, inserted, removed };
}
```

A panel present in `current` but absent from `cache` is an **insertion** (`ins:`) — a brand-new grid item that appeared without ever occupying space before. A panel whose height changed is a **mover** (`sized:`, signed delta so a shrinking panel that pulled space away also counts — `src/bootstrap/cls-mover-tracker.ts:92-99`). A panel whose top moved with unchanged height is a pure **victim** (`moved:N`, count only). A cached panel that disappeared is a **removal** (`rem:`). A shift arriving before any baseline snapshot exists is `coldStart` (`cold`) — attributable to the pre-baseline boot window, not a specific panel.

The live `PerformanceObserver('layout-shift')` wiring (`src/bootstrap/cls-mover-tracker.ts:163-223`) snapshots panel geometry, diffs on every shift ≥ `RECORD_SHIFT_THRESHOLD` (0.05), keeps a 6-record ring, and exposes the top-3-by-value as compact strings via `getMoverRecordStrings()` (`src/bootstrap/cls-mover-tracker.ts:141-143`), which ride the *existing* Sentry CLS report as `extra.movers` — no new telemetry quota, because it only attaches to reports that were already being sent for bad-tail CLS.

**Field result, ~10.5 hours post-merge:** `ins:` tokens dominated — `insights` ×118, `cii` ×111, `threat-timeline` ×102, `strategic-posture`, `strategic-risk`, `forecast`, `live-webcams`, `live-news` all in the same bracket, 1,305 `ins:` tokens/day total, `sized:` stayed in single digits per key, `rem:` zero. The 8 dominant keys were an exact fingerprint match to `INITIAL_PANEL_MOUNT_BUDGET_DESKTOP = 8` at `src/app/panel-mount-deferral.ts:10` — the mechanism was named by the data itself, not inferred.

**Step 2 — trace the fingerprint to the actual code path.** `insertInitialPanelByKey` (`src/app/panel-layout.ts:1464-1481`) is the boot-time entry point for the first `INITIAL_PANEL_MOUNT_BUDGET_DESKTOP` (8) enabled panels — the "immediate tier." Before the fix, it called `mountLazyPanel(key, grid)` directly for lazy-registered panels with **no placeholder**: the panel's dynamic `import()` resolved asynchronously, and whenever it did, `mountPanelElement` (`src/app/panel-layout.ts:1483-1496`) fell through to `insertByOrder(grid, el, key)` (no placeholder to `replaceChild` into), raw-inserting a brand-new grid item into the *live* grid — after first paint on real devices — and shoving every panel below it down. Field sample: 3 such mounts produced `moved:28`. This was the "immediate" tier in name only; it was never actually synchronous for users whose devices/network made the import resolve after paint. Only the **deferred** tier (panel 9+) had the existing footprint-preserving contract: `createDeferredPanelShell` + `replaceChild`.

**Step 3 — the fix (PR #5344, merged 2026-07-16).** Route immediate-tier boot mounts through the same slot-reserving shell contract the deferred tier already had, instead of inventing a parallel mechanism. Current `insertInitialPanelByKey` (`src/app/panel-layout.ts:1464-1481`):

```ts
private insertInitialPanelByKey(grid: HTMLElement, key: string): void {
  const panel = this.ctx.panels[key];
  if (panel && !panel.getElement().parentElement) {
    this.insertInitialPanel(grid, key, panel);
    return;
  }
  if (panel || !this.lazyPanelRegistrations.has(key)) return;
  // Immediate-tier lazy panels go through the same slot-reserving shell
  // contract as deferred ones (#5332): the shell occupies the panel's grid
  // slot during this synchronous boot pass and the async chunk arrival
  // replaces it in place. The previous placeholder-less mountLazyPanel path
  // inserted a brand-new grid item whenever the import resolved — field
  // mover data named those insertions as the dominant desktop CLS source.
  this.deferPanelMount(key, null, grid, this.ctx.panelSettings[key]?.enabled === true);
  if (this.shouldMountPanelImmediately(key)) {
    this.mountDeferredPanel(key);
  }
}
```

Where before it was:

```ts
// pre-#5344
if (panel || !this.lazyPanelRegistrations.has(key)) return;
this.mountLazyPanel(key, grid);   // no shell — raw async insertion into the live grid
```

`deferPanelMount(key, null, grid, withShell)` (`src/app/panel-layout.ts:1509-1540`) synchronously creates and inserts a footprint-matched `createDeferredPanelShell` placeholder into the grid *during the boot loop* — before any async work happens — so the immediate-tier panel occupies its final grid slot from the first frame, exactly like a deferred panel does. `mountDeferredPanel(key)` (`src/app/panel-layout.ts:1605` onward) is then called immediately afterward (still gated by the existing `shouldMountPanelImmediately` budget check) to kick off the load right away rather than waiting for scroll/IntersectionObserver — the visible difference from a true deferred panel is *when* the load starts, not *whether* a shell reserves the slot first. When the chunk resolves, `mountPanelElement` (`src/app/panel-layout.ts:1483-1496`) finds the placeholder and does `placeholder.parentNode.replaceChild(el, placeholder)` — an in-place swap with zero shift, using the exact same retry/failure machinery (`scheduleDeferredPanelRetry`, `DEFERRED_PANEL_MAX_RETRY_ATTEMPTS`) the deferred tier already had for free.

**Review-hardening bundled in the same PR**, because reusing the deferred-shell contract for immediate-tier panels surfaced edge cases the deferred path alone never hit:

- **Shell-aware deep-link readiness** (`src/app/search-manager.ts:648-657`, `dispatchPanelTab`): a placeholder carries the same `data-panel` attribute as the real panel but has no event listener, so a deep-link that fired against the placeholder would silently no-op. The selector was tightened to exclude shells:
  ```ts
  if (document.querySelector(`[data-panel="${panelId}"]:not([data-deferred-panel])`)) {
    window.dispatchEvent(new CustomEvent('wm-consumer-prices-open-tab', { detail: { tab } }));
    return;
  }
  ```
  The scroll helpers (`scrollToPanel`/`scrollToPanelWhenReady`) intentionally kept matching shells — scrolling to a shell is what brings it into the IntersectionObserver margin that triggers its own mount, so excluding shells there would break scroll-to-mount entirely (documented at `src/app/search-manager.ts:638-647`).
- **One-shot `online` retry re-arm** (`src/app/panel-layout.ts:1575-1603`, `scheduleDeferredPanelRetry`): once immediate-tier panels could also exhaust `DEFERRED_PANEL_MAX_RETRY_ATTEMPTS`, a connectivity blip during boot could otherwise strand a panel's skeleton shell permanently. A one-shot `window.addEventListener('online', ...)` re-arms the retry budget so a transient network drop doesn't require a manual reload, while a genuinely broken chunk still fails its retries again and lands back in the same failed state.
- **Placeholder-visibility reconciliation decoupled from mount attempts** (`src/app/panel-layout.ts:1302-1344`, `applyPanelSettings`): re-enabling a panel while its deferred load is already in flight (`deferred.loading` set) previously left the hidden shell orphaned — `mountDeferredPanel` would no-op because a load was already pending, and nothing unhid the shell. The fix separates the two concerns:
  ```ts
  if (!mountedFromDeferred && deferred?.placeholder) {
    deferred.placeholder.classList.toggle('hidden', !config.enabled);
  }
  ```
- **Dead-parameter cleanup**: `mountLazyPanel`'s optional `placeholder` parameter — designed for exactly this slot-preserving use but never called with three arguments in the file's history — was removed once the shell contract subsumed its purpose, leaving the mid-session `mountLiveNewsIfReady` path as the function's only caller.
- **Anchored source-guard regex** (`tests/panel-mount-deferral.test.mts:476-496`): `panel-layout.ts` is bundler-only and cannot be imported into the plain-Node test harness (it depends on Vite-specific module resolution), so the regression guard reads the source text directly and anchors on the method boundary — `source.match(/private\s+insertInitialPanelByKey\([\s\S]*?\n {2}\}/)` — rather than grepping loosely for `mountLazyPanel(` anywhere in the file (which would false-positive on the method existing elsewhere, e.g. in `mountLiveNewsIfReady`). The anchored match then asserts the extracted method body does **not** contain `mountLazyPanel(` and **does** contain the exact `deferPanelMount(key, null, grid, ...)` → budget-gated `mountDeferredPanel(key)` sequence, so a regression that reintroduces the placeholder-less path, or that reorders/drops the enabled-flag argument, fails CI immediately.

## Why This Works

Shift-attribution APIs — Chrome's native `largestShiftTarget` and DebugBear's `clsSelector` RUM ranking — report the DOM node whose *position* changed as a result of a shift. That is definitionally the victim: the thing that got pushed. Neither API tells you what pushed it, because the shift event doesn't carry a "cause" field — it carries only the elements whose rects changed between frames, position-changed and size-changed alike, with no way to distinguish "I moved because something above me grew" from "I am the thing that grew." Two rounds of fixes (#5137, #5333) chased the highest-ranked victims and got real-but-partial or null results because a victim ranking, however consistently reproduced, is not evidence about mechanism — a prominent above-fold panel appears in the ranking whenever *anything* shifts the grid above it, regardless of what that anything is.

The mover tracker breaks that ambiguity by diffing geometry itself, at shift time, against a cache it controls: a panel whose *height* changed between the cached snapshot and now is provably a mover (it changed its own footprint), and a panel whose position changed at *constant* height is provably a pure victim (something else moved it). A panel that appears in the current snapshot with no prior cache entry is an insertion — new content that never occupied space before, which is a mover of a different kind (it doesn't grow, it materializes). This is a strictly stronger signal than either attribution API because it's derived from two point-in-time measurements of the same element rather than the browser's own (victim-only) shift-target reporting.

The fix is correct because the "immediate tier" was never actually synchronous under real conditions — it was synchronous in intent (mount before first paint) but asynchronous in execution (behind a dynamic `import()`), and the deferred tier had already solved exactly this class of problem: reserve the final footprint with a shell before the async work starts, then swap in place when it resolves, so the shift-relevant geometry never changes across the swap. Routing immediate-tier mounts through the identical `deferPanelMount`/`mountDeferredPanel` contract, rather than writing a second bespoke "immediate but shelled" code path, means the immediate tier inherits retry, failure, and now `online`-re-arm handling for free, and there is exactly one contract in the codebase for "async panel arrives in the grid" instead of two divergent ones.

The fingerprint match — the 8 keys `ins:` fired on were exactly the 8 keys in `INITIAL_PANEL_MOUNT_BUDGET_DESKTOP` — was conclusive rather than merely suggestive because it ruled out confounding explanations by construction: it wasn't "some panels shift a lot," it was "precisely the panels the boot loop classifies as immediate-tier, and only those," which pointed directly at `insertInitialPanelByKey`/`shouldMountPanelImmediately` as the code path rather than requiring further narrowing.

## Prevention

- **For field-only metrics, a lab null never closes a mechanism hypothesis — it's evidence about the lab, not the mechanism.** The 2026-07-11 reproduction attempt was methodologically sound (throttled network/CPU, buffered observer) and still missed the mechanism, because "slow enough that a lab throttle profile approximates it" and "slow enough that the async import resolves after the field's layout-shift-sensitive window" are not the same threshold, and persisted-layout/localStorage state common in real sessions isn't present in an anonymous fast lab load either. When a metric only manifests in RUM/CrUX and a lab repro comes back clean, the next move is cheap field instrumentation that measures the real mechanism directly (the mover-tracker pattern: cache a baseline, diff at the actual event, ship the diff on the existing telemetry report) — not concluding the hypothesis is dead and moving to the next-ranked suspect.
- **Shift-attribution rankings (Chrome `largestShiftTarget`, RUM `clsSelector`/`clsText`) name victims, not movers, on every platform that reports them this way — treat any fix aimed at the top-ranked *shifted* element as a hypothesis about the pusher, not a confirmed target.** If a fix that shrinks/pins the top-ranked element doesn't move the aggregate metric, the ranking was naming a victim; the fix for a victim-only symptom is to instrument shift-time geometry diffing (cache `{top, height}` per candidate mover, diff on each qualifying shift) rather than escalating to the next name on the same victim list.
- **Any element inserted into a live, already-laid-out container asynchronously (dynamic `import()`, lazy fetch, IntersectionObserver-triggered mount, anything not present at first paint) needs a slot-reserving placeholder from first paint, not just from "when we decided to defer it."** The bug here was that the immediate tier was correctly identified as needing eager *loading* but not recognized as also needing footprint reservation, because "immediate" was conflated with "synchronous." Any async insertion into a grid/list/flow layout is a CLS source regardless of whether the code calls it "immediate" or "deferred" — the placeholder contract should be the default for all async grid membership changes, applied once and reused, as this fix did by folding the immediate tier into the existing deferred-shell contract rather than adding a second one.
- **When the code under test can't be imported by the test harness (bundler-only modules, e.g. `panel-layout.ts` here, which depends on Vite-specific resolution), guard regressions with an anchored source-text regex, not a loose substring grep.** `source.match(/private\s+insertInitialPanelByKey\([\s\S]*?\n {2}\}/)` isolates the exact method body by anchoring on its declaration and matching to the next same-indentation closing brace, then asserts against *that* substring. A loose `/mountLazyPanel\(/` grep over the whole file would false-positive on the same method name existing legitimately elsewhere (it does, in `mountLiveNewsIfReady`) and would not catch a regression that reorders or drops arguments inside the correct method. Anchor first, assert on the anchored body — see `tests/panel-mount-deferral.test.mts:476-496` for the full pattern (method extraction + `doesNotMatch` for the banned path + `match` for the exact expected call sequence).

## Verification

Two independent sources agreed on a large effect within 17 hours of the PR #5344 merge:

- **Sentry mover instrumentation** (the same `extra.movers` field from PR #5336): bad-CLS event rate dropped from 25.5/h to 4.9/h (−81%), and `ins:` tokens — insertions, the named mechanism — went from 1,305/day to **zero** across 81 post-merge events.
- **DebugBear full-population RUM** for `/dashboard` desktop: CLS p75 dropped from 0.143 to 0.006 (−96%, n=6,534 views), and the former #1 victim selector row, `#panelsGrid div.panel` (p75 0.177, n=4,076 pre-fix), disappeared from the top selector rows entirely.

Residual: `#main div#panelsGrid` at 0.142 — attributed to the boot cold window (skeleton-to-first-grid-population, before any panel baseline exists for the mover tracker to diff against), a P3-scale follow-up rather than a live regression.

## Related Issues

- koala73/worldmonitor#5332 — the issue thread carrying the mover verdicts and acceptance data. Note: its own spec ("Slice A") described the victim-aimed height-pin fix, and PR #5333's merge keyword auto-closed it on 2026-07-15 — before the real fix existed. PR #5344 (the actual fix) had no dedicated issue; its verdicts were posted to this thread.
- koala73/worldmonitor#4580 — parent tracking issue for the desktop CLS regression (#5332 was its slice A)
- koala73/worldmonitor#4490 — prior "reserve space for dynamically-mounted panels" fix whose contract left the immediate tier uncovered
- koala73/worldmonitor#5336 — the mover-tracker instrumentation PR whose field data named the mechanism
- koala73/worldmonitor#5333 / koala73/worldmonitor#5137 — the two victim-aimed fixes with null/partial field effect that motivated mover attribution
