// Commodity variant - commodity.worldmonitor.app -- Focused on mining, metals, energy commodities, and critical minerals
import type { PanelConfig, MapLayers } from '@/types';
import type { VariantConfig } from './base';

// Re-export base config
export * from './base';

// Commodity-specific data exports (explicit named re-exports avoid VS Code language-server path issues)
export { COMMODITY_SECTORS, COMMODITY_PRICES, COMMODITY_MARKET_SYMBOLS } from '@/config/commodity-markets';
export type { MineralType, MineSiteStatus, MineSite, ProcessingPlant, CommodityPort } from '@/config/commodity-geo';
export { MINING_SITES, PROCESSING_PLANTS, COMMODITY_PORTS } from '@/config/commodity-geo';

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
  // Regional / macro
  'gulf-economies': { name: 'Gulf & OPEC Economies', enabled: true, priority: 1 },
  'gcc-investments': { name: 'GCC Resource Investments', enabled: true, priority: 2 },
  // Environmental & operational risk
  climate: { name: 'Climate & Weather Impact', enabled: true, priority: 2 },
  'satellite-fires': { name: 'Fires & Operational Risk', enabled: true, priority: 2 },
  'airline-intel': { name: 'Airline Intelligence', enabled: true, priority: 2 },
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
  satellites: false,
  satelliteImagery: false,
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
  ais: true,              // Commodity shipping, tanker routes, bulk carriers
  flights: false,
  notamOverlay: false,
  // Infrastructure
  cables: true,           // Undersea cables (trade comms)
  outages: true,          // Power outages affect operations
  datacenters: false,
  // Sanctions / financial context
  sanctions: true,        // Sanctions directly impact commodity trade
  economic: true,         // Economic centers = commodity demand signals
  // Environmental / operational risk
  fires: true,            // Fires near mining/forestry operations
  climate: true,          // Climate events disrupt supply chains
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
  satellites: false,
  satelliteImagery: false,
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
  notamOverlay: false,
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

  ciiChoropleth: false,
};

export const VARIANT_CONFIG: VariantConfig = {
  name: 'commodity',
  description: 'Commodity, mining & critical minerals intelligence dashboard',
  panels: DEFAULT_PANELS,
  mapLayers: DEFAULT_MAP_LAYERS,
  mobileMapLayers: MOBILE_DEFAULT_MAP_LAYERS,
};
