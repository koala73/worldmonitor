/**
 * User-customizable market watchlist (additive).
 *
 * Stores a list of extra tickers the user wants to track beyond the defaults.
 * Optional friendly label is supported (used as the displayed name).
 */

export interface MarketWatchlistEntry {
  symbol: string;
  /** Friendly label shown in the UI (maps to MarketData.name). */
  name?: string;
  /** Optional short display code (maps to MarketData.display). Defaults to symbol. */
  display?: string;
}

const STORAGE_KEY = 'wm-market-watchlist-v1';
export const MARKET_WATCHLIST_EVENT = 'wm-market-watchlist-changed';

function safeParseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

function normalizeSymbol(raw: string): string {
  // Allow common finnhub/yahoo formats: ^GSPC, BRK-B, GC=F, BTCUSD, etc.
  // Only trim whitespace and remove internal spaces.
  return raw.trim().replace(/\s+/g, '');
}

function normalizeName(raw: string | undefined): string | undefined {
  const v = (raw || '').trim();
  return v ? v : undefined;
}

function coerceEntry(v: unknown): MarketWatchlistEntry | null {
  if (typeof v === 'string') {
    const sym = normalizeSymbol(v);
    if (!sym) return null;
    return { symbol: sym };
  }
  if (v && typeof v === 'object') {
    const obj = v as any;
    const sym = normalizeSymbol(String(obj.symbol || ''));
    if (!sym) return null;
    const name = normalizeName(typeof obj.name === 'string' ? obj.name : undefined);
    const display = normalizeName(typeof obj.display === 'string' ? obj.display : undefined);
    return { symbol: sym, ...(name ? { name } : {}), ...(display ? { display } : {}) };
  }
  return null;
}

export function getMarketWatchlistEntries(): MarketWatchlistEntry[] {
  try {
    const parsed = safeParseJson<unknown>(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(parsed)) {
      const entries: MarketWatchlistEntry[] = [];
      for (const item of parsed) {
        const e = coerceEntry(item);
        if (e) entries.push(e);
      }
      return entries;
    }
  } catch {
    // ignore
  }
  return [];
}

export function setMarketWatchlistEntries(entries: MarketWatchlistEntry[]): void {
  // Clean, de-dupe by symbol but keep order.
  const seen = new Set<string>();
  const out: MarketWatchlistEntry[] = [];

  for (const raw of entries || []) {
    const sym = normalizeSymbol(raw.symbol || '');
    if (!sym || seen.has(sym)) continue;
    seen.add(sym);

    const name = normalizeName(raw.name);
    const display = normalizeName(raw.display);

    out.push({ symbol: sym, ...(name ? { name } : {}), ...(display ? { display } : {}) });
    if (out.length >= 50) break;
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
  } catch {
    // ignore
  }

  window.dispatchEvent(new CustomEvent(MARKET_WATCHLIST_EVENT, { detail: { entries: out } }));
}

export function resetMarketWatchlist(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(MARKET_WATCHLIST_EVENT, { detail: { entries: [] } }));
}

export function subscribeMarketWatchlistChange(cb: (entries: MarketWatchlistEntry[]) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail as { entries?: unknown } | undefined;
    if (Array.isArray(detail?.entries)) {
      const coerced: MarketWatchlistEntry[] = [];
      for (const it of detail!.entries!) {
        const ce = coerceEntry(it);
        if (ce) coerced.push(ce);
      }
      cb(coerced);
      return;
    }
    cb(getMarketWatchlistEntries());
  };
  window.addEventListener(MARKET_WATCHLIST_EVENT, handler);
  return () => window.removeEventListener(MARKET_WATCHLIST_EVENT, handler);
}

export function parseMarketWatchlistInput(text: string): MarketWatchlistEntry[] {
  // Accept comma or newline-separated entries.
  // Friendly label format: SYMBOL|Label (ex: TSLA|Tesla)
  const rawItems = text
    .split(/[\n,]+/g)
    .map((s) => s.trim())
    .filter(Boolean);

  const entries: MarketWatchlistEntry[] = [];

  for (const item of rawItems) {
    const [left, ...rest] = item.split('|');
    const symbol = normalizeSymbol(left || '');
    if (!symbol) continue;
    const name = normalizeName(rest.join('|'));
    entries.push({ symbol, ...(name ? { name } : {}) });
  }

  return entries;
}
