'use strict';

// Yahoo rolls a chart to the next session before that session trades: futures
// on a weekend, day-session contracts before their open. The default (1d)
// chart then has no bars and quotes the last trade as its previous close, so a
// change computed from it reads 0.00%. The last completed session's move needs
// the close before that session, which only a daily chart carries.

const PREVIOUS_SESSION_CHART_QUERY = '?range=5d&interval=1d';
// Yahoo-backed cash equity indexes in the Markets catalog. Non-cash
// proxies (ETFs and futures), volatility indexes and yields are not included.
const INDEX_TIME_ZONES = Object.freeze({
  '^GSPC': 'America/New_York', '^DJI': 'America/New_York', '^IXIC': 'America/New_York',
  '000001.SS': 'Asia/Shanghai', '^HSI': 'Asia/Hong_Kong',
  '^NSEI': 'Asia/Kolkata', '^BSESN': 'Asia/Kolkata',
  '^FTSE': 'Europe/London', '^GDAXI': 'Europe/Berlin', '^FCHI': 'Europe/Paris',
  '^SSMI': 'Europe/Zurich', '^AEX': 'Europe/Amsterdam', '^IBEX': 'Europe/Madrid', 'FTSEMIB.MI': 'Europe/Rome',
  '^N225': 'Asia/Tokyo', '^KS11': 'Asia/Seoul', '^TWII': 'Asia/Taipei', '^AXJO': 'Australia/Sydney',
  '^STI': 'Asia/Singapore', '^JKSE': 'Asia/Jakarta', '^TASI.SR': 'Asia/Riyadh', 'DFMGI.AE': 'Asia/Dubai',
  '^BVSP': 'America/Sao_Paulo', '^GSPTSE': 'America/Toronto', '^MXX': 'America/Mexico_City',
  '^MERV': 'America/Argentina/Buenos_Aires',
});

const SESSION_FORMATTERS = new Map();
const INDEX_BASIS_TTL_SECONDS = 7 * 86400;
const INDEX_BASIS_RETRY_MS = 15 * 60 * 1000;
const INDEX_BASIS_FETCH_RETRY_MS = 5 * 60 * 1000;

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

function isYahooEquityIndex(symbol) {
  return Object.hasOwn(INDEX_TIME_ZONES, symbol);
}

function sessionFormatter(symbol) {
  if (!isYahooEquityIndex(symbol)) return null;
  let formatter = SESSION_FORMATTERS.get(symbol);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: INDEX_TIME_ZONES[symbol], year: 'numeric', month: '2-digit', day: '2-digit',
    });
    SESSION_FORMATTERS.set(symbol, formatter);
  }
  return formatter;
}

function indexSessionDay(formatter, timestamp) {
  const epochSeconds = finiteNumber(timestamp);
  if (!formatter || !(epochSeconds > 0) || epochSeconds > 8.64e12) return null;
  return formatter.format(epochSeconds * 1000);
}

/**
 * The 1d metadata can skip a trading day (e.g. Nov 24 Taiwan, Hong Kong,
 * Shanghai, Australia and Jakarta all quoted Nov 20 instead of Nov 23).
 * Establish the quote's exchange-local session via the daily rows and use
 * the preceding session's bar, never a range-level previous close field.
 */
function equityIndexPreviousSessionClose(symbol, data, lastTradeAt) {
  const formatter = sessionFormatter(symbol);
  const session = indexSessionDay(formatter, lastTradeAt);
  const result = data?.chart?.result?.[0];
  const timestamps = result?.timestamp;
  const closes = result?.indicators?.quote?.[0]?.close;
  if (session == null || !Array.isArray(timestamps) || !Array.isArray(closes)) return null;

  let foundSession = false;
  let priorSession = '';
  let priorClose = null;
  for (let i = 0; i < timestamps.length; i += 1) {
    // Compare session days, not times: the daily chart is fetched after the
    // quote, so its current bar can be stamped after the quote's last trade.
    const day = indexSessionDay(formatter, timestamps[i]);
    if (day == null) continue;
    if (day === session) {
      // The current daily close may still be null during the session.
      foundSession = true;
    } else if (day < session && day > priorSession) {
      priorSession = day;
      priorClose = finiteNumber(closes[i]);
    }
  }
  return foundSession && priorClose > 0 ? priorClose : null;
}

/**
 * Memoize a verified close per exchange session and symbol. Railway relay
 * and short-lived cron processes also share the optional Redis cache. A miss
 * delays retries briefly, without backfilling an older close or publishing a
 * move calculated from the unreliable quote metadata.
 *
 * Two kinds of miss back off differently:
 * - The daily chart loaded but has no prior-session bar. Every producer would
 *   see the same chart, so the 15-minute backoff is shared, and `writeIfAbsent`
 *   keeps it from replacing a close another producer verified.
 * - The request failed (429, timeout, block). That says nothing about the data
 *   and another producer's route may work, so only this `scope` backs off.
 */
function createYahooEquityIndexBasisResolver({ read, write, writeIfAbsent, scope = 'process', now = Date.now } = {}) {
  const local = new Map();
  const inFlight = new Map();
  const attempt = (operation) => Promise.resolve().then(operation).catch(() => null);
  const usable = (entry) => (
    (Number.isFinite(entry?.close) && entry.close > 0) ||
    (entry?.close === null && Number.isFinite(entry.retryAt) && entry.retryAt > now())
  );
  return async function resolveIndexClose(symbol, lastTradeAt, loadDaily) {
    const day = indexSessionDay(sessionFormatter(symbol), lastTradeAt);
    if (!day) return null;
    const key = `market:yahoo-index-close:v1:${symbol}:${day}`;
    const remembered = local.get(symbol);
    if (remembered?.day === day && usable(remembered)) return remembered.close;
    if (inFlight.has(key)) return inFlight.get(key);

    const retryKey = `${key}:retry:${scope}`;
    const remember = (entry) => local.set(symbol, { ...entry, day });
    const request = (async () => {
      for (const candidate of [key, retryKey]) {
        const cached = await attempt(() => read?.(candidate));
        if (usable(cached)) {
          remember(cached);
          return cached.close;
        }
      }
      const daily = await attempt(loadDaily);
      if (!daily) {
        const entry = { close: null, retryAt: now() + INDEX_BASIS_FETCH_RETRY_MS };
        remember(entry);
        await attempt(() => write?.(retryKey, entry, INDEX_BASIS_FETCH_RETRY_MS / 1000));
        return null;
      }
      const close = equityIndexPreviousSessionClose(symbol, daily, lastTradeAt);
      if (close === null) {
        const entry = { close: null, retryAt: now() + INDEX_BASIS_RETRY_MS };
        remember(entry);
        await attempt(() => writeIfAbsent?.(key, entry, INDEX_BASIS_RETRY_MS / 1000));
        return null;
      }
      remember({ close });
      await attempt(() => write?.(key, { close }, INDEX_BASIS_TTL_SECONDS));
      return close;
    })();
    inFlight.set(key, request);
    try {
      return await request;
    } finally {
      inFlight.delete(key);
    }
  };
}

module.exports = {
  PREVIOUS_SESSION_CHART_QUERY,
  INDEX_TIME_ZONES,
  awaitsSessionOpen,
  previousSessionClose,
  isYahooEquityIndex,
  equityIndexPreviousSessionClose,
  createYahooEquityIndexBasisResolver,
};
