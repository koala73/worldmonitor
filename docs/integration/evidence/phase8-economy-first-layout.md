# Phase 8 — economy-first full layout evidence

**Scope:** Existing full-variant default ordering, saved-layout preservation,
collapsed provider-dependent posture entries and observation-label truthfulness.

## Delivered change

- Reused `VARIANT_DEFAULTS.full`, `App` migration and `PanelLayout`; no second
  dashboard was introduced.
- A fresh full layout starts with Markets, stock analysis, stock backtest,
  daily market brief and market implications. The Market header opens the
  native stock workspace at `/stocks/AAPL`; it is not an embedded PokieTicker
  page.
- Macro/trade, supply-chain and China work follow; then news and
  disaster/infrastructure. Military correlation, escalation correlation and
  airline intelligence are ordered last.
- An actual saved `panel-order` is left untouched. The collapse migration runs
  only for a full first visit with no saved order, and does not overwrite an
  existing collapse value.
- Military and aviation panels are collapsible. Their readiness notice gives
  Provider state, explicit absence of a verifiable observation time and a
  non-secret manual action. No plaintext key or key hash is displayed.
- `setLiveMode(true)` from a map-layer toggle alone cannot display `LIVE`.
  Only a valid, sourced, non-future position inside five minutes gives an
  `OBSERVED` header badge.

## Browser acceptance

The Phase 8 development instance used `http://127.0.0.1:4185/`, a new local
origin that did not inspect or alter any prior page's storage. The browser
observed:

| Observation | Result |
|---|---|
| First rendered panels | `markets`, `stock-analysis`, `stock-backtest`, `daily-market-brief`, `market-implications`, then macro/trade/supply-chain/China before `live-news` |
| Native stock entry | Market header link resolves to `/stocks/AAPL` |
| Visual placement | Markets and Stock Analysis occupy the first grid row below the map; Live News begins much lower (`top=1704`) |
| Provider-dependent tail | Military and escalation entries render at the bottom with `panel-collapsed=true`; low priority does not remove their configuration entry under the free cap |
| Military unavailable notice | After normal deferred mount, the panel contains `OpenSky relay: 未配置`, no verified observation time and the Desktop Configuration/server authorization action |
| Aviation live label | No `LIVE`/`OBSERVED` label appeared without a qualifying source/timestamped position |

Screenshots:

- `phase8-full-dashboard-market-first-1440x900.jpg` — first grid row has the
  market/stock surfaces below the map.
- `phase8-full-dashboard-first-use-1440x900.jpg` — bottom posture entries are
  visibly collapsed; it is evidence of degradation, not real-time activity.

## Acceptance boundary

This verifies layout priority and truthful no-provider state only. It does not
certify that OpenSky, Aviationstack, a military data service or any actual
flight provider is configured, licensed, current or returning an authorized
observation.
