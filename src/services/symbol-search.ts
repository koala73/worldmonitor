/**
 * Client for /api/symbol-search — the watchlist editor's typeahead source.
 *
 * Cancels the in-flight request when a newer query supersedes it, so the
 * dropdown never flashes a stale result set after the user keeps typing.
 */

import type { MarketWatchlistEntry } from '@/services/market-watchlist';

export interface SymbolSearchResult {
  symbol: string;
  name: string;
  display: string;
}

let _inflight: AbortController | null = null;

/**
 * Search stocks by ticker or company name. Returns [] for an empty query, a
 * superseded (aborted) request, or any failure — the caller treats "no
 * results" and "search unavailable" the same way (an empty dropdown).
 */
export async function searchSymbols(query: string): Promise<SymbolSearchResult[]> {
  const q = query.trim();
  if (!q) return [];

  // Supersede any in-flight search — the user has typed more since.
  _inflight?.abort();
  const controller = new AbortController();
  _inflight = controller;

  try {
    const res = await fetch(`/api/symbol-search?q=${encodeURIComponent(q)}`, {
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { results?: SymbolSearchResult[] };
    return Array.isArray(data.results) ? data.results : [];
  } catch (err) {
    // AbortError = superseded by a newer query; everything else = transient
    // failure. Either way the dropdown just shows nothing.
    void err;
    return [];
  } finally {
    if (_inflight === controller) _inflight = null;
  }
}

/** A resolved search result is directly usable as a watchlist entry. */
export function toWatchlistEntry(r: SymbolSearchResult): MarketWatchlistEntry {
  return { symbol: r.symbol, name: r.name, display: r.display };
}
