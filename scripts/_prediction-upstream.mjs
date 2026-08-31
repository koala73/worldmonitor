const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLYMARKET_LIMIT = 100;
const DEFAULT_KALSHI_PAGE_SIZE = 200;
const DEFAULT_KALSHI_MAX_PAGES = 5;

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
  return Array.isArray(data) ? data : [];
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
