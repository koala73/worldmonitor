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
  </div>
`;

const RENDER = `
    if (!data || typeof data !== "object") return;
    var d = data.data && typeof data.data === "object" ? data.data : data;
    q("empty").style.display = "none";
    q("card").style.display = "block";
    var node = object(d.predictions);
    var state = listState(node.predictions);
    var preds = state.items.filter(function (p) { return p && typeof p === "object" && !Array.isArray(p); });
    var reported = number(object(node.predictions).count);
    var total = reported == null ? preds.length : Math.max(preds.length, reported);
    var host = q("list");

    function object(v) { return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }
    function text(v) { return typeof v === "string" ? collapseWs(v) : ""; }
    function number(v) { return typeof v === "number" && isFinite(v) ? v : null; }
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
      analysis(details, p);
      details.ontoggle = reportSize;
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
    if (node.generatedAt) source.push("Generated: " + text(node.generatedAt));
    if (data.cached_at) source.push("Snapshot: " + text(data.cached_at));
    if (node.degraded) source.push("Forecast source degraded");
    if (data.stale || node.stale) source.push("stale cache");
    if (text(node.error)) source.push(text(node.error).split("_").join(" "));
    q("foot").textContent = source.join(" · ");
`;

export const FORECASTS_APP_HTML = buildAppHtml({
  title: 'Forecasts — WorldMonitor',
  appName: 'worldmonitor-forecasts',
  styles: STYLES,
  body: BODY,
  renderBody: RENDER,
});
