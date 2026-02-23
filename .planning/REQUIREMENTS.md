# Requirements: HappyMonitor

**Defined:** 2026-02-22
**Core Value:** Every piece of content on the dashboard makes the viewer feel genuinely better about humanity

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Variant Infrastructure

- [x] **INFRA-01**: Happy variant config (`VITE_VARIANT=happy`) registered in variant architecture with panel/feed/layer definitions
- [x] **INFRA-02**: Subdomain routing for happy.worldmonitor.app via Vercel config
- [x] **INFRA-03**: Variant-specific metadata (title, description, OG tags, favicon) for happy subdomain

### Visual Theme

- [x] **THEME-01**: Warm & bright CSS theme with custom color palette (warm greens, golds, soft blues), replacing dark military aesthetic
- [x] **THEME-02**: Warm map basemap style (green landmass, light ocean, gold accents) replacing dark military map
- [x] **THEME-03**: Typography and spacing adjustments for welcoming, readable feel (consider sans-serif for happy variant)
- [x] **THEME-04**: Positive-semantic color system replacing threat/severity colors (celebration gold, growth green, hope blue, kindness pink)
- [x] **THEME-05**: Happy counterparts for all existing dark-variant UI elements (panel headers, status indicators, loading states, empty states)
- [ ] **THEME-06**: Celebration animations via canvas-confetti for milestone moments (species recovery announced, renewable energy record, etc.)

### Content Pipeline

- [x] **FEED-01**: Dedicated positive news RSS feeds integrated (Good News Network, Positive.News, Reasons to be Cheerful, Optimist Daily, SunnySkyz, The Better India, Future Crunch)
- [x] **FEED-02**: AI sentiment filter using existing DistilBERT-SST2 to gate mixed-source feeds, only passing positive stories (score >= 0.85 threshold)
- [x] **FEED-03**: GDELT positive tone filter — extend existing GDELT integration with `tone>5` parameter for positive global news
- [x] **FEED-04**: Content categories defined and mapped: Science & Health, Nature & Wildlife, Humanity & Kindness, Innovation & Tech, Climate Wins, Culture & Community
- [x] **FEED-05**: Multi-stage content quality pipeline: curated sources as primary, sentiment-filtered mainstream as supplement, confidence threshold to minimize false positives

### Positive News Feed Panel

- [x] **NEWS-01**: Scrolling real-time positive news feed panel showing curated uplifting stories with title, source, image, and category
- [x] **NEWS-02**: Category filtering within the news feed (user can filter by Science, Nature, Humanity, etc.)
- [x] **NEWS-03**: Auto-refresh on configurable interval (same real-time feel as WorldMonitor)

### Global Map & Positive Events

- [x] **MAP-01**: Interactive map displaying geocoded positive events with warm-colored markers (green/gold pulses instead of red threat markers)
- [x] **MAP-02**: Positive event layer showing news stories geolocated on the map
- [x] **MAP-03**: World happiness heatmap choropleth layer (World Happiness Report data, green = happy)
- [x] **MAP-04**: Species recovery zones as map overlay (IUCN data, wildlife comeback locations)
- [x] **MAP-05**: Renewable energy installation locations as map layer

### Live Humanity Counters Panel

- [x] **COUNT-01**: Worldometer-style ticking counters for positive metrics: babies born today, trees planted, vaccines administered, students graduated, books published, renewable MW installed
- [x] **COUNT-02**: Per-second rate calculation from latest annual UN/WHO/World Bank data (no live API needed)
- [x] **COUNT-03**: Smooth animated number transitions (always-moving, hypnotic feel)

### Humanity Progress Charts Panel

- [x] **PROG-01**: Long-term trend charts showing human progress: extreme poverty declining, literacy rising, child mortality dropping, life expectancy increasing
- [x] **PROG-02**: Data sourced from Our World in Data REST API and World Bank Indicators API
- [x] **PROG-03**: D3.js sparkline/area chart visualizations with warm color palette

### Scientific Breakthroughs Ticker

- [x] **SCI-01**: Horizontal scrolling ticker of recent scientific discoveries and medical advances
- [x] **SCI-02**: RSS feeds from ScienceDaily, Nature, Science, Live Science filtered for breakthrough/positive content

### Today's Best Human Spotlight

- [x] **HERO-01**: Daily featured story card of an individual doing extraordinary good (hero, inventor, rescuer, volunteer)
- [x] **HERO-02**: Full-width card with photo, story excerpt, and location shown on map
- [x] **HERO-03**: Curated from GNN Heroes feed and editorial picks

### Daily Digest / "5 Good Things"

- [x] **DIGEST-01**: Summary panel showing 5 curated top positive stories of the day in 50 words or less each
- [x] **DIGEST-02**: AI summarization via existing Flan-T5 model in ML worker

### Species Comeback Tracker Panel

- [x] **SPECIES-01**: Wildlife conservation wins displayed as cards with species photo, population trend sparkline, and recovery status badge
- [x] **SPECIES-02**: Data sourced from IUCN Red List data and conservation reports
- [x] **SPECIES-03**: Monthly update cadence with historical population trend data

### Renewable Energy Growth Tracker Panel

- [x] **ENERGY-01**: Renewable energy capacity visualization showing solar/wind installations growing, coal plants closing
- [x] **ENERGY-02**: Animated gauge showing global renewable percentage climbing plus regional breakdown
- [x] **ENERGY-03**: Data from IEA Renewable Energy Progress Tracker and existing EIA API integration

### Live Kindness Map

- [x] **KIND-01**: Animated map layer showing acts of kindness, donations, volunteer events geolocated worldwide with green pulses
- [x] **KIND-02**: Hybrid data approach: estimated baseline pulses weighted by population density, overlaid with real events from GoFundMe trending, Change.org wins, etc.

### Shareable Story Cards

- [ ] **SHARE-01**: One-tap generation of branded image cards for sharing positive stories on social media
- [ ] **SHARE-02**: Canvas/SVG rendering with headline, category badge, warm gradient background, HappyMonitor branding
- [ ] **SHARE-03**: Export as PNG with watermark

### Ambient / TV Mode

- [x] **TV-01**: Full-screen lean-back mode designed for TV/second monitor with auto-cycling between panels
- [x] **TV-02**: Configurable panel rotation interval (30s-2min), suppressed interactive elements, larger typography
- [x] **TV-03**: Subtle ambient animations (floating particles, gentle transitions) for warm background feel

## v2 Requirements

### Engagement & Retention

- **ENGAGE-01**: Weekly email digest of "5 Good Things" (requires email infrastructure)
- **ENGAGE-02**: User-customizable panel layout (choose which panels to show/hide)

### Data Expansion

- **DATA-01**: Multi-language positive news filtering (beyond English)
- **DATA-02**: Real-time social media positivity tracker
- **DATA-03**: Country-specific positive news deep-dives

## Out of Scope

| Feature | Reason |
|---------|--------|
| User-submitted good news | Moderation nightmare, quality collapse, spam risk |
| Comments / social features | Destroys dashboard experience, moderation burden |
| Gamification / streaks / points | Undermines authenticity, creates anxiety |
| Push notifications | Notification fatigue, interrupts rather than soothes |
| Personalized / algorithmic feed | Filter bubbles even in positive content, added complexity |
| Premium / paywall | Contradicts freely-accessible mission |
| Excessive animation / particle effects | Kills dashboard credibility (warm, not birthday party) |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| INFRA-01 | Phase 1 | Complete |
| INFRA-02 | Phase 1 | Complete |
| INFRA-03 | Phase 1 | Complete |
| THEME-01 | Phase 1 | Complete |
| THEME-02 | Phase 1 | Complete |
| THEME-03 | Phase 1 | Complete |
| THEME-04 | Phase 1 | Complete |
| THEME-05 | Phase 1 | Complete |
| THEME-06 | Phase 9 | Pending |
| FEED-01 | Phase 2 | Complete |
| FEED-02 | Phase 3 | Complete |
| FEED-03 | Phase 2 | Complete |
| FEED-04 | Phase 2 | Complete |
| FEED-05 | Phase 3 | Complete |
| NEWS-01 | Phase 3 | Complete |
| NEWS-02 | Phase 3 | Complete |
| NEWS-03 | Phase 3 | Complete |
| MAP-01 | Phase 4 | Complete |
| MAP-02 | Phase 4 | Complete |
| MAP-03 | Phase 8 | Complete |
| MAP-04 | Phase 8 | Complete |
| MAP-05 | Phase 8 | Complete |
| COUNT-01 | Phase 5 | Complete |
| COUNT-02 | Phase 5 | Complete |
| COUNT-03 | Phase 5 | Complete |
| PROG-01 | Phase 5 | Complete |
| PROG-02 | Phase 5 | Complete |
| PROG-03 | Phase 5 | Complete |
| SCI-01 | Phase 6 | Complete |
| SCI-02 | Phase 6 | Complete |
| HERO-01 | Phase 6 | Complete |
| HERO-02 | Phase 6 | Complete |
| HERO-03 | Phase 6 | Complete |
| DIGEST-01 | Phase 6 | Complete |
| DIGEST-02 | Phase 6 | Complete |
| SPECIES-01 | Phase 7 | Complete |
| SPECIES-02 | Phase 7 | Complete |
| SPECIES-03 | Phase 7 | Complete |
| ENERGY-01 | Phase 7.1 | Complete |
| ENERGY-02 | Phase 7 | Complete |
| ENERGY-03 | Phase 7.1 | Complete |
| KIND-01 | Phase 4 | Complete |
| KIND-02 | Phase 4 | Complete |
| SHARE-01 | Phase 9 | Pending |
| SHARE-02 | Phase 9 | Pending |
| SHARE-03 | Phase 9 | Pending |
| TV-01 | Phase 9 | Complete |
| TV-02 | Phase 9 | Complete |
| TV-03 | Phase 9 | Complete |

**Coverage:**
- v1 requirements: 49 total
- Mapped to phases: 49
- Unmapped: 0

---
*Requirements defined: 2026-02-22*
*Last updated: 2026-02-22 after roadmap creation*
