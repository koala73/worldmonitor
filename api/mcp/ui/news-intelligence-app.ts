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
  .news-note { font-size: 12px; color: var(--high); padding: 6px 0; }
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

    var hasOwn = Object.prototype.hasOwnProperty;
    // An unprojected response always carries insights (null when the source is
    // missing), so an insights that is absent, a non-null scalar, or an object
    // without topStories was left out by a projection, with or without the
    // wrapper; only an explicit null stays an unavailable source.
    var projectedInsights = d.insights;
    var omitsInsights = !hasOwn.call(d, "insights") || (projectedInsights !== null
      && (typeof projectedInsights !== "object" || !hasOwn.call(projectedInsights, "topStories")));
    var ins = d.insights && typeof d.insights === "object" ? d.insights : null;
    var sourceStories = ins && ins.topStories;
    var storyState = listState(sourceStories);
    var stories = storyState.items;
    var host = q("list");
    host.textContent = "";
    // A short, plain provenance tag; unreviewed sources say so rather than
    // reading as neutral.
    function provenanceLabel(provenance) {
      if (!provenance || typeof provenance !== "object") return "";
      var state = collapseWs(provenance.stateAffiliated);
      var where = state ? " (" + state + ")" : "";
      var biases = Array.isArray(provenance.knownBiases)
        ? provenance.knownBiases.map(collapseWs).filter(Boolean) : [];
      var label = provenance.type === "gov" ? "official source" + where
        : provenance.risk === "high" ? "state media" + where
        : provenance.risk === "medium" ? (state ? "state-funded" + where : "use with caution")
        : provenance.risk === "unknown" ? "source not yet reviewed"
        : "";
      if (biases.length) label += (label ? "; " : "") + biases.join(", ");
      return label ? " · " + label : "";
    }
    function corroborationText(story) {
      var publishers = Array.isArray(story.publishers) ? story.publishers : null;
      // Only valid roster entries count, so blank or malformed rows never
      // inflate the "and N more" figure.
      var validNames = [];
      if (publishers) {
        for (var j = 0; j < publishers.length; j++) {
          var publisher = publishers[j];
          if (publisher && typeof publisher.name === "string" && publisher.name.trim()) validNames.push(collapseWs(publisher.name));
        }
      }
      var names = validNames.slice(0, 12);
      var unlisted = Number.isInteger(story.publishersUnlisted) && story.publishersUnlisted > 0 ? story.publishersUnlisted : 0;
      var more = validNames.length - names.length + unlisted;
      var corroboration = story.corroboration && typeof story.corroboration === "object" ? story.corroboration : {};
      var state = corroboration.state;
      var lead = state === "single-publisher" ? "Single source"
        : state === "tier4-only" ? "Only low-reliability sources"
        : state === "corroborated" ? "Corroborated"
        : "Corroboration unknown";
      if (!names.length) return lead + (publishers || lead !== "Corroboration unknown" ? "" : "; publishers unknown") + ".";
      if (state === "single-publisher" && names.length === 1 && !more) return lead + ".";
      return lead + ": " + names.join(", ") + (more > 0 ? " and " + more + " more" : "") + ".";
    }
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
      var threat = typeof s.threatLevel === "string" ? collapseWs(s.threatLevel).toLowerCase() : "";
      if (threat) head.appendChild(el("span", "chip", threat.charAt(0).toUpperCase() + threat.slice(1) + " threat"));
      if (s.isAlert === true) head.appendChild(el("span", "chip alert", "Alert"));
      var cn = countryName(s.countryCode);
      if (cn) head.appendChild(el("span", "story-country", cn));
      row.appendChild(head);
      var src = collapseWs(s.primarySource);
      var metaLine = el("div", "story-src", src ? src + provenanceLabel(s.sourceProvenance) + " · " : "");
      var pubValue = typeof s.pubDate === "number" && s.pubDate <= 0 ? null : s.pubDate;
      var published = utcTime(pubValue);
      if (published) {
        var publication = el("time", "", published);
        publication.dateTime = new Date(pubValue).toISOString();
        metaLine.appendChild(publication);
      } else {
        metaLine.appendChild(el("span", "", "Publication time unknown"));
      }
      row.appendChild(metaLine);
      var support = corroborationText(s);
      var reliability = s.credibilityScore;
      if (typeof reliability === "number" && Number.isFinite(reliability) && reliability >= 0 && reliability <= 100) {
        support += " Reliability " + reliability + "/100.";
      }
      row.appendChild(el("div", "story-src", support));
      host.appendChild(row);
    }
    var shown = host.childNodes.length;
    if (!shown) {
      host.appendChild(el("div", "empty", storyState.available
        ? "No news stories available."
        : omitsInsights ? "This request left out the story list, so there is nothing to show."
        : "News intelligence is temporarily unavailable."));
    }
    var notes = [];
    // "degraded" also covers a failed summary with healthy feeds, and a stale
    // flag can come from unreadable freshness data, so neither names a cause.
    if (ins && ins.status === "degraded") notes.push("The last news update was incomplete.");
    if (envelope.freshnessUnknown === true) notes.push("Whether these stories are current could not be checked.");
    else if (envelope.stale === true) notes.push("These stories may be out of date.");
    if (notes.length) host.insertBefore(el("div", "news-note", notes.join(" ")), host.firstChild);

    var footParts = [];
    if (storyState.available) {
      if (Array.isArray(sourceStories)) {
        if (shown < stories.length) footParts.push("Showing " + shown + " of " + stories.length + " stories.");
      } else {
        var total = sourceStories.count;
        var knownTotal = typeof total === "number" && Number.isInteger(total) && total >= stories.length;
        if (!knownTotal) footParts.push("Showing " + shown + " stories; total unknown.");
        else if (total > shown) footParts.push("Showing " + shown + " of " + total + " stories.");
      }
    }
    var updated = utcTime(envelope.cached_at);
    if (envelope.cached_at) footParts.push("Updated " + (updated || collapseWs(envelope.cached_at)) + ".");
    q("foot").textContent = footParts.join(" ");
`;

export const NEWS_INTELLIGENCE_APP_HTML = buildAppHtml({
  title: 'News Intelligence — WorldMonitor',
  appName: 'worldmonitor-news-intelligence',
  styles: STYLES,
  body: BODY,
  renderBody: RENDER,
});
