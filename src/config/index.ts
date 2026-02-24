// Configuration exports
// For variant-specific builds, set VITE_VARIANT environment variable
// VITE_VARIANT=tech → tech.worldmonitor.app (tech-focused)
// VITE_VARIANT=full → worldmonitor.app (geopolitical)
// VITE_VARIANT=finance → finance.worldmonitor.app (markets/trading)

export { SITE_VARIANT } from './variant';

// Shared base configuration (always included)
export {
  REFRESH_INTERVALS,
  MONITOR_COLORS,
  STORAGE_KEYS,
} from './variants/base';

// Market data (shared)
export { SECTORS, COMMODITIES, MARKET_SYMBOLS, CRYPTO_MAP } from './markets';

// Geo data (shared base)
export { UNDERSEA_CABLES, MAP_URLS } from './geo';

// AI Datacenters (shared)
export { AI_DATA_CENTERS } from './ai-datacenters';

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

export {
  INTEL_HOTSPOTS,
  CONFLICT_ZONES,
  MILITARY_BASES,
  NUCLEAR_FACILITIES,
  APT_GROUPS,
  STRATEGIC_WATERWAYS,
  ECONOMIC_CENTERS,
  SANCTIONED_COUNTRIES,
  SPACEPORTS,
  CRITICAL_MINERALS,
} from './geo';

export { GAMMA_IRRADIATORS } from './irradiators';
export { PIPELINES, PIPELINE_COLORS } from './pipelines';
export { PORTS } from './ports';
export { MONITORED_AIRPORTS, FAA_AIRPORTS } from './airports';
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
export {
  STARTUP_HUBS,
  ACCELERATORS,
  TECH_HQS,
  CLOUD_REGIONS,
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
