function marketQuotesKey(marketSymbols) {
  return `market:quotes:v1:${[...marketSymbols].sort().join(',')}`;
}

async function maintainClosedMarketEquityKeys({
  marketSymbols,
  marketSeedTtl,
  lastEquityQuoteCount = 0,
  upstashExpire,
  upstashGet,
  upstashSet,
  nowMs = () => Date.now(),
  metaTtlSeconds = 604800,
  preserveKeys = [],
}) {
  if (!marketSymbols || typeof marketSymbols[Symbol.iterator] !== 'function') {
    throw new Error('marketSymbols iterable is required');
  }
  if (typeof upstashExpire !== 'function') throw new Error('upstashExpire dependency is required');
  if (typeof upstashGet !== 'function') throw new Error('upstashGet dependency is required');
  if (typeof upstashSet !== 'function') throw new Error('upstashSet dependency is required');
  if (!preserveKeys || typeof preserveKeys[Symbol.iterator] !== 'function') {
    throw new Error('preserveKeys iterable is required');
  }

  const redisKey = marketQuotesKey(marketSymbols);
  const keys = [...new Set([redisKey, 'market:stocks-bootstrap:v1', ...preserveKeys])];
  const results = await Promise.all(keys.map((key) => upstashExpire(key, marketSeedTtl)));
  if (results.some((ok) => !ok)) return false;

  let count = lastEquityQuoteCount;
  if (!count) {
    const meta = await upstashGet('seed-meta:market:stocks');
    count = (meta && typeof meta.recordCount === 'number') ? meta.recordCount : 0;
  }
  if (count > 0) {
    await upstashSet('seed-meta:market:stocks', { fetchedAt: nowMs(), recordCount: count }, metaTtlSeconds);
  }
  return true;
}

module.exports = {
  marketQuotesKey,
  maintainClosedMarketEquityKeys,
};
