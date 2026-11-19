'use strict';

// Yahoo rolls a chart to the next session before that session trades: futures
// on a weekend, day-session contracts before their open. The default (1d)
// chart then has no bars and quotes the last trade as its previous close, so a
// change computed from it reads 0.00%. The last completed session's move needs
// the close before that session, which only a daily chart carries.

const PREVIOUS_SESSION_CHART_QUERY = '?range=5d&interval=1d';

function finiteNumber(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** True when a 1d chart's last trade predates its session and its previous close is that trade. */
function awaitsSessionOpen(data) {
  const meta = data?.chart?.result?.[0]?.meta;
  const price = finiteNumber(meta?.regularMarketPrice);
  const lastTradeAt = finiteNumber(meta?.regularMarketTime);
  const sessionStart = finiteNumber(meta?.currentTradingPeriod?.regular?.start);
  if (price == null || lastTradeAt == null || sessionStart == null || lastTradeAt >= sessionStart) return false;
  const quotedPrevClose = [meta.chartPreviousClose, meta.previousClose]
    .map(finiteNumber)
    .find((value) => value != null && value !== 0);
  return quotedPrevClose == null || quotedPrevClose === price;
}

/**
 * Close of the session before the one holding the last trade, from a daily
 * chart. Bars after the last trade (a session that has not traded) are skipped.
 * A daily chart's chartPreviousClose is the close before its whole range, so
 * it cannot stand in for this. Pass the quote's own `lastTradeAt` when the
 * daily chart was fetched separately: trading may open in between.
 */
function previousSessionClose(data, lastTradeAt = data?.chart?.result?.[0]?.meta?.regularMarketTime) {
  const result = data?.chart?.result?.[0];
  lastTradeAt = finiteNumber(lastTradeAt);
  const timestamps = result?.timestamp;
  const closes = result?.indicators?.quote?.[0]?.close;
  if (lastTradeAt == null || !Array.isArray(timestamps) || !Array.isArray(closes)) return null;
  const sessionCloses = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const close = finiteNumber(closes[i]);
    if (timestamps[i] <= lastTradeAt && close != null && close !== 0) sessionCloses.push(close);
  }
  return sessionCloses.length >= 2 ? sessionCloses[sessionCloses.length - 2] : null;
}

module.exports = {
  PREVIOUS_SESSION_CHART_QUERY,
  awaitsSessionOpen,
  previousSessionClose,
};
