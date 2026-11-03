---
title: "Panel resize strips wider than the content padding took clicks from the news translate button"
date: 2026-10-27
category: ui-bugs
module: src/styles/main.css
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - "In a non-English UI, the right part of the headline translate button in clustered news rows starts a width resize instead of translating"
  - "The cursor flips to ew-resize over the right edge of the button while the button is still visible under it"
  - "At scroll end, the bottom of the last news row starts a height resize"
root_cause: logic_error
resolution_type: code_fix
severity: medium
related_components:
  - testing_framework
tags: [resize-handle, hit-test, element-from-point, pointer-events, panel-content, cluster-meta, translate-button, pseudo-element, subpixel]
---

## Problem

Every dashboard panel gets two resize strips from `Panel`: `.panel-col-resize-handle` on the right edge and `.panel-resize-handle` on the bottom edge. Both were 20px, absolutely positioned at `z-index: 100`. `.panel-content` has only 8px of padding, so each strip covered 12px of real content in every panel. Reported in #9729, fixed in PR #9736.

## Symptoms

- Clustered news rows lay out `.cluster-meta` with `justify-content: space-between`, which pins the `文` translate button to the content's right edge. The width strip took 13 of the button's 17 pixel columns. Flat rows were unaffected for this button because their `文` sits right after the timestamp, on the left.
- At scroll end the height strip took 319 of 391 pixels of the last clustered row's button, and 85 of 391 of the last flat row's.
- The fault was not news-specific. The before screenshot on PR #9736 shows the width strip also covering the end of the "EINZELNER VERLEGER" source badge.

## What Didn't Work

- **The live dashboard as the repro surface.** Locally it rendered no news items, so there was no `文` button to measure. Mounting a real `NewsPanel` on `tests/runtime-harness.html` with fixture items gave a deterministic repro.
- **An 8px strip, flush with the padding.** It removed all but one column per button. Chromium's hit test gave the shared boundary column to the strip even though the measured rects only touched (`content right = strip left = 310.19`). A 6px strip leaves 2px of slack and lost nothing at 1x, 1.25x, 1.5x and 2x device scale.
- **Shrinking the strip and adding only `pointer-events: none` to the grip glyphs.** The `⋮` and `⋯` glyphs kept their old offsets (`right: 3px`, `bottom: 2px`), so their ink sat 1 to 3px left of the 6px width strip and 6 to 8px above the height strip. A user aiming at the visible grip missed the drag target. CodeRabbit flagged it on the PR, and pixel measurement confirmed it at every scale.

## Solution

`src/styles/main.css`:

```css
.panel-resize-handle {
  /* Stays inside .panel-content's 8px padding, with room for subpixel hit-test rounding,
     so the strip never covers content (#9729). */
  height: 6px;            /* was 20px */
}
.panel-col-resize-handle {
  width: 6px;             /* was 20px */
}
.panel-resize-handle::after,
.panel-col-resize-handle::after {
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  line-height: 1;
  pointer-events: none;   /* the glyph box must not extend the hit area */
}
```

The tradeoff is a 6px grab target instead of 20px. The cursor change and the centered grip glyph keep it discoverable. Keeping 20px would have meant 12px more padding in every panel, which costs narrow panels content width.

## Why This Works

An overlay control sitting above content is safe only if its hit area stays inside the content's padding gutter. The strip was 20px against an 8px gutter, so the overlap followed from the two numbers alone. Any right-aligned control was covered, whichever panel it was in. Sizing the strip below the padding removes the overlap for every panel at once. A z-index fix could not work here: `.panel-content` has `contain: layout style`, which makes it a stacking context, so nothing inside it can be raised above a sibling strip without also raising the whole content box over the strip.

## Prevention

- `e2e/news-panel-resize-hit-target.spec.ts` sweeps `document.elementFromPoint` over every pixel of each `文` button, in clustered and flat rows and at scroll end. It also real-clicks the button's right edge, drags the strip to confirm resizing still works, and hit-tests the centroid of each grip's ink.
- To locate a pseudo-element's visible ink, which has no `getBoundingClientRect`, paint it a unique color (`#ff00ff`), hide the parent's background, screenshot a clip, and scan the pixels with `OffscreenCanvas` in the page. The centroid is a point a user would aim at.
- Headless Chromium on macOS uses overlay scrollbars, so `.panel-content` reserves 0px for its scrollbar there. Windows reserves 4px (`.panel-content::-webkit-scrollbar { width: 4px }`). Gutter math checked only on a Mac is the tighter case, not the Windows one.
- When adding an absolutely positioned control over panel content (handles, badges, corner buttons), keep its hit area at least 1 to 2px inside `.panel-content`'s padding. Assert that with an `elementFromPoint` sweep, not with a presence or class check. The same lesson for overlays appears in [settings-discard-confirm-stacked-behind-settings-overlay.md](settings-discard-confirm-stacked-behind-settings-overlay.md).
