// MCP Apps (extension `io.modelcontextprotocol/ui`, spec 2026-01-26) — the
// self-contained HTML app shell an MCP-Apps host renders inline for the
// `get_country_risk` tool. Served verbatim as a `ui://` resource
// (mimeType `text/html;profile=mcp-app`) — no build step, no external refs,
// so it renders unchanged inside the host's sandboxed (opaque-origin) iframe
// under a strict CSP.
//
// Data flow (the host, NOT this file, holds the credential):
//   1. Model calls `get_country_risk` (a normal, quota-gated tools/call).
//   2. Host renders THIS shell, then posts the tool's result in via
//      `postMessage` — the shell never fetches data itself.
//   3. Shell renders the Composite Instability Index + component breakdown
//      from that message using `textContent` / numeric coercion ONLY
//      (never innerHTML), so a hostile payload cannot inject markup.
//
// Bridge protocol (raw JSON-RPC 2.0 over `window.postMessage(msg, "*")`, no
// envelope), per the extension:
//   View → Host  request : `ui/initialize` {appInfo, appCapabilities, protocolVersion}
//   Host → View  result  : {hostCapabilities, hostInfo, hostContext}
//   View → Host  notify  : `ui/notifications/initialized`
//   Host → View  notify  : `ui/notifications/tool-input`  {arguments}
//   Host → View  notify  : `ui/notifications/tool-result` (a CallToolResult:
//                          structuredContent | content[].text)
//   View → Host  notify  : `ui/notifications/size-changed` {height}
//
// Incoming messages are gated on `event.source === window.parent` — the
// sandbox origin is opaque ("null"), so a source-identity check is the
// available trust boundary (an origin allowlist can't work here).
//
// Authoring constraint: this template is embedded in a TS template literal,
// so the inline <script>/<style> deliberately avoid backticks and `${` to
// keep the outer literal un-escaped and readable.

export const COUNTRY_RISK_UI_PROTOCOL_VERSION = '2026-01-26';

export const COUNTRY_RISK_APP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- MCP Apps view quality: uppercase DOCTYPE + color-scheme so the host renders
     light/dark correctly (orank mcp-apps-ui-quality + mcp-view-domain checks). -->
<meta name="color-scheme" content="light dark">
<!-- MCP Apps view CSP (orank mcp-view-csp). Scopes all 4 required directive
     categories: connect-src pins the MCP origin; frame-ancestors allowlists the
     agent hosts that embed this shell; form-action is locked ('none' — no forms);
     img/script/style-src are specific ('unsafe-inline' keeps the inline bridge +
     styles working) rather than '*'. default-src 'none' earns full credit over a
     permissive default. frame-ancestors is advisory in a <meta> CSP (browsers honor
     it only via HTTP header) but the static scanner reads it here. -->
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://worldmonitor.app https://www.worldmonitor.app; frame-ancestors https://chatgpt.com https://claude.ai https://claude.com; form-action 'none'; base-uri 'none'">
<title>Country Risk — WorldMonitor</title>
<style>
  :root {
    --bg: #ffffff; --fg: #0f172a; --muted: #64748b; --card: #f8fafc;
    --border: #e2e8f0; --accent: #2563eb;
    --low: #16a34a; --moderate: #ca8a04; --high: #ea580c; --severe: #dc2626;
  }
  [data-theme="dark"] {
    --bg: #0b1220; --fg: #e5e7eb; --muted: #94a3b8; --card: #131c2e;
    --border: #1e293b; --accent: #60a5fa;
    /* The severity ramp needs dark variants too: the light values sit at
       3.5:1 on --card, under WCAG AA for the 12px degraded banner — the one
       element whose whole job is being noticed during an outage. */
    --low: #4ade80; --moderate: #facc15; --high: #fb923c; --severe: #f87171;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .wrap { padding: 16px; max-width: 520px; }
  .head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .country { font-size: 20px; font-weight: 650; letter-spacing: 0.2px; }
  .badge { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--muted); }
  .cii-row { display: flex; align-items: center; gap: 14px; margin: 14px 0 4px; }
  .cii-score { font-size: 40px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; }
  .cii-of { color: var(--muted); font-size: 13px; }
  .level { font-weight: 600; font-size: 13px; padding: 2px 10px; border-radius: 999px;
    background: var(--card); border: 1px solid var(--border); }
  .bar { height: 8px; border-radius: 999px; background: var(--border); overflow: hidden; margin: 6px 0 18px; }
  .bar > span { display: block; height: 100%; background: var(--accent); width: 0%; transition: width .3s ease; }
  .components { display: grid; grid-template-columns: 1fr; gap: 10px; }
  .comp { }
  .comp-top { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); }
  .comp-name { color: var(--fg); font-weight: 550; }
  .degraded { margin: 0 0 14px; padding: 8px 10px; border-radius: 8px; font-size: 12px;
    color: var(--severe); background: var(--card); border: 1px solid var(--severe); }
  .comp-bar { height: 6px; border-radius: 999px; background: var(--border); overflow: hidden; margin-top: 4px; }
  .comp-bar > span { display: block; height: 100%; width: 0%; }
  .meta { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--border);
    display: grid; grid-template-columns: 1fr 1fr; gap: 10px 16px; font-size: 12px; }
  .meta .k { color: var(--muted); }
  .meta .v { font-weight: 600; }
  .foot { margin-top: 14px; font-size: 11px; color: var(--muted); }
  .empty { color: var(--muted); padding: 8px 0; }
  a { color: var(--accent); text-decoration: none; }
</style>
</head>
<body>
<div class="wrap" id="root">
  <div class="empty" id="empty">Waiting for country-risk data…</div>
  <div id="card" style="display:none">
    <div class="head">
      <div class="country" id="country">—</div>
      <div class="badge" id="badge">Composite Instability Index</div>
    </div>
    <!-- upstreamUnavailable: a required upstream read failed, so the zeroed risk
         fields mean UNKNOWN. Without this banner an outage renders exactly
         like a calm, low-risk country. -->
    <div class="degraded" id="degraded" style="display:none">
      Upstream risk data is unavailable — the fields below are unknown, not low.
    </div>
    <div class="cii-row">
      <div class="cii-score" id="cii">—</div>
      <div class="cii-of">/ 100</div>
      <div class="level" id="level">—</div>
    </div>
    <div class="bar"><span id="ciibar"></span></div>
    <div class="components" id="components"></div>
    <div class="meta">
      <div class="k">Travel advisory</div><div class="v" id="advisory">—</div>
      <div class="k">Sanctions exposure</div><div class="v" id="sanctions">—</div>
      <div class="k">Trend</div><div class="v" id="trend">—</div>
    </div>
    <div class="foot" id="foot"></div>
  </div>
</div>
<script>
(function () {
  "use strict";
  var parentWin = window.parent;

  function post(msg) {
    // Opaque sandbox origin: the host expects "*" and validates on its side.
    try { parentWin.postMessage(msg, "*"); } catch (e) { /* host gone */ }
  }
  function notify(method, params) {
    post({ jsonrpc: "2.0", method: method, params: params || {} });
  }

  function levelFor(score) {
    if (typeof score !== "number" || isNaN(score)) return { label: "Unknown", varName: "--muted" };
    if (score >= 75) return { label: "Severe", varName: "--severe" };
    if (score >= 50) return { label: "High", varName: "--high" };
    if (score >= 25) return { label: "Moderate", varName: "--moderate" };
    return { label: "Low", varName: "--low" };
  }
  // Only real numbers and numeric strings become numbers. A bare Number()
  // coerces null, "", and [] to 0, which would render a MISSING score as a
  // reassuring 0 — the same "absent read as calm" failure as the outage path.
  function num(v) {
    if (typeof v === "number") return isFinite(v) ? v : null;
    if (typeof v === "string" && v.trim() !== "") {
      var n = Number(v);
      return isFinite(n) ? n : null;
    }
    return null;
  }
  function clampPct(n) { return Math.max(0, Math.min(100, n)); }

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text == null ? "—" : String(text);
  }

  // Server strings are collapsed and capped before they reach the DOM. The
  // sibling shells get this from shell.ts's collapseWs; this shell is
  // hand-rolled, and the tool's 256 KB output budget means an unbounded value
  // could flood a cell and push a huge height back to the host.
  // NOTE the doubled backslash: this file is a TS template literal, so a bare
  // \\s would reach the browser as a literal "s" and collapse every letter s
  // in the value. shell.ts:189 escapes the same way for the same reason.
  function cleanText(s, max) {
    return String(s == null ? "" : s).replace(/\\s+/g, " ").trim().slice(0, max);
  }
  // GetCountryRiskResponse.advisory_level is a plain string ("do-not-travel",
  // "reconsider", "caution", …), empty when no advisory applies.
  function describeAdvisory(level) {
    var text = cleanText(level, 64).replace(/[-_]+/g, " ");
    return text === "" ? "None" : text;
  }
  // Sanctions arrive as two scalars, not a collection: sanctions_active plus
  // sanctions_count. count alone is enough to render, but active is the
  // authoritative flag, so an active designation with an unknown count still
  // reads as active rather than as "None".
  function describeSanctions(active, count) {
    // Count first, so a positive one is never discarded. The producer keeps
    // the two coupled today (sanctionsActive = sanctionsCount > 0), but the
    // schema declares them independently and nothing enforces that, and
    // "designations exist but we printed None" is the precise failure this
    // shell was fixed to stop making.
    var n = num(count);
    if (n != null && n > 0) return String(n) + " OFAC-listed";
    if (active === true) return "Active";
    if (active === false) return "None";
    return "—";
  }
  var TREND_LABELS = {
    TREND_DIRECTION_RISING: "Rising",
    TREND_DIRECTION_STABLE: "Stable",
    TREND_DIRECTION_FALLING: "Falling"
  };
  function describeTrend(trend) {
    if (typeof trend !== "string") return "—";
    // Require a string hit: a bare lookup also finds inherited members, so a
    // payload sending trend "constructor" or "__proto__" would render an
    // Object internal into the row instead of the em-dash.
    var label = TREND_LABELS[trend];
    return typeof label === "string" ? label : "—";
  }
  // The four CiiComponents wire names are historical and do not describe what
  // they measure (cii_contribution is unrest, geo_convergence is armed
  // conflict, military_activity is security/mobility). Label them by meaning —
  // see proto/worldmonitor/intelligence/v1/intelligence.proto.
  var COMPONENTS = [
    { key: "ciiContribution", label: "Domestic unrest" },
    { key: "geoConvergence", label: "Armed conflict" },
    { key: "militaryActivity", label: "Security & mobility" },
    { key: "newsActivity", label: "Information environment" }
  ];

  function render(data) {
    if (!data || typeof data !== "object") return;
    document.getElementById("empty").style.display = "none";
    document.getElementById("card").style.display = "block";

    var degraded = data.upstreamUnavailable === true;
    document.getElementById("degraded").style.display = degraded ? "block" : "none";

    setText("country", cleanText(data.countryName, 64) || cleanText(data.countryCode, 8) || "—");

    // cii is a CiiScore object; combinedScore is the headline 0-100 number.
    var score = (data.cii && typeof data.cii === "object") ? data.cii : {};
    var cii = degraded ? null : num(score.combinedScore);
    setText("cii", cii == null ? "—" : String(Math.round(cii)));
    var lv = levelFor(cii);
    var levelEl = document.getElementById("level");
    var bar = document.getElementById("ciibar");
    levelEl.textContent = lv.label;
    // The host can post a second tool-result into this same shell, so every
    // branch must fully own the score visuals. Leaving them untouched when
    // cii is null let an outage inherit the PREVIOUS country's severity —
    // "Unknown" in red above a full red bar — which is the exact
    // outage-reads-as-a-verdict failure this shell exists to prevent.
    if (cii == null) {
      levelEl.style.color = "";
      bar.style.width = "0%";
      bar.style.background = "";
    } else {
      var color = getComputedStyle(document.documentElement).getPropertyValue(lv.varName).trim();
      levelEl.style.color = color;
      bar.style.width = clampPct(cii) + "%";
      bar.style.background = color || "var(--accent)";
    }

    var comps = (score.components && typeof score.components === "object") ? score.components : {};
    var host = document.getElementById("components");
    host.textContent = "";
    var any = false;
    COMPONENTS.forEach(function (spec) {
      var val = degraded ? null : num(comps[spec.key]);
      if (val == null) return;
      any = true;
      var wrap = document.createElement("div");
      wrap.className = "comp";
      var top = document.createElement("div");
      top.className = "comp-top";
      var name = document.createElement("span");
      name.className = "comp-name";
      name.textContent = spec.label;
      var v = document.createElement("span");
      v.textContent = String(Math.round(val));
      top.appendChild(name); top.appendChild(v);
      var cbar = document.createElement("div");
      cbar.className = "comp-bar";
      var fill = document.createElement("span");
      var cl = levelFor(val);
      var ccolor = getComputedStyle(document.documentElement).getPropertyValue(cl.varName).trim();
      fill.style.width = clampPct(val) + "%";
      fill.style.background = ccolor || "var(--accent)";
      cbar.appendChild(fill);
      wrap.appendChild(top); wrap.appendChild(cbar);
      host.appendChild(wrap);
    });
    if (!any) {
      var none = document.createElement("div");
      none.className = "empty";
      none.textContent = degraded
        ? "Component breakdown unavailable — upstream data could not be read."
        : "No component breakdown available.";
      host.appendChild(none);
    }

    setText("advisory", degraded ? "—" : describeAdvisory(data.advisoryLevel));
    setText("sanctions", degraded ? "—" : describeSanctions(data.sanctionsActive, data.sanctionsCount));
    setText("trend", degraded ? "—" : describeTrend(score.trend));

    // fetched_at is Unix epoch milliseconds, 0 when the CII computation time
    // is unknown (which includes "no CII score for this country").
    var foot = document.getElementById("foot");
    var fetchedAt = num(data.fetchedAt);
    if (fetchedAt != null && fetchedAt > 0) {
      var when = new Date(fetchedAt);
      foot.textContent = "Snapshot: " + (isNaN(when.getTime()) ? String(fetchedAt) : when.toISOString());
    } else {
      foot.textContent = degraded ? "Upstream unavailable — no snapshot time." : "";
    }
    reportSize();
  }

  function applyTheme(hostContext) {
    var theme = hostContext && hostContext.theme;
    if (theme === "dark" || theme === "light") {
      document.documentElement.setAttribute("data-theme", theme);
    } else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
      document.documentElement.setAttribute("data-theme", "dark");
    }
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

  function reportSize() {
    var h = Math.ceil(document.getElementById("root").getBoundingClientRect().height) + 8;
    notify("ui/notifications/size-changed", { height: h });
  }

  window.addEventListener("message", function (event) {
    // Trust boundary: only the embedding host (window.parent) may drive us.
    if (event.source !== parentWin) return;
    var msg = event.data;
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return;

    // Response to our ui/initialize request.
    if (msg.id === 1 && msg.result) {
      applyTheme(msg.result.hostContext);
      notify("ui/notifications/initialized", {});
      reportSize();
      return;
    }

    switch (msg.method) {
      case "ui/notifications/tool-result": {
        var data = extractToolData(msg.params && msg.params.result ? msg.params.result : msg.params);
        if (data) render(data);
        break;
      }
      case "ui/notifications/tool-input":
        // Arguments (e.g. country_code) arrive before the result; no-op —
        // the header country is populated from the result payload.
        break;
      case "ui/notifications/host-context-changed":
        applyTheme(msg.params && msg.params.hostContext ? msg.params.hostContext : msg.params);
        break;
      default:
        break;
    }
  });

  // Apply the OS/browser color preference up front so the theme is correct
  // from first paint regardless of host message ordering; the host's
  // ui/initialize result (hostContext.theme) overrides it if provided.
  applyTheme(null);

  // Kick off the handshake.
  post({
    jsonrpc: "2.0",
    id: 1,
    method: "ui/initialize",
    params: {
      protocolVersion: "2026-01-26",
      appInfo: { name: "worldmonitor-country-risk", version: "1.0.0" },
      appCapabilities: {}
    }
  });
})();
</script>
</body>
</html>`;
