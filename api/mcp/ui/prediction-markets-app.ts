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
  .mkt-count { color: var(--muted); font-size: 10px; margin-left: 8px; }
  .mkt-more { margin: 8px 0; padding: 6px 10px; border: 1px solid var(--border); border-radius: 5px; background: transparent; color: var(--fg); cursor: pointer; }
  #groups { max-height: 560px; overflow: auto; }
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
      var href = httpUrl(m.url);
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
    for (let g = 0; g < buckets.length; g++) {
      let cfg = buckets[g];
      let raw = mb && mb[cfg.key];
      let list = listState(raw).items;
      if (!list.length) continue;
      let sec = el("div", "mgroup");
      let label = el("div", "sec-label", cfg.label);
      let reported = raw && !Array.isArray(raw) ? num(raw.count) : null;
      let total = reported == null ? list.length : Math.max(list.length, Math.floor(reported));
      let count = el("span", "mkt-count", Math.min(6, list.length) + " of " + total + " markets");
      label.appendChild(count);
      sec.appendChild(label);
      for (var i = 0; i < list.length && i < 6; i++) appendMarket(sec, list[i]);
      if (list.length > 6) {
        let more = el("button", "mkt-more", "Show more markets");
        more.type = "button";
        more.onclick = function () {
          var firstNew = sec.querySelectorAll(".mkt").length;
          more.remove();
          for (var j = 6; j < list.length; j++) appendMarket(sec, list[j]);
          var target = sec.querySelectorAll(".mkt")[firstNew];
          if (target) { target.tabIndex = -1; target.focus(); }
          count.textContent = list.length + " of " + total + " markets";
          reportSize();
        };
        sec.appendChild(more);
      }
      host.appendChild(sec);
    }
    if (!host.childNodes.length) host.appendChild(el("div", "empty", "No prediction markets available."));

    q("foot").textContent = envelope.cached_at
      ? "Snapshot: " + collapseWs(envelope.cached_at) + (envelope.stale ? " (stale)" : "")
      : "";
`;

export const PREDICTION_MARKETS_APP_HTML = buildAppHtml({
  title: 'Prediction Markets — WorldMonitor',
  appName: 'worldmonitor-prediction-markets',
  styles: STYLES,
  body: BODY,
  renderBody: RENDER,
});
