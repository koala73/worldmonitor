import type { PanelConfig, MapLayers } from '@/types';

const SITE_VARIANT = import.meta.env.VITE_VARIANT || 'full';

// ============================================
// FULL VARIANT (Geopolitical)
// ============================================
// Panel order matters! First panels appear at top of grid.
// Desired order: live-news, AI Insights, AI Strategic Posture, cii, strategic-risk, then rest
const FULL_PANELS: Record<string, PanelConfig> = {
  map: { name: 'Global Map', enabled: true, priority: 1 },
  'live-news': { name: 'Live News', enabled: true, priority: 1 },
  insights: { name: 'AI Insights', enabled: true, priority: 1 },
  'strategic-posture': { name: 'AI Strategic Posture', enabled: true, priority: 1 },
  cii: { name: 'Country Instability', enabled: true, priority: 1 },
  'strategic-risk': { name: 'Strategic Risk Overview', enabled: true, priority: 1 },
  intel: { name: 'Intel Feed', enabled: true, priority: 1 },
  'gdelt-intel': { name: 'Live Intelligence', enabled: true, priority: 1 },
  cascade: { name: 'Infrastructure Cascade', enabled: true, priority: 1 },
  politics: { name: 'World News', enabled: true, priority: 1 },
  middleeast: { name: 'Middle East', enabled: true, priority: 1 },
  africa: { name: 'Africa', enabled: true, priority: 1 },
  latam: { name: 'Latin America', enabled: true, priority: 1 },
  asia: { name: 'Asia-Pacific', enabled: true, priority: 1 },
  energy: { name: 'Energy & Resources', enabled: true, priority: 1 },
  gov: { name: 'Government', enabled: true, priority: 1 },
  thinktanks: { name: 'Think Tanks', enabled: true, priority: 1 },
  polymarket: { name: 'Predictions', enabled: true, priority: 1 },
  commodities: { name: 'Commodities', enabled: true, priority: 1 },
  markets: { name: 'Markets', enabled: true, priority: 1 },
  economic: { name: 'Economic Indicators', enabled: true, priority: 1 },
  finance: { name: 'Financial', enabled: true, priority: 1 },
  tech: { name: 'Technology', enabled: true, priority: 2 },
  crypto: { name: 'Crypto', enabled: true, priority: 2 },
  heatmap: { name: 'Sector Heatmap', enabled: true, priority: 2 },
  ai: { name: 'AI/ML', enabled: true, priority: 2 },
  layoffs: { name: 'Layoffs Tracker', enabled: true, priority: 2 },
  monitors: { name: 'My Monitors', enabled: true, priority: 2 },
  'satellite-fires': { name: 'Fires', enabled: true, priority: 2 },
  'macro-signals': { name: 'Market Radar', enabled: true, priority: 2 },
  'etf-flows': { name: 'BTC ETF Tracker', enabled: true, priority: 2 },
  stablecoins: { name: 'Stablecoins', enabled: true, priority: 2 },
};

const FULL_MAP_LAYERS: MapLayers = {
  conflicts: true,
  bases: true,
  cables: false,
  pipelines: false,
  hotspots: true,
  ais: false,
  nuclear: true,
  irradiators: false,
  sanctions: true,
  weather: true,
  economic: true,
  waterways: true,
  outages: true,
  datacenters: false,
  protests: false,
  flights: false,
  military: true,
  natural: true,
  spaceports: false,
  minerals: false,
  fires: false,
  // Tech layers (disabled in full variant)
  startupHubs: false,
  cloudRegions: false,
  accelerators: false,
  techHQs: false,
  techEvents: false,
  // Infra layer (disabled in full variant)
  gulfInvestments: false,
};

const FULL_MOBILE_MAP_LAYERS: MapLayers = {
  conflicts: true,
  bases: false,
  cables: false,
  pipelines: false,
  hotspots: true,
  ais: false,
  nuclear: false,
  irradiators: false,
  sanctions: true,
  weather: true,
  economic: false,
  waterways: false,
  outages: true,
  datacenters: false,
  protests: false,
  flights: false,
  military: false,
  natural: true,
  spaceports: false,
  minerals: false,
  fires: false,
  // Tech layers (disabled in full variant)
  startupHubs: false,
  cloudRegions: false,
  accelerators: false,
  techHQs: false,
  techEvents: false,
  // Infra layer (disabled in full variant)
  gulfInvestments: false,
};

// ============================================
// TECH VARIANT (Tech/AI/Startups)
// ============================================
const TECH_PANELS: Record<string, PanelConfig> = {
  map: { name: 'Global Tech Map', enabled: true, priority: 1 },
  'live-news': { name: 'Tech Headlines', enabled: true, priority: 1 },
  insights: { name: 'AI Insights', enabled: true, priority: 1 },
  ai: { name: 'AI/ML News', enabled: true, priority: 1 },
  tech: { name: 'Technology', enabled: true, priority: 1 },
  startups: { name: 'Startups & VC', enabled: true, priority: 1 },
  vcblogs: { name: 'VC Insights & Essays', enabled: true, priority: 1 },
  regionalStartups: { name: 'Global Startup News', enabled: true, priority: 1 },
  unicorns: { name: 'Unicorn Tracker', enabled: true, priority: 1 },
  accelerators: { name: 'Accelerators & Demo Days', enabled: true, priority: 1 },
  security: { name: 'Cybersecurity', enabled: true, priority: 1 },
  policy: { name: 'AI Policy & Regulation', enabled: true, priority: 1 },
  regulation: { name: 'AI Regulation Dashboard', enabled: true, priority: 1 },
  layoffs: { name: 'Layoffs Tracker', enabled: true, priority: 1 },
  markets: { name: 'Tech Stocks', enabled: true, priority: 2 },
  finance: { name: 'Financial News', enabled: true, priority: 2 },
  crypto: { name: 'Crypto', enabled: true, priority: 2 },
  hardware: { name: 'Semiconductors & Hardware', enabled: true, priority: 2 },
  cloud: { name: 'Cloud & Infrastructure', enabled: true, priority: 2 },
  dev: { name: 'Developer Community', enabled: true, priority: 2 },
  github: { name: 'GitHub Trending', enabled: true, priority: 1 },
  ipo: { name: 'IPO & SPAC', enabled: true, priority: 2 },
  polymarket: { name: 'Tech Predictions', enabled: true, priority: 2 },
  funding: { name: 'Funding & VC', enabled: true, priority: 1 },
  producthunt: { name: 'Product Hunt', enabled: true, priority: 1 },
  events: { name: 'Tech Events', enabled: true, priority: 1 },
  'service-status': { name: 'Service Status', enabled: true, priority: 2 },
  economic: { name: 'Economic Indicators', enabled: true, priority: 2 },
  'tech-readiness': { name: 'Tech Readiness Index', enabled: true, priority: 1 },
  'macro-signals': { name: 'Market Radar', enabled: true, priority: 2 },
  'etf-flows': { name: 'BTC ETF Tracker', enabled: true, priority: 2 },
  stablecoins: { name: 'Stablecoins', enabled: true, priority: 2 },
  monitors: { name: 'My Monitors', enabled: true, priority: 2 },
};

const TECH_MAP_LAYERS: MapLayers = {
  conflicts: false,
  bases: false,
  cables: true,
  pipelines: false,
  hotspots: false,
  ais: false,
  nuclear: false,
  irradiators: false,
  sanctions: false,
  weather: true,
  economic: true,
  waterways: false,
  outages: true,
  datacenters: true,
  protests: false,
  flights: false,
  military: false,
  natural: true,
  spaceports: false,
  minerals: false,
  fires: false,
  // Tech layers (enabled in tech variant)
  startupHubs: true,
  cloudRegions: true,
  accelerators: false,
  techHQs: true,
  techEvents: true,
  // Infra layer (disabled in tech variant)
  gulfInvestments: false,
};

const TECH_MOBILE_MAP_LAYERS: MapLayers = {
  conflicts: false,
  bases: false,
  cables: false,
  pipelines: false,
  hotspots: false,
  ais: false,
  nuclear: false,
  irradiators: false,
  sanctions: false,
  weather: false,
  economic: false,
  waterways: false,
  outages: true,
  datacenters: true,
  protests: false,
  flights: false,
  military: false,
  natural: true,
  spaceports: false,
  minerals: false,
  fires: false,
  // Tech layers (limited on mobile)
  startupHubs: true,
  cloudRegions: false,
  accelerators: false,
  techHQs: false,
  techEvents: true,
  // Infra layer (disabled in tech variant)
  gulfInvestments: false,
};

// ============================================
// INFRA VARIANT (Gulf FDI / Critical Infrastructure)
// ============================================
const INFRA_PANELS: Record<string, PanelConfig> = {
  map:                  { name: 'Gulf FDI World Map',           enabled: true,  priority: 1 },
  'fdi-investments':    { name: 'Investment Database',           enabled: true,  priority: 1 },
  'fdi-announcements':  { name: 'New Announcements',             enabled: true,  priority: 1 },
  'live-news':          { name: 'Live FDI News',                 enabled: true,  priority: 1 },
  fdiNews:              { name: 'Gulf Business News',            enabled: true,  priority: 1 },
  entityNews:           { name: 'Entity News',                   enabled: true,  priority: 1 },
  infraMedia:           { name: 'Infrastructure Media',          enabled: true,  priority: 1 },
  announcements:        { name: 'New Project Announcements',     enabled: true,  priority: 1 },
  regional:             { name: 'Regional Coverage',             enabled: true,  priority: 2 },
  markets:              { name: 'Markets',                       enabled: true,  priority: 2 },
  energy:               { name: 'Energy & Resources',            enabled: true,  priority: 2 },
  insights:             { name: 'AI Insights',                   enabled: true,  priority: 2 },
  monitors:             { name: 'My Monitors',                   enabled: true,  priority: 2 },
};

const INFRA_MAP_LAYERS: MapLayers = {
  conflicts:        false,
  bases:            false,
  cables:           false,
  pipelines:        true,
  hotspots:         false,
  ais:              true,
  nuclear:          false,
  irradiators:      false,
  sanctions:        false,
  weather:          false,
  economic:         true,
  waterways:        true,
  outages:          false,
  datacenters:      false,
  protests:         false,
  flights:          false,
  military:         false,
  natural:          false,
  spaceports:       false,
  minerals:         true,
  fires:            false,
  startupHubs:      false,
  cloudRegions:     false,
  accelerators:     false,
  techHQs:          false,
  techEvents:       false,
  gulfInvestments:  true,
};

const INFRA_MOBILE_MAP_LAYERS: MapLayers = {
  conflicts:        false,
  bases:            false,
  cables:           false,
  pipelines:        false,
  hotspots:         false,
  ais:              false,
  nuclear:          false,
  irradiators:      false,
  sanctions:        false,
  weather:          false,
  economic:         false,
  waterways:        true,
  outages:          false,
  datacenters:      false,
  protests:         false,
  flights:          false,
  military:         false,
  natural:          false,
  spaceports:       false,
  minerals:         false,
  fires:            false,
  startupHubs:      false,
  cloudRegions:     false,
  accelerators:     false,
  techHQs:          false,
  techEvents:       false,
  gulfInvestments:  true,
};

// ============================================
// VARIANT-AWARE EXPORTS
// ============================================
export const DEFAULT_PANELS =
  SITE_VARIANT === 'tech' ? TECH_PANELS :
  SITE_VARIANT === 'infra' ? INFRA_PANELS :
  FULL_PANELS;
export const DEFAULT_MAP_LAYERS =
  SITE_VARIANT === 'tech' ? TECH_MAP_LAYERS :
  SITE_VARIANT === 'infra' ? INFRA_MAP_LAYERS :
  FULL_MAP_LAYERS;
export const MOBILE_DEFAULT_MAP_LAYERS =
  SITE_VARIANT === 'tech' ? TECH_MOBILE_MAP_LAYERS :
  SITE_VARIANT === 'infra' ? INFRA_MOBILE_MAP_LAYERS :
  FULL_MOBILE_MAP_LAYERS;

export const MONITOR_COLORS = [
  '#44ff88',
  '#ff8844',
  '#4488ff',
  '#ff44ff',
  '#ffff44',
  '#ff4444',
  '#44ffff',
  '#88ff44',
  '#ff88ff',
  '#88ffff',
];

export const STORAGE_KEYS = {
  panels: 'worldmonitor-panels',
  monitors: 'worldmonitor-monitors',
  mapLayers: 'worldmonitor-layers',
  disabledFeeds: 'worldmonitor-disabled-feeds',
} as const;
