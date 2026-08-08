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

function planYahooRefresh({
  mandatoryYahooSymbols,
  missedPrimarySymbols,
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
    symbols: due
      ? [...new Set([...(mandatoryYahooSymbols || []), ...(missedPrimarySymbols || [])])]
      : [],
  };
}

module.exports = {
  mergeLastGoodQuotes,
  planYahooRefresh,
};
