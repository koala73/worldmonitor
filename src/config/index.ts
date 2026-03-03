// SalesIntel Configuration Exports
// Single product — no variant system

// Shared base configuration
export {
  REFRESH_INTERVALS,
  MONITOR_COLORS,
  STORAGE_KEYS,
} from './variants/base';

// Feed configuration
export {
  SOURCE_TIERS,
  getSourceTier,
  SOURCE_TYPES,
  getSourceType,
  getSourcePropagandaRisk as getSourceReliabilityRisk,
  ALERT_KEYWORDS,
  ALERT_EXCLUSIONS,
  type SourceRiskProfile,
  type SourceType,
  FEEDS,
  INTEL_SOURCES,
} from './feeds';

// Panel configuration
export {
  DEFAULT_PANELS,
  DEFAULT_MAP_LAYERS,
  MOBILE_DEFAULT_MAP_LAYERS,
  LAYER_TO_SOURCE,
} from './panels';

// Entity recognition
export {
  ENTITY_REGISTRY,
  getEntityById,
  type EntityType,
  type EntityEntry,
} from './entities';

// ML Configuration
export { ML_THRESHOLDS } from './ml-config';

// SalesIntel is always the single variant
export const SITE_VARIANT = 'salesintel' as const;
