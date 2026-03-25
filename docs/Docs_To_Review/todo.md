# World Monitor — Feature & Improvement Roadmap

Items are prefixed with `TODO-` and a three-digit number.
Priority: 🔴 High · 🟡 Medium · 🟢 Low.
Dependencies reference `BUG-` or other `TODO-` codes.

---

## 🔴 High Priority

### TODO-001 — Decompose `App.ts` into a Controller Architecture

| Field | Value |
|---|---|
| **Priority** | 🔴 High |
| **Effort** | ~2 days |
| **Depends on** | BUG-001 |

**Description**
Break the 4 357-line God-class into focused controllers:

- `DataLoader` — orchestrates all `fetch*` calls and refresh timers
- `PanelManager` — creates, orders, drags, and persists panel layout
- `MapController` — wraps `MapContainer`, handles layer toggles and country clicks
- `DeepLinkRouter` — handles URL state, story links, country brief links
- `RefreshScheduler` — manages `setInterval`/`setTimeout` lifecycle

Keep `App` as a thin composition root.

**AI instructions**

1. Create `src/controllers/` directory.
2. Move the corresponding `App` methods into each controller class.
3. Update `App` constructor and `init()` to instantiate and wire controllers.
4. Ensure `App.destroy()` delegates to each controller's `destroy()`.

---

### TODO-002 — Add Server-Side RSS Aggregation and Caching

| Field | Value |
|---|---|
| **Priority** | 🔴 High |
| **Effort** | ~3 days |
| **Depends on** | — |

**Description**
Currently 70+ RSS feeds are fetched client-side through individual proxy rules.
This wastes bandwidth (every user fetches the same feeds) and multiplies rate-limit exposure.

Move RSS fetching to a server-side edge function (or Vercel cron) that:

1. Fetches all feeds on a 3-minute cron.
2. Stores merged results in Redis (Upstash already in `package.json`).
3. Exposes a single `/api/news` endpoint returning the cached aggregate.

**AI instructions**
Create `api/news.js` edge function. Use `@upstash/redis`. Implement feed XML parsing identical to `src/services/rss.ts`. Add a `stale-while-revalidate` cache header. On the client side, replace ~40 proxy rules in `vite.config.ts` with a single fetch to `/api/news`.

---

### TODO-003 — Real-Time Alert Webhooks (Slack / Discord / Email)

| Field | Value |
|---|---|
| **Priority** | 🔴 High |
| **Effort** | ~2 days |
| **Depends on** | — |

**Description**
The dashboard generates high-value signals (military surge, CII spikes, geographic convergence) but they are only visible when the Dashboard tab is active.
Users should be able to receive critical alerts via external channels.

**AI instructions**

1. Add a Settings UI for webhook configuration (URL + secret + filter by priority).
2. Store webhook config in localStorage (web) or OS keyring (desktop).
3. When `signalAggregator` emits a signal at or above the user's threshold, POST the signal payload to the configured webhook URL.
4. Support Slack incoming webhook format and Discord webhook format out of the box.

---

### TODO-004 — Comprehensive API Handler Test Suite

| Field | Value |
|---|---|
| **Priority** | 🔴 High |
| **Effort** | ~2 days |
| **Depends on** | BUG-014 |

**Description**
52 of 55 API handlers have zero test coverage.
Add unit tests using Node built-in test runner (`node --test`) for all handlers.

**AI instructions**
For each handler in `api/`:

1. Import the handler and mock the external API call.
2. Test valid input → correct response.
3. Test malformed input → 400 error.
4. Test upstream failure → graceful error response.
Prioritize handlers that accept user-controlled query params.

---

### TODO-005 — Cross-Platform npm Script Compatibility

| Field | Value |
|---|---|
| **Priority** | 🔴 High |
| **Effort** | ~1 hour |
| **Depends on** | BUG-013, BUG-019 |

**Description**
All `VITE_VARIANT=…` and `VITE_E2E=…` scripts break on Windows.

**AI instructions**
Install `cross-env` as a devDependency.
Prefix every inline env-var assignment with `cross-env`, e.g.:
`"build:tech": "cross-env VITE_VARIANT=tech tsc && cross-env VITE_VARIANT=tech vite build"`.

---

## 🟡 Medium Priority

### TODO-006 — Temporal Anomaly Detection ("Unusual for This Time")

| Field | Value |
|---|---|
| **Priority** | 🟡 Medium |
| **Effort** | ~3 days |
| **Depends on** | — |

**Description**
Flag when activity deviates from time-of-day/week norms.
Example: "Military flights 3× normal for a Tuesday" or "News velocity spike at 3 AM UTC".

**AI instructions**

1. Extend `src/services/temporal-baseline.ts` to store per-hour-of-week baselines in IndexedDB.
2. Compare each refresh cycle's values against the time-matched baseline.
3. Generate `temporal_anomaly` signals when z-score > 2.0.
4. Display in the Signal Aggregator and Intelligence Findings badge.

---

### TODO-007 — Trade Route Risk Scoring

| Field | Value |
|---|---|
| **Priority** | 🟡 Medium |
| **Effort** | ~4 days |
| **Depends on** | — |

**Description**
Score major shipping routes based on chokepoint risk, AIS disruptions, and military posture along the route.

**AI instructions**

1. Define major trade routes in `src/config/trade-routes.ts`.
2. For each route, aggregate: chokepoint congestion, AIS gap count, military vessel density, recent news velocity for route countries.
3. Compute a composite risk score.
4. Display as a new panel and optionally overlay route lines on the map.

---

### TODO-008 — Choropleth CII Map Layer

| Field | Value |
|---|---|
| **Priority** | 🟡 Medium |
| **Effort** | ~2 days |
| **Depends on** | — |

**Description**
Overlay the map with country-colored fills based on CII score.

**AI instructions**

1. Use deck.gl's `GeoJsonLayer` with the existing country geometry from `src/services/country-geometry.ts`.
2. Map CII scores to a red-yellow-green color scale.
3. Add as a toggleable layer in the layer controls.
4. Update the legend to show the CII color scale.

---

### TODO-009 — Custom Country Watchlists (Tier 2 Monitoring)

| Field | Value |
|---|---|
| **Priority** | 🟡 Medium |
| **Effort** | ~2 days |
| **Depends on** | — |

**Description**
CII currently monitors 20 hardcoded Tier 1 countries.
Allow users to add custom countries to a Tier 2 watchlist with the same scoring pipeline.

**AI instructions**

1. Add a "+" button in the CII panel to search and add countries by name.
2. Store Tier 2 list in localStorage.
3. Run the same `calculateCII()` pipeline for Tier 2 countries (without conflict-zone floor scores).
4. Display Tier 2 countries in a collapsible sub-section of the CII panel.

---

### TODO-010 — Historical Playback with Timeline Scrubbing

| Field | Value |
|---|---|
| **Priority** | 🟡 Medium |
| **Effort** | ~3 days |
| **Depends on** | — |

**Description**
The snapshot system captures periodic state but playback is rudimentary.
Add a visual timeline scrubber to replay dashboard state over time.

**AI instructions**

1. Build a timeline UI component (`src/components/Timeline.ts`) showing dots for each stored snapshot (up to 7 days).
2. Clicking a dot restores that snapshot via `App.restoreSnapshot()`.
3. Dragging the scrubber auto-plays through snapshots.
4. Add a "Live" button to exit playback and resume real-time data.

---

### TODO-011 — Election Calendar Integration (Auto-Boost Sensitivity)

| Field | Value |
|---|---|
| **Priority** | 🟡 Medium |
| **Effort** | ~1 day |
| **Depends on** | — |

**Description**
Automatically boost CII sensitivity 30 days before major elections.

**AI instructions**

1. Create `src/config/elections.ts` with a calendar of upcoming elections (date, country code, type).
2. In `calculateCII()`, check if any monitored country has an election within 30 days.
3. If yes, apply a multiplier to the Information component (e.g., 1.3×).
4. Show an "🗳 Election Watch" badge on the CII panel for those countries.

---

### TODO-012 — News Translation Support (Localized Feeds)

| Field | Value |
|---|---|
| **Priority** | 🟡 Medium |
| **Effort** | ~3 days |
| **Depends on** | — |

**Description**
`docs/NEWS_TRANSLATION_ANALYSIS.md` already proposes a hybrid approach: localized feeds + on-demand LLM translation.

**AI instructions**

1. Restructure `src/config/feeds.ts` to support per-language URLs.
2. In `src/services/rss.ts`, select the URL matching `i18n.language`.
3. For feeds without a localized URL, add a "Translate" button per news card that calls `summarization.ts`.
4. Cache translations in a Map to avoid re-translation.

---

### TODO-013 — Map Popup Modularization

| Field | Value |
|---|---|
| **Priority** | 🟡 Medium |
| **Effort** | ~2 days |
| **Depends on** | BUG-016, BUG-020 |

**Description**
`MapPopup.ts` (113 KB) and `DeckGLMap.ts` (156 KB) are the two largest component files.
Split each into per-layer modules.

**AI instructions**

1. Create `src/components/popups/` directory.
2. Extract one file per popup type: `ConflictPopup.ts`, `MilitaryBasePopup.ts`, `VesselPopup.ts`, `AircraftPopup.ts`, etc.
3. Create a `PopupFactory.ts` dispatcher that selects the correct renderer by layer type.
4. Update `MapPopup.ts` to delegate to the factory.

---

### TODO-014 — ESLint + Prettier Setup

| Field | Value |
|---|---|
| **Priority** | 🟡 Medium |
| **Effort** | ~1 day |
| **Depends on** | — |

**Description**
The project has no linter or formatter configured.

**AI instructions**

1. Install ESLint with `@typescript-eslint` and a Prettier plugin.
2. Configure rules to match the project's style.
3. Add `lint` and `format` npm scripts.
4. Add a `lint-staged` + `husky` pre-commit hook.

---

### TODO-015 — Desktop Notification Support for Critical Signals

| Field | Value |
|---|---|
| **Priority** | 🟡 Medium |
| **Effort** | ~1 day |
| **Depends on** | — |

**Description**
Use the Web Notifications API (and Tauri's native notifications for desktop) to push critical signals when the tab is in the background.

**AI instructions**

1. Request notification permission on first critical signal.
2. When a signal with priority ≥ High is generated and the tab is hidden, show a native notification.
3. Clicking the notification focuses the tab and opens the Signal Modal.

---

### TODO-016 — Stablecoin De-peg Monitoring Enhancements

| Field | Value |
|---|---|
| **Priority** | 🟡 Medium |
| **Effort** | ~1 day |
| **Depends on** | — |

**Description**
The `StablecoinPanel` exists but lacks correlation with geopolitical events.

**AI instructions**

1. When a stablecoin deviates > 0.5% from peg, check if any CII country has a score > 70.
2. If correlated, generate a `stablecoin_depeg` signal.
3. Display in the Intelligence Findings badge.

---

## 🟢 Low Priority / Enhancements

### TODO-017 — Dark/Light Theme Toggle Improvements

| Field | Value |
|---|---|
| **Priority** | 🟢 Low |
| **Effort** | ~1 day |
| **Depends on** | — |

**Description**
Audit all CSS custom properties for light-theme counterparts. Ensure light mode is visually polished.

---

### TODO-018 — PWA Offline Dashboard State

| Field | Value |
|---|---|
| **Priority** | 🟢 Low |
| **Effort** | ~2 days |
| **Depends on** | — |

**Description**
Display the last snapshot data when offline with an "Offline — showing cached data" banner.

---

### TODO-019 — Accessibility (a11y) Audit

| Field | Value |
|---|---|
| **Priority** | 🟢 Low |
| **Effort** | ~3 days |
| **Depends on** | — |

**Description**
Add ARIA roles, labels, and keyboard navigation for panels, modals, and map controls.

---

### TODO-020 — UNHCR / World Bank / IMF Data Integration

| Field | Value |
|---|---|
| **Priority** | 🟢 Low |
| **Effort** | ~2 days per source |
| **Depends on** | — |

**Description**
Additional humanitarian and economic data sources to strengthen CII scoring.

---

### TODO-021 — Automated Visual Regression Testing CI

| Field | Value |
|---|---|
| **Priority** | 🟢 Low |
| **Effort** | ~1 day |
| **Depends on** | — |

**Description**
Add GitHub Actions workflow running visual snapshot tests on every PR.

---

### TODO-022 — Sentry Error Tracking Configuration

| Field | Value |
|---|---|
| **Priority** | 🟢 Low |
| **Effort** | ~2 hours |
| **Depends on** | — |

**Description**
Initialize Sentry in `src/main.ts` with DSN from environment variable.

---

### TODO-023 — Satellite Fire Detection Panel Enhancements

| Field | Value |
|---|---|
| **Priority** | 🟢 Low |
| **Effort** | ~1 day |
| **Depends on** | — |

**Description**
Correlate fires near military installations or critical infrastructure — generate `fire_near_infrastructure` signals.

---

### TODO-024 — Keyboard-Navigable Map with Focus Management

| Field | Value |
|---|---|
| **Priority** | 🟢 Low |
| **Effort** | ~2 days |
| **Depends on** | TODO-019 |

**Description**
Arrow keys for pan, `+`/`-` for zoom, `Tab` to cycle markers, `Enter` to open popup, `Escape` to close.

---

### TODO-025 — Data Export Improvements (Scheduled + API)

| Field | Value |
|---|---|
| **Priority** | 🟢 Low |
| **Effort** | ~2 days |
| **Depends on** | — |

**Description**
Add scheduled export and a public API endpoint for integration with external tools.

---

---

## UI / UX Improvements

> Items below are focused exclusively on visual design, interaction quality, layout, and user experience.

---

### TODO-026 — Panel Drag-and-Drop Reordering

- **Priority:** 🟡 Medium | **Effort:** ~1 day
- Users should be able to drag panels to reorder them. Persist order in localStorage. Show a subtle grab handle on hover.

### TODO-027 — Panel Resize Handles

- **Priority:** 🟡 Medium | **Effort:** ~1 day
- Add vertical resize handles to panels so users can allocate more height to the panels they care about. Store sizes in localStorage.

### TODO-028 — Collapsible Panel Groups

- **Priority:** 🟡 Medium | **Effort:** ~4 hours
- Group related panels (e.g., "Security", "Markets", "Intel") into collapsible accordion sections in the sidebar.

### TODO-029 — Panel Search / Quick Filter

- **Priority:** 🟡 Medium | **Effort:** ~4 hours
- Add a search input at the top of the panel list to filter panels by name. Useful when 30+ panels are enabled.

### TODO-030 — Multi-Column Panel Layout

- **Priority:** 🟡 Medium | **Effort:** ~1 day
- On ultra-wide monitors (>2560px), allow a 2- or 3-column panel layout instead of forcing a single column sidebar.

### TODO-031 — Panel Pinning ("Always on Top")

- **Priority:** 🟢 Low | **Effort:** ~4 hours
- Let users pin a panel so it stays visible at the top regardless of scroll position.

### TODO-032 — Panel Maximize / Full-Width View

- **Priority:** 🟡 Medium | **Effort:** ~4 hours
- Double-click a panel header to expand it to full-screen overlay. Press Escape to return to normal.

### TODO-033 — Animated Panel Transitions

- **Priority:** 🟢 Low | **Effort:** ~4 hours
- Add smooth CSS transitions (slide in, fade in) when panels are expanded/collapsed or reordered.

### TODO-034 — Panel Badge Animations

- **Priority:** 🟢 Low | **Effort:** ~2 hours
- When a panel receives new data, show a brief pulse animation on its badge count to draw attention.

### TODO-035 — Panel Data Age Indicator

- **Priority:** 🟡 Medium | **Effort:** ~4 hours
- Show a colored dot on each panel header: green = <1 min stale, yellow = 1–5 min, red = >5 min. Help users know which data is fresh.

### TODO-036 — Contextual Right-Click Menu on Panels

- **Priority:** 🟢 Low | **Effort:** ~4 hours
- Right-click a panel header to access: Pin, Maximize, Export Data, Refresh, Hide.

### TODO-037 — Floating Action Button (FAB) for Quick Actions

- **Priority:** 🟢 Low | **Effort:** ~4 hours
- Add a FAB in the bottom-right with quick actions: scroll to top, refresh all, toggle dark mode, open search.

### TODO-038 — Breadcrumb Navigation for Country Drill-Down

- **Priority:** 🟡 Medium | **Effort:** ~4 hours
- When in a Country Brief / Country Intel Modal, show breadcrumbs: `Dashboard > Middle East > Syria`. Clicking a breadcrumb navigates back.

### TODO-039 — Command Palette (Ctrl+K / ⌘K)

- **Priority:** 🔴 High | **Effort:** ~1 day
- Implement a Discord/VSCode-style command palette. Commands: "Go to country", "Toggle layer", "Open panel", "Export data", "Change language".

### TODO-040 — Global Keyboard Shortcuts Reference Sheet

- **Priority:** 🟢 Low | **Effort:** ~2 hours
- Press `?` to show a modal listing all available keyboard shortcuts. Include map controls, panel navigation, and search.

### TODO-041 — Toast Notification System

- **Priority:** 🟡 Medium | **Effort:** ~4 hours
- Replace inline status messages with a stacking toast system (bottom-right). Toast types: success (green), warning (amber), error (red), info (blue). Auto-dismiss after 5s.

### TODO-042 — Skeleton Loading Placeholders

- **Priority:** 🟡 Medium | **Effort:** ~1 day
- Replace "Loading…" text with animated skeleton placeholders (shimmer effect) in all panels. Matches modern dashboard UX standards.

### TODO-043 — Empty State Illustrations

- **Priority:** 🟡 Medium | **Effort:** ~1 day
- Add illustrated empty states to panels instead of plain "No data available" text. E.g., a calm globe for "No active sirens", a radar icon for "Scanning…".

### TODO-044 — News Card Redesign with Image Thumbnails

- **Priority:** 🟡 Medium | **Effort:** ~1 day
- Fetch og:image from news links and display as small thumbnails in the NewsPanel cards. Fallback to a gradient placeholder with the source favicon.

### TODO-045 — News Article Preview Modal

- **Priority:** 🟡 Medium | **Effort:** ~1 day
- Click a news item to see a summarized preview in a modal (using the existing summarization service) instead of opening the external link immediately.

### TODO-046 — News Sentiment Badge per Article

- **Priority:** 🟡 Medium | **Effort:** ~4 hours
- Show a tiny sentiment badge (🔴 negative, 🟡 neutral, 🟢 positive) on each news card derived from the entity-extraction service.

### TODO-047 — News Source Credibility Indicator

- **Priority:** 🟢 Low | **Effort:** ~4 hours
- Add a tiny icon on each news card indicating source reliability tier (Tier 1 / Tier 2 / Unknown). Based on a static config of known outlets.

### TODO-048 — News Read/Unread State

- **Priority:** 🟡 Medium | **Effort:** ~4 hours
- Track which news items the user has clicked/read. Display unread items with a bold title, read items with a muted style. Store in localStorage.

### TODO-049 — News Bookmark / Save for Later

- **Priority:** 🟢 Low | **Effort:** ~4 hours
- Add a bookmark icon on each news card. Bookmarked articles appear in a "Saved" tab within the NewsPanel.

### TODO-050 — Map Style Selector (Satellite / Dark / Light / Terrain)

- **Priority:** 🟡 Medium | **Effort:** ~4 hours
- Add a map style picker (bottom-left corner) with preview thumbnails for each style. Already have multiple map styles defined but no UI to switch.

### TODO-051 — Map Mini-Compass Widget

- **Priority:** 🟢 Low | **Effort:** ~2 hours
- Add a small compass rose to the map corner showing north orientation. Clicking resets rotation to north-up.

### TODO-052 — Map Ruler / Measurement Tool

- **Priority:** 🟢 Low | **Effort:** ~1 day
- Click two points on the map to measure distance (km/mi). Useful for assessing military range or event proximity.

### TODO-053 — Map Cluster Expansion Animation

- **Priority:** 🟢 Low | **Effort:** ~4 hours
- When clicking a cluster marker, animate the cluster expanding into individual markers with a spring/burst effect.

### TODO-054 — Map Heatmap Toggle for Event Density

- **Priority:** 🟡 Medium | **Effort:** ~1 day
- Add a heatmap view toggle that overlays event density (conflicts, protests, military activity) as a continuous gradient.

### TODO-055 — Map Layer Legend Panel

- **Priority:** 🟡 Medium | **Effort:** ~4 hours
- Show a collapsible legend in the bottom-left explaining all active layer symbols (conflict red dot, military blue triangle, etc.).

### TODO-056 — Map Geofence Alert Zones

- **Priority:** 🟡 Medium | **Effort:** ~2 days
- Let users draw a polygon on the map and get notified when any event (conflict, military, fire) occurs within that zone.

### TODO-057 — Map Screenshot / Export as Image

- **Priority:** 🟢 Low | **Effort:** ~4 hours
- Add a "Capture Map" button that exports the current map view + active layers as a high-resolution PNG.

### TODO-058 — Country Flag Icons in Panel Lists

- **Priority:** 🟢 Low | **Effort:** ~4 hours
- Show small country flag emojis/icons next to country names in CII, Displacement, UCDP, and other panels.

### TODO-059 — Country Quick Info Tooltip on Map Hover

- **Priority:** 🟡 Medium | **Effort:** ~4 hours
- Hovering over a country on the map shows a lightweight tooltip with: country name, CII score, active conflicts count, population.

### TODO-060 — Animated Number Counters on Panel Metrics

- **Priority:** 🟢 Low | **Effort:** ~2 hours
- When panel counts update (e.g., CII score changes from 65→72), animate the number transition with a counting-up effect.

### TODO-061 — Color-Coded Severity Levels Across All Panels

- **Priority:** 🟡 Medium | **Effort:** ~4 hours
- Standardize severity color coding across all panels: critical=red, high=orange, medium=yellow, low=blue, info=gray. Currently inconsistent.

### TODO-062 — Sparkline Mini-Charts in Panel Headers

- **Priority:** 🟡 Medium | **Effort:** ~1 day
- Add tiny inline sparkline charts next to panel count badges showing the metric's trend over the last 24 hours.

### TODO-063 — Panel Data Trend Arrows

- **Priority:** 🟡 Medium | **Effort:** ~2 hours
- Show ↑ or ↓ arrows next to panel counts indicating if the value has increased or decreased since last refresh.

### TODO-064 — Responsive Mobile Layout (Below 768px)

- **Priority:** 🔴 High | **Effort:** ~3 days
- Currently shows a MobileWarningModal. Instead, implement a responsive bottom-sheet layout with swipeable panels and a condensed header.

### TODO-065 — Tablet Layout (768px–1024px)

- **Priority:** 🟡 Medium | **Effort:** ~2 days
- Implement a split-view layout for tablets: panels on the left third, map on the right two-thirds. Touch-optimized controls.

### TODO-066 — Map Controls Touch Optimization

- **Priority:** 🟡 Medium | **Effort:** ~4 hours
- Increase hit areas for layer toggles and zoom buttons on touch devices. Add pinch-to-zoom and drag-to-pan gesture hints.

### TODO-067 — Swipe Gesture Navigation Between Panels (Mobile)

- **Priority:** 🟡 Medium | **Effort:** ~1 day
- On mobile, allow swiping left/right to navigate between panels instead of scrolling a long list.

### TODO-068 — Full-Screen Immersive Map Mode

- **Priority:** 🟡 Medium | **Effort:** ~4 hours
- Add a "Focus Mode" button that hides the header and sidebar, showing only the map with a floating minimal toolbar.

### TODO-069 — Map Auto-Focus on Critical Events

- **Priority:** 🟡 Medium | **Effort:** ~4 hours
- When a critical signal is detected (e.g., new military surge), optionally auto-pan the map to the event location with a brief highlighting animation.

### TODO-070 — Notification Center / Activity Feed

- **Priority:** 🟡 Medium | **Effort:** ~1 day
- Add a bell icon in the header that shows a chronological feed of all signals, alerts, and data updates with timestamps. Mark as read/unread.

### TODO-071 — User Onboarding Tour

- **Priority:** 🟡 Medium | **Effort:** ~1 day
- First-time users see a guided tour (tooltip sequence) explaining: map layers, panels, search, CII, signals, and keyboard shortcuts.

### TODO-072 — Settings Panel UI Redesign

- **Priority:** 🟡 Medium | **Effort:** ~1 day
- Group all configuration options into a clean modal with tabs: General, Appearance, Notifications, Data Sources, Map, Advanced.

### TODO-073 — Rich Tooltip System (Tippy.js-style)

- **Priority:** 🟡 Medium | **Effort:** ~4 hours
- Replace browser-native `title` attributes with styled tooltips that support HTML content, positioning, and animation.

### TODO-074 — Loading Progress Bar (Global)

- **Priority:** 🟡 Medium | **Effort:** ~2 hours
- Show a thin progress bar at the top of the viewport (YouTube-style) during initial data loading sequence.

### TODO-075 — Custom Accent Color Picker

- **Priority:** 🟢 Low | **Effort:** ~4 hours
- Let users pick a custom accent color (default: blue) that applies to buttons, links, active indicators, and chart highlights.

### TODO-076 — Font Size / Density Toggle

- **Priority:** 🟡 Medium | **Effort:** ~4 hours
- Add a "Compact / Default / Comfortable" density toggle affecting panel padding, font sizes, and row heights. Analysts on large monitors want compact; casual users want comfortable.

### TODO-077 — High-Contrast Mode

- **Priority:** 🟢 Low | **Effort:** ~4 hours
- Add an accessibility option for high-contrast mode with increased border weight, higher color contrast ratios, and no transparency.

### TODO-078 — Map Event Popup Redesign

- **Priority:** 🟡 Medium | **Effort:** ~1 day
- Redesign the map popup cards with a card-style layout: image/icon header, structured data rows, action buttons (zoom in, view country profile, share).

### TODO-079 — Sticky Panel Header on Scroll

- **Priority:** 🟢 Low | **Effort:** ~2 hours
- When scrolling within a long panel content area, keep the panel header sticky at the top so the title and controls remain visible.

### TODO-080 — CII Score Donut Chart Visualization

- **Priority:** 🟡 Medium | **Effort:** ~4 hours
- Render CII scores as animated donut/ring charts instead of plain numbers. Segments colored by component (conflict, economy, social, info).

### TODO-081 — Signal Timeline Visualization

- **Priority:** 🟡 Medium | **Effort:** ~1 day
- In the Signal Modal, add a horizontal timeline bar showing when each signal was generated over the last 24 hours. Cluster by type.

### TODO-082 — Country Intelligence Profile Page

- **Priority:** 🟡 Medium | **Effort:** ~2 days
- Expand CountryBriefPage with tabbed sections: Overview, CII Breakdown, News Feed, Military Activity, Economic Data, Climate Data.

### TODO-083 — Dark Map Popup Styling

- **Priority:** 🟢 Low | **Effort:** ~2 hours
- Ensure all map popups use the dark theme consistently — currently some popups have white backgrounds.

### TODO-084 — Animated Globe Spinner for Initial Load

- **Priority:** 🟢 Low | **Effort:** ~4 hours
- Replace the plain loading spinner with a slowly rotating wireframe globe animation during initial app bootstrap.

### TODO-085 — Panel Export as Image (PNG/SVG)

- **Priority:** 🟢 Low | **Effort:** ~4 hours
- Add an "Export as Image" button for each panel that renders the panel's current content as a downloadable PNG/SVG.

### TODO-086 — Strategic Posture Visual Indicators on Map

- **Priority:** 🟡 Medium | **Effort:** ~1 day
- Show colored region overlays or border highlights on the map for countries in the Strategic Posture analysis, colored by posture level.

### TODO-087 — News Panel Infinite Scroll

- **Priority:** 🟡 Medium | **Effort:** ~4 hours
- Replace the current page-based news list with infinite scroll. Load more items as the user scrolls down.

### TODO-088 — Economic Panel Mini-Chart Inline Rendering

- **Priority:** 🟡 Medium | **Effort:** ~1 day
- Render small inline area charts for economic indicators (GDP growth, inflation, unemployment) within the EconomicPanel rows.

### TODO-089 — Prediction Market Price Sparklines

- **Priority:** 🟡 Medium | **Effort:** ~4 hours
- Add tiny sparklines next to each prediction market entry in the PredictionPanel showing price movement over the last 7 days.

### TODO-090 — Stablecoin Panel Historical Chart

- **Priority:** 🟡 Medium | **Effort:** ~4 hours
- Add a small line chart at the bottom of the StablecoinPanel showing peg deviation over the last 30 days.

### TODO-091 — Panel Tab Navigation (Internal Sub-views)

- **Priority:** 🟡 Medium | **Effort:** ~4 hours
- For complex panels (Market, Economic, CII), add sub-tabs within the panel to organize content without needing to scroll.

### TODO-092 — Glassmorphism Panel Headers

- **Priority:** 🟢 Low | **Effort:** ~2 hours
- Apply a subtle frosted-glass/blur effect to panel headers (backdrop-filter: blur) for a modern look.

### TODO-093 — Map Layer Opacity Sliders

- **Priority:** 🟢 Low | **Effort:** ~4 hours
- In the layer control, add an opacity slider (0–100%) for each layer so users can see overlapping data more clearly.

### TODO-094 — Typewriter Effect for AI Insight Text

- **Priority:** 🟢 Low | **Effort:** ~2 hours
- When the InsightsPanel displays new AI-generated analysis, render it with a typewriter animation to feel more "live".

### TODO-095 — Interactive Tutorial for Map Layers

- **Priority:** 🟢 Low | **Effort:** ~1 day
- Click "?" next to each map layer toggle to show a brief explanation + sample screenshot of what that layer looks like.

### TODO-096 — Compact Header Mode for More Map Space

- **Priority:** 🟡 Medium | **Effort:** ~4 hours
- Add a toggle to collapse the header into a minimal single-line bar (logo + essential icons only). Gives ~40px more vertical map space.

### TODO-097 — Live News Panel Video Thumbnail Previews

- **Priority:** 🟢 Low | **Effort:** ~4 hours
- In the LiveNewsPanel, show a small preview thumbnail of the YouTube stream. Indicate "LIVE" with a pulsing red dot.

### TODO-098 — RTL Layout Full Audit

- **Priority:** 🟡 Medium | **Effort:** ~1 day
- Audit and fix all RTL layout issues for Arabic. Cover sidebar direction, panel alignment, table column order, and map control placement.

### TODO-099 — Customizable Dashboard Presets

- **Priority:** 🟢 Low | **Effort:** ~1 day
- Let users save and load named panel configurations: "DefCon View" (military + CII only), "Market Watch" (financial panels only), "Full Intel".

### TODO-100 — Story Share Card Redesign

- **Priority:** 🟢 Low | **Effort:** ~4 hours
- Redesign the `story-share.ts` OG card template with richer previews: map snapshot, event title, CII score, and World Monitor branding.

### TODO-101 — Multi-Event Comparison View

- **Priority:** 🟡 Medium | **Effort:** ~1 day
- Let users select 2–3 events and view them side-by-side in a split comparison modal with timestamps, locations, and severity.

### TODO-102 — Map Bookmark / Saved Views

- **Priority:** 🟢 Low | **Effort:** ~4 hours
- Save named map positions (lat/lon/zoom) for quick return: "Middle East Overview", "South China Sea", "Ukraine Front".

### TODO-103 — Country Flag Overlay on Map

- **Priority:** 🟢 Low | **Effort:** ~4 hours
- When zoomed to a specific country, show a faint country flag watermark behind the map data for quick identification.

### TODO-104 — Panel Content Text Selection + Copy

- **Priority:** 🟢 Low | **Effort:** ~2 hours
- Ensure all panel text content is selectable and copyable. Currently some panels prevent text selection via CSS.

### TODO-105 — CII Alert Sound Toggle

- **Priority:** 🟢 Low | **Effort:** ~2 hours
- Add an option (off by default) to play a subtle alert tone when a CII score crosses a critical threshold (e.g., >80).

### TODO-106 — Map Night/Day Terminator Line

- **Priority:** 🟢 Low | **Effort:** ~4 hours
- Overlay the day/night terminator line on the map, updating in real-time. Useful for military analysts assessing time-of-day context.

### TODO-107 — Map Clock Widget (Multi-Timezone)

- **Priority:** 🟢 Low | **Effort:** ~4 hours
- Show a small clock widget on the map displaying UTC + 2 user-selected timezones (e.g., Jerusalem, Washington DC).

### TODO-108 — Gradient Heat Indicator for CII Panel Rows

- **Priority:** 🟢 Low | **Effort:** ~2 hours
- Add a subtle gradient background to CII country rows coloring from green to red based on score. Makes it scannable at a glance.

### TODO-109 — Map Event Timeline Slider

- **Priority:** 🟡 Medium | **Effort:** ~1 day
- Add a time slider below the map to filter events by time range (last 1h, 6h, 24h, 7d). Slider updates all map layers.

### TODO-110 — Micro-Interaction: Panel Expand Ripple Effect

- **Priority:** 🟢 Low | **Effort:** ~1 hour
- Add a Material Design-style ripple effect when clicking panel headers to expand/collapse them.

### TODO-111 — Context Menu on Map Markers

- **Priority:** 🟢 Low | **Effort:** ~4 hours
- Right-click a map marker to access: "View details", "Show nearby events", "Center map here", "Add to watchlist".

### TODO-112 — Intelligence Briefing Auto-Summary

- **Priority:** 🟡 Medium | **Effort:** ~1 day
- Add a "Daily Briefing" button that auto-generates a 1-page markdown summary of the top signals, CII changes, and notable events from the last 24 hours.

### TODO-113 — Popover Quick Stats on Header Metrics

- **Priority:** 🟢 Low | **Effort:** ~4 hours
- Hovering over header metric counters (conflicts, flights, vessels) shows a popover with breakdown by region and trend.

### TODO-114 — Sidebar Width Adjustment

- **Priority:** 🟡 Medium | **Effort:** ~4 hours
- Add a draggable border between the sidebar and map that lets users adjust the sidebar width. Persist in localStorage.

### TODO-115 — Animated Data Flow Visualization on Map

- **Priority:** 🟢 Low | **Effort:** ~2 days
- Show animated dots flowing along trade routes, pipelines, and submarine cables on the map representing live data flow.

### TODO-116 — Regional Zoom Presets

- **Priority:** 🟢 Low | **Effort:** ~4 hours
- Add quick-zoom buttons for major regions: "Middle East", "Europe", "East Asia", "Global View". Each sets a predefined viewport.

### TODO-117 — Panel Grouping by Data Freshness

- **Priority:** 🟢 Low | **Effort:** ~4 hours
- Sort/group panels by which have the freshest data, showing the most recently updated panels at the top.

### TODO-118 — Inline Panel Help Text

- **Priority:** 🟢 Low | **Effort:** ~4 hours
- Add a collapsible "How to interpret" section inside each panel for first-time users explaining what the data means and why it matters.

### TODO-119 — Signal Priority Filter in Header

- **Priority:** 🟡 Medium | **Effort:** ~4 hours
- Add a dropdown filter next to the Intelligence Findings badge to filter signals by priority: Critical, High, Medium, Low, All.

### TODO-120 — Animated Map Marker Icons by Event Type

- **Priority:** 🟢 Low | **Effort:** ~4 hours
- Use animated SVG markers on the map: pulsing red for active conflicts, rotating for military flights, wave animation for naval vessels.

### TODO-121 — Country Timeline Panel

- **Priority:** 🟡 Medium | **Effort:** ~1 day
- Expand the existing CountryTimeline component into a full panel showing a vertical timeline of all events affecting a selected country.

### TODO-122 — Dashboard Snapshot Sharing via URL

- **Priority:** 🟡 Medium | **Effort:** ~1 day
- Generate a shareable URL that encodes the current map view, active layers, open panels, and selected country. Others can open the same view.

### TODO-123 — Accessibility: Color-Blind Safe Palette

- **Priority:** 🟢 Low | **Effort:** ~4 hours
- Add a color-blind-safe mode that replaces red/green severity indicators with blue/orange + patterns.

### TODO-124 — Panel Content Pagination

- **Priority:** 🟡 Medium | **Effort:** ~4 hours
- For panels with 100+ items (news, UCDP events), add proper pagination controls with page numbers instead of endless scrolling.

### TODO-125 — Map Drawing Tools (Annotations)

- **Priority:** 🟢 Low | **Effort:** ~2 days
- Let analysts draw circles, lines, and polygons on the map as temporary annotations. Options to label and color-code. Not persisted.

### TODO-126 — Quick Currency / Unit Converter Widget

- **Priority:** 🟢 Low | **Effort:** ~4 hours
- A small floating widget for converting between currencies, distances (km/mi), and populations. Useful when reading international data.

### TODO-127 — Panel Dependency Graph View

- **Priority:** 🟢 Low | **Effort:** ~1 day
- Add a "System View" that shows a node graph of how data flows between services and panels. Educational / debugging tool.

### TODO-128 — Map 3D Building Extrusion Mode

- **Priority:** 🟢 Low | **Effort:** ~4 hours
- When zoomed in to city level, toggle 3D building extrusions for spatial context. Already supported by deck.gl.

### TODO-129 — Hover Preview Cards for Map Markers

- **Priority:** 🟡 Medium | **Effort:** ~4 hours
- Hovering over a map marker shows a small preview card (type, title, severity). Clicking opens the full popup.

### TODO-130 — Event Sound Effects (Optional)

- **Priority:** 🟢 Low | **Effort:** ~2 hours
- Optional mode (off by default): play brief sound effects for different event types — siren for Oref, ping for new signal, etc.

### TODO-131 — Self-Hosted Map Tiles via Protomaps + CloudFront

- **Priority:** 🔴 High | **Effort:** ~2 days
- Replace CARTO/Stadia third-party basemap tiles with self-hosted Protomaps PMTiles on CloudFront. Eliminates CORS failures, third-party availability issues, and rate limits. CARTO has been intermittently blocking cross-origin requests (no `Access-Control-Allow-Origin` header), causing blank maps until the OpenFreeMap fallback kicks in. Self-hosted tiles = zero external dependency for the base map.
- **Approach:** Download a PMTiles archive (OpenStreetMap-based, ~70GB planet or extract regions), host on S3 + CloudFront CDN, use `pmtiles://` protocol with MapLibre GL JS. Style JSON also self-hosted.
- **References:** protomaps.com, github.com/protomaps/PMTiles
