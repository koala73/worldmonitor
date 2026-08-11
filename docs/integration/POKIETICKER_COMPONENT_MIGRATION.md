# PokieTicker Component Migration Record

**Locked reference:** `owengetinfo-design/PokieTicker` at
`c16b7e34e72c2d09bb50d7b3159fa5cd6697fd19` (MIT; trace and license are
preserved under `third_party/PokieTicker/`).

Phase 4 uses the reference as a behavior map. It does not copy the React
runtime, source files, historical SQLite database, API credentials or upstream
page into the product. The native implementation is plain TypeScript/D3 in
`src/features/pokieticker/stock-workspace.ts` plus locally scoped
`.pokie-workspace` CSS, so WorldMonitor retains one client runtime and no
iframe is used.

| PokieTicker component | WorldMonitor-native destination | Disposition | Data/truth boundary |
|---|---|---|---|
| `StockSelector.tsx` | Header selector, priority chips and search in `stock-workspace.ts` | Adapted | S&P 500 high-value names are convenient initial choices only. Search renders Provider-verified results, never a fake global catalogue. |
| `CandlestickChart.tsx` | D3 SVG chart, range buttons, crosshair and drag interval in `stock-workspace.ts` | Reimplemented | Candles/wicks/volume exist only for validated bars that belong to the selected symbol; otherwise the chart is visibly empty. |
| `NewsPanel.tsx` | News/event particle rail | Adapted | Only Provider-returned items with a safe source link and publication time can be shown. |
| `NewsCategoryPanel.tsx` | Disabled news-category controls | Adapted as disabled | No positive/negative label is created before Phase 5 analysis evidence; related news is not causal proof. |
| `RangeQueryPopup.tsx` | Chart drag interval and range-explanation section | Reimplemented | A bounded selected interval can request a backend explanation; no interval means no explanation. |
| `RangeNewsPanel.tsx` | Range news section | Deferred/disabled | Requires source-backed, time-bounded results. |
| `RangeAnalysisPanel.tsx` | Range explanation section | Deferred/disabled | Requires a real backend analysis response and must separate correlation from causality. |
| `SimilarDaysPanel.tsx` | Similar events/trading-days section | Deferred/disabled | Requires a real event ID and historical retrieval evidence; no fixture or sample rows reach production UI. |
| `SimilarNewsPanel.tsx` | Similar events/news section | Deferred/disabled | Requires an evidence-backed event/news index. |
| `PredictionPanel.tsx` | Forecast/actual-return section | Deferred/disabled | Requires model version, confidence, horizon and later observed-return evaluation; no simulated return or buy/sell conclusion is shown. |
| `StoryPanel.tsx` | Price-and-event story section | Deferred/disabled | Requires cited source links and an explicitly non-causal narrative unless causality is independently established. |

The migration status is therefore feature-complete for shell, interaction and
honest empty state, but deliberately not a claim that no-key local development
has live global markets, real-time K-lines, automated causal inference or a
prediction service. Provider-backed visual acceptance remains a later manual
authorization gate.
