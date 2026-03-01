# Integration Plan: WorldMonitor + xcu_my_apps + Codexes-Factory

## Context & Current State

### WorldMonitor (this repo)
- **Stack**: TypeScript + Vite SPA, MapLibre GL + deck.gl, vanilla DOM (no React/Vue)
- **Variants**: full, tech, finance, happy (build-time `VITE_VARIANT`)
- **Backend**: Vercel Edge Functions, sebuf proto-RPC, Upstash Redis cache
- **AI**: Groq → OpenRouter → browser T5 fallback chain
- **Key data**: 100+ RSS feeds, 40+ map layers, threat classification, signal aggregation, country instability index (CII), focal-point detection, trending spike detection
- **Existing exports**: Country Brief (PNG/JSON/CSV), AI intelligence briefs

### Codexes2Gemini / Codexes-Factory (external, `fredzannarbor/Codexes2Gemini`)
- **Stack**: Python, Streamlit UI, Gemini API (10M-token context)
- **Function**: AI-powered book generation — outlines, content, parts-of-the-book awareness
- **Deployed at**: codexes.xtuff.ai
- **Key classes**: `BuildLauncher`, `PromptsPlan` (JSON plan objects)
- **Install**: `pip install codexes2gemini`

### xcu_my_apps (not found locally or on public GitHub)
- Likely a private Streamlit multi-page app framework that hosts Codexes-Factory and other tools
- Provides shared look-and-feel, navigation, and authentication across Fred's apps

---

## Goals

1. **Unified look and feel** with Codexes-Factory (Streamlit-based)
2. **All existing WorldMonitor functions** preserved
3. **Recency filtering** — surface most current/breaking info
4. **Book-worthy event identification** — flag world events suitable for instant book generation
5. **Book request pipeline** — form submission → pipeline → iMessage + Claude Code notification → generation

---

## Architecture Decision

### Option A: Embed WorldMonitor as iframe/component in Streamlit ← **Recommended**

Create a new Streamlit page within xcu_my_apps that:
- Embeds the existing WorldMonitor web app (iframe or web component)
- Adds a Streamlit sidebar with filtering, book-worthiness scoring, and book request form
- Communicates via postMessage API (iframe ↔ Streamlit) or a shared API

**Pros**: Preserves the full, high-performance TypeScript/WebGL dashboard; minimal rewrite; Streamlit handles forms/auth/pipeline integration natively.

**Cons**: Two-way communication needs bridge code; slight UX seam at the iframe boundary.

### Option B: Pure Streamlit re-implementation

Rewrite WorldMonitor panels in Streamlit using st.components, folium/pydeck, etc.

**Pros**: Fully native Streamlit look. **Cons**: Massive effort; loses deck.gl 3D globe, real-time WebSocket feeds, 40+ interactive layers; performance regression.

### Option C: Add Streamlit-compatible API layer to WorldMonitor → Streamlit frontend consumes it

Build a Python API wrapper that calls WorldMonitor's existing edge functions and proto-RPC endpoints, then render in Streamlit.

**Pros**: Streamlit-native look and feel. **Cons**: Still significant rewrite of all visualization; loses interactivity.

**Recommendation: Option A** — iframe embed with Streamlit sidebar controls. This gives Codexes-Factory look-and-feel while preserving all existing WorldMonitor functionality.

---

## Implementation Plan

### Phase 1: New WorldMonitor Variant for Embedding (this repo)

**Files to modify/create:**

1. **`src/config/variants/codexes.ts`** (new) — Define a `codexes` variant config
   - Enable all `full` variant panels + map layers
   - Add CSS class `variant-codexes` for minor styling adjustments (hide redundant header chrome when embedded)
   - Add `postMessage` bridge for bi-directional communication

2. **`src/config/variant.ts`** — Add `'codexes'` to the variant union

3. **`src/config/panels.ts`** — Add `CODEXES_PANELS` definition (clone of `FULL_PANELS` plus new panels below)

4. **`src/components/BookWorthinessOverlay.ts`** (new) — Visual overlay that scores and highlights events
   - Consumes threat classification, CII scores, trending spikes, focal points
   - Displays a "Book-Worthy" badge on qualifying events
   - Scoring algorithm (see Phase 3)

5. **`src/components/RecencyFilter.ts`** (new) — Time-range filter component
   - Dropdown/slider: Last 1h, 6h, 24h, 3d, 7d, custom
   - Filters all news panels, map events, and insights by recency
   - Integrates with existing `currentTimeRange` state

6. **`src/services/book-worthiness.ts`** (new) — Scoring engine
   - Input: clustered events, threat levels, CII scores, signal convergence, velocity/spike data
   - Output: `BookWorthinessScore` with recommended flavors
   - Criteria (see Phase 3 detail)

7. **`src/services/embed-bridge.ts`** (new) — postMessage bridge
   - Sends: selected events, book-worthiness scores, current filters, user selections
   - Receives: filter commands, highlight requests from Streamlit parent

8. **`api/book-request.js`** (new) — API endpoint for book request submission
   - Accepts: event data, selected flavor, user notes
   - Forwards to Codexes-Factory pipeline
   - Triggers iMessage notification (via Shortcuts/webhook)
   - Triggers Claude Code notification (via webhook/API)

9. **`package.json`** — Add `"dev:codexes"` and `"build:codexes"` scripts

10. **`vite.config.ts`** — Add codexes variant entry

### Phase 2: xcu_my_apps Streamlit Integration (external repo)

**Assumes xcu_my_apps is a Streamlit multi-page app. Files to create there:**

1. **`pages/world_monitor.py`** — Main page
   ```python
   import streamlit as st
   import streamlit.components.v1 as components

   st.set_page_config(layout="wide", page_title="World Monitor")

   # Sidebar: recency filter, book-worthiness threshold, flavor selector
   with st.sidebar:
       recency = st.selectbox("Time Range", ["1h", "6h", "24h", "3d", "7d"])
       min_score = st.slider("Min Book-Worthiness", 0, 100, 60)
       flavors = st.multiselect("Book Flavors", [
           "Lite Briefing",
           "Deep History/Background",
           "Deep Technical Background",
           "Executive Summary"
       ])

   # Embed WorldMonitor (codexes variant)
   components.iframe(
       f"https://worldmonitor.app?variant=codexes&recency={recency}",
       height=800, scrolling=True
   )
   ```

2. **`pages/book_request.py`** — Book request form page
   - Pre-populated from event selection in WorldMonitor
   - Fields: event summary, flavor selection, urgency, notes
   - Submit → calls book pipeline API
   - Confirmation with pipeline status

3. **`lib/worldmonitor_client.py`** — Python client for WorldMonitor API
   - Fetches current events, book-worthiness scores
   - Calls `/api/book-request` endpoint

4. **`lib/book_pipeline.py`** — Integration with Codexes2Gemini
   - Creates `PromptsPlan` from selected world event
   - Configures flavor-specific prompts (see Phase 4)
   - Launches `BuildLauncher` for generation

5. **`lib/notifications.py`** — iMessage + Claude Code notification
   - iMessage via macOS Shortcuts webhook or Pushover
   - Claude Code notification via webhook/API

### Phase 3: Book-Worthiness Scoring Algorithm

Score each clustered event 0-100 based on:

| Factor | Weight | Source |
|--------|--------|--------|
| Threat level (critical=100, high=75, med=50) | 25% | `threat-classifier.ts` |
| Source count / velocity (multi-source = higher) | 15% | `ClusteredEvent.sourceCount`, `velocity` |
| Signal convergence (multi-type signals in region) | 20% | `signal-aggregator.ts` convergenceScore |
| CII country spike (delta from baseline) | 15% | `country-instability.ts` |
| Trending spike magnitude | 10% | `trending-keywords.ts` |
| Category fit (conflict, disaster, diplomatic > general) | 10% | `EventCategory` |
| Recency boost (newer = higher) | 5% | `pubDate` |

**Flavor recommendations based on event characteristics:**

- **Lite Briefing** (all events scoring >60): 5-10 page quick overview
- **Deep History/Background** (diplomatic, conflict, long-running): Historical context, 50+ pages
- **Deep Technical Background** (cyber, infrastructure, tech, military): Technical analysis, 30-50 pages
- **Executive Summary** (high convergence, multi-signal): Decision-maker brief, 15-20 pages

### Phase 4: Book Flavors → Codexes2Gemini PromptsPlan Templates

Create four `PromptsPlan` templates:

1. **Lite Briefing**
   ```json
   {
     "plan_id": "worldmonitor-lite",
     "mode": "instant_book",
     "system_prompt": "You are a concise news briefing writer...",
     "user_prompt": "Create a 5-10 page briefing on: {event_summary}. Include: what happened, key actors, immediate implications, what to watch.",
     "minimum_required_output_tokens": 3000,
     "output_format": "ebook_pdf"
   }
   ```

2. **Deep History/Background**
   ```json
   {
     "plan_id": "worldmonitor-deep-history",
     "mode": "instant_book",
     "system_prompt": "You are a historian and geopolitical analyst...",
     "user_prompt": "Create a comprehensive background book on: {event_summary}. Include: historical roots (go back decades/centuries), key turning points, all major actors and their motivations, regional context, precedents, and future scenarios.",
     "minimum_required_output_tokens": 30000,
     "context_file_paths": ["{country_brief_json}", "{related_news_corpus}"],
     "output_format": "print_pdf"
   }
   ```

3. **Deep Technical Background**
   ```json
   {
     "plan_id": "worldmonitor-deep-tech",
     "mode": "instant_book",
     "system_prompt": "You are a technical analyst specializing in {category}...",
     "user_prompt": "Create a deep technical analysis of: {event_summary}. Include: technical details, infrastructure involved, capabilities assessment, threat modeling, technical implications, and expert recommendations.",
     "minimum_required_output_tokens": 20000,
     "output_format": "ebook_pdf"
   }
   ```

4. **Executive Summary**
   ```json
   {
     "plan_id": "worldmonitor-executive",
     "mode": "instant_book",
     "system_prompt": "You are a senior intelligence analyst writing for decision-makers...",
     "user_prompt": "Create an executive briefing on: {event_summary}. Include: bottom-line-up-front, situation overview, key signals and their convergence, risk assessment, recommended actions, and monitoring priorities.",
     "minimum_required_output_tokens": 10000,
     "output_format": "both"
   }
   ```

### Phase 5: Notification & Approval Pipeline

```
User submits book request form
        │
        ▼
  API /api/book-request
        │
        ├──► Store in pending_requests (Redis/Convex)
        │
        ├──► Send iMessage notification
        │    (via macOS Shortcuts URL scheme / Pushover / Twilio)
        │    "New book request: {event_title} - {flavor}"
        │
        └──► Send Claude Code webhook
             (POST to configured endpoint)
             "Review and approve: {request_id}"
                    │
                    ▼
         Fred reviews in Claude Code or iMessage
                    │
              ┌─────┴─────┐
              │ Approve    │ Reject
              ▼            ▼
     Call Codexes2Gemini   Update status
     BuildLauncher         Notify user
              │
              ▼
     Book generated
     (ebook + optional print PDF)
              │
              ▼
     Notify user via email/push
```

### Phase 6: Recency Filtering (Goal #3)

Extend the existing WorldMonitor filtering:

1. **`src/components/RecencyFilter.ts`** — Add a persistent filter bar (top of page or sidebar)
   - Time presets: Breaking (1h), Today (24h), This Week (7d), Custom range
   - Applies to: `allNews`, map event layers, insights, panels

2. **`src/app/data-loader.ts`** — Add `recencyFilter` to state; apply to `loadNews()`, `loadAllData()`

3. **`src/utils/recency.ts`** (new) — Utility functions
   - `filterByRecency(items: {pubDate: Date}[], range: string): items`
   - `getRecencyLabel(range: string): string`

4. **URL parameter**: `?recency=1h` — syncs with embed bridge for Streamlit control

---

## File Change Summary

### This repo (worldmonitor) — New files:
- `src/config/variants/codexes.ts`
- `src/components/BookWorthinessOverlay.ts`
- `src/components/RecencyFilter.ts`
- `src/services/book-worthiness.ts`
- `src/services/embed-bridge.ts`
- `src/utils/recency.ts`
- `api/book-request.js`

### This repo (worldmonitor) — Modified files:
- `src/config/variant.ts` (add 'codexes')
- `src/config/panels.ts` (add CODEXES_PANELS)
- `src/App.ts` (initialize RecencyFilter, BookWorthinessOverlay, embed bridge)
- `src/app/data-loader.ts` (recency filtering)
- `src/app/event-handlers.ts` (embed bridge message handling)
- `package.json` (new scripts)
- `vite.config.ts` (codexes variant)
- `vercel.json` (book-request API route)

### External (xcu_my_apps) — New files:
- `pages/world_monitor.py`
- `pages/book_request.py`
- `lib/worldmonitor_client.py`
- `lib/book_pipeline.py`
- `lib/notifications.py`
- `templates/prompt_plans/*.json` (4 flavor templates)

---

## Implementation Order

1. **Phase 1a**: RecencyFilter + recency utils (standalone value, no external deps)
2. **Phase 1b**: Book-worthiness scoring service (standalone value)
3. **Phase 1c**: Codexes variant + embed bridge
4. **Phase 2**: xcu_my_apps Streamlit pages (requires cloning that repo)
5. **Phase 3**: Book request API + notification pipeline
6. **Phase 4**: Codexes2Gemini PromptsPlan templates + BuildLauncher integration
7. **Phase 5**: End-to-end testing and polish

## Open Questions

1. **xcu_my_apps location**: Is this a private repo? Need access to clone and integrate.
2. **iMessage delivery**: Preferred method — macOS Shortcuts, Pushover, Twilio, or other?
3. **Book generation target**: Should books be generated locally or via codexes.xtuff.ai API?
4. **Authentication**: Does xcu_my_apps have auth? Should WorldMonitor embed require auth?
5. **Hosting**: Will the codexes variant deploy to a separate Vercel URL or same worldmonitor.app?
