---
title: Ordinary dashboard lists use the shared panel scrollport
date: 2026-11-05
module: Dashboard panels
component: Panel
problem_type: ui_bug
tags: [scrolling, panels, climate-news, css]
---

# Ordinary dashboard lists use the shared panel scrollport

The Climate News list capped itself at 380px with `overflow-y: auto` inside the
already scrollable `.panel-content`. This added an independent native scrollbar
that did not inherit the shared panel scrollbar styling. Expanding the panel did
not expand the list viewport. Other ordinary lists used the same pattern.

Keep vertical scrolling on `.panel-content`, which `Panel` already names and
makes keyboard focusable. List wrappers retain their padding, gaps, and cards;
height limits belong to the panel/grid. Horizontal table wrappers retain
`.table-scroll`, its focusability and overflow cues.

## Sweep findings

| Owning surface | Correction |
| --- | --- |
| Climate News | Remove the 380px list viewport. |
| Social Velocity, Disease Outbreaks | Remove inline 440px/420px list viewports. |
| Earnings Calendar, Economic Calendar, SEC Material Events | Remove inline 440px/480px list viewports; retain padding. |
| WSB Ticker Scanner | Remove the 480px vertical cap; retain the focusable horizontal table wrapper. |
| Internet Disruptions | Remove the 320px caps on outage/anomaly lists and DDoS content. |
| Oref Sirens history, Cascade countries, Strategic Risk alerts, Pinned Webcams overflow list | Remove secondary list caps; the shared panel body reaches these sections. |
| Economic indicators, Trade Policy, Supply Chain | Let tabs, `.economic-content`, and footers flow normally through the shared scrollport, without shrinking the tabs. |
| Deduct Situation | Remove the inner full-height scrollport so the form and result flow through the panel body. |

No changed list renderer consumes its own `scrollTop` or registers scroll-driven
pagination/virtualization. Feed loading, filtering, ordering, caching, and layout
persistence are unchanged.

## Scrollers retained after inspection

- `WatchlistTableView`, `.windowed-list`, and `.virtual-viewport` depend on their
  own scroll positions to render a window of rows. Removing their scrollports
  would break virtualization.
- Consumer Prices, grocery/price comparison tables, National Debt, and Tech Events
  deliberately divide a full-height view into controls and a scrolling body.
  These are different from an arbitrary capped list inside ordinary panel content.
- FX and other `.table-scroll` wrappers preserve horizontal table navigation and
  pinned columns. Their horizontal overflow can compute vertical overflow to
  `auto`; that alone does not prove a nested vertical viewport.
- Supply Chain's expandable scenario-evidence disclosure bounds a separate
  detailed evidence view. Country deep-dive tables and section navigation are
  on a separate report surface. They retain their independent scrolling.
- Panel summaries live beside the panel body. Drawers, dropdowns, modals, map
  popups, chat histories and Route Explorer are separate interaction surfaces.
- `.risk-countries` has no current component consumer; its unused styling is
  outside the demonstrated runtime problem.

## Verification and limits

`e2e/panel-vertical-scroll.spec.ts` mounts eight real panel renderers using
controlled RPC responses/public data setters. Secondary list selectors and the
Economic/Deduction wrappers use labelled CSS fixtures inside the real `Panel`
shell. The test checks short/tall panel heights at desktop and phone widths,
absence of nested vertical scrollports, keyboard/wheel scrolling, reaching the
last content, available collapse controls, and the retained horizontal table
wrapper. The fixture isolates panel geometry from maps and provider availability.

Run the existing dashboard layout/reorder tests separately to exercise the real
grid. This browser proof does not establish Windows WebView2 scrollbar appearance,
125%/150% Windows scaling, live provider refresh behavior, or production acceptance.
The Climate News translation action is a separate concern.

The existing grid-overlap check and backwards reorder check passed locally. The
Happy forwards-reorder and empty-bottom-zone persistence checks failed identically
on this branch and an unchanged `e08685453f88e326619d645ae3a96be2f2686303` source
snapshot (unchanged order; zero-height bottom drop zone). Those are baseline
failures, not verified acceptance for layout persistence.
