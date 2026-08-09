/**
 * User-customizable market watchlist.
 *
 * Two layers:
 *  1. Catalog selection — user picks symbols from the built-in catalog (full replacement).
 *  2. Custom entries — freeform tickers typed manually (appended on top).
 *
 * When a catalog selection exists the defaults are replaced entirely.
 * Custom entries are always additive on top of whichever base list is active.
 */

export interface MarketWatchlistEntry {
  symbol: string;
  /** Friendly label shown in the UI (maps to MarketData.name). */
  name?: string;
  /** Optional short display code (maps to MarketData.display). Defaults to symbol. */
  display?: string;
}

/** Shape of an entry in the fixed default symbol universe (`shared/stocks.json`). */
export interface MarketSymbolMeta {
  symbol: string;
  name: string;
  display: string;
}

/**
 * Maximum number of CUSTOM tickers the user may track on top of the defaults.
 *
 * Single source of truth for the storage layer, the watchlist editor, and the
 * dashboard merge. #6305: the merge used to bound the default-plus-custom
 * array by this number instead, and since the default universe is already
 * larger than the cap, all but the first custom ticker were silently dropped.
 */
export const MARKET_WATCHLIST_MAX_ENTRIES = 50;

export const MARKET_WATCHLIST_STORAGE_KEY = 'wm-market-watchlist-v1';
export const MARKET_CATALOG_SELECTION_STORAGE_KEY = 'wm-market-catalog-selection-v1';
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

/**
 * Clean, de-dupe by symbol (order preserved) and bound a raw entry list.
 *
 * Shared by the storage setter and the watchlist editor so the cap and the
 * normalization rules cannot drift apart between the two.
 */
export function normalizeWatchlistEntries(
  entries: readonly MarketWatchlistEntry[] | null | undefined,
  max: number = MARKET_WATCHLIST_MAX_ENTRIES,
): MarketWatchlistEntry[] {
  const seen = new Set<string>();
  const out: MarketWatchlistEntry[] = [];

  for (const raw of entries || []) {
    if (out.length >= max) break;
    const symbol = normalizeSymbol(raw?.symbol || '');
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);

    const name = normalizeName(raw.name);
    const display = normalizeName(raw.display);
    out.push({ symbol, ...(name ? { name } : {}), ...(display ? { display } : {}) });
  }

  return out;
}

/**
 * Merge the user's custom tickers onto the fixed default universe.
 *
 * The bound applies to how many custom tickers are appended — never to the
 * merged length, which starts out above the cap (#6305). A custom entry that
 * duplicates a default is already tracked, so it is skipped without spending
 * cap budget.
 */
export function mergeWatchlistSymbols(
  defaults: readonly MarketSymbolMeta[],
  customEntries: readonly MarketWatchlistEntry[],
  maxCustom: number = MARKET_WATCHLIST_MAX_ENTRIES,
): MarketSymbolMeta[] {
  const merged = defaults.slice();
  if (customEntries.length === 0) return merged;

  const seen = new Set(merged.map((s) => s.symbol));
  let added = 0;
  for (const entry of customEntries) {
    if (added >= maxCustom) break;
    const symbol = entry?.symbol;
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    merged.push({ symbol, name: entry.name || symbol, display: entry.display || symbol });
    added += 1;
  }

  return merged;
}

export interface ResolvedMarketWatchlist {
  baseSymbols: MarketSymbolMeta[];
  customEntries: MarketWatchlistEntry[];
  symbols: MarketSymbolMeta[];
  usesCatalogSelection: boolean;
}

/** Resolve the catalog base and additive searchable entries in one pure path. */
export function resolveEffectiveMarketWatchlist(
  catalog: readonly MarketSymbolMeta[],
  defaults: readonly MarketSymbolMeta[],
  catalogSelection: readonly string[] | null | undefined,
  customEntries: readonly MarketWatchlistEntry[] | null | undefined,
  maxCustom: number = MARKET_WATCHLIST_MAX_ENTRIES,
): ResolvedMarketWatchlist {
  const catalogBySymbol = new Map(catalog.map((entry) => [entry.symbol, entry]));
  const selectedBase: MarketSymbolMeta[] = [];
  const seenSelection = new Set<string>();

  for (const raw of catalogSelection ?? []) {
    if (typeof raw !== 'string') continue;
    const symbol = normalizeSymbol(raw);
    if (!symbol || seenSelection.has(symbol)) continue;
    const entry = catalogBySymbol.get(symbol);
    if (!entry) continue;
    seenSelection.add(symbol);
    selectedBase.push(entry);
  }

  const usesCatalogSelection = selectedBase.length > 0;
  const baseSymbols = usesCatalogSelection ? selectedBase : defaults.slice();
  const normalizedCustom = normalizeWatchlistEntries(customEntries, maxCustom);
  return {
    baseSymbols,
    customEntries: normalizedCustom,
    symbols: mergeWatchlistSymbols(baseSymbols, normalizedCustom, maxCustom),
    usesCatalogSelection,
  };
}

export function getMarketWatchlistEntries(): MarketWatchlistEntry[] {
  try {
    const parsed = safeParseJson<unknown>(localStorage.getItem(MARKET_WATCHLIST_STORAGE_KEY));
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
  setMarketWatchlistPreferences({ catalogSelection: getCatalogSelection(), entries });
}

export function resetMarketWatchlist(): void {
  setMarketWatchlistPreferences({ catalogSelection: getCatalogSelection(), entries: [] });
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

// ---- Catalog selection (visual picker) ----

export function getCatalogSelection(): string[] | null {
  try {
    const parsed = safeParseJson<unknown>(localStorage.getItem(MARKET_CATALOG_SELECTION_STORAGE_KEY));
    if (!Array.isArray(parsed)) return null;
    const symbols: string[] = [];
    const seen = new Set<string>();
    for (const raw of parsed) {
      if (typeof raw !== 'string') continue;
      const symbol = normalizeSymbol(raw);
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      symbols.push(symbol);
    }
    return symbols.length > 0 ? symbols : null;
  } catch {
    return null;
  }
}

export interface MarketWatchlistPreferences {
  catalogSelection: readonly string[] | null;
  entries: readonly MarketWatchlistEntry[];
}

/** Persist both preference layers coherently and emit exactly one change event. */
export function setMarketWatchlistPreferences(preferences: MarketWatchlistPreferences): void {
  const entries = normalizeWatchlistEntries(preferences.entries);
  const catalogSelection = Array.from(new Set(
    (preferences.catalogSelection ?? [])
      .filter((symbol): symbol is string => typeof symbol === 'string')
      .map(normalizeSymbol)
      .filter(Boolean),
  ));

  try {
    if (entries.length > 0) localStorage.setItem(MARKET_WATCHLIST_STORAGE_KEY, JSON.stringify(entries));
    else localStorage.removeItem(MARKET_WATCHLIST_STORAGE_KEY);

    if (catalogSelection.length > 0) {
      localStorage.setItem(MARKET_CATALOG_SELECTION_STORAGE_KEY, JSON.stringify(catalogSelection));
    } else {
      localStorage.removeItem(MARKET_CATALOG_SELECTION_STORAGE_KEY);
    }
  } catch {
    // Keep the in-memory event contract when storage is unavailable.
  }

  window.dispatchEvent(new CustomEvent(MARKET_WATCHLIST_EVENT, {
    detail: {
      entries,
      catalogSelection: catalogSelection.length > 0 ? catalogSelection : null,
    },
  }));
}

/** Clear both stored layers atomically; consumers observe one coherent reset. */
export function resetMarketWatchlistPreferences(): void {
  setMarketWatchlistPreferences({ catalogSelection: null, entries: [] });
}
