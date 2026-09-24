// MCP Apps (extension `io.modelcontextprotocol/ui`, spec 2026-01-26) — the
// interactive app shell for the `get_country_brief` tool: the per-country
// deep-dive companion to the country-risk widget. Renders the LLM-synthesised
// country intelligence brief as paragraphs, the analytical framework lens (when
// supplied), the grounding sources, and the World Monitor data points the
// brief's `[En]` markers cite. Built on the shared shell foundation.
//
// Tool result shape (RPC tool — content[0].text JSON). The backing
// get-country-intel-brief handler emits CAMELCASE identity fields
// (`countryCode` + a resolved `countryName`), NOT `country_code`:
//   { countryCode, countryName, brief: string, model, generatedAt,
//     sources: [{ title, url, source, publishedAt }],
//     evidence: [{ id, kind, label, value, factText, asOf, url }] }
// A claim ending `[E2]` cites evidence id "E2": the marker becomes a
// superscript whose title reads "label: value (as of date)", and the cited
// items list under Sources. Evidence links render for https URLs only.
// `model` is deliberately never rendered.
// The title read below prefers `countryName`, then resolves `countryCode`
// via Intl, and still tolerates a legacy `country_code` for safety.
//
// textContent-only rendering; renderBody stays backtick/`${`/regex-free.

import { buildAppHtml } from './shell';

const STYLES = `
  .lens { display: inline-block; margin: 4px 0 0; font-size: 11px; color: var(--muted); }
  .lens b { color: var(--fg); font-weight: 600; }
  .brief { margin: 14px 0 4px; }
  .brief .para { margin: 0 0 10px; font-size: 14px; line-height: 1.6; }
  .section { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border); }
  .sec-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 8px; }
  .src-row { display: flex; flex-direction: column; gap: 1px; padding: 6px 0; border-bottom: 1px solid var(--border); }
  .src-row:last-child { border-bottom: none; }
  .src-name { font-size: 11px; color: var(--accent); font-weight: 600; }
  .src-title { font-size: 12px; color: var(--fg); }
  .ev-ref { font-size: 10px; color: var(--accent); font-weight: 600; cursor: help; margin-left: 1px; }
  .ev-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; padding: 4px 0; font-size: 12px; }
  .ev-id { font-size: 10px; color: var(--accent); font-weight: 600; }
  .ev-text { color: var(--fg); }
  .ev-date { font-size: 11px; color: var(--muted); }
`;

const BODY = `
  <div class="head">
    <div class="title" id="title">Country Brief</div>
    <div class="badge">WorldMonitor Intelligence</div>
  </div>
  <div class="lens" id="lens" style="display:none"></div>
  <div class="empty" id="empty">Waiting for country-brief data…</div>
  <div id="card" style="display:none">
    <div class="brief" id="brief"></div>
    <div class="section" id="src-sec" style="display:none">
      <div class="sec-label">Sources</div>
      <div class="sources" id="sources"></div>
    </div>
    <div class="section" id="ev-sec" style="display:none">
      <div class="sec-label">World Monitor data</div>
      <div id="evidence"></div>
    </div>
    <div class="foot" id="foot"></div>
  </div>
`;

const RENDER = `
    if (!data || typeof data !== "object") return;
    q("empty").style.display = "none";
    q("card").style.display = "block";

    var name = collapseWs(data.countryName) || countryName(data.countryCode || data.country_code);
    setText("title", name ? name + " Brief" : "Country Brief");

    // GetCountryIntelBriefResponse has no framework field — it is an INPUT
    // only, so this lens pill could never appear. The shared shell drops
    // ui/notifications/tool-input (shell.ts), which is where the argument
    // would have to come from; wiring that is a fleet-wide bridge change.
    q("lens").style.display = "none";

    // Evidence items keyed by id; malformed entries (null, missing or
    // non-string id) are dropped before either the markers or the list use them.
    var evRaw = Array.isArray(data.evidence) ? data.evidence : [];
    var evList = [];
    var evById = {};
    for (var e = 0; e < evRaw.length; e++) {
      var ev = evRaw[e];
      if (!ev || typeof ev !== "object" || typeof ev.id !== "string" || !ev.id) continue;
      if (Object.prototype.hasOwnProperty.call(evById, ev.id)) continue;
      evById[ev.id] = ev;
      evList.push(ev);
    }
    function evAsOf(ev) { return typeof ev.asOf === "string" ? collapseWs(ev.asOf).slice(0, 10) : ""; }
    function evText(ev) { return (collapseWs(ev.label) || ev.id) + ": " + collapseWs(ev.value); }
    function evHttps(u) { var h = httpUrl(u); return h.indexOf("https:") === 0 ? h : ""; }
    // Appends paragraph text to node, turning each known "[E<digits>]" marker
    // into a superscript reference. Unknown ids stay as literal text.
    function appendWithRefs(node, text) {
      var pos = 0;
      while (pos < text.length) {
        var open = text.indexOf("[E", pos);
        if (open < 0) break;
        var close = text.indexOf("]", open + 2);
        var id = close > open + 2 ? text.slice(open + 1, close) : "";
        var digits = id.slice(1);
        var isNum = digits.length > 0 && digits.length <= 2 && String(Number(digits)) === digits;
        var item = isNum && Object.prototype.hasOwnProperty.call(evById, id) ? evById[id] : null;
        if (!item) {
          node.appendChild(document.createTextNode(text.slice(pos, open + 2)));
          pos = open + 2;
          continue;
        }
        var before = text.slice(pos, open);
        if (before.charAt(before.length - 1) === " ") before = before.slice(0, -1);
        node.appendChild(document.createTextNode(before));
        var asOf = evAsOf(item);
        var sup = el("sup", "ev-ref", id);
        sup.title = evText(item) + (asOf ? " (as of " + asOf + ")" : "");
        node.appendChild(sup);
        pos = close + 1;
      }
      node.appendChild(document.createTextNode(text.slice(pos)));
    }

    var brief = typeof data.brief === "string" ? data.brief
      : (typeof data.summary === "string" ? data.summary : "");
    var briefEl = q("brief");
    briefEl.textContent = "";
    var paras = paragraphs(brief);
    for (var i = 0; i < paras.length; i++) {
      var p = el("p", "para");
      appendWithRefs(p, paras[i]);
      briefEl.appendChild(p);
    }
    if (!briefEl.childNodes.length) briefEl.appendChild(el("div", "empty", "No brief text available."));

    var srcs = Array.isArray(data.sources) ? data.sources : [];
    var srcHost = q("sources");
    srcHost.textContent = "";
    for (var k = 0; k < srcs.length && srcHost.childNodes.length < 8; k++) {
      var s = srcs[k];
      if (!s || typeof s !== "object") continue;
      var row = el("div", "src-row");
      row.appendChild(el("span", "src-name", collapseWs(s.source) || "source"));
      var url = httpUrl(s.url);
      if (s.title) {
        var titleText = collapseWs(s.title);
        if (url) {
          var a = el("a", "src-title", titleText);
          a.href = url;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          row.appendChild(a);
        } else {
          row.appendChild(el("span", "src-title", titleText));
        }
      }
      srcHost.appendChild(row);
    }
    q("src-sec").style.display = srcHost.childNodes.length ? "block" : "none";

    var evHost = q("evidence");
    evHost.textContent = "";
    for (var m = 0; m < evList.length && m < 12; m++) {
      var item = evList[m];
      var evRow = el("div", "ev-row");
      evRow.appendChild(el("span", "ev-id", item.id));
      var evUrl = evHttps(item.url);
      if (evUrl) {
        var link = el("a", "ev-text", evText(item));
        link.href = evUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        evRow.appendChild(link);
      } else {
        evRow.appendChild(el("span", "ev-text", evText(item)));
      }
      var evDate = evAsOf(item);
      if (evDate) evRow.appendChild(el("span", "ev-date", "as of " + evDate));
      evHost.appendChild(evRow);
    }
    q("ev-sec").style.display = evHost.childNodes.length ? "block" : "none";

    // The response still carries model for telemetry; no rendered surface
    // shows it (plan KTD7), so the footer is the generation date alone.
    // generated_at is int64 epoch milliseconds (INT64_ENCODING_NUMBER), so
    // printing it raw read "Generated 1756296000000".
    var genMs = Number(data.generatedAt);
    var genAt = isFinite(genMs) && genMs > 0 ? new Date(genMs) : null;
    var gen = genAt && !isNaN(genAt.getTime())
      ? "Generated " + genAt.toISOString()
      : (data.generatedAt != null ? "Generated " + collapseWs(data.generatedAt) : "");
    q("foot").textContent = gen;
`;

export const COUNTRY_BRIEF_APP_HTML = buildAppHtml({
  title: 'Country Brief — WorldMonitor',
  appName: 'worldmonitor-country-brief',
  styles: STYLES,
  body: BODY,
  renderBody: RENDER,
});
