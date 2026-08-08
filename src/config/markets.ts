import type { Sector, Commodity, MarketSymbol } from '@/types';
import cryptoConfig from '../../shared/crypto.json';
import sectorConfig from '../../shared/sectors.json';
import commodityConfig from '../../shared/commodities.json';
import stocksConfig from '../../shared/stocks.json';

export const SECTORS: Sector[] = sectorConfig.sectors as Sector[];

export const COMMODITIES: Commodity[] = commodityConfig.commodities as Commodity[];

export interface CatalogSymbol extends MarketSymbol {
  region: string;
}

export const STOCK_CATALOG: CatalogSymbol[] = stocksConfig.symbols as CatalogSymbol[];

export const REGION_LABELS: Record<string, string> = stocksConfig.regions;

const CATALOG_BY_SYMBOL = new Map(STOCK_CATALOG.map((symbol) => [symbol.symbol, symbol]));

// Preserve the canonical current-main default order independently of catalog
// grouping/order. A missing default is a configuration error, not a silent drop.
export const MARKET_SYMBOLS: MarketSymbol[] = stocksConfig.defaultSymbols.map((symbol) => {
  const entry = CATALOG_BY_SYMBOL.get(symbol);
  if (!entry) throw new Error(`Default market symbol is missing from catalog: ${symbol}`);
  return entry;
});

export const CRYPTO_IDS = cryptoConfig.ids as readonly string[];
export const CRYPTO_MAP: Record<string, { name: string; symbol: string }> = cryptoConfig.meta;
