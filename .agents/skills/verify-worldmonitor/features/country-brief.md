# Country brief

The country brief (deep dive) is the per-country intelligence panel that slides in over the dashboard. A user reaches it from the map, from search, or from a shared link, and the link they share must reopen exactly that country.

## Sub-features

- `brief-deeplink` opens the brief for `?country=<ISO2>` on load; `&expanded=1` opens it maximized.
- `brief-content` renders the country's sections (heading, signal sections) rather than an empty shell.
- `brief-url-roundtrip` re-adds `?country=<code>` to the address bar while the brief is visible, so the URL stays shareable.
- `brief-close` closes the brief from `#deep-dive-close` and drops the parameter.
- `brief-context-menu` offers "Open country brief" from the map right-click menu.
- `brief-search` opens the brief from a `Brief: <country>` search result.

## How to get to it (user POV)

- Visit `/dashboard?country=UA` (the shareable link).
- Right-click a country on the map and choose `Open country brief`.
- Open the command palette and choose a `Brief: <country>` result.

## Driving it with wm-verify

Preconditions:

- `wm-verify.sh doctor` reports OK.
- No credential is needed; the brief renders from bundled and directly-fetched data.

- **Deep link.** Navigate to `/dashboard?country=UA`. Run `wm-verify.sh drive .agents/skills/verify-worldmonitor/steps/country-brief.mjs --name country-brief`. Exit code `0`.
- **Open state.** `#country-deep-dive-panel` reaches `aria-hidden="false"` with computed `visibility: visible`. Both matter — the panel is always in the DOM and slides in via transform, so attachment alone proves nothing.
- **Content.** `#deep-dive-content` holds 200+ characters of text and a heading. A `UA` run on this checkout reports a `Ukraine` heading with ~23 sections and ~2 000 characters.
- **URL round-trip.** Poll until `?country=UA` is back in `window.location`. Observed value includes the map state too: `?lat=…&lon=…&zoom=…&view=global&timeRange=7d&layers=…&country=UA`.
- **Close.** Choose the `×`. `#deep-dive-close` click returns the panel to `aria-hidden="true"`.
- **Proof.** `01-country-brief-open.png` and `02-country-brief-closed.png`, plus the transcript's content summary and post-open URL.

## Gotchas

- Reading `page.url()` immediately after the brief becomes visible finds NO `country` param and looks like a dropped deep link. `getShareUrl()` re-adds it only on the next debounced (250 ms) URL sync, and map-driven syncs compete with it. Poll for the parameter; do not assert once. This exact false positive was hit while writing this map.
- The brief opens after `DEEP_LINK_INITIAL_DELAY_MS` and its own retry loop, not at DOM ready. Wait on `aria-hidden`, not on boot.
- `visibility` is the honest open/closed signal. The panel keeps `right: 0px` in both states; only `transform` and `visibility` change.
- Section counts and body length vary run to run as data arrives. Assert a floor, log the number.
- Change the country with `WM_VERIFY_COUNTRY=<ISO2>`; the code is upper-cased and must resolve to a known country name.
