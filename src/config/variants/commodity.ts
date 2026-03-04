// Commodity variant - commodity.worldmonitor.app -- Focused on mining, metals, energy commodities, and critical minerals
import type { PanelConfig, MapLayers } from '@/types';
import type { VariantConfig } from './base';

// Re-export base config
export * from './base';

// Commodity-specific data exports (explicit named re-exports avoid VS Code language-server path issues)
export type { CommodityMiner } from '@/config/commodity-miners';
export { COMMODITY_MINERS } from '@/config/commodity-miners';
export { COMMODITY_SECTORS, COMMODITY_PRICES, COMMODITY_MARKET_SYMBOLS } from '@/config/commodity-markets';
export type { MineralType, MineSiteStatus, MineSite, ProcessingPlant, CommodityPort } from '@/config/commodity-geo';
export { MINING_SITES, PROCESSING_PLANTS, COMMODITY_PORTS } from '@/config/commodity-geo';

// Re-export feeds infrastructure
export {
  SOURCE_TIERS,
  getSourceTier,
  SOURCE_TYPES,
  getSourceType,
  getSourcePropagandaRisk,
  type SourceRiskProfile,
  type SourceType,
} from '../feeds';

// Commodity-specific FEEDS configuration
import type { Feed } from '@/types';

const rss = (url: string) => `/api/rss-proxy?url=${encodeURIComponent(url)}`;

export const FEEDS: Record<string, Feed[]> = {
  // ── Core Commodity & Mining News ────────────────────────────────────────
  'commodity-news': [
    { name: 'Kitco News', url: rss('https://www.kitco.com/rss/KitcoNews.xml') },
    { name: 'Mining.com', url: rss('https://www.mining.com/feed/') },
    { name: 'Bloomberg Commodities', url: rss('https://news.google.com/rss/search?q=site:bloomberg.com+commodities+OR+metals+OR+mining+when:1d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Reuters Commodities', url: rss('https://news.google.com/rss/search?q=site:reuters.com+commodities+OR+metals+OR+mining+when:1d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'S&P Global Commodity', url: rss('https://news.google.com/rss/search?q=site:spglobal.com+commodities+metals+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Commodity Trade Mantra', url: rss('https://www.commoditytrademantra.com/feed/') },
    { name: 'CNBC Commodities', url: rss('https://news.google.com/rss/search?q=site:cnbc.com+(commodities+OR+metals+OR+gold+OR+copper)+when:1d&hl=en-US&gl=US&ceid=US:en') },
  ],

  // ── Gold & Silver ─────────────────────────────────────────────────────
  'gold-silver': [
    { name: 'Kitco Gold', url: rss('https://www.kitco.com/rss/KitcoGold.xml') },
    { name: 'Gold Price News', url: rss('https://news.google.com/rss/search?q=(gold+price+OR+"gold+market"+OR+bullion+OR+LBMA)+when:1d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Silver Price News', url: rss('https://news.google.com/rss/search?q=(silver+price+OR+"silver+market"+OR+"silver+futures")+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Precious Metals', url: rss('https://news.google.com/rss/search?q=("precious+metals"+OR+platinum+OR+palladium+OR+"gold+ETF"+OR+GLD+OR+SLV)+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'World Gold Council', url: rss('https://news.google.com/rss/search?q="World+Gold+Council"+OR+"central+bank+gold"+OR+"gold+reserves"+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'GoldSeek', url: rss('https://news.goldseek.com/GoldSeek/rss.xml') },
    { name: 'SilverSeek', url: rss('https://news.silverseek.com/SilverSeek/rss.xml') },
  ],

  // ── Energy (Oil, Gas, LNG) ────────────────────────────────────────────
  energy: [
    { name: 'OilPrice.com', url: rss('https://oilprice.com/rss/main') },
    { name: 'Rigzone', url: rss('https://www.rigzone.com/news/rss/rigzone_latest.aspx') },
    { name: 'EIA Reports', url: rss('https://www.eia.gov/rss/press_room.xml') },
    { name: 'OPEC News', url: rss('https://news.google.com/rss/search?q=(OPEC+OR+"oil+price"+OR+"crude+oil"+OR+WTI+OR+Brent+OR+"oil+production")+when:1d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Natural Gas News', url: rss('https://news.google.com/rss/search?q=("natural+gas"+OR+LNG+OR+"gas+price"+OR+"Henry+Hub")+when:1d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Energy Intel', url: rss('https://news.google.com/rss/search?q=(energy+commodities+OR+"energy+market"+OR+"energy+prices")+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Reuters Energy', url: rss('https://news.google.com/rss/search?q=site:reuters.com+(oil+OR+gas+OR+energy)+when:1d&hl=en-US&gl=US&ceid=US:en') },
  ],

  // ── Mining Industry News ──────────────────────────────────────────────
  'mining-news': [
    { name: 'Mining Journal', url: rss('https://www.mining-journal.com/feed/') },
    { name: 'Northern Miner', url: rss('https://www.northernminer.com/feed/') },
    { name: 'Mining Weekly', url: rss('https://www.miningweekly.com/rss/') },
    { name: 'Mining Technology', url: rss('https://www.mining-technology.com/feed/') },
    { name: 'Australian Mining', url: rss('https://www.australianmining.com.au/feed/') },
    { name: 'Mine Web (SNL)', url: rss('https://news.google.com/rss/search?q=("mining+company"+OR+"mine+production"+OR+"mining+operations")+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Resource World', url: rss('https://news.google.com/rss/search?q=("mining+project"+OR+"mineral+exploration"+OR+"mine+development")+when:3d&hl=en-US&gl=US&ceid=US:en') },
  ],

  // ── Critical Minerals & Battery Metals ───────────────────────────────
  'critical-minerals': [
    { name: 'Benchmark Mineral', url: rss('https://news.google.com/rss/search?q=("critical+minerals"+OR+"battery+metals"+OR+lithium+OR+cobalt+OR+"rare+earths")+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Lithium Market', url: rss('https://news.google.com/rss/search?q=(lithium+price+OR+"lithium+market"+OR+"lithium+supply"+OR+spodumene+OR+LCE)+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Cobalt Market', url: rss('https://news.google.com/rss/search?q=(cobalt+price+OR+"cobalt+market"+OR+"DRC+cobalt"+OR+"battery+cobalt")+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Rare Earths News', url: rss('https://news.google.com/rss/search?q=("rare+earth"+OR+"rare+earths"+OR+"REE"+OR+neodymium+OR+praseodymium)+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'EV Battery Supply', url: rss('https://news.google.com/rss/search?q=("EV+battery"+OR+"battery+supply+chain"+OR+"battery+materials")+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'IEA Critical Minerals', url: rss('https://news.google.com/rss/search?q=site:iea.org+(minerals+OR+critical+OR+battery)+when:14d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Uranium Market', url: rss('https://news.google.com/rss/search?q=(uranium+price+OR+"uranium+market"+OR+U3O8+OR+nuclear+fuel)+when:3d&hl=en-US&gl=US&ceid=US:en') },
  ],

  // ── Base Metals (Copper, Aluminum, Zinc, Nickel) ──────────────────────
  'base-metals': [
    { name: 'LME Metals', url: rss('https://news.google.com/rss/search?q=(LME+OR+"London+Metal+Exchange")+copper+OR+aluminum+OR+zinc+OR+nickel+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Copper Market', url: rss('https://news.google.com/rss/search?q=(copper+price+OR+"copper+market"+OR+"copper+supply"+OR+COMEX+copper)+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Nickel News', url: rss('https://news.google.com/rss/search?q=(nickel+price+OR+"nickel+market"+OR+"nickel+supply"+OR+Indonesia+nickel)+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Aluminum & Zinc', url: rss('https://news.google.com/rss/search?q=(aluminum+price+OR+aluminium+OR+zinc+price+OR+"base+metals")+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Iron Ore Market', url: rss('https://news.google.com/rss/search?q=("iron+ore"+price+OR+"iron+ore+market"+OR+"steel+raw+materials")+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Metals Bulletin', url: rss('https://news.google.com/rss/search?q=("metals+market"+OR+"base+metals"+OR+SHFE+OR+"Shanghai+Futures")+when:2d&hl=en-US&gl=US&ceid=US:en') },
  ],

  // ── Major Mining Companies ────────────────────────────────────────────
  'mining-companies': [
    { name: 'BHP News', url: rss('https://news.google.com/rss/search?q=BHP+(mining+OR+production+OR+results+OR+copper+OR+"iron+ore")+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Rio Tinto News', url: rss('https://news.google.com/rss/search?q="Rio+Tinto"+(mining+OR+production+OR+results+OR+Pilbara)+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Glencore & Vale', url: rss('https://news.google.com/rss/search?q=(Glencore+OR+Vale)+(mining+OR+production+OR+cobalt+OR+"iron+ore")+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Gold Majors', url: rss('https://news.google.com/rss/search?q=(Newmont+OR+Barrick+OR+AngloGold+OR+Agnico)+(gold+mine+OR+production+OR+results)+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Freeport & Copper Miners', url: rss('https://news.google.com/rss/search?q=(Freeport+McMoRan+OR+Southern+Copper+OR+Teck+OR+Antofagasta)+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Critical Mineral Companies', url: rss('https://news.google.com/rss/search?q=(Albemarle+OR+SQM+OR+"MP+Materials"+OR+Lynas+OR+Cameco)+when:7d&hl=en-US&gl=US&ceid=US:en') },
  ],

  // ── Supply Chain & Logistics ──────────────────────────────────────────
  'supply-chain': [
    { name: 'Shipping & Freight', url: rss('https://news.google.com/rss/search?q=("bulk+carrier"+OR+"dry+bulk"+OR+"commodity+shipping"+OR+"Port+Hedland"+OR+"Strait+of+Hormuz")+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Trade Routes', url: rss('https://news.google.com/rss/search?q=("trade+route"+OR+"supply+chain"+OR+"commodity+export"+OR+"mineral+export")+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'China Commodity Imports', url: rss('https://news.google.com/rss/search?q=(China+imports+copper+OR+iron+ore+OR+lithium+OR+cobalt+OR+"rare+earth")+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Port & Logistics', url: rss('https://news.google.com/rss/search?q=("iron+ore+port"+OR+"copper+port"+OR+"commodity+port"+OR+"mineral+logistics")+when:7d&hl=en-US&gl=US&ceid=US:en') },
  ],

  // ── Mining Policy, ESG & Regulation ──────────────────────────────────
  'commodity-regulation': [
    { name: 'Mining Regulation', url: rss('https://news.google.com/rss/search?q=("mining+regulation"+OR+"mining+policy"+OR+"mining+permit"+OR+"mining+ban")+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'ESG in Mining', url: rss('https://news.google.com/rss/search?q=("mining+ESG"+OR+"responsible+mining"+OR+"mine+closure"+OR+"tailings")+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Trade & Tariffs', url: rss('https://news.google.com/rss/search?q=("mineral+tariff"+OR+"metals+tariff"+OR+"critical+mineral+policy"+OR+"mining+export+ban")+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Indonesia Nickel Policy', url: rss('https://news.google.com/rss/search?q=(Indonesia+nickel+OR+"nickel+export"+OR+"nickel+ban"+OR+"nickel+processing")+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'China Mineral Policy', url: rss('https://news.google.com/rss/search?q=(China+"rare+earth"+OR+"mineral+export"+OR+"critical+mineral")+policy+OR+restriction+when:7d&hl=en-US&gl=US&ceid=US:en') },
  ],

  // ── Markets (commodity-focused financial news) ────────────────────────
  markets: [
    { name: 'Yahoo Finance Commodities', url: rss('https://finance.yahoo.com/rss/topstories') },
    { name: 'CNBC Markets', url: rss('https://www.cnbc.com/id/100003114/device/rss/rss.html') },
    { name: 'Seeking Alpha Metals', url: rss('https://news.google.com/rss/search?q=site:seekingalpha.com+(gold+OR+silver+OR+copper+OR+mining)+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Commodity Futures', url: rss('https://news.google.com/rss/search?q=(COMEX+OR+NYMEX+OR+"commodity+futures"+OR+CME+commodities)+when:2d&hl=en-US&gl=US&ceid=US:en') },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// PANEL CONFIGURATION — Commodity-only panels
// ─────────────────────────────────────────────────────────────────────────────
export const DEFAULT_PANELS: Record<string, PanelConfig> = {
  // Core
  map: { name: 'Commodity & Mining Map', enabled: true, priority: 1 },
  'live-news': { name: 'Commodity Headlines', enabled: true, priority: 1 },
  // Markets
  markets: { name: 'Mining & Commodity Stocks', enabled: true, priority: 1 },
  commodities: { name: 'Live Commodity Prices', enabled: true, priority: 1 },
  heatmap: { name: 'Sector Heatmap', enabled: true, priority: 1 },
  'macro-signals': { name: 'Market Radar', enabled: true, priority: 1 },
  // Commodity news feeds
  'gold-silver': { name: 'Gold & Silver', enabled: true, priority: 1 },
  energy: { name: 'Energy Markets', enabled: true, priority: 1 },
  'mining-news': { name: 'Mining Industry', enabled: true, priority: 1 },
  'critical-minerals': { name: 'Critical Minerals & Battery Metals', enabled: true, priority: 1 },
  'base-metals': { name: 'Base Metals (Cu, Al, Zn, Ni)', enabled: true, priority: 1 },
  'mining-companies': { name: 'Major Miners', enabled: true, priority: 1 },
  'commodity-news': { name: 'Commodity News', enabled: true, priority: 1 },
  // Operations & supply
  'supply-chain': { name: 'Supply Chain & Shipping', enabled: true, priority: 2 },
  'commodity-regulation': { name: 'Mining Policy & ESG', enabled: true, priority: 2 },
  // Tracking
  monitors: { name: 'My Monitors', enabled: true, priority: 2 },
};

// ─────────────────────────────────────────────────────────────────────────────
// MAP LAYERS — Commodity-focused (mirrors Finance variant pattern)
// Only commodity-relevant layers are enabled; all others are explicitly false.
// ─────────────────────────────────────────────────────────────────────────────
export const DEFAULT_MAP_LAYERS: MapLayers = {
  // ── Core commodity map layers (ENABLED) ───────────────────────────────────
  minerals: true,           // Critical minerals projects (existing layer)
  miningSites: true,        // ~70 major mine sites from commodity-geo.ts
  processingPlants: true,   // Smelters, refineries, separation plants
  commodityPorts: true,     // Mineral export/import ports
  commodityHubs: true,      // Commodity exchanges (LME, CME, SHFE, etc.)
  pipelines: true,          // Oil & gas pipelines (energy commodity context)
  waterways: true,          // Strategic shipping chokepoints
  tradeRoutes: true,        // Commodity trade routes
  natural: true,            // Earthquakes/natural events (affect mine operations)
  weather: true,            // Weather impacting operations

  // ── All non-commodity layers (DISABLED) ───────────────────────────────────
  // Geopolitical / military
  gpsJamming: false,
  iranAttacks: false,
  conflicts: false,
  bases: false,
  hotspots: false,
  nuclear: false,
  irradiators: false,
  military: false,
  spaceports: false,
  ucdpEvents: false,
  displacement: false,
  // Protests / civil unrest
  protests: false,
  // Transport / tracking
  ais: false,
  flights: false,
  // Infrastructure (non-commodity)
  cables: false,
  outages: false,
  datacenters: false,
  // Sanctions / financial context
  sanctions: false,
  economic: false,
  // Environmental
  fires: false,
  climate: false,
  // Tech variant layers
  startupHubs: false,
  cloudRegions: false,
  accelerators: false,
  techHQs: false,
  techEvents: false,
  // Finance variant layers
  stockExchanges: false,
  financialCenters: false,
  centralBanks: false,
  gulfInvestments: false,
  // Happy variant layers
  positiveEvents: false,
  kindness: false,
  happiness: false,
  speciesRecovery: false,
  renewableInstallations: false,
  // Overlay
  dayNight: false,
  cyberThreats: false,
  // Additional required properties
  geopoliticalBoundaries: false,
  ciiChoropleth: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// MOBILE MAP LAYERS — Minimal set for commodity mobile view
// ─────────────────────────────────────────────────────────────────────────────
export const MOBILE_DEFAULT_MAP_LAYERS: MapLayers = {
  // Core commodity layers (limited on mobile for performance)
  minerals: true,
  miningSites: true,
  processingPlants: false,
  commodityPorts: false,
  commodityHubs: true,
  pipelines: false,
  waterways: false,
  tradeRoutes: false,
  natural: true,
  weather: false,

  // All others disabled on mobile
  gpsJamming: false,
  iranAttacks: false,
  conflicts: false,
  bases: false,
  hotspots: false,
  nuclear: false,
  irradiators: false,
  military: false,
  spaceports: false,
  ucdpEvents: false,
  displacement: false,
  protests: false,
  ais: false,
  flights: false,
  cables: false,
  outages: false,
  datacenters: false,
  sanctions: false,
  economic: false,
  fires: false,
  climate: false,
  startupHubs: false,
  cloudRegions: false,
  accelerators: false,
  techHQs: false,
  techEvents: false,
  stockExchanges: false,
  financialCenters: false,
  centralBanks: false,
  gulfInvestments: false,
  positiveEvents: false,
  kindness: false,
  happiness: false,
  speciesRecovery: false,
  renewableInstallations: false,
  dayNight: false,
  cyberThreats: false,
  // Additional required properties
  geopoliticalBoundaries: false,
  ciiChoropleth: false,
};

export const VARIANT_CONFIG: VariantConfig = {
  name: 'commodity',
  description: 'Commodity, mining & critical minerals intelligence dashboard',
  panels: DEFAULT_PANELS,
  mapLayers: DEFAULT_MAP_LAYERS,
  mobileMapLayers: MOBILE_DEFAULT_MAP_LAYERS,
};
