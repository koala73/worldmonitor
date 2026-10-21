---
title: A layout breakpoint is encoded in more places than it is defined
date: 2026-08-25
category: architecture-patterns
module: split-layout
problem_type: architecture_pattern
component: frontend
severity: high
applies_when:
  - "Changing a viewport/layout threshold (a breakpoint, a min-width gate, a split-vs-stacked switch)"
  - "Unifying two thresholds that previously differed per platform (web vs desktop app)"
  - "Auditing why a class-applied CSS block duplicates a media query"
tags: [breakpoint, media-query, split-layout, e2e, css-drift, tauri]
---

# A layout breakpoint is encoded in more places than it is defined

## Context

Issue #6417 (implemented in PR #7165, open as of this writing) moved the dashboard's split-layout threshold from 1600px (web) / 900px (desktop) to a single 900px constant. The threshold turned out to be *encoded* in far more places than it was *defined*: nine TS/CSS literals, an entire duplicated CSS block, an e2e viewport table, and localStorage key semantics. Each encoding looked independent, and one of them (the 900/1600 split in `panels.css` vs `panel-layout.ts`) had already produced a shipped drift bug — #6426, where saved bottom-zone panels vanished for desktop windows in the 900–1599px band.

The expensive discoveries were the encodings that did not *mention* the number:

- **A class-applied CSS block duplicating a media query.** `.main-content.desktop-grid { ... }` re-stated the whole split layout so the desktop app could get it below the web's 1600px gate. Once the thresholds unified at 900px, the block became provably dead: the Tauri window minimum width (1200, `src-tauri/tauri.conf.json`) keeps the desktop app inside the `@media (min-width: 900px)` query at all times. The duplicate had also been *masking* an inconsistency — a zoomed desktop webview below 900 CSS px kept the class-driven split while the JS zone logic (`getEffectiveUltraWide()`) had already switched to stacked.
- **An e2e viewport table that encoded the breakpoint as behavior, not as a number.** `e2e/dashboard-news-request-budget.spec.ts` pinned viewport→scroll-owner pairs (`1280px → 'main-content'`). Nothing greps for "1600" there; the old threshold lived in the *expectation* that 1280px is a stacked layout. CI went red only after the change shipped to the PR.

## Guidance

When changing a layout threshold, sweep every **encoding**, not every **occurrence of the number**:

1. **Define it once** in a zero-import TS module (`src/app/split-layout.ts`, `SPLIT_LAYOUT_MIN_WIDTH`) and make every TS site reference it.
2. **CSS cannot import it** — media queries keep literals. Pin them with an alignment test that imports the constant and asserts the CSS text (`tests/responsive-zone-listener.test.mjs` asserts the `@media (min-width: 900px)` gate, the `(max-width: 899px)` hide, the grid-track floors, and that no `1600` survives in the runtime files).
3. **Audit class-applied CSS blocks that duplicate a media query.** They exist to serve a platform the media query excluded; after a threshold change, check whether the platform is still outside the query. If the platform's window floor (Tauri `minWidth`) now sits inside it, the class block is dead — delete it and its JS class, and add a `doesNotMatch` guard so it stays deleted.
4. **Sweep e2e specs for viewport tables.** Search `e2e/` for `setViewportSize` and viewport→expectation tables; any viewport between the old and new thresholds changes layout mode, and expectations like scroll owner (`main-content` stacked vs `panels-grid` split) flip. Keep a case on each side of the new threshold so both modes stay covered.
5. **Check threshold-conditional state.** Storage keys written per-mode (`map-height` vs `map-split-height`), settings-export prefix lists, and zone-reconciliation listeners all branch on the same predicate — moving the threshold moves which users hit which branch.

## Why This Matters

A threshold defined in one place but encoded in many is the exact shape that produced #6426: two encodings drifted 700px apart and silently hid user panels for an entire viewport band. Encodings that don't contain the number (viewport tables, duplicated class blocks, mode-scoped keys) are invisible to a literal grep, so they surface as CI reds or field bugs after the "complete" change. The constant-plus-alignment-test structure converts future drift from a field bug into a test failure at the PR gate.

## When to Apply

- Any change to a `@media (min-width/max-width)` gate that JS also branches on
- Unifying or splitting per-platform thresholds
- Deleting or adding a platform-specific layout class (`desktop-grid`-style) — first prove the platform's window bounds against the media query it duplicates

## Examples

The e2e encoding that did not contain the number (failed CI on PR #7165 until updated):

```ts
// e2e/dashboard-news-request-budget.spec.ts — the OLD threshold lived in
// this expectation, not in any "1600" literal:
{ label: 'desktop', width: 1280, height: 720, scrollOwner: 'main-content' } // pre-#6417
{ label: 'desktop', width: 1280, height: 720, scrollOwner: 'panels-grid' }  // post-#6417
{ label: 'narrow-desktop', width: 850, height: 720, scrollOwner: 'main-content' } // keeps the stacked side covered
```

The dead-block proof (why `.desktop-grid` could be deleted):

```
Tauri window minWidth = 1200  >=  SPLIT_LAYOUT_MIN_WIDTH = 900
=> the desktop app always matches @media (min-width: 900px)
=> every rule in .main-content.desktop-grid { ... } is shadowed
```

## Related

- #6417 (feature), PR #7165 (implementation), #6426 (the drift bug this structure closes off)
- [verification-grep-must-cover-every-file-type-it-claims](../conventions/verification-grep-must-cover-every-file-type-it-claims.md) — the same root cause shape: a value duplicated across file types, where the sweep must enumerate every encoding surface
- [deleting-a-parameter-doesnt-delete-the-branch-it-used-to-select](../conventions/deleting-a-parameter-doesnt-delete-the-branch-it-used-to-select.md) — the inverse audit: a change silently killing or activating a branch elsewhere
- [desktop-cls-immediate-tier-panel-mounts-need-deferred-shells](../performance-issues/desktop-cls-immediate-tier-panel-mounts-need-deferred-shells.md) — same dashboard layout surface; watch field CLS after breakpoint changes
