# World Monitor: Press Kit & FAQ

## What Is World Monitor?

World Monitor is a real-time global intelligence dashboard that brings together news, markets, military activity, infrastructure data, and AI-powered analysis into a single, interactive map interface. Think of it as a situational awareness tool that was previously only available to government agencies and large corporations with six-figure OSINT budgets, now accessible to journalists, analysts, researchers, and curious citizens through a web browser or desktop app.

The platform monitors over 200 countries using 435+ news feeds, 30+ live video streams, satellite tracking, military flight and naval vessel data, prediction markets, and dozens of specialized data layers. All of this is visualized on either a photorealistic 3D globe or a flat WebGL map, with AI summarization that distills thousands of headlines into actionable intelligence briefs.

---

## How Does It Work?

### The Core Experience

When a user opens World Monitor, they see a globe (or flat map) populated with live data points. Each point represents something happening in the world right now: a military flight over the Black Sea, an earthquake in Turkey, a protest in Nairobi, a cyberattack origin in Eastern Europe, or a spike in GPS jamming near a conflict zone.

Users can toggle 45+ data layers on and off, zoom into regions, click on any event for details, and read AI-generated summaries that connect dots across multiple data streams. A command palette (Cmd+K) provides instant search across countries, layers, and intelligence categories.

### Five Specialized Dashboards

World Monitor runs five thematic variants from a single codebase, each tailored to a different audience:

| Variant | Domain | Focus |
|---------|--------|-------|
| **World Monitor** | worldmonitor.app | Geopolitics, military, conflicts, infrastructure |
| **Tech Monitor** | tech.worldmonitor.app | AI/ML, startups, cybersecurity, tech ecosystems |
| **Finance Monitor** | finance.worldmonitor.app | Markets, central banks, Gulf FDI, commodities |
| **Commodity Monitor** | commodity.worldmonitor.app | Mining, metals, energy, critical minerals |
| **Happy Monitor** | happy.worldmonitor.app | Good news, conservation, positive global trends |

### AI Intelligence Layer

World Monitor uses a multi-tier AI pipeline to process and summarize information:

1. **World Brief**: An AI-generated summary of the most significant global events, updated regularly, using a chain of language models that prioritizes speed and cost efficiency.
2. **AI Deduction**: Users can ask free-text geopolitical questions (e.g., "What are the implications of rising tensions in the South China Sea?") and receive analysis grounded in live headlines.
3. **Headline Memory**: The system maintains a local semantic index of recent headlines, allowing it to recall and correlate events across time.
4. **Threat Classification**: A three-stage pipeline automatically categorizes incoming news by severity and type.
5. **Country Intelligence Briefs**: Full-page dossiers for any country, combining instability scores, AI analysis, event timelines, and prediction market data.

All AI features can run entirely in the browser using lightweight ML models, with no data leaving the user's device. Cloud AI (via Groq, OpenRouter) is optional and used only when configured.

---

## Where Does the Data Come From?

World Monitor aggregates publicly available data from dozens of sources. No proprietary or classified information is used. Key source categories:

### News & Media

- **435+ RSS feeds** from Reuters, AP, BBC, Al Jazeera, CNN, The Guardian, and dozens of specialized outlets
- **30+ live video streams** from major news networks
- **22 live webcams** from geopolitical hotspots
- **26 Telegram OSINT channels** including BNO News, Aurora Intel, DeepState, and Bellingcat

### Geopolitical & Security

- **ACLED** (Armed Conflict Location & Event Data): Protest and conflict event tracking
- **UCDP** (Uppsala Conflict Data Program): Armed conflict datasets
- **GDELT** (Global Database of Events, Language, and Tone): Global event detection
- **OREF** (Israel Home Front Command): Real-time rocket alert sirens
- **LiveUAMap**: Conflict event mapping (Iran theater)
- **Government travel advisories**: US State Department, UK FCDO, Australia DFAT, NZ MFAT
- **13 US Embassy feeds** for country-specific security updates

### Military & Strategic

- **ADS-B Exchange / OpenSky**: Live military aircraft tracking
- **AIS (Automatic Identification System)**: Naval vessel monitoring
- **CelesTrak**: Intelligence satellite orbital data (TLE propagation)
- **226 military bases** from 9 operators mapped globally
- **Nuclear facility locations** and gamma irradiator sites

### Infrastructure & Environment

- **USGS**: Earthquake data
- **GDACS**: Global disaster alerts
- **NASA EONET**: Natural events (volcanoes, wildfires, storms)
- **NASA FIRMS**: Satellite fire detection (VIIRS thermal hotspots)
- **Cloudflare Radar**: Internet outage detection
- **Submarine cable landing points** and cable repair ship tracking
- **111 airports** monitored for delays and NOTAM closures

### Markets & Finance

- **Yahoo Finance**: Stock quotes, indices, sectors
- **CoinGecko**: Cryptocurrency prices
- **Polymarket**: Prediction market data for geopolitical events
- **FRED** (Federal Reserve Economic Data): Macroeconomic indicators
- **EIA** (Energy Information Administration): Oil and energy data
- **BIS** (Bank for International Settlements): Central bank rates
- **mempool.space**: Bitcoin network metrics

### Cyber Threats

- **abuse.ch** (Feodo Tracker, URLhaus): Malware and botnet C2 servers
- **AlienVault OTX**: Threat intelligence indicators
- **AbuseIPDB**: IP reputation data
- **C2IntelFeeds**: Command-and-control infrastructure
- **Ransomware.live**: Active ransomware tracking

### Humanitarian

- **UN OCHA HAPI**: Displacement and humanitarian data
- **WorldPop**: Population exposure estimation
- **CDC, ECDC, WHO**: Health agency feeds
- **Open-Meteo ERA5**: Climate anomaly detection across 15 zones

---

## Key Numbers

| Metric | Value |
|--------|-------|
| News feeds monitored | 435+ |
| Live video streams | 30+ |
| Data layers on map | 45+ |
| Countries monitored | 200+ |
| Languages supported | 21 (including RTL) |
| Military bases mapped | 210+ |
| AI datacenters mapped | 111 |
| Stock exchanges mapped | 92 |
| Strategic ports mapped | 83 |
| Undersea cables tracked | 55+ |
| Pipelines mapped | 88 |
| Intelligence satellites tracked | 80-120 |
| Telegram OSINT channels | 26 |
| Airports monitored | 107 |
| Prediction market events | 100+ |

---

## Who Is It For?

World Monitor serves several audiences:

- **Journalists & Newsrooms**: Real-time situational awareness during breaking events. Layer military flights over conflict zones, cross-reference with news feeds and prediction markets.
- **Security & Risk Analysts**: Country instability scoring (CII), threat classification, infrastructure monitoring, and AI-generated intelligence briefs.
- **Researchers & Academics**: Access to aggregated open-source intelligence across dozens of domains, with historical context and source attribution.
- **Finance Professionals**: Market radar with macro signals, Gulf FDI tracking, stablecoin health monitoring, central bank rate data, and commodity intelligence.
- **Policy Analysts**: Cross-stream correlation of geopolitical signals, from military movements to economic indicators to social unrest patterns.
- **General Public**: Anyone who wants to understand what is happening in the world beyond traditional news headlines.

---

## How Is It Different from Existing Tools?

| Feature | World Monitor | Traditional OSINT Tools | News Aggregators |
|---------|--------------|------------------------|-----------------|
| Real-time map visualization | Yes (3D globe + flat map) | Often static or delayed | No map |
| AI summarization | Yes (multi-tier LLM) | Rarely | Basic or none |
| Military tracking | ADS-B + AIS + satellites | Specialized tools only | No |
| Prediction markets | Integrated | No | No |
| Multiple thematic variants | 5 dashboards | Usually single-focus | No |
| Browser-based ML | Yes (no data leaves device) | Server-dependent | No |
| Desktop app | Yes (macOS, Windows, Linux) | Varies | Rarely |
| Cost | Free tier available | $10K-100K+/year | Free but limited |
| Open source | AGPL-3.0 | Almost never | Rarely |

---

## Scoring & Detection Systems

### Country Instability Index (CII)

Every country receives a real-time instability score from 0 to 100, calculated from four weighted components:

- **Baseline risk** (40%): Historical conflict, governance, and fragility indicators
- **Social unrest** (20%): Protest frequency, labor strikes, civil demonstrations
- **Security events** (20%): Armed incidents, terrorism, military escalation
- **Information velocity** (20%): Anomalous spikes in news volume relative to baseline

Scores are classified as: Low (0-20), Normal (21-40), Elevated (41-60), High (61-80), Critical (81-100).

### Hotspot Detection

The system identifies emerging crises by blending news clustering, geographic convergence, CII scores, and military signal proximity. When multiple indicators converge in a region, the system elevates it as a "hotspot" with escalation scoring.

### Cross-Stream Correlation

14 signal types are monitored for unusual patterns: when a GPS jamming spike coincides with military flight activity near an active conflict zone, or when prediction market prices shift alongside breaking news from a specific region, the system flags these correlations for analyst attention.

---

## Privacy & Security

- **No user accounts required** for the free tier. No tracking cookies, no personal data collection.
- **All AI can run locally** in the browser using lightweight ML models. No headlines or queries are sent to external servers unless the user explicitly configures cloud AI.
- **API keys are server-side only**. The browser never sees credentials for upstream data providers.
- **Open source** under AGPL-3.0, meaning the code is publicly auditable.
- **Rate limiting and bot protection** are enforced at the API layer.
- **Desktop app** stores API keys in the OS keychain (macOS Keychain, Windows Credential Manager).

---

## Availability

- **Web**: Available at worldmonitor.app and variant subdomains
- **Desktop**: Native apps for macOS, Windows, and Linux (via Tauri)
- **PWA**: Installable as a progressive web app with offline map tile caching
- **Mobile**: Mobile-optimized responsive layout with touch gestures
- **Languages**: 21 languages including Arabic (RTL), Chinese, Japanese, Korean, Hindi, and major European languages

---

## What's Next: Roadmap Highlights

World Monitor is actively developed with planned expansions across several areas:

### Pro Tier (Planned)

- **Authenticated user accounts** with personalized dashboards
- **Scheduled AI briefings** delivered via email, Slack, Telegram, Discord, or WhatsApp
- **Advanced equity research** with financials, analyst targets, valuation metrics, and backtesting
- **Custom alert rules** for specific countries, topics, or threshold triggers
- **API access** for developers and organizations to integrate World Monitor data into their own tools

### Enterprise Features (Planned)

- **Team workspaces** with shared views and annotations
- **Custom data source integration** (bring your own feeds)
- **Compliance and audit logging**
- **Dedicated support and SLAs**
- **On-premise deployment** options

### Platform Expansion

- **Push notifications** for critical alerts on mobile and desktop
- **Enhanced satellite analysis**: overhead pass prediction, revisit time analysis, imaging window alerts
- **Deeper financial intelligence**: expanded macro signal coverage, portfolio risk correlation
- **Additional OSINT channels**: expanded Telegram coverage, social media monitoring
- **Collaborative features**: shared map views, team annotations, briefing co-authoring

---

## Frequently Asked Questions

**Q: Is World Monitor free?**
A: Yes. The core dashboard with all map layers, news feeds, live streams, and AI features is free to use. A Pro tier with additional features is planned.

**Q: Where does World Monitor get its data?**
A: Exclusively from publicly available, open-source data. This includes government agencies (USGS, NASA, NOAA, EIA, FRED), academic institutions (ACLED, UCDP), open tracking networks (ADS-B, AIS), news RSS feeds, and public APIs. No classified or proprietary intelligence is used.

**Q: Is this legal?**
A: Yes. All data sources are publicly accessible and used within their terms of service. The platform aggregates open-source intelligence (OSINT), a well-established practice in journalism, academia, and security research.

**Q: How real-time is the data?**
A: Most data layers update every 1 to 15 minutes. Military flight and vessel tracking updates in near-real-time (seconds to minutes). News feeds are polled every 15 minutes. Prediction markets update every few minutes. Earthquake and disaster alerts propagate within minutes of occurrence.

**Q: Can I trust the AI analysis?**
A: The AI summarization and deduction features are tools, not oracles. They synthesize patterns from aggregated headlines and data, but should be treated as one input among many. All AI outputs cite their source headlines, allowing users to verify claims. The system is designed to surface signals, not make definitive predictions.

**Q: Does World Monitor track users or sell data?**
A: No. There are no tracking cookies, no user profiling, and no data sales. The free tier requires no account. AI features can run entirely in-browser with no data sent to external servers.

**Q: Is the code open source?**
A: Yes. World Monitor is licensed under AGPL-3.0, meaning anyone can inspect, audit, modify, and redistribute the code. If you run a modified version as a service, you must share your modifications under the same license.

**Q: Who built this?**
A: World Monitor was created by Elie Habib. It is an independent project, not affiliated with any government, intelligence agency, or defense contractor.

**Q: Can I embed World Monitor or use its data in my reporting?**
A: The web interface can be referenced and linked in reporting. For data integration, an API tier is planned. Please attribute "World Monitor (worldmonitor.app)" when referencing the platform in published work.

**Q: How is this different from Janes, Palantir, or Dataminr?**
A: Those are enterprise products costing tens to hundreds of thousands of dollars per year, typically sold to governments and large corporations. World Monitor aims to democratize access to situational awareness by aggregating public data and using AI to make it digestible. It is open source, free to use, and designed for individual analysts and small teams, not just large organizations.

**Q: What does "Country Instability Index" mean and how reliable is it?**
A: The CII is a composite score (0-100) that combines baseline risk data, social unrest indicators, security events, and news volume anomalies. It provides a relative comparison between countries and a directional indicator of change. It is not a predictive model and should not be used as the sole basis for security or investment decisions. It is most useful for identifying countries experiencing unusual activity relative to their baseline.

**Q: How many people work on this?**
A: World Monitor is primarily a solo project by its creator, with occasional open-source contributions from the community.

---

## Media Contact

For press inquiries, interview requests, or additional information:

- **GitHub**: github.com/koala73/worldmonitor
- **Website**: worldmonitor.app

---

*This document was last updated March 2026. World Monitor is an independent, open-source project licensed under AGPL-3.0.*
