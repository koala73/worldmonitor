# World Monitor

Real-time global intelligence dashboard aggregating news, markets, geopolitical data, and infrastructure monitoring into a unified situation awareness interface.

🌐 **[Live Demo: worldmonitor.app](https://worldmonitor.app)**

![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat&logo=vite&logoColor=white)
![D3.js](https://img.shields.io/badge/D3.js-F9A03C?style=flat&logo=d3.js&logoColor=white)
![Version](https://img.shields.io/badge/version-1.3.4-blue)

![World Monitor Dashboard](Screenshot.png)

## Features

### Interactive Global Map
- **Zoom & Pan** - Smooth navigation with mouse/trackpad gestures
- **Multiple Views** - Global, US, and MENA region presets
- **Layer System** - Toggle visibility of different data layers
- **Time Filtering** - Filter events by time range (1h to 7d)

### Data Layers

Layers are organized into logical groups for efficient monitoring:

**Geopolitical**
| Layer | Description |
|-------|-------------|
| **Conflicts** | Active conflict zones with involved parties and status |
| **Hotspots** | Intelligence hotspots with activity levels based on news correlation |
| **Sanctions** | Countries under economic sanctions regimes |
| **Protests** | Live social unrest events from ACLED and GDELT |

**Military & Strategic**
| Layer | Description |
|-------|-------------|
| **Military Bases** | 220+ global military installations from 9 operators |
| **Nuclear Facilities** | Power plants, weapons labs, enrichment sites |
| **Gamma Irradiators** | IAEA-tracked Category 1-3 radiation sources |

**Infrastructure**
| Layer | Description |
|-------|-------------|
| **Undersea Cables** | 55 major submarine cable routes worldwide |
| **Pipelines** | 88 operating oil & gas pipelines across all continents |
| **Internet Outages** | Network disruptions via Cloudflare Radar |
| **AI Datacenters** | 111 major AI compute clusters (≥10,000 GPUs) |

**Transport**
| Layer | Description |
|-------|-------------|
| **Ships (AIS)** | Live vessel tracking via AIS with chokepoint monitoring and 61 strategic ports* |
| **Delays** | FAA airport delay status and ground stops |

*\*AIS data via [AISStream.io](https://aisstream.io) uses terrestrial receivers with stronger coverage in European/Atlantic waters. Middle East, Asia, and open ocean coverage is limited. Satellite AIS providers (Spire, Kpler) offer global coverage but require commercial licenses.*

**Natural Events**
| Layer | Description |
|-------|-------------|
| **Natural** | USGS earthquakes (M4.5+) + NASA EONET events (storms, wildfires, volcanoes, floods) |
| **Weather** | NWS severe weather warnings |

**Economic & Labels**
| Layer | Description |
|-------|-------------|
| **Economic** | FRED indicators panel (Fed assets, rates, yields) |
| **Countries** | Country boundary labels |
| **Waterways** | Strategic waterways and chokepoints |

### Intelligence Panels

Beyond raw data feeds, the dashboard provides synthesized intelligence panels:

| Panel | Purpose |
|-------|---------|
| **Strategic Risk Overview** | Composite risk score combining all intelligence modules |
| **Country Instability Index** | Real-time stability scores for 20 monitored countries |
| **Infrastructure Cascade** | Dependency analysis for cables, pipelines, and chokepoints |
| **Live Intelligence** | GDELT-powered topic feeds (Military, Cyber, Nuclear, Sanctions) |
| **Intel Feed** | Curated defense and security news sources |

These panels transform raw signals into actionable intelligence by applying scoring algorithms, trend detection, and cross-source correlation.

### News Aggregation

Multi-source RSS aggregation across categories:
- **World / Geopolitical** - BBC, Reuters, AP, Guardian, NPR, Politico, The Telegraph
- **Middle East / MENA** - Al Jazeera, BBC ME, Guardian ME, CNN World
- **Technology** - Hacker News, Ars Technica, The Verge, MIT Tech Review
- **AI / ML** - ArXiv, Hugging Face, VentureBeat, OpenAI
- **Finance** - CNBC, MarketWatch, Financial Times, Yahoo Finance
- **Government** - White House, State Dept, Pentagon, Treasury, Fed, SEC
- **Intel Feed** - Defense One, Breaking Defense, Bellingcat, Krebs Security
- **Think Tanks** - Foreign Policy, Atlantic Council, Foreign Affairs
- **Layoffs Tracker** - Tech industry job cuts

### Live News Streams

Embedded YouTube live streams from major news networks with channel switching:

| Channel | Coverage |
|---------|----------|
| **Bloomberg** | Business & financial news |
| **Sky News** | UK & international news |
| **Euronews** | European perspective |
| **DW News** | German international broadcaster |
| **France 24** | French global news |
| **Al Arabiya** | Middle East news (Arabic perspective) |
| **Al Jazeera** | Middle East & international news |

Features:
- **Channel Switcher** - One-click switching between networks
- **Live Indicator** - Blinking dot shows stream status, click to pause/play
- **Mute Toggle** - Audio control (muted by default)
- **Double-Width Panel** - Larger video player for better viewing

### Market Data
- **Stocks** - Major indices and tech stocks via Finnhub (Yahoo Finance backup)
- **Commodities** - Oil, gold, natural gas, copper, VIX
- **Crypto** - Bitcoin, Ethereum, Solana via CoinGecko
- **Sector Heatmap** - Visual sector performance (11 SPDR sectors)
- **Economic Indicators** - Fed data via FRED (assets, rates, yields)

### Prediction Markets
- Polymarket integration for event probability tracking
- Correlation analysis with news events

### Search (⌘K)
Universal search across all data sources:
- News articles
- Geographic hotspots and conflicts
- Infrastructure (pipelines, cables, datacenters)
- Nuclear facilities and irradiators
- Markets and predictions

### Data Export
- CSV and JSON export of current dashboard state
- Historical playback from snapshots

---

## Signal Intelligence

The dashboard continuously analyzes data streams to detect significant patterns and anomalies. Signals appear in the header badge (⚡) with confidence scores.

### Signal Types

| Signal | Trigger | What It Means |
|--------|---------|---------------|
| **◉ Convergence** | 3+ source types report same story within 30 minutes | Multiple independent channels confirming the same event—higher likelihood of significance |
| **△ Triangulation** | Wire + Government + Intel sources align | The "authority triangle"—when official channels, wire services, and defense specialists all report the same thing |
| **🔥 Velocity Spike** | Topic mention rate doubles with 6+ sources/hour | A story is accelerating rapidly across the news ecosystem |
| **🔮 Prediction Leading** | Prediction market moves 5%+ with low news coverage | Markets pricing in information not yet reflected in news |
| **📊 Silent Divergence** | Market moves 2%+ with minimal related news | Unexplained price action—possible insider knowledge or algorithm-driven |

### How It Works

The correlation engine maintains rolling snapshots of:
- News topic frequency (by keyword extraction)
- Market price changes
- Prediction market probabilities

Each refresh cycle compares current state to previous snapshot, applying thresholds and deduplication to avoid alert fatigue. Signals include confidence scores (60-95%) based on the strength of the pattern.

---

## Source Intelligence

Not all sources are equal. The system implements a dual classification to prioritize authoritative information.

### Source Tiers (Authority Ranking)

| Tier | Sources | Characteristics |
|------|---------|-----------------|
| **Tier 1** | Reuters, AP, AFP, Bloomberg, White House, Pentagon | Wire services and official government—fastest, most reliable |
| **Tier 2** | BBC, Guardian, NPR, Al Jazeera, CNBC, Financial Times | Major outlets—high editorial standards, some latency |
| **Tier 3** | Defense One, Bellingcat, Foreign Policy, MIT Tech Review | Domain specialists—deep expertise, narrower scope |
| **Tier 4** | Hacker News, The Verge, VentureBeat, aggregators | Useful signal but requires corroboration |

When multiple sources report the same story, the **lowest tier** (most authoritative) source is displayed as the primary, with others listed as corroborating.

### Source Types (Categorical)

Sources are also categorized by function for triangulation detection:

- **Wire** - News agencies (Reuters, AP, AFP, Bloomberg)
- **Gov** - Official government (White House, Pentagon, State Dept, Fed, SEC)
- **Intel** - Defense/security specialists (Defense One, Bellingcat, Krebs)
- **Mainstream** - Major news outlets (BBC, Guardian, NPR, Al Jazeera)
- **Market** - Financial press (CNBC, MarketWatch, Financial Times)
- **Tech** - Technology coverage (Hacker News, Ars Technica, MIT Tech Review)

---

## Algorithms & Design

### News Clustering

Related articles are grouped using **Jaccard similarity** on tokenized headlines:

```
similarity(A, B) = |A ∩ B| / |A ∪ B|
```

- Headlines are tokenized, lowercased, and stripped of stop words
- Articles with similarity ≥ 0.5 are grouped into clusters
- Clusters are sorted by source tier, then recency
- The most authoritative source becomes the "primary" headline

### Velocity Analysis

Each news cluster tracks publication velocity:

- **Sources per hour** = article count / time span
- **Trend** = rising/stable/falling based on first-half vs second-half publication rate
- **Levels**: Normal (<3/hr), Elevated (3-6/hr), Spike (>6/hr)

### Sentiment Detection

Headlines are scored against curated word lists:

**Negative indicators**: war, attack, killed, crisis, crash, collapse, threat, sanctions, invasion, missile, terror, assassination, recession, layoffs...

**Positive indicators**: peace, deal, agreement, breakthrough, recovery, growth, ceasefire, treaty, alliance, victory...

Score determines sentiment classification: negative (<-1), neutral (-1 to +1), positive (>+1)

### Baseline Deviation (Z-Score)

The system maintains rolling baselines for news volume per topic:

- **7-day average** and **30-day average** stored in IndexedDB
- Standard deviation calculated from historical counts
- **Z-score** = (current - mean) / stddev

Deviation levels:
- **Spike**: Z > 2.5 (statistically rare increase)
- **Elevated**: Z > 1.5
- **Normal**: -2 < Z < 1.5
- **Quiet**: Z < -2 (unusually low activity)

This enables detection of anomalous activity even when absolute numbers seem normal.

---

## Dynamic Hotspot Activity

Hotspots on the map are **not static threat levels**. Activity is calculated in real-time based on news correlation.

Each hotspot defines keywords:
```typescript
{
  id: 'dc',
  name: 'DC',
  keywords: ['pentagon', 'white house', 'congress', 'cia', 'nsa', ...],
  agencies: ['Pentagon', 'CIA', 'NSA', 'State Dept'],
}
```

The system counts matching news articles in the current feed, applies velocity analysis, and assigns activity levels:

| Level | Criteria | Visual |
|-------|----------|--------|
| **Low** | <3 matches, normal velocity | Gray marker |
| **Elevated** | 3-6 matches OR elevated velocity | Yellow pulse |
| **High** | >6 matches OR spike velocity | Red pulse |

This creates a dynamic "heat map" of global attention based on live news flow.

---

## Country Instability Index (CII)

The dashboard maintains a **real-time instability score** for 20 strategically significant countries. Rather than relying on static risk ratings, the CII dynamically reflects current conditions based on multiple input streams.

### Monitored Countries (Tier 1)

| Region | Countries |
|--------|-----------|
| **Americas** | United States, Venezuela |
| **Europe** | Germany, France, United Kingdom, Poland |
| **Eastern Europe** | Russia, Ukraine |
| **Middle East** | Iran, Israel, Saudi Arabia, Turkey, Syria, Yemen |
| **Asia-Pacific** | China, Taiwan, North Korea, India, Pakistan, Myanmar |

### Three Component Scores

Each country's CII is computed from three weighted components:

| Component | Weight | Data Sources | What It Measures |
|-----------|--------|--------------|------------------|
| **Unrest** | 40% | ACLED protests, GDELT events | Civil unrest intensity, fatalities, event severity |
| **Security** | 30% | Military flights, naval vessels | Unusual military activity patterns |
| **Information** | 30% | News velocity, alert clusters | Media attention intensity and acceleration |

### Scoring Algorithm

```
Unrest Score:
  base = min(50, protest_count × 8)
  fatality_boost = min(30, total_fatalities × 5)
  severity_boost = min(20, high_severity_count × 10)
  unrest = min(100, base + fatality_boost + severity_boost)

Security Score:
  flight_score = min(50, military_flights × 3)
  vessel_score = min(30, naval_vessels × 5)
  security = min(100, flight_score + vessel_score)

Information Score:
  base = min(40, news_count × 5)
  velocity_boost = min(40, avg_velocity × 10)
  alert_boost = 20 if any_alert else 0
  information = min(100, base + velocity_boost + alert_boost)

Final CII = round(unrest × 0.4 + security × 0.3 + information × 0.3)
```

### Instability Levels

| Level | Score Range | Visual | Meaning |
|-------|-------------|--------|---------|
| **Critical** | 81-100 | Red | Active crisis or major escalation |
| **High** | 66-80 | Orange | Significant instability requiring close monitoring |
| **Elevated** | 51-65 | Yellow | Above-normal activity patterns |
| **Normal** | 31-50 | Gray | Baseline geopolitical activity |
| **Low** | 0-30 | Green | Unusually quiet period |

### Trend Detection

The CII tracks 24-hour changes to identify trajectory:
- **Rising**: Score increased by ≥5 points (escalating situation)
- **Stable**: Change within ±5 points (steady state)
- **Falling**: Score decreased by ≥5 points (de-escalation)

### Keyword Attribution

Countries are matched to data via keyword lists:
- **Russia**: `russia`, `moscow`, `kremlin`, `putin`
- **China**: `china`, `beijing`, `xi jinping`, `prc`
- **Taiwan**: `taiwan`, `taipei`

This enables attribution of news and events to specific countries even when formal country codes aren't present in the source data.

---

## Geographic Convergence Detection

One of the most valuable intelligence signals is when **multiple independent data streams converge on the same geographic area**. This often precedes significant events.

### How It Works

The system maintains a real-time grid of geographic cells (1° × 1° resolution). Each cell tracks four event types:

| Event Type | Source | Detection Method |
|------------|--------|-----------------|
| **Protests** | ACLED/GDELT | Direct geolocation |
| **Military Flights** | OpenSky | ADS-B position |
| **Naval Vessels** | AIS stream | Ship position |
| **Earthquakes** | USGS | Epicenter location |

When **3 or more different event types** occur within the same cell during a 24-hour window, a **convergence alert** is generated.

### Convergence Scoring

```
type_score = event_types × 25      # Max 100 (4 types)
count_boost = min(25, total_events × 2)
convergence_score = min(100, type_score + count_boost)
```

### Alert Thresholds

| Types Converging | Score Range | Alert Level |
|-----------------|-------------|-------------|
| **4 types** | 80-100 | Critical |
| **3 types** | 60-80 | High |
| **3 types** (low count) | 40-60 | Medium |

### Example Scenarios

**Taiwan Strait Buildup**
- Cell: `25°N, 121°E`
- Events: Military flights (3), Naval vessels (2), Protests (1)
- Score: 75 + 12 = 87 (Critical)
- Signal: "Geographic Convergence (3 types) - military flights, naval vessels, protests"

**Middle East Flashpoint**
- Cell: `32°N, 35°E`
- Events: Military flights (5), Protests (8), Earthquake (1)
- Score: 75 + 25 = 100 (Critical)
- Signal: Multiple activity streams converging on region

### Why This Matters

Individual data points are often noise. But when **protests break out, military assets reposition, and seismic monitors detect anomalies** in the same location simultaneously, it warrants attention—regardless of whether any single source is reporting a crisis.

---

## Infrastructure Cascade Analysis

Critical infrastructure is interdependent. A cable cut doesn't just affect connectivity—it creates cascading effects across dependent countries and systems. The cascade analysis system visualizes these dependencies.

### Dependency Graph

The system builds a graph of **279 infrastructure nodes** and **280 dependency edges**:

| Node Type | Count | Examples |
|-----------|-------|----------|
| **Undersea Cables** | 18 | MAREA, FLAG Europe-Asia, SEA-ME-WE 6 |
| **Pipelines** | 88 | Nord Stream, Trans-Siberian, Keystone |
| **Ports** | 61 | Singapore, Rotterdam, Shenzhen |
| **Chokepoints** | 8 | Suez, Hormuz, Malacca |
| **Countries** | 105 | End nodes representing national impact |

### Cascade Calculation

When a user selects an infrastructure asset for analysis, a **breadth-first cascade** propagates through the graph:

```
1. Start at source node (e.g., "cable:marea")
2. For each dependent node:
   impact = edge_strength × disruption_level × (1 - redundancy)
3. Categorize impact:
   - Critical: impact > 0.8
   - High: impact > 0.5
   - Medium: impact > 0.2
   - Low: impact ≤ 0.2
4. Recurse to depth 3 (prevent infinite loops)
```

### Redundancy Modeling

The system accounts for alternative routes:
- Cables with high redundancy show reduced impact
- Countries with multiple cable landings show lower vulnerability
- Alternative routes are displayed with capacity percentages

### Example Analysis

**MAREA Cable Disruption**:
```
Source: MAREA (US ↔ Spain, 200 Tbps)
Countries Affected: 4
- Spain: Medium (redundancy via other Atlantic cables)
- Portugal: Low (secondary landing)
- France: Low (alternative routes via UK)
- US: Low (high redundancy)
Alternative Routes: TAT-14 (35%), Hibernia (22%), AEConnect (18%)
```

**FLAG Europe-Asia Disruption**:
```
Source: FLAG Europe-Asia (UK ↔ Japan)
Countries Affected: 7
- India: Medium (major capacity share)
- UAE, Saudi Arabia: Medium (limited alternatives)
- UK, Japan: Low (high redundancy)
Alternative Routes: SEA-ME-WE 6 (11%), 2Africa (8%), Falcon (8%)
```

### Use Cases

- **Pre-positioning**: Understand which countries are most vulnerable to specific infrastructure failures
- **Risk Assessment**: Evaluate supply chain exposure to chokepoint disruptions
- **Incident Response**: Quickly identify downstream effects of reported cable cuts or pipeline damage

---

## Strategic Risk Overview

The Strategic Risk Overview provides a **composite dashboard** that synthesizes all intelligence modules into a single risk assessment.

### Composite Score (0-100)

The strategic risk score combines three components:

| Component | Weight | Calculation |
|-----------|--------|-------------|
| **Convergence** | 40% | `min(100, convergence_zones × 20)` |
| **CII Deviation** | 35% | `min(100, avg_deviation × 2)` |
| **Infrastructure** | 25% | `min(100, incidents × 25)` |

### Risk Levels

| Score | Level | Trend Icon | Meaning |
|-------|-------|------------|---------|
| 70-100 | **Critical** | 📈 Escalating | Multiple converging crises |
| 50-69 | **Elevated** | ➡️ Stable | Heightened global tension |
| 30-49 | **Moderate** | ➡️ Stable | Normal fluctuation |
| 0-29 | **Low** | 📉 De-escalating | Unusually quiet period |

### Unified Alert System

Alerts from all modules are merged using **temporal and spatial deduplication**:

- **Time window**: Alerts within 2 hours may be merged
- **Distance threshold**: Alerts within 200km may be merged
- **Same country**: Alerts affecting the same country may be merged

When alerts merge, they become **composite alerts** that show the full picture:

```
Type: Composite Alert
Title: Convergence + CII + Infrastructure: Ukraine
Components:
  - Geographic Convergence: 4 event types in Kyiv region
  - CII Spike: Ukraine +15 points (Critical)
  - Infrastructure: Black Sea cables at risk
Priority: Critical
```

### Alert Priority

| Priority | Criteria |
|----------|----------|
| **Critical** | CII critical level, convergence score ≥80, cascade critical impact |
| **High** | CII high level, convergence score ≥60, cascade affecting ≥5 countries |
| **Medium** | CII change ≥10 points, convergence score ≥40 |
| **Low** | Minor changes and low-impact events |

### Trend Detection

The system tracks the composite score over time:
- First measurement establishes baseline (shows "Stable")
- Subsequent changes of ±5 points trigger trend changes
- This prevents false "escalating" signals on initialization

---

## Pentagon Pizza Index (PizzINT)

The dashboard integrates real-time foot traffic data from strategic locations near government and military facilities. This "Pizza Index" concept—tracking late-night activity spikes at restaurants near the Pentagon, Langley, and other facilities—provides an unconventional indicator of crisis activity.

### How It Works

The system aggregates percentage-of-usual metrics from monitored locations:

1. **Locations**: Fast food, pizza shops, and convenience stores near Pentagon, CIA, NSA, State Dept, and other facilities
2. **Aggregation**: Activity percentages are averaged, capped at 100%
3. **Spike Detection**: Locations exceeding their baseline are flagged

### DEFCON-Style Alerting

Aggregate activity maps to a 5-level readiness scale:

| Level | Threshold | Label | Meaning |
|-------|-----------|-------|---------|
| **DEFCON 1** | ≥90% | COCKED PISTOL | Maximum readiness; crisis response active |
| **DEFCON 2** | ≥75% | FAST PACE | High activity; significant event underway |
| **DEFCON 3** | ≥50% | ROUND HOUSE | Elevated; above-normal operations |
| **DEFCON 4** | ≥25% | DOUBLE TAKE | Increased vigilance |
| **DEFCON 5** | <25% | FADE OUT | Normal peacetime operations |

### GDELT Tension Pairs

The indicator also displays geopolitical tension scores from GDELT (Global Database of Events, Language, and Tone):

| Pair | Monitored Relationship |
|------|----------------------|
| USA ↔ Russia | Primary nuclear peer adversary |
| USA ↔ China | Economic and military competition |
| USA ↔ Iran | Middle East regional tensions |
| Israel ↔ Iran | Direct conflict potential |
| China ↔ Taiwan | Cross-strait relations |
| Russia ↔ Ukraine | Active conflict zone |

Each pair shows:
- **Current tension score** (GDELT's normalized metric)
- **7-day trend** (rising, falling, stable)
- **Percentage change** from previous period

This provides context for the activity levels—a spike at Pentagon locations during a rising China-Taiwan tension score carries different weight than during a quiet period.

---

## Related Assets

News clusters are automatically enriched with nearby critical infrastructure. When a story mentions a geographic region, the system identifies relevant assets within 600km, providing immediate operational context.

### Asset Types

| Type | Source | Examples |
|------|--------|----------|
| **Pipelines** | 88 global routes | Nord Stream, Keystone, Trans-Siberian |
| **Undersea Cables** | 55 major cables | TAT-14, SEA-ME-WE, Pacific Crossing |
| **AI Datacenters** | 111 clusters (≥10k GPUs) | Azure East US, GCP Council Bluffs |
| **Military Bases** | 220+ installations | Ramstein, Diego Garcia, Guam |
| **Nuclear Facilities** | 100+ sites | Power plants, weapons labs, enrichment |

### Location Inference

The system infers the geographic focus of news stories through:

1. **Keyword matching**: Headlines are scanned against hotspot keyword lists (e.g., "Taiwan" → Taiwan Strait hotspot)
2. **Confidence scoring**: Multiple keyword matches increase location confidence
3. **Fallback to conflicts**: If no hotspot matches, active conflict zones are checked

### Distance Calculation

Assets are ranked by Haversine distance from the inferred location:

```
d = 2r × arcsin(√(sin²(Δφ/2) + cos(φ₁) × cos(φ₂) × sin²(Δλ/2)))
```

Up to 3 assets per type are displayed, sorted by proximity.

### Example Context

A news cluster about "pipeline explosion in Germany" would show:
- **Pipelines**: Nord Stream (23km), Yamal-Europe (156km)
- **Cables**: TAT-14 landing (89km)
- **Bases**: Ramstein (234km)

Clicking an asset zooms the map to its location and displays detailed information.

---

## Custom Monitors

Create personalized keyword alerts that scan all incoming news:

1. Enter comma-separated keywords (e.g., "nvidia, gpu, chip shortage")
2. System assigns a unique color
3. Matching articles are highlighted in the Monitor panel
4. Matching articles in clusters inherit the monitor color

Monitors persist across sessions via LocalStorage.

---

## Activity Tracking

The dashboard highlights newly-arrived items so you can quickly identify what changed since your last look.

### Visual Indicators

| Indicator | Duration | Purpose |
|-----------|----------|---------|
| **NEW tag** | 2 minutes | Badge on items that just appeared |
| **Glow highlight** | 30 seconds | Subtle animation drawing attention |
| **Panel badge** | Until viewed | Count of new items in collapsed panels |

### Automatic "Seen" Detection

The system uses IntersectionObserver to detect when panels become visible:

- When a panel is >50% visible for >500ms, items are marked as "seen"
- Scrolling through a panel marks visible items progressively
- Switching panels resets the "new" state appropriately

### Panel-Specific Tracking

Each panel maintains independent activity state:

- **News**: New clusters since last view
- **Markets**: Price changes exceeding thresholds
- **Predictions**: Probability shifts >5%
- **Natural Events**: New earthquakes and EONET events

This enables focused monitoring—you can collapse panels you've reviewed and see at a glance which have new activity.

---

## Snapshot System

The dashboard captures periodic snapshots for historical analysis:

- **Automatic capture** every refresh cycle
- **7-day retention** with automatic cleanup
- **Stored data**: news clusters, market prices, prediction values, hotspot levels
- **Playback**: Load historical snapshots to see past dashboard states

Baselines (7-day and 30-day averages) are stored in IndexedDB for deviation analysis.

---

## Maritime Intelligence

The Ships layer provides real-time vessel tracking and maritime domain awareness through AIS (Automatic Identification System) data.

### Chokepoint Monitoring

The system monitors eight critical maritime chokepoints where disruptions could impact global trade:

| Chokepoint | Strategic Importance |
|------------|---------------------|
| **Strait of Hormuz** | 20% of global oil transits; Iran control |
| **Suez Canal** | Europe-Asia shipping; single point of failure |
| **Strait of Malacca** | Primary Asia-Pacific oil route |
| **Bab el-Mandeb** | Red Sea access; Yemen/Houthi activity |
| **Panama Canal** | Americas east-west transit |
| **Taiwan Strait** | Semiconductor supply chain; PLA activity |
| **South China Sea** | Contested waters; island disputes |
| **Black Sea** | Ukraine grain exports; Russian naval activity |

### Density Analysis

Vessel positions are aggregated into a 2° grid to calculate traffic density. Each cell tracks:
- Current vessel count
- Historical baseline (30-minute rolling window)
- Change percentage from baseline

Density changes of ±30% trigger alerts, indicating potential congestion, diversions, or blockades.

### Dark Ship Detection

The system monitors for AIS gaps—vessels that stop transmitting their position. An AIS gap exceeding 60 minutes in monitored regions may indicate:
- Sanctions evasion (ship-to-ship transfers)
- Illegal fishing
- Military activity
- Equipment failure

Vessels reappearing after gaps are flagged for the duration of the session.

### WebSocket Architecture

AIS data flows through a WebSocket relay for real-time updates without polling:

```
AISStream → WebSocket Relay → Browser
              (ws://relay)
```

The connection automatically reconnects on disconnection with a 30-second backoff. When the Ships layer is disabled, the WebSocket disconnects to conserve resources.

---

## Military Tracking

The Military layer provides specialized tracking of military vessels and aircraft, identifying assets by their transponder characteristics and monitoring activity patterns.

### Military Vessel Identification

Vessels are identified as military through multiple methods:

**MMSI Analysis**: Maritime Mobile Service Identity numbers encode the vessel's flag state. The system maintains a mapping of 150+ country codes to identify naval vessels:

| MID Range | Country | Notes |
|-----------|---------|-------|
| 338-339 | USA | US Navy, Coast Guard |
| 273 | Russia | Russian Navy |
| 412-414 | China | PLAN vessels |
| 232-235 | UK | Royal Navy |
| 226-228 | France | Marine Nationale |

**Callsign Patterns**: Known military callsign prefixes (NAVY, GUARD, etc.) provide secondary identification.

### Naval Chokepoint Monitoring

The system monitors 12 critical maritime chokepoints with configurable detection radii:

| Chokepoint | Strategic Significance |
|------------|----------------------|
| Strait of Hormuz | Persian Gulf access, oil transit |
| Suez Canal | Mediterranean-Red Sea link |
| Strait of Malacca | Pacific-Indian Ocean route |
| Taiwan Strait | Cross-strait tensions |
| Bosphorus | Black Sea access |
| GIUK Gap | North Atlantic submarine route |

When military vessels enter these zones, proximity alerts are generated.

### Naval Base Proximity

Activity near 12 major naval installations is tracked:

- **Norfolk** (USA) - Atlantic Fleet headquarters
- **Pearl Harbor** (USA) - Pacific Fleet base
- **Sevastopol** (Russia) - Black Sea Fleet
- **Qingdao** (China) - North Sea Fleet
- **Yokosuka** (Japan) - US 7th Fleet

Vessels within 50km of these bases are flagged, enabling detection of unusual activity patterns.

### Aircraft Tracking (OpenSky)

Military aircraft are tracked via the OpenSky Network using ADS-B data. OpenSky blocks unauthenticated requests from cloud provider IPs (Vercel, Railway, AWS), so aircraft tracking requires a relay server with credentials.

**Authentication**:
- Register for a free account at [opensky-network.org](https://opensky-network.org)
- Create an API client in account settings to get `OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET`
- The relay uses Basic Auth with these credentials to bypass cloud IP blocks

**Identification Methods**:
- **Callsign matching**: Known military callsign patterns (RCH, REACH, DUKE, etc.)
- **ICAO hex ranges**: Military aircraft use assigned hex code blocks by country
- **Altitude/speed profiles**: Unusual flight characteristics

**Tracked Metrics**:
- Position history (20-point trails over 5-minute windows)
- Altitude and ground speed
- Heading and track

**Activity Detection**:
- Formations (multiple military aircraft in proximity)
- Unusual patterns (holding, reconnaissance orbits)
- Chokepoint transits

### Vessel Position History

The system maintains position trails for tracked vessels:

- **30-point history** per MMSI
- **10-minute cleanup interval** for stale data
- **Trail visualization** on map for recent movement

This enables detection of loitering, circling, or other anomalous behavior patterns.

---

## Aircraft Enrichment

Military aircraft tracking is enhanced with **Wingbits** enrichment data, providing detailed aircraft information that goes beyond basic transponder data.

### What Wingbits Provides

When an aircraft is detected via OpenSky ADS-B, the system queries Wingbits for:

| Field | Description | Use Case |
|-------|-------------|----------|
| **Registration** | Aircraft tail number (e.g., N12345) | Unique identification |
| **Owner** | Legal owner of the aircraft | Military branch detection |
| **Operator** | Operating entity | Distinguish military vs. contractor |
| **Manufacturer** | Boeing, Lockheed Martin, etc. | Aircraft type classification |
| **Model** | Specific aircraft model | Capability assessment |
| **Built Year** | Year of manufacture | Fleet age analysis |

### Military Classification Algorithm

The enrichment service analyzes owner and operator fields against curated keyword lists:

**Confirmed Military** (owner/operator match):
- Government: "United States Air Force", "Department of Defense", "Royal Air Force"
- International: "NATO", "Ministry of Defence", "Bundeswehr"

**Likely Military** (operator ICAO codes):
- `AIO` (Air Mobility Command), `RRR` (Royal Air Force), `GAF` (German Air Force)
- `RCH` (REACH flights), `CNV` (Convoy flights), `DOD` (Department of Defense)

**Possible Military** (defense contractors):
- Northrop Grumman, Lockheed Martin, General Atomics, Raytheon, Boeing Defense, L3Harris

**Aircraft Type Matching**:
- Transport: C-17, C-130, C-5, KC-135, KC-46
- Reconnaissance: RC-135, U-2, RQ-4, E-3, E-8
- Combat: F-15, F-16, F-22, F-35, B-52, B-2
- European: Eurofighter, Typhoon, Rafale, Tornado, Gripen

### Confidence Levels

Each enriched aircraft receives a confidence classification:

| Level | Criteria | Display |
|-------|----------|---------|
| **Confirmed** | Direct military owner/operator match | Green badge |
| **Likely** | Military ICAO code or aircraft type | Yellow badge |
| **Possible** | Defense contractor ownership | Gray badge |
| **Civilian** | No military indicators | No badge |

### Caching Strategy

Aircraft details rarely change, so aggressive caching reduces API load:

- **Server-side**: HTTP Cache-Control headers (24-hour max-age)
- **Client-side**: 1-hour local cache per aircraft
- **Batch optimization**: Up to 20 aircraft per API call

This means an aircraft's details are fetched at most once per day, regardless of how many times it appears on the map.

---

## Social Unrest Tracking

The Protests layer aggregates civil unrest data from two independent sources, providing corroboration and global coverage.

### ACLED (Armed Conflict Location & Event Data)

Academic-grade conflict data with human-verified events:
- **Coverage**: Global, 30-day rolling window
- **Event types**: Protests, riots, strikes, demonstrations
- **Metadata**: Actors involved, fatalities, detailed notes
- **Confidence**: High (human-curated)

### GDELT (Global Database of Events, Language, and Tone)

Real-time news-derived event data:
- **Coverage**: Global, 7-day rolling window
- **Event types**: Geocoded protest mentions from news
- **Volume**: Reports per location (signal strength)
- **Confidence**: Medium (algorithmic extraction)

### Multi-Source Corroboration

Events from both sources are deduplicated using a 0.5° spatial grid and date matching. When both ACLED and GDELT report events in the same area:
- Confidence is elevated to "high"
- ACLED data takes precedence (higher accuracy)
- Source list shows corroboration

### Severity Classification

| Severity | Criteria |
|----------|----------|
| **High** | Fatalities reported, riots, or clashes |
| **Medium** | Large demonstrations, strikes |
| **Low** | Smaller protests, localized events |

Events near intelligence hotspots are cross-referenced to provide geopolitical context.

---

## Aviation Monitoring

The Flights layer tracks airport delays and ground stops at major US airports using FAA NASSTATUS data.

### Delay Types

| Type | Description |
|------|-------------|
| **Ground Stop** | No departures permitted; severe disruption |
| **Ground Delay** | Departures held; arrival rate limiting |
| **Arrival Delay** | Inbound traffic backed up |
| **Departure Delay** | Outbound traffic delayed |

### Severity Thresholds

| Severity | Average Delay | Visual |
|----------|--------------|--------|
| **Severe** | ≥60 minutes | Red |
| **Major** | 45-59 minutes | Orange |
| **Moderate** | 25-44 minutes | Yellow |
| **Minor** | 15-24 minutes | Gray |

### Monitored Airports

The 30 largest US airports are tracked:
- Major hubs: JFK, LAX, ORD, ATL, DFW, DEN, SFO
- International gateways with high traffic volume
- Airports frequently affected by weather or congestion

Ground stops are particularly significant—they indicate severe disruption (weather, security, or infrastructure failure) and can cascade across the network.

---

## Security & Input Validation

The dashboard handles untrusted data from dozens of external sources. Defense-in-depth measures prevent injection attacks and API abuse.

### XSS Prevention

All user-visible content is sanitized before DOM insertion:

```typescript
escapeHtml(str)  // Encodes & < > " ' as HTML entities
sanitizeUrl(url) // Allows only http/https protocols
```

This applies to:
- News headlines and sources (RSS feeds)
- Search results and highlights
- Monitor keywords (user input)
- Map popup content
- Tension pair labels

The `<mark>` highlighting in search escapes text *before* wrapping matches, preventing injection via crafted search queries.

### Proxy Endpoint Validation

Serverless proxy functions validate and clamp all parameters:

| Endpoint | Validation |
|----------|------------|
| `/api/yahoo-finance` | Symbol format `[A-Za-z0-9.^=-]`, max 20 chars |
| `/api/coingecko` | Coin IDs alphanumeric+hyphen, max 20 IDs |
| `/api/polymarket` | Order field allowlist, limit clamped 1-100 |

This prevents upstream API abuse and rate limit exhaustion from malformed requests.

### Content Security

- URLs are validated via `URL()` constructor—only `http:` and `https:` protocols are permitted
- External links use `rel="noopener"` to prevent reverse tabnapping
- No inline scripts or `eval()`—all code is bundled at build time

---

## Fault Tolerance

External APIs are unreliable. Rate limits, outages, and network errors are inevitable. The system implements **circuit breaker** patterns to maintain availability.

### Circuit Breaker Pattern

Each external service is wrapped in a circuit breaker that tracks failures:

```
Normal → Failure #1 → Failure #2 → OPEN (cooldown)
                                      ↓
                              5 minutes pass
                                      ↓
                                   CLOSED
```

**Behavior during cooldown:**
- New requests return cached data (if available)
- UI shows "temporarily unavailable" status
- No API calls are made (prevents hammering)

### Protected Services

| Service | Cooldown | Cache TTL |
|---------|----------|-----------|
| Yahoo Finance | 5 min | 10 min |
| Polymarket | 5 min | 10 min |
| USGS Earthquakes | 5 min | 10 min |
| NWS Weather | 5 min | 10 min |
| FRED Economic | 5 min | 10 min |
| Cloudflare Radar | 5 min | 10 min |
| ACLED | 5 min | 10 min |
| GDELT | 5 min | 10 min |
| FAA Status | 5 min | 5 min |
| RSS Feeds | 5 min per feed | 10 min |

RSS feeds use per-feed circuit breakers—one failing feed doesn't affect others.

### Graceful Degradation

When a service enters cooldown:
1. Cached data continues to display (stale but available)
2. Status panel shows service health
3. Automatic recovery when cooldown expires
4. No user intervention required

---

## Conditional Data Loading

API calls are expensive. The system only fetches data for **enabled layers**, reducing unnecessary network traffic and rate limit consumption.

### Layer-Aware Loading

When a layer is toggled OFF:
- No API calls for that data source
- No refresh interval scheduled
- WebSocket connections closed (for AIS)

When a layer is toggled ON:
- Data is fetched immediately
- Refresh interval begins
- Loading indicator shown on toggle button

### Unconfigured Services

Some data sources require API keys (AIS relay, Cloudflare Radar). If credentials are not configured:
- The layer toggle is hidden entirely
- No failed requests pollute the console
- Users see only functional layers

This prevents confusion when deploying without full API access.

---

## Performance Optimizations

The dashboard processes thousands of data points in real-time. Several techniques keep the UI responsive even with heavy data loads.

### Web Worker for Analysis

CPU-intensive operations run in a dedicated Web Worker to avoid blocking the main thread:

| Operation | Complexity | Worker? |
|-----------|------------|---------|
| News clustering (Jaccard) | O(n²) | ✅ Yes |
| Correlation detection | O(n × m) | ✅ Yes |
| DOM rendering | O(n) | ❌ Main thread |

The worker manager implements:
- **Lazy initialization**: Worker spawns on first use
- **10-second ready timeout**: Rejects if worker fails to initialize
- **30-second request timeout**: Prevents hanging on stuck operations
- **Automatic cleanup**: Terminates worker on fatal errors

### Virtual Scrolling

Large lists (100+ news items) use virtualized rendering:

**Fixed-Height Mode** (VirtualList):
- Only renders items visible in viewport + 3-item overscan buffer
- Element pooling—reuses DOM nodes rather than creating new ones
- Invisible spacers maintain scroll position without rendering all items

**Variable-Height Mode** (WindowedList):
- Chunk-based rendering (10 items per chunk)
- Renders chunks on-scroll with 1-chunk buffer
- CSS containment for performance isolation

This reduces DOM node count from thousands to ~30, dramatically improving scroll performance.

### Request Deduplication

Identical requests within a short window are deduplicated:
- Market quotes batch multiple symbols into single API call
- Concurrent layer toggles don't spawn duplicate fetches
- `Promise.allSettled` ensures one failing request doesn't block others

### Efficient Data Updates

When refreshing data:
- **Incremental updates**: Only changed items trigger re-renders
- **Stale-while-revalidate**: Old data displays while fetch completes
- **Delta compression**: Baselines store 7-day/30-day deltas, not raw history

---

## Prediction Market Filtering

The Prediction Markets panel focuses on **geopolitically relevant** markets, filtering out sports and entertainment.

### Inclusion Keywords

Markets matching these topics are displayed:
- **Conflicts**: war, military, invasion, ceasefire, NATO, nuclear
- **Countries**: Russia, Ukraine, China, Taiwan, Iran, Israel, Gaza
- **Leaders**: Putin, Zelensky, Trump, Biden, Xi Jinping, Netanyahu
- **Economics**: Fed, interest rate, inflation, recession, tariffs, sanctions
- **Global**: UN, EU, treaties, summits, coups, refugees

### Exclusion Keywords

Markets matching these are filtered out:
- **Sports**: NBA, NFL, FIFA, World Cup, championships, playoffs
- **Entertainment**: Oscars, movies, celebrities, TikTok, streaming

This ensures the panel shows markets like "Will Russia withdraw from Ukraine?" rather than "Will the Lakers win the championship?"

---

## Panel Management

The dashboard organizes data into **draggable, collapsible panels** that persist user preferences across sessions.

### Drag-to-Reorder

Panels can be reorganized by dragging:

1. Grab the panel header (grip icon appears on hover)
2. Drag to desired position
3. Drop to reorder
4. New order saves automatically to LocalStorage

This enables personalized layouts—put your most-watched panels at the top.

### Panel Visibility

Toggle panels on/off via the Settings menu (⚙):

- **Hidden panels**: Don't render, don't fetch data
- **Visible panels**: Full functionality
- **Collapsed panels**: Header only, data still refreshes

Hiding a panel is different from disabling a layer—the panel itself doesn't appear in the interface.

### Default Panel Order

Panels are organized by intelligence priority:

| Priority | Panels | Purpose |
|----------|--------|---------|
| **Critical** | Strategic Risk, Live Intel | Immediate situational awareness |
| **Primary** | News, CII, Markets | Core monitoring data |
| **Supporting** | Predictions, Economic, Monitor | Supplementary analysis |
| **Reference** | Live News Video | Background context |

### Persistence

Panel state survives browser restarts:

- **LocalStorage**: Panel order, visibility, collapsed state
- **Automatic save**: Changes persist immediately
- **Per-device**: Settings are browser-specific (not synced)

---

## Mobile Experience

The dashboard adapts for smaller screens while maintaining core functionality.

### Mobile Detection

On screens narrower than 768px:

- **Warning modal** appears recommending desktop for full experience
- **Reduced default layers** to prevent overwhelm
- **Touch-optimized controls** for map navigation
- **Simplified panel layout** with full-width panels

### Layer Defaults by Device

| Device | Default Layers |
|--------|----------------|
| **Desktop** | Conflicts, Hotspots, Military Bases, Sanctions, Weather |
| **Mobile** | Conflicts, Hotspots, Weather |

Mobile users can still enable additional layers—defaults just prioritize performance.

### Touch Gestures

Map navigation supports:

- **Pinch zoom**: Two-finger zoom in/out
- **Drag pan**: Single-finger map movement
- **Tap markers**: Show popup (replaces hover)
- **Double-tap**: Quick zoom

---

## Energy Flow Detection

The correlation engine detects signals related to energy infrastructure and commodity markets.

### Pipeline Keywords

The system monitors news for pipeline-related events:

**Infrastructure terms**: pipeline, pipeline explosion, pipeline leak, pipeline attack, pipeline sabotage, pipeline disruption, nord stream, keystone, druzhba

**Flow indicators**: gas flow, oil flow, supply disruption, transit halt, capacity reduction

### Flow Drop Signals

When news mentions flow disruptions, two signal types may trigger:

| Signal | Criteria | Meaning |
|--------|----------|---------|
| **Flow Drop** | Pipeline keywords + disruption terms | Potential supply interruption |
| **Flow-Price Divergence** | Flow drop news + oil price stable (< $1.50 move) | Markets not yet pricing in disruption |

### Why This Matters

Energy supply disruptions create cascading effects:

1. **Immediate**: Spot price volatility
2. **Short-term**: Industrial production impacts
3. **Long-term**: Geopolitical leverage shifts

Early detection of flow drops—especially when markets haven't reacted—provides an information edge.

---

## Cross-Module Integration

Intelligence modules don't operate in isolation. Data flows between systems to enable composite analysis.

### Data Flow Architecture

```
News Feeds → Clustering → Velocity Analysis → Hotspot Correlation
                ↓                                    ↓
         Topic Extraction                    CII Information Score
                ↓                                    ↓
         Keyword Monitors              Strategic Risk Overview
                                                     ↑
Military Flights → Near-Hotspot Detection ──────────┤
                                                     ↑
AIS Vessels → Chokepoint Monitoring ────────────────┤
                                                     ↑
ACLED/GDELT → Protest Events ───────────────────────┤
                       ↓
                CII Unrest Score
```

### Module Dependencies

| Consumer Module | Data Source | Integration |
|----------------|-------------|-------------|
| **CII Unrest Score** | ACLED, GDELT protests | Event count, fatalities |
| **CII Security Score** | Military flights, vessels | Activity near hotspots |
| **CII Information Score** | News clusters | Velocity, keyword matches |
| **Strategic Risk** | CII, Convergence, Cascade | Composite scoring |
| **Related Assets** | News location inference | Pipeline/cable proximity |
| **Geographic Convergence** | All geo-located events | Multi-type clustering |

### Alert Propagation

When a threshold is crossed:

1. **Source module** generates alert (e.g., CII spike)
2. **Alert merges** with related alerts (same country/region)
3. **Strategic Risk** receives composite alert
4. **UI updates** header badge and panel indicators

This ensures a single escalation (e.g., Ukraine military flights + protests + news spike) surfaces as one coherent signal rather than three separate alerts.

---

## Refresh Intervals

Different data sources update at different frequencies based on volatility and API constraints.

### Polling Schedule

| Data Type | Interval | Rationale |
|-----------|----------|-----------|
| **News feeds** | 5 min | Balance freshness vs. rate limits |
| **Stock quotes** | 1 min | Market hours require near-real-time |
| **Crypto prices** | 1 min | 24/7 markets, high volatility |
| **Predictions** | 5 min | Probabilities shift slowly |
| **Earthquakes** | 5 min | USGS updates every 5 min |
| **Weather alerts** | 10 min | NWS alert frequency |
| **Flight delays** | 10 min | FAA status update cadence |
| **Internet outages** | 60 min | BGP events are rare |
| **Economic data** | 30 min | FRED data rarely changes intraday |
| **Military tracking** | 5 min | Activity patterns need timely updates |
| **PizzINT** | 10 min | Foot traffic changes slowly |

### Real-Time Streams

AIS vessel tracking uses WebSocket for true real-time:

- **Connection**: Persistent WebSocket to Railway relay
- **Messages**: Position updates as vessels transmit
- **Reconnection**: Automatic with exponential backoff (5s → 10s → 20s)

### User Control

Time range selector affects displayed data, not fetch frequency:

| Selection | Effect |
|-----------|--------|
| **1 hour** | Show only events from last 60 minutes |
| **6 hours** | Show events from last 6 hours |
| **24 hours** | Show events from last day |
| **7 days** | Show all recent events |

Historical filtering is client-side—all data is fetched but filtered for display.

---

## Tech Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| **Language** | TypeScript 5.x | Type safety across 50+ source files |
| **Build** | Vite | Fast HMR, optimized production builds |
| **Visualization** | D3.js + TopoJSON | SVG map rendering, zoom/pan, animations |
| **Concurrency** | Web Workers | Off-main-thread clustering and correlation |
| **Networking** | WebSocket + REST | Real-time AIS stream, HTTP for other APIs |
| **Storage** | IndexedDB | Snapshots, baselines (megabytes of state) |
| **Preferences** | LocalStorage | User settings, monitors, panel order |
| **Deployment** | Vercel Edge | Serverless proxies with global distribution |

### Key Libraries

- **D3.js**: Map projection, SVG rendering, zoom behavior
- **TopoJSON**: Efficient geographic data encoding
- **DOMPurify pattern**: HTML escaping (custom implementation)

### No External UI Frameworks

The entire UI is hand-crafted DOM manipulation—no React, Vue, or Angular. This keeps the bundle small (~200KB gzipped) and provides fine-grained control over rendering performance.

## Installation

```bash
# Clone the repository
git clone https://github.com/koala73/worldmonitor.git
cd worldmonitor

# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build
```

## API Dependencies

The dashboard fetches data from various public APIs and data sources:

| Service | Data | Auth Required |
|---------|------|---------------|
| RSS2JSON | News feed parsing | No |
| Finnhub | Stock quotes (primary) | Yes (free) |
| Yahoo Finance | Stock indices & commodities (backup) | No |
| CoinGecko | Cryptocurrency prices | No |
| USGS | Earthquake data | No |
| NASA EONET | Natural events (storms, fires, volcanoes, floods) | No |
| NWS | Weather alerts | No |
| FRED | Economic indicators (Fed data) | No |
| Polymarket | Prediction markets | No |
| ACLED | Armed conflict & protest data | Yes (free) |
| GDELT Geo | News-derived event geolocation + tensions | No |
| GDELT Doc | Topic-based intelligence feeds (cyber, military, nuclear) | No |
| FAA NASSTATUS | Airport delay status | No |
| Cloudflare Radar | Internet outage data | Yes (free) |
| AISStream | Live vessel positions | Yes (relay) |
| OpenSky Network | Military aircraft tracking | Yes (free) |
| Wingbits | Aircraft enrichment (owner, operator) | Yes (free) |
| PizzINT | Pentagon-area activity metrics | No |

### Optional API Keys

Some features require API credentials. Without them, the corresponding layer is hidden:

| Variable | Service | How to Get |
|----------|---------|------------|
| `FINNHUB_API_KEY` | Stock quotes (primary) | Free registration at [finnhub.io](https://finnhub.io/) |
| `VITE_WS_RELAY_URL` | AIS vessel tracking | Deploy AIS relay or use hosted service |
| `VITE_OPENSKY_RELAY_URL` | Military aircraft | Deploy relay with OpenSky credentials |
| `OPENSKY_CLIENT_ID` | OpenSky auth (relay) | Free registration at [opensky-network.org](https://opensky-network.org) |
| `OPENSKY_CLIENT_SECRET` | OpenSky auth (relay) | API key from OpenSky account settings |
| `CLOUDFLARE_API_TOKEN` | Internet outages | Free Cloudflare account with Radar access |
| `ACLED_ACCESS_TOKEN` | Protest data (server-side) | Free registration at acleddata.com |
| `WINGBITS_API_KEY` | Aircraft enrichment | Contact [Wingbits](https://wingbits.com) for API access |

The dashboard functions fully without these keys—affected layers simply don't appear. Core functionality (news, markets, earthquakes, weather) requires no configuration.

## Project Structure

```
src/
├── App.ts                    # Main application orchestrator
├── main.ts                   # Entry point
├── components/
│   ├── Map.ts                # D3.js map with 20+ toggleable layers
│   ├── MapPopup.ts           # Contextual info popups
│   ├── SearchModal.ts        # Universal search (⌘K)
│   ├── SignalModal.ts        # Signal intelligence display
│   ├── PizzIntIndicator.ts   # Pentagon Pizza Index display
│   ├── VirtualList.ts        # Virtual/windowed scrolling
│   ├── EconomicPanel.ts      # FRED economic indicators
│   ├── GdeltIntelPanel.ts    # Topic-based intelligence (cyber, military, etc.)
│   ├── LiveNewsPanel.ts      # YouTube live news streams with channel switching
│   ├── NewsPanel.ts          # News feed with clustering
│   ├── MarketPanel.ts        # Stock/commodity display
│   ├── MonitorPanel.ts       # Custom keyword monitors
│   ├── CIIPanel.ts           # Country Instability Index display
│   ├── CascadePanel.ts       # Infrastructure cascade analysis
│   ├── StrategicRiskPanel.ts # Strategic risk overview dashboard
│   └── ...
├── config/
│   ├── feeds.ts              # 45+ RSS feeds, source tiers
│   ├── geo.ts                # Hotspots, conflicts, 55 cables, waterways
│   ├── pipelines.ts          # 88 oil & gas pipelines
│   ├── ports.ts              # 61 strategic ports worldwide
│   ├── bases-expanded.ts     # 220+ military bases
│   ├── ai-datacenters.ts     # 313 AI clusters (filtered to 111)
│   ├── airports.ts           # 30 monitored US airports
│   ├── irradiators.ts        # IAEA gamma irradiator sites
│   ├── nuclear-facilities.ts # Global nuclear infrastructure
│   └── markets.ts            # Stock symbols, sectors
├── services/
│   ├── ais.ts                # WebSocket vessel tracking
│   ├── military-vessels.ts   # Naval vessel identification
│   ├── military-flights.ts   # Aircraft tracking via OpenSky
│   ├── wingbits.ts           # Aircraft enrichment (owner, operator, type)
│   ├── pizzint.ts            # Pentagon Pizza Index + GDELT tensions
│   ├── protests.ts           # ACLED + GDELT integration
│   ├── gdelt-intel.ts        # GDELT Doc API topic intelligence
│   ├── flights.ts            # FAA delay parsing
│   ├── outages.ts            # Cloudflare Radar integration
│   ├── rss.ts                # RSS parsing with circuit breakers
│   ├── markets.ts            # Finnhub, Yahoo Finance, CoinGecko
│   ├── earthquakes.ts        # USGS integration
│   ├── eonet.ts              # NASA EONET natural events
│   ├── weather.ts            # NWS alerts
│   ├── fred.ts               # Federal Reserve data
│   ├── polymarket.ts         # Prediction markets (filtered)
│   ├── clustering.ts         # Jaccard similarity clustering
│   ├── correlation.ts        # Signal detection engine
│   ├── velocity.ts           # Velocity & sentiment analysis
│   ├── related-assets.ts     # Infrastructure near news events
│   ├── activity-tracker.ts   # New item detection & highlighting
│   ├── analysis-worker.ts    # Web Worker manager
│   ├── storage.ts            # IndexedDB snapshots & baselines
│   ├── country-instability.ts    # CII scoring algorithm
│   ├── geo-convergence.ts        # Geographic convergence detection
│   ├── infrastructure-cascade.ts # Dependency graph and cascade analysis
│   └── cross-module-integration.ts # Unified alerts and strategic risk
├── workers/
│   └── analysis.worker.ts    # Off-thread clustering & correlation
├── utils/
│   ├── circuit-breaker.ts    # Fault tolerance pattern
│   ├── sanitize.ts           # XSS prevention (escapeHtml, sanitizeUrl)
│   ├── urlState.ts           # Shareable link encoding/decoding
│   └── analysis-constants.ts # Shared thresholds for worker sync
├── styles/
└── types/
api/                          # Vercel Edge serverless proxies
├── cloudflare-outages.js     # Proxies Cloudflare Radar
├── coingecko.js              # Crypto prices with validation
├── faa-status.js             # FAA ground stops/delays
├── finnhub.js                # Stock quotes (batch, primary)
├── fred-data.js              # Federal Reserve economic data
├── gdelt-doc.js              # GDELT Doc API (topic intelligence)
├── gdelt-geo.js              # GDELT Geo API (event geolocation)
├── polymarket.js             # Prediction markets with validation
├── yahoo-finance.js          # Stock indices/commodities (backup)
├── opensky-relay.js          # Military aircraft tracking
└── wingbits.js               # Aircraft enrichment proxy
```

## Usage

### Keyboard Shortcuts
- `⌘K` / `Ctrl+K` - Open search
- `↑↓` - Navigate search results
- `Enter` - Select result
- `Esc` - Close modals

### Map Controls
- **Scroll** - Zoom in/out
- **Drag** - Pan the map
- **Click markers** - Show detailed popup
- **Layer toggles** - Show/hide data layers

### Panel Management
- **Drag panels** - Reorder layout
- **Settings (⚙)** - Toggle panel visibility

### Shareable Links

The current view state is encoded in the URL, enabling:
- **Bookmarking**: Save specific views for quick access
- **Sharing**: Send colleagues a link to your exact map position and layer configuration
- **Deep linking**: Link directly to a specific region or feature

**Encoded Parameters**:
| Parameter | Description |
|-----------|-------------|
| `lat`, `lon` | Map center coordinates |
| `zoom` | Zoom level (1-10) |
| `time` | Active time filter (1h, 6h, 24h, 7d) |
| `view` | Preset view (global, us, mena) |
| `layers` | Comma-separated enabled layer IDs |

Example: `?lat=38.9&lon=-77&zoom=6&layers=bases,conflicts,hotspots`

Values are validated and clamped to prevent invalid states.

## Data Sources

### News Feeds
Aggregates **45+ RSS feeds** from major news outlets, government sources, and specialty publications with source-tier prioritization. Categories include world news, MENA, technology, AI/ML, finance, government releases, defense/intel, and think tanks.

### Geospatial Data
- **Hotspots**: 25+ global intelligence hotspots with keyword correlation
- **Conflicts**: 10+ active conflict zones with involved parties
- **Military Bases**: 220+ installations from US, NATO, Russia, China, and allies
- **Pipelines**: 88 operating oil/gas pipelines across all continents
- **Undersea Cables**: 55 major submarine cable routes
- **Nuclear**: 100+ power plants, weapons labs, enrichment facilities
- **AI Infrastructure**: 111 major compute clusters (≥10k GPUs)
- **Strategic Waterways**: 8 critical chokepoints
- **Ports**: 61 strategic ports (container, oil/LNG, naval, chokepoint)

### Live APIs
- **USGS**: Earthquake feed (M4.5+ global)
- **NASA EONET**: Natural events (storms, wildfires, volcanoes, floods)
- **NWS**: Severe weather alerts (US)
- **FAA**: Airport delays and ground stops
- **Cloudflare Radar**: Internet outage detection
- **AIS**: Real-time vessel positions
- **ACLED/GDELT**: Protest and unrest events
- **Yahoo Finance**: Stock quotes and indices
- **CoinGecko**: Cryptocurrency prices
- **FRED**: Federal Reserve economic data
- **Polymarket**: Prediction market odds

## Data Attribution

This project uses data from the following sources. Please respect their terms of use.

### Aircraft Tracking
Data provided by [The OpenSky Network](https://opensky-network.org). If you use this data in publications, please cite:

> Matthias Schäfer, Martin Strohmeier, Vincent Lenders, Ivan Martinovic and Matthias Wilhelm. "Bringing Up OpenSky: A Large-scale ADS-B Sensor Network for Research". In *Proceedings of the 13th IEEE/ACM International Symposium on Information Processing in Sensor Networks (IPSN)*, pages 83-94, April 2014.

### Conflict & Protest Data
- **ACLED**: Armed Conflict Location & Event Data. Source: [ACLED](https://acleddata.com). Data must be attributed per their [Attribution Policy](https://acleddata.com/attributionpolicy/).
- **GDELT**: Global Database of Events, Language, and Tone. Source: [The GDELT Project](https://www.gdeltproject.org/).

### Financial Data
- **Stock Quotes**: Powered by [Finnhub](https://finnhub.io/) (primary), with [Yahoo Finance](https://finance.yahoo.com/) as backup for indices and commodities
- **Cryptocurrency**: Powered by [CoinGecko API](https://www.coingecko.com/en/api)
- **Economic Indicators**: Data from [FRED](https://fred.stlouisfed.org/), Federal Reserve Bank of St. Louis

### Geophysical Data
- **Earthquakes**: [U.S. Geological Survey](https://earthquake.usgs.gov/), ANSS Comprehensive Catalog
- **Natural Events**: [NASA EONET](https://eonet.gsfc.nasa.gov/) - Earth Observatory Natural Event Tracker (storms, wildfires, volcanoes, floods)
- **Weather Alerts**: [National Weather Service](https://www.weather.gov/) - Open data, free to use

### Infrastructure & Transport
- **Airport Delays**: [FAA Air Traffic Control System Command Center](https://www.fly.faa.gov/)
- **Vessel Tracking**: [AISstream](https://aisstream.io/) real-time AIS data
- **Internet Outages**: [Cloudflare Radar](https://radar.cloudflare.com/) (CC BY-NC 4.0)

### Other Sources
- **Prediction Markets**: [Polymarket](https://polymarket.com/)

## Acknowledgments

Original dashboard concept inspired by Reggie James ([@HipCityReg](https://x.com/HipCityReg/status/2009003048044220622)) - with thanks for the vision of a comprehensive situation awareness tool

Special thanks to **Yanal at [Wingbits](https://wingbits.com)** for providing API access for aircraft enrichment data, enabling military aircraft classification and ownership tracking

---

## Limitations & Caveats

This project is a **proof of concept** demonstrating what's possible with publicly available data. While functional, there are important limitations:

### Data Completeness

Some data sources require paid accounts for full access:
- **ACLED**: Free tier has API restrictions; Research tier required for programmatic access
- **OpenSky Network**: Rate-limited; commercial tiers offer higher quotas
- **Satellite AIS**: Global coverage requires commercial providers (Spire, Kpler, etc.)

The dashboard works with free tiers but may have gaps in coverage or update frequency.

### AIS Coverage Bias

The Ships layer uses terrestrial AIS receivers via [AISStream.io](https://aisstream.io). This creates a **geographic bias**:
- **Strong coverage**: European waters, Atlantic, major ports
- **Weak coverage**: Middle East, open ocean, remote regions

Terrestrial receivers only detect vessels within ~50km of shore. Satellite AIS (commercial) provides true global coverage but is not included in this free implementation.

### Blocked Data Sources

Some publishers block requests from cloud providers (Vercel, Railway, AWS):
- RSS feeds from certain outlets may fail with 403 errors
- This is a common anti-bot measure, not a bug in the dashboard
- Affected feeds are automatically disabled via circuit breakers

The system degrades gracefully—blocked sources are skipped while others continue functioning.

---

## Roadmap

See [ROADMAP.md](ROADMAP.md) for detailed planning. Recent intelligence enhancements:

### Completed

- ✅ **Multi-Signal Geographic Convergence** - Alerts when 3+ data types converge on same region within 24h
- ✅ **Country Instability Index (CII)** - Real-time composite risk score for 20 Tier-1 countries
- ✅ **Infrastructure Cascade Visualization** - Dependency graph showing downstream effects of disruptions
- ✅ **Strategic Risk Overview** - Unified alert system with cross-module correlation and deduplication
- ✅ **GDELT Topic Intelligence** - Categorized feeds for military, cyber, nuclear, and sanctions topics
- ✅ **OpenSky Authentication** - OAuth2 credentials for military aircraft tracking via relay
- ✅ **Human-Readable Locations** - Convergence alerts show place names instead of coordinates
- ✅ **Data Freshness Tracking** - Status panel shows enabled/disabled state for all feeds

### Planned

**High Priority:**
- **Temporal Anomaly Detection** - Flag activity unusual for time of day/week/year (e.g., "military flights 3x normal for Tuesday")
- **Trade Route Risk Scoring** - Real-time supply chain vulnerability for major shipping routes (Asia→Europe, Middle East→Europe, etc.)

**Medium Priority:**
- **Historical Playback** - Review past dashboard states with timeline scrubbing
- **Election Calendar Integration** - Auto-boost sensitivity 30 days before major elections
- **Choropleth CII Map Layer** - Country-colored overlay showing instability scores

**Future Enhancements:**
- **Alert Webhooks** - Push critical alerts to Slack, Discord, email
- **Custom Country Watchlists** - User-defined Tier-2 country monitoring
- **Additional Data Sources** - World Bank, IMF, OFAC sanctions, UNHCR refugee data, FAO food security
- **Think Tank Feeds** - RUSI, Chatham House, ECFR, CFR, Wilson Center, CNAS, Arms Control Association

The full [ROADMAP.md](ROADMAP.md) documents implementation details, API endpoints, and 30+ free data sources for future integration.

---

## Design Philosophy

**Information density over aesthetics.** Every pixel should convey signal. The dark interface minimizes eye strain during extended monitoring sessions.

**Authority matters.** Not all sources are equal. Wire services and official government channels are prioritized over aggregators and blogs.

**Correlation over accumulation.** Raw news feeds are noise. The value is in clustering related stories, detecting velocity changes, and identifying cross-source patterns.

**Local-first.** No accounts, no cloud sync. All preferences and history stored locally. The only network traffic is fetching public data.

---

## Contributing

Contributions are welcome! Whether you're fixing bugs, adding features, improving documentation, or suggesting ideas, your help makes this project better.

### Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/worldmonitor.git
   cd worldmonitor
   ```
3. **Install dependencies**:
   ```bash
   npm install
   ```
4. **Create a feature branch**:
   ```bash
   git checkout -b feature/your-feature-name
   ```
5. **Start the development server**:
   ```bash
   npm run dev
   ```

### Code Style & Conventions

This project follows specific patterns to maintain consistency:

**TypeScript**
- Strict type checking enabled—avoid `any` where possible
- Use interfaces for data structures, types for unions
- Prefer `const` over `let`, never use `var`

**Architecture**
- Services (`src/services/`) handle data fetching and business logic
- Components (`src/components/`) handle UI rendering
- Config (`src/config/`) contains static data and constants
- Utils (`src/utils/`) contain shared helper functions

**Security**
- Always use `escapeHtml()` when rendering user-controlled or external data
- Use `sanitizeUrl()` for any URLs from external sources
- Validate and clamp parameters in API proxy endpoints

**Performance**
- Expensive computations should run in the Web Worker
- Use virtual scrolling for lists with 50+ items
- Implement circuit breakers for external API calls

**No Comments Policy**
- Code should be self-documenting through clear naming
- Only add comments for non-obvious algorithms or workarounds
- Never commit commented-out code

### Submitting a Pull Request

1. **Ensure your code builds**:
   ```bash
   npm run build
   ```

2. **Test your changes** manually in the browser

3. **Write a clear commit message**:
   ```
   Add earthquake magnitude filtering to map layer

   - Adds slider control to filter by minimum magnitude
   - Persists preference to localStorage
   - Updates URL state for shareable links
   ```

4. **Push to your fork**:
   ```bash
   git push origin feature/your-feature-name
   ```

5. **Open a Pull Request** with:
   - A clear title describing the change
   - Description of what the PR does and why
   - Screenshots for UI changes
   - Any breaking changes or migration notes

### What Makes a Good PR

| Do | Don't |
|----|-------|
| Focus on one feature or fix | Bundle unrelated changes |
| Follow existing code patterns | Introduce new frameworks without discussion |
| Keep changes minimal and targeted | Refactor surrounding code unnecessarily |
| Update README if adding features | Add features without documentation |
| Test edge cases | Assume happy path only |

### Types of Contributions

**🐛 Bug Fixes**
- Found something broken? Fix it and submit a PR
- Include steps to reproduce in the PR description

**✨ New Features**
- New data layers (with public API sources)
- UI/UX improvements
- Performance optimizations
- New signal detection algorithms

**📊 Data Sources**
- Additional RSS feeds for news aggregation
- New geospatial datasets (bases, infrastructure, etc.)
- Alternative APIs for existing data

**📝 Documentation**
- Clarify existing documentation
- Add examples and use cases
- Fix typos and improve readability

**🔒 Security**
- Report vulnerabilities via GitHub Issues (non-critical) or email (critical)
- XSS prevention improvements
- Input validation enhancements

### Review Process

1. **Automated checks** run on PR submission
2. **Maintainer review** within a few days
3. **Feedback addressed** through commits to the same branch
4. **Merge** once approved

PRs that don't follow the code style or introduce security issues will be asked to revise.

### Development Tips

**Adding a New Data Layer**

1. Create service in `src/services/` for data fetching
2. Add layer toggle in `src/components/Map.ts`
3. Add rendering logic for map markers/overlays
4. Add to help panel documentation
5. Update README with layer description

**Adding a New API Proxy**

1. Create handler in `api/` directory
2. Implement input validation (see existing proxies)
3. Add appropriate cache headers
4. Document any required environment variables

**Debugging**

- Browser DevTools → Network tab for API issues
- Console logs prefixed with `[ServiceName]` for easy filtering
- Circuit breaker status visible in browser console

---

## License

MIT

## Author

**Elie Habib**

---

*Built for situational awareness and open-source intelligence gathering.*
