import { buildAppHtml } from './shell';

const STYLES = `
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
    <div class="title">Natural Disasters</div>
    <div class="badge">WorldMonitor Hazards</div>
  </div>
  <div class="empty" id="empty">Waiting for hazard data…</div>
  <div id="card" style="display:none">
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
    host.textContent = "";
    var selectedCount = 0;
    var emptyCount = 0;
    var coverageLimited = false;

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
      return { section: section, bucket: bucket, list: list, items: state.items, available: state.available };
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
        eventRow.appendChild(el("span", "dplace", collapseWs(event.title) || "Natural event"));
        var eventDetails = [collapseWs(event.type), collapseWs(event.country)].filter(Boolean);
        var eventMagnitude = num(event.magnitude);
        if (eventMagnitude != null) eventDetails.push("Magnitude " + eventMagnitude);
        if (typeof event.closed === "boolean") eventDetails.push(event.closed ? "Closed" : "Active");
        eventRow.appendChild(el("span", "dtime", eventDetails.join(" · ")));
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
