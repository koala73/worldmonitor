# Phase 4 — Native Stock Workspace Evidence

**Implementation commit:** `PENDING_BACKFILL`

**Scope:** a native WorldMonitor route for `/stocks` and `/stocks/:symbol`,
with a scrollable research workspace, S&P 500 high-market-capitalization
symbols first, provider-backed search and an honest no-provider state. This is
an interface and truthfulness gate, not an authorized live-market acceptance.

## Delivered behavior

- `stock-workspace-route.ts` owns only valid stock paths and normalizes the
  requested symbol; `/stocks` defaults to AAPL and an invalid path is not
  silently treated as a different user-selected security.
- `stock-workspace.ts` calls the generated `MarketServiceClient` for bars,
  quote, search, news and range analysis. It does not call PokieTicker, use an
  iframe, embed a credential or ship a static K-line array.
- The initial selector intentionally puts `AAPL`, `MSFT`, `NVDA`, `AMZN`,
  `GOOGL`, `META`, `TSLA` and `BABA` first. Search results are rendered only
  when a Provider returns and validates them; no global-company list is
  invented while the Provider is unconfigured.
- The D3 chart renders a candlestick body/wick, volume, axes, date/price
  crosshair, source-linked event particles and range drag **only** from bars
  whose returned symbol, time and OHLC shape passed Market v1 validation. With
  no returned bars it remains visibly empty and identifies the provider state.
- The workspace has its own `overflow-y: auto` scroll container because the
  legacy dashboard shell intentionally locks document scrolling. This directly
  resolves the reported inability to scroll the stock view while preserving the
  shell's layout policy elsewhere.
- News category, similar-day/news, forecast and story surfaces retain their
  native route/UI locations but are disabled or explicitly empty until their
  Phase 5 evidence inputs exist. They do not label sentiment as impact or news
  correlation as a price cause.

## Automated gates

| Check | Exit / result | Evidence |
|---|---:|---|
| `npm run typecheck:all` | 0 | TypeScript, API TypeScript and Convex audit passed. |
| Focused Market + route suite | 0; 15/15 | `node --import tsx --test tests/stock-workspace-route.test.mts tests/stock-data-contract.test.mts tests/stock-realtime-adapter.test.mts` |
| Phase-scoped Biome lint | 0 | Seven Phase 4 source/style/test files checked with no fixes. |
| `npm run lint` whole tree | 0 | 33 existing warnings and 9 infos; no error. The Phase 4 scoped lint is the diff gate. |
| `npm run build:full` | 0 | Product facts, Vite secret guard, OpenAPI, attribution, blog/corpus/sitemap and production bundle completed. Existing chunk-size/dynamic-import warnings remain warnings. |
| Local route response | 200 | Vite dev server returned `200` for `http://127.0.0.1:4184/stocks/AAPL`. |

## Browser evidence — local development route

All browser checks use the actual local native route, not a mock page. No
Provider key or display/rebroadcast entitlement was supplied, so the visual
evidence proves layout, routing, disabled state and absence of fake data — not
live price accuracy or real-time entitlement.

| Viewport / interaction | Result | Screenshot |
|---|---|---|
| 1440×900 initial workspace | PASS after route hydration; AAPL is selected and the eight priority chips are present. | `phase4-stock-workspace-1440x900-scroll-pass.png` |
| 1440×900 wheel scroll | PASS; `.pokie-workspace` had `clientHeight=860`, `scrollHeight=1104`, `overflowY=auto`; an actual wheel scroll set `scrollTop=244` (bottom). | `phase4-stock-workspace-scroll-bottom.png` |
| 1280×720 | PASS; workspace remains independently scrollable (`680 / 978`, `auto`) and chart/research rail remain usable. | `phase4-stock-workspace-1280x720.png` |
| 390×844 | PASS; workspace is `375` CSS px wide with `scrollWidth=375`, `scrollHeight=2020`, `overflowY=auto`; document horizontal overflow is false. | `phase4-stock-workspace-390x844.png` |
| Symbol route | PASS; clicking `MSFT` changed the path to `/stocks/MSFT` and heading to `MSFT`. | DOM/browser record in this receipt. |
| Unconfigured global search | PASS; after `7203`, there were zero results and the UI said `没有收到可验证的搜索结果`; no fabricated company or chart appeared. | DOM/browser record in this receipt. |
| Fake-data rejection | PASS; all browser measurements found zero `.synthetic-candle` / `[data-synthetic-candle]` elements. | DOM/browser record in this receipt. |

`phase4-stock-workspace-1440x900.png` is retained as a transparent diagnostic
artifact: it was captured during the dashboard shell's loading placeholder,
before the lazy route had hydrated. It is explicitly **not** treated as a pass.
The next capture waited for the visible stock-workspace heading and is the pass
evidence listed above.

## Truthfulness boundary

The current UI truthfully says `数据源未配置 · none` and renders no quote,
OHLC bar, news particle, analysis, forecast, similar-day result or story.
This is correct until a server-side Provider request produces a provenance
envelope and the required display/rebroadcast authorization is separately
confirmed. The historical PokieTicker fixture remains test-only and never
crosses this UI boundary.
