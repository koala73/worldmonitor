// MCP Apps (extension `io.modelcontextprotocol/ui`, spec 2026-01-26) — the
// `ui://` resource registry. These are the interactive in-conversation app
// shells an MCP-Apps host renders inline; a tool links to one via
// `_meta.ui.resourceUri` (emitted by buildPublicTool from the tool's
// internal `_uiResourceUri`).
//
// How this differs from the DATA resources in ../resources/index.ts:
//   - DATA resources (worldmonitor://…) return live JSON and consume the Pro
//     daily quota symmetrically with the equivalent tools/call.
//   - UI resources (ui://…) return a STATIC, data-free HTML template. They
//     carry no data and spend no quota, so resources/read of a ui:// URI is
//     served on the anonymous discovery path (an MCP-Apps host — or an
//     agent-readiness scanner — must be able to fetch the shell to render
//     it). Live data reaches the shell later, via host postMessage after a
//     normal gated tools/call. See the handler's resources/read gate.
//
// The MCP-Apps UI resource mimeType is EXACTLY `text/html;profile=mcp-app`
// (the extension's content profile) — NOT `text/html+skybridge` (that is the
// OpenAI Apps SDK's marker).

import { rpcError, rpcOk } from '../rpc';
import { CHOKEPOINT_MONITOR_APP_HTML } from './chokepoint-monitor-app';
import { COUNTRY_BRIEF_APP_HTML } from './country-brief-app';
import { COUNTRY_RISK_APP_HTML } from './country-risk-app';
import { MARKET_RADAR_APP_HTML } from './market-radar-app';
import { buildUiMeta, UI_RESOURCE_MIME_TYPE as SHELL_UI_MIME_TYPE, type UiResourceMeta } from './shell';
import { WORLD_BRIEF_APP_HTML } from './world-brief-app';
import { NEWS_INTELLIGENCE_APP_HTML } from './news-intelligence-app';
import { CONFLICT_EVENTS_APP_HTML } from './conflict-events-app';
import { NATURAL_DISASTERS_APP_HTML } from './natural-disasters-app';
import { PREDICTION_MARKETS_APP_HTML } from './prediction-markets-app';
import { FORECASTS_APP_HTML } from './forecasts-app';

// Re-exported from the shared shell so the mimeType has a single source of
// truth across the fleet (the first widget defined it here in v1.11.0).
export const UI_RESOURCE_MIME_TYPE = SHELL_UI_MIME_TYPE;

// Canonical ui:// URIs for each app shell. Each is imported by its backing tool
// def as the single-source-of-truth `_uiResourceUri`, so the tool linkage and
// the registered resource can never drift.
export const COUNTRY_RISK_UI_URI = 'ui://worldmonitor/country-risk.html';
export const WORLD_BRIEF_UI_URI = 'ui://worldmonitor/world-brief.html';
export const COUNTRY_BRIEF_UI_URI = 'ui://worldmonitor/country-brief.html';
export const MARKET_RADAR_UI_URI = 'ui://worldmonitor/market-radar.html';
export const CHOKEPOINT_MONITOR_UI_URI = 'ui://worldmonitor/chokepoint-monitor.html';
export const NEWS_INTELLIGENCE_UI_URI = 'ui://worldmonitor/news-intelligence.html';
export const CONFLICT_EVENTS_UI_URI = 'ui://worldmonitor/conflict-events.html';
export const NATURAL_DISASTERS_UI_URI = 'ui://worldmonitor/natural-disasters.html';
export const PREDICTION_MARKETS_UI_URI = 'ui://worldmonitor/prediction-markets.html';
export const FORECASTS_UI_URI = 'ui://worldmonitor/forecasts.html';

// Per-resource `_meta.ui` (ext-apps `UIResourceMeta`) is built by the shared
// `buildUiMeta()` in ./shell — SINGLE source of truth for the fleet's CSP /
// render policy. The `csp` block is the spec-native complement to the HTML
// `<meta http-equiv>` CSP: `connectDomains` mirrors the meta's `connect-src`
// (the MCP server origin); `resourceDomains` / `frameDomains` / `baseUriDomains`
// stay empty (the secure default) because the apps load no external assets,
// embed no frames, and need no external base URI (postMessage + inline CSS/JS
// only). `prefersBorder` asks the host to frame the card. A fresh object is
// minted per entry so a mutating consumer can't poison siblings. Surfaced on
// BOTH resources/list and the resources/read response.
export type { UiResourceMeta };

interface UiResourceDef {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  _meta: UiResourceMeta;
  // The verbatim self-contained HTML served on resources/read.
  html: string;
}

export const UI_RESOURCE_REGISTRY: UiResourceDef[] = [
  {
    uri: COUNTRY_RISK_UI_URI,
    name: 'Country Risk (interactive)',
    description:
      'Interactive in-conversation app shell for get_country_risk: renders the Composite Instability Index (CII 0-100), the unrest/conflict/security/news component breakdown, travel-advisory level, and sanctions exposure. Linked from the get_country_risk tool via _meta.ui.resourceUri; an MCP-Apps host renders it inline and streams the tool result in via postMessage. Static, data-free template — public and quota-exempt.',
    mimeType: UI_RESOURCE_MIME_TYPE,
    _meta: buildUiMeta(),
    html: COUNTRY_RISK_APP_HTML,
  },
  {
    uri: WORLD_BRIEF_UI_URI,
    name: 'World Brief (interactive)',
    description:
      'Interactive in-conversation app shell for get_world_brief: renders the AI-summarised global intelligence brief as readable paragraphs, the grounding headlines, and the source feed articles. Linked from the get_world_brief tool via _meta.ui.resourceUri; an MCP-Apps host renders it inline and streams the tool result in via postMessage. Static, data-free template — public and quota-exempt.',
    mimeType: UI_RESOURCE_MIME_TYPE,
    _meta: buildUiMeta(),
    html: WORLD_BRIEF_APP_HTML,
  },
  {
    uri: COUNTRY_BRIEF_UI_URI,
    name: 'Country Brief (interactive)',
    description:
      'Interactive in-conversation app shell for get_country_brief: renders the AI-synthesised per-country intelligence brief as paragraphs, the analytical framework lens, and the grounding sources. Linked from the get_country_brief tool via _meta.ui.resourceUri; an MCP-Apps host renders it inline and streams the tool result in via postMessage. Static, data-free template — public and quota-exempt.',
    mimeType: UI_RESOURCE_MIME_TYPE,
    _meta: buildUiMeta(),
    html: COUNTRY_BRIEF_APP_HTML,
  },
  {
    uri: MARKET_RADAR_UI_URI,
    name: 'Market Radar (interactive)',
    description:
      'Interactive in-conversation app shell for get_market_data: renders the Fear & Greed composite plus per-asset-class quote tables (equities, commodities, crypto, Gulf, sectors) with signed, colour-coded change. Linked from the get_market_data tool via _meta.ui.resourceUri; an MCP-Apps host renders it inline and streams the tool result in via postMessage. Static, data-free template — public and quota-exempt.',
    mimeType: UI_RESOURCE_MIME_TYPE,
    _meta: buildUiMeta(),
    html: MARKET_RADAR_APP_HTML,
  },
  {
    uri: CHOKEPOINT_MONITOR_UI_URI,
    name: 'Chokepoint Monitor (interactive)',
    description:
      'Interactive in-conversation app shell for get_chokepoint_status: renders per-chokepoint rolling transit summaries (today\'s transit count, week-over-week change, tanker split) with a risk-level badge. Linked from the get_chokepoint_status tool via _meta.ui.resourceUri; an MCP-Apps host renders it inline and streams the tool result in via postMessage. Static, data-free template — public and quota-exempt.',
    mimeType: UI_RESOURCE_MIME_TYPE,
    _meta: buildUiMeta(),
    html: CHOKEPOINT_MONITOR_APP_HTML,
  },
  {
    uri: NEWS_INTELLIGENCE_UI_URI,
    name: 'News Intelligence (interactive)',
    description:
      'Interactive in-conversation app shell for get_news_intelligence: renders AI-classified top stories (title, category, alert flag, country, source) from WorldMonitor\'s intelligence layer. Linked from the get_news_intelligence tool via _meta.ui.resourceUri; an MCP-Apps host renders it inline and streams the tool result in via postMessage. Static, data-free template — public and quota-exempt.',
    mimeType: UI_RESOURCE_MIME_TYPE,
    _meta: buildUiMeta(),
    html: NEWS_INTELLIGENCE_APP_HTML,
  },
  {
    uri: CONFLICT_EVENTS_UI_URI,
    name: 'Conflict Events (interactive)',
    description:
      'Interactive in-conversation app shell for get_conflict_events: renders active armed-conflict events (belligerents, violence type, country, fatalities, date) from the UCDP feed. Linked from the get_conflict_events tool via _meta.ui.resourceUri; an MCP-Apps host renders it inline and streams the tool result in via postMessage. Static, data-free template — public and quota-exempt.',
    mimeType: UI_RESOURCE_MIME_TYPE,
    _meta: buildUiMeta(),
    html: CONFLICT_EVENTS_APP_HTML,
  },
  {
    uri: NATURAL_DISASTERS_UI_URI,
    name: 'Natural Disasters (interactive)',
    description:
      'Interactive in-conversation app shell for get_natural_disasters: groups recent earthquakes (USGS magnitude, place, time) and active wildfires (NASA FIRMS). Linked from the get_natural_disasters tool via _meta.ui.resourceUri; an MCP-Apps host renders it inline and streams the tool result in via postMessage. Static, data-free template — public and quota-exempt.',
    mimeType: UI_RESOURCE_MIME_TYPE,
    _meta: buildUiMeta(),
    html: NATURAL_DISASTERS_APP_HTML,
  },
  {
    uri: PREDICTION_MARKETS_UI_URI,
    name: 'Prediction Markets (interactive)',
    description:
      'Interactive in-conversation app shell for get_prediction_markets: renders active event-contract odds grouped by category (geopolitical, tech, finance) with a probability bar per market. Linked from the get_prediction_markets tool via _meta.ui.resourceUri; an MCP-Apps host renders it inline and streams the tool result in via postMessage. Static, data-free template — public and quota-exempt.',
    mimeType: UI_RESOURCE_MIME_TYPE,
    _meta: buildUiMeta(),
    html: PREDICTION_MARKETS_APP_HTML,
  },
  {
    uri: FORECASTS_UI_URI,
    name: 'Forecasts (interactive)',
    description:
      'Interactive in-conversation app shell for get_forecast_predictions: renders WorldMonitor\'s AI-generated geopolitical and economic forecasts as probability cards (title, domain, region). Linked from the get_forecast_predictions tool via _meta.ui.resourceUri; an MCP-Apps host renders it inline and streams the tool result in via postMessage. Static, data-free template — public and quota-exempt.',
    mimeType: UI_RESOURCE_MIME_TYPE,
    _meta: buildUiMeta(),
    html: FORECASTS_APP_HTML,
  },
];

// Fast membership set for the handler's gate promotion + parsing.
const UI_RESOURCE_BY_URI = new Map(UI_RESOURCE_REGISTRY.map((r) => [r.uri, r]));

export function isUiResourceUri(uri: string): boolean {
  return UI_RESOURCE_BY_URI.has(uri);
}

// resources/list public shape — {uri, name, description, mimeType} plus the
// spec `_meta.ui` (CSP + render prefs) so a host learns the view policy at
// discovery time. The internal `html` field never leaks.
export interface PublicUiResourceShape {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  _meta: UiResourceMeta;
}

export const UI_RESOURCE_LIST_RESPONSE: PublicUiResourceShape[] = UI_RESOURCE_REGISTRY.map((r) => ({
  uri: r.uri,
  name: r.name,
  description: r.description,
  mimeType: r.mimeType,
  _meta: r._meta,
}));

// resources/read responder for a ui:// URI. Returns the static HTML verbatim
// as a spec-shaped resources/read result. No auth context, no dispatch, no
// quota — the caller (handler) has already resolved that this URI is a public
// UI resource via isUiResourceUri().
export function buildUiResourceRead(
  id: unknown,
  uri: string,
  corsHeaders: Record<string, string>,
): Response {
  const def = UI_RESOURCE_BY_URI.get(uri);
  if (!def) {
    // Unreachable in practice — the handler only routes here after
    // isUiResourceUri(uri) is true — but fail closed with a spec -32602.
    return rpcError(id, -32602, `Unknown ui:// resource "${uri}".`, corsHeaders);
  }
  return rpcOk(
    id,
    { contents: [{ uri: def.uri, mimeType: def.mimeType, text: def.html, _meta: def._meta }] },
    corsHeaders,
  );
}
