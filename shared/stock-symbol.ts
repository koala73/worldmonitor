/**
 * One ticker-normalization rule for stored market snapshots and the clients
 * that look them up. The server used to uppercase on write while freshness
 * helpers compared the watchlist string as-is, so `aapl` missed `AAPL`.
 */
export function normalizeStockSymbol(raw: string): string {
  return raw.trim().replace(/\s+/g, '').slice(0, 32).toUpperCase();
}
