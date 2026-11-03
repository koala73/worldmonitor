---
title: "One throwing deck.gl frame stops the render loop for good, so unchecked 2D layers stay drawn"
date: 2026-10-25
category: ui-bugs
module: 2D map (DeckGLMap, deck.gl interleaved overlay) and Sentry error filtering
problem_type: ui_bug
component: tooling
severity: high
symptoms:
  - "Desktop v2.11.4 (#9653): red/orange markers stay on the 2D map after every layer checkbox is off, through pans and zooms"
  - "Only a 2D -> 3D -> 2D renderer switch clears them; the bug is intermittent and survives an app restart"
  - "Clicking a stranded marker selects the country polygon underneath, because the layer is no longer pickable in deck's own state"
  - "Console shows one `[DeckGLMap] Render error (non-fatal): ...` line and nothing in Sentry"
root_cause: async_timing
resolution_type: code_fix
related_components:
  - testing_framework
tags:
  - deck-gl
  - luma-gl
  - maplibre
  - animation-loop
  - stale-layers
  - sentry
  - beforesend
---

# One throwing deck.gl frame stops the render loop for good, so unchecked 2D layers stay drawn

## Problem

On the 2D map, layers the user turned off could stay drawn indefinitely (#9653). One error thrown inside a deck.gl frame stops deck's animation loop permanently. deck then never commits another layer list, while MapLibre keeps repainting the last one it committed.

## Symptoms

- Unchecked layers remain visible and move with the map through pans and zooms.
- The legend and checkboxes are correct. Only the canvas is stale.
- A 2D/3D switch fixes it because it destroys and rebuilds the whole deck instance.
- The only trace was a console warning labelled "non-fatal".

## What Didn't Work

- **Suspecting the layer factory.** The report pointed at `createClimateHeatmapLayer` (`pickable: false`). That only explains why clicks select the polygon underneath. The layer code was correct, and the same freeze affects every layer.
- **Suspecting the swallowed `catch` in `updateLayers()`.** `setProps` did run. deck stores the new list in `_nextLayers` and applies it only on its own loop tick (`node_modules/@deck.gl/core/src/lib/deck.ts:1819`, `this.layerManager!.updateLayers()` inside `_onRenderFrame`).
- **Pixel-diff verification at first.** Several unrelated changes polluted on/off screenshot diffs: `flashLocation` (`src/components/DeckGLMap.ts:8238`) draws 40px 50%-white DOM circles for 2 s where breaking news lands; the layers panel scrolls inside the map canvas box; weather radar tiles and the hotspot pulse (after 60 s uptime) differ between runs. These circles also set `pointer-events: none`, so `document.elementsFromPoint` does not see them.
- **Wrapping the Sentry report in a new Error with `cause`.** The SDK puts the original error last and its causes first in `exception.values` (`@sentry/core` `aggregate-errors.js`), so `beforeSend` reads the cause as `values[0]` and the vendor-stack rules still drop it.

## Solution

Fix opened in PR #9660 (unmerged as of 2026-10-25).

1. The idle-aware frame provider reports whether a frame is pending (`src/utils/idle-aware-frame-provider.ts:80`). A running luma loop always has its next frame requested.
2. `createDeckLoopRecovery` (`src/components/map/deck-loop-recovery.ts`) runs after each deck `onError` (`src/components/DeckGLMap.ts:1446`). On a microtask, after luma has unwound, it checks for a pending frame. None means the loop is dead, and it calls `restartDeck` (`src/components/DeckGLMap.ts:1452`):

   ```ts
   private restartDeck(error: Error): void {
     if (!this.maplibreMap) return;
     reportDeckLoopStop(error, 'restart');
     // A finalized deck.gl layer cannot join a new Deck.
     this.layerCache.clear();
     this.deckOverlay?.finalize();
     this.deckOverlay = this.createDeckOverlay();
     this.maplibreMap.addControl(this.deckOverlay as unknown as maplibregl.IControl);
     this.render();
   }
   ```

   Three restarts inside 60 s, or a restart that throws, call `giveUp`, which reports and hands off to the existing SVG fallback through `onFatalError`.
3. `reportDeckLoopStop` (`src/components/DeckGLMap.ts:599`) tags the Sentry event `kind: 'deck_loop_stopped'`. `beforeSend` keeps a claimed event at one early branch (`src/bootstrap/sentry-init.ts:463`) and still runs non-production isolation and credential scrubbing. Without it, six vendor-stack rules drop exactly these errors, because their frames are all in `deck-stack`/`maplibre` chunks.

## Why This Works

luma.gl 9.4's `AnimationLoop._animationFrame` (`node_modules/@luma.gl/engine/src/animation-loop/animation-loop.ts:364`) catches a frame throw, calls `onError`, then `stop()`. It cannot be restarted in place, because `redraw()` returns early forever once `_error` is set. deck runs hover picking (`readPixels`) and our `getTooltip` inside that frame, so a GPU read failure or a throwing tooltip kills it. MapLibre's interleaved render path still calls deck's draw on every repaint, using the last committed layers, which is why the stale layers follow pans and zooms.

The recovery reads loop liveness from a signal the app owns (pending frames in its own frame provider) instead of luma's private `_running`/`_error`. Layer errors and async picking errors leave a frame pending, so they never trigger a restart. A rebuilt overlay is the same thing the 2D/3D switch did. The layer cache must be cleared first: deck asserts a finalized layer cannot be reused (`node_modules/@deck.gl/core/src/lib/layer.ts:972`).

## Prevention

- Treat any deck `onError` without a `layer` argument as possibly fatal. Under luma 9.4 a frame-level error stops the loop.
- Reproduce with a scripted trigger: an init script wraps `WebGL2RenderingContext.prototype.readPixels` to throw once when a window flag is set, then the test hovers the map and unchecks Conflict Zones (large polygons; Military Bases is invisible at global zoom). Hide `.flash-location-marker`, turn off every other layer, and clip the diff to the right of the layers panel. With that setup, removing Conflict Zones changed 2.78% of map pixels; the frozen loop changed 0.60%.
- A first-party Sentry report about vendor-chunk errors must claim `tags.kind`, and needs a `tests/sentry-beforesend.test.mjs` case for both the claimed and unclaimed shape.
- Tests: `tests/deckgl-loop-recovery.test.mts` drives the recovery over the real frame provider with a luma-like loop (stop on throw, keep running on layer error, budget, restart that throws).
