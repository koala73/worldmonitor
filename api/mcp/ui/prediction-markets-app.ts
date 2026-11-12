import { buildAppHtml } from './shell';

const STYLES = `
  .mgroup { margin-top: 14px; }
  .mgroup:first-child { margin-top: 4px; }
  .sec-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 6px; }
  .mkt { padding: 7px 0; border-bottom: 1px solid var(--border); }
  .mkt:last-child { border-bottom: none; }
  .mkt:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
  .mkt-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .mkt-title { font-size: 13px; color: var(--fg); min-width: 0; }
  .mkt-prob { font-variant-numeric: tabular-nums; font-weight: 700; font-size: 13px; white-space: nowrap; }
  .mkt-src { font-size: 10px; letter-spacing: 0.05em; color: var(--muted); }
  .mkt-title { overflow-wrap: anywhere; }
  a.mkt-title { text-decoration: none; }
  a.mkt-title:hover { text-decoration: underline; }
  .mkt-meta { display: flex; flex-wrap: wrap; gap: 6px 12px; color: var(--muted); font-size: 11px; margin-top: 4px; }
  .mkt-conviction { color: var(--muted); }
  .conv-yes, .mkt-yes { color: var(--accent); }
  .conv-no, .mkt-no { color: var(--severe); }
  .mkt-outcomes { display: flex; justify-content: space-between; font-size: 11px; margin-top: 5px; }
  .mkt .pbar { background: color-mix(in srgb, var(--severe) 30%, var(--border)); }
  .mkt-count { color: var(--muted); font-size: 11px; margin-left: 8px; text-transform: none; letter-spacing: 0; }
  .mkt-coverage { font-size: 12px; }
  .mkt-more { margin: 8px 0; padding: 6px 10px; border: 1px solid var(--border); border-radius: 5px; background: transparent; color: var(--fg); cursor: pointer; }
`;

const BODY = `
  <div class="head">
    <div class="title">Prediction Markets</div>
    <div class="badge">WorldMonitor Markets</div>
  </div>
  <div class="empty" id="empty">Waiting for market odds…</div>
  <div id="card" style="display:none">
    <div id="groups"></div>
    <div class="foot" id="foot"></div>
  </div>
`;

const RENDER = `
    if (!data || typeof data !== "object") return;
    var value = Object.prototype.hasOwnProperty.call(data, "projection") ? data.projection : data;
    var envelope = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    var d = envelope.data && typeof envelope.data === "object" ? envelope.data : envelope;
    q("empty").style.display = "none";
    q("card").style.display = "block";

    var mb = d["markets-bootstrap"] && typeof d["markets-bootstrap"] === "object" ? d["markets-bootstrap"] : null;
    var buckets = [
      { key: "geopolitical", label: "Geopolitical" },
      { key: "tech", label: "Tech" },
      { key: "finance", label: "Finance" }
    ];
    var host = q("groups");
    host.textContent = "";
    function appendMarket(sec, m) {
      if (!m || typeof m !== "object") return;
      var mkt = el("div", "mkt");
      var head = el("div", "mkt-head");
      var href = httpUrl(m.source === "kalshi" ? m.displayUrl ?? m.url : m.url);
      var title = el(href ? "a" : "span", "mkt-title", collapseWs(m.title) || "Market");
      if (href) { title.href = href; title.target = "_blank"; title.rel = "noopener noreferrer"; }
      head.appendChild(title);
      var p = num(m.yesPrice);
      var pct = p == null ? null : Math.round(clampPct(p));
      head.appendChild(el("span", "mkt-prob", pct == null ? "—" : pct + "%"));
      mkt.appendChild(head);
      var meta = el("div", "mkt-meta");
      var src = collapseWs(m.source);
      if (src) meta.appendChild(el("span", "mkt-src", src === "kalshi" ? "Kalshi" : src === "polymarket" ? "Polymarket" : src));
      var volume = num(m.volume);
      if (volume != null && volume > 0) {
        var amount = volume >= 1000000 ? (volume / 1000000).toFixed(1) + "M"
          : volume >= 1000 ? (volume / 1000).toFixed(0) + "K" : volume.toFixed(0);
        meta.appendChild(el("span", "mkt-volume", "Vol: $" + amount));
      }
      if (typeof m.endDate === "string") {
        var closes = new Date(m.endDate);
        if (Number.isFinite(closes.getTime())) meta.appendChild(el("span", "mkt-closes", "Closes: " + closes.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })));
      }
      if (pct != null) meta.appendChild(el("span", "mkt-conviction " + (pct >= 60 ? "conv-yes" : pct <= 40 ? "conv-no" : "conv-neutral"), pct >= 60 ? "Lean Yes" : pct <= 40 ? "Lean No" : "Toss-up"));
      mkt.appendChild(meta);
      var outcomes = el("div", "mkt-outcomes");
      outcomes.appendChild(el("span", "mkt-yes", "Yes " + (pct == null ? "—" : pct + "%")));
      outcomes.appendChild(el("span", "mkt-no", "No " + (pct == null ? "—" : (100 - pct) + "%")));
      mkt.appendChild(outcomes);
      var bar = probabilityBar(pct);
      if (bar) mkt.appendChild(bar);
      sec.appendChild(mkt);
    }
    function plural(n, word) { return n.toLocaleString("en-US") + " " + word + (n === 1 ? "" : "s"); }
    function listNames(names) {
      return names.length < 2 ? names.join("") : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
    }
    var unavailable = [];
    var unsampled = [];
    for (let g = 0; g < buckets.length; g++) {
      let cfg = buckets[g];
      let raw = mb && mb[cfg.key];
      let state = listState(raw);
      let list = state.items;
      let reported = raw && !Array.isArray(raw) ? num(raw.count) : null;
      if (!state.available) unavailable.push(cfg.label);
      if (!list.length) {
        if (reported != null && reported > 0) unsampled.push(cfg.label + ": " + plural(Math.floor(reported), "market") + " reported, but none were included to show.");
        continue;
      }
      let sec = el("div", "mgroup");
      let label = el("div", "sec-label", cfg.label);
      let total = reported == null ? list.length : Math.max(list.length, Math.floor(reported));
      label.appendChild(el("span", "mkt-count", plural(total, "market")));
      sec.appendChild(label);
      for (var i = 0; i < list.length && i < 6; i++) appendMarket(sec, list[i]);
      if (list.length > 6) {
        let more = el("button", "mkt-more", "Show " + (list.length - 6) + " more");
        more.type = "button";
        more.onclick = function () {
          var firstNew = sec.querySelectorAll(".mkt").length;
          more.remove();
          for (var j = 6; j < list.length; j++) appendMarket(sec, list[j]);
          var target = sec.querySelectorAll(".mkt")[firstNew];
          if (target) { target.tabIndex = -1; target.focus(); }
          reportSize();
        };
        sec.appendChild(more);
      }
      // A summary carries a sample; say so rather than imply the list is whole.
      if (list.length < total) sec.appendChild(el("div", "empty mkt-coverage", "Showing " + list.length + " of " + total + "; the rest were not included in this response."));
      host.appendChild(sec);
    }
    if (!host.childNodes.length && !unsampled.length) host.appendChild(el("div", "empty",
      unavailable.length === buckets.length ? "Prediction data unavailable."
        : unavailable.length ? "No markets in the categories that loaded."
        : "No markets in this response."));
    if (unavailable.length) host.appendChild(el("div", "empty mkt-coverage", listNames(unavailable) + " markets were not included or could not be loaded."));
    unsampled.forEach(function (notice) { host.appendChild(el("div", "empty mkt-coverage", notice)); });

    var updated = envelope.cached_at ? utcTime(envelope.cached_at) || collapseWs(envelope.cached_at) : "";
    var notices = [updated ? "Updated " + updated : "Update time unknown"];
    if (envelope.stale) notices[0] += " (out of date)";
    if (envelope.freshnessUnknown) notices.push("Freshness could not be checked");
    if (envelope.degraded || mb && mb.degraded) notices.push("Some market sources failed");
    // Error codes such as "kalshi_fetch_failed" name the source in plain
    // words; other error text is not shown to the reader.
    var sourceError = collapseWs(envelope.error || mb && mb.error);
    if (sourceError) {
      var failedSuffix = "_fetch_failed";
      var failedName = sourceError.length > failedSuffix.length && sourceError.slice(-failedSuffix.length) === failedSuffix
        ? sourceError.slice(0, -failedSuffix.length) : "";
      var sourceNames = { kalshi: "Kalshi", polymarket: "Polymarket" };
      notices.push(Object.prototype.hasOwnProperty.call(sourceNames, failedName)
        ? sourceNames[failedName] + " could not be reached" : "A market source reported an error");
    }
    q("foot").textContent = notices.join(" · ");
`;

export const PREDICTION_MARKETS_APP_HTML = buildAppHtml({
  title: 'Prediction Markets — WorldMonitor',
  appName: 'worldmonitor-prediction-markets',
  styles: STYLES,
  body: BODY,
  renderBody: RENDER,
});
