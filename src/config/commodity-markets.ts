// Commodity variant: Expanded commodity and mining company market symbols
// Replaces the generic COMMODITIES and MARKET_SYMBOLS for the commodity variant

import type { Commodity, MarketSymbol, Sector } from '@/types';

// Commodity-focused sector ETFs
export const COMMODITY_SECTORS: Sector[] = [
  { symbol: 'GDX', name: 'Gold Miners' },
  { symbol: 'GDXJ', name: 'Jr Gold Miners' },
  { symbol: 'XLE', name: 'Energy' },
  { symbol: 'XLB', name: 'Materials' },
  { symbol: 'COPX', name: 'Copper Miners' },
  { symbol: 'LIT', name: 'Lithium & Battery' },
  { symbol: 'REMX', name: 'Rare Earth/Strat' },
  { symbol: 'URA', name: 'Uranium' },
  { symbol: 'SIL', name: 'Silver Miners' },
  { symbol: 'PICK', name: 'Diversified Metals' },
  { symbol: 'PALL', name: 'Palladium' },
  { symbol: 'PPLT', name: 'Platinum' },
];

// Expanded commodity futures and proxies
export const COMMODITY_PRICES: Commodity[] = [
  // Precious Metals
  { symbol: 'GC=F', name: 'Gold', display: 'GOLD' },
  { symbol: 'SI=F', name: 'Silver', display: 'SILVER' },
  { symbol: 'PL=F', name: 'Platinum', display: 'PLAT' },
  { symbol: 'PA=F', name: 'Palladium', display: 'PALL' },
  // Industrial Metals
  { symbol: 'HG=F', name: 'Copper', display: 'COPPER' },
  { symbol: 'ALI=F', name: 'Aluminum', display: 'ALUM' },
  { symbol: 'ZNC=F', name: 'Zinc', display: 'ZINC' },
  { symbol: 'NI=F', name: 'Nickel', display: 'NICKEL' },
  // Energy
  { symbol: 'CL=F', name: 'Crude Oil', display: 'WTI' },
  { symbol: 'BZ=F', name: 'Brent Crude', display: 'BRENT' },
  { symbol: 'NG=F', name: 'Natural Gas', display: 'NATGAS' },
  // Battery / Critical Minerals (ETF proxies)
  { symbol: 'LIT', name: 'Lithium ETF', display: 'LI-ETF' },
  { symbol: 'URA', name: 'Uranium ETF', display: 'URAN' },
  // Volatility reference
  { symbol: '^VIX', name: 'VIX', display: 'VIX' },
];

// Mining companies and commodity ETFs for the markets panel
export const COMMODITY_MARKET_SYMBOLS: MarketSymbol[] = [
  // === Diversified Major Miners ===
  { symbol: 'BHP', name: 'BHP Group', display: 'BHP' },
  { symbol: 'RIO', name: 'Rio Tinto', display: 'RIO' },
  { symbol: 'VALE', name: 'Vale', display: 'VALE' },
  { symbol: 'GLEN.L', name: 'Glencore', display: 'GLEN' },
  { symbol: 'AAL.L', name: 'Anglo American', display: 'AAL' },
  { symbol: 'TECK', name: 'Teck Resources', display: 'TECK' },
  // === Copper Specialists ===
  { symbol: 'FCX', name: 'Freeport-McMoRan', display: 'FCX' },
  { symbol: 'SCCO', name: 'Southern Copper', display: 'SCCO' },
  // === Gold Majors ===
  { symbol: 'NEM', name: 'Newmont', display: 'NEM' },
  { symbol: 'GOLD', name: 'Barrick Gold', display: 'GOLD' },
  { symbol: 'AEM', name: 'Agnico Eagle', display: 'AEM' },
  { symbol: 'KGC', name: 'Kinross Gold', display: 'KGC' },
  { symbol: 'GFI', name: 'Gold Fields', display: 'GFI' },
  { symbol: 'AU', name: 'AngloGold Ashanti', display: 'AU' },
  // === Silver ===
  { symbol: 'PAAS', name: 'Pan American Silver', display: 'PAAS' },
  // === Royalty & Streaming ===
  { symbol: 'RGLD', name: 'Royal Gold', display: 'RGLD' },
  { symbol: 'WPM', name: 'Wheaton Precious Metals', display: 'WPM' },
  { symbol: 'FNV', name: 'Franco-Nevada', display: 'FNV' },
  // === Lithium ===
  { symbol: 'ALB', name: 'Albemarle', display: 'ALB' },
  { symbol: 'SQM', name: 'SQM', display: 'SQM' },
  // === Rare Earths ===
  { symbol: 'MP', name: 'MP Materials', display: 'MP' },
  // === Uranium ===
  { symbol: 'CCJ', name: 'Cameco', display: 'CCJ' },
  { symbol: 'KAP', name: 'Kazatomprom', display: 'KAP' },
  // === Energy Majors (commodity context) ===
  { symbol: 'XOM', name: 'ExxonMobil', display: 'XOM' },
  { symbol: 'CVX', name: 'Chevron', display: 'CVX' },
  { symbol: 'SLB', name: 'SLB (Schlumberger)', display: 'SLB' },
  // === Commodity ETFs ===
  { symbol: 'GLD', name: 'SPDR Gold Shares', display: 'GLD' },
  { symbol: 'SLV', name: 'iShares Silver', display: 'SLV' },
  { symbol: 'GDX', name: 'VanEck Gold Miners ETF', display: 'GDX' },
  { symbol: 'USO', name: 'US Oil ETF', display: 'USO' },
  { symbol: 'DBB', name: 'Invesco Base Metals ETF', display: 'DBB' },
];
