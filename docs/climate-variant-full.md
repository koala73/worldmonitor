# Climate Variant: Full Implementation Plan

## Current State

| Component | Status |
|-----------|--------|
| Proto RPCs | 1 — `ListClimateAnomalies` |
| Redis keys | 1 — `climate:anomalies:v1` |
| Seed scripts | 1 — `seed-climate-anomalies.mjs` |
| MCP tool | `get_climate_data` — bundled with `weather:alerts:v1` |
| Hostname variant | Not configured |

**Critical flaw in existing seeder:** `seed-climate-anomalies.mjs` uses a 30-day rolling window as its own baseline. It compares "last 7 days" vs "previous 23 days" — not against 30-year climate normals. This produces anomaly numbers that are internally consistent but climatologically meaningless (e.g., a heat wave during a hot month won't appear anomalous if the prior 3 weeks were equally hot).

---

## Target State: 6 Data Layers

### Layer 1: Climate Anomalies (EXISTING — fix + expand)

**Fix first:** Replace 30-day rolling baseline with **30-year ERA5 climatological normals** via Copernicus Climate Data Store or Open-Meteo's historical endpoint with proper reference period (1991–2020 WMO standard).

**Correct approach using Open-Meteo:**
```
// Reference period: same calendar month, 1991-2020 (30-year WMO normal)
// Step 1: Fetch current 7-day mean for zone
// Step 2: Fetch historical 30-year monthly mean for same month
//         using open-meteo archive: start_date=1991-01-01 end_date=2020-12-31, aggregate monthly
// Step 3: anomaly = current - historical_mean
```

**Expand zones:** Current 15 zones are geopolitically focused. Add climate-specific zones:

- Arctic (70°N, 0°E) — sea ice proxy
- Greenland (72°N, -42°W) — ice sheet melt
- Western Antarctic Ice Sheet (-78°S, -100°W)
- Tibetan Plateau (31°N, 91°E) — third pole
- Congo Basin (-1°N, 24°E) — largest tropical forest after Amazon
- Coral Triangle (-5°S, 128°E) — reef bleaching proxy (sea temp)
- North Atlantic (55°N, -30°W) — AMOC slowdown signal

**No change to cache key `climate:anomalies:v1`** — fix in place.

### Layer 2: CO2 & Greenhouse Gas Monitoring (NEW)

**What:** Real atmospheric CO2 concentration + trend + annual growth rate. The foundational number behind all climate change.

**Sources:**

- **NOAA GML Mauna Loa** (no key, free):
  - Daily CO2: `https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_daily_mlo.txt`
  - Weekly averages: `https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_weekly_mlo.txt`
  - Monthly: `https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_mm_mlo.txt`
- **NOAA global average** (not just Mauna Loa):
  - `https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_annmean_gl.txt`
- **Methane (CH4)**: `https://gml.noaa.gov/webdata/ccgg/trends/ch4/ch4_mm_gl.txt`
- **Nitrous oxide (N2O)**: `https://gml.noaa.gov/webdata/ccgg/trends/n2o/n2o_mm_gl.txt`

**What to compute:**

- Current ppm (today/this week)
- YoY change (ppm/year growth rate)
- Pre-industrial baseline: 280 ppm
- Paris Agreement "safe" level: 450 ppm (1.5°C budget)
- Days since CO2 exceeded 400 ppm (crossed May 2013)

**Redis key:** `climate:co2-monitoring:v1`
**Seed script:** `seed-co2-monitoring.mjs`
**Cache TTL:** 86400 (24h — NOAA updates daily with ~2 day lag)
**Proto RPC:** `GetCo2Monitoring`

```proto
message Co2Monitoring {
  double current_ppm = 1;           // latest daily/weekly reading
  double year_ago_ppm = 2;
  double annual_growth_rate = 3;    // ppm/year
  double pre_industrial_baseline = 4; // 280.0 (hardcoded)
  double monthly_average = 5;
  repeated Co2DataPoint trend_12m = 6;  // monthly readings, last 12 months
  double methane_ppb = 7;
  double nitrous_oxide_ppb = 8;
  int64 measured_at = 9;
  string station = 10;  // "Mauna Loa, Hawaii"
}
message Co2DataPoint {
  string month = 1;   // "YYYY-MM"
  double ppm = 2;
  double anomaly = 3; // vs same month previous year
}
```

### Layer 3: Global Disaster Alerts (NEW — reuse existing seeder data)

**What:** Real-time disaster events with severity scoring. GDACS already runs in the natural events seeder — expose it as a climate layer too, plus add additional disaster sources.

**CRITICAL: Reuse `natural:events:v1` Redis key data** — don't re-seed. Just expose GDACS + wildfire + earthquake data through a climate-domain RPC that filters for climate-relevant events: floods, storms, droughts, wildfires, heat waves.

**Additional sources for climate-specific disaster data:**

- **ReliefWeb API** (no key): `https://api.reliefweb.int/v1/disasters?filter[field]=primary_type&filter[value]=FL` (floods)
  - Disaster types: FL (flood), TC (tropical cyclone), DR (drought), HT (heat wave), WF (wildfire)
  - Returns: disaster name, country, date, GLIDE number, status (alert/ongoing/past)
- **EMDAT EM-DAT** (requires registration — use public export): `https://www.emdat.be/`
  - Use: pre-downloaded static dataset for historical context (annual aggregates)
- **NOAA Storm Prediction Center**: `https://www.spc.noaa.gov/products/outlook/day1otlk_cat.nolhtml` (US only)

**Redis key:** `climate:disasters:v1`
**Seed script:** `seed-climate-disasters.mjs`
**Cache TTL:** 21600 (6h — ReliefWeb updates multiple times daily)
**Proto RPC:** `ListClimateDisasters`

```proto
message ClimateDisaster {
  string id = 1;
  string type = 2;          // "flood" | "cyclone" | "drought" | "wildfire" | "heatwave" | "earthquake"
  string name = 3;
  string country = 4;
  string country_code = 5;
  double lat = 6;
  double lng = 7;
  string severity = 8;      // "green" | "orange" | "red" (GDACS scale) or "low"/"medium"/"high"
  int64 started_at = 9;
  string status = 10;       // "alert" | "ongoing" | "past"
  int32 affected_population = 11;
  string source = 12;       // "GDACS" | "ReliefWeb" | "NASA FIRMS"
  string source_url = 13;
}
```

### Layer 4: Air Quality & Pollution (NEW)

**What:** Global PM2.5, AQI, ozone, NO2 readings — direct output of fossil fuel combustion and climate feedback loops.

**Note:** This layer is SHARED with the Health variant (`health:air-quality:v1`). Climate domain gets the same data but a different RPC focused on pollution sources and trends rather than health risk.

**Sources:**

- **OpenAQ API v3** (no key): `https://api.openaq.org/v3/locations?limit=2000&parameters=pm25`
  - Measurements: PM2.5, PM10, O3, NO2, CO, SO2, BC
  - 12,000+ stations
- **WAQI API** (`WAQI_API_KEY`): city aggregates + dominant pollutant
- **Copernicus Atmosphere Monitoring Service (CAMS)** (free, no key for basic):
  - Global forecast: `https://ads.atmosphere.copernicus.eu/api/v2/` (requires CDS API key)
  - Alternative: CAMS Near-Real-Time: `https://atmosphere.copernicus.eu/charts/packages/nrta/`
- **EPA AirNow** (US): `https://www.airnowapi.org/aq/observation/zipCode/current/?format=application/json&zipCode={zip}&API_KEY={key}`

**Redis key:** `climate:air-quality:v1` (mirrors `health:air-quality:v1` — same seed, separate key)
**Seed script:** Shared with health: `seed-health-air-quality.mjs` writes both keys
**Cache TTL:** 3600 (1h)
**Proto RPC:** `ListAirQualityData`

### Layer 5: Sea Level, Ice & Ocean Data (NEW)

**What:** The long-term physical indicators of climate change — sea level rise, Arctic sea ice, ocean heat.

**Sources:**

- **NSIDC Sea Ice Index** (no key):
  - Daily extent: `https://masie_web.apps.nsidc.org/pub/DATASETS/NOAA/G02135/north/daily/data/N_seaice_extent_daily_v3.0.csv`
  - Monthly anomaly: `https://nsidc.org/data/seaice_index/`
- **NOAA Sea Level Trends** (no key):
  - Gauge data API: `https://tidesandcurrents.noaa.gov/mdapi/latest/webapi/stations.json?type=waterlevels`
  - Trend endpoint: `https://tidesandcurrents.noaa.gov/sltrends/sltrends.html`
- **CSIRO/AVISO global mean sea level** (no key, public):
  - `https://www.cmar.csiro.au/sealevel/sl_data_cmar.html`
- **NOAA OHC (Ocean Heat Content)** — Argo float composite:
  - `https://www.ncei.noaa.gov/data/oceans/woa/WOA23/DATA/`
- **Copernicus Climate Change Service** sea surface temperature anomaly:
  - `https://cds.climate.copernicus.eu/api/v2/` (requires free CDS key)

**Redis key:** `climate:ocean-ice:v1`
**Seed script:** `seed-climate-ocean-ice.mjs`
**Cache TTL:** 86400 (24h — daily/weekly satellite updates)
**Proto RPC:** `GetOceanIceData`

```proto
message OceanIceData {
  // Arctic sea ice
  double arctic_extent_mkm2 = 1;         // million km²
  double arctic_extent_anomaly_mkm2 = 2; // vs 1981-2010 median
  string arctic_trend = 3;               // "record_low" | "below_average" | "average" | "above_average"

  // Global mean sea level
  double sea_level_mm_above_1993 = 4;    // mm above 1993 satellite era baseline
  double sea_level_annual_rise_mm = 5;   // mm/year current rate

  // Ocean heat content
  double ohc_0_700m_zj = 6;             // zettajoules, 0-700m depth
  double sst_anomaly_c = 7;             // global SST anomaly vs 1971-2000

  int64 measured_at = 8;
  repeated IceTrendPoint ice_trend_12m = 9;
}
message IceTrendPoint {
  string month = 1;
  double extent_mkm2 = 2;
  double anomaly_mkm2 = 3;
}
```

### Layer 6: Climate News Intelligence (NEW — news layer)

**What:** Aggregated news from authoritative climate sources with AI tagging for events, policies, records.

**Sources (RSS, no keys):**

- Carbon Brief (10min): `https://www.carbonbrief.org/feed`
- The Guardian Environment (10min): `https://www.theguardian.com/environment/climate-crisis/rss`
- ReliefWeb Disasters (10min): `https://reliefweb.int/updates/rss.xml?content=reports&country=0&theme=4590`
- NASA Earth Observatory: `https://earthobservatory.nasa.gov/feeds/earth-observatory.rss`
- NOAA Climate News: `https://www.noaa.gov/taxonomy/term/28/rss`
- Phys.org Earth Science: `https://phys.org/rss-feed/earth-news/earth-sciences/`
- Copernicus/ECMWF: `https://atmosphere.copernicus.eu/rss`
- Inside Climate News: `https://insideclimatenews.org/feed/`
- Climate Central: `https://www.climatecentral.org/rss`

**Redis key:** `climate:news-intelligence:v1`
**Seed script:** `seed-climate-news.mjs` (or relay loop)
**Cache TTL:** 1800 (30min)
**Proto RPC:** `ListClimateNews`

---

## Seed Script Schedule (Railway Cron)

| Script | Interval | Key | TTL |
|--------|----------|-----|-----|
| `seed-climate-anomalies.mjs` | Every 3h (existing, fix baseline) | `climate:anomalies:v1` | 3h |
| `seed-co2-monitoring.mjs` | Daily 06:00 UTC | `climate:co2-monitoring:v1` | 24h |
| `seed-climate-disasters.mjs` | Every 6h | `climate:disasters:v1` | 6h |
| `seed-health-air-quality.mjs` | Every 1h (shared) | `climate:air-quality:v1` | 1h |
| `seed-climate-ocean-ice.mjs` | Daily 08:00 UTC | `climate:ocean-ice:v1` | 24h |
| `seed-climate-news.mjs` | Every 30min (or relay loop) | `climate:news-intelligence:v1` | 1h |

---

## Proto Service Extension

```proto
service ClimateService {
  rpc ListClimateAnomalies(...)  // EXISTING (fix baseline)
  rpc GetCo2Monitoring(GetCo2MonitoringRequest) returns (GetCo2MonitoringResponse) {
    option (sebuf.http.config) = {path: "/get-co2-monitoring", method: HTTP_METHOD_GET};
  }
  rpc ListClimateDisasters(ListClimateDisastersRequest) returns (ListClimateDisastersResponse) {
    option (sebuf.http.config) = {path: "/list-climate-disasters", method: HTTP_METHOD_GET};
  }
  rpc ListAirQualityData(ListAirQualityDataRequest) returns (ListAirQualityDataResponse) {
    option (sebuf.http.config) = {path: "/list-air-quality-data", method: HTTP_METHOD_GET};
  }
  rpc GetOceanIceData(GetOceanIceDataRequest) returns (GetOceanIceDataResponse) {
    option (sebuf.http.config) = {path: "/get-ocean-ice-data", method: HTTP_METHOD_GET};
  }
  rpc ListClimateNews(ListClimateNewsRequest) returns (ListClimateNewsResponse) {
    option (sebuf.http.config) = {path: "/list-climate-news", method: HTTP_METHOD_GET};
  }
}
```

---

## Cache Keys to Register

Per AGENTS.md, adding a new seeded key requires changes in **4 files**:

1. **`server/_shared/cache-keys.ts`** — add to `BOOTSTRAP_CACHE_KEYS`:

```ts
co2Monitoring: 'climate:co2-monitoring:v1',
climateDisasters: 'climate:disasters:v1',
climateAirQuality: 'climate:air-quality:v1',
oceanIce: 'climate:ocean-ice:v1',
climateNews: 'climate:news-intelligence:v1',
climateZoneNormals: 'climate:zone-normals:v1',
```

2. **`api/health.js`** — add each data key (not zone-normals) to the `BOOTSTRAP_KEYS` array (startup hydration on deploy)

3. **`api/mcp.ts`** — add keys to the `get_climate_data` tool's `_cacheKeys` array (see MCP Tool section below)

4. **Each seed script** — must call `runSeed()` with the correct canonical key so it writes `seed-meta:<domain>:<name>` automatically. The seed-meta key is required for health monitoring (`_seedMetaKey` in the MCP tool).

---

## MCP Tool: Update `get_climate_data`

Replace current entry in `api/mcp.ts`:

```ts
{
  name: 'get_climate_data',
  description: 'Climate intelligence: temperature/precipitation anomalies (vs 30-year WMO normals), atmospheric CO2 trend (NOAA Mauna Loa), global disaster alerts (GDACS/ReliefWeb), air quality (OpenAQ/WAQI), sea level rise and Arctic ice extent (NSIDC/NOAA), and climate news.',
  inputSchema: {
    type: 'object',
    properties: {
      layer: { type: 'string', description: '"anomalies" | "co2" | "disasters" | "air-quality" | "ocean-ice" | "news" | empty for all' },
      region: { type: 'string', description: 'Region or zone name filter' },
    },
    required: [],
  },
  _cacheKeys: [
    'climate:anomalies:v1',
    'climate:co2-monitoring:v1',
    'climate:disasters:v1',
    'climate:air-quality:v1',
    'climate:ocean-ice:v1',
    'climate:news-intelligence:v1',
  ],
  _seedMetaKey: 'seed-meta:climate:anomalies',
  _maxStaleMin: 120,
}
```

---

## External API Keys Required

| Service | Key Name | Free Tier |
|---------|----------|-----------|
| WAQI (air quality) | `WAQI_API_KEY` | 1000 req/day |
| OpenAQ | None | Free |
| NOAA GML | None | Free |
| NSIDC | None | Free |
| ReliefWeb API | None | Free |
| RSS feeds (all) | None | Public |
| Copernicus CDS | `CDS_API_KEY` | Free (registration required) — only needed for CAMS/ERA5 advanced queries |

**Only 1-2 new API keys required.** WAQI is optional (OpenAQ alone is sufficient). CDS key is optional (enhances but not required).

---

## Priority Fix: Anomaly Baseline

**Before any new layer work**, fix `seed-climate-anomalies.mjs`:

```js
// WRONG (current): compare last 7d vs previous 23d of same 30d window
// RIGHT: compare last 7d vs 30-year monthly mean (1991–2020 WMO standard)

// Implementation: fetch Open-Meteo archive with start_date=1991-01-01 end_date=2020-12-31,
// aggregate daily values by calendar month to get monthly mean per zone.
// IMPORTANT: use the full 1991-2020 period — do NOT use a shorter "proxy" window
// (e.g., 2014-2023) as a warm decade would systematically understate current anomalies.
const NORMALS_KEY = 'climate:zone-normals:v1';
const NORMALS_TTL = 30 * 86400; // 30 days — recalculate monthly
```

The 30-year normal fetch should run as a separate monthly seed and cache in `climate:zone-normals:v1`, then `seed-climate-anomalies.mjs` reads that as its baseline. This is one fetch per zone per year instead of per run.

---

## Frontend Variant: `climate.worldmonitor.app`

Add to `src/config/variant.ts`:

```ts
climate: {
  defaultPanels: ['climate-anomalies', 'co2-monitoring', 'climate-disasters', 'ocean-ice', 'air-quality', 'climate-news'],
  mapLayers: ['climate-anomalies-heatmap', 'disasters', 'air-quality', 'wildfire'],
  theme: { primaryColor: '#00AA55', accentColor: '#FF6600' },
  refreshIntervals: { anomalies: 3 * 60, co2: 24 * 60, disasters: 6 * 60, news: 30 },
  i18n: { title: 'Climate Intelligence', subtitle: 'Atmospheric, Ocean & Disaster Monitoring' },
}
```

---

## Implementation Order

1. **Fix `seed-climate-anomalies.mjs` baseline** — high priority, improves existing data quality immediately
2. **`seed-co2-monitoring.mjs`** — NOAA GML text file parsing, no key, 30min effort, high impact (single most important climate number)
3. **`seed-climate-news.mjs`** — RSS aggregation, no key, fast win
4. **`seed-climate-disasters.mjs`** — ReliefWeb API (no key) + reuse GDACS from natural seeder
5. **`seed-health-air-quality.mjs`** — OpenAQ (no key), writes both `health:air-quality:v1` and `climate:air-quality:v1`
6. **`seed-climate-ocean-ice.mjs`** — NSIDC CSV parsing (no key), daily data
7. **`seed-climate-zone-normals.mjs`** — one-time + monthly refresh, feeds anomaly baseline
8. **Proto + handler additions** for each new RPC
9. **Update MCP tool** `get_climate_data` with new cache keys
10. **Hostname variant config** `climate.worldmonitor.app`
