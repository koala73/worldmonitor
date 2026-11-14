# Satellite passes here

Right-click or long-press any point on the map, land or ocean, and choose **Satellite passes here**. A sheet docks beside the map (a bottom sheet on phones) and answers which imaging satellites passed over that point, which of those passes have a public image, and what is coming next. The picked point stays in the browser. Only the public archives see it.

## Sub-features

- `entry` adds the context-menu item on the flat deck.gl map and the globe. It needs only the point, not a country.
- `progress` shows pass computation, then archive answers counted out of five (Earth Search, Planetary Computer, GIBS daily mosaics, GIBS geostationary, EUMETSAT).
- `tiers` gives every row its tier as text: checking archive, confirmed image, likely imaged, upcoming pass, in daily mosaic, weather frame, within reach, passed overhead, capability overhead, unavailable.
- `credits` puts each source credit under its image, plus the NASA GIBS acknowledgement when a GIBS image is shown.
- `partial` names the archive that failed and offers Retry. `stale` shows the orbit-data age. `empty` explains the searched window.
- `privacy` keeps a one-line "Point stays in your browser · How ›" disclosure in every state.

## How to get to it (user POV)

- Right-click the map, or long-press it on a touch screen, and choose **Satellite passes here**.
- Close with the X or Escape. Focus returns to `#mapContainer`.

## Driving it with wm-verify

Run `wm-verify.sh drive .agents/skills/verify-worldmonitor/steps/orbital-watch.mjs --name orbital-watch`. Set `WM_VERIFY_ORBITAL_VIEWPORT=mobile` for the 390px bottom sheet. The step stores the globe map mode, because headless Chromium has only software GL and `MapContainer` keeps deck.gl off it. Use `WM_VERIFY_HEADED=1` on a machine with a GPU to drive the flat map.

The step serves `/api/orbital/v1/list-imaging-satellites` from `tests/fixtures/orbital/celestrak-gp-2026-11-13.json` and lets archive requests reach the real archives. It holds them to capture the checking state, fails Earth Search for the partial state, marks the catalog stale, and for the empty state serves an empty catalog and empty archive answers (no scenes, empty GIBS time domains). Set `WM_VERIFY_ORBITAL_CATALOG=live` to read the local API instead. Fixture orbits drift with time, so far from 2026-11-13 the pass list shrinks.

It fails if any request to a non-archive host carries the picked point, if an archive request carries it in its URL path rather than its query or body, and if an archive image becomes the largest contentful paint.

## Proof limits

- The point check covers requests the page makes. Sentry breadcrumb scrubbing is covered by `tests/orbital-privacy.test.mts`, because the dev server does not start Sentry.
- DebugBear RUM loads only on production hosts. Its request-window wait is covered by `tests/debugbear-rum.test.mts`. Crops cannot become the LCP element because the sheet opens only after a user input, which ends LCP.
- Live imagery varies. The fixture proves the states, not a specific scene.

Handles: `.orbital-watch-sheet`, `.ow-headline`, `.ow-group-toggle[aria-expanded]`, `.ow-row`, `.ow-tier-label`, `.ow-row-image figcaption`, `.ow-banner-partial`, `.ow-banner-stale`, `.ow-empty`, `.ow-privacy`, `.ow-retry`.
