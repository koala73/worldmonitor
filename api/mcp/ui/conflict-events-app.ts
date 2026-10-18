// MCP Apps (extension `io.modelcontextprotocol/ui`, spec 2026-01-26) — the
// interactive app shell for the `get_conflict_events` tool: an active armed-
// conflict event list rendering the UCDP events (belligerents, violence type,
// country, fatalities, date). Built on the shared shell foundation.
//
// Tool result shape (cache tool — content[0].text JSON, freshness envelope).
// The tool serves the raw UCDP cache value under label `ucdp-events`; each event
// carries `violenceType` as a UCDP_VIOLENCE_TYPE_* enum constant (see
// scripts/seed-ucdp-events.mjs), mapped here to a human label:
//   { cached_at, stale, data: {
//       "ucdp-events": { events: [{ sideA, sideB, violenceType, country,
//                                   deathsBest, dateStart }] },
//       events: {...}, scores: {...} } }  // unrest + CII buckets (not rendered here)
// The tool also returns unrest `events` and CII `scores` buckets in its text
// response; this widget focuses on the UCDP armed-conflict feed. Any label may
// be absent (country / min_fatalities filters narrow the bundle).
//
// textContent-only rendering; renderBody stays backtick/`${`/regex-free.

import { buildAppHtml } from './shell';
import { CONFLICT_MAP_BASE } from './_conflict-map-base';

const STYLES = `
  .evt { display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
    padding: 9px 0; border-bottom: 1px solid var(--border); }
  .evt:last-child { border-bottom: none; }
  .evt-main { min-width: 0; }
  .evt-sides { font-size: 13px; font-weight: 600; color: var(--fg); overflow-wrap: anywhere; }
  .evt-meta { font-size: 11px; color: var(--muted); margin-top: 2px; overflow-wrap: anywhere; }
  .evt-deaths { font-variant-numeric: tabular-nums; font-size: 12px; font-weight: 600; white-space: nowrap; }
  .evt[role="button"] { cursor: pointer; }
  .evt[aria-pressed="true"] { background: var(--card); box-shadow: inset 3px 0 var(--accent); padding-left: 8px; }
  .evt:focus-visible, .conflict-marker:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  #conflict-map { display: block; width: 100%; height: auto; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); }
  .conflict-land { fill: var(--card); stroke: var(--muted); stroke-width: 0.5; }
  .conflict-marker, #conflict-hit-targets { cursor: pointer; }
  .conflict-dot { fill: var(--high); stroke: var(--fg); stroke-width: 1; }
  .conflict-marker[aria-pressed="true"] .conflict-dot { fill: var(--accent); stroke-width: 2; }
  .conflict-marker text { fill: var(--fg); font-size: 10px; font-weight: 700; pointer-events: none; }
  .conflict-tools { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin: 8px 0; }
  #conflict-locations, #conflict-selection { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
  #conflict-selection { margin: 8px 0; }
  #conflict-chooser { display: flex; flex-wrap: wrap; gap: 6px; }
  .conflict-control { color: var(--fg); background: var(--card); border: 1px solid var(--border); border-radius: 4px; padding: 7px 10px; cursor: pointer; font: inherit; font-size: 12px; max-width: 100%; overflow-wrap: anywhere; }
  .conflict-control:focus-visible { outline: 2px solid var(--accent); }
  .conflict-control:disabled { opacity: 0.5; cursor: default; }
`;

const BODY = `
  <div class="head">
    <div class="title">Conflict Events</div>
    <div class="badge">WorldMonitor Conflict</div>
  </div>
  <div class="empty" id="empty">Waiting for conflict data…</div>
  <div id="card" style="display:none">
    <div id="conflict-geography">
      <div class="conflict-tools">
        <span id="conflict-locations"></span>
        <button type="button" id="conflict-world" class="conflict-control">World view</button>
      </div>
      <svg id="conflict-map" viewBox="0 0 ${CONFLICT_MAP_BASE.width} ${CONFLICT_MAP_BASE.height}" role="group" aria-label="Locations of displayed conflict events">
        <path class="conflict-land" d="${CONFLICT_MAP_BASE.path}" aria-hidden="true"></path>
        <g id="conflict-hit-targets" aria-hidden="true"></g>
        <g id="conflict-markers"></g>
      </svg>
      <div id="conflict-selection" role="status" aria-live="polite"></div>
      <div id="conflict-chooser" aria-label="Events at the selected location"></div>
    </div>
    <div id="list"></div>
    <div class="foot" id="foot"></div>
  </div>
`;

const RENDER = `
    if (!data || typeof data !== "object") return;
    var envelope = Object.prototype.hasOwnProperty.call(data, "projection") ? data.projection : data;
    var d = envelope && typeof envelope === "object"
      ? (envelope.data && typeof envelope.data === "object" ? envelope.data : envelope) : {};
    q("empty").style.display = "none";
    q("card").style.display = "block";

    var uc = d["ucdp-events"] && typeof d["ucdp-events"] === "object" ? d["ucdp-events"] : null;
    var eventValue = uc && uc.events;
    var eventState = listState(eventValue);
    var evs = eventState.items;
    var isSummary = eventValue && !Array.isArray(eventValue) && Array.isArray(eventValue.sample);
    var total = Array.isArray(eventValue) ? eventValue.length
      : isSummary && Number.isSafeInteger(eventValue.count) && eventValue.count >= evs.length ? eventValue.count : null;
    var shown = 0;
    var vtMap = {
      UCDP_VIOLENCE_TYPE_STATE_BASED: "State-based",
      UCDP_VIOLENCE_TYPE_NON_STATE: "Non-state",
      UCDP_VIOLENCE_TYPE_ONE_SIDED: "One-sided"
    };
    var host = q("list");
    host.textContent = "";
    var map = q("conflict-map");
    var markers = q("conflict-markers");
    var hitTargets = q("conflict-hit-targets");
    var chooser = q("conflict-chooser");
    var selection = q("conflict-selection");
    var geometry = ${JSON.stringify({ width: CONFLICT_MAP_BASE.width, height: CONFLICT_MAP_BASE.height, scale: CONFLICT_MAP_BASE.scale, translate: CONFLICT_MAP_BASE.translate })};
    var worldView = "0 0 " + geometry.width + " " + geometry.height;
    var locations = new Map();
    var selectable = [];
    markers.textContent = "";
    hitTargets.textContent = "";
    chooser.textContent = "";
    selection.textContent = "";
    map.setAttribute("viewBox", worldView);
    function clearSelection(keepChooser) {
      selectable.forEach(function(item) { item.row.setAttribute("aria-pressed", "false"); });
      locations.forEach(function(location) { location.marker.setAttribute("aria-pressed", "false"); });
      selection.textContent = "";
      if (!keepChooser) chooser.textContent = "";
    }
    function focusLocation(location) {
      var x = Math.max(0, Math.min(geometry.width - 180, location.x - 90));
      var y = Math.max(0, Math.min(geometry.height - 96, location.y - 48));
      map.setAttribute("viewBox", x + " " + y + " 180 96");
    }
    function selectEvent(item, keepChooser) {
      if (!host.contains(item.row)) return;
      clearSelection(keepChooser);
      item.row.setAttribute("aria-pressed", "true");
      item.location.marker.setAttribute("aria-pressed", "true");
      focusLocation(item.location);
      selection.textContent = item.label + " · Coordinates: " + item.location.latitude + ", " + item.location.longitude;
      reportSize();
    }
    function activate(node, action) {
      node.setAttribute("role", "button");
      node.setAttribute("tabindex", "0");
      node.setAttribute("aria-pressed", "false");
      node.addEventListener("click", action);
      node.addEventListener("keydown", function(event) {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); action(); }
      });
    }
    q("conflict-world").onclick = function() { clearSelection(); map.setAttribute("viewBox", worldView); reportSize(); };
    for (var i = 0; i < evs.length && i < 14; i++) {
      var ev = evs[i];
      if (!ev || typeof ev !== "object") continue;
      var row = el("div", "evt");
      var main = el("div", "evt-main");
      var a = collapseWs(ev.sideA);
      var b = collapseWs(ev.sideB);
      var vt = vtMap[collapseWs(ev.violenceType)] || "";
      var sides = a && b ? a + " vs " + b : (a || b || vt || "Event");
      main.appendChild(el("div", "evt-sides", sides));
      var metaParts = [];
      var ct = collapseWs(ev.country);
      if (ct) metaParts.push(ct);
      if (vt && a && b) metaParts.push(vt);
      var dv = ev.dateStart;
      var dt = dv != null ? new Date(typeof dv === "number" ? dv : String(dv)) : null;
      if (dt && !isNaN(dt.getTime())) metaParts.push(dt.toISOString().slice(0, 10));
      main.appendChild(el("div", "evt-meta", metaParts.join(" · ")));
      if (typeof ev.sourceOriginal === "string" && collapseWs(ev.sourceOriginal)) {
        main.appendChild(el("div", "evt-meta", "Source: " + collapseWs(ev.sourceOriginal)));
      }
      row.appendChild(main);
      var deaths = num(ev.deathsBest);
      if (deaths != null) {
        var badge = el("span", "evt-deaths", deaths.toLocaleString() + (deaths === 1 ? " death" : " deaths"));
        var dcol = deaths >= 100 ? cssVar("--severe") : (deaths >= 10 ? cssVar("--high") : (deaths >= 1 ? cssVar("--moderate") : cssVar("--muted")));
        badge.style.color = dcol || "";
        row.appendChild(badge);
      }
      host.appendChild(row);
      shown++;
      var latitude = ev.location && ev.location.latitude;
      var longitude = ev.location && ev.location.longitude;
      if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
        || typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        main.appendChild(el("div", "evt-meta", "Location unavailable"));
        continue;
      }
      var locationKey = latitude + "," + longitude;
      var location = locations.get(locationKey);
      if (!location) {
        location = { latitude: latitude, longitude: longitude, events: [],
          x: geometry.translate[0] + longitude * Math.PI / 180 * geometry.scale,
          y: geometry.translate[1] - latitude * Math.PI / 180 * geometry.scale };
        locations.set(locationKey, location);
      }
      var label = Array.from(row.querySelectorAll(".evt-sides, .evt-meta, .evt-deaths"))
        .map(function(node) { return node.textContent; }).join(" · ");
      var item = { key: i, row: row, location: location, label: label };
      location.events.push(item);
      selectable.push(item);
      row.setAttribute("data-event-key", String(i));
      activate(row, (function(current) { return function() { selectEvent(current); }; })(item));
    }
    locations.forEach(function(location) {
      var marker = document.createElementNS("http://www.w3.org/2000/svg", "g");
      location.marker = marker;
      marker.setAttribute("class", "conflict-marker");
      marker.setAttribute("transform", "translate(" + location.x + " " + location.y + ")");
      marker.setAttribute("aria-label", location.events.length === 1
        ? "Select " + location.events[0].label : "Choose " + location.events.length + " events at " + location.latitude + ", " + location.longitude);
      var hit = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      hit.setAttribute("r", "24"); hit.setAttribute("fill", "transparent");
      hit.setAttribute("transform", marker.getAttribute("transform")); hitTargets.appendChild(hit);
      var dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("r", location.events.length > 1 ? "8" : "5"); dot.setAttribute("class", "conflict-dot"); marker.appendChild(dot);
      if (location.events.length > 1) {
        var count = document.createElementNS("http://www.w3.org/2000/svg", "text");
        count.setAttribute("text-anchor", "middle"); count.setAttribute("dy", "3"); count.textContent = String(location.events.length); marker.appendChild(count);
      }
      function chooseLocation() {
        if (!host.contains(location.events[0].row)) return;
        if (location.events.length === 1) { selectEvent(location.events[0]); return; }
        clearSelection(); focusLocation(location);
        selection.textContent = "Choose one of " + location.events.length + " events at " + location.latitude + ", " + location.longitude + ".";
        location.events.forEach(function(item) {
          var button = el("button", "conflict-control", item.label);
          button.type = "button"; button.onclick = function() { selectEvent(item, true); }; chooser.appendChild(button);
        });
        reportSize();
      }
      activate(marker, chooseLocation);
      hit.addEventListener("click", chooseLocation);
      markers.appendChild(marker);
    });
    q("conflict-geography").hidden = shown === 0;
    map.style.display = selectable.length ? "block" : "none";
    q("conflict-world").disabled = selectable.length === 0;
    q("conflict-locations").textContent = selectable.length
      ? "Locations for " + selectable.length + " of " + shown + " displayed events."
      : "Locations unavailable for the displayed events.";
    if (!host.childNodes.length) {
      host.appendChild(el("div", "empty", eventState.available
        ? (isSummary && total !== 0 ? "Summary contains no supplied event samples." : "No conflict events available.")
        : "Conflict event data is temporarily unavailable."));
    }

    var footParts = [];
    if (eventState.available) {
      footParts.push(isSummary
        ? "Summary sample: " + shown + (total == null ? " UCDP events; total unknown." : " of " + total + " UCDP events.")
        : "Showing " + shown + " of " + total + " loaded UCDP events.");
    }
    if (uc) {
      var source = envelope && envelope.conflict_source && envelope.conflict_source.ucdp || {};
      var fetchedPartial = [source.candidateVersion, uc.candidateVersion].some(function(version) {
        return typeof version === "string" && version.endsWith("+partial");
      });
      var incomplete = source.candidateComplete === false || uc.candidateComplete === false || fetchedPartial;
      var confirmed = source.candidateComplete === true || uc.candidateComplete === true;
      footParts.push(incomplete ? "Candidate completeness not confirmed."
        : confirmed ? "Candidate completeness confirmed." : "Candidate completeness unknown.");
      if (fetchedPartial) footParts.push("Candidate release fetched partially.");
      var sourceFailures = source.annualFailedPages;
      var payloadFailures = uc.annualFailedPages;
      var sourceFailuresKnown = Number.isSafeInteger(sourceFailures) && sourceFailures >= 0;
      var payloadFailuresKnown = Number.isSafeInteger(payloadFailures) && payloadFailures >= 0;
      if (sourceFailuresKnown && payloadFailuresKnown && sourceFailures !== payloadFailures) {
        footParts.push("Annual base failed-page counts disagree: source metadata " + sourceFailures
          + "; events payload " + payloadFailures + ".");
      } else {
        var failedPages = sourceFailuresKnown ? sourceFailures : payloadFailuresKnown ? payloadFailures : null;
        footParts.push(failedPages != null
          ? "Annual base pages failed: " + failedPages + "." : "Annual base failed-page count unknown.");
      }
    }
    if (d.partial === true && d.truncation && typeof d.truncation === "object") {
      var returnedCount = num(d.truncation.returned_event_count);
      var originalCount = num(d.truncation.original_event_count);
      if (returnedCount != null && originalCount != null) {
        footParts.push("Source response includes " + returnedCount.toLocaleString() + " of "
          + originalCount.toLocaleString() + " events (output limit).");
      }
    }
    if (envelope && envelope.cached_at) {
      footParts.push("Snapshot: " + collapseWs(envelope.cached_at) + (envelope.stale ? " (stale)" : ""));
    }
    q("foot").textContent = footParts.join(" ");
`;

export const CONFLICT_EVENTS_APP_HTML = buildAppHtml({
  title: 'Conflict Events — WorldMonitor',
  appName: 'worldmonitor-conflict-events',
  styles: STYLES,
  body: BODY,
  renderBody: RENDER,
});
