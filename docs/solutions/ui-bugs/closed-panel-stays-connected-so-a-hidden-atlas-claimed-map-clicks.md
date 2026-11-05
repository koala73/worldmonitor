---
title: "A closed panel is still connected — a hidden Storage Atlas claimed the map click and swallowed it; gate claims on visibility and deliver deferred opens from the mount hook"
date: 2026-11-04
category: ui-bugs
module: src/components/StorageFacilityMapPanel.ts
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - "Clicking a green storage dot on the 2D map does nothing after the Strategic Storage Atlas was closed with its X, collapsed, filtered out by a mobile category chip, or covered by the fullscreen map"
  - "Hovering still names the facility, so the dot is clearly picked; no popup, no console error"
  - "Open in Storage Atlas sometimes shows the bare atlas table with no drawer when the panel chunk loads slowly"
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components:
  - testing_framework
tags: [panel-lifecycle, isconnected, hidden-class, click-claim, preventdefault, cancelable-event, deferred-panel, afterpanelmounted, storage-atlas, deckgl, map-popup, mobile-cat-hidden, map-fullscreen]
---

## Problem

Two handlers in PR #10148 used `element.isConnected` as a stand-in for "the user can see this panel". Closing a dashboard panel does not detach it: `Panel.hide()` only adds the `hidden` class (`src/components/Panel.ts`), collapse only hides the content, the mobile category nav adds `.mobile-cat-hidden`, and map fullscreen hides the whole grid with `body.live-news-fullscreen-active`. So a "closed" Strategic Storage Atlas still passed the `isConnected` gate, claimed the map's click, loaded the facility into an invisible panel, and the map suppressed its own fallback popup. The same assumption made "Open in Storage Atlas" deliver into a panel nobody could see, and a bounded poll for the deferred panel gave up on slow loads.

## Symptoms

- Storage dot click: hover tooltip appears, click produces nothing. Reproduced on the local energy dashboard by closing the atlas with its X and clicking the Lille Torup dot.
- No error anywhere: the click was handled, by a panel with `display: none`.
- "Open in Storage Atlas" from a fullscreen map or a mobile category view: the popup closed and nothing visible happened.
- On a slow deferred-panel import the atlas mounted later with no drawer for the clicked facility.

## What Didn't Work

- **Treating `isConnected` as visibility.** The original claim handler was `if (!id || !this.element?.isConnected) return;` followed by `ev.preventDefault()`. Four review bots and three independent reviewers flagged the same line; the author's own test only covered detached versus attached, so it pinned the wrong contract.
- **Polling for the deferred panel.** `focusStorageFacility` retried 24 times at 200 ms and silently returned. A chunk slower than 4.8 s, or a deferred mount sitting in its `failed` state waiting for `online`, mounted later with nobody re-dispatching the request. The repo already documents this failure class: a push aimed at an absent panel must be queued and replayed from the mount, never dropped (see `docs/solutions/ui-bugs/deferred-panel-mounts-after-the-boot-data-pass-and-keeps-its-constructor-empty-state.md`).
- **Dispatching the detail event from another panel.** `EnergyDisruptionsPanel` rows dispatched `energy:open-storage-facility-detail` directly. Once the claim was gated on visibility, a closed atlas ignored those rows too (CodeRabbit caught this on the follow-up head).

## Solution

1. **One visibility predicate on `Panel`.** `Panel.isVisibleToUser()` = `canHostLiveMedia()` (connected, no `hidden` class, not collapsed) and not `.mobile-cat-hidden` and not `body.live-news-fullscreen-active`. The atlas claims the click only when it is true:

```ts
// src/components/StorageFacilityMapPanel.ts
private claimStorageClick = (ev: Event): void => {
  const id = (ev as CustomEvent<{ facilityId?: string }>).detail?.facilityId;
  if (!id || !this.isVisibleToUser()) return;
  ev.preventDefault();   // "the atlas owns this click, skip the map popup"
  void this.loadDetail(id);
};
```

2. **Claim contract.** `DeckGLMap` dispatches a **cancelable** `energy:open-storage-facility-detail`; `event.defaultPrevented` false means "show the `MapPopup` summary with an Open in Storage Atlas button". Any code that just wants the atlas opened dispatches `wm:open-storage-atlas { facilityId }` instead (the popup button and `EnergyDisruptionsPanel` both do).

3. **Deliver from the mount hook, not a poll.** `wm:open-storage-atlas` runs through `EventHandlerManager`: `enablePanelById` -> exit map fullscreen -> `PanelLayoutManager.focusStorageFacility`, which parks `pendingStorageFacilityId`, calls `mountDeferredPanel`, delivers immediately if the panel is connected, and otherwise lets `afterPanelMounted` deliver once the chunk mounts, however late. Delivery expands the panel, dispatches `wm:reveal-panel` (so `MobilePanelNav` drops an excluding chip), dispatches the detail event, then scrolls.

```ts
// src/app/panel-layout.ts
private afterPanelMounted(key: string, panel: Panel): void {
  ...
  if (key === STORAGE_ATLAS_PANEL_KEY) this.deliverPendingStorageFacility(panel);
```

Verified in the real browser (Playwright against the local energy dashboard): close the atlas with X, click a dot, the popup appears; press Open in Storage Atlas, the panel is re-enabled, scrolled into view, and its drawer shows the facility.

## Why This Works

Visibility is a property of the panel's whole presentation state, not of DOM attachment, so the predicate lives on `Panel` where all four hiding mechanisms are known. The cancelable-event claim keeps the map and the atlas loosely coupled while still letting the map know whether anyone will visibly answer. Moving delivery into `afterPanelMounted` reuses the one place every deferred mount path (initial, retry, re-enable) already passes through, so there is no window to miss and no timer to tune.

## Prevention

- Never gate an interaction claim or a render on `isConnected` alone; use `Panel.isVisibleToUser()` (or `canHostLiveMedia()` when the mobile filter and fullscreen are irrelevant).
- When a request targets a deferred panel, store it and consume it from `afterPanelMounted`; a bounded retry is a bug waiting for a slow network.
- A DOM test for a claim must cover the connected-but-hidden case: `panel.toggle(false)` then assert `defaultPrevented === false` (`tests/dom/storage-facility-click-claim.test.mts`). The focus flow is pinned in `tests/dom/storage-atlas-focus.test.mts`, the disruptions route in `tests/dom/energy-disruptions-open-asset.test.mts`.
- `StorageFacilityMapPanel` is not `collapsible`, so `setCollapsed` is a no-op on it; do not write a test that expects the collapsed branch to fire for it.

## Related

- PR #10148 (fix, review fixes, follow-up), issue #10138.
- `docs/solutions/ui-bugs/deferred-panel-mounts-after-the-boot-data-pass-and-keeps-its-constructor-empty-state.md` — the replay-from-mount rule this fix follows.
- `CONCEPTS.md`: Late-Mount Window, Click Claim.
