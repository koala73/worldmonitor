/**
 * Types for shared/ticker-extract.js — structural tickers[] extraction at
 * news ingest (#4922 item a). See the .js module doc for the matching
 * semantics and why the dictionary is passed in rather than JSON-loaded.
 */

/** Compiled company-name matcher — opaque; produce with
 * buildTickerDictionary(), pass to extractTickers(). */
export interface TickerDictionary {
  nameRe: RegExp | null;
  symbolByName: Map<string, string>;
}

/** Proto contract: NewsItem.tickers max_items=8 — never emit more. */
export const MAX_TICKERS: number;

export function buildTickerDictionary(
  symbols: ReadonlyArray<{ symbol: string; name: string; display?: string }>,
): TickerDictionary;

export function extractTickers(
  text: string | null | undefined,
  dictionary?: TickerDictionary | null,
): string[];
