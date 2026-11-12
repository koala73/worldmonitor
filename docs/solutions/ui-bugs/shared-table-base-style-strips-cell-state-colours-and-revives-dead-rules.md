---
title: "A shared table base style stripped cell state colours, and lowering its specificity revived dead rules"
date: 2026-11-04
category: ui-bugs
module: src/styles/panels.css
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - "After moving FX and BTC ETF tables onto the shared .wm-table style, gain/loss, ticker and dimmed cells rendered in the plain cell colour"
  - "After lowering the base to :where(), Climate Anomalies deltas and Displacement/UCDP cells picked up colours their class rules had never shown"
  - "FAO food price product names (<th scope=\"row\">) rendered uppercase and muted like column headers"
  - "Inline-styled tables kept their own header and cell look after gaining the wm-table class"
root_cause: logic_error
resolution_type: code_fix
severity: medium
related_components:
  - testing_framework
tags: [css-specificity, where-selector, wm-table, panel-tables, state-colours, row-header, inline-style, cascade]
---

## Problem

Panel tables (42 `<table>` templates in 26 component files) each carried their own header and cell rules; an audit of the 23 visible ones found 15 distinct styles. Consolidating them onto one `.wm-table` base in `src/styles/panels.css` (PRs #10128, #10129, #10130, #10131) hit four cascade traps. None showed up in a source-level scan; each needed a rendered check.

## Symptoms

- The first base, `.wm-table td { color: var(--text-secondary) }` at (0,1,1), outranked single-class state rules on cells: `.change-positive`, `.change-negative`, `.etf-ticker`, `.fx-na` (0,1,0). 17 FX and ETF cells lost their colour.
- Lowering the base to `:where(.wm-table) td` (0,0,1) fixed that, but class rules that used to lose to each panel's own `.X td` rule (0,1,1) now won. Climate Anomalies deltas went from grey to coloured. `.disp-round`, `.ucdp-date` and `.ucdp-actors` colours resurfaced.
- `:where(.wm-table) th` styles every `th`, including `<th scope="row">` in a body row. The FAO product names became 10px uppercase muted text. The first fix, a descendant `:where(.wm-table) tbody th` reset, then also matched the column headers of a table nested in a body row: an expanded Stock Analysis watchlist row holds the insider table inside the outer `tbody` (found in review on #10131). Child combinators scope the reset to the table's own rows.
- Five tables (Economic Calendar, Sector Heatmap valuations, Stock Analysis insiders, WSB tickers, Yield Curve) set their header and cell style through inline `style=` attributes. An inline style outranks every stylesheet rule, and `<tr style="font-size:…">` changes the cells by inheritance. The class-rule scan never saw them.
- One table's rules lived in `src/styles/supply-chain-panel.css`, imported by `base-layer.css:12`. The first scan read only `panels.css` and `main.css`.

## What Didn't Work

- Scanning stylesheets for `.X th` / `.X td` redeclarations. It proved the copies were gone, not that the rendered cells looked right. It could not see the specificity inversion, the revived rules, row headers or inline styles.
- Checking only the target properties (font size, padding) after the `:where()` switch. The revived colours were on properties the migration never touched.

## Solution

Base rules below class specificity, with row headers reset to body-cell style (`src/styles/panels.css:107-139`):

```css
.wm-table { width: 100%; border-collapse: collapse; font-size: calc(11px * var(--wm-panel-effective-scale, 1)); }
:where(.wm-table) th { padding: 4px 8px; border-bottom: 1px solid var(--border); color: var(--text-muted);
  font-size: calc(10px * var(--wm-panel-effective-scale, 1)); font-weight: 600; letter-spacing: 0.04em;
  text-align: start; text-transform: uppercase; }
:where(.wm-table) td,
:where(.wm-table) > tbody > tr > th { padding: 5px 8px; border-bottom: 1px solid var(--border-subtle); color: var(--text-secondary); }
/* A row header (<th scope="row">) is a body cell, not a column header. */
:where(.wm-table) > tbody > tr > th { font-size: inherit; font-weight: inherit; letter-spacing: normal; text-transform: none; }
```

Each revived rule was decided one by one. Dead declarations were deleted (`.disp-round`, `.ucdp-*` colours). Intended behaviour was kept and fixed: the Climate deltas got a light-theme `--semantic-low-text` shade for contrast. Inline row and cell styles moved to classes. Alignment and computed state colours (P/E bands, buy/sell) stayed inline.

## Why This Works

`:where()` contributes zero specificity, so the base sits at element level (0,0,1). Any class on a cell (0,1,0) overrides it, which is exactly the contract a shared base needs: panels keep state colours and alignment without fighting the base. The same property is why previously shadowed class rules come back to life. The old per-panel `.X td` rules were the only thing hiding them, so removing those rules exposes every class rule underneath.

## Prevention

- `tests/panel-table-style.test.mjs` requires `wm-table` on every panel `<table>`. It also requires the `:where()` selectors, including the row-header reset `:where(.wm-table) > tbody > tr > th`, and rejects `.wm-table th/td` rules. It reads every `src/styles/*.css` (`STYLESHEETS`, line 38). It fails on inline `<tr|th|td style>` declarations of shared properties, including styles interpolated from a same-file string constant (`rows and cells carry no inline shared style`, line 100).
- `e2e/panel-table-overflow.spec.ts` mounts the tables, on the fixture dashboard and in the runtime harness, and asserts computed header and cell styles. `readLostColours` (line 236) renders a probe cell with the same classes in a plain table and fails when the real cell shows a different colour. That is what caught the 17 stripped cells.
- When lowering a shared rule's specificity, diff the computed colour of every cell in every migrated table, not only the properties being consolidated.
- Align shared header cells with `text-align: start`, not `left`. Body cells default to `start`, so a physical `left` on the headers puts them on the opposite side of their columns in right-to-left layouts.
- A generic `th` rule needs a row-header counterpart whenever any table uses row headers. Scope it with child combinators (`> tbody > tr > th`), because tables nest inside expandable rows.
