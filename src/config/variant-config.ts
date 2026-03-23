/**
 * Variant Configuration Utilities
 *
 * Provides access to variant-specific configuration without hardcoding
 * variant checks throughout the codebase.
 */
import { SITE_VARIANT } from './variant';
import type { VariantConfig } from './variants/base';

// Import all variant configs
import { VARIANT_CONFIG as irelandConfig } from './variants/ireland';
import { VARIANT_CONFIG as techConfig } from './variants/tech';
import { VARIANT_CONFIG as fullConfig } from './variants/full';
import { VARIANT_CONFIG as financeConfig } from './variants/finance';
import { VARIANT_CONFIG as happyConfig } from './variants/happy';
import { VARIANT_CONFIG as commodityConfig } from './variants/commodity';

/** Map of variant name to config */
const VARIANT_CONFIGS: Record<string, VariantConfig> = {
  ireland: irelandConfig,
  tech: techConfig,
  full: fullConfig,
  finance: financeConfig,
  happy: happyConfig,
  commodity: commodityConfig,
};

/** Default brand configuration */
const DEFAULT_BRAND = {
  displayName: 'World Monitor',
  logoText: 'MONITOR',
  headerText: 'WORLD MONITOR',
};

/** Default map configuration */
const DEFAULT_MAP = {
  center: { lat: 20, lng: 0 },
  defaultZoom: 2,
  minZoom: 1,
  bounds: undefined,
};

/** Default feature flags */
const DEFAULT_FEATURES = {
  irelandRelevanceFilter: false,
  disableCountryOverlay: false,
  expandedAttribution: false,
};

/**
 * Get the current variant's configuration
 */
export function getVariantConfig(): VariantConfig {
  return VARIANT_CONFIGS[SITE_VARIANT] ?? VARIANT_CONFIGS.full!;
}

/**
 * Get brand configuration for the current variant
 */
export function getBrand() {
  const config = getVariantConfig();
  return config.brand || DEFAULT_BRAND;
}

/**
 * Get map configuration for the current variant
 */
export function getMapConfig() {
  const config = getVariantConfig();
  return {
    ...DEFAULT_MAP,
    ...config.map,
  };
}

/**
 * Get feature flags for the current variant
 */
export function getFeatures() {
  const config = getVariantConfig();
  return {
    ...DEFAULT_FEATURES,
    ...config.features,
  };
}

/**
 * Check if current variant is Ireland
 * @deprecated Use getFeatures() instead for specific feature checks
 */
export function isIrelandVariant(): boolean {
  return SITE_VARIANT === 'ireland';
}

/**
 * Get minimum zoom level for current variant
 */
export function getMinZoom(): number {
  return getMapConfig().minZoom ?? DEFAULT_MAP.minZoom;
}

/**
 * Get map bounds for current variant (if any)
 */
export function getMapBounds() {
  return getMapConfig().bounds;
}
