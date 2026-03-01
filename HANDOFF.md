# xcu_my_apps Integration — Handoff Document

## What's Done (Phase 1: WorldMonitor-side)

All changes are on branch `claude/integrate-xcu-my-apps-lEcT1`, pushed to origin.

### New files
- `src/config/variants/codexes.ts` — Codexes variant config (clones full panels/layers, embed-friendly CSS class)
- `src/utils/recency.ts` — `filterByRecency()`, `parseRecencyParam()`, `RecencyRange` type, all range options
- `src/components/RecencyFilter.ts` — Chip-bar UI (1h/6h/24h/3d/7d/all), URL-synced, embed-bridge-aware
- `src/services/book-worthiness.ts` — Scoring engine (0-100) with 7 weighted factors; `rankBookWorthyEvents()` returns sorted candidates with flavor recommendations
- `src/services/embed-bridge.ts` — `embedBridge` singleton; postMessage protocol (`wm:` prefix); inbound: set-recency, set-min-score, highlight-event, request-state; outbound: ready, state-update, event-selected, book-worthy-events
- `api/book-request.js` — Edge function; POST body: `{title, flavor, score, eventId, ...}`; stores in Upstash Redis; fires webhook; returns `{requestId, status: 'pending'}`

### Modified files
- `src/config/variant.ts` — Added `'codexes'` to valid stored variants
- `src/config/panels.ts` — Added `'codexes'` to all full-variant panel category `variants` arrays; codexes falls through to FULL_PANELS in ternary chain
- `src/App.ts` — RecencyFilter mounted into header-bar; embedBridge initialized with callbacks; destroy cleanup; codexes added to trade-policy + intelligence refresh conditions
- `src/styles/panels.css` — `.recency-filter`, `.recency-chip`, `.variant-codexes` styles
- `package.json` — `dev:codexes`, `build:codexes` scripts
- `vite.config.ts` — `codexes` entry in VARIANT_META
- `vercel.json` — CSP `frame-ancestors` + `frame-src` allow `*.xtuff.ai` and `*.streamlit.app`; X-Frame-Options updated
- `api/_cors.js` — Added `*.xtuff.ai` and `*.streamlit.app` to CORS allowed origins

### Key types/exports to consume from Python side
```typescript
// Book flavors: 'lite-briefing' | 'deep-history' | 'deep-technical' | 'executive-summary'
// POST /api/book-request body:
{
  eventId: string, title: string, flavor: string, score: number,
  rationale?: string, notes?: string, category?: string,
  threatLevel?: string, sourceCount?: number, link?: string
}
// Embed bridge messages (parent → iframe):
{ type: 'wm:set-recency', range: '1h'|'6h'|'24h'|'3d'|'7d'|'all' }
{ type: 'wm:set-min-score', minScore: number }
{ type: 'wm:request-state' }
// Embed bridge messages (iframe → parent):
{ type: 'wm:ready', variant: 'codexes' }
{ type: 'wm:state-update', recency, minScore, totalEvents, bookWorthyCount }
{ type: 'wm:event-selected', event: {...}, worthiness: {...} }
{ type: 'wm:book-worthy-events', events: [{id, title, score, recommendedFlavors, rationale}] }
```

---

## What Remains

### Phase 2: xcu_my_apps Streamlit pages
Create in the **xcu_my_apps** repo:

1. **`pages/world_monitor.py`** — Main page embedding WorldMonitor via `st.components.iframe()`. Sidebar controls send postMessages to iframe (recency, min-score). Listens for `wm:event-selected` and `wm:book-worthy-events` to populate sidebar state.

2. **`pages/book_request.py`** — Book request form. Pre-populates from event selection. Fields: title, flavor (selectbox from 4 options), urgency, notes. Submit calls `POST /api/book-request` on worldmonitor.app.

3. **`lib/worldmonitor_client.py`** — Thin Python client wrapping the book-request API and any future endpoints.

### Phase 3: Codexes2Gemini integration
4. **`lib/book_pipeline.py`** — Creates `PromptsPlan` objects from event data + selected flavor. Four JSON templates in `templates/prompt_plans/`. Launches `BuildLauncher`.

5. **`templates/prompt_plans/`** — Four JSON PromptsPlan templates: `lite-briefing.json`, `deep-history.json`, `deep-technical.json`, `executive-summary.json`. Placeholder fields: `{event_summary}`, `{category}`, `{country_brief_json}`, `{related_news_corpus}`.

### Phase 4: Notification pipeline
6. **`lib/notifications.py`** — iMessage (via macOS Shortcuts webhook or Pushover) + Claude Code webhook. Triggered by book-request API webhook (`BOOK_REQUEST_WEBHOOK_URL` env var).

### Phase 5: End-to-end wiring
- RecencyFilter currently calls `loadAllData()` on change but doesn't yet pass the range into the data-loader's filtering pipeline. Wire `filterByRecency()` into `DataLoaderManager.loadNews()` using `recencyFilter.getRange()`.
- Book-worthiness scores are computed but not yet displayed in-app. Add a badge/overlay to clustered events in the live-news panel when score >= 60.
- Embed bridge `sendBookWorthyEvents()` should be called after each news load cycle.

### Environment variables needed
```
UPSTASH_REDIS_REST_URL    — for book-request persistence
UPSTASH_REDIS_REST_TOKEN  — for book-request persistence
BOOK_REQUEST_WEBHOOK_URL  — optional, for approval notifications
```

### Build/run commands
```bash
# WorldMonitor codexes variant
npm run dev:codexes       # local dev
npm run build:codexes     # production build

# xcu_my_apps (once pages are created)
streamlit run app.py
```
