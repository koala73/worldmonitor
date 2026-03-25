import type { Sector, Commodity, MarketSymbol } from '@/types';
import cryptoConfig from '../../shared/crypto.json';
import sectorConfig from '../../shared/sectors.json';
import commodityConfig from '../../shared/commodities.json';
import stocksConfig from '../../shared/stocks.json';

export const SECTORS: Sector[] = sectorConfig.sectors as Sector[];

export const COMMODITIES: Commodity[] = commodityConfig.commodities as Commodity[];

export const MARKET_SYMBOLS: MarketSymbol[] = stocksConfig.symbols as MarketSymbol[];

export const CRYPTO_IDS = cryptoConfig.ids as readonly string[];
export const CRYPTO_MAP: Record<string, { name: string; symbol: string }> = cryptoConfig.meta;
