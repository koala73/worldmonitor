# World Monitor v2

AI-powered real-time global intelligence dashboard aggregating news, markets, geopolitical data, and infrastructure monitoring into a unified situation awareness interface.

🌐 **[Live Demo: worldmonitor.app](https://worldmonitor.app)** | 💻 **[Tech Variant: tech.worldmonitor.app](https://tech.worldmonitor.app)**

![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat&logo=vite&logoColor=white)
![D3.js](https://img.shields.io/badge/D3.js-F9A03C?style=flat&logo=d3.js&logoColor=white)
![Version](https://img.shields.io/badge/version-2.1.4-blue)

![World Monitor Dashboard](../new-world-monitor.png)

## Platform Variants

World Monitor runs two specialized variants from a single codebase, each optimized for different monitoring needs:

| Variant | URL | Focus |
|---------|-----|-------|
| **🌍 World Monitor** | [worldmonitor.app](https://worldmonitor.app) | Geopolitical intelligence, military tracking, conflict monitoring, infrastructure security |
| **💻 Tech Monitor** | [tech.worldmonitor.app](https://tech.worldmonitor.app) | Technology sector intelligence, AI/startup ecosystems, cloud infrastructure, tech events |

A compact **variant switcher** in the header allows seamless navigation between variants while preserving your map position and panel configuration.

---

## World Monitor (Geopolitical)

The primary variant focuses on geopolitical intelligence, military tracking, and infrastructure security monitoring.

### Key Capabilities

- **Conflict Monitoring** - Active war zones, hotspots, and crisis areas with real-time escalation tracking
- **Military Intelligence** - 220+ military bases, flight tracking, naval vessel monitoring, surge detection
- **Infrastructure Security** - Undersea cables, pipelines, datacenters, internet outages
- **Economic Intelligence** - FRED indicators, oil analytics, government spending, sanctions tracking
- **Natural Disasters** - Earthquakes, severe weather, NASA EONET events (wildfires, volcanoes, floods)
- **AI-Powered Analysis** - Focal point detection, country instability scoring, infrastructure cascade analysis

### Intelligence Panels

| Panel | Purpose |
|-------|---------|
| **AI Insights** | LLM-synthesized world brief with focal point detection |
| **AI Strategic Posture** | Theater-level military force aggregation with strike capability assessment |
| **Country Instability Index** | Real-time stability scores for 20 monitored countries |
| **Strategic Risk Overview** | Composite risk score combining all intelligence modules |
| **Infrastructure Cascade** | Dependency analysis for cables, pipelines, and chokepoints |
| **Live Intelligence** | GDELT-powered topic feeds (Military, Cyber, Nuclear, Sanctions) |

### News Coverage

80+ curated sources across geopolitics, defense, energy, think tanks, and regional news (Middle East, Africa, Latin America, Asia-Pacific).

---

## Tech Monitor

The tech variant ([tech.worldmonitor.app](https://tech.worldmonitor.app)) provides specialized layers for technology sector monitoring.

### Tech Ecosystem Layers

| Layer | Description |
|-------|-------------|
| **Tech HQs** | Headquarters of major tech companies (Big Tech, unicorns, public companies) |
| **Startup Hubs** | Major startup ecosystems with ecosystem tier, funding data, and notable companies |
| **Cloud Regions** | AWS, Azure, GCP data center regions with zone counts |
| **Accelerators** | Y Combinator, Techstars, 500 Startups, and regional accelerator locations |
| **Tech Events** | Upcoming conferences and tech events with countdown timers |

### Tech Infrastructure Layers

| Layer | Description |
|-------|-------------|
| **AI Datacenters** | 111 major AI compute clusters (≥10,000 GPUs) |
| **Undersea Cables** | Submarine fiber routes critical for cloud connectivity |
| **Internet Outages** | Network disruptions affecting tech operations |

### Tech News Categories

- **Startups & VC** - Funding rounds, acquisitions, startup news
- **Cybersecurity** - Security vulnerabilities, breaches, threat intelligence
- **Cloud & Infrastructure** - AWS, Azure, GCP announcements, outages
- **Hardware & Chips** - Semiconductors, AI accelerators, manufacturing
- **Developer & Open Source** - Languages, frameworks, open source projects
- **Tech Policy** - Regulation, antitrust, digital governance

### Regional Tech HQ Coverage

| Region | Notable Companies |
|--------|------------------|
| **Silicon Valley** | Apple, Google, Meta, Nvidia, Intel, Cisco, Oracle, VMware |
| **Seattle** | Microsoft, Amazon, Tableau, Expedia |
| **New York** | Bloomberg, MongoDB, Datadog, Squarespace |
| **London** | Revolut, Deliveroo, Darktrace, Monzo |
| **Tel Aviv** | Wix, Check Point, Monday.com, Fiverr |
| **Dubai/MENA** | Careem, Noon, Anghami, Property Finder, Kitopi |
| **Riyadh** | Tabby, Presight.ai, Ninja, XPANCEO |
| **Singapore** | Grab, Razer, Sea Limited |
| **Berlin** | Zalando, Delivery Hero, N26, Celonis |
| **Tokyo** | Sony, Toyota, SoftBank, Rakuten |

---

## Features

### Interactive Global Map

- **Zoom & Pan** - Smooth navigation with mouse/trackpad gestures
- **Regional Focus** - 8 preset views for rapid navigation (Global, Americas, Europe, MENA, Asia, Latin America, Africa, Oceania)
- **Layer System** - Toggle visibility of 20+ data layers organized by category
- **Time Filtering** - Filter events by time range (1h, 6h, 24h, 48h, 7d)
- **Pinnable Map** - Pin the map to the top while scrolling through panels, or let it scroll with the page
- **Smart Marker Clustering** - Nearby markers group at low zoom, expand on zoom in

### Marker Clustering

Dense regions with many data points use intelligent clustering to prevent visual clutter:

**How It Works**

- Markers within a pixel radius (adaptive to zoom level) merge into cluster badges
- Cluster badges show the count of grouped items
- Clicking a cluster opens a popup listing all grouped items
- Zooming in reduces cluster radius, eventually showing individual markers

**Grouping Logic**

- **Protests**: Cluster within same country only (riots sorted first, high severity prioritized)
- **Tech HQs**: Cluster within same city (Big Tech sorted before unicorns before public companies)
- **Tech Events**: Cluster within same location (sorted by date, soonest first)

This prevents issues like Dubai and Riyadh companies appearing merged at global zoom, while still providing clean visualization at continental scales.

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
| **APT Groups** | State-sponsored cyber threat actors with geographic attribution |
| **Spaceports** | 12 major launch facilities (NASA, SpaceX, Roscosmos, CNSA, ESA, ISRO, JAXA) |
| **Critical Minerals** | Strategic mineral deposits (lithium, cobalt, rare earths) with operator info |

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
| **Economic** | Tabbed economic panel with FRED indicators, EIA oil analytics, and USASpending.gov government contracts |
| **Countries** | Country boundary labels |
| **Waterways** | Strategic waterways and chokepoints |

### Intelligence Panels

Beyond raw data feeds, the dashboard provides synthesized intelligence panels:

| Panel | Purpose |
|-------|---------|
| **AI Strategic Posture** | Theater-level military aggregation with strike capability analysis |
| **Strategic Risk Overview** | Composite risk score combining all intelligence modules |
| **Country Instability Index** | Real-time stability scores for 20 monitored countries |
| **Infrastructure Cascade** | Dependency analysis for cables, pipelines, and chokepoints |
| **Live Intelligence** | GDELT-powered topic feeds (Military, Cyber, Nuclear, Sanctions) |
| **Intel Feed** | Curated defense and security news sources |

These panels transform raw signals into actionable intelligence by applying scoring algorithms, trend detection, and cross-source correlation.

### News Aggregation

Multi-source RSS aggregation across categories:

- **World / Geopolitical** - BBC, Reuters, AP, Guardian, NPR, Politico, The Diplomat
- **Middle East / MENA** - Al Jazeera, BBC ME, Guardian ME, Al Arabiya, Times of Israel
- **Africa** - BBC Africa, News24, Google News aggregation (regional & Sahel coverage)
- **Latin America** - BBC Latin America, Guardian Americas, Google News aggregation
- **Asia-Pacific** - BBC Asia, South China Morning Post, Google News aggregation
- **Energy & Resources** - Google News aggregation (oil/gas, nuclear, mining, Reuters Energy)
- **Technology** - Hacker News, Ars Technica, The Verge, MIT Tech Review
- **AI / ML** - ArXiv, VentureBeat AI, The Verge AI, MIT Tech Review
- **Finance** - CNBC, MarketWatch, Financial Times, Yahoo Finance
- **Government** - White House, State Dept, Pentagon, Treasury, Fed, SEC, UN News, CISA
- **Intel Feed** - Defense One, Breaking Defense, Bellingcat, Krebs Security, Janes
- **Think Tanks** - Foreign Policy, Atlantic Council, Foreign Affairs, CSIS, RAND, Brookings, Carnegie
- **Crisis Watch** - International Crisis Group, IAEA, WHO, UNHCR
- **Regional Sources** - Xinhua, TASS, Kyiv Independent, Moscow Times
- **Layoffs Tracker** - Tech industry job cuts

### Source Filtering

The **📡 SOURCES** button in the header opens a global source management modal, enabling fine-grained control over which news sources appear in the dashboard.

**Capabilities:**

- **Search**: Filter the source list by name to quickly find specific outlets
- **Individual Toggle**: Click any source to enable/disable it
- **Bulk Actions**: "Select All" and "Select None" for quick adjustments
- **Counter Display**: Shows "45/77 enabled" to indicate current selection
- **Persistence**: Settings are saved to localStorage and persist across sessions

**Use Cases:**

- **Noise Reduction**: Disable high-volume aggregators (Google News) to focus on primary sources
- **Regional Focus**: Enable only sources relevant to a specific geographic area
- **Source Quality**: Disable sources with poor signal-to-noise ratio
- **Bias Management**: Balance coverage by enabling/disabling sources with known editorial perspectives

**Technical Details:**

- Disabled sources are filtered at fetch time (not display time), reducing bandwidth and API calls
- Affects all news panels simultaneously—disable BBC once, it's gone everywhere
- Panels with all sources disabled show "All sources disabled" message
- Changes take effect on the next refresh cycle

### Regional Intelligence Panels

Dedicated panels provide focused coverage for strategically significant regions:

| Panel | Coverage | Key Topics |
|-------|----------|------------|
| **Middle East** | MENA region | Israel-Gaza, Iran, Gulf states, Red Sea |
| **Africa** | Sub-Saharan Africa | Sahel instability, coups, insurgencies, resources |
| **Latin America** | Central & South America | Venezuela, drug trafficking, regional politics |
| **Asia-Pacific** | East & Southeast Asia | China-Taiwan, Korean peninsula, ASEAN |
| **Energy & Resources** | Global | Oil markets, nuclear, mining, energy security |

Each panel aggregates region-specific sources to provide concentrated situational awareness for that theater. This enables focused monitoring when global events warrant attention to a particular region.

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

**Core Features:**

- **Channel Switcher** - One-click switching between networks
- **Live Indicator** - Blinking dot shows stream status, click to pause/play
- **Mute Toggle** - Audio control (muted by default)
- **Double-Width Panel** - Larger video player for better viewing

**Performance Optimizations:**

The live stream panel uses the **YouTube IFrame Player API** rather than raw iframe embedding. This provides several advantages:

| Feature | Benefit |
|---------|---------|
| **Persistent player** | No iframe reload on mute/play/channel change |
| **API control** | Direct `playVideo()`, `pauseVideo()`, `mute()` calls |
| **Reduced bandwidth** | Same stream continues across state changes |
| **Faster switching** | Channel changes via `loadVideoById()` |

**Idle Detection:**

To conserve resources, the panel implements automatic idle pausing:

| Trigger | Action |
|---------|--------|
| **Tab hidden** | Stream pauses (via Visibility API) |
| **5 min idle** | Stream pauses (no mouse/keyboard activity) |
| **User returns** | Stream resumes automatically |
| **Manual pause** | User intent tracked separately |

This prevents background tabs from consuming bandwidth while preserving user preference for manually-paused streams.

### Market Data

- **Stocks** - Major indices and tech stocks via Finnhub (Yahoo Finance backup)
- **Commodities** - Oil, gold, natural gas, copper, VIX
- **Crypto** - Bitcoin, Ethereum, Solana via CoinGecko
- **Sector Heatmap** - Visual sector performance (11 SPDR sectors)
- **Economic Indicators** - Fed data via FRED (assets, rates, yields)
- **Oil Analytics** - EIA data: WTI/Brent prices, US production, US inventory with weekly changes
- **Government Spending** - USASpending.gov: Recent federal contracts and awards

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

### Intelligence Findings Badge

The header displays an **Intelligence Findings** badge that consolidates two types of alerts:

| Alert Type | Source | Examples |
|------------|--------|----------|
| **Correlation Signals** | Cross-source pattern detection | Velocity spikes, market divergence, prediction leading |
| **Unified Alerts** | Module-generated alerts | CII spikes, geographic convergence, infrastructure cascades |

**Interaction**: Clicking the badge—or clicking an individual alert—opens a detail modal showing:

- Full alert description and context
- Component breakdown (for composite alerts)
- Affected countries or regions
- Confidence score and priority level
- Timestamp and trending direction

This provides a unified command center for all intelligence findings, whether generated by correlation analysis or module-specific threshold detection.

### Signal Types

The system detects 12 distinct signal types across news, markets, military, and infrastructure domains:

**News & Source Signals**

| Signal | Trigger | What It Means |
|--------|---------|---------------|
| **◉ Convergence** | 3+ source types report same story within 30 minutes | Multiple independent channels confirming the same event—higher likelihood of significance |
| **△ Triangulation** | Wire + Government + Intel sources align | The "authority triangle"—when official channels, wire services, and defense specialists all report the same thing |
| **🔥 Velocity Spike** | Topic mention rate doubles with 6+ sources/hour | A story is accelerating rapidly across the news ecosystem |

**Market Signals**

| Signal | Trigger | What It Means |
|--------|---------|---------------|
| **🔮 Prediction Leading** | Prediction market moves 5%+ with low news coverage | Markets pricing in information not yet reflected in news |
| **📰 News Leads Markets** | High news velocity without corresponding market move | Breaking news not yet priced in—potential mispricing |
| **✓ Market Move Explained** | Market moves 2%+ with correlated news coverage | Price action has identifiable news catalyst—entity correlation found related stories |
| **📊 Silent Divergence** | Market moves 2%+ with no correlated news after entity search | Unexplained price action after exhaustive search—possible insider knowledge or algorithm-driven |
| **📈 Sector Cascade** | Multiple related sectors moving in same direction | Market reaction cascading through correlated industries |

**Infrastructure & Energy Signals**

| Signal | Trigger | What It Means |
|--------|---------|---------------|
| **🛢 Flow Drop** | Pipeline flow disruption keywords detected | Physical commodity supply constraint—may precede price spike |
| **🔁 Flow-Price Divergence** | Pipeline disruption news without corresponding oil price move | Energy supply disruption not yet priced in—potential information edge |

**Geopolitical & Military Signals**

| Signal | Trigger | What It Means |
|--------|---------|---------------|
| **🌍 Geographic Convergence** | 3+ event types in same 1°×1° grid cell | Multiple independent data streams converging on same location—heightened regional activity |
| **🔺 Hotspot Escalation** | Multi-component score exceeds threshold with rising trend | Hotspot showing corroborated escalation across news, CII, convergence, and military data |
| **✈ Military Surge** | Transport/fighter activity 2× baseline in theater | Unusual military airlift concentration—potential deployment or crisis response |

### How It Works

The correlation engine maintains rolling snapshots of:

- News topic frequency (by keyword extraction)
- Market price changes
- Prediction market probabilities

Each refresh cycle compares current state to previous snapshot, applying thresholds and deduplication to avoid alert fatigue. Signals include confidence scores (60-95%) based on the strength of the pattern.

### Entity-Aware Correlation

The signal engine uses a **knowledge base of 100+ entities** to intelligently correlate market movements with news coverage. Rather than simple keyword matching, the system understands that "AVGO" (the ticker) relates to "Broadcom" (the company), "AI chips" (the sector), and entities like "Nvidia" (a competitor).

#### Entity Knowledge Base

Each entity in the registry contains:

| Field | Purpose | Example |
|-------|---------|---------|
| **ID** | Canonical identifier | `broadcom` |
| **Name** | Display name | `Broadcom Inc.` |
| **Type** | Category | `company`, `commodity`, `crypto`, `country`, `person` |
| **Aliases** | Alternative names | `AVGO`, `Broadcom`, `Broadcom Inc` |
| **Keywords** | Related topics | `AI chips`, `semiconductors`, `VMware` |
| **Sector** | Industry classification | `semiconductors` |
| **Related** | Linked entities | `nvidia`, `intel`, `amd` |

#### Entity Types

| Type | Count | Examples |
|------|-------|----------|
| **Companies** | 50+ | Nvidia, Apple, Tesla, Broadcom, Boeing, Lockheed Martin, TSMC, Rheinmetall |
| **Indices** | 5+ | S&P 500, Dow Jones, NASDAQ |
| **Sectors** | 10+ | Technology (XLK), Finance (XLF), Energy (XLE), Healthcare (XLV), Semiconductors (SMH) |
| **Commodities** | 10+ | Oil (WTI), Gold, Natural Gas, Copper, Silver, VIX |
| **Crypto** | 3 | Bitcoin, Ethereum, Solana |
| **Countries** | 15+ | China, Russia, Iran, Israel, Ukraine, Taiwan, Saudi Arabia, UAE, Qatar, Turkey, Egypt |

#### How Entity Matching Works

When a market moves significantly (≥2%), the system:

1. **Looks up the ticker** in the entity registry (e.g., `AVGO` → `broadcom`)
2. **Gathers all identifiers**: aliases, keywords, sector peers, related entities
3. **Scans all news clusters** for matches against any identifier
4. **Scores confidence** based on match type:
   - Alias match (exact name): 95%
   - Keyword match (topic): 70%
   - Related entity match: 60%

If correlated news is found → **"Market Move Explained"** signal with the news headline.
If no correlation after exhaustive search → **"Silent Divergence"** signal.

#### Example: Broadcom +2.5%

```
1. Ticker AVGO detected with +2.5% move
2. Entity lookup: broadcom
3. Search terms: ["Broadcom", "AVGO", "AI chips", "semiconductors", "VMware", "nvidia", "intel", "amd"]
4. News scan finds: "Broadcom AI Revenue Beats Estimates"
5. Result: "✓ Market Move Explained: Broadcom AI Revenue Beats Estimates"
```

Without this system, the same move would generate a generic "Silent Divergence: AVGO +2.5%" signal.

#### Sector Coverage

The entity registry spans strategically significant sectors:

| Sector | Examples | Keywords Tracked |
|--------|----------|------------------|
| **Technology** | Apple, Microsoft, Nvidia, Google, Meta, TSMC | AI, cloud, chips, datacenter, streaming |
| **Defense & Aerospace** | Lockheed Martin, Raytheon, Northrop Grumman, Boeing, Rheinmetall, Airbus | F-35, missiles, drones, tanks, defense contracts |
| **Semiconductors** | ASML, Samsung, AMD, Intel, Broadcom | Lithography, EUV, foundry, fab, wafer |
| **Critical Minerals** | Albemarle, SQM, MP Materials, Freeport-McMoRan | Lithium, rare earth, cobalt, copper |
| **Finance** | JPMorgan, Berkshire Hathaway, Visa, Mastercard | Banking, credit, investment, interest rates |
| **Healthcare** | Eli Lilly, Novo Nordisk, UnitedHealth, J&J | Pharma, drugs, GLP-1, obesity, diabetes |
| **Energy** | Exxon, Chevron, ConocoPhillips | Oil, gas, drilling, refinery, LNG |
| **Consumer** | Tesla, Walmart, Costco, Home Depot | EV, retail, grocery, housing |

This broad coverage enables correlation detection across diverse geopolitical and market events.

### Entity Registry Architecture

The entity registry is a knowledge base of 600+ entities with rich metadata for intelligent correlation:

```typescript
{
  id: 'NVDA',           // Unique identifier
  name: 'Nvidia',       // Display name
  type: 'company',      // company | country | index | commodity | currency
  sector: 'semiconductors',
  searchTerms: ['Nvidia', 'NVDA', 'Jensen Huang', 'H100', 'CUDA'],
  aliases: ['nvidia', 'nvda'],
  competitors: ['AMD', 'INTC'],
  related: ['AVGO', 'TSM', 'ASML'],  // Related entities
  country: 'US',        // Headquarters/origin
}
```

**Entity Types**:

| Type | Count | Use Case |
|------|-------|----------|
| `company` | 100+ | Market-news correlation, sector analysis |
| `country` | 200+ | Focal point detection, CII scoring |
| `index` | 20+ | Market overview, regional tracking |
| `commodity` | 15+ | Energy and mineral correlation |
| `currency` | 10+ | FX market tracking |

**Lookup Indexes**:

The registry provides multiple lookup paths for fast entity resolution:

| Index | Query Example | Use Case |
|-------|---------------|----------|
| `byId` | `'NVDA'` → Nvidia entity | Direct lookup from ticker |
| `byAlias` | `'nvidia'` → Nvidia entity | Case-insensitive name match |
| `byKeyword` | `'AI chips'` → [Nvidia, AMD, Intel] | News keyword extraction |
| `bySector` | `'semiconductors'` → all chip companies | Sector cascade analysis |
| `byCountry` | `'US'` → all US entities | Country-level aggregation |

### Signal Deduplication

To prevent alert fatigue, signals use **type-specific TTL (time-to-live)** values for deduplication:

| Signal Type | TTL | Rationale |
|-------------|-----|-----------|
| **Silent Divergence** | 6 hours | Market moves persist; don't re-alert on same stock |
| **Flow-Price Divergence** | 6 hours | Energy events unfold slowly |
| **Explained Market Move** | 6 hours | Same correlation shouldn't repeat |
| **Prediction Leading** | 2 hours | Prediction markets update more frequently |
| **Other signals** | 30 minutes | Default for fast-moving events |

Market signals use **symbol-only keys** (e.g., `silent_divergence:AVGO`) rather than including the price change. This means a stock moving +2.5% then +3.0% won't trigger duplicate alerts—the first alert covers the story.

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

### Propaganda Risk Indicators

The dashboard visually flags sources with known state affiliations or propaganda risk, enabling users to appropriately weight information from these outlets.

**Risk Levels**

| Level | Visual | Meaning |
|-------|--------|---------|
| **High** | ⚠ State Media (red) | Direct state control or ownership |
| **Medium** | ! Caution (orange) | Significant state influence or funding |
| **Low** | (none) | Independent editorial control |

**Flagged Sources**

| Source | Risk Level | State Affiliation | Notes |
|--------|------------|-------------------|-------|
| **Xinhua** | High | China (CCP) | Official news agency of PRC |
| **TASS** | High | Russia | State-owned news agency |
| **RT** | High | Russia | Registered foreign agent in US |
| **CGTN** | High | China (CCP) | China Global Television Network |
| **PressTV** | High | Iran | IRIB subsidiary |
| **Al Jazeera** | Medium | Qatar | Qatari government funded |
| **TRT World** | Medium | Turkey | Turkish state broadcaster |

**Display Locations**

Propaganda risk badges appear in:

- **Cluster primary source**: Badge next to the main source name
- **Top sources list**: Small badge next to each flagged source
- **Cluster view**: Visible when expanding multi-source clusters

**Why Include State Media?**

State-controlled outlets are included rather than filtered because:

1. **Signal Value**: What state media reports (and omits) reveals government priorities
2. **Rapid Response**: State media often breaks domestic news faster than international outlets
3. **Narrative Analysis**: Understanding how events are framed by different governments
4. **Completeness**: Excluding them creates blind spots in coverage

The badges ensure users can **contextualize** state media reports rather than unknowingly treating them as independent journalism.

---

## Entity Extraction System

The dashboard extracts **named entities** (companies, countries, leaders, organizations) from news headlines to enable news-to-market correlation and entity-based filtering.

### How It Works

Headlines are scanned against a curated entity index containing:

| Entity Type | Examples | Purpose |
|-------------|----------|---------|
| **Companies** | Apple, Tesla, NVIDIA, Boeing | Market symbol correlation |
| **Countries** | Russia, China, Iran, Ukraine | Geopolitical attribution |
| **Leaders** | Putin, Xi Jinping, Khamenei | Political event tracking |
| **Organizations** | NATO, OPEC, Fed, SEC | Institutional news filtering |
| **Commodities** | Oil, Gold, Bitcoin | Commodity news correlation |

### Entity Matching

Each entity has multiple match patterns for comprehensive detection:

```
Entity: NVIDIA (NVDA)
  Aliases: nvidia, nvda, jensen huang
  Keywords: gpu, h100, a100, cuda, ai chip
  Match Types:
    - Name match: "NVIDIA announces..." → 95% confidence
    - Alias match: "Jensen Huang says..." → 90% confidence
    - Keyword match: "H100 shortage..." → 70% confidence
```

### Confidence Scoring

Entity extraction produces confidence scores based on match quality:

| Match Type | Confidence | Example |
|------------|------------|---------|
| **Direct name** | 95% | "Apple reports earnings" |
| **Alias** | 90% | "Tim Cook announces..." |
| **Keyword** | 70% | "iPhone sales decline" |
| **Related cluster** | 63% | Secondary headline mention (90% × 0.7) |

### Market Correlation

When a market symbol moves significantly, the system searches news clusters for related entities:

1. **Symbol lookup** - Find entity by market symbol (e.g., `AAPL` → Apple)
2. **News search** - Find clusters mentioning the entity or related entities
3. **Confidence ranking** - Sort by extraction confidence
4. **Result** - "Market Move Explained" or "Silent Divergence" signal

This enables signals like:

- **Explained**: "AVGO +5.2% — Broadcom mentioned in 3 news clusters (AI chip demand)"
- **Silent**: "AVGO +5.2% — No correlated news after entity search"

---

## Signal Context ("Why It Matters")

Every signal includes contextual information explaining its analytical significance:

### Context Fields

| Field | Purpose | Example |
|-------|---------|---------|
| **Why It Matters** | Analytical significance | "Markets pricing in information before news" |
| **Actionable Insight** | What to do next | "Monitor for breaking news in 1-6 hours" |
| **Confidence Note** | Signal reliability caveats | "Higher confidence if multiple markets align" |

### Signal-Specific Context

| Signal | Why It Matters |
|--------|---------------|
| **Prediction Leading** | Prediction markets often price in information before it becomes news—traders may have early access to developments |
| **Silent Divergence** | Market moving without identifiable catalyst—possible insider knowledge, algorithmic trading, or unreported development |
| **Velocity Spike** | Story accelerating across multiple sources—indicates growing significance and potential for market/policy impact |
| **Triangulation** | The "authority triangle" (wire + government + intel) aligned—gold standard for breaking news confirmation |
| **Flow-Price Divergence** | Supply disruption not yet reflected in prices—potential information edge or markets have better information |
| **Hotspot Escalation** | Geopolitical hotspot showing escalation across news, instability, convergence, and military presence |

This contextual layer transforms raw alerts into **actionable intelligence** by explaining the analytical reasoning behind each signal.

---

## Algorithms & Design

### News Clustering

Related articles are grouped using **Jaccard similarity** on tokenized headlines:

```
similarity(A, B) = |A ∩ B| / |A ∪ B|
```

**Tokenization**:

- Headlines are lowercased and split on word boundaries
- Stop words removed: "the", "a", "an", "in", "on", "at", "to", "for", "of", "and", "or"
- Short tokens (<3 characters) filtered out
- Result cached per headline for performance

**Inverted Index Optimization**:
Rather than O(n²) pairwise comparison, the algorithm uses an inverted index:

1. Build token → article indices map
2. For each article, find candidate matches via shared tokens
3. Only compute Jaccard for candidates with token overlap
4. This reduces comparisons from ~10,000 to ~500 for typical news loads

**Clustering Rules**:

- Articles with similarity ≥ 0.5 are grouped into clusters
- Clusters are sorted by source tier, then recency
- The most authoritative source becomes the "primary" headline
- Clusters maintain full item list for multi-source attribution

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

### Entity Extraction

News headlines are scanned against the entity knowledge base using **word-boundary regex matching**:

```
regex = /\b{escaped_alias}\b/gi
```

**Index Structure**:
The entity index pre-builds five lookup maps for O(1) access:

| Map | Key | Value | Purpose |
|-----|-----|-------|---------|
| `byId` | Entity ID | Full entity record | Direct lookup |
| `byAlias` | Lowercase alias | Entity ID | Name matching |
| `byKeyword` | Lowercase keyword | Set of entity IDs | Topic matching |
| `bySector` | Sector name | Set of entity IDs | Sector queries |
| `byType` | Entity type | Set of entity IDs | Type filtering |

**Matching Algorithm**:

1. **Alias matching** (highest confidence):
   - Iterate all aliases (minimum 3 characters to avoid false positives)
   - Word-boundary regex prevents partial matches ("AI" won't match "RAID")
   - First alias match for each entity stops further searching (deduplication)

2. **Keyword matching** (medium confidence):
   - Simple substring check (faster than regex)
   - Multiple entities may match same keyword
   - Lower confidence (70%) than alias matches (95%)

3. **Related entity expansion**:
   - If entity has `related` field, those entities are also checked
   - Example: AVGO move also searches for NVDA, INTC, AMD news

**Performance**:

- Index builds once on first access (cached singleton)
- Alias map has ~300 entries for 100+ entities
- Keyword map has ~400 entries
- Full news scan: O(aliases × clusters) ≈ 300 × 50 = 15,000 comparisons

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

### Hotspot Escalation Signals

Beyond visual activity levels, the system generates **escalation signals** when hotspots show significant changes across multiple dimensions. This multi-component approach reduces false positives by requiring corroboration from independent data streams.

**Escalation Components**

Each hotspot's escalation score blends four weighted components:

| Component | Weight | Data Source | What It Measures |
|-----------|--------|-------------|------------------|
| **News Activity** | 35% | RSS feeds | Matching news count, breaking flags, velocity |
| **CII Contribution** | 25% | Country Instability Index | Instability score of associated country |
| **Geographic Convergence** | 25% | Multi-source events | Event type diversity in geographic cell |
| **Military Activity** | 15% | OpenSky/AIS | Flights and vessels within 200km |

**Score Calculation**

```
static_baseline = hotspot.baselineRisk  // 1-5 per hotspot
dynamic_score = (
  news_component × 0.35 +
  cii_component × 0.25 +
  geo_component × 0.25 +
  military_component × 0.15
)
proximity_boost = hotspot_proximity_multiplier  // 1.0-2.0

final_score = (static_baseline × 0.30 + dynamic_score × 0.70) × proximity_boost
```

**Trend Detection**

The system maintains 48-point history (24 hours at 30-minute intervals) per hotspot:

- **Linear regression** calculates slope of recent scores
- **Rising**: Slope > +0.1 points per interval
- **Falling**: Slope < -0.1 points per interval
- **Stable**: Slope within ±0.1

**Signal Generation**

Escalation signals (`hotspot_escalation`) are emitted when:

1. Final score exceeds threshold (typically 60)
2. At least 2 hours since last signal for this hotspot (cooldown)
3. Trend is rising or score is critical (>80)

**Signal Context**

| Field | Content |
|-------|---------|
| **Why It Matters** | "Geopolitical hotspot showing significant escalation based on news activity, country instability, geographic convergence, and military presence" |
| **Actionable Insight** | "Increase monitoring priority; assess downstream impacts on infrastructure, markets, and regional stability" |
| **Confidence Note** | "Weighted by multiple data sources—news (35%), CII (25%), geo-convergence (25%), military (15%)" |

This multi-signal approach means a hotspot escalation signal represents **corroborated evidence** across independent data streams—not just a spike in news mentions.

---

## Regional Focus Navigation

The FOCUS selector in the header provides instant navigation to strategic regions. Each preset is calibrated to center on the region's geographic area with an appropriate zoom level.

### Available Regions

| Region | Coverage | Primary Use Cases |
|--------|----------|-------------------|
| **Global** | Full world view | Overview, cross-regional comparison |
| **Americas** | North America focus | US monitoring, NORAD activity |
| **Europe** | EU + UK + Scandinavia + Western Russia | NATO activity, energy infrastructure |
| **MENA** | Middle East + North Africa | Conflict zones, oil infrastructure |
| **Asia** | East Asia + Southeast Asia | China-Taiwan, Korean peninsula |
| **Latin America** | Central + South America | Regional instability, drug trafficking |
| **Africa** | Sub-Saharan Africa | Conflict zones, resource extraction |
| **Oceania** | Australia + Pacific | Indo-Pacific activity |

### Quick Navigation

The FOCUS dropdown enables rapid context switching:

1. **Breaking news** - Jump to the affected region
2. **Regional briefing** - Cycle through regions for situational awareness
3. **Crisis monitoring** - Lock onto a specific theater

Regional views are encoded in shareable URLs, enabling direct links to specific geographic contexts.

---

## Map Pinning

By default, the map scrolls with the page, allowing you to scroll down to view panels below. The **pin button** (📌) in the map header toggles sticky behavior:

| State | Behavior |
|-------|----------|
| **Unpinned** (default) | Map scrolls with page; scroll down to see panels |
| **Pinned** | Map stays fixed at top; panels scroll beneath |

### When to Pin

- **Active monitoring** - Keep the map visible while reading news panels
- **Cross-referencing** - Compare map markers with panel data
- **Presentation** - Show the map while discussing panel content

### When to Unpin

- **Panel focus** - Read through panels without map taking screen space
- **Mobile** - Pin is disabled on mobile for better space utilization
- **Research** - Focus on data panels without geographic distraction

Pin state persists across sessions via localStorage.

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

### Scoring Bias Prevention

Raw news volume creates a natural bias—English-language media generates far more coverage of the US, UK, and Western Europe than conflict zones. Without correction, stable democracies would consistently score higher than actual crisis regions.

**Log Scaling for High-Volume Countries**

Countries with high media coverage receive logarithmic dampening on their unrest and information scores:

```
if (newsVolume > threshold):
  dampingFactor = 1 / (1 + log10(newsVolume / threshold))
  score = rawScore × dampingFactor
```

This ensures the US receiving 50 news mentions about routine political activity doesn't outscore Ukraine with 10 mentions about active combat.

**Conflict Zone Floor Scores**

Active conflict zones have minimum score floors that prevent them from appearing stable during data gaps or low-coverage periods:

| Country | Floor | Rationale |
|---------|-------|-----------|
| Ukraine | 55 | Active war with Russia |
| Syria | 50 | Ongoing civil war |
| Yemen | 50 | Ongoing civil war |
| Myanmar | 45 | Military coup, civil conflict |
| Israel | 45 | Active Gaza conflict |

The floor applies *after* the standard calculation—if the computed score exceeds the floor, the computed score is used. This prevents false "all clear" signals while preserving sensitivity to actual escalations.

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

### Contextual Score Boosts

Beyond the base component scores, several contextual factors can boost a country's CII score (up to a combined maximum of 23 additional points):

| Boost Type | Max Points | Condition | Purpose |
|------------|------------|-----------|---------|
| **Hotspot Activity** | 10 | Events near defined hotspots | Captures localized escalation |
| **News Urgency** | 5 | Information component ≥50 | High media attention indicator |
| **Focal Point** | 8 | AI focal point detection on country | Multi-source convergence indicator |

**Hotspot Boost Calculation**:

- Hotspot activity (0-100) scaled by 1.5× then capped at 10
- Zero boost for countries with no associated hotspot activity

**News Urgency Boost Tiers**:

- Information ≥70: +5 points
- Information ≥50: +3 points
- Information <50: +0 points

**Focal Point Boost Tiers**:

- Critical urgency: +8 points
- Elevated urgency: +4 points
- Normal urgency: +0 points

These boosts are designed to elevate scores only when corroborating evidence exists—a country must have both high base scores AND contextual signals to reach extreme levels.

### Server-Side Pre-Computation

To eliminate the "cold start" problem where new users would see blank data during the Learning Mode warmup, CII scores are **pre-computed server-side** via the `/api/risk-scores` endpoint. See the [Server-Side Risk Score API](#server-side-risk-score-api) section for details.

### Learning Mode (15-Minute Warmup)

On dashboard startup, the CII system enters **Learning Mode**—a 15-minute calibration period where scores are calculated but alerts are suppressed. This prevents the flood of false-positive alerts that would otherwise occur as the system establishes baseline values.

**Note**: Server-side pre-computation now provides immediate scores to new users—Learning Mode primarily affects client-side dynamic adjustments and alert generation rather than initial score display.

**Why 15 minutes?** Real-world testing showed that CII scores stabilize after approximately 10-20 minutes of data collection. The 15-minute window provides sufficient time for:

- Multiple refresh cycles across all data sources
- Trend detection to establish direction (rising/stable/falling)
- Cross-source correlation to normalize bias

**Visual Indicators**

During Learning Mode, the dashboard provides clear visual feedback:

| Location | Indicator |
|----------|-----------|
| **CII Panel** | Yellow banner with progress bar and countdown timer |
| **Strategic Risk Overview** | "Learning Mode - Xm until reliable" status |
| **Score Display** | Scores shown at 60% opacity (dimmed) |

**Behavior**

```
Minutes 0-15: Learning Mode Active
  - CII scores calculated and displayed (dimmed)
  - Trend detection active (stores baseline)
  - All CII-related alerts suppressed
  - Progress bar fills as time elapses

After 15 minutes: Learning Complete
  - Full opacity scores
  - Alert generation enabled (threshold ≥10 point change)
  - "All data sources active" status shown
```

This ensures users understand that early scores are provisional while preventing alert fatigue during the calibration period.

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

## Undersea Cable Activity Monitoring

The dashboard monitors real-time cable operations and advisories from official maritime warning systems, providing early warning of potential connectivity disruptions.

### Data Sources

| Source | Coverage | Data Type |
|--------|----------|-----------|
| **NGA Warnings** | Global | NAVAREA maritime warnings |
| **Cable Operators** | Route-specific | Maintenance advisories |

### How It Works

The system parses NGA (National Geospatial-Intelligence Agency) maritime warnings for cable-related activity:

1. **Keyword filtering**: Warnings containing "CABLE", "CABLESHIP", "SUBMARINE CABLE", "FIBER OPTIC" are extracted
2. **Coordinate parsing**: DMS and decimal coordinates are extracted from warning text
3. **Cable matching**: Coordinates are matched to nearest cable routes within 5° radius
4. **Severity classification**: Keywords like "FAULT", "BREAK", "DAMAGE" indicate faults; others indicate maintenance

### Alert Types

| Type | Trigger | Map Display |
|------|---------|-------------|
| **Cable Advisory** | Any cable-related NAVAREA warning | ⚠ Yellow marker at location |
| **Repair Ship** | Cableship name detected in warning | 🚢 Ship icon with status |

### Repair Ship Tracking

When a cableship is mentioned in warnings, the system extracts:

- **Vessel name**: CS Reliance, Cable Innovator, etc.
- **Status**: "En route" or "On station"
- **Location**: Current working area
- **Associated cable**: Nearest cable route

This enables monitoring of ongoing repair operations before official carrier announcements.

### Why This Matters

Undersea cables carry 95% of intercontinental data traffic. A cable cut can:

- Cause regional internet outages
- Disrupt financial transactions
- Impact military communications
- Create economic cascading effects

Early visibility into cable operations—even maintenance windows—provides advance warning for contingency planning.

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

### Railway Relay Architecture

Some APIs block requests from cloud providers (Vercel, AWS, Cloudflare Workers). A Railway relay server provides authenticated access:

```
Browser → Railway Relay → External APIs
           (Node.js)      (AIS, OpenSky, RSS)
```

**Relay Functions**:

| Endpoint | Purpose | Authentication |
|----------|---------|----------------|
| `/` (WebSocket) | AIS vessel stream | AISStream API key |
| `/opensky` | Military aircraft | OAuth2 Bearer token |
| `/rss` | Blocked RSS feeds | None (user-agent spoofing) |
| `/health` | Status check | None |

**Environment Variables** (Railway):

- `AISSTREAM_API_KEY` - AIS data access
- `OPENSKY_CLIENT_ID` - OAuth2 client ID
- `OPENSKY_CLIENT_SECRET` - OAuth2 client secret

**Why Railway?**

- Residential IP ranges (not blocked like cloud providers)
- WebSocket support for persistent connections
- Global edge deployment for low latency
- Free tier sufficient for moderate traffic

The relay is stateless—it simply authenticates and proxies requests. All caching and processing happens client-side or in Vercel Edge Functions.

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

**Known Vessel Database**: A curated database of 50+ named vessels enables positive identification when AIS transmits vessel names:

| Category | Tracked Vessels |
|----------|-----------------|
| **US Carriers** | All 11 Nimitz/Ford-class (CVN-68 through CVN-78) |
| **UK Carriers** | HMS Queen Elizabeth (R08), HMS Prince of Wales (R09) |
| **Chinese Carriers** | Liaoning (16), Shandong (17), Fujian (18) |
| **Russian Carrier** | Admiral Kuznetsov |
| **Notable Destroyers** | USS Zumwalt (DDG-1000), HMS Defender (D36), HMS Duncan (D37) |
| **Research/Intel** | USNS Victorious (T-AGOS-19), USNS Impeccable (T-AGOS-23), Yuan Wang |

**Vessel Classification Algorithm**:

1. Check vessel name against known database (hull numbers and ship names)
2. Fall back to AIS ship type code if name match fails
3. Apply MMSI pattern matching for country/operator identification
4. For naval-prefix vessels (USS, HMS, HMCS, HMAS, INS, JS, ROKS, TCG), infer military status

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
- The relay uses **OAuth2 client credentials flow** to obtain Bearer tokens
- Tokens are cached (30-minute expiry) and automatically refreshed

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

### Military Surge Detection

The system continuously monitors military aircraft activity to detect **surge events**—significant increases above normal operational baselines that may indicate mobilization, exercises, or crisis response.

**Theater Classification**

Military activity is analyzed across five geographic theaters:

| Theater | Coverage | Key Areas |
|---------|----------|-----------|
| **Middle East** | Persian Gulf, Levant, Arabian Peninsula | US CENTCOM activity, Iranian airspace |
| **Eastern Europe** | Ukraine, Baltics, Black Sea | NATO-Russia border activity |
| **Western Europe** | Central Europe, North Sea | NATO exercises, air policing |
| **Pacific** | East Asia, Southeast Asia | Taiwan Strait, Korean Peninsula |
| **Horn of Africa** | Red Sea, East Africa | Counter-piracy, Houthi activity |

**Aircraft Classification**

Aircraft are categorized by callsign pattern matching:

| Type | Callsign Patterns | Significance |
|------|-------------------|--------------|
| **Transport** | RCH, REACH, MOOSE, HERKY, EVAC, DUSTOFF | Airlift operations, troop movement |
| **Fighter** | VIPER, EAGLE, RAPTOR, STRIKE | Combat air patrol, interception |
| **Reconnaissance** | SIGNT, COBRA, RIVET, JSTARS | Intelligence gathering |

**Baseline Calculation**

The system maintains rolling 48-hour activity baselines per theater:

- Minimum 6 data samples required for reliable baseline
- Default baselines when data insufficient: 3 transport, 2 fighter, 1 reconnaissance
- Activity below 50% of baseline indicates stand-down

**Surge Detection Algorithm**

```
surge_ratio = current_count / baseline
surge_triggered = (
  ratio ≥ 2.0 AND
  transport ≥ 5 AND
  fighters ≥ 4
)
```

**Surge Signal Output**

When a surge is detected, the system generates a `military_surge` signal:

| Field | Content |
|-------|---------|
| **Location** | Theater centroid coordinates |
| **Message** | "Military Transport Surge in [Theater]: [X] aircraft (baseline: [Y])" |
| **Details** | Aircraft types, nearby bases (150km radius), top callsigns |
| **Confidence** | Based on surge ratio (0.6–0.9) |

### Foreign Military Presence Detection

Beyond surge detection, the system monitors for **foreign military aircraft in sensitive regions**—situations where aircraft from one nation appear in geopolitically significant areas outside their normal operating range.

**Sensitive Regions**

The system tracks 18 strategically significant geographic areas:

| Region | Sensitivity | Monitored For |
|--------|-------------|---------------|
| **Taiwan Strait** | Critical | PLAAF activity, US transits |
| **Persian Gulf** | Critical | Iranian, US, Gulf state activity |
| **Baltic Sea** | High | Russian activity near NATO |
| **Black Sea** | High | NATO reconnaissance, Russian activity |
| **South China Sea** | High | PLAAF patrols, US FONOPs |
| **Korean Peninsula** | High | DPRK activity, US-ROK exercises |
| **Eastern Mediterranean** | Medium | Russian naval aviation, NATO |
| **Arctic** | Medium | Russian bomber patrols |

**Detection Logic**

For each sensitive region, the system:

1. Identifies all military aircraft within the region boundary
2. Groups aircraft by operating nation
3. Excludes "home region" operators (e.g., Russian VKS in Baltic excluded from alert)
4. Applies concentration thresholds (typically 2-3 aircraft per operator)

**Critical Combinations**

Certain operator-region combinations trigger **critical severity** alerts:

| Operator | Region | Rationale |
|----------|--------|-----------|
| PLAAF | Taiwan Strait | Potential invasion rehearsal |
| Russian VKS | Arctic | Nuclear bomber patrols |
| USAF | Persian Gulf | Potential strike package |

**Signal Output**

Foreign presence detection generates a `foreign_military_presence` signal:

| Field | Content |
|-------|---------|
| **Title** | "Foreign Military Presence: [Region]" |
| **Details** | "[Operator] aircraft detected: [count] [types]" |
| **Severity** | Critical/High/Medium based on combination |
| **Confidence** | 0.7–0.95 based on aircraft count and type diversity |

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

## Space Launch Infrastructure

The Spaceports layer displays global launch facilities for monitoring space-related activity and supply chain implications.

### Tracked Launch Sites

| Site | Country | Operator | Activity Level |
|------|---------|----------|----------------|
| **Kennedy Space Center** | USA | NASA/Space Force | High |
| **Vandenberg SFB** | USA | US Space Force | Medium |
| **Starbase** | USA | SpaceX | High |
| **Baikonur Cosmodrome** | Kazakhstan | Roscosmos | Medium |
| **Plesetsk Cosmodrome** | Russia | Roscosmos/Military | Medium |
| **Vostochny Cosmodrome** | Russia | Roscosmos | Low |
| **Jiuquan SLC** | China | CNSA | High |
| **Xichang SLC** | China | CNSA | High |
| **Wenchang SLC** | China | CNSA | Medium |
| **Guiana Space Centre** | France | ESA/CNES | Medium |
| **Satish Dhawan SC** | India | ISRO | Medium |
| **Tanegashima SC** | Japan | JAXA | Low |

### Why This Matters

Space launches are geopolitically significant:

- **Military implications**: Many launches are dual-use (civilian/military)
- **Technology competition**: Launch cadence indicates space program advancement
- **Supply chain**: Satellite services affect communications, GPS, reconnaissance
- **Incident correlation**: News about space debris, failed launches, or policy changes

---

## Critical Mineral Deposits

The Minerals layer displays strategic mineral extraction sites essential for modern technology and defense supply chains.

### Tracked Resources

| Mineral | Strategic Importance | Major Producers |
|---------|---------------------|-----------------|
| **Lithium** | EV batteries, energy storage | Australia, Chile, China |
| **Cobalt** | Battery cathodes, superalloys | DRC (60%+ global), Australia |
| **Rare Earths** | Magnets, electronics, defense | China (60%+ global), Australia, USA |

### Key Sites

| Site | Mineral | Country | Significance |
|------|---------|---------|--------------|
| Greenbushes | Lithium | Australia | World's largest hard-rock lithium mine |
| Salar de Atacama | Lithium | Chile | Largest brine lithium source |
| Mutanda | Cobalt | DRC | World's largest cobalt mine |
| Tenke Fungurume | Cobalt | DRC | Major Chinese-owned cobalt source |
| Bayan Obo | Rare Earths | China | 45% of global REE production |
| Mountain Pass | Rare Earths | USA | Only active US rare earth mine |

### Supply Chain Risks

Critical minerals are geopolitically concentrated:

- **Cobalt**: 70% from DRC, significant artisanal mining concerns
- **Rare Earths**: 60% from China, processing nearly monopolized
- **Lithium**: Expanding production but demand outpacing supply

News about these regions or mining companies can signal supply disruptions affecting technology and defense sectors.

---

## Cyber Threat Actors (APT Groups)

The map displays geographic attribution markers for major state-sponsored Advanced Persistent Threat (APT) groups. These markers show the approximate operational centers of known threat actors.

### Tracked Groups

| Group | Aliases | Sponsor | Notable Activity |
|-------|---------|---------|-----------------|
| **APT28/29** | Fancy Bear, Cozy Bear | Russia (GRU/FSB) | Election interference, government espionage |
| **APT41** | Double Dragon | China (MSS) | Supply chain attacks, intellectual property theft |
| **Lazarus** | Hidden Cobra | North Korea (RGB) | Financial theft, cryptocurrency heists |
| **APT33/35** | Elfin, Charming Kitten | Iran (IRGC) | Critical infrastructure, aerospace targeting |

### Why This Matters

Cyber operations often correlate with geopolitical tensions. When news reports reference Russian cyber activity during a Ukraine escalation, or Iranian hacking during Middle East tensions, these markers provide geographic context for the threat landscape.

### Visual Indicators

APT markers appear as warning triangles (⚠) with distinct styling. Clicking a marker shows:

- **Official designation** and common aliases
- **State sponsor** and intelligence agency
- **Primary targeting sectors**

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

### Map Display Filtering

To reduce visual clutter and focus attention on significant events, the map displays only **high-severity protests and riots**:

| Displayed | Event Type | Visual |
|-----------|------------|--------|
| ✅ Yes | Riot | Bright red marker |
| ✅ Yes | High-severity protest | Red marker |
| ❌ No | Medium/low-severity protest | Not shown on map |

Lower-severity events are still tracked for CII scoring and data exports—they simply don't create map markers. This filtering prevents dense urban areas (which naturally generate more low-severity demonstrations) from overwhelming the map display.

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

## System Health Monitoring

The status panel (accessed via the health indicator in the header) provides real-time visibility into data source status and system health.

### Health Indicator

The header displays a system health badge:

| State | Visual | Meaning |
|-------|--------|---------|
| **Healthy** | Green dot | All data sources operational |
| **Degraded** | Yellow dot | Some sources in cooldown |
| **Unhealthy** | Red dot | Multiple sources failing |

Click the indicator to expand the full status panel.

### Data Source Status

The status panel lists all data feeds with their current state:

| Status | Icon | Description |
|--------|------|-------------|
| **Active** | ● Green | Fetching data normally |
| **Cooldown** | ● Yellow | Temporarily paused (circuit breaker) |
| **Disabled** | ○ Gray | Layer not enabled |
| **Error** | ● Red | Persistent failure |

### Per-Feed Information

Each feed entry shows:

- **Source name** - The data provider
- **Last update** - Time since last successful fetch
- **Next refresh** - Countdown to next scheduled fetch
- **Cooldown remaining** - Time until circuit breaker resets (if in cooldown)

### Why This Matters

External APIs are unreliable. The status panel helps you understand:

- **Data freshness** - Is the news feed current or stale?
- **Coverage gaps** - Which sources are currently unavailable?
- **Recovery timeline** - When will failed sources retry?

This transparency enables informed interpretation of the dashboard data.

---

## Data Freshness Tracking

Beyond simple "online/offline" status, the system tracks fine-grained freshness for each data source to indicate data reliability and staleness.

### Freshness Levels

| Status | Color | Criteria | Meaning |
|--------|-------|----------|---------|
| **Fresh** | Green | Updated within expected interval | Data is current |
| **Aging** | Yellow | 1-2× expected interval elapsed | Data may be slightly stale |
| **Stale** | Orange | 2-4× expected interval elapsed | Data is outdated |
| **Critical** | Red | >4× expected interval elapsed | Data unreliable |
| **Disabled** | Gray | Layer toggled off | Not fetching |

### Source-Specific Thresholds

Each data source has calibrated freshness expectations:

| Source | Expected Interval | "Fresh" Threshold |
|--------|------------------|-------------------|
| News feeds | 5 minutes | <10 minutes |
| Stock quotes | 1 minute | <5 minutes |
| Earthquakes | 5 minutes | <15 minutes |
| Weather | 10 minutes | <30 minutes |
| Flight delays | 10 minutes | <20 minutes |
| AIS vessels | Real-time | <1 minute |

### Visual Indicators

The status panel displays freshness for each source:

- **Colored dot** indicates freshness level
- **Time since update** shows exact staleness
- **Next refresh countdown** shows when data will update

### Why This Matters

Understanding data freshness is critical for decision-making:

- A "fresh" earthquake feed means recent events are displayed
- A "stale" news feed means you may be missing breaking stories
- A "critical" AIS stream means vessel positions are unreliable

This visibility enables appropriate confidence calibration when interpreting the dashboard.

### Core vs. Optional Sources

Data sources are classified by their importance to risk assessment:

| Classification | Sources | Impact |
|----------------|---------|--------|
| **Core** | GDELT, RSS feeds | Required for meaningful risk scores |
| **Optional** | ACLED, Military, AIS, Weather, Economic | Enhance but not required |

The Strategic Risk Overview panel adapts its display based on core source availability:

| Status | Display Mode | Behavior |
|--------|--------------|----------|
| **Sufficient** | Full data view | All metrics shown with confidence |
| **Limited** | Limited data view | Shows "Limited Data" warning banner |
| **Insufficient** | Insufficient data view | "Insufficient Data" message, no risk score |

### Freshness-Aware Risk Assessment

The composite risk score is adjusted based on data freshness:

```
If core sources fresh:
  → Full confidence in risk score
  → "All data sources active" indicator

If core sources stale:
  → Display warning: "Limited Data - [active sources]"
  → Score shown but flagged as potentially unreliable

If core sources unavailable:
  → "Insufficient data for risk assessment"
  → No score displayed
```

This prevents false "all clear" signals when the system actually lacks data to make that determination.

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

The dashboard is optimized for mobile devices with a streamlined interface that prioritizes usability on smaller screens.

### First-Time Mobile Welcome

When accessing the dashboard on a mobile device for the first time, a welcome modal explains the mobile-optimized experience:

- **Simplified view notice** - Informs users they're seeing a curated mobile version
- **Navigation tip** - Explains regional view buttons and marker interaction
- **"Don't show again" option** - Checkbox to skip on future visits (persisted to localStorage)

### Mobile-First Design

On screens narrower than 768px or touch devices:

- **Compact map** - Reduced height (40vh) to show more panels
- **Single-column layout** - Panels stack vertically for easy scrolling
- **Hidden map labels** - All marker labels are hidden to reduce visual clutter
- **Fixed layer set** - Layer toggle buttons are hidden; a curated set of layers is enabled by default
- **Simplified controls** - Map resize handle and pin button are hidden
- **Touch-optimized markers** - Expanded touch targets (44px) for easy tapping
- **Hidden DEFCON indicator** - Pentagon Pizza Index hidden to reduce header clutter
- **Hidden FOCUS selector** - Regional focus buttons hidden (use preset views instead)
- **Compact header** - Social link shows X logo instead of username text

### Mobile Default Layers

The mobile experience focuses on the most essential intelligence layers:

| Layer | Purpose |
|-------|---------|
| **Conflicts** | Active conflict zones |
| **Hotspots** | Intelligence hotspots with activity levels |
| **Sanctions** | Countries under economic sanctions |
| **Outages** | Network disruptions |
| **Natural** | Earthquakes, storms, wildfires |
| **Weather** | Severe weather warnings |

Layers disabled by default on mobile (but available on desktop):

- Military bases, nuclear facilities, spaceports, minerals
- Undersea cables, pipelines, datacenters
- AIS vessels, military flights
- Protests, economic centers

This curated set provides situational awareness without overwhelming the interface or consuming excessive data/battery.

### Touch Gestures

Map navigation supports:

- **Pinch zoom** - Two-finger zoom in/out
- **Drag pan** - Single-finger map movement
- **Tap markers** - Show popup (replaces hover)
- **Double-tap** - Quick zoom

### Performance Considerations

Mobile optimizations reduce resource consumption:

| Optimization | Benefit |
|--------------|---------|
| Fewer layers | Reduced API calls, lower battery usage |
| No labels | Faster rendering, cleaner interface |
| Hidden controls | More screen space for content |
| Simplified header | Reduced visual processing |

### Desktop Experience

On larger screens, the full feature set is available:

- Multi-column responsive panel grid
- All layer toggles accessible
- Map labels visible at appropriate zoom levels
- Resizable map section
- Pinnable map (keeps map visible while scrolling panels)
- Full DEFCON indicator with tension pairs
- FOCUS regional selector for rapid navigation

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

## Signal Aggregator

The Signal Aggregator is the central nervous system that collects, groups, and summarizes intelligence signals from all data sources.

### What It Aggregates

| Signal Type | Source | Frequency |
|-------------|--------|-----------|
| `military_flight` | OpenSky ADS-B | Real-time |
| `military_vessel` | AIS WebSocket | Real-time |
| `protest` | ACLED + GDELT | Hourly |
| `internet_outage` | Cloudflare Radar | 5 min |
| `ais_disruption` | AIS analysis | Real-time |

### Country-Level Grouping

All signals are grouped by country code, creating a unified view:

```typescript
{
  country: 'UA',  // Ukraine
  countryName: 'Ukraine',
  totalCount: 15,
  highSeverityCount: 3,
  signalTypes: Set(['military_flight', 'protest', 'internet_outage']),
  signals: [/* all signals for this country */]
}
```

### Regional Convergence Detection

The aggregator identifies geographic convergence—when multiple signal types cluster in the same region:

| Convergence Level | Criteria | Alert Priority |
|-------------------|----------|----------------|
| **Critical** | 4+ signal types within 200km | Immediate |
| **High** | 3 signal types within 200km | High |
| **Medium** | 2 signal types within 200km | Normal |

### Summary Output

The aggregator provides a real-time summary for dashboards and AI context:

```
[SIGNAL SUMMARY]
Top Countries: Ukraine (15 signals), Iran (12), Taiwan (8)
Convergence Zones: Baltic Sea (military_flight + military_vessel),
                   Tehran (protest + internet_outage)
Active Signal Types: 5 of 5
Total Signals: 47
```

---

## Browser-Based Machine Learning

For offline resilience and reduced API costs, the system includes browser-based ML capabilities using ONNX Runtime Web.

### Available Models

| Model | Task | Size | Use Case |
|-------|------|------|----------|
| **T5-small** | Text summarization | ~60MB | Offline briefing generation |
| **DistilBERT** | Sentiment analysis | ~67MB | News tone classification |

### Fallback Strategy

Browser ML serves as the final fallback when cloud APIs are unavailable:

```
User requests summary
    ↓
1. Try Groq API (fast, free tier)
    ↓ (rate limited or error)
2. Try OpenRouter API (fallback provider)
    ↓ (unavailable)
3. Use Browser T5 (offline, always available)
```

### Lazy Loading

Models are loaded on-demand to minimize initial page load:

- Models download only when first needed
- Progress indicator shows download status
- Once cached, models load instantly from IndexedDB

### Worker Isolation

All ML inference runs in a dedicated Web Worker:

- Main thread remains responsive during inference
- 30-second timeout prevents hanging
- Automatic cleanup on errors

### Limitations

Browser ML has constraints compared to cloud models:

| Aspect | Cloud (Llama 3.3) | Browser (T5) |
|--------|-------------------|--------------|
| Context window | 128K tokens | 512 tokens |
| Output quality | High | Moderate |
| Inference speed | 2-3 seconds | 5-10 seconds |
| Offline support | No | Yes |

Browser summarization is intentionally limited to 6 headlines × 80 characters to stay within model constraints.

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

## AI Insights Panel

The Insights Panel provides AI-powered analysis of the current news landscape, transforming raw headlines into actionable intelligence briefings.

### World Brief Generation

Every 2 minutes (with rate limiting), the system generates a concise situation brief using a multi-provider fallback chain:

| Priority | Provider | Model | Latency | Use Case |
|----------|----------|-------|---------|----------|
| 1 | Groq | Llama 3.3 70B | ~2s | Primary provider (fast inference) |
| 2 | OpenRouter | Llama 3.3 70B | ~3s | Fallback when Groq rate-limited |
| 3 | Browser | T5 (ONNX) | ~5s | Offline fallback (local ML) |

**Caching Strategy**: Redis server-side caching prevents redundant API calls. When the same headline set has been summarized recently, the cached result is returned immediately.

### Focal Point Detection

The AI receives enriched context about **focal points**—entities that appear in both news coverage AND map signals. This enables intelligence-grade analysis:

```
[INTELLIGENCE SYNTHESIS]
FOCAL POINTS (entities across news + signals):
- IRAN [CRITICAL]: 12 news mentions + 5 map signals (military_flight, protest, internet_outage)
  KEY: "Iran protests continue..." | SIGNALS: military activity, outage detected
- TAIWAN [ELEVATED]: 8 news mentions + 3 map signals (military_vessel, military_flight)
  KEY: "Taiwan tensions rise..." | SIGNALS: naval vessels detected
```

### Headline Scoring Algorithm

Not all news is equally important. Headlines are scored to identify the most significant stories for the briefing:

**Score Boosters** (high weight):

- Military keywords: war, invasion, airstrike, missile, deployment, mobilization
- Violence indicators: killed, casualties, clashes, massacre, crackdown
- Civil unrest: protest, uprising, coup, riot, martial law

**Geopolitical Multipliers**:

- Flashpoint regions: Iran, Russia, China, Taiwan, Ukraine, North Korea, Gaza
- Critical actors: NATO, Pentagon, Kremlin, Hezbollah, Hamas, Wagner

**Score Reducers** (demoted):

- Business context: CEO, earnings, stock, revenue, startup, data center
- Entertainment: celebrity, movie, streaming

This ensures military conflicts and humanitarian crises surface above routine business news.

### Sentiment Analysis

Headlines are analyzed for overall sentiment distribution:

| Sentiment | Detection Method | Display |
|-----------|------------------|---------|
| **Negative** | Crisis, conflict, death keywords | Red percentage |
| **Positive** | Agreement, growth, peace keywords | Green percentage |
| **Neutral** | Neither detected | Gray percentage |

The overall sentiment balance provides a quick read on whether the news cycle is trending toward escalation or de-escalation.

### Velocity Detection

Fast-moving stories are flagged when the same topic appears in multiple recent headlines:

- Headlines are grouped by shared keywords and entities
- Topics with 3+ mentions in 6 hours are marked as "high velocity"
- Displayed separately to highlight developing situations

---

## Focal Point Detector

The Focal Point Detector is the intelligence synthesis layer that correlates news entities with map signals to identify "main characters" driving current events.

### The Problem It Solves

Without synthesis, intelligence streams operate in silos:

- News feeds show 80+ sources with thousands of headlines
- Map layers display military flights, protests, outages independently
- No automated way to see that IRAN appears in news AND has military activity AND an internet outage

### How It Works

1. **Entity Extraction**: Extract countries, companies, and organizations from all news clusters using the entity registry (600+ entities with aliases)

2. **Signal Aggregation**: Collect all map signals (military flights, protests, outages, vessels) and group by country

3. **Cross-Reference**: Match news entities with signal countries

4. **Score & Rank**: Calculate focal scores based on correlation strength

### Focal Point Scoring

```
FocalScore = NewsScore + SignalScore + CorrelationBonus

NewsScore (0-40):
  base = min(20, mentionCount × 4)
  velocity = min(10, newsVelocity × 2)
  confidence = avgConfidence × 10

SignalScore (0-40):
  types = signalTypes.count × 10
  count = min(15, signalCount × 3)
  severity = highSeverityCount × 5

CorrelationBonus (0-20):
  +10 if entity appears in BOTH news AND signals
  +5 if news keywords match signal types (e.g., "military" + military_flight)
  +5 if related entities also have signals
```

### Urgency Classification

| Urgency | Criteria | Visual |
|---------|----------|--------|
| **Critical** | Score > 70 OR 3+ signal types | Red badge |
| **Elevated** | Score > 50 OR 2+ signal types | Orange badge |
| **Watch** | Default | Yellow badge |

### Signal Type Icons

Focal points display icons indicating which signal types are active:

| Icon | Signal Type | Meaning |
|------|-------------|---------|
| ✈️ | military_flight | Military aircraft detected nearby |
| ⚓ | military_vessel | Naval vessels in waters |
| 📢 | protest | Civil unrest events |
| 🌐 | internet_outage | Network disruption |
| 🚢 | ais_disruption | Shipping anomaly |

### Example Output

A focal point for IRAN might show:

- **Display**: "Iran [CRITICAL] ✈️📢🌐"
- **News**: 12 mentions, velocity 0.5/hour
- **Signals**: 5 military flights, 3 protests, 1 outage
- **Narrative**: "12 news mentions | 5 military flights, 3 protests, 1 internet outage | 'Iran protests continue amid...'"
- **Correlation Evidence**: "Iran appears in both news (12) and map signals (9)"

### Integration with CII

Focal point urgency levels feed into the Country Instability Index:

- **Critical** focal point → CII score boost for that country
- Ensures countries with multi-source convergence are properly flagged
- Prevents "silent" instability when news alone wouldn't trigger alerts

---

## Natural Disaster Tracking

The Natural layer combines two authoritative sources for comprehensive disaster monitoring.

### GDACS (Global Disaster Alert and Coordination System)

UN-backed disaster alert system providing official severity assessments:

| Event Type | Code | Icon | Sources |
|------------|------|------|---------|
| Earthquake | EQ | 🔴 | USGS, EMSC |
| Flood | FL | 🌊 | Satellite imagery |
| Tropical Cyclone | TC | 🌀 | NOAA, JMA |
| Volcano | VO | 🌋 | Smithsonian GVP |
| Wildfire | WF | 🔥 | MODIS, VIIRS |
| Drought | DR | ☀️ | Multiple sources |

**Alert Levels**:
| Level | Color | Meaning |
|-------|-------|---------|
| **Red** | Critical | Significant humanitarian impact expected |
| **Orange** | Alert | Moderate impact, monitoring required |
| **Green** | Advisory | Minor event, localized impact |

### NASA EONET (Earth Observatory Natural Event Tracker)

Near-real-time natural event detection from satellite observation:

| Category | Detection Method | Typical Delay |
|----------|------------------|---------------|
| Severe Storms | GOES/Himawari imagery | Minutes |
| Wildfires | MODIS thermal anomalies | 4-6 hours |
| Volcanoes | Thermal + SO2 emissions | Hours |
| Floods | SAR imagery + gauges | Hours to days |
| Sea/Lake Ice | Passive microwave | Daily |
| Dust/Haze | Aerosol optical depth | Hours |

### Multi-Source Deduplication

When both GDACS and EONET report the same event:

1. Events within 100km and 48 hours are considered duplicates
2. GDACS severity takes precedence (human-verified)
3. EONET geometry provides more precise coordinates
4. Combined entry shows both source attributions

### Filtering Logic

To prevent map clutter, natural events are filtered:

- **Wildfires**: Only events < 48 hours old (older fires are either contained or well-known)
- **Earthquakes**: M4.5+ globally, lower threshold for populated areas
- **Storms**: Only named storms or those with warnings

---

## Military Surge Detection

The system detects unusual concentrations of military activity using two complementary algorithms.

### Baseline-Based Surge Detection

Surges are detected by comparing current aircraft counts to historical baselines within defined military theaters:

| Parameter | Value | Purpose |
|-----------|-------|---------|
| Surge threshold | 2.0× baseline | Minimum multiplier to trigger alert |
| Baseline window | 48 hours | Historical data used for comparison |
| Minimum samples | 6 observations | Required data points for valid baseline |

**Aircraft Categories Tracked**:

| Category | Examples | Minimum Count |
|----------|----------|---------------|
| Transport/Airlift | C-17, C-130, KC-135, REACH flights | 5 aircraft |
| Fighter | F-15, F-16, F-22, Typhoon | 4 aircraft |
| Reconnaissance | RC-135, E-3 AWACS, U-2 | 3 aircraft |

### Surge Severity

| Severity | Criteria | Meaning |
|----------|----------|---------|
| **Critical** | 4× baseline or higher | Major deployment |
| **High** | 3× baseline | Significant increase |
| **Medium** | 2× baseline | Elevated activity |

### Military Theaters

Surge detection groups activity into strategic theaters:

| Theater | Center | Key Bases |
|---------|--------|-----------|
| Middle East | Persian Gulf | Al Udeid, Al Dhafra, Incirlik |
| Eastern Europe | Poland | Ramstein, Spangdahlem, Łask |
| Pacific | Guam/Japan | Andersen, Kadena, Yokota |
| Horn of Africa | Djibouti | Camp Lemonnier |

### Foreign Presence Detection

A separate system monitors for military operators outside their normal operating areas:

| Operator | Home Regions | Alert When Found In |
|----------|--------------|---------------------|
| USAF/USN | Alaska ADIZ | Persian Gulf, Taiwan Strait |
| Russian VKS | Kaliningrad, Arctic, Black Sea | Baltic Region, Alaska ADIZ |
| PLAAF/PLAN | Taiwan Strait, South China Sea | (alerts when increased) |
| Israeli IAF | Eastern Med | Iran border region |

**Example alert**:
```
FOREIGN MILITARY PRESENCE: Persian Gulf
USAF: 3 aircraft detected (KC-135, RC-135W, E-3)
Severity: HIGH - Operator outside normal home regions
```

### News Correlation

Both surge and foreign presence alerts query the Focal Point Detector for context:

1. Identify countries involved (aircraft operators, region countries)
2. Check focal points for those countries
3. If news correlation exists, attach headlines and evidence

**Example with correlation**:
```
MILITARY AIRLIFT SURGE: Middle East Theater
Current: 8 transport aircraft (2.5× baseline)
Aircraft: C-17 (3), KC-135 (3), C-130J (2)

NEWS CORRELATION:
Iran: "Iran protests continue amid military..."
→ Iran appears in both news (12) and map signals (9)
```

---

## Strategic Posture Analysis

The AI Strategic Posture panel aggregates military aircraft and naval vessels across defined theaters, providing at-a-glance situational awareness of global force concentrations.

### Strategic Theaters

Nine geographic theaters are monitored continuously, each with custom thresholds based on typical peacetime activity levels:

| Theater | Bounds | Elevated Threshold | Critical Threshold |
|---------|--------|--------------------|--------------------|
| **Iran Theater** | Persian Gulf, Iraq, Syria (20°N–42°N, 30°E–65°E) | 50 aircraft | 100 aircraft |
| **Taiwan Strait** | Taiwan, East China Sea (18°N–30°N, 115°E–130°E) | 30 aircraft | 60 aircraft |
| **Korean Peninsula** | North/South Korea (33°N–43°N, 124°E–132°E) | 20 aircraft | 50 aircraft |
| **Baltic Theater** | Baltics, Poland, Scandinavia (52°N–65°N, 10°E–32°E) | 20 aircraft | 40 aircraft |
| **Black Sea** | Ukraine, Turkey, Romania (40°N–48°N, 26°E–42°E) | 15 aircraft | 30 aircraft |
| **South China Sea** | Philippines, Vietnam (5°N–25°N, 105°E–121°E) | 25 aircraft | 50 aircraft |
| **Eastern Mediterranean** | Syria, Cyprus, Lebanon (33°N–37°N, 25°E–37°E) | 15 aircraft | 30 aircraft |
| **Israel/Gaza** | Israel, Gaza Strip (29°N–33°N, 33°E–36°E) | 10 aircraft | 25 aircraft |
| **Yemen/Red Sea** | Bab el-Mandeb, Houthi areas (11°N–22°N, 32°E–54°E) | 15 aircraft | 30 aircraft |

### Strike Capability Assessment

Beyond raw counts, the system assesses whether forces in a theater constitute an **offensive strike package**—the combination of assets required for sustained combat operations.

**Strike-Capable Criteria**:

- Aerial refueling tankers (KC-135, KC-10, A330 MRTT)
- Airborne command and control (E-3 AWACS, E-7 Wedgetail)
- Combat aircraft (fighters, strike aircraft)

Each theater has custom thresholds reflecting realistic strike package sizes:

| Theater | Min Tankers | Min AWACS | Min Fighters |
|---------|-------------|-----------|--------------|
| Iran Theater | 10 | 2 | 30 |
| Taiwan Strait | 5 | 1 | 20 |
| Korean Peninsula | 4 | 1 | 15 |
| Baltic/Black Sea | 3-4 | 1 | 10-15 |
| Israel/Gaza | 2 | 1 | 8 |

When all three criteria are met, the theater is flagged as **STRIKE CAPABLE**, indicating forces sufficient for sustained offensive operations.

### Naval Vessel Integration

The panel augments aircraft data with real-time naval vessel positions from AIS tracking. Vessels are classified into categories:

| Category | Examples | Strategic Significance |
|----------|----------|------------------------|
| **Carriers** | CVN, CV, LHD | Power projection, air superiority |
| **Destroyers** | DDG, DDH | Air defense, cruise missile strike |
| **Frigates** | FFG, FF | Multi-role escort, ASW |
| **Submarines** | SSN, SSK, SSBN | Deterrence, ISR, strike |
| **Patrol** | PC, PG | Coastal defense |
| **Auxiliary** | T-AO, AOR | Fleet support, logistics |

**Data Accumulation Note**: AIS vessel data arrives via WebSocket stream and accumulates gradually. The panel automatically re-checks vessel counts at 30, 60, 90, and 120 seconds after initial load to capture late-arriving data.

### Posture Levels

| Level | Indicator | Criteria | Meaning |
|-------|-----------|----------|---------|
| **Normal** | 🟢 NORM | Below elevated threshold | Routine peacetime activity |
| **Elevated** | 🟡 ELEV | At or above elevated threshold | Increased activity, possible exercises |
| **Critical** | 🔴 CRIT | At or above critical threshold | Major deployment, potential crisis |

**Elevated + Strike Capable** is treated as a higher alert state than regular elevated status.

### Trend Detection

Activity trends are computed from rolling historical data:

- **Increasing** (↗): Current activity >10% higher than previous period
- **Stable** (→): Activity within ±10% of previous period
- **Decreasing** (↘): Current activity >10% lower than previous period

### Server-Side Caching

Theater posture computations run on edge servers with Redis caching:

| Cache Type | TTL | Purpose |
|------------|-----|---------|
| **Active cache** | 5 minutes | Matches OpenSky refresh rate |
| **Stale cache** | 1 hour | Fallback when upstream APIs fail |

This ensures consistent data across all users and minimizes redundant API calls to OpenSky Network.

---

## Server-Side Risk Score API

Strategic risk and Country Instability Index (CII) scores are pre-computed server-side rather than calculated in the browser. This eliminates the "cold start" problem where new users would see no data while the system accumulated enough information to generate scores.

### How It Works

The `/api/risk-scores` edge function:

1. Fetches recent protest/riot data from ACLED (7-day window)
2. Computes CII scores for 20 Tier 1 countries
3. Derives strategic risk from weighted top-5 CII scores
4. Caches results in Redis (10-minute TTL)

### CII Score Calculation

Each country's score combines:

**Baseline Risk** (0–50 points): Static geopolitical risk based on historical instability, ongoing conflicts, and authoritarian governance.

| Country | Baseline | Rationale |
|---------|----------|-----------|
| Syria, Ukraine, Yemen | 50 | Active conflict zones |
| Myanmar, Venezuela, North Korea | 40-45 | Civil unrest, authoritarian |
| Iran, Israel, Pakistan | 35-45 | Regional tensions |
| Saudi Arabia, Turkey, India | 20-25 | Moderate instability |
| Germany, UK, US | 5-10 | Stable democracies |

**Unrest Component** (0–50 points): Recent protest and riot activity, weighted by event significance multiplier.

**Information Component** (0–25 points): News coverage intensity (proxy for international attention).

**Security Component** (0–25 points): Baseline plus riot contribution.

### Event Significance Multipliers

Events in some countries carry more global significance than others:

| Multiplier | Countries | Rationale |
|------------|-----------|-----------|
| 3.0× | North Korea | Any visible unrest is highly unusual |
| 2.0-2.5× | China, Russia, Iran, Saudi Arabia | Authoritarian states suppress protests |
| 1.5-1.8× | Taiwan, Pakistan, Myanmar, Venezuela | Regional flashpoints |
| 0.5-0.8× | US, UK, France, Germany | Protests are routine in democracies |

### Strategic Risk Derivation

The composite strategic risk score is computed as a weighted average of the top 5 CII scores:

```
Weights: [1.0, 0.85, 0.70, 0.55, 0.40] (total: 3.5)
Strategic Risk = (Σ CII[i] × weight[i]) / 3.5 × 0.7 + 15
```

The top countries contribute most heavily, with diminishing influence for lower-ranked countries.

### Fallback Behavior

When ACLED data is unavailable (API errors, rate limits, expired auth):

1. **Stale cache** (1-hour TTL): Return recent scores with `stale: true` flag
2. **Baseline fallback**: Return scores using only static baseline values with `baseline: true` flag

This ensures the dashboard always displays meaningful data even during upstream outages.

---

## Service Status Monitoring

The Service Status panel tracks the operational health of external services that WorldMonitor users may depend on.

### Monitored Services

| Service | Status Endpoint | Parser |
|---------|-----------------|--------|
| Anthropic (Claude) | status.claude.com | Statuspage.io |
| OpenAI | status.openai.com | Statuspage.io |
| Vercel | vercel-status.com | Statuspage.io |
| Cloudflare | cloudflarestatus.com | Statuspage.io |
| AWS | health.aws.amazon.com | Custom |
| GitHub | githubstatus.com | Statuspage.io |

### Status Levels

| Status | Color | Meaning |
|--------|-------|---------|
| **Operational** | Green | All systems functioning normally |
| **Degraded** | Yellow | Partial outage or performance issues |
| **Partial Outage** | Orange | Some components unavailable |
| **Major Outage** | Red | Significant service disruption |

### Why This Matters

External service outages can affect:

- AI summarization (Groq, OpenRouter outages)
- Deployment pipelines (Vercel, GitHub outages)
- API availability (Cloudflare, AWS outages)

Monitoring these services provides context when dashboard features behave unexpectedly.

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
| **Language** | TypeScript 5.x | Type safety across 60+ source files |
| **Build** | Vite | Fast HMR, optimized production builds |
| **Map (Desktop)** | deck.gl + MapLibre GL | WebGL-accelerated rendering for large datasets |
| **Map (Mobile)** | D3.js + TopoJSON | SVG fallback for battery efficiency |
| **Concurrency** | Web Workers | Off-main-thread clustering and correlation |
| **AI/ML** | ONNX Runtime Web | Browser-based inference for offline summarization |
| **Networking** | WebSocket + REST | Real-time AIS stream, HTTP for other APIs |
| **Storage** | IndexedDB | Snapshots, baselines (megabytes of state) |
| **Preferences** | LocalStorage | User settings, monitors, panel order |
| **Deployment** | Vercel Edge | Serverless proxies with global distribution |

### Map Rendering Architecture

The map uses a hybrid rendering strategy optimized for each platform:

**Desktop (deck.gl + MapLibre GL)**:

- WebGL-accelerated layers handle thousands of markers smoothly
- MapLibre GL provides base map tiles (OpenStreetMap)
- GeoJSON, Scatterplot, Path, and Icon layers for different data types
- GPU-based clustering and picking for responsive interaction

**Mobile (D3.js + TopoJSON)**:

- SVG rendering for battery efficiency
- Reduced marker count and simplified layers
- Touch-optimized interaction with larger hit targets
- Automatic fallback when WebGL unavailable

### Key Libraries

- **deck.gl**: High-performance WebGL visualization layers
- **MapLibre GL**: Open-source map rendering engine
- **D3.js**: SVG map rendering, zoom behavior (mobile fallback)
- **TopoJSON**: Efficient geographic data encoding
- **ONNX Runtime**: Browser-based ML inference
- **Custom HTML escaping**: XSS prevention (DOMPurify pattern)

### No External UI Frameworks

The entire UI is hand-crafted DOM manipulation—no React, Vue, or Angular. This keeps the bundle small (~250KB gzipped) and provides fine-grained control over rendering performance.

### Build-Time Configuration

Vite injects configuration values at build time, enabling features like automatic version syncing:

| Variable | Source | Purpose |
|----------|--------|---------|
| `__APP_VERSION__` | `package.json` version field | Header displays current version |

This ensures the displayed version always matches the published package—no manual synchronization required.

```typescript
// vite.config.ts
define: {
  __APP_VERSION__: JSON.stringify(pkg.version),
}

// App.ts
const header = `World Monitor v${__APP_VERSION__}`;
```

---

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
| EIA | Oil analytics (prices, production, inventory) | Yes (free) |
| USASpending.gov | Federal government contracts & awards | No |
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
| `EIA_API_KEY` | Oil analytics | Free registration at [eia.gov/opendata](https://www.eia.gov/opendata/) |
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
│   ├── DeckGLMap.ts          # WebGL map with deck.gl + MapLibre (desktop)
│   ├── Map.ts                # D3.js SVG map (mobile fallback)
│   ├── MapContainer.ts       # Map wrapper with platform detection
│   ├── MapPopup.ts           # Contextual info popups
│   ├── SearchModal.ts        # Universal search (⌘K)
│   ├── SignalModal.ts        # Signal intelligence display with focal points
│   ├── PizzIntIndicator.ts   # Pentagon Pizza Index display
│   ├── VirtualList.ts        # Virtual/windowed scrolling
│   ├── InsightsPanel.ts      # AI briefings + focal point display
│   ├── EconomicPanel.ts      # FRED economic indicators
│   ├── GdeltIntelPanel.ts    # Topic-based intelligence (cyber, military, etc.)
│   ├── LiveNewsPanel.ts      # YouTube live news streams with channel switching
│   ├── NewsPanel.ts          # News feed with clustering
│   ├── MarketPanel.ts        # Stock/commodity display
│   ├── MonitorPanel.ts       # Custom keyword monitors
│   ├── CIIPanel.ts           # Country Instability Index display
│   ├── CascadePanel.ts       # Infrastructure cascade analysis
│   ├── StrategicRiskPanel.ts # Strategic risk overview dashboard
│   ├── StrategicPosturePanel.ts # AI strategic posture with theater analysis
│   ├── ServiceStatusPanel.ts # External service health monitoring
│   └── ...
├── config/
│   ├── feeds.ts              # 70+ RSS feeds, source tiers, regional sources
│   ├── geo.ts                # 30+ hotspots, conflicts, 55 cables, waterways, spaceports, minerals
│   ├── pipelines.ts          # 88 oil & gas pipelines
│   ├── ports.ts              # 61 strategic ports worldwide
│   ├── bases-expanded.ts     # 220+ military bases
│   ├── ai-datacenters.ts     # 313 AI clusters (filtered to 111)
│   ├── airports.ts           # 30 monitored US airports
│   ├── irradiators.ts        # IAEA gamma irradiator sites
│   ├── nuclear-facilities.ts # Global nuclear infrastructure
│   ├── markets.ts            # Stock symbols, sectors
│   ├── entities.ts           # 100+ entity definitions (companies, indices, commodities, countries)
│   └── panels.ts             # Panel configs, layer defaults, mobile optimizations
├── services/
│   ├── ais.ts                # WebSocket vessel tracking with density analysis
│   ├── military-vessels.ts   # Naval vessel identification and tracking
│   ├── military-flights.ts   # Aircraft tracking via OpenSky relay
│   ├── military-surge.ts     # Surge detection with news correlation
│   ├── cached-theater-posture.ts # Theater posture API client with caching
│   ├── wingbits.ts           # Aircraft enrichment (owner, operator, type)
│   ├── pizzint.ts            # Pentagon Pizza Index + GDELT tensions
│   ├── protests.ts           # ACLED + GDELT integration
│   ├── gdelt-intel.ts        # GDELT Doc API topic intelligence
│   ├── gdacs.ts              # UN GDACS disaster alerts
│   ├── eonet.ts              # NASA EONET natural events + GDACS merge
│   ├── flights.ts            # FAA delay parsing
│   ├── outages.ts            # Cloudflare Radar integration
│   ├── rss.ts                # RSS parsing with circuit breakers
│   ├── markets.ts            # Finnhub, Yahoo Finance, CoinGecko
│   ├── earthquakes.ts        # USGS integration
│   ├── weather.ts            # NWS alerts
│   ├── fred.ts               # Federal Reserve data
│   ├── oil-analytics.ts      # EIA oil prices, production, inventory
│   ├── usa-spending.ts       # USASpending.gov contracts & awards
│   ├── polymarket.ts         # Prediction markets (filtered)
│   ├── clustering.ts         # Jaccard similarity clustering
│   ├── correlation.ts        # Signal detection engine
│   ├── velocity.ts           # Velocity & sentiment analysis
│   ├── related-assets.ts     # Infrastructure near news events
│   ├── activity-tracker.ts   # New item detection & highlighting
│   ├── analysis-worker.ts    # Web Worker manager
│   ├── ml-worker.ts          # Browser ML inference (ONNX)
│   ├── summarization.ts      # AI briefings with fallback chain
│   ├── parallel-analysis.ts  # Concurrent headline analysis
│   ├── storage.ts            # IndexedDB snapshots & baselines
│   ├── data-freshness.ts     # Real-time data staleness tracking
│   ├── signal-aggregator.ts  # Central signal collection & grouping
│   ├── focal-point-detector.ts   # Intelligence synthesis layer
│   ├── entity-index.ts       # Entity lookup maps (by alias, keyword, sector)
│   ├── entity-extraction.ts  # News-to-entity matching for market correlation
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
├── eia/[[...path]].js        # EIA petroleum data (oil prices, production)
├── faa-status.js             # FAA ground stops/delays
├── finnhub.js                # Stock quotes (batch, primary)
├── fred-data.js              # Federal Reserve economic data
├── gdelt-doc.js              # GDELT Doc API (topic intelligence)
├── gdelt-geo.js              # GDELT Geo API (event geolocation)
├── polymarket.js             # Prediction markets with validation
├── yahoo-finance.js          # Stock indices/commodities (backup)
├── opensky-relay.js          # Military aircraft tracking
├── wingbits.js               # Aircraft enrichment proxy
├── risk-scores.js            # Pre-computed CII and strategic risk (Redis cached)
├── theater-posture.js        # Theater-level force aggregation (Redis cached)
├── groq-summarize.js         # AI summarization with Groq API
└── openrouter-summarize.js   # AI summarization fallback via OpenRouter
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
- **Click markers** - Show detailed popup with full context
- **Hover markers** - Show tooltip with summary information
- **Layer toggles** - Show/hide data layers

### Map Marker Design

Infrastructure markers (nuclear facilities, economic centers, ports) display without labels to reduce visual clutter. Full information is available through interaction:

| Layer | Label Behavior | Interaction |
|-------|---------------|-------------|
| Nuclear facilities | Hidden | Click for popover with details |
| Economic centers | Hidden | Click for popover with details |
| Protests | Hidden | Hover for tooltip, click for details |
| Military bases | Hidden | Click for popover with base info |
| Hotspots | Visible | Color-coded activity levels |
| Conflicts | Visible | Status and involved parties |

This design prioritizes geographic awareness over label density—users can quickly scan for markers and then interact for context.

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

Aggregates **70+ RSS feeds** from major news outlets, government sources, and specialty publications with source-tier prioritization. Categories include world news, MENA, Africa, Latin America, Asia-Pacific, energy, technology, AI/ML, finance, government releases, defense/intel, think tanks, and international crisis organizations.

### Geospatial Data

- **Hotspots**: 30+ global intelligence hotspots with keyword correlation (including Sahel, Haiti, Horn of Africa)
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

Thanks to **[@fai9al](https://github.com/fai9al)** for the inspiration and original PR that led to the Tech Monitor variant

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

- ✅ **Focal Point Detection** - Intelligence synthesis correlating news entities with map signals
- ✅ **AI-Powered Briefings** - Groq/OpenRouter/Browser ML fallback chain for summarization
- ✅ **Military Surge Detection** - Alerts when multiple operators converge on regions
- ✅ **News-Signal Correlation** - Surge alerts include related focal point context
- ✅ **GDACS Integration** - UN disaster alert system for earthquakes, floods, cyclones, volcanoes
- ✅ **WebGL Map (deck.gl)** - High-performance rendering for desktop users
- ✅ **Browser ML Fallback** - ONNX Runtime for offline summarization capability
- ✅ **Multi-Signal Geographic Convergence** - Alerts when 3+ data types converge on same region within 24h
- ✅ **Country Instability Index (CII)** - Real-time composite risk score for 20 Tier-1 countries
- ✅ **Infrastructure Cascade Visualization** - Dependency graph showing downstream effects of disruptions
- ✅ **Strategic Risk Overview** - Unified alert system with cross-module correlation and deduplication
- ✅ **GDELT Topic Intelligence** - Categorized feeds for military, cyber, nuclear, and sanctions topics
- ✅ **OpenSky Authentication** - OAuth2 credentials for military aircraft tracking via relay
- ✅ **Human-Readable Locations** - Convergence alerts show place names instead of coordinates
- ✅ **Data Freshness Tracking** - Status panel shows enabled/disabled state for all feeds
- ✅ **CII Scoring Bias Prevention** - Log scaling and conflict zone floors prevent news volume bias
- ✅ **Alert Warmup Period** - Suppresses false positives on dashboard startup
- ✅ **Significant Protest Filtering** - Map shows only riots and high-severity protests
- ✅ **Intelligence Findings Detail Modal** - Click any alert for full context and component breakdown
- ✅ **Build-Time Version Sync** - Header version auto-syncs with package.json
- ✅ **Tech Monitor Variant** - Dedicated technology sector dashboard with startup ecosystems, cloud regions, and tech events
- ✅ **Smart Marker Clustering** - Geographic grouping of nearby markers with click-to-expand popups
- ✅ **Variant Switcher UI** - Compact orbital navigation between World Monitor and Tech Monitor
- ✅ **CII Learning Mode** - 15-minute calibration period with visual progress indicator
- ✅ **Regional Tech Coverage** - Verified tech HQ data for MENA, Europe, Asia-Pacific hubs
- ✅ **Service Status Panel** - External service health monitoring (AI providers, cloud platforms)
- ✅ **AI Strategic Posture Panel** - Theater-level force aggregation with strike capability assessment
- ✅ **Server-Side Risk Score API** - Pre-computed CII and strategic risk scores with Redis caching
- ✅ **Naval Vessel Classification** - Known vessel database with hull number matching and AIS type inference
- ✅ **Strike Capability Detection** - Assessment of offensive force packages (tankers + AWACS + fighters)
- ✅ **Theater Posture Thresholds** - Custom elevated/critical thresholds for each strategic theater

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

**Information density over aesthetics.** Every pixel should convey signal. The dark interface minimizes eye strain during extended monitoring sessions. Panels are collapsible, draggable, and hideable—customize to show only what matters.

**Authority matters.** Not all sources are equal. Wire services and official government channels are prioritized over aggregators and blogs. When multiple sources report the same story, the most authoritative source is displayed as primary.

**Correlation over accumulation.** Raw news feeds are noise. The value is in clustering related stories, detecting velocity changes, and identifying cross-source patterns. A single "Broadcom +2.5% explained by AI chip news" signal is more valuable than showing both data points separately.

**Signal, not noise.** Deduplication is aggressive. The same market move doesn't generate repeated alerts. Signals include confidence scores so you can prioritize attention. Alert fatigue is the enemy of situational awareness.

**Knowledge-first matching.** Simple keyword matching produces false positives. The entity knowledge base understands that AVGO is Broadcom, that Broadcom competes with Nvidia, and that both are in semiconductors. This semantic layer transforms naive string matching into intelligent correlation.

**Fail gracefully.** External APIs are unreliable. Circuit breakers prevent cascading failures. Cached data displays during outages. The status panel shows exactly what's working and what isn't—no silent failures.

**Local-first.** No accounts, no cloud sync. All preferences and history stored locally. The only network traffic is fetching public data. Your monitoring configuration is yours alone.

**Compute where it matters.** CPU-intensive operations (clustering, correlation) run in Web Workers to keep the UI responsive. The main thread handles only rendering and user interaction.

---

## System Architecture

### Data Flow Overview

```
                                    ┌─────────────────────────────────┐
                                    │     External Data Sources       │
                                    │  RSS Feeds, APIs, WebSockets    │
                                    └─────────────┬───────────────────┘
                                                  │
                         ┌────────────────────────┼────────────────────────┐
                         │                        │                        │
                         ▼                        ▼                        ▼
               ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
               │   RSS Parser    │    │    API Client   │    │  WebSocket Hub  │
               │  (News Feeds)   │    │ (USGS, FAA...)  │    │ (AIS, Markets)  │
               └────────┬────────┘    └────────┬────────┘    └────────┬────────┘
                        │                      │                      │
                        └──────────────────────┼──────────────────────┘
                                               │
                                               ▼
                             ┌─────────────────────────────────┐
                             │      Circuit Breakers           │
                             │  (Rate Limiting, Retry Logic)   │
                             └─────────────┬───────────────────┘
                                           │
                         ┌─────────────────┼─────────────────┐
                         │                 │                 │
                         ▼                 ▼                 ▼
               ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
               │  Data Freshness │ │  Search Index   │ │   Web Worker    │
               │    Tracker      │ │  (Searchables)  │ │  (Clustering)   │
               └────────┬────────┘ └────────┬────────┘ └────────┬────────┘
                        │                   │                   │
                        └───────────────────┼───────────────────┘
                                            │
                                            ▼
                             ┌─────────────────────────────────┐
                             │         App State               │
                             │  (Map, Panels, Intelligence)    │
                             └─────────────┬───────────────────┘
                                           │
                                           ▼
                             ┌─────────────────────────────────┐
                             │      Rendering Pipeline         │
                             │  D3.js Map + React-like Panels  │
                             └─────────────────────────────────┘
```

### Update Cycles

Different data types refresh at different intervals based on volatility and API limits:

| Data Type | Refresh Interval | Rationale |
|-----------|------------------|-----------|
| **News Feeds** | 3 minutes | Balance between freshness and API politeness |
| **Market Data** | 60 seconds | Real-time awareness with rate limit constraints |
| **Military Tracking** | 30 seconds | High-priority for situational awareness |
| **Weather Alerts** | 5 minutes | NWS update frequency |
| **Earthquakes** | 5 minutes | USGS update cadence |
| **Internet Outages** | 5 minutes | Cloudflare Radar update frequency |
| **AIS Vessels** | Real-time | WebSocket streaming |

### Error Handling Strategy

The system implements defense-in-depth for external service failures:

**Circuit Breakers**

- Each external service has an independent circuit breaker
- After 3 consecutive failures, the circuit opens for 60 seconds
- Partial failures don't cascade to other services
- Status panel shows exact failure states

**Graceful Degradation**

- Stale cached data displays during outages (with timestamp warning)
- Failed services are automatically retried on next cycle
- Critical data (news, markets) has backup sources

**User Feedback**

- Real-time status indicators in the header
- Specific error messages in the status panel
- No silent failures—every data source state is visible

### Build-Time Optimization

The project uses Vite for optimal production builds:

**Code Splitting**

- Web Worker code is bundled separately
- Config files (tech-geo.ts, pipelines.ts) are tree-shaken
- Lazy-loaded panels reduce initial bundle size

**Variant Builds**

- `npm run build` - Standard geopolitical dashboard
- `npm run build:tech` - Tech sector variant with different defaults
- Both share the same codebase, configured via environment variables

**Asset Optimization**

- TopoJSON geography data is pre-compressed
- Static config data is inlined at build time
- CSS is minified and autoprefixed

### Security Considerations

**Client-Side Security**

- All user input is sanitized via `escapeHtml()` before rendering
- URLs are validated via `sanitizeUrl()` before href assignment
- No `innerHTML` with user-controllable content

**API Security**

- Sensitive API keys are stored server-side only
- Proxy functions validate and sanitize parameters
- Geographic coordinates are clamped to valid ranges

**Privacy**

- No user accounts or cloud storage
- All preferences stored in localStorage
- No telemetry beyond basic Vercel analytics (page views only)

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
