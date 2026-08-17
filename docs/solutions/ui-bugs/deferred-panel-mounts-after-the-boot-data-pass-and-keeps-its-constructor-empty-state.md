---
title: "A deferred panel mounts AFTER the boot data pass and keeps its constructor's empty state forever — queue the call, and wait for the element"
date: 2026-08-13
category: ui-bugs
module: src/app/data-loader.ts
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - "Threat Timeline sits on its constructor copy 'Waiting for intelligence insight data.' with an UNAVAILABLE badge for the whole session"
  - "AI Strategic Posture sits on 'Scanning Theaters' with the elapsed counter ticking past 76s and the naval/theater stages never lighting up"
  - "Reproduces on mobile far more than desktop, and intermittently — the same page load can render one panel and strand the other"
  - "No console error, no failed request, no Sentry event: the data arrived and was discarded in-process"
root_cause: async_timing
resolution_type: code_fix
severity: high
related_components:
  - testing_framework
tags: [deferred-panel, lazy-mount, intersectionobserver, callpanel, pending-panel-data, runwhenconnected, isconnected, panel-lifecycle, mobile]
---

## Problem

Panels below the fold are mounted lazily by an `IntersectionObserver` whose margin is only 700px on mobile (`src/app/panel-layout.ts:1878`). The boot data pass finishes long before a user scrolls that far, so a deferred panel is routinely **not in `ctx.panels`** when its data arrives — and it is **not yet in the DOM** when its own constructor-started fetch resolves. Two panels shipped a hole in that window and displayed a permanent placeholder.

## Symptoms

- `THREAT TIMELINE — UNAVAILABLE`, body stuck on the constructor's `Waiting for intelligence insight data.`
- `AI STRATEGIC POSTURE`, body stuck on the loading radar `Scanning Theaters` with `Elapsed: 76 s` and climbing.
- Intermittent by design — it is a race. A production sweep on 2026-08-13 caught Threat Timeline stranded on every load and Strategic Posture stranded on some.
- Nothing in the console. The network calls all succeeded.

## What Didn't Work

- **Reading the call site and concluding it was wired.** `void threatTimelinePanel?.refresh(this.ctx.latestClusters)` reads like a complete hand-off. The optional chain is the bug: when `ctx.panels['threat-timeline']` is `undefined`, the expression evaluates to `undefined` and the clustering result is silently dropped. There is no error to see.
- **Looking for a retry that would recover it.** Neither panel has a `refreshScheduler` entry (Threat Timeline has none at all; Strategic Posture's is `REFRESH_INTERVALS.strategicPosture` = 15 minutes, `src/config/variants/base.ts:40`). `StrategicPosturePanel`'s own 30/60/90/120s vessel re-augment timers return early on `this.postures.length === 0`, so they cannot recover a panel that never got postures.
- **Blaming the upstream feed for the posture panel.** The absence of the `[StrategicPosturePanel] Got N total military vessels` log line was the tell: execution never reached `augmentWithVessels()`, so the panel stopped at or before the first `await` — an in-process discard, not a slow feed.
- **Trying to reproduce against a local `vite` dev server.** `api.worldmonitor.app` sends `Access-Control-Allow-Origin: https://worldmonitor.app`, so every data call from `localhost` fails CORS. What the local server *is* good for is the discriminator below.

## Solution

Two distinct fixes for two distinct halves of the same window.

**1. Data pushed to a panel that may not exist yet → push through the queue.**

`DataLoaderManager.callPanel()` already exists for exactly this: it calls directly when the panel is mounted and `enqueuePanelCall()`s otherwise, and `panel-layout.ts` replays the queue during lazy load (`replayPendingCalls`, `src/app/panel-layout.ts:3400`). The clustering fan-out was bypassing it.

```ts
// before — src/app/data-loader.ts (both arms of the clustering try/catch)
const insightsPanel = this.ctx.panels['insights'] as InsightsPanel | undefined;
insightsPanel?.updateInsights(this.ctx.latestClusters);
if (isPanelInVariantDefaults('threat-timeline')) {
  const threatTimelinePanel = this.ctx.panels['threat-timeline'] as ThreatTimelinePanel | undefined;
  void threatTimelinePanel?.refresh(this.ctx.latestClusters);
}

// after
this.callPanel('insights', 'updateInsights', this.ctx.latestClusters);
if (isPanelInVariantDefaults('threat-timeline')) {
  this.callPanel('threat-timeline', 'refresh', this.ctx.latestClusters);
}
```

The queue keeps only the newest args per `(key, method)` (`src/app/pending-panel-data.ts:9`), so a late mount replays the freshest clusters, once.

**2. A fetch started in the constructor → wait for the element, don't bail on it.**

`StrategicPosturePanel`'s constructor calls `init()` → `fetchAndRender()`, but `panel-layout` only inserts the element *after* the constructor returns (`new PanelClass()` in the loader, then `mountPanelElement()` several ticks later). A warm posture cache resolves in a microtask — before the insert — so the post-`await` guard fired:

```ts
const data = await fetchCachedTheaterPosture(this.signal);
if (!this.element?.isConnected) return;   // ← discarded the render, no retry
```

The repo's established idiom for this is `Panel.runWhenConnected()` (`src/components/Panel.ts:753`), already used by `LatestBriefPanel`, `McpDataPanel`, `TechReadinessPanel`, `AirlineIntelPanel` and `RegionalIntelligenceBoard`. Guard **before** starting the work, not after:

```ts
private async fetchAndRender(): Promise<void> {
  if (!this.element?.isConnected) {
    this.runWhenConnected(() => { void this.fetchAndRender(); });
    return;
  }
  if (!this.isPanelVisible()) return;
  // …
}
```

`mountPanelElement()` calls `panel.notifyConnected()` right after the insert (`src/app/panel-layout.ts:1813`), which flushes the queued callback.

## Why This Works

The two halves are the same window seen from opposite ends: **a deferred panel's constructor runs before its element is in the DOM, and its element enters the DOM long after the boot data pass.** Anything crossing that window needs somewhere to wait.

- `callPanel()` gives *inbound* data a place to wait (the pending-call map, drained at lazy-load time).
- `runWhenConnected()` gives *outbound* rendering a place to wait (the connected-callback list, drained by `notifyConnected()`).

An optional chain and a post-`await` `isConnected` bail both look like defensive programming. They are not: they are silent discards with no retry behind them, on a code path that is the *normal* case on a phone.

Note the asymmetry that makes the `isConnected` guard so easy to get wrong — it is genuinely correct *after* mount (a destroyed panel must not render) and wrong *before* it. Only moving it ahead of the fetch distinguishes "never attached yet" from "detached again".

## How far the class extends

The obvious follow-up — "how many of the ~90 panels have this?" — has a bounded answer, and the bound is what makes the fix small.

**Inbound pushes are safe wherever the loader re-runs.** `runGuarded` dedupes only *concurrent* runs (`ctx.inFlight`, released in `finally`); it never remembers a completed one. `afterPanelMounted` calls `primeVisiblePanelData()` and schedules a `loadAllData` pass, and `isPanelNearViewport` reads `ctx.panels[key]` — the Panel object, not the shell — so a panel's gate flips true at the moment it mounts and its loader re-delivers on that pass. Every OR-gated fan-out (`loadMarkets` across nine market panels, `loadIntelligenceSignals` across eleven) can drop a payload for an unmounted sibling and heal on the next scroll.

**`loadNews` is the only loader that cannot heal**, because `shouldHydrateNews` skips it once `loadedNewsSignature` matches the work-list. Auditing everything it delivers gives the complete list:

| delivered to | status |
|---|---|
| news category panels | already fixed — mount-time backfill in the `NewsPanel` lazy factory (#5376) |
| `geo-hubs`, `tech-hubs` | safe — their lazy factories pull `ctx.latestClusters`, gated on `clustersSettled` |
| `insights`, `threat-timeline` | **were broken** — fixed here |
| `monitors` (via `updateMonitorResults`) | **was broken** — fixed here. Less visible because the panel's constructor renders its input and keyword list, so only the results area stayed blank: it read as "your keywords matched nothing" rather than as a panel that never received the news |

Note the `NewsPanel` backfill comment already names this exact cause ("now that the load runs once per work-list that second chance is gone"). The class was known; three call sites were simply left out of that fix.

**Outbound renders** have an even smaller surface: only a panel that starts async work *before* mount can hit a pre-mount `isConnected` bail. That is three entry points — a constructor-started fetch (`StrategicPosturePanel`), a lazy factory that kicks `void p.refresh()` (`TechReadinessPanel`, `NationalDebtPanel`), and `replayPendingCalls`, which runs *before* the element is inserted. Every queued `(panel, method)` pair was checked against its class: none of the replayed methods contains an `isConnected` bail, and both factory-kicked panels already wait (`runWhenConnected`, and a hand-rolled MutationObserver equivalent). `StrategicPosturePanel` was the only gap.

## Prevention

**1. Extend the existing guard when adding a self-starting panel fetch.** `tests/panel-attached-fetch-guard.test.mts` already asserts that self-starting fetches call `runWhenConnected` before their network work — `StrategicPosturePanel` was simply missing from the list, which is exactly why it shipped broken:

```ts
it('StrategicPosturePanel fetchAndRender waits for connection before the posture fetch', () => {
  assertGuardBefore(
    read('src/components/StrategicPosturePanel.ts'),
    'fetchAndRender',
    /fetchCachedTheaterPosture\(/,
  );
});
```

**2. Never optional-chain a panel push inside a one-shot loader.** `tests/one-shot-loader-panel-delivery.test.mts` enforces the scoping rule below: it asserts `runGuarded` stays concurrency-only, asserts `loadedNewsSignature` is still the *only* completion latch (a new one means a new one-shot loader whose fan-out needs the same treatment), and rejects any direct `panels[key]` lookup inside `loadNews()` / `updateMonitorResults()` unless the key is allowlisted with a mount-time pull that the test then verifies still exists in `panel-layout.ts`. Slice each arm of the clustering try/catch before matching — a whole-method match passes with the queued call wired into only one arm, and the `catch` arm is where a regression hides because it runs only when clustering throws.

**3. A test that mounts the panel before feeding it cannot see this bug.** The DOM test must run the production *order*: construct detached → data arrives → `document.body.append(el)` → `notifyConnected()`. `tests/dom/late-mounted-panel-hydration.test.mts` does this, and it is what went red before the fix. Remember `Panel`'s 150ms content debounce (`src/components/Panel.ts:142`) — assert only after it drains, or every assertion reads pre-commit DOM and the suite is a false pass.

**4. Use an empty-data discriminator to verify in a real browser.** Local `vite` cannot fetch real data (CORS), but the two empty states differ by exactly one thing — whether `refresh()` ran:

| panel state | meaning |
|---|---|
| `Waiting for intelligence insight data.` | constructor's `renderEmpty` — `refresh()` never ran |
| `No recent threat metadata available from the intelligence snapshot.` | `renderState()` with `hasData === false` — `refresh()` ran |

Scrolling the deferred panel into view on the local dev server and seeing the copy change to the second string is end-to-end proof that the queue replayed on mount, with no working API needed.

## Related

- [A panel registered only in scheduleRefresh shows a loading radar for a full interval](panel-scheduled-but-never-primed-shows-loading-radar-for-a-full-interval.md) — the sibling failure: same visible symptom (permanent loading state), different half of the wiring (missing prime entry rather than a dropped push).
- [Desktop CLS: immediate-tier panel mounts need deferred shells](../performance-issues/desktop-cls-immediate-tier-panel-mounts-need-deferred-shells.md) — why panels are deferred in the first place, and the source-slice guard pattern reused in prevention #2.
- Hub panels (`geo-hubs`, `tech-hubs`) solve the same inbound-data problem a third way — pulling `ctx.latestClusters` in their lazy factory, gated on `ctx.clustersSettled` (`src/app/panel-layout.ts:2455-2473`) — because feeding their queue would drag a ~62KB tech-geo chunk onto the critical path. Prefer `callPanel()` unless there is a comparable payload reason.
