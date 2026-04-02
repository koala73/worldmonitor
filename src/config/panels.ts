import type { PanelConfig, MapLayers, DataSourceId } from '@/types';
import { SITE_VARIANT } from './variant';
// boundary-ignore: isDesktopRuntime is a pure env probe with no service dependencies
import { isDesktopRuntime } from '@/services/runtime';
// boundary-ignore: getSecretState is a pure env/keychain probe with no service dependencies
import { getSecretState } from '@/services/runtime-config';

// ============================================
// REIT VARIANT — the only variant in this build
// ============================================

const REIT_PANELS: Record<string, PanelConfig> = {
  map: { name: 'REIT Property Map', enabled: true, priority: 1 },
  reits: { name: 'REIT Monitor', enabled: true, priority: 1 },
  'reit-correlation': { name: 'REIT Macro', enabled: true, priority: 1 },
  'reit-social': { name: 'REIT Social', enabled: true, priority: 1 },
  'reit-detail': { name: 'REIT Detail', enabled: true, priority: 1 },
  'reit-us': { name: 'REIT Headlines', enabled: true, priority: 1 },
  'reit-china': { name: '中国REITs', enabled: true, priority: 1 },
  'property-markets': { name: 'Property Markets', enabled: true, priority: 2 },
};

const REIT_MAP_LAYERS: MapLayers = {
  gpsJamming: false, satellites: false, conflicts: false, bases: false,
  cables: false, pipelines: false, hotspots: false, ais: false,
  nuclear: false, irradiators: false, sanctions: false,
  weather: true, economic: true, waterways: false, outages: false,
  cyberThreats: false, datacenters: false, protests: false, flights: false,
  military: false, natural: true, spaceports: false, minerals: false,
  fires: true,
  ucdpEvents: false, displacement: false, climate: false,
  startupHubs: false, cloudRegions: false, accelerators: false, techHQs: false, techEvents: false,
  stockExchanges: false, financialCenters: false, centralBanks: false, commodityHubs: false, gulfInvestments: false,
  positiveEvents: false, kindness: false, happiness: false, speciesRecovery: false, renewableInstallations: false,
  tradeRoutes: false, iranAttacks: false, ciiChoropleth: false, dayNight: false,
  miningSites: false, processingPlants: false, commodityPorts: false, webcams: false, weatherRadar: false,
  reitProperties: true,
  diseaseOutbreaks: false,
  radiationWatch: false,
};

const REIT_MOBILE_MAP_LAYERS: MapLayers = {
  ...REIT_MAP_LAYERS,
  weather: false, economic: false, fires: false, natural: false,
  reitProperties: true,
};

// ============================================
// UNIFIED PANEL REGISTRY
// ============================================

/** All panels available in the panel picker — REITs only. */
export const ALL_PANELS: Record<string, PanelConfig> = { ...REIT_PANELS };

/** Per-variant canonical panel order (keys = which panels are enabled by default). */
export const VARIANT_DEFAULTS: Record<string, string[]> = {
  reits: Object.keys(REIT_PANELS),
};

/**
 * Variant-specific label overrides for panels shared across variants.
 * Applied at render time, not just at seed time.
 */
export const VARIANT_PANEL_OVERRIDES: Partial<Record<string, Partial<Record<string, Partial<PanelConfig>>>>> = {
  reits: {
    map:         { name: 'REIT Property Map' },
  },
};

/**
 * Returns the effective panel config for a given key and variant,
 * applying variant-specific display overrides (name, premium, etc.).
 */
export function getEffectivePanelConfig(key: string, variant: string): PanelConfig {
  const base = ALL_PANELS[key];
  if (!base) return { name: key, enabled: false, priority: 2 };
  const override = VARIANT_PANEL_OVERRIDES[variant]?.[key] ?? {};
  return { ...base, ...override };
}

export const FREE_MAX_PANELS = 40;
export const FREE_MAX_SOURCES = 80;

/**
 * Returns true if the current user is entitled to enable/view this panel.
 * Mirrors the entitlement checks in panel-layout.ts (single source of truth).
 */
export function isPanelEntitled(key: string, config: PanelConfig, isPro = false): boolean {
  if (!config.premium) return true;
  const apiKeyPanels = ['stock-analysis', 'stock-backtest', 'daily-market-brief', 'market-implications', 'deduction', 'chat-analyst'];
  if (apiKeyPanels.includes(key)) {
    return getSecretState('WORLDMONITOR_API_KEY').present || isPro;
  }
  if (config.premium === 'locked') {
    return isDesktopRuntime();
  }
  return true;
}

// ============================================
// VARIANT-AWARE EXPORTS
// ============================================
export const DEFAULT_PANELS: Record<string, PanelConfig> = Object.fromEntries(
  (VARIANT_DEFAULTS[SITE_VARIANT] ?? VARIANT_DEFAULTS['reits'] ?? []).map(key =>
    [key, getEffectivePanelConfig(key, SITE_VARIANT)]
  )
);

export const DEFAULT_MAP_LAYERS = REIT_MAP_LAYERS;

export const MOBILE_DEFAULT_MAP_LAYERS = REIT_MOBILE_MAP_LAYERS;

/** Maps map-layer toggle keys to their data-freshness source IDs (single source of truth). */
export const LAYER_TO_SOURCE: Partial<Record<keyof MapLayers, DataSourceId[]>> = {
  military: ['opensky', 'wingbits'],
  ais: ['ais'],
  natural: ['usgs'],
  weather: ['weather'],
  outages: ['outages'],
  cyberThreats: ['cyber_threats'],
  protests: ['acled', 'gdelt_doc'],
  ucdpEvents: ['ucdp_events'],
  displacement: ['unhcr'],
  climate: ['climate'],
  sanctions: ['sanctions_pressure'],
  radiationWatch: ['radiation'],
};

// ============================================
// PANEL CATEGORY MAP — REIT categories only
// ============================================
// Maps category keys to panel keys. Only categories with at least one
// matching panel in the user's active panel settings are shown.
export const PANEL_CATEGORY_MAP: Record<string, { labelKey: string; panelKeys: string[]; variants?: string[] }> = {
  core: {
    labelKey: 'header.panelCatCore',
    panelKeys: ['map', 'reits', 'reit-detail'],
  },
  reitNews: {
    labelKey: 'header.panelCatREITNews',
    panelKeys: ['reit-us', 'reit-china', 'property-markets'],
  },
  reitAnalysis: {
    labelKey: 'header.panelCatREITAnalysis',
    panelKeys: ['reit-correlation', 'reit-social'],
  },
};

// Monitor palette — fixed category colors persisted to localStorage (not theme-dependent)
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
