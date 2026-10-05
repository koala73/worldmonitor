import { buildAppHtml } from './shell';

const STYLES = `
  .filters { display: flex; gap: 12px; margin: 14px 0 6px; flex-wrap: wrap; }
  .filters label { display: grid; gap: 4px; flex: 1; font-size: 12px; color: var(--muted); }
  .filters select { width: 100%; min-width: 0; padding: 7px; color: var(--fg); background: var(--card); border: 1px solid var(--border); border-radius: 5px; }
  #count { font-size: 11px; color: var(--muted); margin-bottom: 8px; }
  #list { max-height: 560px; overflow-y: auto; overscroll-behavior: contain; }
  .fc { padding: 12px 2px; border-bottom: 1px solid var(--border); overflow-wrap: anywhere; }
  .fc:last-child { border-bottom: none; }
  .fc-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .fc-title { font-size: 13px; color: var(--fg); min-width: 0; }
  .fc-prob { font-variant-numeric: tabular-nums; font-weight: 700; font-size: 13px; white-space: nowrap; }
  .fc-meta { margin-top: 5px; display: flex; gap: 6px; flex-wrap: wrap; }
  .chip { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted);
    border: 1px solid var(--border); border-radius: 999px; padding: 1px 7px; }
  details { margin-top: 10px; }
  summary { cursor: pointer; color: var(--accent); font-size: 12px; padding: 4px 0; }
  summary:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .fc-section { padding: 10px; margin: 8px 0; background: var(--card); border: 1px solid var(--border); border-radius: 6px; font-size: 12px; }
  .fc-section h3 { margin: 0 0 6px; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .fc-section p { margin: 4px 0; }
  .fc-section ul { margin: 4px 0; padding-left: 18px; }
  .fc-entry + .fc-entry { border-top: 1px solid var(--border); margin-top: 8px; padding-top: 8px; }
  #theaters { border-top: 1px solid var(--border); margin-top: 16px; padding-top: 12px; overflow-wrap: anywhere; }
  #theaters h2 { margin: 0 0 8px; font-size: 14px; }
  #load-theaters { margin: 8px 0; padding: 7px 12px; border: 1px solid var(--border); border-radius: 5px; background: var(--card); color: var(--accent); cursor: pointer; }
  #load-theaters:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
`;

const BODY = `
  <div class="head">
    <div class="title">Forecasts</div>
    <div class="badge">WorldMonitor Forecasts</div>
  </div>
  <div class="empty" id="empty">Waiting for forecasts…</div>
  <div id="card" style="display:none">
    <div class="filters">
      <label for="domain">Domain<select id="domain"></select></label>
      <label for="region">Region<select id="region"></select></label>
    </div>
    <div id="count" role="status"></div>
    <div id="list" role="region" aria-label="Loaded forecasts" tabindex="0"></div>
    <div class="foot" id="foot"></div>
    <section id="theaters" aria-label="Original active theaters"></section>
  </div>
`;

const RENDER = `
    if (!data || typeof data !== "object") return;
    if (Object.prototype.hasOwnProperty.call(data, "projection")) data = object(data.projection);
    var d = data.data && typeof data.data === "object" ? data.data : data;
    q("empty").style.display = "none";
    q("card").style.display = "block";
    var node = object(d.predictions);
    var state = listState(node.predictions);
    var preds = state.items.filter(function (p) { return p && typeof p === "object" && !Array.isArray(p); });
    var reported = number(object(node.predictions).count);
    var total = reported == null ? preds.length : Math.max(preds.length, reported);
    var host = q("list");
    var generation = node.generatedAt == null ? "" : String(node.generatedAt);
    var cases = renderData.forecastCases || (renderData.forecastCases = { generation: "", cache: new Map(), pending: new Map(), targets: new Map(), serial: 0 });
    cases.pending.forEach(function (cancel) { cancel(); });
    cases.pending.clear();
    if (cases.generation !== generation) { cases.cache.clear(); cases.generation = generation; }
    var panel = object(data.panelRequest);
    var theaterState = renderData.forecastTheaters || (renderData.forecastTheaters = { key: "", value: null, error: "", pending: false, cancel: null, serial: 0 });
    var theaterKey = generation + "|" + text(panel.token);
    if (theaterState.key !== theaterKey) {
      if (theaterState.cancel) theaterState.cancel();
      theaterState.key = theaterKey; theaterState.value = null; theaterState.error = "";
    }

    function renderTheaters() {
      var target = q("theaters");
      target.textContent = "";
      target.appendChild(el("h2", "", "Active theaters"));
      var value = theaterState.value;
      if (value) {
        var status = { ready: "Completed", partial: "Partial coverage", empty: "No eligible theaters", failed: "All theaters failed", unknown: "Completion unknown", missing: "No theater outcome available", processing: "Theater outcome processing", unavailable: "Theater source unavailable" }[value.status];
        var coverage = status + " · " + value.theaterCount + " of " + value.eligibleTheaterCount + " theaters completed · " + value.failedTheaterCount + " failed";
        if (value.completionStatus) coverage += " · " + value.completionStatus;
        target.appendChild(el("p", "empty", coverage));
        if (value.runId) target.appendChild(el("p", "foot", "Source run: " + value.runId));
        if (value.generatedAt) target.appendChild(el("p", "foot", "Theater source time: " + timestamp(value.generatedAt) + " · freshness unknown"));
        if (value.note) target.appendChild(el("p", "empty", value.note));
        if (value.error) target.appendChild(el("p", "empty", value.error));
        value.theaters.forEach(function (theater) {
          var details = el("details", "fc");
          details.appendChild(el("summary", "", theater.theaterLabel));
          copy(details, theater.stateKind, "State: ");
          theater.topPaths.forEach(function (path) {
            section(details, path.label, function (content) {
              copy(content, path.summary);
              var confidence = number(path.confidence);
              content.appendChild(el("p", "", confidence == null ? "Confidence unknown" : "Confidence: " + Math.round(confidence * 100) + "%"));
              section(content, "Actors", function (actors) { items(actors, path.keyActors); });
              section(content, "Actor roles", function (roles) { items(roles, path.keyActorRoles); });
            });
          });
          section(details, "Dominant reactions", function (content) { items(content, theater.dominantReactions); });
          section(details, "Stabilizers", function (content) { items(content, theater.stabilizers); });
          section(details, "Invalidators", function (content) { items(content, theater.invalidators); });
          details.ontoggle = reportSize;
          target.appendChild(details);
        });
      }
      if (theaterState.error) target.appendChild(el("p", "empty", theaterState.error));
      if (!value || value.status !== "ready" && value.status !== "empty" || theaterState.error) {
        var load = el("button", "", theaterState.pending ? "Loading active theaters…" : value || theaterState.error ? "Retry active theaters" : "Load active theaters");
        load.id = "load-theaters"; load.type = "button"; load.disabled = theaterState.pending;
        load.onclick = loadTheaters;
        target.appendChild(load);
      }
      reportSize();
    }
    function loadTheaters() {
      if (theaterState.pending) return;
      if (!hostCapabilities.serverTools || typeof hostCapabilities.serverTools !== "object") {
        theaterState.error = "This host does not support original theater tool calls."; renderTheaters(); return;
      }
      if (panel.panel !== "forecasts" || typeof panel.token !== "string" || !panel.token) {
        theaterState.error = "Original theaters require a signed panel request. Open a new forecasts panel."; renderTheaters(); return;
      }
      theaterState.pending = true; theaterState.error = "";
      var id = "forecast-theaters-" + ++theaterState.serial;
      var timer;
      function cancel() { clearTimeout(timer); window.removeEventListener("message", receive); theaterState.pending = false; theaterState.cancel = null; }
      function failure(message) { cancel(); theaterState.error = message; renderTheaters(); }
      function receive(event) {
        if (event.source !== parentWin || theaterState.key !== theaterKey) return;
        var message = event.data;
        if (!message || message.jsonrpc !== "2.0" || message.id !== id) return;
        if (message.error || message.result && message.result.isError) { failure("Original theater request failed. Retry manually or refresh forecasts if the panel expired."); return; }
        var payload = extractToolData(message.result);
        var error = softError(payload);
        if (error) { failure(error); return; }
        var envelope = object(payload);
        if (Object.prototype.hasOwnProperty.call(envelope, "projection")) envelope = object(envelope.projection);
        var value = object(object(envelope.data).forecastTheaters);
        var theaters;
        try { theaters = value.theaterSummariesJson ? JSON.parse(value.theaterSummariesJson) : []; } catch (_) { failure("Original theater response is invalid."); return; }
        function stringArray(v) { return Array.isArray(v) && v.every(function (item) { return typeof item === "string"; }); }
        function count(v) { return Number.isInteger(v) && v >= 0 && v <= 3; }
        var valid = ["ready", "partial", "empty", "failed", "unknown", "missing", "processing", "unavailable"].indexOf(value.status) >= 0
          && typeof value.found === "boolean" && typeof value.processing === "boolean" && typeof value.allTheatersFailed === "boolean"
          && ["runId", "schemaVersion", "note", "error", "theaterSummariesJson", "completionStatus"].every(function (field) { return typeof value[field] === "string"; })
          && Number.isSafeInteger(value.generatedAt) && value.generatedAt >= 0
          && count(value.theaterCount) && count(value.eligibleTheaterCount) && count(value.failedTheaterCount)
          && value.theaterCount + value.failedTheaterCount === value.eligibleTheaterCount
          && Array.isArray(theaters) && theaters.length <= 3 && theaters.length === value.theaterCount
          && theaters.every(function (theater) {
            return theater && typeof theater.theaterId === "string" && typeof theater.theaterLabel === "string" && typeof theater.stateKind === "string"
              && Array.isArray(theater.topPaths) && theater.topPaths.length <= 3 && theater.topPaths.every(function (path) {
                return path && typeof path.pathId === "string" && typeof path.label === "string" && typeof path.summary === "string"
                  && (path.confidence == null || number(path.confidence) != null && path.confidence >= 0 && path.confidence <= 1)
                  && stringArray(path.keyActors) && path.keyActors.length <= 4 && (path.keyActorRoles === undefined || stringArray(path.keyActorRoles) && path.keyActorRoles.length <= 8);
              }) && stringArray(theater.dominantReactions) && theater.dominantReactions.length <= 3
              && stringArray(theater.stabilizers) && theater.stabilizers.length <= 3 && stringArray(theater.invalidators) && theater.invalidators.length <= 2;
          });
        if (!valid) { failure("Original theater response is invalid."); return; }
        if (["unavailable", "missing", "processing", "failed"].indexOf(value.status) >= 0 && theaterState.value && theaterState.value.theaters.length) {
          failure("Latest theater read: " + value.status + (value.error ? " · " + value.error : "") + ". Previously loaded evidence remains visible; freshness unknown."); return;
        }
        cancel(); theaterState.value = Object.assign({}, value, { theaters: theaters }); renderTheaters();
      }
      theaterState.cancel = cancel;
      window.addEventListener("message", receive);
      timer = setTimeout(function () { failure("Original theater request timed out."); }, 15000);
      renderTheaters();
      post({ jsonrpc: "2.0", id: id, method: "tools/call", params: { name: "get_forecast_theaters", arguments: { panel_request: panel.token } } });
    }

    function caseContent(parent, value) {
      parent.textContent = "";
      analysis(parent, value.forecast);
      var coverage = [];
      if (text(value.cached_at)) coverage.push("Original case snapshot: " + text(value.cached_at));
      if (value.stale) coverage.push("Original case uses stale cache");
      if (value.freshnessUnknown) coverage.push("Original case freshness unknown");
      if (value.unreadable) coverage.push("Original case source coverage unavailable");
      if (coverage.length) parent.appendChild(el("p", "empty", coverage.join(" · ")));
    }
    function caseNotice(parent, message, retry) {
      parent.textContent = "";
      parent.appendChild(el("p", "empty", message));
      if (retry) {
        var button = el("button", "", "Retry case details");
        button.type = "button";
        button.onclick = retry;
        parent.appendChild(button);
      }
      reportSize();
    }
    function loadCase(parent, p) {
      if (!hostCapabilities.serverTools || typeof hostCapabilities.serverTools !== "object") {
        caseNotice(parent, "This host does not support original case tool calls."); return;
      }
      if (panel.panel !== "forecasts" || typeof panel.token !== "string" || !panel.token) {
        caseNotice(parent, "Original case details require a signed panel request. Open a new forecasts panel."); return;
      }
      if (typeof p.id !== "string" || !p.id || p.id.length > 160 || !generation || generation.length > 64) {
        caseNotice(parent, "Original case identity or generation is unavailable."); return;
      }
      var cached = cases.cache.get(p.id);
      if (cached) { caseContent(parent, cached); return; }
      caseNotice(parent, "Loading original case details…");
      if (cases.pending.has(p.id)) return;
      var requestId = "forecast-case-" + ++cases.serial;
      var timer;
      function cancel() { clearTimeout(timer); window.removeEventListener("message", receive); cases.pending.delete(p.id); }
      function failure(message) { cancel(); caseNotice(cases.targets.get(p.id) || parent, message, function () { loadCase(cases.targets.get(p.id) || parent, p); }); }
      function receive(event) {
        if (event.source !== parentWin) return;
        var message = event.data;
        if (!message || message.jsonrpc !== "2.0" || message.id !== requestId) return;
        if (message.error) { failure("Original case request failed."); return; }
        var result = message.result;
        var payload = extractToolData(result);
        var error = softError(payload);
        if (result && result.isError) { failure("Original case request failed."); return; }
        if (error) { failure(error); return; }
        var envelope = object(payload);
        if (Object.prototype.hasOwnProperty.call(envelope, "projection")) envelope = object(envelope.projection);
        var detail = object(object(envelope.data).forecastCase);
        if (detail.status === "generation_changed" || (detail.generatedAt != null && String(detail.generatedAt) !== generation)) {
          cancel(); caseNotice(cases.targets.get(p.id) || parent, "Forecast generation changed. Ask to refresh forecasts for current original evidence. Refreshing uses 1 new panel allocation."); return;
        }
        if (detail.status === "missing") { failure("Original case is no longer available."); return; }
        if (detail.status === "unavailable") { failure("Original case source unavailable."); return; }
        var original = object(detail.forecast);
        if (detail.status !== "ready" || String(detail.generatedAt) !== generation || original.id !== p.id) {
          failure("Original case response does not match this forecast."); return;
        }
        cancel();
        var value = { forecast: original, cached_at: envelope.cached_at, stale: envelope.stale === true, freshnessUnknown: envelope.freshnessUnknown === true, unreadable: Array.isArray(envelope.unreadable) && envelope.unreadable.length > 0 };
        cases.cache.set(p.id, value);
        caseContent(cases.targets.get(p.id) || parent, value);
        reportSize();
      }
      cases.pending.set(p.id, cancel);
      window.addEventListener("message", receive);
      timer = setTimeout(function () { failure("Original case request timed out."); }, 15000);
      post({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: { name: "get_forecast_case", arguments: {
        forecast_id: p.id, generated_at: generation, panel_request: panel.token
      } } });
    }

    function object(v) { return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }
    function text(v) { return typeof v === "string" ? collapseWs(v) : ""; }
    function number(v) { return typeof v === "number" && isFinite(v) ? v : null; }
    function timestamp(v) {
      if ((typeof v !== "number" && typeof v !== "string") || !v || (typeof v === "number" && v <= 0)) return "";
      var date = new Date(v);
      return isFinite(date.getTime()) ? date.toISOString() : "";
    }
    function strings(v) { return Array.isArray(v) ? v.map(text).filter(Boolean) : []; }
    function copy(parent, value, prefix) {
      var str = text(value);
      if (str) parent.appendChild(el("p", "", (prefix || "") + str));
    }
    function items(parent, values) {
      var entries = strings(values);
      if (!entries.length) return;
      var ul = el("ul");
      entries.forEach(function (entry) { ul.appendChild(el("li", "", entry)); });
      parent.appendChild(ul);
    }
    function section(parent, title, fill) {
      var content = el("div");
      fill(content);
      if (!content.childNodes.length) return;
      var block = el("section", "fc-section");
      block.appendChild(el("h3", "", title));
      block.appendChild(content);
      parent.appendChild(block);
    }
    function evidence(parent, values) {
      if (!Array.isArray(values)) return;
      items(parent, values.map(function (item) {
        var e = object(item);
        var weight = number(e.weight);
        return text(e.summary) ? text(e.summary) + (weight == null ? "" : " (" + Math.round(weight * 100) + "%)") : "";
      }));
    }
    function analysis(parent, p) {
      var c = object(p.caseFile);
      section(parent, "Executive View", function (s) { copy(s, p.scenario); });
      section(parent, "Base Case", function (s) { copy(s, c.baseCase); });
      section(parent, "What Changed", function (s) { copy(s, c.changeSummary); items(s, c.changeItems); });
      section(parent, "World State", function (s) {
        var w = object(c.worldState);
        copy(s, w.summary);
        [["Pressures", w.activePressures], ["Stabilizers", w.stabilizers], ["Key unknowns", w.keyUnknowns]].forEach(function (entry) {
          if (strings(entry[1]).length) { copy(s, entry[0] + ":"); items(s, entry[1]); }
        });
      });
      section(parent, "Alternative Paths", function (s) { copy(s, c.escalatoryCase, "Escalatory: "); copy(s, c.contrarianCase, "Contrarian: "); });
      section(parent, "Simulated Branches", function (s) {
        if (!Array.isArray(c.branches)) return;
        c.branches.forEach(function (value) {
          if (!value || typeof value !== "object") return;
          var b = object(value);
          var entry = el("div", "fc-entry");
          entry.appendChild(el("strong", "", text(b.title) || text(b.kind) || "Branch"));
          var probability = number(b.projectedProbability);
          if (probability != null) copy(entry, "Projected " + Math.round(probability * 100) + "%");
          copy(entry, b.summary); copy(entry, b.outcome, "Outcome: ");
          if (Array.isArray(b.rounds)) b.rounds.slice(0, 3).forEach(function (value) {
            var r = object(value);
            var detail = strings(r.developments).slice(0, 2).concat(strings(r.actorMoves).slice(0, 1)).join(" ") || text(r.focus);
            copy(entry, detail, "R" + (number(r.round) || 0) + ": ");
          });
          s.appendChild(entry);
        });
      });
      section(parent, "Supporting Evidence", function (s) { evidence(s, c.supportingEvidence); });
      section(parent, "Counter Evidence", function (s) { evidence(s, c.counterEvidence); });
      section(parent, "Signals To Watch", function (s) { items(s, c.triggers); });
      section(parent, "Signals", function (s) {
        if (Array.isArray(p.signals)) items(s, p.signals.map(function (value) { return object(value).value; }));
      });
      section(parent, "Actors", function (s) {
        if (!Array.isArray(c.actors)) return;
        c.actors.forEach(function (value) {
          if (!value || typeof value !== "object") return;
          var a = object(value);
          var entry = el("div", "fc-entry");
          entry.appendChild(el("strong", "", text(a.name) || "Actor"));
          copy(entry, a.category);
          var influence = number(a.influenceScore);
          if (influence != null) copy(entry, "Influence " + Math.round(influence * 100) + "%");
          copy(entry, a.role);
          copy(entry, strings(a.objectives)[0], "Objective: ");
          copy(entry, strings(a.constraints)[0], "Constraint: ");
          copy(entry, strings(a.likelyActions)[0], "Likely action: ");
          s.appendChild(entry);
        });
      });
      if (!Array.isArray(c.actors) || !c.actors.length) section(parent, "Actor Lenses", function (s) { items(s, c.actorLenses); });
      section(parent, "Perspectives", function (s) {
        var views = object(p.perspectives);
        copy(s, views.strategic, "Strategic: "); copy(s, views.regional, "Regional: "); copy(s, views.contrarian, "Contrarian: ");
      });
      section(parent, "Context", function (s) {
        var calibration = object(p.calibration);
        if (text(calibration.marketTitle)) {
          var price = number(calibration.marketPrice);
          copy(s, "Market: " + text(calibration.marketTitle) + (price == null ? " (probability unknown)" : " (" + Math.round(price * 100) + "%)"));
        }
        var prior = number(p.priorProbability);
        if (prior != null) copy(s, "Prior: " + Math.round(prior * 100) + "%");
        if (Array.isArray(p.cascades) && p.cascades.length) copy(s, "Cascades: " + p.cascades.length);
      });
      if (!Object.keys(c).length) parent.appendChild(el("p", "empty", "Case evidence is not included in this result."));
    }
    function appendForecast(p) {
      var fc = el("article", "fc");
      var head = el("div", "fc-head");
      head.appendChild(el("span", "fc-title", text(p.title) || "Forecast"));
      var pr = num(p.probability);
      var pct = pr == null ? null : (pr <= 1 ? pr * 100 : pr);
      head.appendChild(el("span", "fc-prob", pct == null ? "—" : Math.round(pct) + "%"));
      fc.appendChild(head);
      var meta = el("div", "fc-meta");
      [p.domain, p.region, p.trend, p.timeHorizon].forEach(function (value) {
        if (text(value)) meta.appendChild(el("span", "chip", text(value)));
      });
      var adjustment = number(p.simulationAdjustment);
      if (p.demotedBySimulation === true) meta.appendChild(el("span", "chip", "AI skeptical"));
      else if (adjustment != null && adjustment !== 0) meta.appendChild(el("span", "chip", adjustment > 0 ? "AI backed" : "AI flagged"));
      if (adjustment != null && adjustment !== 0) {
        var confidence = number(p.simPathConfidence);
        var label = p.demotedBySimulation === true ? "AI flag: dropped" : adjustment < 0 ? "AI caution" : confidence != null && confidence < 0.7 ? "AI signal (moderate)" : "AI signal";
        meta.appendChild(el("span", "chip", label + " · " + (adjustment > 0 ? "+" : "−") + Math.round(Math.abs(adjustment) * 100) + "%"));
      }
      if (meta.childNodes.length) fc.appendChild(meta);
      var bar = probabilityBar(pct);
      if (bar) fc.appendChild(bar);
      var details = el("details");
      details.appendChild(el("summary", "", "Analysis"));
      var content = el("div");
      details.appendChild(content);
      if (typeof p.id === "string") cases.targets.set(p.id, content);
      var loadedCase = Object.keys(object(p.caseFile)).length > 0;
      if (loadedCase) analysis(content, p);
      else if (p.hasCaseFile === false) caseNotice(content, "No case evidence is available for this forecast.");
      else if (p.hasCaseFile === true && typeof p.id === "string" && cases.cache.has(p.id)) caseContent(content, cases.cache.get(p.id));
      else analysis(content, p);
      details.ontoggle = function () {
        if (details.open && !loadedCase && p.hasCaseFile === true) loadCase(content, p);
        reportSize();
      };
      fc.appendChild(details);
      host.appendChild(fc);
    }
    function options(id, field, all) {
      var select = q(id);
      var selected = select.value || "";
      var values = Array.from(new Set(preds.map(function (p) { return text(p[field]); }).filter(Boolean))).sort();
      select.textContent = "";
      [""].concat(values).forEach(function (value) {
        var option = el("option", "", value || all);
        option.value = value;
        select.appendChild(option);
      });
      select.value = values.indexOf(selected) >= 0 ? selected : "";
      select.onchange = renderList;
    }
    function renderList() {
      cases.targets.clear();
      host.textContent = "";
      var visible = preds.filter(function (p) {
        return (!q("domain").value || text(p.domain) === q("domain").value) && (!q("region").value || text(p.region) === q("region").value);
      });
      visible.forEach(appendForecast);
      if (!host.childNodes.length) host.appendChild(el("div", "empty", !state.available ? "Forecast data unavailable." : !preds.length ? "No forecasts available." : "No forecasts match these filters."));
      q("count").textContent = state.available ? visible.length + " shown · " + preds.length + " of " + total + " loaded. Filters apply to this loaded result." : "Forecast coverage unavailable.";
      reportSize();
    }
    options("domain", "domain", "All domains");
    options("region", "region", "All regions");
    renderList();
    var source = [];
    var generatedAt = timestamp(node.generatedAt);
    if (generatedAt) source.push("Generated: " + generatedAt);
    if (data.cached_at) source.push("Snapshot: " + text(data.cached_at));
    if (node.degraded) source.push("Forecast source degraded");
    if (data.stale || node.stale) source.push("stale cache");
    if (text(node.error)) source.push(text(node.error).split("_").join(" "));
    q("foot").textContent = source.join(" · ");
    renderTheaters();
`;

export const FORECASTS_APP_HTML = buildAppHtml({
  title: 'Forecasts — WorldMonitor',
  appName: 'worldmonitor-forecasts',
  styles: STYLES,
  body: BODY,
  renderBody: RENDER,
});
