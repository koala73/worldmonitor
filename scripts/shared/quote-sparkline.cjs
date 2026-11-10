'use strict';

// A quote sparkline covers the 24 hours ending at the last trade, in 5-minute
// bar closes. Yahoo's default chart starts at midnight New York time, so on its
// own it spans 53 minutes at one hour and 19 hours at another. The history
// chart supplies the bars before that. Bars with no trades are left out: a
// closed market is a gap, not a flat line nobody traded.

const SPARKLINE_INTERVAL_SECONDS = 300;
const SPARKLINE_WINDOW_SECONDS = 24 * 60 * 60;
const SPARKLINE_HISTORY_QUERY = '?range=2d&interval=5m';

const SPIKE_MAD_MULTIPLE = 10;
const SPIKE_MIN_MOVE = 0.002;
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

// A bad tick jumps away from both neighbours in the same direction, and the
// next print returns to where the previous one was. A move that holds is kept,
// and so is any print next to a trading gap.
function dropSingleTickSpikes(bars) {
  if (bars.length < 3) return bars;
  const diffs = bars.slice(1).map((bar, i) => bar.v - bars[i].v);
  const kept = [bars[0]];
  for (let i = 1; i < bars.length - 1; i += 1) {
    const prev = bars[i - 1];
    const cur = bars[i];
    const next = bars[i + 1];
    if (cur.t - prev.t > TRADING_GAP_SECONDS || next.t - cur.t > TRADING_GAP_SECONDS) {
      kept.push(cur);
      continue;
    }
    const up = cur.v - prev.v;
    const down = cur.v - next.v;
    const window = diffs.slice(Math.max(0, i - SPIKE_MAD_RADIUS), i + SPIKE_MAD_RADIUS);
    const center = median(window);
    const mad = median(window.map((d) => Math.abs(d - center)));
    const threshold = Math.max(SPIKE_MAD_MULTIPLE * mad, SPIKE_MIN_MOVE * Math.abs(prev.v));
    const spike = Math.sign(up) === Math.sign(down)
      && Math.min(Math.abs(up), Math.abs(down)) > threshold
      && Math.abs(next.v - prev.v) < Math.min(Math.abs(up), Math.abs(down)) / 2;
    if (!spike) kept.push(cur);
  }
  kept.push(bars[bars.length - 1]);
  return kept;
}

/**
 * Build the 24-hour sparkline from the quote's default chart and, when
 * available, a SPARKLINE_HISTORY_QUERY chart of the same symbol. Returns the
 * values with the bar width in seconds and the first bar's start in epoch ms,
 * or an empty series with no labels.
 */
function buildQuoteSparkline(chart, history) {
  const recent = chartBars(chart);
  const recentStart = recent.length > 0 ? recent[0].t : Infinity;
  const bars = dropSingleTickSpikes([...chartBars(history).filter((bar) => bar.t < recentStart), ...recent]);
  if (bars.length === 0) return { sparkline: [] };

  const lastBucket = Math.floor(bars[bars.length - 1].t / SPARKLINE_INTERVAL_SECONDS) * SPARKLINE_INTERVAL_SECONDS;
  const firstBucket = lastBucket - SPARKLINE_WINDOW_SECONDS + SPARKLINE_INTERVAL_SECONDS;
  const closes = new Map();
  for (const bar of bars) {
    const bucket = Math.floor(bar.t / SPARKLINE_INTERVAL_SECONDS) * SPARKLINE_INTERVAL_SECONDS;
    if (bucket >= firstBucket) closes.set(bucket, bar.v);
  }
  const buckets = [...closes.keys()].sort((a, b) => a - b);
  return {
    sparkline: buckets.map((bucket) => closes.get(bucket)),
    sparklineIntervalSeconds: SPARKLINE_INTERVAL_SECONDS,
    sparklineStartAt: buckets[0] * 1000,
  };
}

module.exports = {
  SPARKLINE_INTERVAL_SECONDS,
  SPARKLINE_WINDOW_SECONDS,
  SPARKLINE_HISTORY_QUERY,
  buildQuoteSparkline,
};
