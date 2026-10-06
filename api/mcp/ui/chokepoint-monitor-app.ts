// MCP Apps (extension `io.modelcontextprotocol/ui`, spec 2026-01-26) — the
// interactive app shell for the `get_chokepoint_status` tool: a maritime
// chokepoint monitor rendering per-chokepoint rolling transit summaries
// (last-24-hour transit count, week-over-week change, tanker split) with a
// risk-level badge. Built on the shared shell foundation.
//
// Tool result shape (cache tool — content[0].text JSON, freshness envelope):
//   { cached_at, stale, data: {
//       "transit-summaries": { summaries: {
//         <chokepoint>: { todayTotal, todayTanker, todayCargo, wowChangePct,
//                         riskLevel, riskSummary, dataAvailable } },
//         fetchedAt } } }
//
// textContent-only rendering; renderBody stays backtick/`${`/regex-free.

import { buildAppHtml } from './shell';

const STYLES = `
  .crow { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }
  .crow:first-child { border-top: none; }
  .crow-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .cname { font-size: 15px; font-weight: 600; }
  .risk { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;
    padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border); }
  .cstats { display: flex; gap: 18px; margin-top: 6px; flex-wrap: wrap; }
  .cstat { display: flex; flex-direction: column; }
  .cstat .k { font-size: 11px; color: var(--muted); }
  .cstat .v { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .csum { margin-top: 6px; font-size: 12px; color: var(--muted); }
  .coverage { margin-top: 12px; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
  .foot { white-space: pre-line; overflow-wrap: anywhere; }
`;

const BODY = `
  <div class="head">
    <div class="title">Chokepoint Monitor</div>
    <div class="badge">WorldMonitor Maritime</div>
  </div>
  <div class="empty" id="empty">Waiting for chokepoint data…</div>
  <div id="card" style="display:none">
    <div class="coverage" id="coverage"></div>
    <div id="rows"></div>
    <div class="foot" id="foot"></div>
  </div>
`;

const RENDER = `
    var value = data && typeof data === "object" && Object.prototype.hasOwnProperty.call(data, "projection") ? data.projection : data;
    var envelope = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    var d = envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data)
      ? envelope.data : envelope;
    q("empty").style.display = "none";
    q("card").style.display = "block";

    function prettyName(key) {
      var s = String(key == null ? "" : key).split("_").join(" ").trim();
      if (!s) return "—";
      return s.charAt(0).toUpperCase() + s.slice(1);
    }
    function riskColor(r) {
      if (r === "critical" || r === "severe") return cssVar("--severe");
      if (r === "high" || r === "elevated") return cssVar("--high");
      if (r === "moderate" || r === "warning") return cssVar("--moderate");
      return r === "normal" || r === "low" ? cssVar("--low") : cssVar("--muted");
    }
    function transitCount(v) {
      return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
    }
    function clock(v) {
      var ms = NaN;
      if (typeof v === "number") ms = v;
      else if (typeof v === "string" && v.indexOf("T") >= 0) ms = Date.parse(v);
      else if (typeof v === "string" && v.trim() && String(Number(v)) === v.trim()) ms = Number(v);
      if (!Number.isFinite(ms) || ms <= 0) return "Unknown";
      var date = new Date(ms);
      return Number.isFinite(date.getTime()) ? date.toISOString() : "Unknown";
    }
    function stat(k, v, color) {
      var wrap = el("div", "cstat");
      wrap.appendChild(el("span", "k", k));
      var val = el("span", "v", v);
      if (color) val.style.color = color;
      wrap.appendChild(val);
      return wrap;
    }

    var ts = d["transit-summaries"];
    var summaries = ts && typeof ts === "object" ? ts.summaries : null;
    var host = q("rows");
    host.textContent = "";
    var count = 0;
    var keySummary = summaries && typeof summaries === "object" && Array.isArray(summaries.sample_keys);
    if (keySummary) {
      var reported = summaries.count;
      var knownCount = typeof reported === "number" && Number.isFinite(reported) && Number.isInteger(reported) && reported >= summaries.sample_keys.length;
      host.appendChild(el("div", "empty", (knownCount ? "Summary reports " + reported + " chokepoints." : "Summary count is unavailable.") +
        " Transit records are not loaded."));
    } else if (summaries && typeof summaries === "object" && !Array.isArray(summaries)) {
      var keys = Object.keys(summaries);
      for (var i = 0; i < keys.length && count < 20; i++) {
        var s = summaries[keys[i]];
        if (!s || typeof s !== "object" || Array.isArray(s)) continue;
        var historyMissing = s.dataAvailable === false;
        var row = el("div", "crow");
        var head = el("div", "crow-head");
        head.appendChild(el("span", "cname", prettyName(keys[i])));
        var risk = typeof s.riskLevel === "string" ? collapseWs(s.riskLevel).toLowerCase() : "";
        if (["normal", "low", "moderate", "warning", "high", "elevated", "critical", "severe"].indexOf(risk) < 0) risk = "Unknown";
        var badge = el("span", "risk", risk);
        var rc = riskColor(risk);
        badge.style.color = rc;
        badge.style.borderColor = rc;
        head.appendChild(badge);
        row.appendChild(head);

        var stats = el("div", "cstats");
        var countsAvailable = s.todayCountsAvailable === undefined || s.todayCountsAvailable === true;
        var total = countsAvailable ? transitCount(s.todayTotal) : null;
        stats.appendChild(stat("Last 24 hours", total == null ? "—" : String(total)));
        var wow = s.dataAvailable === true && typeof s.wowChangePct === "number" && Number.isFinite(s.wowChangePct) ? s.wowChangePct : null;
        var wowColor = wow == null ? null : (wow >= 0 ? cssVar("--up") : cssVar("--down"));
        stats.appendChild(stat("Week over week", pctText(wow), wowColor));
        var tanker = countsAvailable ? transitCount(s.todayTanker) : null;
        stats.appendChild(stat("Tanker", tanker == null ? "—" : String(tanker)));
        row.appendChild(stats);

        if (historyMissing) row.appendChild(el("div", "csum", "PortWatch history unavailable"));
        else if (s.dataAvailable !== true) row.appendChild(el("div", "csum", "PortWatch history unknown"));
        if (s.riskSummary) row.appendChild(el("div", "csum", collapseWs(s.riskSummary)));
        host.appendChild(row);
        count++;
      }
    }
    if (!count && !keySummary) host.appendChild(el("div", "empty", "No chokepoint transit data available."));

    var transits = d.chokepoint_transits;
    var coverage = transits && typeof transits === "object" ? transits.transitCoverage : null;
    var coverageText = "";
    if (transits && typeof transits === "object" && !Array.isArray(transits)) {
      var covered = coverage && transitCount(coverage.covered);
      var totalRoutes = coverage && transitCount(coverage.total);
      var coverageKnown = covered != null && totalRoutes != null && totalRoutes > 0 && covered <= totalRoutes;
      coverageText = "AIS coverage: " + (coverageKnown ? covered + "/" + totalRoutes : "Unknown");
      var missing = coverage && coverage.missing;
      if (Array.isArray(missing) && missing.every(function(key) { return typeof key === "string" && key.trim().length > 0; })) {
        coverageText += " · Missing: " + (missing.length ? missing.map(prettyName).join(", ") : "None reported");
      } else coverageText += " · Missing: Unknown";
    }
    q("coverage").textContent = coverageText;
    var clocks = [];
    if (ts && typeof ts === "object" && !Array.isArray(ts) && (count || keySummary || ts.fetchedAt !== undefined)) clocks.push("Summary fetched: " + clock(ts.fetchedAt));
    if (transits && typeof transits === "object" && !Array.isArray(transits)) clocks.push("AIS fetched: " + clock(transits.fetchedAt));
    var baseline = d["chokepoint-baselines"];
    if (baseline && typeof baseline === "object" && !Array.isArray(baseline)) {
      var year = baseline.referenceYear;
      if (typeof year === "string" && String(Number(year)) === year) year = Number(year);
      var yearKnown = typeof year === "number" && Number.isInteger(year) && year >= 1900 && year <= 9999;
      clocks.push("Baseline: " + (typeof baseline.source === "string" && baseline.source.trim() ? collapseWs(baseline.source) : "Unknown source") +
        " · Reference year: " + (yearKnown ? String(year) : "Unknown") + " · Updated: " + clock(baseline.updatedAt));
    }
    if (envelope.cached_at !== undefined) clocks.push("Snapshot: " + (clock(envelope.cached_at) === "Unknown" ? "Unknown" : collapseWs(envelope.cached_at)) + (envelope.stale === true ? " (stale)" : ""));
    if (envelope.freshnessUnknown === true) clocks.push("Freshness: Unknown");
    q("foot").textContent = clocks.join("\\n");
`;

export const CHOKEPOINT_MONITOR_APP_HTML = buildAppHtml({
  title: 'Chokepoint Monitor — WorldMonitor',
  appName: 'worldmonitor-chokepoint-monitor',
  styles: STYLES,
  body: BODY,
  renderBody: RENDER,
});
