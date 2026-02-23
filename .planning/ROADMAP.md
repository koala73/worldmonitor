# Roadmap: HappyMonitor

## Overview

HappyMonitor transforms the existing WorldMonitor codebase into an optimistic counterpart by adding a "happy" variant at happy.worldmonitor.app. The journey starts with the variant shell and warm visual theme, then builds the content pipeline (curated positive feeds first, ML sentiment filtering second), then delivers panels one cluster at a time -- news feed, map, counters, spotlights, trackers -- finishing with sharing, ambient TV mode, and celebration polish. Every phase delivers a coherent, verifiable capability on the live variant.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Variant Shell & Visual Foundation** - Register happy variant, warm theme, basemap, typography, and positive color system
- [x] **Phase 2: Curated Content Pipeline** - Integrate positive news RSS feeds, GDELT tone filter, and content category definitions (completed 2026-02-22)
- [x] **Phase 3: Positive News Feed & Quality Pipeline** - First visible panel: scrolling positive news with category filtering, ML sentiment gate, and multi-stage quality pipeline (completed 2026-02-23)
- [x] **Phase 4: Global Map & Positive Events** - Interactive map with geocoded positive events and live kindness layer (completed 2026-02-23)
- [x] **Phase 5: Humanity Data Panels** - Live ticking counters and long-term progress charts showing humanity getting better (completed 2026-02-23)
- [x] **Phase 6: Content Spotlight Panels** - Scientific breakthroughs ticker, today's best human spotlight, and daily digest (completed 2026-02-23)
- [ ] **Phase 7: Conservation & Energy Trackers** - Species comeback cards and renewable energy growth visualizations
- [ ] **Phase 8: Map Data Overlays** - World happiness heatmap, species recovery zones, and renewable energy installation layers
- [ ] **Phase 9: Sharing, TV Mode & Polish** - Shareable story cards, full-screen ambient mode, and celebration animations

## Phase Details

### Phase 1: Variant Shell & Visual Foundation
**Goal**: Users can navigate to happy.worldmonitor.app and see a warm, bright dashboard shell with the correct branding, even before content panels are populated
**Depends on**: Nothing (first phase)
**Requirements**: INFRA-01, INFRA-02, INFRA-03, THEME-01, THEME-02, THEME-03, THEME-04, THEME-05
**Success Criteria** (what must be TRUE):
  1. Navigating to happy.worldmonitor.app loads the HappyMonitor variant with correct title, favicon, and OG tags
  2. The dashboard renders with a warm color palette (greens, golds, soft blues) -- no dark military aesthetic visible
  3. The map displays a warm basemap style (green landmass, light ocean) instead of the dark satellite/military map
  4. All existing UI chrome (panel headers, status indicators, loading states, empty states) renders in the positive-semantic color system
  5. Typography is welcoming and readable, visually distinct from the default WorldMonitor variant
**Plans**: 3 plans

Plans:
- [x] 01-01-PLAN.md -- Variant registration, build scripts, metadata, favicons (INFRA-01, INFRA-02, INFRA-03)
- [x] 01-02-PLAN.md -- Warm CSS theme, typography, semantic colors (THEME-01, THEME-03, THEME-04)
- [x] 01-03-PLAN.md -- Map basemap styles, panel chrome, UI polish + visual verification (THEME-02, THEME-05)

### Phase 2: Curated Content Pipeline
**Goal**: The happy variant has a steady stream of positive news content flowing in from dedicated curated sources and GDELT positive tone filtering
**Depends on**: Phase 1
**Requirements**: FEED-01, FEED-03, FEED-04
**Success Criteria** (what must be TRUE):
  1. At least 5 dedicated positive news RSS feeds are actively ingesting stories (Good News Network, Positive.News, Reasons to be Cheerful, etc.)
  2. GDELT integration returns only positive-tone stories (tone>5 filter) when queried by the happy variant
  3. Every ingested story is tagged with one of the defined content categories (Science & Health, Nature & Wildlife, Humanity & Kindness, Innovation & Tech, Climate Wins, Culture & Community)
**Plans**: 3 plans

Plans:
- [x] 02-01-PLAN.md -- Positive RSS feed configuration and GDELT tone filter extension (FEED-01, FEED-03)
- [x] 02-02-PLAN.md -- Content category classifier, type extension, and feed wiring verification (FEED-04)
- [x] 02-03-PLAN.md -- Gap closure: wire classifyNewsItem into ingestion pipeline (FEED-04)

### Phase 3: Positive News Feed & Quality Pipeline
**Goal**: Users see a scrolling, real-time positive news feed as the primary content panel, with category filtering and ML-backed quality assurance
**Depends on**: Phase 2
**Requirements**: NEWS-01, NEWS-02, NEWS-03, FEED-02, FEED-05
**Success Criteria** (what must be TRUE):
  1. A scrolling news feed panel displays curated positive stories with title, source, image, and category badge
  2. Users can filter the news feed by category (Science, Nature, Humanity, etc.) and see only matching stories
  3. The feed auto-refreshes on a configurable interval, maintaining the same real-time feel as WorldMonitor
  4. Mixed-source feeds (non-curated) pass through DistilBERT-SST2 sentiment filtering with a configurable confidence threshold, and only positive stories (score >= 0.85) appear
  5. The multi-stage quality pipeline prioritizes curated sources as primary content, with sentiment-filtered mainstream as supplement
**Plans**: 3 plans

Plans:
- [ ] 03-01-PLAN.md -- App.ts happy variant integration: DEFCON exclusion, variant switcher, data loading guards, refresh interval filtering (NEWS-03)
- [ ] 03-02-PLAN.md -- PositiveNewsFeedPanel component with image cards, category filter bar, and RSS image extraction (NEWS-01, NEWS-02)
- [ ] 03-03-PLAN.md -- Sentiment gate service, multi-stage quality pipeline, and panel wiring in App.ts (NEWS-03, FEED-02, FEED-05)

### Phase 4: Global Map & Positive Events
**Goal**: Users see positive events and acts of kindness geolocated on the interactive map with warm-colored animated markers
**Depends on**: Phase 2
**Requirements**: MAP-01, MAP-02, KIND-01, KIND-02
**Success Criteria** (what must be TRUE):
  1. The map displays geocoded positive news events as warm-colored markers (green/gold pulses) that users can click for details
  2. A positive event Deck.gl layer shows news stories plotted at their geolocated positions
  3. A live kindness layer shows animated green pulses representing acts of kindness, donations, and volunteer events worldwide
  4. Kindness data combines estimated baseline pulses (weighted by population density) with real events from GoFundMe trending, Change.org wins, and similar sources
**Plans**: 3 plans

Plans:
- [ ] 04-01-PLAN.md -- MapLayers type extension, variant configs, happy layer toggles & legend (MAP-01)
- [ ] 04-02-PLAN.md -- Positive events geocoding pipeline + Deck.gl layer with green/gold markers (MAP-01, MAP-02)
- [ ] 04-03-PLAN.md -- Kindness data pipeline (baseline + curated) + Deck.gl animated green pulse layer (KIND-01, KIND-02)

### Phase 5: Humanity Data Panels
**Goal**: Users can watch live ticking counters of positive global metrics and explore long-term charts proving humanity is getting better
**Depends on**: Phase 1
**Requirements**: COUNT-01, COUNT-02, COUNT-03, PROG-01, PROG-02, PROG-03
**Success Criteria** (what must be TRUE):
  1. A counters panel displays Worldometer-style ticking numbers for babies born today, trees planted, vaccines administered, students graduated, books published, and renewable MW installed
  2. Counter values are derived from per-second rates calculated from latest annual UN/WHO/World Bank data and tick smoothly in real time
  3. Number transitions are smoothly animated, creating an always-moving, hypnotic feel
  4. A progress charts panel shows long-term trend sparklines/area charts for extreme poverty declining, literacy rising, child mortality dropping, and life expectancy increasing
  5. Progress chart data is sourced from Our World in Data REST API and World Bank Indicators API, rendered with D3.js in the warm color palette
**Plans**: 3 plans

Plans:
- [ ] 05-01-PLAN.md -- Counter rate service & CountersPanel with 60fps ticking animation (COUNT-01, COUNT-02, COUNT-03)
- [ ] 05-02-PLAN.md -- Progress data service (World Bank) & ProgressChartsPanel with D3.js area charts (PROG-01, PROG-02, PROG-03)
- [ ] 05-03-PLAN.md -- App.ts panel wiring & happy-theme.css styling for both panels (COUNT-01, COUNT-03, PROG-03)

### Phase 6: Content Spotlight Panels
**Goal**: Users see a scientific breakthroughs ticker, a daily hero spotlight, and a curated 5-good-things digest on the dashboard
**Depends on**: Phase 2
**Requirements**: SCI-01, SCI-02, HERO-01, HERO-02, HERO-03, DIGEST-01, DIGEST-02
**Success Criteria** (what must be TRUE):
  1. A horizontal scrolling ticker continuously displays recent scientific discoveries and medical advances sourced from ScienceDaily, Nature, Science, and Live Science RSS feeds
  2. A daily "Today's Best Human" card shows a featured hero/inventor/rescuer story with photo, excerpt, and their location marked on the map
  3. Hero stories are curated from GNN Heroes feed and editorial picks, updating daily
  4. A "5 Good Things" digest panel shows the top 5 positive stories of the day, each summarized in 50 words or less via Flan-T5 AI summarization
**Plans**: 3 plans

Plans:
- [ ] 06-01-PLAN.md -- Science RSS feeds, BreakthroughsTickerPanel, HeroSpotlightPanel (SCI-01, SCI-02, HERO-01, HERO-02, HERO-03)
- [ ] 06-02-PLAN.md -- GoodThingsDigestPanel with progressive AI summarization (DIGEST-01, DIGEST-02)
- [ ] 06-03-PLAN.md -- App.ts panel wiring, happy.ts config, and happy-theme.css styling (all requirements)

### Phase 7: Conservation & Energy Trackers
**Goal**: Users can explore wildlife conservation wins and watch renewable energy capacity grow in dedicated tracker panels
**Depends on**: Phase 1
**Requirements**: SPECIES-01, SPECIES-02, SPECIES-03, ENERGY-01, ENERGY-02, ENERGY-03
**Success Criteria** (what must be TRUE):
  1. A species comeback panel displays conservation win cards with species photo, population trend sparkline, and recovery status badge
  2. Species data is sourced from IUCN Red List data and conservation reports, updated monthly with historical population trends
  3. A renewable energy panel visualizes solar/wind installations growing and coal plants closing
  4. An animated gauge shows global renewable energy percentage climbing with a regional breakdown, using IEA and existing EIA API data
**Plans**: 3 plans

Plans:
- [ ] 07-01-PLAN.md -- Conservation wins static data + SpeciesComebackPanel with D3 sparklines (SPECIES-01, SPECIES-02, SPECIES-03)
- [ ] 07-02-PLAN.md -- Renewable energy data service + RenewableEnergyPanel with D3 arc gauge (ENERGY-01, ENERGY-02, ENERGY-03)
- [ ] 07-03-PLAN.md -- App.ts panel wiring, happy.ts config, and happy-theme.css styling (all requirements)

### Phase 8: Map Data Overlays
**Goal**: The map gains choropleth and overlay layers for world happiness, species recovery zones, and renewable energy installations
**Depends on**: Phase 4, Phase 7
**Requirements**: MAP-03, MAP-04, MAP-05
**Success Criteria** (what must be TRUE):
  1. A world happiness heatmap choropleth layer colors countries by happiness score (World Happiness Report data), with green indicating happier nations
  2. Species recovery zones appear as map overlays showing wildlife comeback locations sourced from IUCN data
  3. Renewable energy installation locations are displayed as a map layer showing where new capacity is being built
**Plans**: 2 plans

Plans:
- [ ] 08-01-PLAN.md -- Static data files (happiness scores, renewable installations, species coordinates), typed services, and MapLayers type extension (MAP-03, MAP-04, MAP-05)
- [ ] 08-02-PLAN.md -- Deck.gl overlay layers (choropleth, scatterplots), toggles, legend, tooltips, MapContainer delegation, App.ts wiring (MAP-03, MAP-04, MAP-05)

### Phase 9: Sharing, TV Mode & Polish
**Goal**: Users can share stories as branded image cards, watch HappyMonitor on a TV in ambient mode, and see celebration animations for milestone moments
**Depends on**: Phase 3, Phase 5, Phase 6, Phase 7
**Requirements**: SHARE-01, SHARE-02, SHARE-03, TV-01, TV-02, TV-03, THEME-06
**Success Criteria** (what must be TRUE):
  1. Users can tap a share button on any story to generate a branded image card with headline, category badge, warm gradient background, and HappyMonitor branding
  2. The share card exports as a PNG with watermark, ready for social media posting
  3. A full-screen TV/ambient mode auto-cycles between panels at a configurable interval (30s-2min) with larger typography and suppressed interactive elements
  4. Subtle ambient animations (floating particles, gentle transitions) create a warm background feel in TV mode
  5. Milestone moments (species recovery announced, renewable energy record, etc.) trigger celebration animations via canvas-confetti
**Plans**: TBD

Plans:
- [ ] 09-01: TBD
- [ ] 09-02: TBD
- [ ] 09-03: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9

Note: Phases 4, 5, 6, 7 can partially parallelize after Phase 2 completes (they share the variant shell and content pipeline as prerequisites but are otherwise independent).

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Variant Shell & Visual Foundation | 3/3 | Complete | 2026-02-22 |
| 2. Curated Content Pipeline | 3/3 | Complete    | 2026-02-22 |
| 3. Positive News Feed & Quality Pipeline | 0/3 | Complete    | 2026-02-23 |
| 4. Global Map & Positive Events | 0/3 | Complete    | 2026-02-23 |
| 5. Humanity Data Panels | 0/3 | Complete    | 2026-02-23 |
| 6. Content Spotlight Panels | 0/3 | Complete    | 2026-02-23 |
| 7. Conservation & Energy Trackers | 0/2 | Not started | - |
| 8. Map Data Overlays | 0/2 | Not started | - |
| 9. Sharing, TV Mode & Polish | 0/3 | Not started | - |
