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

const DEFAULT_SYMBOL_SET = new Set(stocksConfig.defaultSymbols);

export const MARKET_SYMBOLS: MarketSymbol[] = STOCK_CATALOG.filter(
  (s) => DEFAULT_SYMBOL_SET.has(s.symbol),
);

export const CRYPTO_IDS = cryptoConfig.ids as readonly string[];
export const CRYPTO_MAP: Record<string, { name: string; symbol: string }> = cryptoConfig.meta;
