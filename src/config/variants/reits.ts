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
  // US REIT news
  'reit-us': [
    { name: 'REIT.com', url: rss('https://news.google.com/rss/search?q=site:reit.com+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Nareit', url: rss('https://news.google.com/rss/search?q=site:nareit.com+REIT+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'REIT News', url: rss('https://news.google.com/rss/search?q=REIT+"real+estate+investment+trust"+when:1d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'GlobeSt', url: rss('https://news.google.com/rss/search?q=site:globest.com+REIT+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Commercial Observer', url: rss('https://news.google.com/rss/search?q=site:commercialobserver.com+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Bisnow', url: rss('https://news.google.com/rss/search?q=site:bisnow.com+REIT+OR+"commercial+real+estate"+when:3d&hl=en-US&gl=US&ceid=US:en') },
  ],
  // China REIT & commercial real estate news
  'reit-china': [
    { name: '赢商网', url: rss('https://news.google.com/rss/search?q=site:winshang.com+when:3d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans') },
    { name: '观点地产', url: rss('https://news.google.com/rss/search?q=site:guandian.cn+REITs+OR+%E5%95%86%E4%B8%9A%E5%9C%B0%E4%BA%A7+when:3d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans') },
    { name: '公募REITs', url: rss('https://news.google.com/rss/search?q=%E5%85%AC%E5%8B%9FREITs+when:3d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans') },
    { name: '商业地产', url: rss('https://news.google.com/rss/search?q=%E5%95%86%E4%B8%9A%E5%9C%B0%E4%BA%A7+OR+%E8%B4%AD%E7%89%A9%E4%B8%AD%E5%BF%83+OR+%E5%86%99%E5%AD%97%E6%A5%BC+when:1d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans') },
    { name: '保障房', url: rss('https://news.google.com/rss/search?q=%E4%BF%9D%E9%9A%9C%E6%80%A7%E7%A7%9F%E8%B5%81%E4%BD%8F%E6%88%BF+OR+%E9%95%BF%E7%A7%9F%E5%85%AC%E5%AF%93+when:3d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans') },
    { name: 'China REITs (EN)', url: rss('https://news.google.com/rss/search?q="China+REIT"+OR+"C-REIT"+when:3d&hl=en-US&gl=US&ceid=US:en') },
  ],
  // Global property markets & macro
  'property-markets': [
    { name: 'Property Markets', url: rss('https://news.google.com/rss/search?q="commercial+real+estate"+OR+"property+market"+when:1d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'CBRE Research', url: rss('https://news.google.com/rss/search?q=site:cbre.com+research+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'JLL', url: rss('https://news.google.com/rss/search?q=site:jll.com+"real+estate"+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Mortgage Rates', url: rss('https://news.google.com/rss/search?q="mortgage+rates"+OR+"interest+rates"+"real+estate"+when:1d&hl=en-US&gl=US&ceid=US:en') },
  ],
};

// ============================================
// PANEL CONFIGURATION — only REIT-relevant panels
// ============================================
export const DEFAULT_PANELS: Record<string, PanelConfig> = {
  map: { name: 'REIT Property Map', enabled: true, priority: 1 },
  reits: { name: 'REIT Monitor', enabled: true, priority: 1 },
  'reit-correlation': { name: 'REIT Macro', enabled: true, priority: 1 },
  'reit-social': { name: 'REIT Social', enabled: true, priority: 1 },
  'reit-detail': { name: 'REIT Detail', enabled: true, priority: 1 },
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
