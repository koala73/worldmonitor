# Market Data Cadence Audit

| Area | Dataset / panel | Classification | Producer cadence | Data TTL / stale contract | Frontend refresh | Decision |
|---|---|---:|---:|---:|---:|---|
| Positioning | Hyperliquid 24/7 | near-live | 5m | 45m / 30m | 5m | Keep; baseline state retained separately for 7d |
| Positioning | CFTC COT | periodic weekly | weekly | health 14d | 1h | Reduce polling in a later UI-only cleanup; label periodic |
| Gold | commodity quote / gold extended | near-live | about 15m | 30m | 5–12m | Keep near-live; consumers must preserve freshness metadata |
| Gold | SPDR holdings | periodic daily | 2h retry, daily source | 48h | included in 5m composite panel | Do not describe as live |
| Gold | IMF central-bank reserves | periodic monthly | daily retry | 31d health budget | included in 5m composite panel | Do not describe as live |
| FX | ECB/shared FX seeds | periodic daily | daily | 72h | 6h | Correct classification; not live tick FX |
| Macro/Rates | FRED tenors | periodic business-day | deployment contract requires explicit registration | 26h key; health must outlive cadence | 30m–6h | Preserve observation date separately from fetch time |
| Macro/Rates | ECB AAA curve | periodic business-day | daily | 72h / 72h; content age 10d | 30m | Correct producer; frontend over-polls static payload |
| Commodities | quote panel | near-live | 5–15m | health 30m | 12m | Keep near-live |
| Crypto | quotes / Hyperliquid | near-live, 24/7 | 5m | 30–45m | 5–12m | Keep and include in crypto-ready analysis |

“Live” means the source itself changes intraday and the end-to-end producer,
cache, health, and consumer contracts support that cadence. A frequently fetched
daily/weekly/monthly series remains periodic.
