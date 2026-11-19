---
title: "A render pause written for a modal outlived it and froze the 2D map behind the Country Brief side panel"
date: 2026-11-03
category: ui-bugs
module: 2D map (DeckGLMap) and Country Brief (CountryIntelManager)
problem_type: ui_bug
component: tooling
severity: medium
symptoms:
  - "Desktop v2.11.7 (#10066): with a Country Brief open, toggling Pipelines checks the box but draws nothing on the 2D map"
  - "Closing the brief makes the map catch up at once"
  - "Data refreshes and marker animations also stop while the brief is open; the 3D globe and the SVG fallback are unaffected"
root_cause: logic_error
resolution_type: code_fix
related_components:
  - testing_framework
tags:
  - deck-gl
  - render-paused
  - country-brief
  - stale-guard
  - headed-drive
  - pixel-diff
---

# A render pause written for a modal outlived it and froze the 2D map behind the Country Brief side panel

## Problem

Opening a Country Brief paused the deck.gl renderer until the brief closed. The brief is a side panel with the map visible beside it. So every map change a user made while reading a brief was silently dropped. A layer toggled on looked empty, which reads as "this layer has no data here."

## Symptoms

- Layer checkbox and legend change state, but the map does not redraw.
- Two screenshots 1.5 s apart with the brief open are pixel-identical, so the whole 2D map is frozen, not just one layer.
- Only the deck.gl renderer is affected. `MapContainer.setRenderPaused` forwards to `deckGLMap` only, so the globe and SVG renderers never paused.

## What Didn't Work

- **Bounding the pause to the loading phase** was the approach the issue proposed. It keeps a mechanism whose reason no longer exists and adds request-ownership bookkeeping to unpause safely across aborted and superseded opens.
- **Raw pixel diff of the map region** as the repro signal. Animated markers changed about 8,000 pixels between frames with no toggle, which swamped the toggle signal. The clip also caught the layer list scrolling when a checkbox was clicked.
- **Headless Playwright in the current setup.** The repo's Playwright config and default headless Chromium render with SwiftShader, which `MapContainer.hasWebGLSupport()` rejects as software GL, so those runs mount the SVG map, which never paused. The check tests the GL renderer, not headless mode, so a hardware-accelerated headless run could reach deck.gl. A headed run on a real GPU is the reliable way to get there.

## Solution

Delete every brief-driven `setRenderPaused` call (PR #10084). That's seven in `src/app/country-intel.ts`, plus four brief error handlers in `src/App.ts` that existed only to undo the pause. The desktop hidden-tab pause in `src/app/event-handlers.ts` (`setRenderPaused(document.hidden)`) stays.

The DOM tests that recorded the pause sequence now assert it never happens, on the open, abort, supersede, coordinate-lookup, and failure paths:

```ts
// before: expect(renderPaused).toEqual([true, false]);
expect(renderPaused).toEqual([]);
```

## Why This Works

The pause came from "pause renders during modal" (2026-01), when the country view was `CountryIntelModal`, a full modal over the map, and deck.gl flickered behind it. The modal later became a side panel, but the pause stayed. `DeckGLMap.render()` sets `renderPending` and returns while paused, and `updateLayers()` returns early, so nothing the user did reached the GPU until close. Once the panel no longer covers the map, the right number of pauses is zero.

A side effect is fixed too. The brief error handlers called `setRenderPaused(false)` unconditionally. On desktop that could unpause a map the hidden-tab handler had paused.

## Prevention

- When a UI surface changes shape (a modal becomes a panel, an overlay becomes inline), grep for the side effects it triggers on the map (`setRenderPaused`, `clearCountryHighlight`, and similar) and ask whether each one still has a reason.
- To prove a deck.gl visual change, use a headed `verify-worldmonitor` drive (`WM_VERIFY_HEADED=1`) and a **stable-pixel diff**. Take two frames before the action and two after. Count a pixel only if it is unchanged within each pair and different between the pairs. Clip the region clear of the layer panel and the brief. In #10084 this read 807 changed pixels for a Pipelines toggle with no brief open, 0 with a brief open before the fix, and 862 after.
- CI cannot see deck.gl, so lock the contract at the call site instead. Assert the map API calls that manager code makes, as the `renderPaused` arrays in `tests/dom/country-intel-webmcp.test.mts` now do.

## Related Issues

- #10066 (report), PR #10084 (fix)
- [deck-gl-loop-stops-on-one-frame-error-leaving-stale-2d-layers.md](deck-gl-loop-stops-on-one-frame-error-leaving-stale-2d-layers.md) is the same "2D map shows stale layers" symptom from a different cause (deck's render loop stopping after one throwing frame).
