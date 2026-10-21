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

For strict prediction-market acceptance, use the Playwright flow below. The manual
drive checks navigation and panel availability; its body-length check does not
prove that a dataset is correct.

Preconditions:

- `wm-verify.sh doctor` reports OK.
- No credential is needed; the brief renders from bundled and directly-fetched data.

- **Deep link.** Navigate to `/dashboard?country=UA`. Run `wm-verify.sh drive .agents/skills/verify-worldmonitor/steps/country-brief.mjs --name country-brief`. Exit code `0`.
- **Open state.** `#country-deep-dive-panel` reaches `aria-hidden="false"` with computed `visibility: visible`. Both matter — the panel is always in the DOM and slides in via transform, so attachment alone proves nothing.
- **Content.** `#deep-dive-content` holds 200+ characters of text and a heading. A `UA` run on this checkout reports a `Ukraine` heading with ~23 sections and ~2 000 characters.
- **URL round-trip.** Poll until `?country=UA` is back in `window.location`. Observed value includes the map state too: `?lat=…&lon=…&zoom=…&view=global&timeRange=7d&layers=…&country=UA`.
- **Close.** Choose the `×`. `#deep-dive-close` click returns the panel to `aria-hidden="true"`.
- **Proof.** `01-country-brief-open.png` and `02-country-brief-closed.png`, plus the transcript's content summary and post-open URL.

## Strict deterministic prediction-market flow

Use the [contributor setup](../../../../CONTRIBUTING.md#development-setup) to prepare
Node 24, dependencies, and Chromium. No credentials or env-file links are needed.

```bash
npm run test:e2e:country-brief
```

If Chromium is missing, run `npx playwright install chromium` and retry. The command
uses the existing Playwright Vite server on port 4173. If the port is occupied,
stop the server only when this run owns it. Otherwise wait for the owner to finish.
This flow does not add concurrent worktree port allocation.

`e2e/country-brief.spec.ts` also runs in `test:e2e:ci-smoke`. Each case starts with a
fresh anonymous browser context. Bootstrap and prediction RPC responses are
controlled; unrelated API and external requests receive empty stubs. Local
application assets, request construction, hydration, parsing, and rendering are real.

The cases assert:

- The visible Ukraine heading, two exact market titles, probabilities, source
  labels, and destination URLs. Neither loading text nor an empty message passes.
- The same country and records after `page.reload()`, using the URL the application
  preserved. The test does not restore the country parameter before reload.
- An exact bootstrap record when the country index is unavailable.
- An authoritative empty index suppresses bootstrap fallback.
- A 503 response reaches the current empty UI, then a user reload with a successful
  response restores the exact records. This proves reload recovery; the product
  currently does not distinguish a failed index from an empty index in its message.

Every case retains a Playwright trace, screenshots, and a `country-brief-evidence`
JSON attachment under `test-results/`. The JSON records the mode, scenario, commit,
worktree, tracked-diff fingerprint, dirty paths, selected RPC requests and statuses,
browser errors, transport failures, stubbed paths, and unverified criteria. Traces
include browser console and network activity. Use `npx playwright show-trace
<path-to-trace.zip>` to inspect a run. Copy evidence or pass a unique `--output`
directory before another run replaces the default output.

This mode proves deterministic browser behavior. It leaves live providers, real
handlers and cache behavior, deployment assets and middleware, auth/entitlements,
production freshness, and GPU rendering unverified. It does not cover every
country-brief section, mobile layout, search, or map entry points.

### Trace the prediction data path

The observable outcome is that a shared Ukraine link opens the correct country,
shows the expected market records, and preserves both after reload. The route
below explains where to investigate when that outcome fails.

| Part | Existing implementation | Local proof |
|---|---|---|
| Interface and URL | [CountryIntelManager](../../../../src/app/country-intel.ts) opens the brief and calls `fetchCountryMarkets`. [CountryDeepDivePanel](../../../../src/components/CountryDeepDivePanel.ts) renders the cards. | The browser suite asserts country identity, exact titles, percentages, sources, links, and reload state. |
| Client and hydration | [prediction service](../../../../src/services/prediction/index.ts) requests `country:UA` with page size 5. An available empty index suppresses fallback. Missing data can use hydrated bootstrap pools. | The browser suite controls RPC and bootstrap responses. `prediction-country-markets-pools.test.mts` exercises the service with controlled dependencies. |
| Handler and persistence | [listPredictionMarkets](../../../../server/worldmonitor/prediction/v1/list-prediction-markets.ts) reads `prediction:markets-country-index:v1` through shared Redis helpers. Bootstrap hydration reads the separate markets-bootstrap key. | `prediction-market-rpc.test.mts` executes the handler with mocked Redis HTTP responses. This is not a live Redis check. |
| Worker and providers | [seed-prediction-markets.mjs](../../../../scripts/seed-prediction-markets.mjs) fetches Polymarket and Kalshi, builds pools and the country index, and publishes cache and health metadata through `runSeed`. | Country-index and upstream tests use fixtures and controlled requests. They do not run the scheduled worker or publish data. |

For changes to this data path, run the existing focused checks before the browser
suite. Run these commands sequentially from the repo root.

```bash
node --import tsx --test tests/prediction-market-rpc.test.mts tests/prediction-country-markets-pools.test.mts tests/prediction-country-index.test.mjs tests/prediction-upstream.test.mjs
npm run test:e2e:country-brief
```

The focused tests are included in `test:data`. The browser suite is included in
`test:e2e:ci-smoke`. Both run through the existing [Test workflow](../../../../.github/workflows/test.yml)
when its code-change filter selects them. A docs-only PR can skip those CI jobs,
so record any local trial separately. Live provider acceptance needs authorized
source-health and natural worker-run evidence. Do not invoke the seeder for this trial.

### Check that the assertions reject defects

These optional fault injections run the same positive assertions and **must exit
nonzero**. They are separate from the ordinary passing suite. An unrelated startup
failure is not valid negative-control evidence; inspect the failing assertion.

```bash
WM_COUNTRY_BRIEF_FAULT=drop-record npm run test:e2e:country-brief -- --grep 'exact RPC records' --retries=0 --output=test-results/drop-record
WM_COUNTRY_BRIEF_FAULT=skip-hydration npm run test:e2e:country-brief -- --grep 'uses bootstrap fallback' --retries=0 --output=test-results/skip-hydration
WM_COUNTRY_BRIEF_FAULT=drop-reload-country npm run test:e2e:country-brief -- --grep 'exact RPC records' --retries=0 --output=test-results/drop-reload-country
```

The controls remove a required RPC record, omit bootstrap hydration data, or remove
the country from the current URL immediately before reload. They must fail at the
record, hydrated-record, or reopened-country assertion respectively. The evidence
JSON identifies the injected fault.

## Gotchas

- Reading `page.url()` immediately after the brief becomes visible finds NO `country` param and looks like a dropped deep link. `getShareUrl()` re-adds it only on the next debounced (250 ms) URL sync, and map-driven syncs compete with it. Poll for the parameter; do not assert once. This exact false positive was hit while writing this map.
- The brief opens after `DEEP_LINK_INITIAL_DELAY_MS` and its own retry loop, not at DOM ready. Wait on `aria-hidden`, not on boot.
- `visibility` is the honest open/closed signal. The panel keeps `right: 0px` in both states; only `transform` and `visibility` change.
- Section counts and body length vary run to run as data arrives. Assert a floor, log the number.
- Change the country with `WM_VERIFY_COUNTRY=<ISO2>`; the code is upper-cased and must resolve to a known country name.
