# Global search

The command palette is the dashboard's one search surface: countries, panels, hotspots, pipelines, nuclear sites and dashboard commands all resolve from the same box. It opens from the header, opens from ⌘K, ranks matches as the user types, and closes on Escape.

## Sub-features

- `search-open-button` opens the palette from the header `⌘K Search` button.
- `search-open-shortcut` opens it from ⌘K / Ctrl+K.
- `search-tips` shows the hint rows when the query is empty.
- `search-match` returns ranked entity and command matches for a typed query.
- `search-close` closes the palette on Escape without trapping focus.
- `search-mobile` opens the bottom sheet from `#mobileSearchBtn`.
- `search-headline-history` lists headlines the dashboard served earlier and no longer holds, fetched from the server for the typed query (24 hours signed out or free; on Pro up to 7 days, by language).

## How to get to it (user POV)

- Choose the `⌘K Search` button in the header.
- Press ⌘K (macOS) or Ctrl+K while focus is outside an editable field.
- On mobile, choose the search button in the bottom bar.

## Driving it with wm-verify

Preconditions:

- `wm-verify.sh doctor` reports OK.
- The dashboard has booted; the search index builds during boot.

- **Header entry.** Choose `⌘K Search`. Run `wm-verify.sh drive .agents/skills/verify-worldmonitor/steps/global-search.mjs --name global-search`. `#searchBtn` click makes `.search-modal .search-input` visible.
- **Empty state.** With no query the results list holds `.search-result-item.tip-item` hint rows (7 on this checkout) and zero real results.
- **Typed match.** Type `ukraine` with `pressSequentially`. `.search-modal .search-results .search-result-item[data-index]` becomes visible. Observed top results: `🇺🇦 Brief: Ukraine Country`, `⚔️ Ukraine War …`, `📍 Kyiv Conflict Zone Hotspot`, `☢️ South Ukraine Nuclear Power Plant`.
- **Relevance.** At least one result's text contains the query.
- **Escape.** Press `Escape`. `.search-modal` reaches hidden state.
- **Shortcut entry.** Press `Meta+k` (`Control+k` off macOS). The palette reopens with its input visible.
- **Proof.** `01-search-results.png` (the ranked list for the query) and `02-search-palette-via-shortcut.png`.
- **Headline history.** Run `wm-verify.sh drive .agents/skills/verify-worldmonitor/steps/headline-history-search.mjs --name headline-history` (add `WM_VERIFY_MOBILE=1` for the phone sheet). The loaded news is a fixed digest served by `page.route`; the drive scrolls World News into view, then types `hormuz`. A headline that is not in World News is listed with `<publisher> · <age>` under it, a headline that is both loaded and in the history is listed once, and a signed-out browser asks only `/api/news/v1/search-headlines`. Selecting the older headline opens its article in a new tab. By default the history answers are `page.route` fixtures; `WM_VERIFY_HEADLINE_LIVE=1` sends them to the dev server's real handlers, which need a Redis seeded for the run (a local stand-in, never production).

## Gotchas

- **`.search-result-item` alone is a vacuous assertion.** The empty palette already renders 7 tip rows with that class, so a drive that waits on `.search-result-item` passes without ever searching — that is exactly what happened on the first attempt here. Real matches are the only rows carrying `data-index`; tips carry `.tip-item`.
- Results are debounced. Wait for the first `[data-index]` row, never a fixed sleep.
- `fill()` sets the value in one shot; `pressSequentially` better matches a user typing and reliably drives the incremental index.
- Command rows also carry `data-index` (plus `data-command`). If a drive must isolate entity matches, exclude `.command-item`.
- Flight search rows are PRO-gated and will not resolve on an unauthenticated local run.
- The mobile sheet is a different DOM (`.search-sheet`, `.search-sheet-cancel`), not the desktop `.search-modal`.
- A news panel loads its items when it scrolls into view, and the search index reads the loaded news when the palette opens. A drive that searches without first bringing the panel on screen sees no loaded-news rows at all.
- History headlines arrive after the list first renders (one request about 250 ms after the typing pause). Wait for the row by its title; `.search-result-item[data-index]` alone resolves on the loaded rows.
- The phone sheet hides result subtitles except on history headlines (`.search-result-headline`), which keep publisher and age.
- The dev server runs RPC handlers without the gateway, so it answers `/api/news/v1/search-headline-archive` for anyone. Plan gating is proven by `tests/search-headlines-gateway.test.mts`, not by a local drive.
