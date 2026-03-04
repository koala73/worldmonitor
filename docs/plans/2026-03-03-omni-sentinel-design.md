# Omni Sentinel — Design Document

**Date:** 2026-03-03
**Status:** Approved
**Base:** Fork of [World Monitor](https://github.com/koala73/worldmonitor) v2.5.24

---

## Overview

Omni Sentinel extends World Monitor with deeper AI analysis (Claude API), expanded social media intelligence, military analysis frameworks (JP 3-60), government data integration, historical trajectory tracking, and enhanced prediction market coverage.

**Core decisions:**
- **Architecture:** Plugin mode — all new features follow World Monitor's proto-first service pattern
- **Deployment:** Vercel + Railway (inherit upstream infrastructure)
- **AI strategy:** Claude as primary provider, OpenRouter as fallback. Remove Ollama/Groq. Browser T5 kept as last-resort offline fallback for desktop
- **Scope:** All features developed in parallel, no phased rollout

---

## 1. Claude AI Provider

### Fallback Chain

```
Claude API → OpenRouter → (existing chain preserved for desktop offline)
```

Replaces the existing primary chain (Ollama → Groq → OpenRouter). Browser T5 is kept as a last-resort offline fallback for desktop environments, not removed.

### New Service

```
proto/worldmonitor/claude/v1/
  service.proto          — ClaudeService { Summarize, Analyze, Predict }
  summarize.proto        — News headline summarization
  analyze.proto          — Deep geopolitical analysis
  predict.proto          — Probability prediction (6-dimension scoring)

server/worldmonitor/claude/v1/
  handler.ts             — ClaudeServiceHandler
  summarize.ts           — Calls Anthropic API for summarization
  analyze.ts             — JP 3-60 style structured analysis
  predict.ts             — Conflict probability computation

api/claude/v1/[rpc].ts  — Vercel Edge Function entry point
src/services/claude/     — Frontend client wrapper
```

### Configuration

- API Key: `process.env.CLAUDE_API_KEY` (server-side only, never exposed to client)
- Feature flag: `aiClaude` in runtime-config
- Default model: `claude-sonnet-4-20250514`
- Settings UI: Add Claude section to existing AI settings panel

### Integration Points

- Replace `summarization.ts` API_PROVIDERS array with Claude-first chain
- Wire into existing World Brief, AI Deduction, and Headline Memory systems
- All existing AI features (threat classification, focal point detection, etc.) use Claude

---

## 2. Social Media Integration

### Architecture

Backend: Separate RPCs per platform (independent auth, rate limits, failure domains).
Frontend: Unified `SocialFeedPanel` with platform filter tabs.

### New Service

```
proto/worldmonitor/social/v1/
  service.proto          — SocialService { ListRedditPosts, ListTweets, ListBlueskyPosts, ListTikTokPosts, ListVKPosts, ListYouTubeVideos }
  reddit.proto
  twitter.proto
  bluesky.proto
  tiktok.proto
  vk.proto
  youtube.proto
  common.proto           — Unified SocialPost type
```

### Platform Details

| Platform | API | Auth | Cache | Edge/Worker |
|----------|-----|------|-------|-------------|
| Reddit | OAuth2 `oauth.reddit.com` | Client credentials | 5min | Edge Function |
| X/Twitter | TwitterAPI.io adapter | API key | 1min | Edge Function |
| Bluesky | AT Protocol (public, limit 25/request) | None needed | 2min | Edge Function |
| TikTok | Apify scraper | Apify token | 10min | Railway worker |
| VK | VK API v5 | Service token | 5min | Edge Function |
| YouTube | YouTube Data API v3 | API key (free tier) | 5min | Edge Function |

> **Twitter API note:** Twitter integration uses a third-party API adapter pattern (TwitterAPI.io as default, ~$0.15/1K tweets) rather than the official X API ($200/mo). See `docs/research/twitter-telegram-osint-guide.md` for detailed research.

### Monitored Sources

- **Reddit:** r/OSINT, r/geopolitics, r/CombatFootage, r/worldnews
- **X:** @sentdefender, @AuroraIntel, @Bellingcat, @IntelCrab + keyword search
- **Bluesky:** OSINT community feeds + keyword search
- **TikTok:** Conflict zone geotagged videos
- **VK:** Military-related public groups
- **YouTube:** OSINT news channels, citizen journalism, conflict zone coverage

### Frontend

- New `SocialFeedPanel` component (similar to existing `TelegramIntelPanel`)
- Platform filter tabs: All | Reddit | X | Bluesky | TikTok | VK | YouTube
- Geotagged posts appear on map as a new layer
- Feed into existing AI Threat Classification pipeline

---

## 3. JP 3-60 Military Analysis Agent

### Architecture

A structured 6-step analysis pipeline using Claude, each step with a specialized system prompt.

### New Service

```
proto/worldmonitor/analyst/v1/
  service.proto          — AnalystService { RunAssessment, GetPrediction, RunTargetAnalysis }
  assessment.proto       — Full 6-step analysis report
  prediction.proto       — Probability prediction with confidence levels
```

### JP 3-60 Six-Step Pipeline

Each step is a Claude API call with step-specific system prompt and data context:

1. **Commander's Objectives** — User specifies region/event of interest
2. **Target Development** — Auto-pull relevant data from ADS-B, AIS, ACLED, GDELT, social media
3. **Capabilities Analysis** — Claude analyzes military capabilities (weapons, forces, bases)
4. **Commander's Decision** — Claude generates action scenarios with probability assessment
5. **Mission Planning** — Claude projects timelines and operational sequences
6. **Assessment** — Claude produces composite score using 6-dimension weighted model

### Six-Dimension Weighted Scoring

```typescript
interface ConflictPrediction {
  militaryReadiness: number;      // 20% weight — derived from ADS-B military flight density + base activity
  politicalWill: number;          // 25% weight — derived from news/social media sentiment analysis
  targetUrgency: number;          // 20% weight — derived from OSINT event frequency
  diplomaticAlternatives: number; // 15% weight — derived from diplomatic activity news
  allySupport: number;            // 10% weight — derived from allied military movements
  provocationLevel: number;       // 10% weight — derived from adversary actions
  overallProbability: number;     // Weighted composite score
  confidence: 'low' | 'medium' | 'high';
  timeframe: string;              // e.g., "7 days", "30 days"
}
```

### Frontend

- New `AnalystPanel` component
- Input: Free-text analysis query (e.g., "Middle East conflict trajectory next 7 days")
- Output: Structured report with probability dashboard, timeline projection, confidence level
- History: Save and compare past reports
- Integration: Cross-reference with Polymarket/Kalshi prediction market data

---

## 4. Government Data Integration

### New Service

```
proto/worldmonitor/govdata/v1/
  service.proto          — GovDataService { ListNotams, ListNavtex, ListSanctions }
  notam.proto
  navtex.proto
  sanctions.proto
```

### Data Sources

| Data | Upstream API | Refresh | Map Display |
|------|-------------|---------|-------------|
| NOTAM (flight restrictions) | FAA NOTAM API + AviationStack | 15min | TFR polygon overlays on map |
| NAVTEX (maritime warnings) | NGA MSI API | 30min | Warning zone overlays on map |
| Sanctions | OpenSanctions API | 24h | Entity search panel |

> **NAVTEX note:** NAVTEX should NOT be implemented as a new standalone service — it should enhance the existing maritime navigational warnings service already in the codebase.

### OSINT Value

NOTAMs/TFRs are strong pre-strike indicators — temporary flight restrictions typically appear hours before military action.

---

## 5. Historical Trajectory Database

### New Service

```
proto/worldmonitor/trajectory/v1/
  service.proto          — TrajectoryService { QueryFlightHistory, QueryVesselHistory, GetTrajectoryTimelapse }
  flight_history.proto
  vessel_history.proto
```

### Data Sources

| Type | Source | Query Method |
|------|--------|-------------|
| ADS-B history | OpenSky Impala DB (free academic API) | By ICAO24 hex + time range |
| AIS history | AISHub historical data | By MMSI + time range |

### Frontend

- Click aircraft/vessel on map → "View History" button
- Renders historical track line on map with time slider
- Phase 1: Use OpenSky's free historical API (no self-hosted DB)
- Phase 2 (future): Self-hosted collection via readsb + PostgreSQL

---

## 6. Enhanced Prediction Markets

### Extend Existing Service

```
server/worldmonitor/prediction/v1/
  + kalshi.ts            — Kalshi API (US regulated market)
  + metaculus.ts         — Metaculus API (community forecasting)
```

### Frontend

- New comparison panel: Polymarket vs Kalshi vs Metaculus odds side-by-side
- Integration with AnalystPanel: AI prediction vs market prediction comparison
- Highlight divergence (when AI and markets disagree → potential alpha signal)

---

## 7. Expanded RSS News Sources

### Configuration Changes Only

Edit `src/config/feeds.ts`:
- Defense: ISW, INSS, IISS, RUSI
- Middle East: Al-Monitor, Middle East Eye
- Asia-Pacific: The Diplomat, Nikkei Asia
- Chinese: MIIT, MOFCOM, Xinhua
- Think tanks: CSIS, Carnegie, Atlantic Council

Edit `api/rss-proxy.js`:
- Add new domains to ALLOWED_DOMAINS

---

## Technical Notes

### Proto Workflow

All new services follow this pattern:

1. Define `.proto` files in `proto/worldmonitor/{service}/v1/`
2. Run `buf generate proto/` to generate TypeScript clients + servers
3. Implement handler in `server/worldmonitor/{service}/v1/handler.ts`
4. Create Edge Function in `api/{service}/v1/[rpc].ts`
5. Create client wrapper in `src/services/{service}/index.ts`
6. Wire up caching tier in `server/gateway.ts`

### Caching Strategy

| Service | Cache Tier | TTL |
|---------|-----------|-----|
| Claude summarize | medium | 5min |
| Claude analyze | slow | 15min |
| Social media feeds | fast | 1-5min (varies by platform) |
| NOTAM/NAVTEX | medium | 15min |
| Trajectory history | slow | 1h |
| Prediction markets | fast | 2min |
| RSS feeds | medium | 10min (existing) |

### New Panel Registration

Each new panel added to `src/config/panels.ts` in all variant configurations.

### i18n

All new UI strings added to `src/locales/en.json` (other languages can follow later via AI translation).

---

## Revisions

### 2026-03-03 — Post-review fixes

1. **P0-3 FIX (API Key security):** Changed API key storage from `localStorage` to `process.env.CLAUDE_API_KEY` (server-side only, never exposed to client).
2. **AI fallback chain update:** Clarified that Browser T5 is kept as a last-resort offline fallback for desktop environments, not removed. Chain is now `Claude API → OpenRouter → (existing chain preserved for desktop offline)`.
3. **Twitter API update:** Switched from official X API v2 ($200/mo) to third-party API adapter pattern (TwitterAPI.io as default, ~$0.15/1K tweets). See `docs/research/twitter-telegram-osint-guide.md`.
4. **YouTube addition:** Added YouTube as a new social media platform (YouTube Data API v3, API key free tier, 5min cache, Edge Function).
5. **NAVTEX note:** Clarified that NAVTEX should enhance the existing maritime navigational warnings service, not be a new standalone service.
6. **Bluesky correction:** Noted that the AT Protocol API limit is 25 per request, not 100.
