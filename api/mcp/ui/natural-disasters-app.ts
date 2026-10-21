import { buildAppHtml } from './shell';
import { CONFLICT_MAP_BASE as NATURAL_MAP_BASE } from './_conflict-map-base';

const STYLES = `
  .natural-map-wrap { margin-top: 12px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  #natural-map { width: 100%; display: block; background: var(--surface); }
  .natural-land { fill: var(--muted); opacity: 0.3; }
  .natural-controls { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
  .natural-controls button, .natural-select, #natural-chooser button, #natural-selection button { font: inherit; font-size: 12px; color: var(--fg); background: var(--surface); border: 1px solid var(--border); border-radius: 5px; padding: 6px 9px; cursor: pointer; }
  button[aria-pressed="true"] { border-color: var(--high); background: var(--border); }
  button:focus-visible, .natural-marker:focus-visible { outline: 3px solid var(--high); outline-offset: 3px; }
  .natural-marker { fill: var(--high); stroke: var(--fg); stroke-width: 1; cursor: pointer; vector-effect: non-scaling-stroke; }
  .natural-controls button[data-layer="earthquakes"] { border-left: 5px solid var(--high); }
  .natural-controls button[data-layer="fires"] { border-left: 5px solid var(--severe); }
  .natural-controls button[data-layer="events"] { border-left: 5px solid var(--moderate); }
  .natural-marker.fires { fill: var(--severe); }
  .natural-marker.events { fill: var(--moderate); }
  .natural-marker[aria-pressed="true"] { stroke: var(--fg); stroke-width: 4; }
  .natural-target { fill: transparent; cursor: pointer; }
  .natural-selected { background: var(--border); }
  .natural-geometry { pointer-events: none; fill: none; stroke: var(--high); stroke-width: 2; }
  .natural-geometry.pastTrack { stroke: var(--fg); stroke-dasharray: 4 3; }
  .natural-geometry.conePolygon { fill: var(--moderate); fill-opacity: 0.22; stroke: var(--moderate); }
  #natural-selection, #natural-chooser { overflow-wrap: anywhere; }
  #natural-selection:not(:empty), #natural-chooser:not(:empty) { padding: 10px; border: 1px solid var(--border); border-radius: 6px; margin: 8px 0; }
  #natural-selection .dtime, #natural-selection a { display: block; margin: 5px 0; }
  #natural-chooser button { margin: 4px; }

  .dgroup { margin-top: 14px; }
  .dgroup:first-child { margin-top: 4px; }
  .sec-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 6px; }
  .drow { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--border); }
  .drow:last-child { border-bottom: none; }
  .mag { font-variant-numeric: tabular-nums; font-weight: 700; font-size: 13px; min-width: 52px; }
  .dplace { flex: 1 1 10rem; font-size: 13px; color: var(--fg); min-width: 0; overflow-wrap: anywhere; }
  .dcounts, .dwarning { font-size: 12px; color: var(--muted); margin: 6px 0; }
  .dwarning { color: var(--high); }
  .dtime { font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }
  .dprovider { font-size: 12px; line-height: 1.6; margin: 8px 0; padding: 8px; border: 1px solid var(--border); border-radius: 6px; overflow-wrap: anywhere; }
  .dprovider-title { font-weight: 600; }
`;

const BODY = `
  <div class="head">
    <div class="title" id="natural-heading" role="heading" aria-level="1" tabindex="-1">Natural Disasters</div>
    <div class="badge">WorldMonitor Hazards</div>
  </div>
  <div class="empty" id="empty">Waiting for hazard data…</div>
  <div id="card" style="display:none">
    <div class="natural-controls" id="natural-layers" aria-label="Hazard map layers"></div>
    <div class="natural-controls"><button type="button" id="natural-world">World view</button></div>
    <div class="dcounts" id="natural-map-status" role="status"></div>
    <div class="natural-map-wrap">
      <svg id="natural-map" viewBox="0 0 ${NATURAL_MAP_BASE.width} ${NATURAL_MAP_BASE.height}" role="group" aria-label="Reported locations of displayed hazard events">
        <defs><clipPath id="natural-map-clip"><rect width="${NATURAL_MAP_BASE.width}" height="${NATURAL_MAP_BASE.height}"></rect></clipPath></defs>
        <path class="natural-land" d="${NATURAL_MAP_BASE.path}" aria-hidden="true"></path>
        <g clip-path="url(#natural-map-clip)"><g id="natural-overlays" aria-hidden="true" pointer-events="none"></g><g id="natural-targets"></g><g id="natural-markers"></g></g>
      </svg>
    </div>
    <div id="natural-chooser"></div>
    <div id="natural-selection" aria-live="polite"></div>
    <div id="groups"></div>
    <div class="foot" id="foot"></div>
  </div>
`;

const RENDER = `
    if (!data || typeof data !== "object") return;
    var envelope = data.projection && typeof data.projection === "object" && !Array.isArray(data.projection)
      ? data.projection : data;
    var datasets = envelope.data && typeof envelope.data === "object" ? envelope.data : envelope;
    q("empty").style.display = "none";
    q("card").style.display = "block";
    var host = q("groups");
    var focused = document.activeElement;
    var restoreOwnedFocus = [host, q("natural-layers"), q("natural-markers"), q("natural-chooser"), q("natural-selection")].some(function(node) { return node && node.contains(focused); });
    host.textContent = "";
    var selectedCount = 0;
    var emptyCount = 0;
    var coverageLimited = false;

    var detailCoverage = envelope.transportCoverage;
    if (detailCoverage && detailCoverage.count_scope === "post_filter_snapshot" && Array.isArray(detailCoverage.details)) {
      var detailLabels = { conePolygon: "Cone points", forecastTrack: "Forecast track points", pastTrack: "Past track points", events: "Regional events", warnings: "Regional warnings" };
      var displayedCounts = {};
      detailCoverage.details.forEach(function (detail) {
        if (!detail || typeof detail !== "object" || !Object.prototype.hasOwnProperty.call(detailLabels, detail.field)
          || ["geometry_simplified", "output_budget"].indexOf(detail.omission_reason) < 0) return;
        if (typeof detail.original_count !== "number" || !Number.isSafeInteger(detail.original_count) || detail.original_count < 0
          || typeof detail.returned_count !== "number" || !Number.isSafeInteger(detail.returned_count)
          || detail.returned_count < 0 || detail.returned_count > detail.original_count) return;
        var count = displayedCounts[detail.field] || { original: 0, returned: 0 };
        count.original += detail.original_count; count.returned += detail.returned_count;
        displayedCounts[detail.field] = count;
      });
      if (Object.keys(displayedCounts).length) {
        warning(host, "Some detail was simplified or omitted for display. Full original detail is not loaded.");
        Object.keys(displayedCounts).forEach(function (field) {
          var count = displayedCounts[field];
          host.appendChild(el("div", "dcounts", detailLabels[field] + ": " + count.returned + " returned from " + count.original + " original items."));
        });
      }
    }

    function eventTime(value, label, missing) {
      var date = typeof value === "number" || typeof value === "string" && value.trim()
        ? new Date(value) : null;
      return date && Number.isFinite(date.getTime()) ? label + date.toISOString() : missing;
    }
    function group(key, label, field) {
      if (!Object.prototype.hasOwnProperty.call(datasets, key)) return null;
      selectedCount++;
      var bucket = datasets[key] && typeof datasets[key] === "object" ? datasets[key] : null;
      var list = bucket && bucket[field];
      var state = listState(list);
      var section = el("div", "dgroup");
      section.appendChild(el("div", "sec-label", label));
      host.appendChild(section);
      var knownEmpty = Array.isArray(list) ? list.length === 0
        : state.available && list.count === 0 && state.items.length === 0;
      if (knownEmpty) emptyCount++;
      var missingLabel = key === "earthquakes" ? "Earthquake" : key === "fires" ? "Wildfire" : label;
      if (!state.available) section.appendChild(el("div", "empty", missingLabel + " data is temporarily unavailable."));
      return { section: section, bucket: bucket, list: list, items: state.items, available: state.available, knownEmpty: knownEmpty };
    }
    function counts(view, shown) {
      if (!view.available) return;
      var message;
      if (Array.isArray(view.list)) message = "Showing " + shown + " of " + view.list.length + " loaded events.";
      else {
        var total = view.list.count;
        var known = typeof total === "number" && Number.isInteger(total) && total >= view.items.length;
        message = "Showing " + shown + " sampled events" + (known ? " of " + total + " reported events." : "; total unavailable.");
        message += known && total === view.items.length ? " Sample contains all reported events." : " Full list is not loaded.";
      }
      view.section.appendChild(el("div", "dcounts", message));
    }
    function warning(section, message) {
      coverageLimited = true;
      section.appendChild(el("div", "dwarning", message));
    }
    function providerState(view, field, label) {
      var state = view.bucket && view.bucket[field];
      if (typeof state === "string" && state !== "ok") warning(view.section, label + " coverage is " + collapseWs(state) + ".");
    }
    function sourceCounter(value) {
      return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? String(value) : "Unknown";
    }
    function sourceBoolean(value) {
      return typeof value === "boolean" ? String(value) : "Unknown";
    }
    function sourceText(value) {
      return typeof value === "string" && value.trim() ? collapseWs(value) : "Unknown";
    }
    function sourceError(value) {
      return value === null ? "None reported" : sourceText(value);
    }
    function detailBlock(section, title, lines) {
      var block = el("div", "dprovider");
      block.appendChild(el("div", "dprovider-title", title));
      lines.forEach(function (line) { block.appendChild(el("div", "", line)); });
      section.appendChild(block);
    }
    function wildfireDetails(view) {
      var bucket = view.bucket || {};
      if (!Object.keys(bucket).some(function (key) { return /^_(firms|cwfis|bc)/.test(key); })) {
        detailBlock(view.section, "Wildfire sources", ["Provider detail: Unknown"]);
        return;
      }
      detailBlock(view.section, "NASA FIRMS", [
        "State: " + sourceText(bucket._firmsState) + " · Source detections: " + sourceCounter(bucket._firmsCount),
        "Partial: " + sourceBoolean(bucket._firmsPartial) + " · Failed calls: " + sourceCounter(bucket._firmsFailedCalls) + " · Error: " + sourceError(bucket._firmsErrorCode)
      ]);
      detailBlock(view.section, "Canadian CWFIS", [
        "State: " + sourceText(bucket._cwfisState) + " · Source detections: " + sourceCounter(bucket._cwfisCount),
        "Active: " + sourceCounter(bucket._cwfisActiveCount) + " · Prescribed: " + sourceCounter(bucket._cwfisPrescribedCount) + " · Error: " + sourceError(bucket._cwfisErrorCode)
      ]);
      detailBlock(view.section, "British Columbia", [
        "State: " + sourceText(bucket._bcState) + " · Source records: " + sourceCounter(bucket._bcCount) + " · Transport: " + sourceText(bucket._bcVia),
        "Enriched: " + sourceCounter(bucket._bcEnrichedCount) + " · Appended: " + sourceCounter(bucket._bcAppendedCount) + " · Error: " + sourceError(bucket._bcErrorCode)
      ]);
    }
    function regionalDetails(view, region, coverage) {
      if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) {
        detailBlock(view.section, region.label, ["Provider detail: Unknown"]);
        return;
      }
      var supplied = coverage.sourceDecisions;
      var sampled = supplied && typeof supplied === "object" && !Array.isArray(supplied) && Array.isArray(supplied.sample);
      var decisions = Array.isArray(supplied) ? supplied : sampled ? supplied.sample : null;
      var lines = [];
      if (!decisions) lines.push("Provider detail: Unknown");
      else {
        if (sampled) {
          var knownTotal = sourceCounter(supplied.count) !== "Unknown" && supplied.count >= decisions.length;
          lines.push("Showing " + decisions.length + " sampled source decisions" + (knownTotal ? " of " + supplied.count + " reported source decisions." : "; total: Unknown.") + " Full decision list is not loaded.");
        }
        if (!decisions.length) lines.push("No source decisions supplied.");
        decisions.forEach(function (decision) {
          var item = decision && typeof decision === "object" && !Array.isArray(decision) ? decision : {};
          lines.push(sourceText(item.source) + " · " + sourceText(item.status) + " · " + sourceText(item.reason)
            + " · Optional: " + sourceBoolean(item.optional) + " · Requests: " + sourceCounter(item.requestCount)
            + " · Decision check time: " + eventTime(item.checkedAt, "", "Unknown"));
        });
      }
      lines.push("Dataset fetch time: " + eventTime(view.bucket.fetchedAt, "", "Unknown"));
      lines.push("Evaluation time: " + eventTime(coverage.evaluatedAt, "", "Unknown"));
      lines.push("latestObservationAt (supplied): " + eventTime(coverage.latestObservationAt, "", "Unknown") + " · May use evaluation time as a fallback. Original publication is not established.");
      detailBlock(view.section, region.label, lines);
    }

    var geo = ${JSON.stringify({ width: NATURAL_MAP_BASE.width, height: NATURAL_MAP_BASE.height, scale: NATURAL_MAP_BASE.scale, translate: NATURAL_MAP_BASE.translate })};
    var map = q("natural-map"), markers = q("natural-markers"), targets = q("natural-targets");
    var overlays = q("natural-overlays"), chooser = q("natural-chooser"), selection = q("natural-selection");
    var toolbar = q("natural-layers"), mapStatus = q("natural-map-status");
    var world = "0 0 " + geo.width + " " + geo.height;
    var items = [], locations = new Map(), selectedKey = null;
    var layers = { earthquakes: { label: "Earthquakes" }, fires: { label: "Wildfires" }, events: { label: "Other natural events" } };
    [markers, targets, overlays, chooser, selection, toolbar].forEach(function(node) { node.textContent = ""; });
    map.setAttribute("viewBox", world);
    chooser.onkeydown = null;
    function layoutChanged() { requestAnimationFrame(function() { reportSize(); }); }
    function svg(tag, attributes) {
      var node = document.createElementNS("http://www.w3.org/2000/svg", tag);
      Object.keys(attributes).forEach(function(key) { node.setAttribute(key, String(attributes[key])); });
      return node;
    }
    function projected(point) {
      return [geo.translate[0] + point[0] * Math.PI / 180 * geo.scale,
        geo.translate[1] - point[1] * Math.PI / 180 * geo.scale];
    }
    function point(lon, lat) {
      return typeof lon === "number" && Number.isFinite(lon) && lon >= -180 && lon <= 180
        && typeof lat === "number" && Number.isFinite(lat) && lat >= -90 && lat <= 90 ? [lon, lat] : null;
    }
    function objectPoint(value) {
      return value && typeof value === "object" && !Array.isArray(value)
        && Object.prototype.hasOwnProperty.call(value, "lon") && Object.prototype.hasOwnProperty.call(value, "lat")
        ? point(value.lon, value.lat) : null;
    }
    function delta(fromLongitude, toLongitude) {
      var longitudeDelta = toLongitude - fromLongitude;
      if (longitudeDelta > 180) longitudeDelta -= 360;
      if (longitudeDelta < -180) longitudeDelta += 360;
      return Math.abs(longitudeDelta) === 180 ? null : longitudeDelta;
    }
    function path(points, closed) {
      return points.map(function(vertex, vertexIndex) {
        var xy = projected(vertex);
        return (vertexIndex ? "L" : "M") + Number(xy[0].toFixed(3)) + "," + Number(xy[1].toFixed(3));
      }).join("") + (closed ? "Z" : "");
    }
    function rejected(reason) { return { paths: [], status: "Returned geometry retained; not drawn: " + reason }; }
    function localLimit(reason) { return rejected("local display limit or ambiguous geometry (" + reason + ")"); }
    function track(value) {
      if (value.length > 512) return localLimit("more than 512 track entries");
      var edges = [], previous = null, longitude = 0, low = 0, high = 0, invalid = false;
      for (var entryIndex = 0; entryIndex < value.length; entryIndex++) {
        var current = objectPoint(value[entryIndex]);
        if (!current) { previous = null; invalid = true; continue; }
        if (!previous) { longitude = current[0]; low = longitude; high = longitude; }
        else {
          var longitudeDelta = delta(previous[0], current[0]);
          if (longitudeDelta === null) return localLimit("ambiguous 180-degree track edge");
          longitude += longitudeDelta; low = Math.min(low, longitude); high = Math.max(high, longitude);
          if (high - low > 180) return localLimit("track span or repeated winding exceeds 180 degrees");
          if (longitudeDelta !== 0 || current[1] !== previous[1]) edges.push([previous, [previous[0] + longitudeDelta, current[1]]]);
        }
        previous = current;
      }
      var paths = [], vertices = 0;
      edges.forEach(function(edge) {
        [-360, 0, 360].forEach(function(shift) {
          var shiftedStart = [edge[0][0] + shift, edge[0][1]], shiftedEnd = [edge[1][0] + shift, edge[1][1]];
          var dx = shiftedEnd[0] - shiftedStart[0], start = 0, end = 1;
          if (dx === 0) { if (shiftedStart[0] < -180 || shiftedStart[0] > 180) return; }
          else {
            var firstBoundaryFraction = (-180 - shiftedStart[0]) / dx, secondBoundaryFraction = (180 - shiftedStart[0]) / dx;
            start = Math.max(0, Math.min(firstBoundaryFraction, secondBoundaryFraction)); end = Math.min(1, Math.max(firstBoundaryFraction, secondBoundaryFraction));
          }
          if (end <= start) return;
          var pair = [start, end].map(function(fraction) { return [Math.max(-180, Math.min(180, shiftedStart[0] + dx * fraction)), shiftedStart[1] + (shiftedEnd[1] - shiftedStart[1]) * fraction]; });
          paths.push(path(pair, false)); vertices += 2;
        });
      });
      if (vertices > 2048) return localLimit("track output vertices");
      return { paths: paths, status: invalid ? paths.length ? "Supplied geometry invalid/unavailable; valid separated segments are partial." : "Supplied geometry invalid/unavailable; no valid track segments can be drawn." : "Returned supplied geometry; full original detail is not established." };
    }
    function clipRing(points, boundary, keepGreater) {
      var result = [];
      for (var vertexIndex = 0; vertexIndex < points.length; vertexIndex++) {
        var previousVertex = points[(vertexIndex + points.length - 1) % points.length], currentVertex = points[vertexIndex];
        var previousInside = keepGreater ? previousVertex[0] >= boundary : previousVertex[0] <= boundary;
        var currentInside = keepGreater ? currentVertex[0] >= boundary : currentVertex[0] <= boundary;
        if (previousInside !== currentInside) {
          var intersectionFraction = (boundary - previousVertex[0]) / (currentVertex[0] - previousVertex[0]);
          result.push([boundary, previousVertex[1] + intersectionFraction * (currentVertex[1] - previousVertex[1])]);
        }
        if (currentInside) result.push(currentVertex);
      }
      return result;
    }
    function cones(value) {
      if (value.length > 16) return localLimit("more than 16 cone rings");
      var total = 0, rings = [];
      for (var ringIndex = 0; ringIndex < value.length; ringIndex++) {
        var ring = value[ringIndex], tuples = Array.isArray(ring);
        var values = tuples ? ring : ring && typeof ring === "object" ? ring.points : null;
        if (Array.isArray(values)) {
          total += values.length;
          if (total > 512) return localLimit("more than 512 cone vertices");
        }
        rings.push({ values: values, tuples: tuples });
      }
      var paths = [], vertices = 0, invalid = false;
      for (var ringIndex = 0; ringIndex < rings.length; ringIndex++) {
        var input = rings[ringIndex], points = [], bad = false;
        if (!Array.isArray(input.values)) { invalid = true; continue; }
        for (var vertexIndex = 0; vertexIndex < input.values.length; vertexIndex++) {
          var suppliedVertex = input.values[vertexIndex];
          var vertex = input.tuples ? Array.isArray(suppliedVertex) && suppliedVertex.length === 2 ? point(suppliedVertex[0], suppliedVertex[1]) : null : objectPoint(suppliedVertex);
          if (!vertex) { bad = true; break; }
          if (!points.length || vertex[0] !== points[points.length - 1][0] || vertex[1] !== points[points.length - 1][1]) points.push(vertex);
        }
        while (points.length > 1 && points[0][0] === points[points.length - 1][0] && points[0][1] === points[points.length - 1][1]) points.pop();
        var distinct = new Set(points.map(function(vertex) { return vertex[0] + "," + vertex[1]; }));
        if (bad || distinct.size < 3 || distinct.size !== points.length) { invalid = true; continue; }
        var unwrapped = [points[0]], longitude = points[0][0], low = longitude, high = longitude;
        for (var vertexIndex = 1; vertexIndex <= points.length; vertexIndex++) {
          var longitudeDelta = delta(points[vertexIndex - 1][0], points[vertexIndex % points.length][0]);
          if (longitudeDelta === null) return localLimit("ambiguous 180-degree cone edge");
          longitude += longitudeDelta; low = Math.min(low, longitude); high = Math.max(high, longitude);
          if (high - low > 180) return localLimit("cone span or repeated winding exceeds 180 degrees");
          if (vertexIndex < points.length) unwrapped.push([longitude, points[vertexIndex][1]]);
        }
        if (Math.abs(longitude - points[0][0]) > 1e-8) return localLimit("nonzero cone winding");
        [-360, 0, 360].forEach(function(shift) {
          var copy = unwrapped.map(function(vertex) { return [vertex[0] + shift, vertex[1]]; });
          copy = clipRing(clipRing(copy, -180, true), 180, false);
          if (copy.length < 3 || new Set(copy.map(function(vertex) { return vertex[0] + "," + vertex[1]; })).size < 3) return;
          paths.push(path(copy, true)); vertices += copy.length;
        });
      }
      if (vertices > 8192) return localLimit("cone output vertices");
      return { paths: paths, status: invalid ? paths.length ? "Supplied geometry invalid/unavailable; valid rings are partial." : "Supplied geometry invalid/unavailable; no valid cone rings can be drawn." : "Returned supplied geometry; seam intersections and ring closure are display calculations, not observations. Full original detail is not established." };
    }
    function geometryFor(item) {
      var fields = ["forecastTrack", "pastTrack", "conePolygon"], used = 0;
      return fields.map(function(field) {
        var value = item.raw[field], result;
        var omitted = detailCoverage && detailCoverage.count_scope === "post_filter_snapshot" && Array.isArray(detailCoverage.details)
          && detailCoverage.details.some(function(detail) {
            return detail && detail.dataset === "events" && detail.collection === "events.events"
              && Number.isSafeInteger(detail.event_index) && detail.event_index === item.index
              && detail.field === field && detail.state === "available" && detail.omission_reason === "output_budget"
              && Number.isSafeInteger(detail.original_count) && detail.original_count > 0
              && detail.returned_count === 0 && detail.omitted_count === detail.original_count && detail.geometry_simplified === false;
          });
        if (value == null) result = { paths: [], status: omitted ? "Geometry not loaded: omitted by transport." : "Geometry not supplied." };
        else if (!Array.isArray(value)) result = rejected("supplied geometry invalid/unavailable");
        else if (!value.length) result = { paths: [], status: omitted ? "Geometry not loaded: omitted by transport." : "No geometry points supplied." };
        else result = field === "conePolygon" ? cones(value) : track(value);
        var chars = result.paths.reduce(function(count, pathData) { return count + pathData.length; }, 0);
        if (used + chars > 400000) result = localLimit("400000 path character budget");
        else used += chars;
        result.field = field;
        return result;
      });
    }
    function registerRow(dataset, index, raw, row, label) {
      var location = dataset === "events" ? raw : raw.location;
      var reported = dataset === "events" ? objectPoint(location) : location && typeof location === "object"
        && Object.prototype.hasOwnProperty.call(location, "longitude") && Object.prototype.hasOwnProperty.call(location, "latitude")
        ? point(location.longitude, location.latitude) : null;
      var item = { key: dataset + ":" + index, dataset: dataset, index: index, raw: raw, row: row, label: label, point: reported };
      items.push(item);
      if (!reported) { row.appendChild(el("span", "dtime", "No valid coordinates supplied")); return; }
      var button = el("button", "natural-select", "Select location");
      button.type = "button"; button.setAttribute("data-select", item.key); button.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-label", "Select location: " + label);
      button.onclick = function() {
        if (!layers[dataset].visible) { layers[dataset].visible = true; syncLayers(); }
        selectItem(item); button.focus();
      };
      row.appendChild(button); item.button = button;
      var key = reported[1] + "," + reported[0], entry = locations.get(key);
      if (!entry) { entry = { key: key, point: reported, items: [] }; locations.set(key, entry); }
      entry.items.push(item); item.location = entry;
    }
    function clearSelection() {
      selectedKey = null; chooser.textContent = ""; chooser.onkeydown = null; selection.textContent = ""; overlays.textContent = "";
      map.setAttribute("viewBox", world);
      items.forEach(function(item) { if (item.button) item.button.setAttribute("aria-pressed", "false"); item.row.classList.remove("natural-selected"); });
      locations.forEach(function(entry) { if (entry.marker) { entry.marker.setAttribute("aria-pressed", "false"); entry.marker.setAttribute("aria-label", entry.label); } });
    }
    function selectItem(item) {
      clearSelection(); selectedKey = item.key;
      item.button.setAttribute("aria-pressed", "true"); item.row.classList.add("natural-selected");
      item.location.marker.setAttribute("aria-pressed", "true");
      item.location.marker.setAttribute("aria-label", item.location.label + "; selected " + itemLabel(item));
      selection.appendChild(el("div", "dprovider-title", item.label + " · Reported coordinates: " + item.point[1] + ", " + item.point[0]));
      Array.from(item.row.children).forEach(function(child) { if (child.classList.contains("dtime") || child.classList.contains("mag") || child.tagName === "A") selection.appendChild(child.cloneNode(true)); });
      var geometry = item.dataset === "events" ? geometryFor(item) : [];
      if (!geometry.some(function(overlay) { return overlay.paths.length; })) {
        var xy = projected(item.point);
        map.setAttribute("viewBox", Math.max(0, Math.min(geo.width - 180, xy[0] - 90)) + " " + Math.max(0, Math.min(geo.height - 96, xy[1] - 48)) + " 180 96");
      }
      geometry.forEach(function(overlay) {
        var group = svg("g", { "data-geometry": overlay.field, "aria-hidden": "true", "pointer-events": "none", "class": "natural-geometry " + overlay.field });
        overlay.paths.forEach(function(pathData) { group.appendChild(svg("path", { "d": pathData })); }); overlays.appendChild(group);
        var label = { forecastTrack: "Forecast track", pastTrack: "Past track", conePolygon: "Cone" }[overlay.field];
        var status = el("div", "dtime", label + ": " + overlay.status); selection.appendChild(status);
        if (overlay.paths.length) {
          var toggle = el("button", "", label); toggle.type = "button";
          toggle.setAttribute("data-overlay", overlay.field); toggle.setAttribute("aria-pressed", "true");
          toggle.onclick = function() {
            var visible = toggle.getAttribute("aria-pressed") !== "true";
            toggle.setAttribute("aria-pressed", String(visible)); group.style.display = visible ? "" : "none"; layoutChanged();
          };
          selection.appendChild(toggle);
        }
      });
      layoutChanged();
    }
    function itemLabel(item) { return layers[item.dataset].label + " · " + item.label; }
    function visibleItems(entry) { return entry.items.filter(function(item) { return layers[item.dataset].visible; }); }
    function syncLayers() {
      Object.keys(layers).forEach(function(key) { layers[key].button.setAttribute("aria-pressed", String(layers[key].visible)); });
      locations.forEach(function(entry) {
        var members = visibleItems(entry), visible = members.length > 0;
        entry.marker.style.display = visible ? "" : "none"; entry.target.style.display = visible ? "" : "none";
        entry.label = members.length === 1 ? "Select " + itemLabel(members[0]) : "Choose " + members.length + " events at " + entry.key + ": " + members.map(itemLabel).join("; ");
        var chosen = members.find(function(item) { return item.key === selectedKey; });
        entry.marker.setAttribute("aria-label", entry.label + (chosen ? "; selected " + itemLabel(chosen) : ""));
        if (members.length) entry.marker.setAttribute("class", "natural-marker " + members[0].dataset);
      });
      var valid = items.filter(function(item) { return item.point && layers[item.dataset].visible; }).length;
      mapStatus.textContent = Object.keys(layers).some(function(key) { return layers[key].visible; })
        ? valid + " valid locations among " + items.length + " displayed rows. Map covers only displayed rows; reported coordinates are not independently verified."
        : Object.keys(layers).some(function(key) { return !layers[key].button.disabled; })
          ? "Layers hidden. Source rows and coverage remain below." : "Map locations unavailable for supplied datasets. See source coverage below.";
    }
    function finishMap(views) {
      Object.keys(layers).forEach(function(key) {
        var layer = layers[key], view = views[key], available = view && view.available;
        layer.visible = Boolean(available);
        var label = !view ? "Not included" : !available ? "Unavailable" : view.knownEmpty ? "No events in this supplied snapshot" : !view.items.length ? "No sample rows loaded" : "";
        var button = el("button", "", layer.label + (label ? " · " + label : ""));
        button.type = "button"; button.setAttribute("data-layer", key); button.disabled = !available;
        layer.button = button; toolbar.appendChild(button);
        button.onclick = function() {
          layer.visible = !layer.visible;
          if (!layer.visible && items.some(function(item) { return item.key === selectedKey && item.dataset === key; })) {
            button.focus(); clearSelection();
          } else if (chooser.childNodes.length) {
            chooser.textContent = ""; chooser.onkeydown = null; button.focus();
          }
          syncLayers(); layoutChanged();
        };
      });
      locations.forEach(function(entry) {
        var xy = projected(entry.point);
        entry.target = svg("circle", { cx: xy[0], cy: xy[1], r: 10, "class": "natural-target", "aria-hidden": "true" });
        var marker = svg("circle", { cx: xy[0], cy: xy[1], r: 4, role: "button", tabindex: 0,
          "data-marker": entry.key, "aria-pressed": "false", "class": "natural-marker " + entry.items[0].dataset });
        entry.marker = marker; targets.appendChild(entry.target); markers.appendChild(marker);
        marker.onfocus = function() {
          var bounds = map.getAttribute("viewBox").split(" ").map(Number);
          if (xy[0] - 10 < bounds[0] || xy[0] + 10 > bounds[0] + bounds[2]
            || xy[1] - 10 < bounds[1] || xy[1] + 10 > bounds[1] + bounds[3]) {
            map.setAttribute("viewBox", world); layoutChanged();
          }
        };
        function choose() {
          var members = visibleItems(entry);
          if (members.length === 1) { selectItem(members[0]); marker.focus(); return; }
          chooser.textContent = "";
          chooser.appendChild(el("div", "", "Choose an event at " + entry.key));
          members.forEach(function(item) {
            var button = el("button", "", itemLabel(item)); button.type = "button"; button.setAttribute("data-choice", item.key);
            button.onclick = function() { selectItem(item); marker.focus(); }; chooser.appendChild(button);
          });
          var dismiss = el("button", "", "Dismiss choices"); dismiss.type = "button";
          function closeChooser() { chooser.textContent = ""; chooser.onkeydown = null; marker.focus(); layoutChanged(); }
          dismiss.onclick = closeChooser; chooser.appendChild(dismiss);
          chooser.onkeydown = function(event) { if (event.key === "Escape") { event.preventDefault(); closeChooser(); } };
          chooser.querySelector("button").focus(); layoutChanged();
        }
        marker.onclick = choose; entry.target.onclick = choose;
        marker.onkeydown = function(event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(); } };
      });
      q("natural-world").onclick = function() { clearSelection(); q("natural-world").focus(); layoutChanged(); };
      syncLayers();
      if (restoreOwnedFocus) q("natural-heading").focus();
      layoutChanged();
    }

    var quakeView = group("earthquakes", "Earthquakes", "earthquakes");
    if (quakeView) {
      var quakeShown = 0;
      for (var quakeIndex = 0; quakeIndex < quakeView.items.length && quakeIndex < 8; quakeIndex++) {
        var quake = quakeView.items[quakeIndex];
        if (!quake || typeof quake !== "object") continue;
        var quakeRow = el("div", "drow");
        var magnitude = num(quake.magnitude);
        var magnitudeLabel = el("span", "mag", magnitude == null ? "—" : "M" + magnitude.toFixed(1));
        magnitudeLabel.style.color = magnitude == null ? cssVar("--muted") : cssVar(magnitude >= 6 ? "--severe" : magnitude >= 5 ? "--high" : magnitude >= 4 ? "--moderate" : "--low");
        quakeRow.appendChild(magnitudeLabel);
        var source = httpUrl(quake.sourceUrl);
        var place = el(source ? "a" : "span", "dplace", collapseWs(quake.place) || "Unknown location");
        if (source) { place.href = source; place.target = "_blank"; place.rel = "noopener noreferrer"; }
        quakeRow.appendChild(place);
        quakeRow.appendChild(el("span", "dtime", eventTime(quake.occurredAt, "", "Event time unavailable")));
        registerRow("earthquakes", quakeIndex, quake, quakeRow, place.textContent);
        quakeView.section.appendChild(quakeRow);
        quakeShown++;
      }
      if (quakeView.bucket && quakeView.bucket.upstreamUnavailable === true) warning(quakeView.section, "Earthquake source coverage is unavailable.");
      counts(quakeView, quakeShown);
    }

    var fireView = group("fires", "Active Wildfires", "fireDetections");
    if (fireView) {
      var fireShown = 0;
      var confidenceLabels = { FIRE_CONFIDENCE_HIGH: "High", FIRE_CONFIDENCE_NOMINAL: "Nominal", FIRE_CONFIDENCE_LOW: "Low" };
      for (var fireIndex = 0; fireIndex < fireView.items.length && fireIndex < 6; fireIndex++) {
        var fire = fireView.items[fireIndex];
        if (!fire || typeof fire !== "object") continue;
        var fireRow = el("div", "drow");
        fireRow.appendChild(el("span", "mag", confidenceLabels[collapseWs(fire.confidence)] || "Fire"));
        var location = fire.location && typeof fire.location === "object" ? fire.location : null;
        var latitude = location ? num(location.latitude) : null;
        var longitude = location ? num(location.longitude) : null;
        var firePlace = collapseWs(fire.region) || (latitude != null && longitude != null ? latitude.toFixed(2) + ", " + longitude.toFixed(2) : "detection");
        fireRow.appendChild(el("span", "dplace", firePlace));
        var brightness = num(fire.brightness);
        var fireDetails = eventTime(fire.detectedAt === 0 ? null : fire.detectedAt, "Detected ", "Detection time unavailable");
        if (brightness != null) fireDetails += " · brightness " + Math.round(brightness);
        fireRow.appendChild(el("span", "dtime", fireDetails));
        registerRow("fires", fireIndex, fire, fireRow, firePlace);
        fireView.section.appendChild(fireRow);
        fireShown++;
      }
      if (fireView.bucket) {
        if (fireView.bucket._firmsPartial === true) warning(fireView.section, "NASA FIRMS coverage is partial.");
        providerState(fireView, "_firmsState", "NASA FIRMS");
        providerState(fireView, "_cwfisState", "Canadian wildfire");
        providerState(fireView, "_bcState", "British Columbia wildfire");
        if (fireView.bucket.upstreamUnavailable === true) warning(fireView.section, "Wildfire source coverage is unavailable.");
        if (fireView.bucket._bcErrorCode) warning(fireView.section, "British Columbia wildfire source reports an error.");
      }
      wildfireDetails(fireView);
      counts(fireView, fireShown);
    }

    var otherView = group("events", "Other natural events", "events");
    if (otherView) {
      var otherShown = 0;
      for (var otherIndex = 0; otherIndex < otherView.items.length && otherIndex < 8; otherIndex++) {
        var event = otherView.items[otherIndex];
        if (!event || typeof event !== "object") continue;
        var eventRow = el("div", "drow");
        var eventSource = httpUrl(event.sourceUrl);
        var eventPlace = el(eventSource ? "a" : "span", "dplace", collapseWs(event.title) || "Natural event");
        if (eventSource) { eventPlace.href = eventSource; eventPlace.target = "_blank"; eventPlace.rel = "noopener noreferrer"; }
        eventRow.appendChild(eventPlace);
        var eventDetails = [collapseWs(event.categoryTitle) || collapseWs(event.category) || collapseWs(event.type), collapseWs(event.country)].filter(Boolean);
        var ownDate = Object.prototype.hasOwnProperty.call(event, "date") && typeof event.date === "number" && Number.isSafeInteger(event.date) && Number.isFinite(new Date(event.date).getTime());
        var reportedDate = ownDate ? "Reported event time: " + new Date(event.date).toISOString() : "Event time unavailable";
        var eventMagnitude = typeof event.magnitude === "number" && Number.isFinite(event.magnitude) ? event.magnitude : null;
        var eventUnit = typeof event.magnitudeUnit === "string" ? collapseWs(event.magnitudeUnit) : "";
        if (eventMagnitude == null) eventDetails.push("Measurement unavailable");
        else if (eventUnit) eventDetails.push("Measurement: " + eventMagnitude + " " + eventUnit);
        else eventDetails.push("Reported value: " + eventMagnitude + "; unit unavailable" + (eventMagnitude === 0 ? "; measurement status unavailable" : ""));
        if (typeof event.closed === "boolean") eventDetails.push(event.closed ? "Closed" : "Active");
        eventRow.appendChild(el("span", "dtime", eventDetails.join(" · ")));
        eventRow.appendChild(el("span", "dtime", reportedDate));
        if (typeof event.status === "string" && event.status.trim()) eventRow.appendChild(el("span", "dtime", "Reported status: " + collapseWs(event.status)));
        registerRow("events", otherIndex, event, eventRow, eventPlace.textContent);
        otherView.section.appendChild(eventRow);
        otherShown++;
      }
      if (otherView.bucket) {
        if (otherView.bucket.upstreamUnavailable === true) warning(otherView.section, "Other natural-event source coverage is unavailable.");
        var regionalSources = [{ key: "westernPacific", label: "Western Pacific" }, { key: "hkoWarnings", label: "Hong Kong warnings" }];
        regionalSources.forEach(function (region) {
          var coverage = otherView.bucket[region.key];
          if (coverage && typeof coverage === "object") {
            if (coverage.dataAvailable === false) warning(otherView.section, region.label + " coverage is unavailable.");
            if (Array.isArray(coverage.sourceDecisions) && coverage.sourceDecisions.some(function (decision) { return decision && decision.status !== "accepted"; })) {
              warning(otherView.section, region.label + " source coverage is incomplete.");
            }
          }
          regionalDetails(otherView, region, coverage);
        });
      }
      else detailBlock(otherView.section, "Regional sources", ["Provider detail: Unknown"]);
      counts(otherView, otherShown);
    }

    finishMap({ earthquakes: quakeView, fires: fireView, events: otherView });
    if (!selectedCount) host.appendChild(el("div", "empty", "Natural-hazard data is temporarily unavailable."));
    else if (emptyCount === selectedCount && !coverageLimited) host.appendChild(el("div", "empty", "No natural-hazard events available."));
    q("foot").textContent = envelope.cached_at
      ? "Snapshot: " + collapseWs(envelope.cached_at) + (envelope.stale ? " (stale)" : "")
      : "";
`;

export const NATURAL_DISASTERS_APP_HTML = buildAppHtml({
  title: 'Natural Disasters — WorldMonitor',
  appName: 'worldmonitor-natural-disasters',
  styles: STYLES,
  body: BODY,
  renderBody: RENDER,
});
