// Configuration exports
// For variant-specific builds, set VITE_VARIANT environment variable
// VITE_VARIANT=tech → tech.worldmonitor.app (tech-focused)
// VITE_VARIANT=full → worldmonitor.app (geopolitical)
// VITE_VARIANT=finance → finance.worldmonitor.app (markets/trading)

export { SITE_VARIANT } from './variant';

// Shared base configuration (always included)
export {
  IDLE_PAUSE_MS,
  REFRESH_INTERVALS,
  MONITOR_COLORS,
  STORAGE_KEYS,
  DEFAULT_MAP_MODE,
  type MapModePreference,
} from './variants/base';

// Market data (shared)
export { SECTORS, COMMODITIES, MARKET_SYMBOLS, CRYPTO_MAP } from './markets';

// Geo data (shared base). UNDERSEA_CABLES + MAP_URLS moved to the lazy geo-map
// chunk (#4404) — import them directly from '@/config/geo-map', not via this barrel.

// AI Datacenters: NOT re-exported on the eager @/config barrel — the ~86KB table
// is dragged onto the critical path via this re-export. Consumers (map/globe/
// search) import directly from '@/config/ai-datacenters'; related-assets lazy-
// loads it. (#4404)

// Feeds configuration (shared functions, variant-specific data)
export {
  SOURCE_TIERS,
  getSourceTier,
  SOURCE_TYPES,
  getSourceType,
  getSourcePropagandaRisk,
  ALERT_KEYWORDS,
  ALERT_EXCLUSIONS,
  type SourceRiskProfile,
  type SourceType,
} from './feeds';

// Panel configuration - imported from panels.ts
export {
  DEFAULT_PANELS,
  DEFAULT_MAP_LAYERS,
  MOBILE_DEFAULT_MAP_LAYERS,
  LAYER_TO_SOURCE,
  ALL_PANELS,
  VARIANT_DEFAULTS,
  VARIANT_PANEL_OVERRIDES,
  getEffectivePanelConfig,
  isPanelInVariantDefaults,
  isPanelEntitled,
  enforceFreePanelLimit,
  countFreePanelCapUsage,
  isFreePanelCapCounted,
  restoreFreeMapPanelAccess,
  FREE_MAX_PANELS,
  FREE_MAX_SOURCES,
} from './panels';

// ============================================
// VARIANT-SPECIFIC EXPORTS
// Only import what's needed for each variant
// ============================================

// Full variant (geopolitical) - only included in full builds
// These are large data files that should be tree-shaken in tech builds
export {
  FEEDS,
  INTEL_SOURCES,
} from './feeds';

// CANONICAL_FEEDS is the union of every variant's feed map — by design it
// references all *_FEEDS consts, so unlike FEEDS it is NOT tree-shaken per
// variant (~10KB gz). Required so a panel customized in from another variant
// can resolve its feeds. See src/config/feed-resolution.ts.
export { CANONICAL_FEEDS } from './feeds';

// MILITARY_BASES moved to the lazy military-bases chunk (#4478) — import it
// directly from '@/config/military-bases', not via this barrel, so the ~48KB
// bases-expanded table stays off the eager boot graph.
export {
  INTEL_HOTSPOTS,
  CONFLICT_ZONES,
  STRATEGIC_WATERWAYS,
} from './geo';

export { APT_GROUPS } from './apt-groups';
export { GAMMA_IRRADIATORS } from './irradiators';
export { PIPELINES, PIPELINE_COLORS } from './pipelines';
export { PORTS } from './ports';
// MONITORED_AIRPORTS/FAA_AIRPORTS are NOT re-exported on the eager @/config
// barrel — that pulls the airports table onto the critical path. The only
// consumer (AviationCommandBar, lazy) imports directly from '@/config/airports'. (#4404)
export {
  ENTITY_REGISTRY,
  getEntityById,
  type EntityType,
  type EntityEntry,
} from './entities';

// Tech variant - these are included in tech builds
export { TECH_COMPANIES } from './tech-companies';
export { AI_RESEARCH_LABS } from './ai-research-labs';
export { STARTUP_ECOSYSTEMS } from './startup-ecosystems';
export {
  AI_REGULATIONS,
  REGULATORY_ACTIONS,
  COUNTRY_REGULATION_PROFILES,
  getUpcomingDeadlines,
  getRecentActions,
} from './ai-regulations';
// Value re-exports of the tech-geo tables are intentionally NOT on the eager
// @/config barrel — they pull the ~62KB tech-geo chunk onto the dashboard
// critical path. Every consumer (search/map/globe/tech-hub services) imports
// directly from '@/config/tech-geo'. Type re-exports are erased, no edge. (#4404)
export {
  type StartupHub,
  type Accelerator,
  type TechHQ,
  type CloudRegion,
} from './tech-geo';

// Finance variant - these are included in finance builds
export {
  STOCK_EXCHANGES,
  FINANCIAL_CENTERS,
  CENTRAL_BANKS,
  COMMODITY_HUBS,
  type StockExchange,
  type FinancialCenter,
  type CentralBank,
  type CommodityHub,
} from './finance-geo';

// Gulf FDI investment database
export { GULF_INVESTMENTS } from './gulf-fdi';

// Commodity variant - these are included in commodity builds
export {
  COMMODITY_PRICES,
  COMMODITY_MARKET_SYMBOLS,
} from './commodity-markets';

export {
  MINING_SITES,
  PROCESSING_PLANTS,
  COMMODITY_PORTS,
} from './commodity-geo';

// COMMODITY_MINERS: 30+ mining company HQs — not yet rendered on map.
// Uncomment when a miners layer is added to DeckGLMap.ts.
// export { COMMODITY_MINERS, type CommodityMiner } from './commodity-miners';
