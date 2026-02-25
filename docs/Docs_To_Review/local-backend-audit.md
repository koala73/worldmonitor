# Local backend parity matrix (desktop sidecar)

This matrix tracks desktop parity by mapping `src/services/*.ts` consumers to `api/*.js` handlers and classifying each feature as:

- **Fully local**: works from desktop sidecar without user credentials.
- **Requires user-provided API key**: local endpoint exists, but capability depends on configured secrets.
- **Requires cloud fallback**: sidecar exists, but operational behavior depends on a cloud relay path.

## Priority closure order

1. **Priority 1 (core panels + map):** LiveNewsPanel, MonitorPanel, StrategicRiskPanel, critical map layers.
2. **Priority 2 (intelligence continuity):** summaries and market panel.
3. **Priority 3 (enhancements):** enrichment and relay-dependent tracking extras.

## Feature parity matrix

| Priority | Feature / Panel | Service source(s) (`src/services/*.ts`) | API route(s) | API handler(s) (`api/*.js`) | Classification | Closure status |
|---|---|---|---|---|---|---|
| P1 | LiveNewsPanel | `src/services/live-news.ts` | `/api/youtube/live` | `api/youtube/live.js` | Fully local | ✅ Local endpoint available; channel-level video fallback already implemented. |
| P1 | MonitorPanel | _None (panel-local keyword matching)_ | _None_ | _None_ | Fully local | ✅ Client-side only (no backend dependency). |
| P1 | StrategicRiskPanel cached overlays | `src/services/cached-risk-scores.ts` | `/api/risk-scores` | `api/risk-scores.js` | Requires user-provided API key | ✅ Explicit fallback: panel continues with local aggregate scoring when cache feed is unavailable. |
| P1 | Map layers (conflicts, outages, AIS, military flights) | `src/services/conflicts.ts`, `src/services/outages.ts`, `src/services/ais.ts`, `src/services/military-flights.ts` | `/api/acled-conflict`, `/api/cloudflare-outages`, `/api/ais-snapshot`, `/api/opensky` | `api/acled-conflict.js`, `api/cloudflare-outages.js`, `api/ais-snapshot.js`, `api/opensky.js` | Requires user-provided API key | ✅ Explicit fallback: unavailable feeds are disabled while map rendering remains active for local/static layers. |
| P2 | Summaries | `src/services/summarization.ts` | `/api/groq-summarize`, `/api/openrouter-summarize` | `api/groq-summarize.js`, `api/openrouter-summarize.js` | Requires user-provided API key | ✅ Explicit fallback chain: Groq → OpenRouter → browser model. |
| P2 | MarketPanel | `src/services/markets.ts`, `src/services/polymarket.ts` | `/api/coingecko`, `/api/polymarket`, `/api/finnhub`, `/api/yahoo-finance` | `api/coingecko.js`, `api/polymarket.js`, `api/finnhub.js`, `api/yahoo-finance.js` | Fully local | ✅ Multi-provider and cache-aware fetch behavior maintained in sidecar mode. |
| P3 | Flight enrichment | `src/services/wingbits.ts` | `/api/wingbits` | `api/wingbits/[[...path]].js` | Requires user-provided API key | ✅ Explicit fallback: heuristic-only classification mode. |
| P3 | OpenSky relay fallback path | `src/services/military-flights.ts` | `/api/opensky` | `api/opensky.js` | Requires cloud fallback | ✅ Relay fallback documented; no hard failure when relay is unavailable. |

## Non-parity closure actions completed

- Added **desktop readiness + non-parity fallback visibility** in `ServiceStatusPanel` so operators can see acceptance status and per-feature fallback behavior in desktop runtime.
- Kept local-sidecar strategy as the default path: desktop sidecar executes `api/*.js` handlers locally and only uses cloud fallback when handler execution or relay path fails.

## Desktop-ready acceptance criteria

A desktop build is considered **ready** when all checks below are green:

1. **Startup:** app launches and local sidecar health reports enabled.
2. **Map rendering:** map loads with local/static layers even when optional feeds are unavailable.
3. **Core intelligence panels:** LiveNewsPanel, MonitorPanel, StrategicRiskPanel render without fatal errors.
4. **Summaries:** at least one summary path works (provider-backed or browser fallback).
5. **Market panel:** panel renders and returns data from at least one market provider.
6. **Live tracking:** at least one live mode (AIS or OpenSky) is available.

These checks are now surfaced in the Service Status UI as “Desktop readiness”.
