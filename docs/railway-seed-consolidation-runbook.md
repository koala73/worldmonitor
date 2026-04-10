# Railway Seed Consolidation Runbook

**Date:** 2026-04-10
**PR:** #2891
**Current services:** 100 (at Railway limit)
**Target services:** 65 (~35 slots freed)

---

## Prerequisites

1. Merge PR #2891 to `main`
2. Verify the bundle scripts are in the deployed branch
3. Have Railway dashboard access and `gh` CLI authenticated

---

## How It Works

Each "bundle" is a single Railway cron service that replaces N individual services. The bundle script spawns each member seed sequentially via `child_process.execFile`, checking Redis `seed-meta:` timestamps to skip seeds that ran recently. Original seed scripts are unchanged.

**Per-bundle migration:**

1. Delete ONE old member first (to free a slot under the 100 limit)
2. Create the bundle service on Railway
3. Wait 2-3 cron cycles, verify `/api/health` shows OK for all member seeds
4. Delete remaining old member services
5. Monitor 24h before proceeding to next bundle

**Rollback:** Delete the bundle service, re-create individual services. Scripts are unchanged in the repo.

---

## Services to DELETE (46 total)

### Standalone delete (no bundle replacement needed)

| # | Service Name | Service ID | Reason |
|---|---|---|---|
| 1 | seed-defense-patents (DISABLED) | `6f8bfd1b-7ccc-4db5-b03c-a2075b173e91` | Already disabled, no data flowing |

### Replaced by seed-bundle-ecb-eu

| # | Service Name | Service ID | Original Cron |
|---|---|---|---|
| 2 | seed-ecb-fx-rates | `9cc81d27-745f-4925-a956-d9e0acacc8a2` | daily |
| 3 | seed-ecb-short-rates | `b695dd14-12fd-4493-a41b-30d50a9519d5` | daily |
| 4 | seed-yield-curve-eu | `b372da1c-e67d-44c0-ae23-4e391e75709b` | daily |
| 5 | seed-fsi-eu | `9c67552d-0a0a-409a-bf4f-571ac3f741c3` | weekly |

### Replaced by seed-bundle-portwatch

| # | Service Name | Service ID | Original Cron |
|---|---|---|---|
| 6 | seed-portwatch | `72b553c9-bf63-4905-ab47-706b0cc674e8` | every 6h |
| 7 | seed-portwatch-disruptions | `cb0aea5d-806b-49f9-85f3-b0a0e1372a26` | hourly |
| 8 | seed-portwatch-chokepoints-ref | `7907937c-5730-4768-a3cc-f4a3f555a9c5` | weekly |
| 9 | seed-portwatch-port-activity | `334303bb-41a2-4e66-9add-b1762fda9a1a` | every 12h |

### Replaced by seed-bundle-static-ref

| # | Service Name | Service ID | Original Cron |
|---|---|---|---|
| 10 | seed-submarine-cables | `fde66e2c-e542-47e0-8ff5-49026b229949` | weekly |
| 11 | seed-chokepoint-baselines | `de51db71-3492-4521-873c-90b9c08dd8b4` | infrequent (400d TTL) |
| 12 | seed-military-bases | `54b44749-c318-4392-aebe-aaf8308db1e9` | infrequent (one-time) |

### Replaced by seed-bundle-resilience

| # | Service Name | Service ID | Original Cron |
|---|---|---|---|
| 13 | seed-resilience-scores | `e87c212a-eab6-4a85-9e43-b855ca207823` | every 6h |
| 14 | seed-resilience-static | `e0709305-0270-4f53-b133-7d74e8260400` | annual window |

### Replaced by seed-bundle-derived-signals

| # | Service Name | Service ID | Original Cron |
|---|---|---|---|
| 15 | seed-correlation | `6cb62419-f354-419a-835c-67f494347680` | every 5min |
| 16 | seed-cross-source-signals | `57708db4-37a9-490e-98ee-dcdc783ce0f9` | every 15min |

### Replaced by seed-bundle-climate

| # | Service Name | Service ID | Original Cron |
|---|---|---|---|
| 17 | seed-climate-zone-normals | `01d57359-bccd-46f7-8b78-351040058f5f` | monthly |
| 18 | seed-climate-anomalies | `90095ed3-c9a8-4e42-b955-3b66fe288edb` | every 3h |
| 19 | seed-climate-disasters | `7a8e2384-925a-42c3-9767-c4cf14822985` | every 6h |
| 20 | seed-climate-ocean-ice | `05c54150-226f-471d-9938-90fde67a8f11` | daily |
| 21 | seed-co2-monitoring | `2a1cd437-fed3-4f74-b327-f2336ffcbb3f` | every 3 days |

### Replaced by seed-bundle-energy-sources

| # | Service Name | Service ID | Original Cron |
|---|---|---|---|
| 22 | seed-gie-gas-storage | `70a43803-f91e-4306-973c-b99ce29fb055` | daily |
| 23 | seed-gas-storage-countries | `a8dd33d5-ed2a-4462-97ef-3e9654920e19` | daily |
| 24 | seed-jodi-gas | `7b7c7198-60e0-48b4-8f9c-33036d530586` | monthly |
| 25 | seed-jodi-oil | `c0d829a5-42ce-4644-bd7d-94f93bf92e26` | monthly |
| 26 | seed-owid-energy-mix | `31303e69-ec86-4fa0-b956-0c5524f038a1` | monthly |
| 27 | seed-iea-oil-stocks | `8a05aaa6-8802-4221-ab3b-59001a4df5d3` | monthly |

### Replaced by seed-bundle-macro

| # | Service Name | Service ID | Original Cron |
|---|---|---|---|
| 28 | seed-bis-data | `8a2896ea-207e-4bef-8cd0-c6871df09a1d` | every 12h |
| 29 | seed-bls-series | `cf6f0bd4-3b09-4e77-b720-f2d08cb2c04f` | daily |
| 30 | seed-eurostat-country-data | `9314f05a-c9d6-4d5a-8af6-575da09174b0` | daily |
| 31 | seed-imf-macro | `5634de02-83ff-4ab1-8b88-aef73c4055e7` | monthly |
| 32 | seed-national-debt | `7ca57c8b-5d26-4a47-ba76-ae8f465eb0f3` | monthly |
| 33 | seed-fao-food-price-index | `c923b38f-3a52-4933-96d1-89443c8deda1` | daily |

### Replaced by seed-bundle-health

| # | Service Name | Service ID | Original Cron |
|---|---|---|---|
| 34 | seed-health-air-quality | `7be8c278-1c00-4761-adb5-85336ee4661b` | hourly |
| 35 | seed-disease-outbreaks | `12c8681b-6e82-464d-b6e5-6b397123643d` | daily |
| 36 | seed-vpd-tracker | `bd286f94-39f2-4341-895d-4ea6ea4d1905` | daily |
| 37 | seed-displacement-summary | `fed916c2-97bc-434b-ad2d-636121bcd70d` | daily |

### Replaced by seed-bundle-market-backup

| # | Service Name | Service ID | Original Cron | Also in ais-relay? |
|---|---|---|---|---|
| 38 | seed-crypto-quotes | `3bf34a40-e4dc-4fac-9fa6-8438118d0f53` | every 5min | Yes (Market loop) |
| 39 | seed-stablecoin-markets | `0410d0eb-81ee-46e0-a50f-8fd9de334ef8` | every 10min | Yes (Market loop) |
| 40 | seed-etf-flows | `6d907720-b274-4b4c-a2e5-a37e9161f349` | every 15min | Yes (Market loop) |
| 41 | seed-gulf-quotes | `ba1ad92b-1813-412d-b6e5-6c37f3f741c2` | every 10min | Yes (Market loop) |
| 42 | seed-token-panels | `a975dc1a-6ac3-4db0-89bf-bdcdecb92fde` | every 30min | Yes (Market loop) |

### Replaced by seed-bundle-relay-backup

| # | Service Name | Service ID | Original Cron | Also in ais-relay? |
|---|---|---|---|---|
| 43 | seed-climate-news | `c4875401-90b5-4738-ba64-6f27496d41a0` | every 30min | Yes (child spawn) |
| 44 | seed-usa-spending | `f420ca72-c41d-46aa-a151-0315ce45df2d` | hourly | Yes (Spending loop) |
| 45 | seed-ucdp-events | `6bce510f-d3a9-4252-b896-45aef3521cac` | every 6h | Yes (UCDP loop) |
| 46 | seed-wb-indicators | `ad9df8af-f27c-41db-a89d-f68f2fab2cf6` | daily | Yes (WB loop) |

---

## Services to CREATE (11 total)

All new services share these settings:

- **Root directory:** `.` (repo root, so `npm ci` installs all deps)
- **Build command:** (default nixpacks, uses `scripts/nixpacks.toml`)
- **Source branch:** `main`
- **Resources:** 1 vCPU / 1 GB RAM
- **NODE_OPTIONS:** `--dns-result-order=ipv4first`

**Watch paths:** Use `scripts/**`, `shared/**` for all bundles. `scripts/**` covers all seed scripts and their helpers. `shared/**` is needed because `loadSharedConfig()` in `_seed-utils.mjs` resolves `../shared/` (repo root) before `./shared/` (scripts dir), so config JSON files like `country-names.json`, `iso3-to-iso2.json`, and others live at the repo root `shared/` directory. Without `shared/**`, config-only edits won't trigger redeploys.

### Bundle 1: seed-bundle-ecb-eu

| Setting | Value |
|---|---|
| **Service name** | `seed-bundle-ecb-eu` |
| **Start command** | `node scripts/seed-bundle-ecb-eu.mjs` |
| **Cron schedule** | `0 6 * * *` (daily 06:00 UTC) |
| **Watch paths** | `scripts/**`, `shared/**` |
| **Replaces** | 4 services (ecb-fx-rates, ecb-short-rates, yield-curve-eu, fsi-eu) |
| **Net savings** | 3 slots |
| **Members** | ECB FX Rates (daily), ECB Short Rates (daily), Yield Curve EU (daily), FSI EU (weekly, skips 6/7 runs) |

### Bundle 2: seed-bundle-portwatch

| Setting | Value |
|---|---|
| **Service name** | `seed-bundle-portwatch` |
| **Start command** | `node scripts/seed-bundle-portwatch.mjs` |
| **Cron schedule** | `0 */1 * * *` (hourly) |
| **Watch paths** | `scripts/**`, `shared/**` |
| **Replaces** | 4 services |
| **Net savings** | 3 slots |
| **Members** | Disruptions (hourly), Main (6h), Port Activity (12h), Chokepoints Ref (weekly) |

### Bundle 3: seed-bundle-static-ref

| Setting | Value |
|---|---|
| **Service name** | `seed-bundle-static-ref` |
| **Start command** | `node scripts/seed-bundle-static-ref.mjs` |
| **Cron schedule** | `0 3 * * 0` (weekly, Sunday 03:00 UTC) |
| **Watch paths** | `scripts/**`, `shared/**` |
| **Replaces** | 3 services |
| **Net savings** | 2 slots |
| **Members** | Submarine Cables (weekly), Chokepoint Baselines (400d, runs rarely), Military Bases (30d, runs rarely) |

### Bundle 4: seed-bundle-resilience

| Setting | Value |
|---|---|
| **Service name** | `seed-bundle-resilience` |
| **Start command** | `node scripts/seed-bundle-resilience.mjs` |
| **Cron schedule** | `0 */6 * * *` (every 6h) |
| **Watch paths** | `scripts/**`, `shared/**` |
| **Replaces** | 2 services |
| **Net savings** | 1 slot |
| **Members** | Resilience Scores (6h), Resilience Static (annual window Oct 1-3, skips most runs) |

### Bundle 5: seed-bundle-derived-signals

| Setting | Value |
|---|---|
| **Service name** | `seed-bundle-derived-signals` |
| **Start command** | `node scripts/seed-bundle-derived-signals.mjs` |
| **Cron schedule** | `*/5 * * * *` (every 5 min) |
| **Watch paths** | `scripts/**`, `shared/**` |
| **Replaces** | 2 services |
| **Net savings** | 1 slot |
| **Members** | Correlation (5min), Cross-Source Signals (15min, runs every 3rd invocation) |
| **Note** | Both are Redis-derived (no external API calls), fast execution |

### Bundle 6: seed-bundle-climate

| Setting | Value |
|---|---|
| **Service name** | `seed-bundle-climate` |
| **Start command** | `node scripts/seed-bundle-climate.mjs` |
| **Cron schedule** | `0 */3 * * *` (every 3h) |
| **Watch paths** | `scripts/**`, `shared/**` |
| **Replaces** | 5 services |
| **Net savings** | 4 slots |
| **Members** | Zone Normals (monthly, skips ~359/360), Anomalies (3h, depends on zone-normals), Disasters (6h), Ocean Ice (daily), CO2 Monitoring (3 days) |
| **Note** | Zone-normals runs before anomalies (dependency ordering) |

### Bundle 7: seed-bundle-energy-sources

| Setting | Value |
|---|---|
| **Service name** | `seed-bundle-energy-sources` |
| **Start command** | `node scripts/seed-bundle-energy-sources.mjs` |
| **Cron schedule** | `30 7 * * *` (daily 07:30 UTC) |
| **Watch paths** | `scripts/**`, `shared/**` |
| **Replaces** | 6 services |
| **Net savings** | 5 slots |
| **Members** | GIE Gas Storage (daily), Gas Storage Countries (daily), JODI Gas (monthly), JODI Oil (monthly), OWID Energy Mix (monthly), IEA Oil Stocks (monthly) |

### Bundle 8: seed-bundle-macro

| Setting | Value |
|---|---|
| **Service name** | `seed-bundle-macro` |
| **Start command** | `node scripts/seed-bundle-macro.mjs` |
| **Cron schedule** | `0 8 * * *` (daily 08:00 UTC) |
| **Watch paths** | `scripts/**`, `shared/**` |
| **Replaces** | 6 services |
| **Net savings** | 5 slots |
| **Members** | BIS Data (12h), BLS Series (daily), Eurostat (daily), IMF Macro (monthly), National Debt (monthly), FAO FFPI (daily, catches monthly release window) |

### Bundle 9: seed-bundle-health

| Setting | Value |
|---|---|
| **Service name** | `seed-bundle-health` |
| **Start command** | `node scripts/seed-bundle-health.mjs` |
| **Cron schedule** | `0 */1 * * *` (hourly) |
| **Watch paths** | `scripts/**`, `shared/**` |
| **Replaces** | 4 services |
| **Net savings** | 3 slots |
| **Members** | Air Quality (hourly), Disease Outbreaks (daily), VPD Tracker (daily), Displacement (daily) |

### Bundle 10: seed-bundle-market-backup

| Setting | Value |
|---|---|
| **Service name** | `seed-bundle-market-backup` |
| **Start command** | `node scripts/seed-bundle-market-backup.mjs` |
| **Cron schedule** | `*/5 * * * *` (every 5 min) |
| **Watch paths** | `scripts/**`, `shared/**` |
| **Replaces** | 5 services |
| **Net savings** | 4 slots |
| **Members** | Crypto Quotes (5min), Stablecoin Markets (10min), ETF Flows (15min), Gulf Quotes (10min), Token Panels (30min) |
| **Note** | These are BACKUP for ais-relay inline loops. ais-relay is the primary seeder. The bundle provides redundancy if relay goes down. Gulf Quotes uses Alpha Vantage (richer than relay's Yahoo-only). |

### Bundle 11: seed-bundle-relay-backup

| Setting | Value |
|---|---|
| **Service name** | `seed-bundle-relay-backup` |
| **Start command** | `node scripts/seed-bundle-relay-backup.mjs` |
| **Cron schedule** | `*/30 * * * *` (every 30 min) |
| **Watch paths** | `scripts/**`, `shared/**` |
| **Replaces** | 4 services |
| **Net savings** | 3 slots |
| **Members** | Climate News (30min), USA Spending (hourly), UCDP Events (6h), WB Indicators (daily) |
| **Note** | These are BACKUP for ais-relay inline loops/child spawns. Each seed's freshness gate skips if the relay already refreshed the data recently. |

---

## Services that STAY unchanged (54 total)

### Infrastructure (4)

| Service | ID | Type |
|---|---|---|
| Postgres | `8a5871b9-5ca9-4551-8343-aef7fa67b8a4` | Database |
| Postgres-azIG | `3ea8ae20-44f4-49bd-a363-76b0adec8dcd` | Database |
| Valkey | `651a4b62-e224-47c2-9f7c-64e35908c44a` | Cache |
| umami | `d7620480-e05a-4c09-b210-05166c3c0e59` | Analytics |

### Long-running services (4)

| Service | ID | Type |
|---|---|---|
| worldmonitor (ais-relay) | `a5f66d97-217f-44a0-a42d-5f3b67752223` | AIS relay + inline seeds |
| notification-relay | `aa37bd8e-c28d-4e9b-9d1e-0961f1b63d97` | Notification dispatch |
| simulation-worker | `67264e35-0b51-457b-984f-4ef20e36a117` | Forecast simulations |
| deep-forecast-worker | `750bc68f-9840-49a3-95eb-7c8bcc060485` | Deep forecast tasks |

### Consumer prices pipeline (3)

| Service | ID | Type |
|---|---|---|
| seed-consumer-prices | `2a369c41-cc5c-486a-a8d7-f0ca552e27a8` | Scraper |
| seed-consumer-prices-publish | `4492a338-cb37-40da-9e98-95a8d67e49c9` | Redis publisher |
| seed-consumer-aggregate | `4fdd1078-7884-48f8-92fc-06b390d0fdc4` | Index calculator |

### Standalone seed crons (43, not bundled)

| # | Service | ID | Why not bundled |
|---|---|---|---|
| 1 | digest-notifications | `01d644b8-057f-4040-a50e-500bd684daa8` | Notification dispatch, not a data seed |
| 2 | seed-airport-delays | `444e9cc0-4eb2-4820-b430-3228e6ce9568` | Unique aviation domain |
| 3 | seed-aviation | `a8e49386-64c1-4e1e-9f82-4eb69a55fce3` | Different keys from relay's aviation loop |
| 4 | seed-bigmac | `e8269317-c717-498b-adcf-be693a2bb8d3` | Weekly, web scraping via Exa |
| 5 | seed-chokepoint-exposure | `12e8e87d-1214-4ba3-a813-709f279a5ba9` | Derived from Comtrade flows |
| 6 | seed-conflict-intel | `e4188e09-ae3b-4398-bb24-04f4b4b48b52` | Fast cadence (15min), notifications |
| 7 | seed-cot | `23b2597f-1989-4904-9018-b3722a9e1bc2` | Weekly CFTC data |
| 8 | seed-cyber-threats | `fd27928b-0b9b-45d6-b056-92fa2f5d60a6` | Relay disabled its loop, cron is sole source |
| 9 | seed-earnings-calendar | `cd07f48e-6433-4847-9f7b-1f05d062e619` | Finnhub, different domain |
| 10 | seed-earthquakes | `5a953848-0678-4946-8ea0-b2269914ea12` | Independent seismology |
| 11 | seed-economic-calendar | `555fc987-a043-4f64-bfa3-c827157ec706` | FRED + Eurostat + Fed/ECB scrape |
| 12 | seed-economy | `565a66c1-662d-4a3a-b8e2-83b79d75dbe4` | Already multi-section (11+ keys) |
| 13 | seed-electricity-prices | `1aee77cd-3af9-4640-a78d-e957c322adc0` | ENTSO-E + EIA, large dataset |
| 14 | seed-ember-electricity | `67e01a64-d3cb-4b53-bf7d-cd5d223323b3` | Large CSV download |
| 15 | seed-energy-intelligence | `9c2135c6-d638-4137-955a-8819c4d969f6` | RSS parsing |
| 16 | seed-energy-spine | `a6c1d05f-a639-4470-829d-9337ffbdcbbe` | Composite from other seeds |
| 17 | seed-fear-greed | `fcff514b-7b32-46c2-9413-0a48bcf4968e` | Composite index, unique sources |
| 18 | seed-fire-detections | `1ebe342b-074b-4fb5-b012-c1dbfdef1971` | Feeds thermal-escalation |
| 19 | seed-forecasts | `9bcbf89e-2785-452b-b59f-144b4863bd95` | LLM-heavy, long runtime |
| 20 | seed-fuel-prices | `8d966e58-e01c-42cf-8d28-b85fd5d45460` | EU XLSX download |
| 21 | seed-fx-rates | `5221253d-a22e-4560-a3db-ea4634c2049a` | Shared dependency for other seeds |
| 22 | seed-gdelt-intel | `3472577e-dff4-49f9-bc17-f32c2f366f75` | 6 topics with 20s delays |
| 23 | seed-gpsjam | `16949dc7-b908-4740-bfbe-74a213db7c0b` | GPS interference monitoring |
| 24 | seed-grocery-basket | `c8438692-843d-46ae-bee7-8c19e6847fa4` | Web scraping via Exa |
| 25 | seed-hormuz | `e6156007-e917-4139-90bd-71b6333a6d0e` | Power BI scraping |
| 26 | seed-infra | `c615c211-1237-47cc-8d90-e23657437838` | Warm-ping to Vercel |
| 27 | seed-insights | `d1e092bb-6a5b-4225-8043-8ed93ccff268` | LLM-dependent |
| 28 | seed-internet-outages | `5a07e099-14d8-42aa-ad6e-e66631fdd19f` | Cloudflare Radar |
| 29 | seed-iran-events | `5d294bd6-7943-4454-aa9c-eb90bd9d9124` | Iran-focused aggregation |
| 30 | seed-military-flights | `7953a066-0627-4550-b72c-d2aceb33fbd3` | Real-time tracking, live/stale keys |
| 31 | seed-military-maritime | `88768189-f80b-4615-87d1-dbc7803a6a28` | USNI warm-ping |
| 32 | seed-natural-events | `7119c932-05f5-4727-a54f-e4e2de2a907f` | NASA EONET + GDACS + NHC |
| 33 | seed-prediction-markets | `96fabace-d56d-4854-8096-3f5bcfe0d88a` | Polymarket anti-bot measures |
| 34 | seed-radiation-watch | `3b76bb85-637c-43b7-ab90-5dee288f8bca` | EPA + Safecast |
| 35 | seed-regulatory-actions | `249ae8df-5746-4cdb-9978-ec61dce9121f` | Financial regulator RSS |
| 36 | seed-research | `ab850199-4d48-4af8-9681-aafbe2f31b8e` | arXiv + HN + GitHub |
| 37 | seed-sanctions-pressure | `e1686cdf-980f-426d-b5f2-a7757729fe9b` | 120MB+ XML streaming |
| 38 | seed-security-advisories | `8fb9c6b7-0ae9-441b-ae02-0f31baa3aed6` | 22 advisory feeds |
| 39 | seed-supply-chain-trade | `d7cc29f0-691b-40fd-84f2-ce8e8f12b567` | Already multi-section |
| 40 | seed-thermal-escalation | `71d124d5-a4fb-42c3-9c5b-2fb0e5645e5b` | Derived from fire detections |
| 41 | seed-trade-flows | `dd3097f7-df65-4b0e-89ca-86a5fac7d558` | UN Comtrade, 6 reporters |
| 42 | seed-unrest-events | `33c8c2a1-ad66-45ec-ac7e-609d69a59455` | GDELT + ACLED |
| 43 | seed-webcams | `2bf93afa-1922-4f9c-936d-f5054051b8a5` | Paginated across 8 regions |

**Inventory check:** 4 infra + 4 long-running + 3 consumer + 46 delete + 43 standalone = **100**

---

## Execution Order (recommended)

Start with lowest-risk, highest-savings bundles.

| Order | Bundle | Slots Freed | Risk | Cron Frequency |
|---|---|---|---|---|
| 1 | seed-bundle-ecb-eu | 3 | Low (daily, same API) | Daily |
| 2 | seed-bundle-static-ref | 2 | Low (weekly, static data) | Weekly |
| 3 | seed-bundle-resilience | 1 | Low (6h, annual window) | 6h |
| 4 | seed-bundle-portwatch | 3 | Medium (hourly, 4 members) | Hourly |
| 5 | seed-bundle-climate | 4 | Medium (3h, 5 members) | 3h |
| 6 | seed-bundle-energy-sources | 5 | Medium (daily, 6 members) | Daily |
| 7 | seed-bundle-macro | 5 | Medium (daily, 6 members) | Daily |
| 8 | seed-bundle-health | 3 | Medium (hourly, 4 members) | Hourly |
| 9 | seed-bundle-derived-signals | 1 | Low (5min, Redis-only) | 5min |
| 10 | seed-bundle-market-backup | 4 | Low (backup for relay) | 5min |
| 11 | seed-bundle-relay-backup | 3 | Low (backup for relay) | 30min |
| - | seed-defense-patents | 1 | None (already disabled) | - |

**Running total:** 3 + 2 + 1 + 3 + 4 + 5 + 5 + 3 + 1 + 4 + 3 + 1 = **35 slots freed**

---

## Verification Checklist (per bundle)

After deploying each bundle and before deleting old services:

- [ ] Bundle service shows "Active" in Railway dashboard
- [ ] First cron fire produced logs (check Railway logs)
- [ ] Logs show expected `[Bundle:X] Starting (N sections)` and `Finished` lines
- [ ] Each member seed shows `Done` or `Skipped` (not all `failed`)
- [ ] `/api/health` shows OK for all member seed-meta keys (not STALE_SEED)
- [ ] Wait at least 2 full cron cycles before deleting old services
- [ ] After deleting old services, verify health still shows OK on next cycle

---

## Env Vars

Each bundle service inherits the same env vars as the individual seeds it replaces. Copy these from any existing seed service in Railway:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `NODE_OPTIONS=--dns-result-order=ipv4first`
- Plus any API keys used by member seeds (GIE_API_KEY, ICAO_API_KEY, etc.)

The simplest approach: use Railway's "shared variables" or copy all env vars from the `worldmonitor` (ais-relay) service, which has a superset of all API keys.
