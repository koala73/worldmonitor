// MCP Apps (extension `io.modelcontextprotocol/ui`, spec 2026-01-26) — the
// SHARED app-shell foundation for the WorldMonitor interactive-dashboard fleet.
//
// The first shipped widget (get_country_risk, v1.11.0) inlined its whole HTML —
// DOCTYPE, CSP, dark-mode CSS vars, and the ~150-line postMessage bridge — in
// api/mcp/ui/country-risk-app.ts. That file stays as the reference widget; this
// module factors the parts that MUST be identical across every widget (the
// bridge protocol, the 4-category CSP, uppercase DOCTYPE + color-scheme meta,
// the dark-mode theme handling, and the size-reporting handshake) into one
// `buildAppHtml` builder so the fleet can't drift on the orank quality/CSP
// signals a scanner reads statically off each served shell.
//
// Bridge protocol (raw JSON-RPC 2.0 over `window.postMessage(msg, "*")`, no
// envelope), per the extension — identical to the country-risk reference:
//   View → Host  request : `ui/initialize` {appInfo, appCapabilities, protocolVersion}
//   Host → View  result  : {hostCapabilities, hostInfo, hostContext}
//   View → Host  notify  : `ui/notifications/initialized`
//   Host → View  notify  : `ui/notifications/tool-input`  {arguments}
//   Host → View  notify  : `ui/notifications/tool-result` (a CallToolResult)
//   View → Host  notify  : `ui/notifications/size-changed` {height}
//
// Incoming messages are gated on `event.source === window.parent` — the sandbox
// origin is opaque ("null"), so a source-identity check is the available trust
// boundary. Rendering ALWAYS uses `textContent` / numeric coercion (never
// innerHTML), so a hostile tool payload cannot inject markup.
//
// Authoring constraint: each widget's `styles`, `body`, and `renderBody` are
// interpolated into the outer template below. The SHARED bridge carries no
// `${` sequences; per-widget `renderBody` strings must likewise avoid backticks
// and `${` so the outer TS template literal stays un-escaped.

export const UI_PROTOCOL_VERSION = '2026-01-26';

// The MCP-Apps UI resource mimeType is EXACTLY `text/html;profile=mcp-app` (the
// extension's content profile) — NOT `text/html+skybridge` (OpenAI Apps SDK).
export const UI_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';

// The MCP server origin(s) the views connect back to. Mirrored into BOTH the
// HTML `<meta http-equiv>` CSP connect-src and the spec-native
// `_meta.ui.csp.connectDomains` so a host learns the identical policy two ways.
export const UI_CONNECT_DOMAINS = ['https://worldmonitor.app', 'https://www.worldmonitor.app'] as const;

// The agent hosts allowed to embed a shell (advisory in a <meta> CSP — browsers
// honor frame-ancestors only via HTTP header — but the static scanner reads it
// here, and it documents intent).
const UI_FRAME_ANCESTORS = ['https://chatgpt.com', 'https://claude.ai', 'https://claude.com'] as const;

// Per-resource `_meta.ui` (ext-apps `UIResourceMeta`). `connectDomains` mirrors
// the HTML meta's connect-src (the MCP server origin — the app's data ultimately
// originates there); the other allowlists stay empty (the secure default) because
// every widget loads no external assets, embeds no frames, and needs no external
// base URI (postMessage + inline CSS/JS only). `prefersBorder` asks the host to
// frame the card.
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

// SINGLE source of truth for every widget's `_meta.ui` — shared so the fleet's
// CSP policy can't drift entry-to-entry. Returns a fresh object per call so a
// mutating consumer can't poison siblings.
export function buildUiMeta(): UiResourceMeta {
  return {
    ui: {
      csp: {
        connectDomains: [...UI_CONNECT_DOMAINS],
        resourceDomains: [],
        frameDomains: [],
        baseUriDomains: [],
      },
      prefersBorder: true,
    },
  };
}

// The 4-category CSP shared by every shell. default-src 'none' earns full orank
// credit over a permissive default; script/style-src 'unsafe-inline' keeps the
// inline bridge + styles working; connect-src pins the MCP origin; frame-ancestors
// allowlists the embedding agent hosts; form-action + base-uri are locked.
const SHARED_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self' " + UI_CONNECT_DOMAINS.join(' ') + '; ' +
  'frame-ancestors ' + UI_FRAME_ANCESTORS.join(' ') + "; form-action 'none'; base-uri 'none'";

// The shared dark-mode design tokens every widget inherits. A widget's own
// `styles` block is appended AFTER these, so it can add component styles and
// override any token.
const SHARED_STYLE_TOKENS = `
  :root {
    --bg: #ffffff; --fg: #0f172a; --muted: #64748b; --card: #f8fafc;
    --border: #e2e8f0; --accent: #2563eb;
    --low: #16a34a; --moderate: #ca8a04; --high: #ea580c; --severe: #dc2626;
    --up: #16a34a; --down: #dc2626;
  }
  [data-theme="dark"] {
    --bg: #0b1220; --fg: #e5e7eb; --muted: #94a3b8; --card: #131c2e;
    --border: #1e293b; --accent: #60a5fa;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .wrap { padding: 16px; max-width: 560px; }
  .head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .title { font-size: 20px; font-weight: 650; letter-spacing: 0.2px; }
  .badge { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
  .empty { color: var(--muted); padding: 8px 0; }
  .foot { margin-top: 14px; font-size: 11px; color: var(--muted); }
  a { color: var(--accent); text-decoration: none; }
`;

// The shared bridge + helper library. Injected once per shell. It exposes a
// small helper set (q/num/clampPct/pctText/setText/el/cssVar) in closure scope
// that a widget's `renderBody` uses, then calls the widget-defined
// `renderData(data)` on every tool-result. NOTE: no `${` / backtick here.
const SHARED_BRIDGE_HEAD = `
(function () {
  "use strict";
  var parentWin = window.parent;

  function post(msg) {
    try { parentWin.postMessage(msg, "*"); } catch (e) { /* host gone */ }
  }
  function notify(method, params) {
    post({ jsonrpc: "2.0", method: method, params: params || {} });
  }

  // ---- shared render helpers (widget renderBody uses these) ----
  function q(id) { return document.getElementById(id); }
  function num(v) { var n = typeof v === "number" ? v : Number(v); return isFinite(n) ? n : null; }
  function clampPct(n) { return Math.max(0, Math.min(100, n)); }
  function setText(id, text) { var e = q(id); if (e) e.textContent = text == null ? "—" : String(text); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  function pctText(v) {
    var n = num(v);
    if (n == null) return "—";
    return (n > 0 ? "+" : "") + n.toFixed(2) + "%";
  }
  function levelFor(score) {
    if (typeof score !== "number" || isNaN(score)) return { label: "Unknown", varName: "--muted" };
    if (score >= 75) return { label: "Severe", varName: "--severe" };
    if (score >= 50) return { label: "High", varName: "--high" };
    if (score >= 25) return { label: "Moderate", varName: "--moderate" };
    return { label: "Low", varName: "--low" };
  }
  // Text helpers centralised here so widget renderBody stays regex/escape-free.
  function collapseWs(s) { return String(s == null ? "" : s).replace(/\\s+/g, " ").trim(); }
  function paragraphs(s) {
    return String(s == null ? "" : s)
      .split(/\\n\\s*\\n/)
      .map(function (p) { return collapseWs(p); })
      .filter(Boolean);
  }
  function httpUrl(u) {
    if (typeof u !== "string") return "";
    try {
      var parsed = new URL(u.trim());
      return (parsed.protocol === "http:" || parsed.protocol === "https:") ? parsed.href : "";
    } catch (e) { return ""; }
  }
  function countryName(code) {
    var c = String(code == null ? "" : code).toUpperCase().slice(0, 2);
    if (!c) return "";
    try {
      var n = new Intl.DisplayNames(["en"], { type: "region" }).of(c);
      return n || c;
    } catch (e) { return c; }
  }

  function reportSize() {
    var root = q("root");
    if (!root) return;
    var h = Math.ceil(root.getBoundingClientRect().height) + 8;
    notify("ui/notifications/size-changed", { height: h });
  }

  function extractToolData(result) {
    if (!result || typeof result !== "object") return null;
    if (result.structuredContent && typeof result.structuredContent === "object") {
      return result.structuredContent;
    }
    if (Array.isArray(result.content)) {
      for (var i = 0; i < result.content.length; i++) {
        var c = result.content[i];
        if (c && c.type === "text" && typeof c.text === "string") {
          try { return JSON.parse(c.text); } catch (e) { /* not JSON */ }
        }
      }
    }
    return null;
  }

  function applyTheme(hostContext) {
    var theme = hostContext && hostContext.theme;
    if (theme === "dark" || theme === "light") {
      document.documentElement.setAttribute("data-theme", theme);
    } else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
      document.documentElement.setAttribute("data-theme", "dark");
    }
  }

  // Soft-error envelopes are SUCCESSFUL tools/call results (HTTP 200, valid
  // JSON) that carry an error sentinel instead of renderable data — the
  // dispatcher returns { _budget_exceeded, ... } when the tool output exceeds
  // its byte budget, and a bad jmespath projection returns { _jmespath_error,
  // ... }. A few tools also surface user-input faults as a result-level
  // { error: "..." } string. Rendering any of these through renderData() shows
  // a blank / empty-success dashboard, so detect them and surface a visible
  // message instead. Returns the message string, or null when data is genuinely
  // renderable.
  function softError(data) {
    if (!data || typeof data !== "object") return null;
    if (data._budget_exceeded === true) {
      return "This response is too large to display here. Narrow the request (fewer items, or a jmespath projection) and try again.";
    }
    if (data._jmespath_error) {
      return "The response projection could not be applied, so there is nothing to render. Remove the jmespath argument and retry.";
    }
    if (typeof data.error === "string" && data.error) return data.error;
    return null;
  }
  // Every fleet widget owns an #empty placeholder and an #card body; on a soft
  // error we reuse #empty as the error slot (hide the card) so the message is
  // visible regardless of which widget is mounted.
  function showError(msg) {
    var card = q("card");
    if (card) card.style.display = "none";
    var empty = q("empty");
    if (empty) { empty.textContent = msg; empty.style.display = "block"; }
  }

  function safeRender(data) {
    var errMsg = softError(data);
    if (errMsg) { showError(errMsg); reportSize(); return; }
    try { renderData(data); } catch (e) { /* never break the host on a bad payload */ }
    reportSize();
  }
`;

// The bridge tail interpolates the per-widget appInfo.name directly (no
// placeholder sentinel), so a widget whose renderBody happens to contain the
// old `__APP_NAME__` token can't leak it into the served HTML. `appName` is
// JSON.stringified at the call site — it becomes a string literal in the
// emitted JS.
function renderBridgeTail(appName: string): string {
  return `
  window.addEventListener("message", function (event) {
    if (event.source !== parentWin) return;
    var msg = event.data;
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return;

    if (msg.id === 1 && msg.result) {
      applyTheme(msg.result.hostContext);
      notify("ui/notifications/initialized", {});
      reportSize();
      return;
    }

    switch (msg.method) {
      case "ui/notifications/tool-result": {
        var data = extractToolData(msg.params && msg.params.result ? msg.params.result : msg.params);
        if (data) safeRender(data);
        break;
      }
      case "ui/notifications/tool-input":
        break;
      case "ui/notifications/host-context-changed":
        applyTheme(msg.params && msg.params.hostContext ? msg.params.hostContext : msg.params);
        break;
      default:
        break;
    }
  });

  applyTheme(null);

  post({
    jsonrpc: "2.0",
    id: 1,
    method: "ui/initialize",
    params: {
      protocolVersion: "${UI_PROTOCOL_VERSION}",
      appInfo: { name: ${JSON.stringify(appName)}, version: "1.0.0" },
      appCapabilities: {}
    }
  });
})();
`;
}

export interface AppShellSpec {
  // Page <title> and the app-shell identity reported in ui/initialize.appInfo.name.
  title: string;
  appName: string;
  // Component CSS appended after the shared design tokens.
  styles: string;
  // Body markup placed inside <div class="wrap" id="root">. Owns its own
  // empty-state + card elements.
  body: string;
  // JS body of `function renderData(data) { ... }`. Runs inside the shared
  // bridge closure with access to q/num/setText/el/cssVar/pctText/clampPct/
  // levelFor. MUST avoid backticks and `${`.
  renderBody: string;
}

// Assemble a complete, self-contained MCP-Apps shell. Every widget goes through
// here so DOCTYPE, color-scheme, CSP, theme handling, and the bridge stay
// byte-consistent across the fleet.
export function buildAppHtml(spec: AppShellSpec): string {
  const bridge =
    SHARED_BRIDGE_HEAD +
    '\n  function renderData(data) {\n' + spec.renderBody + '\n  }\n' +
    renderBridgeTail(spec.appName);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- MCP Apps view quality: uppercase DOCTYPE + color-scheme so the host renders
     light/dark correctly (orank mcp-apps-ui-quality + mcp-view-domain checks). -->
<meta name="color-scheme" content="light dark">
<!-- MCP Apps view CSP (orank mcp-view-csp): all 4 required directive categories
     scoped. Shared across the widget fleet via api/mcp/ui/shell.ts. -->
<meta http-equiv="Content-Security-Policy" content="${SHARED_CSP}">
<title>${spec.title}</title>
<style>${SHARED_STYLE_TOKENS}${spec.styles}</style>
</head>
<body>
<div class="wrap" id="root">
${spec.body}
</div>
<script>${bridge}</script>
</body>
</html>`;
}
