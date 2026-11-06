/**
 * One ticker-normalization rule for stored market snapshots and the clients
 * that look them up. The server used to uppercase on write while freshness
 * helpers compared the watchlist string as-is, so `aapl` missed `AAPL`.
 */
const WHITESPACE_RE = /\s+/g;

export function normalizeStockSymbol(raw: string): string {
  return raw.trim().replace(WHITESPACE_RE, '').slice(0, 32).toUpperCase();
}
