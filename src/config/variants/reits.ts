// REIT Monitor variant - reits.worldmonitor.app
// Focused dashboard for Real Estate Investment Trust monitoring.
// Only includes REIT-specific panels, macro correlation, social sentiment,
// and property map layer. Strips all non-REIT content.

import type { PanelConfig, MapLayers } from '@/types';
import type { VariantConfig } from './base';

// Re-export base config (shared constants, refresh intervals, colors)
export * from './base';

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

// REIT-specific FEEDS configuration
import type { Feed } from '@/types';
import { rssProxyUrl } from '@/utils';

const rss = rssProxyUrl;

export const FEEDS: Record<string, Feed[]> = {
  'reit-news': [
    { name: 'REIT.com', url: rss('https://news.google.com/rss/search?q=site:reit.com+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Nareit', url: rss('https://news.google.com/rss/search?q=site:nareit.com+REIT+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'REIT News', url: rss('https://news.google.com/rss/search?q=REIT+"real+estate+investment+trust"+when:1d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Property Markets', url: rss('https://news.google.com/rss/search?q="commercial+real+estate"+OR+"property+market"+when:1d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Real Estate Finance', url: rss('https://news.google.com/rss/search?q="real+estate+finance"+OR+"mortgage+rates"+when:1d&hl=en-US&gl=US&ceid=US:en') },
  ],
  'china-reits': [
    { name: '公募REITs新闻', url: rss('https://news.google.com/rss/search?q=%E5%85%AC%E5%8B%9FREITs+when:3d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans') },
    { name: 'China REITs', url: rss('https://news.google.com/rss/search?q="China+REIT"+OR+"C-REIT"+when:3d&hl=en-US&gl=US&ceid=US:en') },
  ],
};

// ============================================
// PANEL CONFIGURATION — only REIT-relevant panels
// ============================================
export const DEFAULT_PANELS: Record<string, PanelConfig> = {
  map: { name: 'REIT Property Map', enabled: true, priority: 1 },
  'live-news': { name: 'REIT Headlines', enabled: true, priority: 1 },
  insights: { name: 'AI REIT Insights', enabled: true, priority: 1 },
  reits: { name: 'REIT Monitor', enabled: true, priority: 1 },
  'reit-correlation': { name: 'REIT Macro', enabled: true, priority: 1 },
  'reit-social': { name: 'REIT Social', enabled: true, priority: 1 },
  markets: { name: 'REIT Markets', enabled: true, priority: 1 },
  economic: { name: 'Macro Indicators', enabled: true, priority: 2 },
  'macro-signals': { name: 'Market Regime', enabled: true, priority: 2 },
  'world-clock': { name: 'World Clock', enabled: true, priority: 2 },
  monitors: { name: 'My Monitors', enabled: true, priority: 2 },
};

// ============================================
// MAP LAYERS — REIT-focused, natural disaster overlays
// ============================================
export const DEFAULT_MAP_LAYERS: MapLayers = {
  gpsJamming: false,
  satellites: false,
  conflicts: false,
  bases: false,
  cables: false,
  pipelines: false,
  hotspots: false,
  ais: false,
  nuclear: false,
  irradiators: false,
  radiationWatch: false,
  sanctions: false,
  weather: true,
  economic: true,
  waterways: false,
  outages: false,
  cyberThreats: false,
  datacenters: false,
  protests: false,
  flights: false,
  military: false,
  natural: true,
  spaceports: false,
  minerals: false,
  fires: true,
  // Data source layers
  ucdpEvents: false,
  displacement: false,
  climate: false,
  // Tech variant layers (disabled)
  startupHubs: false,
  cloudRegions: false,
  accelerators: false,
  techHQs: false,
  techEvents: false,
  // Finance variant layers (selective)
  stockExchanges: false,
  financialCenters: false,
  centralBanks: false,
  commodityHubs: false,
  gulfInvestments: false,
  // Happy variant layers (disabled)
  positiveEvents: false,
  kindness: false,
  happiness: false,
  speciesRecovery: false,
  renewableInstallations: false,
  tradeRoutes: false,
  iranAttacks: false,
  ciiChoropleth: false,
  dayNight: false,
  // Commodity variant layers (disabled)
  miningSites: false,
  processingPlants: false,
  commodityPorts: false,
  webcams: false,
  weatherRadar: false,
  // REIT Properties — the primary layer for this variant
  reitProperties: true,
};

// Mobile: fewer layers to save battery and reduce clutter
export const MOBILE_DEFAULT_MAP_LAYERS: MapLayers = {
  ...DEFAULT_MAP_LAYERS,
  weather: false,
  economic: false,
  fires: false,
  natural: false,
  // Keep only the essential REIT layer on mobile
  reitProperties: true,
};

// ============================================
// VARIANT CONFIG EXPORT
// ============================================
export const VARIANT_CONFIG: VariantConfig = {
  name: 'reits',
  description: 'Real Estate Investment Trust monitoring dashboard',
  panels: DEFAULT_PANELS,
  mapLayers: DEFAULT_MAP_LAYERS,
  mobileMapLayers: MOBILE_DEFAULT_MAP_LAYERS,
};
