# Data Lineage Baseline

## Legacy PokieTicker historical snapshot

| Attribute | Value |
|---|---|
| Source repository | `owengetinfo-design/PokieTicker` at `c16b7e34e72c2d09bb50d7b3159fa5cd6697fd19` |
| License | MIT; attribution and license text must be preserved for any incorporated code/data use |
| Source path | `D:\使用AI专属文件夹\global-intelligence-earth\全球热点追踪\data\pokieticker\pokieticker.db` |
| SHA-256 | `F50090BF859F71A24A210120F9F92407DE3EA6E6B469E814858C69ADBC9DD47C` |
| Tables | `ohlc`, `news_raw`, `news_ticker`, `news_aligned`, Layer 0/1/2 results, tickers, batch records |
| OHLC coverage | 53,025 rows; max `date` is `2026-03-03` |
| Truth status | `HISTORICAL_SNAPSHOT` |
| Allowed use | Offline historical research, analysis backfill, test fixtures under explicit isolation |
| Prohibited representation | Current market quote, licensed real time, exchange-delayed guarantee, or fallback without an explicit historical label/reason |

## Planned WorldMonitor-native data paths

| Domain | Proposed formal path | Minimum lineage/label |
|---|---|---|
| Stock bars and quotes | Market v1 service and server-side relay | Provider, authorization/freshness status, symbol validation, observed/fetched/as-of times, fallback reason |
| Company news | Provider ticker links, WorldMonitor entity mapping, IR/exchange/regulator sources | Source URL/ID, publication time, entity link confidence, trading-session alignment |
| AIS | Existing WorldMonitor maritime/relay architecture | AIS source, packet time, fetch time, freshness and self-reported-field label |
| Port activity | PortWatch/official data adapters | Dataset release/update time, geographic scope, methodology/estimate label |
| Trade / China factory | UN Comtrade, lawful China customs imports, official local-cluster evidence | Reporting period, reporter/partner/HS, source batch, unit/currency, `OBSERVED_OFFICIAL` / `MODELLED_ESTIMATE` / `BILL_OF_LADING_OBSERVED` |

No upstream website is framed or embedded as a substitute for an owned data pipeline.
