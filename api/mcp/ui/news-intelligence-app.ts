import { buildAppHtml } from './shell';
import countries from './news-map.generated.json' with { type: 'json' };

const STYLES = `
.wrap { max-width: 1200px; }
.controls { display: flex; flex-wrap: wrap; gap: 10px; margin: 18px 0; }
label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
input, select, button { font: inherit; color: var(--fg); background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 8px; }
button { cursor: pointer; } button:disabled { opacity: .5; cursor: default; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.workspace { display: grid; grid-template-columns: 1.2fr 1fr; gap: 20px; }
.map { background: var(--card); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
svg { width: 100%; height: 360px; touch-action: none; }
.land { fill: var(--border); stroke: var(--bg); stroke-width: .5; }
.land.covered { fill: var(--accent); opacity: .6; cursor: pointer; }
.land.selected { fill: var(--severe); opacity: 1; }
.map-tools { display: flex; gap: 6px; padding: 10px; }
.story { border-bottom: 1px solid var(--border); padding: 12px 0; }
.story-title { font-size: 15px; font-weight: 600; }
.story-meta, .story-src { color: var(--muted); font-size: 12px; margin: 6px 0; }
.story-actions { display: flex; gap: 8px; margin-top: 8px; }
#list { max-height: 560px; overflow: auto; }
#detail { border: 1px solid var(--border); padding: 12px; margin: 12px 0; }
#status { min-height: 24px; color: var(--muted); }
@media (max-width: 650px) { .workspace { grid-template-columns: 1fr; } svg { height: 240px; } input { max-width: 180px; } }
`;

const BODY = `
<div class="head"><div class="title">News & maps</div><div class="badge">WorldMonitor</div></div>
<div id="status" role="status" aria-live="polite">Waiting for the host</div>
<div id="filters" class="controls" role="search">
<label>Search<input id="query" maxlength="200" type="search" placeholder="Headlines and sources"></label>
<label>Category<input id="category" maxlength="100" placeholder="All categories"></label>
<label>Source<input id="source" maxlength="200" placeholder="All outlets"></label>
<label>Country<input id="country" maxlength="80" placeholder="All countries"></label>
<label>Published<select id="period"><option value="0">All available</option><option value="1">Past hour</option><option value="24">Past day</option><option value="168">Past week</option></select></label>
<button id="apply" type="button" disabled>Apply filters</button>
</div>
<div class="empty" id="empty">Waiting for news intelligence...</div>
<div id="card" style="display:none">
<div class="workspace">
<section aria-label="News map"><div class="map">
<svg id="news-map" viewBox="0 0 900 450" role="img" aria-label="Country-level news context"><g id="geography"></g></svg>
<div class="map-tools"><button id="zoom-in" aria-label="Zoom in">+</button><button id="zoom-out" aria-label="Zoom out">−</button><button id="reset">World view</button></div>
</div><p class="story-meta">Country-level reporting context, not exact event locations. Drag to pan. Use arrow keys on the map to pan.</p></section>
<section aria-label="News stories"><div id="detail" hidden></div><div id="list"></div></section>
</div><div class="foot" id="foot"></div></div>
`;

const SETUP = `
  var newsState = { data: null, zoom: 1, x: 450, y: 225, country: "", arguments: {} };
  var newsCountries = ${JSON.stringify(countries).replace(/</g, '\\u003c')};
  var newsHost = { tools: false, links: false, ready: false };
  var previousShowError = showError;
  showError = function (message) { if (newsState.data) newsStatus(message); else previousShowError(message); };
  var pendingNews = null;
  var nextNewsId = 100;
  var latestNewsInput = {};
  var drag = null;
  var map = q("news-map");
  map.setAttribute("tabindex", "0");
  newsCountries.forEach(function (country) {
    var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", country.path);
    path.setAttribute("class", "land");
    path.setAttribute("data-country", country.code);
    var title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = country.name;
    path.appendChild(title);
    path.addEventListener("click", function () {
      if (path.classList.contains("covered")) focusNewsCountry(country.code);
    });
    q("geography").appendChild(path);
  });
  function newsStatus(text) { q("status").textContent = text; }
  function newsContext() {
    if (!newsHost.ready || !newsHost.context || !newsState.data) return;
    post({ jsonrpc: "2.0", id: nextNewsId++, method: "ui/update-model-context", params: {
      content: [{ type: "text", text: JSON.stringify({ app: "worldmonitor-news-intelligence", status: "applied", filters: newsState.arguments,
        map: { renderer: "svg", precision: "country", country: newsState.country, zoom: newsState.zoom, center: [newsState.x, newsState.y] } }) }]
    }});
  }
  function updateNewsMap() {
    map.setAttribute("viewBox", [newsState.x - 450 / newsState.zoom, newsState.y - 225 / newsState.zoom, 900 / newsState.zoom, 450 / newsState.zoom].join(" "));
    q("geography").querySelectorAll("path").forEach(function (path) {
      path.classList.toggle("selected", path.getAttribute("data-country") === newsState.country);
    });
    newsContext();
  }
  function focusNewsCountry(code) {
    var country = newsCountries.find(function (item) { return item.code === code; });
    if (!country) { newsStatus("No country geometry is available for this story."); return; }
    newsState.country = code; newsState.x = country.center[0]; newsState.y = country.center[1]; newsState.zoom = 3;
    updateNewsMap(); newsStatus("Showing " + country.name + " at country precision.");
  }
  function applyNewsInput(input) {
    latestNewsInput = input && typeof input === "object" ? input : {};
  }
  function commitNewsInput(input) {
    newsState.arguments = {};
    ["query", "source", "category", "country", "published_since", "map_zoom", "map_latitude", "map_longitude"].forEach(function (key) {
      if (typeof input[key] === "string" || typeof input[key] === "number") newsState.arguments[key] = input[key];
    });
    ["query", "source", "category", "country"].forEach(function (key) { q(key).value = typeof input[key] === "string" ? input[key] : ""; });
    if (typeof input.map_zoom === "number" && isFinite(input.map_zoom)) newsState.zoom = Math.max(1, Math.min(8, input.map_zoom));
    if (typeof input.country === "string") {
      var selected = newsCountries.find(function (country) { return country.code === input.country.toUpperCase() || country.name.toLowerCase() === input.country.toLowerCase(); });
      if (!selected && newsState.data) {
        var payload = newsState.data.data || newsState.data;
        var codes = new Set(listState(payload.insights && payload.insights.topStories).items.map(function (story) { return story.countryCode; }).filter(Boolean));
        if (codes.size === 1) selected = newsCountries.find(function (country) { return codes.has(country.code); });
      }
      if (selected) { newsState.country = selected.code; newsState.x = selected.center[0]; newsState.y = selected.center[1]; if (typeof input.map_zoom !== "number") newsState.zoom = 3; }
    }
    if (typeof input.map_longitude === "number" && isFinite(input.map_longitude)) newsState.x = (Math.max(-180, Math.min(180, input.map_longitude)) + 180) * 2.5;
    if (typeof input.map_latitude === "number" && isFinite(input.map_latitude)) newsState.y = (90 - Math.max(-90, Math.min(90, input.map_latitude))) * 2.5;
    updateNewsMap();
  }
  function requestNews(input) {
    if (!newsHost.tools) { newsStatus("This host does not support interactive tool calls. Ask the assistant to apply these filters."); return; }
    if (pendingNews) { newsStatus("A news request is already pending."); return; }
    var id = nextNewsId++;
    pendingNews = { id: id, input: input, timer: setTimeout(function () {
      if (pendingNews && pendingNews.id === id) { pendingNews = null; q("apply").disabled = false; newsStatus("The request timed out. Your previous view is unchanged. Retry when ready."); }
    }, 30000) };
    q("apply").disabled = true;
    newsStatus("Loading news...");
    post({ jsonrpc: "2.0", id: id, method: "tools/call", params: { name: "get_news_intelligence", arguments: input } });
  }
  function submitNewsFilters(event) {
    event.preventDefault();
    var input = { limit: 100, map_zoom: newsState.zoom };
    ["query", "source", "category", "country"].forEach(function (key) { var value = q(key).value.trim(); if (value) input[key] = value; });
    var hours = Number(q("period").value);
    if (hours) input.published_since = Date.now() - hours * 3600000;
    requestNews(input);
  }
  q("apply").onclick = submitNewsFilters;
  q("filters").addEventListener("keydown", function (event) { if (event.key === "Enter") submitNewsFilters(event); });
  q("zoom-in").onclick = function () { newsState.zoom = Math.min(8, newsState.zoom * 1.5); updateNewsMap(); };
  q("zoom-out").onclick = function () { newsState.zoom = Math.max(1, newsState.zoom / 1.5); updateNewsMap(); };
  q("reset").onclick = function () { newsState.zoom = 1; newsState.x = 450; newsState.y = 225; newsState.country = ""; updateNewsMap(); };
  map.onpointerdown = function (event) { drag = { x: event.clientX, y: event.clientY, startX: newsState.x, startY: newsState.y }; if (map.setPointerCapture) map.setPointerCapture(event.pointerId); };
  map.onpointermove = function (event) {
    if (!drag) return;
    var width = map.getBoundingClientRect().width || 900;
    newsState.x = Math.max(0, Math.min(900, drag.startX - (event.clientX - drag.x) * 900 / width / newsState.zoom));
    newsState.y = Math.max(0, Math.min(450, drag.startY - (event.clientY - drag.y) * 900 / width / newsState.zoom));
    map.setAttribute("viewBox", [newsState.x - 450 / newsState.zoom, newsState.y - 225 / newsState.zoom, 900 / newsState.zoom, 450 / newsState.zoom].join(" "));
  };
  map.onpointerup = map.onpointercancel = function () { if (drag) { drag = null; newsContext(); } };
  map.onkeydown = function (event) {
    var offsets = { ArrowLeft: [-30, 0], ArrowRight: [30, 0], ArrowUp: [0, -30], ArrowDown: [0, 30] };
    var offset = offsets[event.key]; if (!offset) return;
    event.preventDefault(); newsState.x = Math.max(0, Math.min(900, newsState.x + offset[0] / newsState.zoom)); newsState.y = Math.max(0, Math.min(450, newsState.y + offset[1] / newsState.zoom)); updateNewsMap();
  };
  window.addEventListener("message", function (event) {
    if (event.source !== parentWin) return;
    var msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    if (msg.id === 1 && msg.result) {
      var caps = msg.result.hostCapabilities || {};
      newsHost = { ready: true, tools: !!caps.serverTools, links: !!caps.openLinks, context: !!(caps.updateModelContext && caps.updateModelContext.text) };
      q("apply").disabled = !newsHost.tools;
      newsStatus(newsHost.tools ? "Ready" : "Read-only host. Ask the assistant to change filters.");
      newsContext();
    }
    if (msg.method === "ui/notifications/tool-input") applyNewsInput(msg.params && msg.params.arguments);
    if (pendingNews && msg.id === pendingNews.id) {
      var request = pendingNews; clearTimeout(request.timer); pendingNews = null; q("apply").disabled = !newsHost.tools;
      if (msg.error || !msg.result || msg.result.isError) { newsStatus("News request failed or access was denied. Your previous view is unchanged."); return; }
      var data = extractToolData(msg.result);
      if (!data || softError(data)) { newsStatus(softError(data) || "News response is unavailable."); return; }
      latestNewsInput = request.input;
      safeRender(data);
    }
  });
`;

const RENDER = `
    if (!data || typeof data !== "object") return;
    var d = data.data && typeof data.data === "object" ? data.data : data;
    var ins = d.insights && typeof d.insights === "object" ? d.insights : null;
    var state = listState(ins && ins.topStories);
    var stories = state.items;
    newsState.data = data;
    q("empty").style.display = "none";
    q("card").style.display = "block";
    q("detail").hidden = true;
    var host = q("list"); host.textContent = "";
    var covered = new Set();
    stories.forEach(function (story) {
      if (!story || typeof story !== "object") return;
      var code = typeof story.countryCode === "string" ? story.countryCode.toUpperCase() : "";
      if (code) covered.add(code);
      var row = el("article", "story");
      row.appendChild(el("div", "story-title", collapseWs(story.primaryTitle) || "Untitled story"));
      row.appendChild(el("div", "story-meta", [story.category, countryName(code), story.isAlert ? "Alert" : ""].filter(Boolean).join(" · ")));
      row.appendChild(el("div", "story-src", collapseWs(story.primarySource) + (story.sourceProvenance && story.sourceProvenance.summary ? " · " + collapseWs(story.sourceProvenance.summary) : "")));
      var actions = el("div", "story-actions");
      var details = el("button", "", "Details");
      details.onclick = function () {
        var panel = q("detail"); panel.textContent = ""; panel.hidden = false;
        panel.appendChild(el("h2", "story-title", collapseWs(story.primaryTitle)));
        var provenance = story.sourceProvenance;
        panel.appendChild(el("p", "story-src", provenance && provenance.summary ? collapseWs(provenance.summary) : "Source provenance is unavailable."));
        (Array.isArray(story.memberTitles) ? story.memberTitles : []).slice(0, 30).forEach(function (title) { panel.appendChild(el("p", "", collapseWs(title))); });
        var link = httpUrl(story.primaryLink);
        if (link) {
          var open = el("button", "", "Open source"); open.disabled = !newsHost.links;
          open.onclick = function () { post({ jsonrpc: "2.0", id: nextNewsId++, method: "ui/open-link", params: { url: link } }); };
          panel.appendChild(open);
          if (!newsHost.links) panel.appendChild(el("p", "story-src", "Source link: " + link));
        }
        var close = el("button", "", "Close details"); close.onclick = function () { panel.hidden = true; details.focus(); }; panel.appendChild(close); close.focus(); reportSize();
      };
      actions.appendChild(details);
      if (newsCountries.some(function (country) { return country.code === code; })) {
        var locate = el("button", "", "Show country"); locate.onclick = function () { focusNewsCountry(code); map.focus(); }; actions.appendChild(locate);
      }
      row.appendChild(actions); host.appendChild(row);
    });
    if (!host.childNodes.length) host.appendChild(el("div", "empty", state.available ? "No news stories available." : "News intelligence is temporarily unavailable."));
    q("geography").querySelectorAll("path").forEach(function (path) { path.classList.toggle("covered", covered.has(path.getAttribute("data-country"))); });
    commitNewsInput(latestNewsInput);
    q("foot").textContent = data.cached_at ? "Snapshot: " + collapseWs(data.cached_at) + (data.stale ? " (stale)" : "") : "Snapshot time unavailable";
    newsStatus(state.available ? (data.stale ? "Showing retained news. The snapshot is stale." : "Showing " + stories.length + " stories from the available snapshot.") : "News intelligence is unavailable. Retry through the filters.");
`;

export const NEWS_INTELLIGENCE_APP_HTML = buildAppHtml({
  title: 'News and maps | WorldMonitor',
  appName: 'worldmonitor-news-intelligence',
  styles: STYLES,
  body: BODY,
  setupBody: SETUP,
  renderBody: RENDER,
});
