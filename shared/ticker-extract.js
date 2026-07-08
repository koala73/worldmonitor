/**
 * ticker-extract — structural tickers[] for news stories (#4922 item a).
 *
 * Stamps stock tickers onto stories at ingest from two signals:
 *   1. Cashtags — `$` + 1–5 UPPERCASE letters, word-bounded ($AAPL, $MSFT).
 *      Any well-formed cashtag is accepted, dictionary member or not:
 *      a cashtag is explicit author intent. Lowercase ($aapl) is dropped,
 *      not normalized — mixed case is far more often a typo or price tag.
 *   2. Company names — whole-word, case-insensitive phrase matches of the
 *      shared/stocks.json `name` values ("Apple" → AAPL, "Eli Lilly" → LLY).
 *      Index entries (^-prefixed symbols: ^GSPC, ^DJI, …) are skipped.
 *
 * Bare symbols WITHOUT `$` are deliberately never matched — GM, ALL, IT,
 * V and friends are ordinary English words (false-positive class).
 *
 * Output contract: uppercase, deduped, first-occurrence order, capped at
 * MAX_TICKERS = 8 — the proto NewsItem.tickers field carries a
 * max_items=8 validation, so exceeding the cap is a wire error, not a
 * style choice.
 *
 * The dictionary is PASSED IN (buildTickerDictionary(stocksJson.symbols))
 * rather than JSON-loaded here. This module is reached by both the Vercel
 * esbuild server bundle and plain `node --test`, and the two JSON-import
 * forms are mutually incompatible there (`with { type: 'json' }` breaks
 * the Vercel bundle; a bare JSON import throws
 * ERR_IMPORT_ATTRIBUTE_MISSING under Node 22+); a runtime readFileSync
 * would depend on stocks.json shipping next to the bundled output. The TS
 * consumer (list-feed-digest.ts) bare-imports shared/stocks.json — the
 * pattern it already uses for diplomacy-keywords.json — and hands the
 * symbols in.
 */

/** Proto contract: NewsItem.tickers max_items=8 — never emit more. */
export const MAX_TICKERS = 8;

// Company names that are also ordinary English words / common terms. Bare-name
// matching on these tags unrelated news ("Visa restrictions" → V, "Amazon
// rainforest" → AMZN, "meta-analysis" → META, "learn the alphabet" → GOOGL),
// and the watchlist-alert consumer would fire spurious notifications on them.
// These are excluded from the company-name matcher — a cashtag ($V, $AMZN,
// $META) is required to tag them, which is explicit author intent. Distinctive
// names (Nvidia, Tesla, Netflix, …) and every multi-word name stay matchable.
// Keep lowercased and in sync with shared/stocks.json when names change.
const AMBIGUOUS_NAMES = new Set([
  'apple', 'alphabet', 'amazon', 'meta', 'visa', 'oracle', 'itc',
]);

// `$` not preceded by an alphanumeric or another `$` (rejects US$100),
// then 1–5 uppercase letters not followed by an alphanumeric (rejects
// $AAPLE12 and $ABCDEF entirely rather than truncating them).
const CASHTAG_RE = /(?<![A-Za-z0-9$])\$([A-Z]{1,5})(?![A-Za-z0-9])/g;

/** @param {string} s */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile the company-name matcher from the stocks.json symbol list.
 * Build once at module load in consumers — the alternation regex is the
 * expensive part.
 * @param {ReadonlyArray<{ symbol: string; name: string; display?: string }>} symbols
 * @returns {{ nameRe: RegExp | null; symbolByName: Map<string, string> }}
 */
export function buildTickerDictionary(symbols) {
  const entries = [];
  for (const entry of symbols ?? []) {
    const symbol = entry?.symbol;
    const name = entry?.name;
    if (!symbol || !name || symbol.startsWith('^')) continue; // indices out
    if (AMBIGUOUS_NAMES.has(name.toLowerCase())) continue;    // cashtag-only names
    entries.push({ symbol: symbol.toUpperCase(), name });
  }
  // Longest name first so overlapping alternatives prefer the full phrase.
  entries.sort((a, b) => b.name.length - a.name.length);
  const symbolByName = new Map(entries.map((e) => [e.name.toLowerCase(), e.symbol]));
  // Lookarounds instead of \b: names carry non-word chars (P&G, L&T) where
  // \b misfires. Word-bounded = not glued to an adjacent letter/digit.
  const nameRe = entries.length
    ? new RegExp(
        `(?<![A-Za-z0-9])(${entries.map((e) => escapeRegExp(e.name)).join('|')})(?![A-Za-z0-9])`,
        'gi',
      )
    : null;
  return { nameRe, symbolByName };
}

/**
 * Extract tickers from story text (title + description). Uppercase,
 * deduped, first-occurrence order, ≤ MAX_TICKERS.
 * @param {string | null | undefined} text
 * @param {{ nameRe: RegExp | null; symbolByName: Map<string, string> } | null} [dictionary]
 *   compiled via buildTickerDictionary; omit for cashtag-only extraction.
 * @returns {string[]}
 */
export function extractTickers(text, dictionary) {
  if (!text || typeof text !== 'string') return [];
  /** @type {Array<{ index: number; symbol: string }>} */
  const hits = [];
  for (const m of text.matchAll(CASHTAG_RE)) {
    hits.push({ index: m.index, symbol: m[1] });
  }
  if (dictionary?.nameRe) {
    for (const m of text.matchAll(dictionary.nameRe)) {
      const symbol = dictionary.symbolByName.get(m[1].toLowerCase());
      if (symbol) hits.push({ index: m.index, symbol });
    }
  }
  hits.sort((a, b) => a.index - b.index);
  const out = [];
  const seen = new Set();
  for (const hit of hits) {
    if (seen.has(hit.symbol)) continue;
    seen.add(hit.symbol);
    out.push(hit.symbol);
    if (out.length >= MAX_TICKERS) break;
  }
  return out;
}
