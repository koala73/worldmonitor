---
noindex: true
---

# WorldMonitor news and maps in an MCP App

Issue #8741 is the news/map slice of epic #5198. The plugin mounts WorldMonitor's `NewsPanel`, `SearchModal`, and `MapContainer` with the dashboard styles. It does not implement a separate story-card design or generate another base map.

## Entry and data

`open_news_dashboard` advertises global and thread entrypoints using the pinned [OpenAI extension specification](https://github.com/openai/mcp-extensions/blob/93a30a92c1e520da18c4b05a29186ee7c48bc046/docs/spec.md). Empty arguments open the view. Initial feed data comes from that tool result; the view does not fetch the digest again on startup.

The tool uses the existing authenticated `list-feed-digest` endpoint for the full variant in English. All returned categories use the same item conversion as the website. The endpoint owns its existing 20-item category limit and coverage policy. The existing MCP dispatcher still owns authentication, entitlements, quota, and output budgets. Summary and translation use the existing `summarize-article` endpoint through `analyze_news_headlines`; credentials stay on the server.

The older `get_news_intelligence` tool and its summary widget remain available without changing their original contract.

## Slice inventory

| Action | Existing implementation | Plugin/assistant path |
|---|---|---|
| Browse news, source provenance, cluster details, sorting | `NewsPanel` | Actual component, fed by `open_news_dashboard` |
| Source and category selection | Existing feed categories and panel names | UI selectors and `apply_news_view` |
| Search and select an article | `SearchModal`, existing search index, `NewsPanel.scrollToNewsItem` | Search button or `apply_news_view.query`; `focus_news_article` selects the same snapshot item |
| Country context | Existing country geometry and country-mention matcher | Map country selection or `apply_news_view.country` |
| Time selection | Existing map time controls | UI or `apply_news_view.time_range` |
| Pan, zoom, country focus | `MapContainer` and its renderers | Map gestures or `apply_news_view` |
| Renderer selection | Existing 2D/3D controls and fallback policy | UI or `apply_news_view.renderer`; receipt includes the effective renderer |
| News locations | `MapContainer.setNewsLocations` | Uses only coordinates supplied by the digest; selecting an unlocated article reports `mapFocused: false` |
| Summary and translation | `NewsPanel`, existing news RPC | Authenticated MCP analysis call |
| Open article source | Existing attributed article link | `ui/open-link`; no credential-bearing navigation |
| Refresh | Existing digest endpoint | Host `tools/call`, with last rendered news retained on failure |

`apply_news_view` and `focus_news_article` are app-local tools advertised to capable hosts. View changes share the UI's implementation. Map operations wait for the existing viewport-settled contract before returning an applied receipt. Server entry results carry requested state, not a claim that a view was applied. Optional model-context updates contain the effective view.

The map uses the existing base maps and news locations only. Other domain-layer controls are hidden in this slice. Military, aviation, maritime, markets, infrastructure, climate, and all other domain layers remain under #5198. The existing SVG renderer intentionally omits news-location markers; it still supports map navigation and geographic focus. WebGL and globe retain their existing renderer and entitlement behavior.

## Packaging and sandbox

`npm run build:plugin` builds `plugin.html` independently into `dist/plugin`. Production `build:full` includes this step. A separate build prevents the dashboard's shared chunks from executing the full application bootstrap in the frame. It reuses source components rather than maintaining a UI copy.

`ui://worldmonitor/news-dashboard.html` reads the static build from the canonical origin, or the trusted Vercel deployment hostname for previews. Reads reject redirects, non-HTML/error pages, oversized documents, and missing plugin roots. Resource metadata declares the asset/base-map origins and base URI. Static plugin assets and public map data allow cross-origin reads. No nested website iframe or arbitrary request proxy is used.

MapLibre receives a plugin-only module-worker URL. A small data-URL bootstrap imports its bundled worker because Chromium blocks module workers created from opaque-origin blob URLs. The CSP declaration includes this requirement. News clustering reuses the existing synchronous algorithm over the endpoint's bounded category buckets; the website keeps its worker path.

## Verification and remaining acceptance

The browser regression builds the production artifact and renders it in a script-only, opaque sandbox with fixture data. It checks the actual panels, base map, MapLibre worker startup, search, source links, no duplicate initial data call, assistant/UI filter equivalence, denied-refresh retention, clearing filters, valid-empty data, and compact-screen overflow. Screenshots are fixture evidence, not evidence of a connected OpenAI host or live providers.

Focused API/resource tests check metadata, fixed-origin asset loading, size/error handling, authenticated endpoint use, and denial propagation. Website converter, panel, map, type, and import-boundary checks remain regression gates.

Actual OpenAI host installation, OAuth, negotiated CSP, app-local tool support, and live renderer/provider acceptance still require a configured development connection. The local fixture does not close those criteria. Full variant parity, live video news, account/settings workflows, and other domains remain epic work. Do not close #8741 or #5198 on local evidence alone.

## Test in ChatGPT

Follow [Build plugins](https://learn.chatgpt.com/docs/build-plugins) and the developer [connection and testing guide](https://developers.openai.com/plugins/deploy/connect-chatgpt). A production deployment is not required: a development HTTPS endpoint or Secure MCP Tunnel can expose the tested MCP server. UI assets must also be reachable by the host sandbox.

1. Inspect the development server's tools, schemas, authentication errors, and results with MCP Inspector.
2. Enable developer mode in ChatGPT's Security and login settings, subject to workspace policy. Add the endpoint or tunnel from Plugins and check discovery.
3. Start a fresh conversation with the connection enabled. Test the prompts below and record tool arguments, results, UI state, errors, host/version, commit, tier, renderer, and source coverage.
4. After changing metadata or UI resources, restart the server, refresh the connection, and use a fresh conversation.
5. Package and install the complete plugin through a local marketplace. Retest its skills and MCP tools together. Test Chat and Work separately when supported; record unavailable extension surfaces explicitly.

| Prompt or interaction | WorldMonitor acceptance |
|---|---|
| Open WorldMonitor news and maps | Actual news panels and map render; initial digest is not fetched twice |
| Show Reuters news from the last hour | Assistant filters and visible controls agree |
| Focus Germany; select another time range while it loads | Country focus completes without losing the later time selection |
| Search for energy, then select a returned article | Existing search opens; article and supplied location agree |
| Summarize this panel; open the article source | Analysis honors authentication; source opens through the host |
| Refresh after access expires | Useful denial; last loaded news stays visible |
| Select 2D and 3D | Effective renderer matches the receipt, including fallback |
| Show live aircraft in this news view | No claim that an excluded map layer was applied |

Record these as pending until exercised in the actual host. Screenshots from the fixture and green CI cannot substitute for host acceptance.
