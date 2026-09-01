'use strict';

function mergeLastGoodQuotes(marketSymbols, freshQuotes, previousQuotes) {
  const freshBySymbol = new Map(
    (Array.isArray(freshQuotes) ? freshQuotes : [])
      .filter((quote) => quote && typeof quote.symbol === 'string')
      .map((quote) => [quote.symbol, quote]),
  );
  const previousBySymbol = new Map(
    (Array.isArray(previousQuotes) ? previousQuotes : [])
      .filter((quote) => quote && typeof quote.symbol === 'string')
      .map((quote) => [quote.symbol, quote]),
  );

  return [...marketSymbols]
    .map((symbol) => freshBySymbol.get(symbol) || previousBySymbol.get(symbol))
    .filter(Boolean);
}

function freshSymbolSet(freshQuotes) {
  return new Set(
    (Array.isArray(freshQuotes) ? freshQuotes : [])
      .filter((quote) => quote && typeof quote.symbol === 'string')
      .map((quote) => quote.symbol),
  );
}

/**
 * Batch `asOf` must not advance when any published quote was retained from
 * last-good. NQ Pulse labels the whole basket from this stamp, so a fresh
 * timestamp on stale Yahoo-only rows would read as Current.
 */
function resolveMergedQuotesAsOf(freshQuotes, mergedQuotes, previousAsOf, fetchedAtMs) {
  const freshSymbols = freshSymbolSet(freshQuotes);
  const retained = (Array.isArray(mergedQuotes) ? mergedQuotes : []).some(
    (quote) => quote && typeof quote.symbol === 'string' && !freshSymbols.has(quote.symbol),
  );
  if (retained) {
    return typeof previousAsOf === 'string' ? previousAsOf : '';
  }
  const fetchedAt = Number(fetchedAtMs);
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) return '';
  return new Date(fetchedAt).toISOString();
}

function planYahooRefresh({
  mandatoryYahooSymbols,
  missedPrimarySymbols,
  alwaysRefreshYahooSymbols,
  nowMs,
  lastRefreshAt,
  refreshIntervalMs,
}) {
  const now = Number(nowMs);
  const last = Number(lastRefreshAt);
  const interval = Number(refreshIntervalMs);
  const due = !Number.isFinite(last) || last <= 0 || !Number.isFinite(now)
    || !Number.isFinite(interval) || interval <= 0 || now < last || now - last >= interval;

  return {
    due,
    symbols: [...new Set([
      ...(due ? (mandatoryYahooSymbols || []) : []),
      ...(due ? (missedPrimarySymbols || []) : []),
      ...(alwaysRefreshYahooSymbols || []),
    ])],
  };
}

module.exports = {
  mergeLastGoodQuotes,
  planYahooRefresh,
  resolveMergedQuotesAsOf,
};
