---
title: "Algorithms & Scoring"
description: "Detailed documentation of World Monitor's scoring formulas, detection algorithms, and classification pipelines."
---

# Algorithms & Scoring

Detailed documentation of World Monitor's scoring formulas, detection algorithms, and classification pipelines.

---

## Country & Regional Scoring

### Country Instability Index (CII)

Every country with incoming event data receives a live instability score (0-100). 24 curated tier-1 nations (US, Russia, China, Ukraine, Iran, Israel, Taiwan, North Korea, Saudi Arabia, Turkey, Poland, Germany, France, UK, India, Pakistan, Syria, Yemen, Myanmar, Venezuela, Cuba, Mexico, Brazil, UAE) have individually tuned baseline risk profiles and keyword lists. All other countries that generate any signal (protests, conflicts, outages, displacement flows, climate anomalies) are scored automatically using a universal default baseline (`DEFAULT_BASELINE_RISK = 15`, `DEFAULT_EVENT_MULTIPLIER = 1.0`).

The server-side score (`get-risk-scores.ts`) uses the same formulas as the frontend (`country-instability.ts`):

| Component            | Weight | Details |
| -------------------- | ------ | ------- |
| **Baseline risk**    | 40%    | Pre-configured per country reflecting structural fragility (0-50 scale) |
| **Event score**      | 60%    | Blend of Unrest (25%), Conflict (30%), Security (20%), Information (25%) |

**Unrest score** (0-100): Log2 dampening for high-volume low-multiplier countries (`multiplier < 0.7`), linear otherwise. Base capped at 50, plus protest/riot fatality boost (up to 30), plus outage severity boost (TOTAL: 30pts, MAJOR: 15pts, PARTIAL: 5pts, capped at 50).

**Conflict score** (0-100): Weighted ACLED events (battles x3, explosions x4, civilian violence x5, capped at 50), sqrt-scaled fatalities (up to 40), civilian boost (up to 10), Iran strike boost with severity weighting (up to 50), and OREF alert boost for Israel (25 base + 5 per active alert, up to 50 total).

**Security score** (0-100): GPS/GNSS jamming (high: 5pts, medium: 2pts per hex, capped at 35).

**Information score**: Reserved (0); no server-side news data available.

**Floors**: UCDP active war pins score at >= 70, UCDP minor conflict at >= 50. Travel advisory do-not-travel pins at >= 60, reconsider at >= 50.

**Boosts**: Advisory boost (+15 do-not-travel, +10 reconsider, +5 caution), OREF blend boost for Israel (+15 active alerts, +5/10 based on 24h history count), climate severity (up to +15), cyber threats (up to +10), wildfires (up to +8).

### Hotspot Escalation Scoring

Intelligence hotspots receive dynamic escalation scores blending four normalized signals (0–100):

- **News activity** (35%) — article count and severity in the hotspot's area
- **Country instability** (25%) — CII score of the host country
- **Geo-convergence alerts** (25%) — spatial binning detects 3+ event types (protests + military + earthquakes) co-occurring within 1° lat/lon cells
- **Military activity** (15%) — vessel clusters and flight density near the hotspot

The system blends static baseline risk (40%) with detected events (60%) and tracks trends via linear regression on 48-hour history. Signal emissions cool down for 2 hours to prevent alert fatigue.

### Geographic Convergence Detection

Events (protests, military flights, vessels, earthquakes) are binned into 1°×1° geographic cells within a 24-hour window. When 3+ distinct event types converge in one cell, a convergence alert fires. Scoring is based on type diversity (×25pts per unique type) plus event count bonuses (×2pts). Alerts are reverse-geocoded to human-readable names using conflict zones, waterways, and hotspot databases.

### Strategic Risk Score Algorithm

The Strategic Risk panel computes a 0–100 composite geopolitical risk score that synthesizes data from all intelligence modules into a single, continuously updated metric.

**Composite formula**:

```
compositeScore =
    convergenceScore × 0.30     // multi-type events co-located in same H3 cell
  + ciiRiskScore     × 0.50     // CII top-5 country weighted blend
  + infraScore       × 0.20     // infrastructure cascade incidents
  + theaterBoost     (0–25)     // military asset density + strike packaging
  + breakingBoost    (0–15)     // breaking news severity injection
```

**Sub-scores**:

- `convergenceScore` — `min(100, convergenceAlertCount × 25)`. Each geographic cell with 3+ distinct event types contributing 25 points
- `ciiRiskScore` — Top 5 countries by CII score, weighted `[0.40, 0.25, 0.20, 0.10, 0.05]`, with a bonus of `min(20, elevatedCount × 5)` for each country above CII 50
- `infraScore` — `min(100, cascadeAlertCount × 25)`. Each infrastructure cascade incident contributing 25 points
- `theaterBoost` — For each theater posture summary: `min(10, floor((aircraft + vessels) / 5))` + 5 if strike-capable (tanker + AWACS + fighters co-present). Summed across theaters, capped at 25. Halved when posture data is stale
- `breakingBoost` — Critical breaking news alerts add 15 points, high adds 8, capped at 15. Breaking alerts expire after 30 minutes

**Alert fusion**: Alerts from convergence detection, CII spikes (≥10-point change), and infrastructure cascades are merged when they occur within a 2-hour window and are within 200km or in the same country. Merged alerts carry the highest priority and combine summaries. The alert queue caps at 50 entries with 24-hour pruning.

**Trend detection**: Delta ≥3 from previous composite = "escalating", ≤−3 = "de-escalating", otherwise "stable". A 15-minute learning period after panel initialization suppresses CII spike alerts to prevent false positives from initial data loading.

### Population Exposure Estimation

Active events (conflicts, earthquakes, floods, wildfires) are cross-referenced against WorldPop population density data to estimate the number of civilians within the impact zone. Event-specific radii reflect typical impact footprints:

| Event Type      | Radius | Rationale                                |
| --------------- | ------ | ---------------------------------------- |
| **Conflicts**   | 50 km  | Direct combat zone + displacement buffer |
| **Earthquakes** | 100 km | Shaking intensity propagation            |
| **Floods**      | 100 km | Watershed and drainage basin extent      |
| **Wildfires**   | 30 km  | Smoke and evacuation perimeter           |

API calls to WorldPop are batched concurrently (max 10 parallel requests) to handle multiple simultaneous events without sequential bottlenecks. The Population Exposure panel displays a summary header with total affected population and a per-event breakdown table.

---

## Military & Strategic

### Strategic Theater Posture Assessment

Nine operational theaters are continuously assessed for military posture escalation:

| Theater               | Key Trigger                                 |
| --------------------- | ------------------------------------------- |
| Iran / Persian Gulf   | Carrier groups, tanker activity, AWACS      |
| Taiwan Strait         | PLAAF sorties, USN carrier presence         |
| Baltic / Kaliningrad  | Russian Western Military District flights   |
| Korean Peninsula      | B-52/B-1 deployments, DPRK missile activity |
| Eastern Mediterranean | Multi-national naval exercises              |
| Horn of Africa        | Anti-piracy patrols, drone activity         |
| South China Sea       | Freedom of navigation operations            |
| Arctic                | Long-range aviation patrols                 |
| Black Sea             | ISR flights, naval movements                |

Posture levels escalate from NORMAL → ELEVATED → CRITICAL based on a composite of:

- **Aircraft count** in theater (both resident and transient)
- **Strike capability** — the presence of tankers + AWACS + fighters together indicates strike packaging, not routine training
- **Naval presence** — carrier groups and combatant formations
- **Country instability** — high CII scores for theater-adjacent countries amplify posture

Each theater is linked to 38+ military bases, enabling automatic correlation between observed flights and known operating locations.

### Military Surge & Foreign Presence Detection

The system monitors five operational theaters (Middle East, Eastern Europe, Western Europe, Western Pacific, Horn of Africa) with 38+ associated military bases. It classifies vessel clusters near hotspots by activity type:

- **Deployment** — carrier present with 5+ vessels
- **Exercise** — combatants present in formation
- **Transit** — vessels passing through

Foreign military presence is dual-credited: the operator's country is flagged for force projection, and the host location's country is flagged for foreign military threat. AIS gaps (dark ships) are flagged as potential signal discipline indicators.

### USNI Fleet Intelligence

The dashboard ingests weekly U.S. Naval Institute (USNI) fleet deployment reports and merges them with live AIS vessel tracking data. Each report is parsed for carrier strike groups, amphibious ready groups, and individual combatant deployments — extracting hull numbers, vessel names, operational regions, and mission notes.

The merge algorithm matches USNI entries against live AIS-tracked vessels by hull number and normalized name. Matched vessels receive enrichment: strike group assignment, deployment status (deployed / returning / in-port), and operational theater. Unmatched USNI entries (submarines, vessels running dark) generate synthetic positions based on the last known operational region, with coordinate scattering to prevent marker overlap.

This dual-source approach provides a more complete operational picture than either AIS or USNI alone — AIS reveals real-time positions but misses submarines and vessels with transponders off, while USNI captures the complete order of battle but with weekly lag.

### Aircraft Enrichment

Military flights detected via ADS-B transponder data are enriched through the Wingbits aviation intelligence API, which provides aircraft registration, manufacturer, model, owner, and operator details. Each flight receives a military confidence classification:

| Confidence    | Criteria                                                         |
| ------------- | ---------------------------------------------------------------- |
| **Confirmed** | Operator matches a known military branch or defense contractor  |
| **Likely**    | Aircraft type is exclusively military (tanker, AWACS, fighter)  |
| **Possible**  | Government-registered aircraft in a military operating area      |
| **Civilian**  | No military indicators detected                                 |

Enrichment queries are batched (up to 50 aircraft per request) and cached with a circuit breaker pattern to avoid hammering the upstream API during high-traffic periods. The enriched metadata feeds into the Theater Posture Assessment — a KC-135 tanker paired with F-15s and an E-3 AWACS indicates strike packaging, not routine training.

---

## Infrastructure

### Undersea Cable Health Monitoring

Beyond displaying static cable routes on the map, the system actively monitors cable health by cross-referencing two live data sources:

1. **NGA Navigational Warnings** — the U.S. National Geospatial-Intelligence Agency publishes maritime safety broadcasts that frequently mention cable repair operations. The system filters these warnings for cable-related keywords (`CABLE`, `CABLESHIP`, `SUBMARINE CABLE`, `FIBER OPTIC`, etc.) and extracts structured data: vessel names, DMS/decimal coordinates, advisory severity, and repair ETAs. Each warning is matched to the nearest cataloged undersea cable within a 5° geographic radius.

2. **AIS Cable Ship Tracking** — dedicated cable repair vessels (CS Reliance, Île de Bréhat, Cable Innovator, etc.) are identified by name pattern matching against AIS transponder data. Ship status is classified as `enroute` (transiting to repair site) or `on-station` (actively working) based on keyword analysis of the warning text.

Advisories are classified by severity: `fault` (cable break, cut, or damage — potential traffic rerouting) or `degraded` (repair work in progress with partial capacity). Impact descriptions are generated dynamically, linking the advisory to the specific cable and the countries it serves — enabling questions like "which cables serving South Asia are currently under repair?"

**Health scoring algorithm** — Each cable receives a composite health score (0–100) computed from weighted signals with exponential time decay:

```
signal_weight = severity × (e^(-λ × age_hours))     where λ = ln(2) / 168 (7-day half-life)
health_score  = max(0, 100 − Σ(signal_weights) × 100)
```

Signals are classified into two kinds: `operator_fault` (confirmed cable damage — severity 1.0) and `cable_advisory` (repair operations, navigational warnings — severity 0.6). Geographic matching uses cosine-latitude-corrected equirectangular approximation to find the nearest cataloged cable within 50km of each NGA warning's coordinates. Results are cached in Redis (6-hour TTL for complete results, 10 minutes for partial) with an in-memory fallback that serves stale data when Redis is unavailable — ensuring the cable health layer never shows blank data even during cache failures.

### Infrastructure Cascade Modeling

Beyond proximity correlation, the system models how disruptions propagate through interconnected infrastructure. A dependency graph connects undersea cables, pipelines, ports, chokepoints, and countries with weighted edges representing capacity dependencies:

```
Disruption Event → Affected Node → Cascade Propagation (BFS, depth ≤ 3)
                                          │
                    ┌─────────────────────┤
                    ▼                     ▼
            Direct Impact         Indirect Impact
         (e.g., cable cut)    (countries served by cable)
```

**Impact calculation**: `strength = edge_weight × disruption_level × (1 − redundancy)`

Strategic chokepoint modeling captures real-world dependencies:

- **Strait of Hormuz** — 80% of Japan's oil, 70% of South Korea's, 60% of India's, 40% of China's
- **Suez Canal** — EU-Asia trade routes (Germany, Italy, UK, China)
- **Malacca Strait** — 80% of China's oil transit

Ports are weighted by type: oil/LNG terminals (0.9 — critical), container ports (0.7), naval bases (0.4 — geopolitical but less economic). This enables questions like "if the Strait of Hormuz closes, which countries face energy shortages within 30 days?"

### Related Assets & Proximity Correlation

When a news event is geo-located, the system automatically identifies critical infrastructure within a 600km radius — pipelines, undersea cables, data centers, military bases, and nuclear facilities — ranked by distance. This enables instant geopolitical context: a cable cut near a strategic chokepoint, a protest near a nuclear facility, or troop movements near a data center cluster.

---

## News & Entity Analysis

### News Geo-Location

A 217-hub strategic location database infers geography from headlines via keyword matching. Hubs span capitals, conflict zones, strategic chokepoints (Strait of Hormuz, Suez Canal, Malacca Strait), and international organizations. Confidence scoring is boosted for critical-tier hubs and active conflict zones, enabling map-driven news placement without requiring explicit location metadata from RSS feeds.

### Entity Index & Cross-Referencing

A structured entity registry catalogs countries, organizations, world leaders, and military entities with multiple lookup indices:

| Index Type        | Purpose               | Example                                         |
| ----------------- | --------------------- | ----------------------------------------------- |
| **ID index**      | Direct entity lookup  | `entity:us` → United States profile             |
| **Alias index**   | Name variant matching | "America", "USA", "United States" → same entity |
| **Keyword index** | Contextual detection  | "Pentagon", "White House" → United States       |
| **Sector index**  | Domain grouping       | "military", "energy", "tech"                    |
| **Type index**    | Category filtering    | "country", "organization", "leader"             |

Entity matching uses word-boundary regex to prevent false positives (e.g., "Iran" matching "Ukraine"). Confidence scores are tiered by match quality: exact name matches score 1.0, aliases 0.85–0.95, and keyword matches 0.7. When the same entity surfaces across multiple independent data sources (news, military tracking, protest feeds, market signals), the system identifies it as a focal point and escalates its prominence in the intelligence picture.

### News Importance Scoring

The AI Insights panel ranks news items by geopolitical significance using a multi-signal importance scoring algorithm. Rather than displaying stories in chronological order, the algorithm surfaces the most consequential developments by applying keyword-weighted scoring across five severity tiers:

| Category | Base Score | Per-Match Bonus | Keywords |
| --- | --- | --- | --- |
| **Violence** | +100 | +25 | killed, dead, death, shot, casualty, massacre, crackdown |
| **Military** | +80 | +20 | war, invasion, airstrike, missile, troops, combat, fleet |
| **Unrest** | +40 | +15 | protest, uprising, riot, demonstration, revolution |
| **Flashpoint** | — | +20 | iran, russia, china, taiwan, ukraine, israel, gaza, north korea, syria, yemen, hamas, hezbollah, nato, kremlin |
| **Crisis** | — | +10 | sanctions, escalation, breaking, urgent, humanitarian |

**Source confirmation boost** — each additional independent source reporting the same story adds +10 points, rewarding multi-source corroboration over single-source reporting.

**Demotion keywords** — corporate and financial noise (CEO, earnings, stock, startup, revenue) reduces scores, preventing business news from crowding out geopolitical developments in the full/geopolitical variant.

**Theater posture integration** — when the Strategic Posture Assessment detects elevated military activity (e.g., unusual flight patterns in a theater), related news stories receive additional scoring boosts, surfacing contextually relevant reporting alongside the military signal.

The scored list feeds into the World Brief generation pipeline, where the top-ranked stories are selected for LLM summarization. Server-side insights (via `seed-insights.mjs`) pre-compute the scored digest and cache it as `news:insights:v1` for bootstrap hydration, so the panel renders instantly with pre-ranked stories on page load.

### Trending Keyword Spike Detection

Every RSS headline is tokenized into individual terms and tracked in per-term frequency maps. A 2-hour rolling window captures current activity while a 7-day baseline (refreshed hourly) establishes what "normal" looks like for each term. A spike fires when all conditions are met:

| Condition            | Threshold                                     |
| -------------------- | --------------------------------------------- |
| **Absolute count**   | > `minSpikeCount` (5 mentions)                |
| **Relative surge**   | > baseline × `spikeMultiplier` (3×)           |
| **Source diversity** | ≥ 2 unique RSS feed sources                   |
| **Cooldown**         | 30 minutes since last spike for the same term |

The tokenizer extracts CVE identifiers (`CVE-2024-xxxxx`), APT/FIN threat actor designators, and 12 compound terms for world leaders (e.g., "Xi Jinping", "Kim Jong Un") that would be lost by naive whitespace splitting. A configurable blocklist suppresses common noise terms.

Detected spikes are auto-summarized via Groq (rate-limited to 5 summaries/hour) and emitted as `keyword_spike` signals into the correlation engine, where they compound with other signal types for convergence detection. The term registry is capped at 10,000 entries with LRU eviction to bound memory usage. All thresholds (spike multiplier, min count, cooldown, blocked terms) are configurable via the Settings panel.

### Temporal Baseline Anomaly Detection

Rather than relying on static thresholds, the system learns what "normal" looks like and flags deviations. Each event type (military flights, naval vessels, protests, news velocity, AIS gaps, satellite fires) is tracked per region with separate baselines for each weekday and month — because military activity patterns differ on Tuesdays vs. weekends, and January vs. July.

The algorithm uses **Welford's online method** for numerically stable streaming computation of mean and variance, stored in Redis with a 90-day rolling window. When a new observation arrives, its z-score is computed against the learned baseline. Thresholds:

| Z-Score | Severity      | Example                            |
| ------- | ------------- | ---------------------------------- |
| ≥ 1.5   | Low           | Slightly elevated protest activity |
| ≥ 2.0   | Medium        | Unusual naval presence             |
| ≥ 3.0   | High/Critical | Military flights 3x above baseline |

A minimum of 10 historical samples is required before anomalies are reported, preventing false positives during the learning phase. Anomalies are ingested back into the signal aggregator, where they compound with other signals for convergence detection.

### Breaking News Alert Pipeline

The dashboard monitors five independent alert origins and fuses them into a unified breaking news stream with layered deduplication, cooldowns, and source quality gating:

| Origin               | Trigger                                                        | Example                                      |
| -------------------- | -------------------------------------------------------------- | -------------------------------------------- |
| **RSS alert**        | News item with `isAlert: true` and threat level critical/high  | Reuters flash: missile strike confirmed       |
| **Keyword spike**    | Trending keyword exceeds spike threshold                       | "nuclear" surges across 8+ feeds in 2 hours  |
| **Hotspot escalation** | Hotspot escalation score exceeds critical threshold          | Taiwan Strait tension crosses 80/100         |
| **Military surge**   | Theater posture assessment detects strike packaging            | Tanker + AWACS + fighters co-present in MENA |
| **OREF siren**       | Israel Home Front Command issues incoming rocket/missile alert | Rocket barrage detected in northern Israel   |

**Anti-noise safeguards**:

- **Per-event dedup** — each alert is keyed by a content hash; repeated alerts for the same event are suppressed for 30 minutes
- **Global cooldown** — after any alert fires, a 60-second global cooldown prevents rapid-fire notification bursts
- **Recency gate** — items older than 15 minutes at processing time are silently dropped, preventing stale events from generating alerts after a reconnection
- **Source tier gating** — Tier 3+ sources (niche outlets, aggregators) must have LLM-confirmed classification (`threat.source !== 'keyword'`) to fire an alert; Tier 1–2 sources bypass this gate
- **User sensitivity control** — configurable between `critical-only` (only critical severity fires) and `critical-and-high` (both critical and high severities)

When an alert passes all gates, the system dispatches a `wm:breaking-news` CustomEvent on `document`, which the Breaking News Banner consumes to display a persistent top-of-screen notification. Optional browser Notification API popups and an audio chime are available as user settings. Clicking the banner scrolls to the RSS panel that sourced the alert and applies a 1.5-second flash highlight animation.

---

## Signal Correlation

### Signal Aggregation

All real-time data sources feed into a central signal aggregator that builds a unified geospatial intelligence picture. Signals are clustered by country and region, with each signal carrying a severity (low/medium/high), geographic coordinates, and metadata. The aggregator:

1. **Clusters by country** — groups signals from diverse sources (flights, vessels, protests, fires, outages, `keyword_spike`) into per-country profiles
2. **Detects regional convergence** — identifies when multiple signal types spike in the same geographic corridor (e.g., military flights + protests + satellite fires in Eastern Mediterranean)
3. **Feeds downstream analysis** — the CII, hotspot escalation, focal point detection, and AI insights modules all consume the aggregated signal picture rather than raw data

### Cross-Stream Correlation Engine

Beyond aggregating signals by geography, the system detects meaningful correlations *across* data streams — identifying patterns that no single source would reveal. 14 signal types are continuously evaluated:

| Signal Type               | Detection Logic                                                                 | Why It Matters                                           |
| ------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `prediction_leads_news`   | Polymarket probability shifts >5% before matching news headlines appear        | Prediction markets as early-warning indicators           |
| `news_leads_markets`      | News velocity spike precedes equity/crypto price move by 15–60 min             | Informational advantage detection                        |
| `silent_divergence`       | Significant market movement with no corresponding news volume                   | Potential insider activity or unreported events           |
| `velocity_spike`          | News cluster sources-per-hour exceeds 6+ from Tier 1–2 outlets                | Breaking story detection                                 |
| `keyword_spike`           | Trending term exceeds 3× its 7-day baseline                                   | Emerging narrative detection                             |
| `convergence`             | 3+ signal types co-locate in same 1°×1° geographic cell                        | Multi-domain crisis indicator                            |
| `triangulation`           | Same entity appears across news + military tracking + market signals           | High-confidence focal point identification               |
| `flow_drop`               | ETF flow estimates reverse direction while price continues                     | Smart money divergence                                   |
| `flow_price_divergence`   | Commodity prices move opposite to shipping flow indicators                     | Supply chain disruption signal                           |
| `geo_convergence`         | Geographic convergence alert from the spatial binning system                   | Regional crisis acceleration                             |
| `explained_market_move`   | Market price change has a matching news cluster with causal keywords           | Attributable market reaction                             |
| `hotspot_escalation`      | Hotspot escalation score exceeds threshold                                     | Conflict zone intensification                            |
| `sector_cascade`          | Multiple companies in same sector move in same direction simultaneously        | Sector-wide event detection                              |
| `military_surge`          | Theater posture assessment detects unusual force concentration                 | Military escalation warning                              |

Each signal carries a severity (low/medium/high), geographic coordinates, a human-readable summary, and the raw data that triggered it. Signals are deduplicated per-type with configurable cooldown windows (30 minutes to 6 hours) to prevent alert fatigue. The correlation output feeds into the AI Insights panel, where the narrative synthesis engine weaves detected correlations into a structured intelligence brief.

### PizzINT Activity Monitor & GDELT Tension Index

The dashboard integrates two complementary geopolitical pulse indicators:

**PizzINT DEFCON scoring** — monitors foot traffic patterns at key military, intelligence, and government locations worldwide via the PizzINT API. Aggregate activity levels across monitored sites are converted into a 5-level DEFCON-style readout:

| Adjusted Activity | DEFCON Level | Label             |
| ----------------- | ------------ | ----------------- |
| ≥ 85%             | 1            | Maximum Activity  |
| 70% – 84%         | 2            | High Activity     |
| 50% – 69%         | 3            | Elevated Activity |
| 25% – 49%         | 4            | Above Normal      |
| < 25%             | 5            | Normal Activity   |

Activity spikes at individual locations boost the aggregate score (+10 per spike, capped at 100). Data freshness is tracked per-location — the system distinguishes between stale readings (location sensor lag) and genuine low activity. Per-location detail includes current popularity percentage, spike magnitude, and open/closed status.

**GDELT bilateral tension pairs** — six strategic country pairs (USA↔Russia, Russia↔Ukraine, USA↔China, China↔Taiwan, USA↔Iran, USA↔Venezuela) are tracked via GDELT's GPR (Goldstein Political Relations) batch API. Each pair shows a current tension score, a percentage change from the previous data point, and a trend direction (rising/stable/falling, with ±5% thresholds). Rising bilateral tension scores that coincide with military signal spikes in the same region feed into the focal point detection algorithm.
