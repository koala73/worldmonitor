const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLYMARKET_LIMIT = 100;
const DEFAULT_KALSHI_PAGE_SIZE = 200;
const DEFAULT_KALSHI_MAX_PAGES = 5;
const DEFAULT_KALSHI_MARKETS_PAGE_SIZE = 1000;
const DEFAULT_KALSHI_SERIES_MARKET_MAX_PAGES = 5;

function requestHeaders(userAgent) {
  return { Accept: 'application/json', 'User-Agent': userAgent };
}

export async function fetchPolymarketEventsByTag(tag, {
  fetchFn = globalThis.fetch,
  baseUrl,
  userAgent,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  limit = DEFAULT_POLYMARKET_LIMIT,
  now = new Date(),
} = {}) {
  const params = new URLSearchParams({
    tag_slug: tag,
    closed: 'false',
    active: 'true',
    archived: 'false',
    end_date_min: now.toISOString(),
    order: 'volume',
    ascending: 'false',
    limit: String(limit),
  });
  const response = await fetchFn(`${baseUrl.replace(/\/$/, '')}/events?${params}`, {
    headers: requestHeaders(userAgent),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Polymarket HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error('Polymarket invalid payload: expected an array');
  return data;
}

export async function fetchKalshiEvents({
  fetchFn = globalThis.fetch,
  baseUrl,
  userAgent,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pageSize = DEFAULT_KALSHI_PAGE_SIZE,
  maxPages = DEFAULT_KALSHI_MAX_PAGES,
  onPageError,
} = {}) {
  const events = [];
  const seenCursors = new Set();
  let cursor = '';

  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({
      status: 'open',
      with_nested_markets: 'true',
      limit: String(pageSize),
    });
    if (cursor) params.set('cursor', cursor);

    let data;
    try {
      const response = await fetchFn(`${baseUrl.replace(/\/$/, '')}/events?${params}`, {
        headers: requestHeaders(userAgent),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`Kalshi HTTP ${response.status}`);
      data = await response.json();
      if (!Array.isArray(data?.events)) {
        throw new Error('Kalshi invalid payload: expected events array');
      }
    } catch (error) {
      if (events.length === 0) throw error;
      onPageError?.(error, page + 1);
      break;
    }
    if (Array.isArray(data?.events)) events.push(...data.events);

    const nextCursor = typeof data?.cursor === 'string' ? data.cursor.trim() : '';
    if (!nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return events;
}

export async function fetchKalshiSeries({
  fetchFn = globalThis.fetch,
  baseUrl,
  userAgent,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const params = new URLSearchParams({ include_volume: 'true' });
  const response = await fetchFn(`${baseUrl.replace(/\/$/, '')}/series?${params}`, {
    headers: requestHeaders(userAgent),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Kalshi HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data?.series)) {
    throw new Error('Kalshi invalid payload: expected series array');
  }
  return data.series;
}

export async function fetchKalshiMarketsBySeries(seriesTickers, {
  fetchFn = globalThis.fetch,
  baseUrl,
  userAgent,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pageSize = DEFAULT_KALSHI_MARKETS_PAGE_SIZE,
  maxPagesPerSeries = DEFAULT_KALSHI_SERIES_MARKET_MAX_PAGES,
  maxRequests = Number.POSITIVE_INFINITY,
  onRequest,
} = {}) {
  const markets = [];
  const uniqueTickers = [...new Set((seriesTickers ?? [])
    .map((ticker) => String(ticker).trim())
    .filter(Boolean))];
  const parsedMaxRequests = Number(maxRequests);
  const requestLimit = Number.isFinite(parsedMaxRequests)
    ? Math.max(0, Math.floor(parsedMaxRequests))
    : Number.POSITIVE_INFINITY;
  let requestCount = 0;

  for (const seriesTicker of uniqueTickers) {
    const seenCursors = new Set();
    let cursor = '';

    for (let page = 0; page < maxPagesPerSeries; page += 1) {
      if (requestCount >= requestLimit) {
        throw new Error(`Kalshi markets request budget exceeded ${requestLimit} requests`);
      }
      const params = new URLSearchParams({
        status: 'open',
        series_ticker: seriesTicker,
        limit: String(pageSize),
        mve_filter: 'exclude',
      });
      if (cursor) params.set('cursor', cursor);

      requestCount += 1;
      onRequest?.({ requestCount, seriesTicker, page: page + 1 });
      const response = await fetchFn(`${baseUrl.replace(/\/$/, '')}/markets?${params}`, {
        headers: requestHeaders(userAgent),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`Kalshi HTTP ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data?.markets)) {
        throw new Error('Kalshi invalid payload: expected markets array');
      }
      markets.push(...data.markets.map(market => ({ ...market, series_ticker: seriesTicker })));

      const nextCursor = typeof data.cursor === 'string' ? data.cursor.trim() : '';
      if (!nextCursor) {
        cursor = '';
        break;
      }
      if (seenCursors.has(nextCursor)) {
        throw new Error(`Kalshi markets repeated cursor for ${seriesTicker}`);
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    if (cursor) {
      throw new Error(
        `Kalshi markets pagination exceeded ${maxPagesPerSeries} pages for ${seriesTicker}`,
      );
    }
  }

  return markets;
}

const KALSHI_ORDERBOOK_CHUNK = 100;
const KALSHI_MARKET_URL = /^https:\/\/kalshi\.com\/markets\/([A-Za-z0-9._-]+)$/;

function parseBookNumber(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

// Resting depth in USD: every bid level on both sides (yes bids and no bids),
// price times size. An empty book is a known 0; an unreadable one is unknown.
export function kalshiOrderbookDepth(book) {
  const orderbook = book?.orderbook_fp;
  if (!orderbook || typeof orderbook !== 'object') return null;
  let total = 0;
  for (const side of [orderbook.yes_dollars, orderbook.no_dollars]) {
    if (side == null) continue;
    if (!Array.isArray(side)) return null;
    for (const level of side) {
      const price = parseBookNumber(level?.[0]);
      const size = parseBookNumber(level?.[1]);
      if (price === null || size === null) return null;
      total += price * size;
    }
  }
  return Math.round(total * 100) / 100;
}

export async function fetchKalshiOrderbookDepths(tickers, {
  fetchFn = globalThis.fetch,
  baseUrl,
  userAgent,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retry = (fn) => fn(),
  onChunkError,
} = {}) {
  const unique = [...new Set((tickers ?? []).map((ticker) => String(ticker).trim()).filter(Boolean))];
  const depths = new Map();
  for (let start = 0; start < unique.length; start += KALSHI_ORDERBOOK_CHUNK) {
    const chunk = unique.slice(start, start + KALSHI_ORDERBOOK_CHUNK);
    // Kalshi reads a comma-joined value as one ticker; each needs its own key.
    const params = new URLSearchParams(chunk.map((ticker) => ['tickers', ticker]));
    try {
      const books = await retry(async () => {
        const response = await fetchFn(`${baseUrl.replace(/\/$/, '')}/markets/orderbooks?${params}`, {
          headers: requestHeaders(userAgent),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          const error = new Error(`Kalshi orderbooks HTTP ${response.status}`);
          if (response.status >= 400 && response.status < 500 && response.status !== 429) error.nonRetryable = true;
          throw error;
        }
        const data = await response.json();
        if (!Array.isArray(data?.orderbooks)) throw new Error('Kalshi orderbooks invalid payload: expected orderbooks array');
        return data.orderbooks;
      });
      const requested = new Set(chunk);
      for (const book of books) {
        const depth = kalshiOrderbookDepth(book);
        if (depth !== null && requested.has(book?.ticker)) depths.set(book.ticker, depth);
      }
    } catch (error) {
      onChunkError?.(error, chunk);
    }
  }
  return depths;
}

export async function attachKalshiLiquidity(records, options = {}) {
  const kalshiRecords = (records ?? [])
    .filter((record) => record?.source === 'kalshi')
    .map((record) => ({ record, ticker: KALSHI_MARKET_URL.exec(String(record.url ?? ''))?.[1] }))
    .filter(({ ticker }) => ticker);
  const tickers = [...new Set(kalshiRecords.map(({ ticker }) => ticker))];
  const depths = await fetchKalshiOrderbookDepths(tickers, options);
  for (const { record, ticker } of kalshiRecords) {
    if (depths.has(ticker)) record.liquidity = depths.get(ticker);
  }
  return { tickers: tickers.length, priced: depths.size };
}
