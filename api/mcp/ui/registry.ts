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
import { COUNTRY_RISK_APP_HTML } from './country-risk-app';

export const UI_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';

// Canonical ui:// URI for the country-risk app shell. Imported by the
// get_country_risk tool def as its single-source-of-truth `_uiResourceUri`,
// so the tool linkage and the registered resource can never drift.
export const COUNTRY_RISK_UI_URI = 'ui://worldmonitor/country-risk.html';

// Per-resource `_meta.ui` (ext-apps `UIResourceMeta`). The `csp` block is the
// spec-native complement to the HTML `<meta http-equiv>` CSP: it declares which
// external origins the view needs so the HOST can enforce an iframe CSP. It is
// kept CONSISTENT with the HTML meta: `connectDomains` mirrors the meta's
// `connect-src` (the MCP server origin — the app's data ultimately originates
// there); `resourceDomains` / `frameDomains` / `baseUriDomains` stay empty (the
// secure default) because the app loads no external assets, embeds no frames,
// and needs no external base URI (postMessage only, inline CSS/JS). `prefersBorder`
// asks the host to frame the card. Surfaced on BOTH resources/list and the
// resources/read response so a host learns the policy at discovery time.
export interface UiResourceMeta {
  ui: {
    csp: {
      connectDomains: string[];
      resourceDomains: string[];
      frameDomains: string[];
      baseUriDomains: string[];
    };
    prefersBorder: boolean;
  };
}

const COUNTRY_RISK_UI_META: UiResourceMeta = {
  ui: {
    csp: {
      // Mirrors the HTML meta CSP's connect-src (the MCP server origin).
      connectDomains: ['https://worldmonitor.app', 'https://www.worldmonitor.app'],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    },
    prefersBorder: true,
  },
};

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
    _meta: COUNTRY_RISK_UI_META,
    html: COUNTRY_RISK_APP_HTML,
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
