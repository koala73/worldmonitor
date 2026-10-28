---
title: "An on-load modal masked a stale map-harness golden for months"
date: 2026-10-28
category: test-failures
module: map-harness-visual-goldens
problem_type: test_failure
component: testing_framework
severity: medium
symptoms:
  - "Removing a modal that opened on page load turned visual-goldens red on a PR that changed no map rendering"
  - "toHaveScreenshot reports only layer-full-conflicts-z4.png at a 0.14 diff ratio; the remaining scenarios are never compared"
  - "The actual frame shows the vector basemap and country-shaped conflict zones; the golden shows a blank background and a fixture rectangle"
root_cause: test_isolation
resolution_type: test_fix
related_components: [development_workflow]
tags: [visual-goldens, playwright, toHaveScreenshot, map-harness, modal-overlay, maxDiffPixelRatio, expect-soft, layer-performance-notice]
---

# An on-load modal masked a stale map-harness golden for months

## Problem

PR #9784 stopped the map's "Performance notice" from opening on every page load. The full variant starts with 13 layers, and `enforceLayerLimit()` in `src/components/DeckGLMap.ts` and `src/components/GlobeMap.ts` warned at `>= 13` while treating its first count (from a baseline of `0`) as an increase. The product fix was small. The surprise came from `visual-goldens` in `.github/workflows/e2e-visual.yml`, which went red on `layer-full-conflicts-z4.png` with a 14% pixel diff.

## Symptoms

- Only one scenario failed, `conflicts-z4`, the first in `VISUAL_SCENARIOS` (`src/e2e/map-harness.ts`).
- `main` passed the same test locally, and the branch failed it, deterministically.
- The actual frame showed the OpenFreeMap vector basemap, its attribution, and conflict zones drawn as country outlines (Ukraine, Iran). The golden, last re-recorded in February 2026, showed a blank background and a single fixture rectangle.

## What Didn't Work

- **Assuming the golden had the overlay baked in.** Opening the golden showed no dimming and no dialog, which ruled this out.
- **Assuming deterministic mode was off.** In isolation the harness body class and styles were present. `hideRasterBasemap()` only zeroes the opacity of the raster `carto-dark-layer`, so any vector basemap present stays visible. The attribution was a red herring.

## Solution

The control experiment settled it. With `main`'s `DeckGLMap.ts` swapped into the dev server, the harness page loads with 31 layers checked, so the notice opens. `.layer-warn-overlay` then dims and blurs the whole map. Every element screenshot of `.deckgl-map-wrapper` came out near-uniform dark, close enough to the stale golden's dark background to pass `maxDiffPixelRatio: 0.04` in `e2e/map-harness.spec.ts`. Removing the notice exposed the real scene, which had drifted since February.

1. Enumerate every mismatch before touching baselines. `toHaveScreenshot` is a hard assertion, so the loop stops at the first failure. Temporarily switch it to `expect.soft(...)`, run the full and tech variants, then revert. Here only `layer-full-conflicts-z4.png` was stale. The other 25 full scenarios and all 29 tech scenarios still matched.
2. Re-record only that golden with `--update-snapshots`.
3. Prove the macOS-recorded golden will pass on CI's Linux runner. The new golden is a local render, so compare a local render against CI's: copy CI's `*-actual.png` from the failed run's artifact over the golden, run the test, then restore the new golden. It passed, so local and CI renders agree within the threshold. This holds only while the local render is deterministic. Confirm with two consecutive local runs against the new golden. The CI run on the pushed golden is the final proof.
4. Fix the harness tests that encoded the bug. The warning-copy test now asserts no notice on load and opens it by re-adding a layer, which fails on `main`. The bases-viewport test no longer clicks a "Got it" button that never appears.

## Why This Works

A full-viewport overlay changes every pixel the screenshot sees and lowers its contrast, so the per-pixel threshold and the 4% ratio stop telling scenes apart. The suite kept passing because the screenshots all looked alike, not because the scenes matched. Once the overlay was gone, the comparison measured the map again.

## Prevention

- Before re-recording any golden, take an element screenshot of the harness at load and check that no modal, toast, or overlay is open. An overlay that covers the screenshot target (here `.deckgl-map-wrapper`) when goldens are recorded or compared can mask scene differences, as the dimming notice did.
- When one scenario fails, enumerate all of them with `expect.soft` before deciding the scope of a re-record.
- Check a regenerated golden against the CI runner's actual image, not only against a local re-run.
- Related layer-notice behaviors that PR #9784 pinned with DOM tests in `tests/dom/deckgl-map-state.test.mts`: the starting layers are a baseline; a bulk `setLayers` rebases the count without notifying; rows an active layer search hides still count, because the count skips only toggles marked `data-layer-hidden`.

## Related

- `docs/solutions/test-failures/cri-golden-baseline-env-pinning-trap.md`, a different way a golden baseline stopped testing what it claimed to.
