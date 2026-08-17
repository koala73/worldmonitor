/** URL contract for the stock research overlay. DOM-free for node tests. */

const STOCK_SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,14}$/;

export function normalizeStockResearchSymbol(raw: string | null | undefined): string | null {
  const symbol = String(raw ?? '').trim().toUpperCase();
  return STOCK_SYMBOL_PATTERN.test(symbol) ? symbol : null;
}

export function isStockResearchPath(pathname: string): boolean {
  return /^\/stocks(?:\/[A-Za-z0-9.-]+)?\/?$/.test(pathname);
}

export function stockResearchSymbolFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/stocks(?:\/([^/]+))?\/?$/);
  if (!match) return null;
  return normalizeStockResearchSymbol(match[1] ?? '');
}

export function stockResearchUrl(rawSymbol: string): string {
  const symbol = normalizeStockResearchSymbol(rawSymbol);
  return symbol ? `/stocks/${symbol}` : '/stocks';
}
