/** URL contract for the stock research overlay. DOM-free for node tests. */

const IS_STOCK_RESEARCH_PATH_RE = /^\/stocks(?:\/[A-Za-z0-9.-]+)?\/?$/;
const STOCK_RESEARCH_SYMBOL_FROM_PATH_RE = /^\/stocks(?:\/([^/]+))?\/?$/;

const STOCK_SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,14}$/;

export function normalizeStockResearchSymbol(raw: string | null | undefined): string | null {
  const symbol = String(raw ?? '').trim().toUpperCase();
  return STOCK_SYMBOL_PATTERN.test(symbol) ? symbol : null;
}

export function isStockResearchPath(pathname: string): boolean {
  return IS_STOCK_RESEARCH_PATH_RE.test(pathname);
}

export function stockResearchSymbolFromPath(pathname: string): string | null {
  const match = pathname.match(STOCK_RESEARCH_SYMBOL_FROM_PATH_RE);
  if (!match) return null;
  return normalizeStockResearchSymbol(match[1] ?? '');
}

export function stockResearchUrl(rawSymbol: string): string {
  const symbol = normalizeStockResearchSymbol(rawSymbol);
  return symbol ? `/stocks/${symbol}` : '/stocks';
}
