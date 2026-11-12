// MCP Apps (extension `io.modelcontextprotocol/ui`, spec 2026-01-26) — the
// interactive app shell for the `get_world_brief` tool: the flagship reader of
// the fleet. Renders the LLM-summarised geopolitical brief as paragraphs, the
// grounding headlines, and the source feed articles. Built on the shared
// api/mcp/ui/shell.ts foundation (DOCTYPE / CSP / dark-mode / bridge), so the
// only per-widget code is the layout + render mapping below.
//
// Tool result shape (RPC tool — content[0].text JSON):
//   { brief|summary: string, headlines: string[],
//     sources: [{ title, url, source, publishedAt }], provider, model, generatedAt }
//
// Rendering uses textContent / element construction only (never innerHTML), so
// a hostile brief/headline/source payload cannot inject markup. renderBody must
// avoid backticks and `${` (it is interpolated into shell.ts's outer literal),
// and stays regex/escape-free by delegating text handling to the shared helpers
// (paragraphs / collapseWs / httpUrl).

import { buildAppHtml } from './shell';

const STYLES = `
  .brief { margin: 14px 0 4px; }
  .brief .para { margin: 0 0 10px; font-size: 14px; line-height: 1.6; }
  .section { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border); }
  .sec-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 8px; }
  ul.headlines { margin: 0; padding-left: 18px; }
  ul.headlines li { margin: 4px 0; font-size: 13px; }
  .src-row { display: flex; flex-direction: column; gap: 1px; padding: 6px 0; border-bottom: 1px solid var(--border); }
  .src-row:last-child { border-bottom: none; }
  .src-name { font-size: 11px; color: var(--accent); font-weight: 600; }
  .src-num { color: var(--muted); font-weight: 400; margin-right: 6px; font-variant-numeric: tabular-nums; }
  .src-title { font-size: 12px; color: var(--fg); }
  .src-date { font-size: 11px; color: var(--muted); }
  /* Serving a stale brief is only safe if a PERSON can see it is stale, so
     this sits above the brief rather than in the footer beside the provenance
     line, which reads as metadata and gets skipped (review, PR #7271). */
  .stale-note { margin: 12px 0 0; padding: 8px 10px; border-radius: 6px; font-size: 12px; line-height: 1.5;
    color: var(--fg); background: rgba(180, 120, 0, 0.12); border: 1px solid rgba(180, 120, 0, 0.45); }
  .stale-note b { font-weight: 600; }
`;

const BODY = `
  <div class="head">
    <div class="title" id="title">World Brief</div>
    <div class="badge">WorldMonitor Intelligence</div>
  </div>
  <div class="empty" id="empty">Waiting for world-brief data…</div>
  <div id="card" style="display:none">
    <div class="stale-note" id="stale-note" style="display:none"></div>
    <div class="brief" id="brief"></div>
    <div class="section" id="hl-sec" style="display:none">
      <div class="sec-label">Headlines</div>
      <ul class="headlines" id="headlines"></ul>
    </div>
    <div class="section" id="src-sec" style="display:none">
      <div class="sec-label">Sources</div>
      <div class="sources" id="sources"></div>
    </div>
    <div class="foot" id="foot"></div>
  </div>
`;

const RENDER = `
    var linkOriginalCitations = renderContext && renderContext.kind === "ordinary-structured";
    if (data && typeof data === "object" && Object.prototype.hasOwnProperty.call(data, "projection")) data = data.projection;
    if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
    var brief = typeof data.brief === "string" && data.brief ? data.brief
      : (typeof data.summary === "string" ? data.summary : "");
    q("empty").style.display = "none";
    q("card").style.display = "block";

    var srcs = Array.isArray(data.sources) ? data.sources : [];
    var briefEl = q("brief");
    briefEl.textContent = "";
    var paras = paragraphs(brief);
    for (var i = 0; i < paras.length; i++) {
      var para = el("p", "para");
      if (!linkOriginalCitations) para.textContent = paras[i];
      else {
        var citation = /\\[([0-9]+)\\]/g;
        var match;
        var cursor = 0;
        while ((match = citation.exec(paras[i])) !== null) {
          para.appendChild(document.createTextNode(paras[i].slice(cursor, match.index)));
          var index = Number(match[1]) - 1;
          var source = Number.isSafeInteger(index) && index >= 0 && index < Math.min(12, srcs.length) ? srcs[index] : null;
          var href = source && typeof source === "object" && !Array.isArray(source) ? httpUrl(source.url) : null;
          if (href) {
            var link = el("a", null, match[0]);
            link.href = href;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            para.appendChild(link);
          } else para.appendChild(document.createTextNode(match[0]));
          cursor = citation.lastIndex;
        }
        para.appendChild(document.createTextNode(paras[i].slice(cursor)));
      }
      briefEl.appendChild(para);
    }
    if (!briefEl.childNodes.length) briefEl.appendChild(el("div", "empty", "No brief text available."));

    // Headlines that only repeat a listed source title add nothing; show the
    // section only for headlines the Sources list does not already carry.
    var sourceTitles = {};
    for (var t = 0; t < srcs.length && t < 12; t++) {
      if (srcs[t] && typeof srcs[t] === "object" && typeof srcs[t].title === "string") sourceTitles[collapseWs(srcs[t].title).toLowerCase()] = true;
    }
    var hls = Array.isArray(data.headlines) ? data.headlines : [];
    var hlHost = q("headlines");
    hlHost.textContent = "";
    for (var j = 0; j < hls.length && hlHost.childNodes.length < 12; j++) {
      var h = hls[j];
      if (typeof h !== "string" || !h) continue;
      if (Object.prototype.hasOwnProperty.call(sourceTitles, collapseWs(h).toLowerCase())) continue;
      hlHost.appendChild(el("li", null, collapseWs(h)));
    }
    q("hl-sec").style.display = hlHost.childNodes.length ? "block" : "none";

    var srcHost = q("sources");
    srcHost.textContent = "";
    // Rows keep their position in the source list, so a brief citation [n]
    // always points at the row numbered n (citations link the first 12).
    for (var k = 0; k < srcs.length && k < 12; k++) {
      var s = srcs[k];
      if (!s || typeof s !== "object") continue;
      var row = el("div", "src-row");
      var name = el("span", "src-name");
      name.appendChild(el("span", "src-num", String(k + 1)));
      name.appendChild(document.createTextNode(collapseWs(s.source) || "Source"));
      row.appendChild(name);
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
      var publishedAt = utcTime(s.publishedAt);
      if (publishedAt) row.appendChild(el("span", "src-date", publishedAt));
      srcHost.appendChild(row);
    }
    q("src-sec").style.display = srcHost.childNodes.length ? "block" : "none";

    // The tool serves last-known-good rather than failing when the seeder has
    // not published inside its freshness window, so the card has to SAY so —
    // otherwise an old brief is presented identically to a current one and the
    // labelling this rests on reaches the agent but never the human.
    var staleEl = q("stale-note");
    staleEl.textContent = "";
    if (data.stale === true) {
      var age = typeof data.ageMinutes === "number" && isFinite(data.ageMinutes) ? Math.round(data.ageMinutes) : null;
      var howOld = age == null ? "" :
        age < 60 ? age + (age === 1 ? " minute" : " minutes") :
        Math.floor(age / 60) + "h " + (age % 60) + "m";
      var lead = document.createElement("b");
      lead.textContent = "Out of date (stale)";
      staleEl.appendChild(lead);
      staleEl.appendChild(document.createTextNode(
        ": " + (howOld ? "this brief is " + howOld + " old" : "this brief's age is unknown")
        + " and a newer one has not been published yet. Check the age before acting on time-sensitive points."
      ));
      staleEl.style.display = "block";
    } else {
      staleEl.style.display = "none";
    }

    var generated = data.generatedAt != null ? utcTime(data.generatedAt) || collapseWs(data.generatedAt) : "";
    q("foot").textContent = generated ? "Generated " + generated : "";
`;

export const WORLD_BRIEF_APP_HTML = buildAppHtml({
  title: 'World Brief — WorldMonitor',
  appName: 'worldmonitor-world-brief',
  styles: STYLES,
  body: BODY,
  renderBody: RENDER,
});
