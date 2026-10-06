// MCP Apps (extension `io.modelcontextprotocol/ui`, spec 2026-01-26) — the
// interactive app shell for the `get_news_intelligence` tool: a compact news
// radar rendering AI-classified top stories (headline, category, alert flag,
// country, source provenance) from WorldMonitor's intelligence layer. Built on the shared
// shell foundation.
//
// Tool result shape (cache tool — content[0].text JSON, freshness envelope).
// The tool serves the raw `news:insights:v1` cache value under label `insights`;
// its topStories items are ServerInsightStory (see src/services/insights-loader.ts),
// which use camelCase `primaryTitle` / `primarySource` (NOT `title`/`summary`):
//   { cached_at, stale, data: {
//       insights: { topStories: [{ primaryTitle, primarySource, sourceProvenance,
//                                  category, threatLevel, isAlert, countryCode }] },
//       "gdelt-intel": {...}, "cross-source-signals": {...} } }
// Any label may be absent (topic/category/country filters narrow the bundle).
//
// textContent-only rendering; renderBody stays backtick/`${`/regex-free.

import { buildAppHtml } from './shell';

const STYLES = `
  .story { padding: 10px 0; border-bottom: 1px solid var(--border); }
  .story:last-child { border-bottom: none; }
  .story-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .story-title { overflow-wrap: anywhere; font-size: 14px; font-weight: 600; color: var(--fg); }
  a.story-title { text-decoration: underline; text-underline-offset: 3px; }
  .chip { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted);
    border: 1px solid var(--border); border-radius: 999px; padding: 1px 7px; }
  .chip.alert { color: #fff; background: var(--severe); border-color: var(--severe); font-weight: 600; }
  .story-country { font-size: 11px; color: var(--muted); }
  .story-src { overflow-wrap: anywhere; margin-top: 4px; font-size: 12px; color: var(--muted); }
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
    var value = Object.prototype.hasOwnProperty.call(data, "projection") ? data.projection : data;
    var envelope = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    var d = envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data)
      ? envelope.data : envelope;
    q("empty").style.display = "none";
    q("card").style.display = "block";

    var ins = d.insights && typeof d.insights === "object" ? d.insights : null;
    var sourceStories = ins && ins.topStories;
    var storyState = listState(sourceStories);
    var stories = storyState.items;
    var host = q("list");
    host.textContent = "";
    for (var i = 0; i < stories.length && i < 12; i++) {
      var s = stories[i];
      if (!s || typeof s !== "object") continue;
      var row = el("div", "story");
      var head = el("div", "story-head");
      var originalUrl = httpUrl(s.primaryLink);
      var title = el(originalUrl ? "a" : "span", "story-title", collapseWs(s.primaryTitle) || "Untitled story");
      if (originalUrl) {
        title.href = originalUrl;
        title.target = "_blank";
        title.rel = "noopener noreferrer";
      }
      head.appendChild(title);
      var cat = collapseWs(s.category);
      if (cat) head.appendChild(el("span", "chip", cat));
      var threat = typeof s.threatLevel === "string" ? collapseWs(s.threatLevel) : "";
      if (threat) head.appendChild(el("span", "chip", "Threat: " + threat));
      if (s.isAlert === true) head.appendChild(el("span", "chip alert", "Alert"));
      var cn = countryName(s.countryCode);
      if (cn) head.appendChild(el("span", "story-country", cn));
      row.appendChild(head);
      var src = collapseWs(s.primarySource);
      var provenanceSummary = s.sourceProvenance && typeof s.sourceProvenance === "object"
        ? collapseWs(s.sourceProvenance.summary) : "";
      if (src) row.appendChild(el("div", "story-src", src + (provenanceSummary ? " • " + provenanceSummary : "")));
      var hasPublicationTime = (typeof s.pubDate === "string" && s.pubDate.trim()) ||
        (typeof s.pubDate === "number" && Number.isFinite(s.pubDate));
      var published = hasPublicationTime ? new Date(s.pubDate) : null;
      if (published && Number.isFinite(published.getTime())) {
        var publication = el("time", "story-src", "Published: " + published.toISOString());
        publication.dateTime = published.toISOString();
        publication.style.display = "block";
        row.appendChild(publication);
      } else {
        row.appendChild(el("div", "story-src", "Publication time unavailable."));
      }
      var publishers = Array.isArray(s.publishers) ? s.publishers : null;
      var publisherNames = [];
      if (publishers) {
        for (var j = 0; j < publishers.length && publisherNames.length < 12; j++) {
          var publisher = publishers[j];
          if (!publisher || typeof publisher.name !== "string" || !publisher.name.trim()) continue;
          var tier = publisher.tier;
          var declaredTier = Number.isInteger(tier) && tier >= 1 && tier <= 4;
          publisherNames.push(publisher.name + (declaredTier ? " (declared tier " + tier + ")" : " (tier undeclared)"));
        }
      }
      var publisherText = publishers
        ? (publisherNames.length ? "Publishers: " + publisherNames.join(", ") + "." : "No contributing publishers listed.")
        : "Publisher roster unavailable.";
      if (publishers && publishers.length > publisherNames.length) {
        publisherText += " Showing " + publisherNames.length + " of " + publishers.length + " supplied publishers.";
      }
      var unlisted = s.publishersUnlisted;
      if (Number.isInteger(unlisted) && unlisted >= 0) {
        if (unlisted > 0) publisherText += " " + unlisted + " counted publishers not listed.";
      } else {
        publisherText += " Unlisted publisher count unavailable.";
      }
      row.appendChild(el("div", "story-src", publisherText));
      host.appendChild(row);
    }
    var shown = host.childNodes.length;
    if (!shown) {
      host.appendChild(el("div", "empty", storyState.available
        ? "No news stories available."
        : "News intelligence is temporarily unavailable."));
    }

    var footParts = [];
    if (storyState.available) {
      if (Array.isArray(sourceStories)) {
        footParts.push("Showing " + shown + " of " + stories.length + " loaded stories.");
      } else {
        var total = sourceStories.count;
        var knownTotal = typeof total === "number" && Number.isFinite(total) && Number.isInteger(total) && total >= stories.length;
        footParts.push("Showing " + shown + " sampled stories" +
          (knownTotal ? " of " + total + " reported stories." : "; total unavailable.") +
          (knownTotal ? (total > stories.length ? " Full list is not loaded." : " Sample contains all reported stories.")
            : " Full list coverage is unavailable."));
      }
    }
    if (ins && ins.status === "degraded") footParts.push("Source reports degraded news intelligence.");
    if (envelope.cached_at) footParts.push("Snapshot: " + collapseWs(envelope.cached_at) + (envelope.stale ? " (stale)" : ""));
    q("foot").textContent = footParts.join(" ");
`;

export const NEWS_INTELLIGENCE_APP_HTML = buildAppHtml({
  title: 'News Intelligence — WorldMonitor',
  appName: 'worldmonitor-news-intelligence',
  styles: STYLES,
  body: BODY,
  renderBody: RENDER,
});
