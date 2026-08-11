/**
 * URL contract for the native stock workspace.
 *
 * Keep it free of DOM/D3 imports so routing, user-input normalization and deep
 * links can be exercised in node tests as well as the browser shell.
 */

export const DEFAULT_STOCK_WORKSPACE_SYMBOL = 'AAPL';

const STOCK_SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,14}$/;

export function normalizeStockWorkspaceSymbol(raw: string | null | undefined): string | null {
  const symbol = String(raw ?? '').trim().toUpperCase();
  return STOCK_SYMBOL_PATTERN.test(symbol) ? symbol : null;
}

export function isStockWorkspacePath(pathname: string): boolean {
  return /^\/stocks(?:\/[A-Za-z0-9.-]+)?\/?$/.test(pathname);
}

export function stockWorkspaceSymbolFromPath(pathname: string): string {
  const match = pathname.match(/^\/stocks(?:\/([^/]+))?\/?$/);
  return normalizeStockWorkspaceSymbol(match?.[1]) ?? DEFAULT_STOCK_WORKSPACE_SYMBOL;
}

export function stockWorkspaceUrl(rawSymbol: string): string {
  return `/stocks/${normalizeStockWorkspaceSymbol(rawSymbol) ?? DEFAULT_STOCK_WORKSPACE_SYMBOL}`;
}
