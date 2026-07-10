// MCP Apps (extension `io.modelcontextprotocol/ui`, spec 2026-01-26) — the
// interactive app shell for the `get_news_intelligence` tool: a compact news
// radar rendering AI-classified top stories (headline, category, alert flag,
// country, source) from WorldMonitor's intelligence layer. Built on the shared
// shell foundation.
//
// Tool result shape (cache tool — content[0].text JSON, freshness envelope).
// The tool serves the raw `news:insights:v1` cache value under label `insights`;
// its topStories items are ServerInsightStory (see src/services/insights-loader.ts),
// which use camelCase `primaryTitle` / `primarySource` (NOT `title`/`summary`):
//   { cached_at, stale, data: {
//       insights: { topStories: [{ primaryTitle, primarySource, category,
//                                  threatLevel, isAlert, countryCode }] },
//       "gdelt-intel": {...}, "cross-source-signals": {...} } }
// Any label may be absent (topic/category/country filters narrow the bundle).
//
// textContent-only rendering; renderBody stays backtick/`${`/regex-free.

import { buildAppHtml } from './shell';

const STYLES = `
  .story { padding: 10px 0; border-bottom: 1px solid var(--border); }
  .story:last-child { border-bottom: none; }
  .story-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .story-title { font-size: 14px; font-weight: 600; color: var(--fg); }
  .chip { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted);
    border: 1px solid var(--border); border-radius: 999px; padding: 1px 7px; }
  .chip.alert { color: #fff; background: var(--severe); border-color: var(--severe); font-weight: 600; }
  .story-country { font-size: 11px; color: var(--muted); }
  .story-src { margin-top: 4px; font-size: 12px; color: var(--muted); }
`;

const BODY = `
  <div class="head">
    <div class="title">News Intelligence</div>
    <div class="badge">WorldMonitor Intelligence</div>
  </div>
  <div class="empty" id="empty">Waiting for news intelligence…</div>
  <div id="card" style="display:none">
    <div id="list"></div>
    <div class="foot" id="foot"></div>
  </div>
`;

const RENDER = `
    if (!data || typeof data !== "object") return;
    var d = data.data && typeof data.data === "object" ? data.data : data;
    q("empty").style.display = "none";
    q("card").style.display = "block";

    var ins = d.insights && typeof d.insights === "object" ? d.insights : null;
    var storyState = listState(ins && ins.topStories);
    var stories = storyState.items;
    var host = q("list");
    host.textContent = "";
    for (var i = 0; i < stories.length && i < 12; i++) {
      var s = stories[i];
      if (!s || typeof s !== "object") continue;
      var row = el("div", "story");
      var head = el("div", "story-head");
      head.appendChild(el("span", "story-title", collapseWs(s.primaryTitle) || "Untitled story"));
      var cat = collapseWs(s.category);
      if (cat) head.appendChild(el("span", "chip", cat));
      if (s.isAlert === true) head.appendChild(el("span", "chip alert", "Alert"));
      var cn = countryName(s.countryCode);
      if (cn) head.appendChild(el("span", "story-country", cn));
      row.appendChild(head);
      var src = collapseWs(s.primarySource);
      if (src) row.appendChild(el("div", "story-src", src));
      host.appendChild(row);
    }
    if (!host.childNodes.length) {
      host.appendChild(el("div", "empty", storyState.available
        ? "No news stories available."
        : "News intelligence is temporarily unavailable."));
    }

    q("foot").textContent = data.cached_at
      ? "Snapshot: " + collapseWs(data.cached_at) + (data.stale ? " (stale)" : "")
      : "";
`;

export const NEWS_INTELLIGENCE_APP_HTML = buildAppHtml({
  title: 'News Intelligence — WorldMonitor',
  appName: 'worldmonitor-news-intelligence',
  styles: STYLES,
  body: BODY,
  renderBody: RENDER,
});
