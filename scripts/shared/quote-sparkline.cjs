'use strict';

// A quote sparkline covers the last 24 trading hours: the latest 288 5-minute
// bars that had trades. Across a daily close or a weekend it reaches back into
// the previous session, so it does not shrink to a few bars after every open.
// Yahoo's default chart starts at midnight New York time, so on its own it
// spans 53 minutes at one hour and 19 hours at another. The 3-day history chart
// supplies the bars before that. Yahoo cuts it at New York midnight and counts
// Sunday's evening session as a day, so on Sunday evening it still holds
// Thursday evening and all of Friday. Bars with no trades are left out: a closed
// market is a gap, not a flat line nobody traded. A thin contract that trades
// fewer than 24 hours in those three days keeps all its bars, and
// sparklineStartAt names the first one.

const SPARKLINE_INTERVAL_SECONDS = 300;
const SPARKLINE_WINDOW_SECONDS = 24 * 60 * 60;
const SPARKLINE_POINTS = SPARKLINE_WINDOW_SECONDS / SPARKLINE_INTERVAL_SECONDS;
const SPARKLINE_HISTORY_QUERY = '?range=3d&interval=5m';
// After a failed history request, both writers wait this long before asking
// again, so a Yahoo 429 episode does not cost one extra request per symbol
// every cycle.
const SPARKLINE_HISTORY_RETRY_SECONDS = 15 * 60;

const SPIKE_MAD_MULTIPLE = 10;
const SPIKE_CHANGE_MULTIPLE = 6;
const SPIKE_MAD_RADIUS = 30;
// Thin contracts skip minutes all the time; a trading gap is a closed market.
const TRADING_GAP_SECONDS = 15 * 60;

function finiteNumber(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function chartBars(data) {
  const result = data?.chart?.result?.[0];
  const timestamps = result?.timestamp;
  const closes = result?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(timestamps) || !Array.isArray(closes)) return [];
  const bars = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const t = finiteNumber(timestamps[i]);
    const v = finiteNumber(closes[i]);
    if (t != null && v != null) bars.push({ t, v });
  }
  return bars;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Remove locally anomalous, bounded reversals from timestamped quote bars.
 * Keep sustained moves, session opens, and sparse pairs that do not cluster.
 * Sparse two-print neighborhoods are decided before singleton removal so a
 * broad reversal cannot be erased by chaining two singleton decisions.
 * @param {{t: number, v: number}[]} bars Quote bars in provider order.
 * @returns {{t: number, v: number}[]} Retained bars, including both endpoints.
 */
function dropSingleTickSpikes(bars) {
  if (bars.length < 3) return bars;
  const diffs = bars.slice(1).map((bar, i) => bar.v - bars[i].v);
  const kept = [bars[0]];
  for (let i = 1; i < bars.length - 1; i += 1) {
    const prev = kept.at(-1);
    let consumed = 0;
    for (const length of [2, 1]) {
      const next = bars[i + length];
      if (!next) continue;
      const island = bars.slice(i, i + length);
      const gapBefore = island[0].t - prev.t > TRADING_GAP_SECONDS;
      const gapAfter = next.t - island.at(-1).t > TRADING_GAP_SECONDS;
      if (gapBefore !== gapAfter) continue;
      // Dense adjacent closes confirm a move. Only sparse contracts admit a
      // two-print island, with trading gaps on both sides and between prints.
      if (length === 2 && (!gapBefore || island[1].t - island[0].t <= TRADING_GAP_SECONDS)) continue;
      const window = diffs.slice(Math.max(0, i - SPIKE_MAD_RADIUS), i - 1)
        .concat(diffs.slice(i + length, i + length + SPIKE_MAD_RADIUS));
      // Without independent changes, a short tape cannot distinguish a
      // genuine reversal from noise. Keep it until volatility is measurable.
      if (window.length < 3) continue;
      const center = median(window);
      const mad = median(window.map((d) => Math.abs(d - center)));
      // Calibrate to this symbol's local tape, excluding the candidate's
      // entry/exit moves. Flat tapes need only a floating-point noise floor.
      const threshold = Math.max(SPIKE_MAD_MULTIPLE * mad,
        SPIKE_CHANGE_MULTIPLE * median(window.map(Math.abs)),
        Number.EPSILON * Math.max(1, Math.abs(prev.v)) * 32);
      const direction = Math.sign(island[0].v - prev.v);
      const departure = Math.min(...island.flatMap((bar) => [Math.abs(bar.v - prev.v), Math.abs(bar.v - next.v)]));
      const spike = island.every((bar) => Math.sign(bar.v - prev.v) === direction && Math.sign(bar.v - next.v) === direction)
        && departure > threshold
        && Math.abs(next.v - prev.v) < departure;
      if (spike) {
        const clustered = Math.max(...island.map((bar) => bar.v)) - Math.min(...island.map((bar) => bar.v)) < departure / 2;
        // A broad two-print reversal is evidence of movement, not an island.
        // Consume both prints so a later singleton cannot erase the second.
        if (!clustered) kept.push(...island);
        consumed = length;
        break;
      }
    }
    if (consumed) i += consumed - 1;
    else kept.push(bars[i]);
  }
  kept.push(bars[bars.length - 1]);
  return kept;
}

/**
 * Put a point back where the spike filter removed one from a continuously
 * trading tape. The client spaces points evenly from sparklineStartAt, so a
 * removed close would shift every later point 5 minutes early. The replacement
 * is the straight line between the retained closes around it. A removal next to
 * a trading gap is left out: that tape has no even spacing to preserve.
 * @param {{t: number, v: number|null}[]} ordered Every close, and a v:null entry per bucket whose prints were all removed, oldest first.
 * @param {Set<object>} keptSet The closes the filter retained, same objects.
 */
function fillDroppedCloses(ordered, keptSet) {
  // One backward pass finds each position's next retained close, so a long run
  // of removals costs O(n), not O(n^2).
  const nextKept = new Array(ordered.length);
  let upcoming;
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    nextKept[i] = upcoming;
    if (keptSet.has(ordered[i])) upcoming = ordered[i];
  }
  const out = [];
  let before;
  for (let i = 0; i < ordered.length; i += 1) {
    const bar = ordered[i];
    if (keptSet.has(bar)) { out.push(bar); before = bar; continue; }
    const after = nextKept[i];
    if (!before || !after) continue;
    // The filter only drops interior bars, so both neighbours exist; a gap on
    // either side of the removed run means it was not part of a dense tape.
    if (bar.t - before.t > TRADING_GAP_SECONDS || after.t - bar.t > TRADING_GAP_SECONDS) continue;
    const ratio = (bar.t - before.t) / (after.t - before.t);
    out.push({ t: bar.t, v: before.v + (after.v - before.v) * ratio });
  }
  return out;
}

/**
 * Build the 24-trading-hour sparkline from the quote's default chart and, when
 * available, a SPARKLINE_HISTORY_QUERY chart of the same symbol. Returns the
 * values with the bar width in seconds and the first bar's start in epoch ms,
 * or an empty series with no labels.
 */
function buildQuoteSparkline(chart, history) {
  const recent = chartBars(chart);
  const recentStart = recent.length > 0 ? recent[0].t : Infinity;
  const raw = [...chartBars(history).filter((bar) => bar.t < recentStart), ...recent];
  const bars = dropSingleTickSpikes(raw);
  if (bars.length === 0) return { sparkline: [] };

  const bucketOf = (bar) => Math.floor(bar.t / SPARKLINE_INTERVAL_SECONDS) * SPARKLINE_INTERVAL_SECONDS;
  const closes = new Map();
  // Keep the closing print's actual time for trading-gap decisions. Rounding
  // a 16-minute gap to 15 minutes must not change a sparse pair's treatment.
  for (const bar of bars) closes.set(bucketOf(bar), bar);
  // A bucket whose every print the filter removed still occupies a slot on the
  // client's even time axis; fillDroppedCloses puts it back. It keeps the last
  // removed print's own time, like the retained closes, for distances and gaps.
  const lost = new Map();
  for (const bar of raw) if (!closes.has(bucketOf(bar))) lost.set(bucketOf(bar), { t: bar.t, v: null });
  // A bad print that follows a smaller bad print passes the first pass, then
  // becomes its bucket's close: USDTRY read 50.207, 50.113, 50.207 on a 50.229
  // tape. The filter runs again on the closes, before the window is cut, so
  // the window's first close is tested against the close before it.
  const real = [...closes.values()].sort((a, b) => a.t - b.t);
  const all = [...real, ...lost.values()].sort((a, b) => a.t - b.t);
  const points = fillDroppedCloses(all, new Set(dropSingleTickSpikes(real))).slice(-SPARKLINE_POINTS);
  return {
    sparkline: points.map((point) => point.v),
    sparklineIntervalSeconds: SPARKLINE_INTERVAL_SECONDS,
    sparklineStartAt: Math.floor(points[0].t / SPARKLINE_INTERVAL_SECONDS) * SPARKLINE_INTERVAL_SECONDS * 1000,
  };
}

module.exports = {
  SPARKLINE_INTERVAL_SECONDS,
  SPARKLINE_WINDOW_SECONDS,
  SPARKLINE_HISTORY_QUERY,
  SPARKLINE_HISTORY_RETRY_SECONDS,
  buildQuoteSparkline,
};
