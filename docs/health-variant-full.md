# Health Variant: Full Implementation Plan

## Current State

| Component | Status |
|-----------|--------|
| Proto RPCs | 1 — `ListDiseaseOutbreaks` |
| Redis keys | 3 — `health:disease-outbreaks:v1`, `health:vpd-tracker:realtime:v1`, `health:vpd-tracker:historical:v1` |
| Seed scripts | 2 — `seed-disease-outbreaks.mjs`, `seed-vpd-tracker.mjs` |
| MCP tool | None registered under `get_health_data` |
| Hostname variant | Not configured |

The disease outbreaks seeder is solid (WHO DON API + CDC + Outbreak News Today + ThinkGlobalHealth/ProMED, 150 geo-pinned alerts). VPD tracker has good historical WHO annual case data. Everything else is missing.

---

## Target State: 6 Data Layers

### Layer 1: Disease Outbreaks (EXISTING — enhance only)

**Current:** WHO DON API + CDC RSS + ThinkGlobalHealth/ProMED

**Enhancements needed:**

- Add ECDC (European Centre for Disease Prevention) RSS: `https://www.ecdc.europa.eu/en/rss.xml`
- Add PAHO Americas alerts: `https://www.paho.org/en/rss.xml`
- Add STAT News (fast-breaking): `https://www.statnews.com/feed/`
- Add bioRxiv Microbiology preprints (early signal): `https://www.biorxiv.org/rss/current/microbiology`
- Add The Lancet Infectious Diseases RSS: `https://www.thelancet.com/rssfeed/laninf_current.xml`
- Cases field is often 0 — pull ECDC case data where available to fill
- No change to existing cache key `health:disease-outbreaks:v1`

### Layer 2: Epidemic Trends (NEW)

**What:** Time-series case/death counts per disease/country — gives the chart line, not just the dot on the map.

**Sources:**

- **Our World in Data disease data API** (no key): `https://ourworldindata.org/grapher/mpox-cases-and-deaths.csv` (per disease)
- **WHO GHO Indicator API** (no key): `https://ghoapi.azureedge.net/api/` — indicators like `MORBIDITY_DENGUE`, `VACCINATIONHEPB3`, etc.
  - Endpoint pattern: `https://ghoapi.azureedge.net/api/{indicator}?$filter=SpatialDim eq '{ISO3}'`
- **CDC surveillance data** (no key): `https://data.cdc.gov/resource/{dataset}.json` (Socrata)
- **Nextstrain SARS-CoV-2** (lineage frequency): `https://nextstrain.org/charon/getDataset?prefix=/ncov/gisaid/global/6m`

**Redis key:** `health:epidemic-trends:v1`
**Seed script:** `seed-epidemic-trends.mjs`
**Cache TTL:** 86400 (24h — daily refresh)
**Proto RPC:** `ListEpidemicTrends` → returns `EpidemicTrendItem[]`

```proto
message EpidemicTrendItem {
  string disease = 1;
  string country_code = 2;
  string country = 3;
  repeated DataPoint weekly_cases = 4;  // last 12 weeks
  repeated DataPoint weekly_deaths = 5;
  double r_number = 6;          // reproduction number (0 = unknown)
  string trend = 7;             // "rising" | "falling" | "stable"
  string source = 8;
}
message DataPoint {
  string date = 1;  // YYYY-MM-DD (week start)
  int32 value = 2;
}
```

### Layer 3: Vaccination Coverage (NEW)

**What:** Coverage rates by vaccine and country — essential for pandemic preparedness context.

**Sources:**

- **WHO Immunization Data Portal** (no key): `https://immunizationdata.who.int/api/v1/coverage?ANTIGEN={antigen}&YEAR={year}`
  - Antigens: MCV1, MCV2, DTP3, Pol3, HepB3, Hib3, PCV3, RCV1
- **UNICEF State of the World's Children** — coverage gaps for low-income countries
- **CDC NIS (National Immunization Survey)** US sub-national data

**Redis key:** `health:vaccination-coverage:v1`
**Seed script:** `seed-vaccination-coverage.mjs`
**Cache TTL:** 604800 (7 days — weekly; WHO updates monthly)
**Proto RPC:** `GetVaccinationCoverage` → returns coverage by country + vaccine

```proto
message VaccinationCoverageItem {
  string id = 1;                // "{country_code}:{vaccine}:{year}"
  string country_code = 2;
  string country = 3;
  string vaccine = 4;           // "MCV1", "DTP3", etc.
  int32 year = 5;
  int32 coverage_pct = 6;       // 0–100
  string target_population = 7; // "infants", "adolescents", etc.
  bool below_threshold = 8;     // < 95% herd immunity threshold
}
```

### Layer 4: Air Quality Health Risk (NEW)

**What:** PM2.5 / AQI global readings mapped to health risk zones — direct bridge between climate/environment and health.

**Sources:**

- **OpenAQ API v3** (`OPENAQ_API_KEY`): `https://api.openaq.org/v3/locations?limit=1000&parameters_id=2&bbox={bbox}`
  - Readings: `https://api.openaq.org/v3/sensors/{id}/measurements/daily`
  - 12,000+ stations globally, free tier sufficient
- **WAQI (World Air Quality Index)** — city-level aggregation: `https://api.waqi.info/map/bounds/?latlng={bbox}&token={key}`
  - Key: `WAQI_API_KEY` (free tier: 1000 req/day)
- **WHO AQI guidelines** as threshold overlay (hardcoded: PM2.5 annual mean > 15 µg/m³ = WHO limit)

**Redis key:** `health:air-quality:v1`
**Seed script:** `seed-health-air-quality.mjs`
**Cache TTL:** 3600 (1h — hourly data available)
**Proto RPC:** `ListAirQualityAlerts` → returns stations above WHO thresholds with health risk classification

```proto
message AirQualityAlert {
  string city = 1;
  string country_code = 2;
  double lat = 3;
  double lng = 4;
  double pm25 = 5;          // µg/m³
  int32 aqi = 6;            // 0–500 US AQI scale
  string risk_level = 7;    // "good" | "moderate" | "unhealthy" | "hazardous"
  string pollutant = 8;     // primary pollutant driving AQI
  int64 measured_at = 9;
  string source = 10;       // "OpenAQ" | "WAQI"
}
```

### Layer 5: Pathogen Surveillance (NEW)

**What:** Emerging pathogen/variant tracking — early warning for novel strains.

**Sources:**

- **Nextstrain** (no key): open JSON builds for flu, mpox, RSV, COVID lineages
  - `https://nextstrain.org/charon/getDataset?prefix=/flu/seasonal/h3n2/ha/2y`
  - `https://nextstrain.org/charon/getDataset?prefix=/mpox/all-clades`
- **GISAID surveillance reports** (public summaries only, not sequences)
- **WHO Weekly Epidemiological Record** RSS: `https://www.who.int/publications/journals/weekly-epidemiological-record/rss`
- **ProMED-mail** full feed (already partially via ThinkGlobalHealth): `https://promedmail.org/feed/`

**Redis key:** `health:pathogen-surveillance:v1`
**Seed script:** `seed-pathogen-surveillance.mjs`
**Cache TTL:** 43200 (12h)
**Proto RPC:** `ListPathogenAlerts` → returns active variant/lineage alerts with geographic spread

```proto
message PathogenAlert {
  string pathogen = 1;          // "H5N1", "SARS-CoV-2 XEC", "Mpox Clade Ib"
  string family = 2;            // "influenza", "coronavirus", "orthopoxvirus"
  string alert_type = 3;        // "novel_variant" | "geographic_spread" | "severity_change"
  string description = 4;
  repeated string countries = 5;
  string who_risk_assessment = 6; // "low" | "moderate" | "high" | "unknown"
  int64 published_at = 7;
  string source_url = 8;
  string source = 9;
}
```

### Layer 6: Global Health News Intelligence (NEW — news layer)

**What:** Aggregated health/medical news from authoritative sources with AI tagging.

**Sources (RSS, no keys):**

- STAT News (10min): `https://www.statnews.com/feed/`
- WHO News: `https://www.who.int/rss-feeds/news-english.xml`
- NIH Latest News: `https://www.nih.gov/rss/news/news.rss`
- CDC Newsroom: `https://tools.cdc.gov/api/v2/resources/media/404952.rss`
- The Lancet: `https://www.thelancet.com/rssfeed/lancet_current.xml`
- New England Journal of Medicine: `https://www.nejm.org/action/showFeed?type=etoc&feed=rss`
- bioRxiv Microbiology: `https://www.biorxiv.org/rss/current/microbiology`
- Global Health Now (Johns Hopkins): `https://www.globalhealthnow.org/rss`

**Redis key:** `health:news-intelligence:v1`
**Seed script:** `seed-health-news.mjs` (or add to `ais-relay.cjs` as a loop)
**Cache TTL:** 1800 (30min)
**Proto RPC:** `ListHealthNews` → normalized news items with disease/entity tagging

---

## Seed Script Schedule (Railway Cron)

| Script | Interval | Key | TTL |
|--------|----------|-----|-----|
| `seed-disease-outbreaks.mjs` | Every 6h (existing) | `health:disease-outbreaks:v1` | 72h |
| `seed-vpd-tracker.mjs` | Daily (existing) | `health:vpd-tracker:realtime:v1` | 72h |
| `seed-epidemic-trends.mjs` | Daily | `health:epidemic-trends:v1` | 24h |
| `seed-vaccination-coverage.mjs` | Weekly (Sunday 02:00 UTC) | `health:vaccination-coverage:v1` | 7 days |
| `seed-health-air-quality.mjs` | Every 1h | `health:air-quality:v1` | 1h |
| `seed-pathogen-surveillance.mjs` | Every 12h | `health:pathogen-surveillance:v1` | 24h |
| `seed-health-news.mjs` | Every 30min (or relay loop) | `health:news-intelligence:v1` | 1h |

---

## Proto Service Extension

```proto
// service.proto additions
service HealthService {
  rpc ListDiseaseOutbreaks(...)  // EXISTING
  rpc ListEpidemicTrends(ListEpidemicTrendsRequest) returns (ListEpidemicTrendsResponse) {
    option (sebuf.http.config) = {path: "/list-epidemic-trends", method: HTTP_METHOD_GET};
  }
  rpc GetVaccinationCoverage(GetVaccinationCoverageRequest) returns (GetVaccinationCoverageResponse) {
    option (sebuf.http.config) = {path: "/get-vaccination-coverage", method: HTTP_METHOD_GET};
  }
  rpc ListAirQualityAlerts(ListAirQualityAlertsRequest) returns (ListAirQualityAlertsResponse) {
    option (sebuf.http.config) = {path: "/list-air-quality-alerts", method: HTTP_METHOD_GET};
  }
  rpc ListPathogenAlerts(ListPathogenAlertsRequest) returns (ListPathogenAlertsResponse) {
    option (sebuf.http.config) = {path: "/list-pathogen-alerts", method: HTTP_METHOD_GET};
  }
  rpc ListHealthNews(ListHealthNewsRequest) returns (ListHealthNewsResponse) {
    option (sebuf.http.config) = {path: "/list-health-news", method: HTTP_METHOD_GET};
  }
}
```

---

## Cache Keys to Register

Per AGENTS.md, adding a new seeded key requires changes in **4 files**:

1. **`server/_shared/cache-keys.ts`** — add to `BOOTSTRAP_CACHE_KEYS`:

```ts
epidemicTrends: 'health:epidemic-trends:v1',
vaccinationCoverage: 'health:vaccination-coverage:v1',
airQuality: 'health:air-quality:v1',
pathogenSurveillance: 'health:pathogen-surveillance:v1',
healthNews: 'health:news-intelligence:v1',
```

2. **`api/health.js`** — add each key to the `BOOTSTRAP_KEYS` array (startup hydration on deploy)

3. **`api/mcp.ts`** — add keys to the relevant MCP tool's `_cacheKeys` array (see MCP Tool section below)

4. **Each seed script** — must call `runSeed()` with the correct canonical key so it writes `seed-meta:<domain>:<name>` automatically. The seed-meta key is required for health monitoring (`_seedMetaKey` in the MCP tool).

---

## MCP Tool: `get_health_data`

Register in `api/mcp.ts`:

```ts
{
  name: 'get_health_data',
  description: 'Global health intelligence: disease outbreaks (WHO/ProMED/CDC), epidemic case trends, vaccination coverage gaps, air quality health risk, pathogen/variant surveillance, and health news.',
  inputSchema: {
    type: 'object',
    properties: {
      layer: { type: 'string', description: '"outbreaks" | "trends" | "vaccination" | "air-quality" | "pathogens" | "news" | empty for all' },
      country: { type: 'string', description: 'ISO2 country code filter' },
    },
    required: [],
  },
  _cacheKeys: [
    'health:disease-outbreaks:v1',
    'health:vpd-tracker:realtime:v1',
    'health:epidemic-trends:v1',
    'health:vaccination-coverage:v1',
    'health:air-quality:v1',
    'health:pathogen-surveillance:v1',
    'health:news-intelligence:v1',
  ],
  _seedMetaKey: 'seed-meta:health:disease-outbreaks',
  _maxStaleMin: 360,
}
```

---

## Frontend Variant: `health.worldmonitor.app`

Add to `src/config/variant.ts`:

```ts
health: {
  defaultPanels: ['disease-outbreaks', 'epidemic-trends', 'pathogen-alerts', 'health-news', 'vaccination-coverage', 'air-quality'],
  mapLayers: ['disease-outbreaks', 'air-quality', 'vaccination-gaps'],
  theme: { primaryColor: '#0099DD', accentColor: '#E53935' },
  refreshIntervals: { outbreaks: 6 * 60, news: 30, airQuality: 60 },
  i18n: { title: 'Health Intelligence', subtitle: 'Global Disease & Epidemic Monitoring' },
}
```

---

## External API Keys Required

| Service | Key Name | Free Tier |
|---------|----------|-----------|
| WAQI (air quality) | `WAQI_API_KEY` | 1000 req/day (sufficient for hourly city aggregation) |
| OpenAQ v3 (air quality) | `OPENAQ_API_KEY` | Required by current API docs |
| WHO GHO API | None required | Free, public |
| Our World in Data | None required | Free, public CSV |
| Nextstrain | None required | Free, public JSON |
| RSS feeds (all) | None required | Public |

**At least 1 new API key is required (`OPENAQ_API_KEY`)**. `WAQI_API_KEY` remains optional; the seed still works with OpenAQ alone.

---

## Implementation Order

1. **Enhance existing disease outbreaks seed** — add ECDC + PAHO + STAT News + Lancet RSS (low risk, existing pattern)
2. **`seed-health-news.mjs`** — pure RSS aggregation, no key needed, fast win
3. **`seed-pathogen-surveillance.mjs`** — Nextstrain JSON + WHO WER RSS
4. **`seed-epidemic-trends.mjs`** — WHO GHO API (no key, daily data)
5. **`seed-health-air-quality.mjs`** — OpenAQ (`OPENAQ_API_KEY`) + optional WAQI
6. **`seed-vaccination-coverage.mjs`** — WHO immunization API (weekly, lowest priority)
7. **Proto + handler additions** for each new RPC
8. **MCP tool registration** `get_health_data`
9. **Hostname variant config** `health.worldmonitor.app`
