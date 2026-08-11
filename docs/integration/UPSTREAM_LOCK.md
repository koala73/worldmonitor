# Upstream Lock

**Recorded:** 2026-08-11
**Rechecked through the connected GitHub app:** 2026-08-11T16:47:20+08:00
**Purpose:** Reproducible source and license provenance for the reconstruction.

| Role | Repository | Ref | Locked SHA | License | Verification |
|---|---|---|---|---|---|
| Formal mother fork (`origin`) | `https://github.com/daking32168-byte/worldmonitor.git` | `main` | `0fca203c776dd5fa4913c4bd52f99cd2c3c13a25` | AGPL-3.0-only | Local sparse clone and connected GitHub app |
| Official WorldMonitor (`upstream`) | `https://github.com/koala73/worldmonitor.git` | `main` | `ae0a0fe26bcbdb683b366899e4dc38fb8ccfb5ad` | AGPL-3.0-only | Connected GitHub app commit lookup on 2026-08-11 |
| PokieTicker source | `https://github.com/owengetinfo-design/PokieTicker.git` | `main` | `c16b7e34e72c2d09bb50d7b3159fa5cd6697fd19` | MIT | Connected GitHub app commit lookup on 2026-08-11 |

## Local remote configuration

```text
origin   https://github.com/daking32168-byte/worldmonitor.git
upstream https://github.com/koala73/worldmonitor.git
```

`origin/main` is locally locked at the fork SHA above. The official upstream SHA is independently verified through the connected GitHub app; Phase 1 must fetch it locally before determining whether `origin/main` is pure-behind and therefore safe for `--ff-only` synchronization.

The Phase 0 closure deliberately did not treat the connected-app upstream lookup as a local object fetch. `ahead`/`behind`, merge-base, and any `--ff-only` action remain Phase 1 gates after the legal confirmation.

## Legacy-data lock

The legacy PokieTicker database is **not** a Git artifact and must not be copied into the mother repository as a normal blob.

| Field | Value |
|---|---|
| Original path | `D:\使用AI专属文件夹\global-intelligence-earth\全球热点追踪\data\pokieticker\pokieticker.db` |
| Size | 226,844,672 bytes |
| SHA-256 | `F50090BF859F71A24A210120F9F92407DE3EA6E6B469E814858C69ADBC9DD47C` |
| `ohlc` rows | 53,025 |
| `news_raw` rows | 60,391 |
| `tickers` rows | 105 |
| Maximum OHLC date | `2026-03-03` |

The database is an historical research snapshot only. Its maximum OHLC date proves it cannot be presented as current exchange data.
