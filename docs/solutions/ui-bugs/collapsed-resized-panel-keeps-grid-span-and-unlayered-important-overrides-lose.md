---
title: "A collapsed resized live panel kept its grid rows, and unlayered !important overrides cannot beat main.css"
date: 2026-11-05
category: ui-bugs
module: src/styles/main.css
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - "Collapsing a user-resized Live News or Live Webcams panel left a large empty black area; panels below did not move up"
  - "Dragging the bottom resize handle of the collapsed panel changed the size of the empty area, not the panel"
  - "An !important override injected into the live page (style tag or adoptedStyleSheets) matched the panel with higher specificity and still had no effect"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [css-cascade-layers, layer-base, important, grid-row, panel-collapse, panel-resize, live-news, live-webcams]
---

# A collapsed resized live panel kept its grid rows, and unlayered !important overrides cannot beat main.css

## Problem

Issue #10185: on the desktop dashboard, a Live News or Live Webcams panel that the user had resized kept its full grid footprint after being collapsed. The panel box shrank to its header, but the rows it had reserved stayed empty. Fixed in PR #10188.

## Symptoms

- Production probe at 1600×900: a resized `span-4` Live News panel collapsed to a 39px box, with a 777px gap to the next panel. A collapsed panel that was not resized had a 165px gap, which is one grid row.
- Collapsed and expanded, the panel's computed `grid-row-start` was `span 4`.
- The resize handle stayed visible right under the header, and drags or arrow keys still changed the saved span.

## What Didn't Work

- Testing the fix by adding a `<style>` tag to the live page, and then a constructed stylesheet through `document.adoptedStyleSheets`. Each injected `#panelsGrid > .panel[data-panel="live-news"].panel-collapsed { grid-row: span 1 !important }`. Listing the matched rules showed the injected rule matched and had higher specificity than `.panel.span-4`, but `span 4` still won. The cause is cascade layers, not CSP or specificity. See below.

## Solution

Two rules in `src/styles/main.css`:

```css
/* main.css:2038 — every collapsed video panel takes one row, resized or not */
@media (min-width: 769px) {
  .panel[data-panel="live-news"].panel-collapsed,
  .panel[data-panel="live-webcams"].panel-collapsed {
    grid-row: span 1 !important;
  }
}

/* main.css:2603 — no row resizing while collapsed */
.panel.panel-collapsed > .panel-resize-handle {
  display: none;
}
```

The old #8276 collapse rule excluded `.resized` and `.span-1`…`.span-4` and had no `!important`. It never applied to a resized panel, so `.panel.span-N { grid-row: span N !important }` (main.css:1917–2061) won. The collapsed selectors apply in both `#panelsGrid` and `#mapBottomGrid`, including the toolbar-hiding rules. The fix keeps the `resized span-N` classes, so expanding restores the saved size, and the persisted spans are left alone.

Regression test: `e2e/live-panel-layout-8276.spec.ts:180`. It resizes each video panel to span 4 with the keyboard separator (`End`), then collapses it. It asserts `span 1`, a non-negative gap to a panel below, and a hidden handle. Then it reloads while collapsed, expands, and asserts `span 4` / 812px. A bottom-grid case seeds the saved layout and checks both panels reserve one row and hide their toolbars and handles while collapsed, including after reload; expanding restores span 4 and the controls.

## Why This Works

`src/styles/base-layer.css:8` imports all of main.css (and header.css, country-deep-dive.css, and the others listed there) with `layer(base)`. For author-origin `!important` declarations, the cascade-layer order is reversed: an `!important` in a layer beats an unlayered `!important`, whatever their specificity. User-origin `!important` and running transitions sit above both. So:

- Inside main.css, the fix is a normal specificity contest. The attribute-based collapse rule with `!important` beats `.panel.span-N !important`.
- Outside the layer (a page-injected style from DevTools or Playwright, or any author stylesheet not imported through `base-layer.css`), an unlayered author `!important` rule cannot beat a layered author `!important` rule. To test a patch on the live page, wrap it in `@layer base { … }`. That reproduced the fix: `span 1`, a 165px gap, and `span 4` again after expanding.

## Prevention

- When a live-page CSS probe "has no effect", list the rules that match the element before blaming specificity or CSP. Then wrap the probe in `@layer base { … }` so it competes in the same layer as main.css.
- A guard that excludes user-resized states (`:not(.resized)`) makes sense for expanded layout rules. Don't copy it onto a collapsed-state rule, because collapsing has to override the user's size.
- When content is hidden, hide the controls that change it too. A resize handle on a collapsed panel changes saved state the user can't see.

## Related Issues

- #8276: natural wide-panel footprint and the original collapse rule.
- `docs/solutions/ui-bugs/shared-table-base-style-strips-cell-state-colours-and-revives-dead-rules.md`: another main.css specificity trap. Its rules also live in files imported by `base-layer.css`.
