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
  .grounding-notice { margin: 12px 0 0; padding: 10px; border: 1px solid var(--border); border-radius: 6px; color: var(--muted); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
  .brief { margin: 14px 0 4px; }
  .brief .para { margin: 0 0 10px; font-size: 14px; line-height: 1.6; }
  .brief .brief-head { margin: 14px 0 6px; font-size: 13px; font-weight: 650; color: var(--fg); }
  .brief .brief-head:first-child { margin-top: 0; }
  .brief .para b { font-weight: 600; }
  .src-num { color: var(--muted); font-weight: 400; margin-right: 6px; font-variant-numeric: tabular-nums; }
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
    <div class="grounding-notice" id="grounding-notice" role="note" style="display:none"></div>
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
    if (data && typeof data === "object" && Object.prototype.hasOwnProperty.call(data, "projection")) data = data.projection;
    if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
    q("empty").style.display = "none";
    q("card").style.display = "block";

    var groundingNotice = q("grounding-notice");
    groundingNotice.textContent = "";
    groundingNotice.style.display = "none";
    var coverage = data.digestCoverage;
    if (coverage && typeof coverage === "object" && !Array.isArray(coverage) &&
        (coverage.servedStale === true || coverage.state === "stale")) {
      var age = coverage.staleAgeSeconds;
      var howOld = "";
      if (typeof age === "number" && Number.isFinite(age) && age > 0) {
        var amount = age < 60 ? Math.max(1, Math.round(age)) : Math.round(age / 60);
        var unit = age < 60 ? "second" : "minute";
        howOld = amount + " " + unit + (amount === 1 ? "" : "s") + " old";
      }
      // digestCoverage describes the news digest, not the brief: the brief may
      // come from cache or drop stale news, so the age is never tied to it.
      // Known reason codes become a plain cause; anything else is not shown.
      var reasons = { "empty-rebuild": "The latest news update returned no stories", "build-error": "The latest news update failed", "gate-held": "The latest news update was held back by quality checks" };
      var reason = typeof coverage.staleReason === "string" && Object.prototype.hasOwnProperty.call(reasons, coverage.staleReason)
        ? reasons[coverage.staleReason] : "The latest news update could not be confirmed";
      var notice = reason + (howOld ? "; the most recent news on hand is " + howOld : "") + ". This brief may not reflect current news.";
      groundingNotice.textContent = notice;
      groundingNotice.style.display = "block";
    }

    var titleName = collapseWs(data.countryName) || countryName(data.countryCode || data.country_code);
    setText("title", titleName ? titleName + " Brief" : "Country Brief");

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
    var srcs = Array.isArray(data.sources) ? data.sources : [];
    var linkOriginalCitations = renderContext && renderContext.kind === "ordinary-structured";
    function evAsOf(ev) {
      if (typeof ev.asOf !== "string") return "";
      var day = collapseWs(ev.asOf).slice(0, 10);
      // Only a full YYYY-MM-DD date is reformatted; "2026 Q2" or "2026-09"
      // stay as written rather than gaining a day they never had.
      var full = day.length === 10 && day.charAt(4) === "-" && day.charAt(7) === "-";
      var parsed = full ? utcTime(day + "T00:00:00Z") : "";
      return parsed ? parsed.slice(0, parsed.indexOf(",")) : day;
    }
    function evText(ev) { return (collapseWs(ev.label) || ev.id) + ": " + collapseWs(ev.value); }
    function evHttps(u) { var h = httpUrl(u); return h.indexOf("https:") === 0 ? h : ""; }
    function isDigits(value) { return value.length > 0 && value.length <= 2 && String(Number(value)) === value; }
    // Appends claim text to node. A known "[E<n>]" marker becomes a superscript
    // reference to World Monitor data; a "[<n>]" marker links the numbered
    // source row. Unknown markers stay literal text.
    function appendWithRefs(node, text) {
      var pos = 0, cursor = 0;
      while (pos < text.length) {
        var open = text.indexOf("[", pos);
        if (open < 0) break;
        var close = text.indexOf("]", open + 1);
        var id = close > open + 1 ? text.slice(open + 1, close) : "";
        var evidence = id.charAt(0) === "E" && isDigits(id.slice(1)) && Object.prototype.hasOwnProperty.call(evById, id) ? evById[id] : null;
        var sourceIndex = isDigits(id) ? Number(id) - 1 : -1;
        var source = sourceIndex >= 0 && sourceIndex < Math.min(12, srcs.length) && srcs[sourceIndex] && typeof srcs[sourceIndex] === "object" ? srcs[sourceIndex] : null;
        var sourceUrl = source && linkOriginalCitations ? httpUrl(source.url) : "";
        if (!evidence && !sourceUrl) { pos = open + 1; continue; }
        var before = text.slice(cursor, open);
        if (before.charAt(before.length - 1) === " ") before = before.slice(0, -1);
        node.appendChild(document.createTextNode(before));
        if (evidence) {
          var asOf = evAsOf(evidence);
          var sup = el("sup", "ev-ref", id);
          sup.title = evText(evidence) + (asOf ? " (as of " + asOf + ")" : "");
          node.appendChild(sup);
        } else {
          var link = el("a", null, "[" + id + "]");
          link.href = sourceUrl; link.target = "_blank"; link.rel = "noopener noreferrer";
          node.appendChild(link);
        }
        pos = cursor = close + 1;
      }
      node.appendChild(document.createTextNode(text.slice(cursor)));
    }
    var displayName = collapseWs(data.countryName) || countryName(data.countryCode || data.country_code);
    // Section headings arrive as whole upper-case lines ("SITUATION NOW",
    // "WHAT THIS MEANS FOR IRAN"); show them in sentence case.
    function headingText(line) {
      var heading = collapseWs(line);
      if (heading.charAt(heading.length - 1) === ":") heading = heading.slice(0, -1);
      if (!heading || heading.length > 80 || heading !== heading.toUpperCase() || heading === heading.toLowerCase()) return "";
      // A cited or labelled line is a claim even when written in capitals.
      if (heading.indexOf("[") >= 0 || heading.indexOf(":") >= 0) return "";
      var prefix = "WHAT THIS MEANS FOR ";
      if (heading.indexOf(prefix) === 0 && displayName) return "What this means for " + displayName;
      return heading.charAt(0) + heading.slice(1).toLowerCase();
    }

    var brief = typeof data.brief === "string" ? data.brief
      : (typeof data.summary === "string" ? data.summary : "");
    var briefEl = q("brief");
    briefEl.textContent = "";
    // Each line of the brief is its own claim or heading.
    var lines = brief.split("\\n").map(collapseWs).filter(Boolean);
    for (var l = 0; l < lines.length; l++) {
      var heading = headingText(lines[l]);
      if (heading) { briefEl.appendChild(el("div", "brief-head", heading)); continue; }
      var p = el("p", "para");
      var colon = lines[l].indexOf(":");
      var label = lines[l].indexOf("NEXT ") === 0 && colon > 0 && colon < 20 ? lines[l].slice(0, colon) : "";
      if (label) {
        p.appendChild(el("b", null, "Next " + label.slice(5).toLowerCase() + ": "));
        appendWithRefs(p, collapseWs(lines[l].slice(colon + 1)));
      } else appendWithRefs(p, lines[l]);
      briefEl.appendChild(p);
    }
    if (!briefEl.childNodes.length) briefEl.appendChild(el("div", "empty", "No brief text available."));

    var srcHost = q("sources");
    srcHost.textContent = "";
    // Rows keep their list position so a claim's [n] marker names row n.
    for (var k = 0; k < srcs.length && k < 12; k++) {
      var s = srcs[k];
      if (!s || typeof s !== "object") continue;
      var row = el("div", "src-row");
      var srcName = el("span", "src-name");
      srcName.appendChild(el("span", "src-num", String(k + 1)));
      srcName.appendChild(document.createTextNode(collapseWs(s.source) || "Source"));
      row.appendChild(srcName);
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
      ? "Generated " + utcTime(genMs)
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
