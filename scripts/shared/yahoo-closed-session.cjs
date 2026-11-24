'use strict';

// Yahoo rolls a chart to the next session before that session trades: futures
// on a weekend, day-session contracts before their open. The default (1d)
// chart then has no bars and quotes the last trade as its previous close, so a
// change computed from it reads 0.00%. The last completed session's move needs
// the close before that session, which only a daily chart carries.

const PREVIOUS_SESSION_CHART_QUERY = '?range=5d&interval=1d';
const TAIEX_SYMBOL = '^TWII';

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

/** Taipei's UTC+8 civil day identifies the TAIEX session that traded. */
function taiexSessionDay(timestamp) {
  const epochSeconds = finiteNumber(timestamp);
  return epochSeconds != null && epochSeconds > 0
    ? Math.floor((epochSeconds + 8 * 3600) / 86400)
    : null;
}

/**
 * On Nov 24 Yahoo's 1d ^TWII metadata used Nov 20 as the prior close, skipping
 * Nov 23. Use daily bars for this index even after the market is open.
 * Require a row matching the quote session (the current close may be null
 * intraday), and do not skip a missing preceding close to an older value.
 */
function taiexPreviousSessionClose(data, lastTradeAt) {
  const tradeAt = finiteNumber(lastTradeAt);
  const session = taiexSessionDay(tradeAt);
  const result = data?.chart?.result?.[0];
  const timestamps = result?.timestamp;
  const closes = result?.indicators?.quote?.[0]?.close;
  if (session == null || !Array.isArray(timestamps) || !Array.isArray(closes)) return null;

  let foundSession = false;
  let priorSession = -Infinity;
  let priorClose = null;
  for (let i = 0; i < timestamps.length; i += 1) {
    const barAt = finiteNumber(timestamps[i]);
    const day = taiexSessionDay(barAt);
    if (day == null || barAt > tradeAt) continue;
    if (day === session) {
      foundSession = true;
    } else if (day < session && day > priorSession) {
      priorSession = day;
      priorClose = finiteNumber(closes[i]);
    }
  }
  return foundSession && priorClose > 0 ? priorClose : null;
}

module.exports = {
  PREVIOUS_SESSION_CHART_QUERY,
  TAIEX_SYMBOL,
  awaitsSessionOpen,
  previousSessionClose,
  taiexPreviousSessionClose,
  taiexSessionDay,
};
