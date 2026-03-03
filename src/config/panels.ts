import type { PanelConfig } from '@/types';

// SalesIntel panels — single product, no variants
export const DEFAULT_PANELS: Record<string, PanelConfig> = {
  dashboard: { name: 'Dashboard', enabled: true, priority: 1 },
  targets: { name: 'My Targets', enabled: true, priority: 1 },
  'signal-alerts': { name: 'Signal Alerts', enabled: true, priority: 1 },
  prospects: { name: 'Prospects', enabled: true, priority: 1 },
  campaigns: { name: 'Campaigns', enabled: true, priority: 2 },
  insights: { name: 'AI Insights', enabled: true, priority: 1 },
  intel: { name: 'Signal Feed', enabled: true, priority: 1 },
  settings: { name: 'Settings', enabled: true, priority: 2 },
};

// SalesIntel has no map layers — company/account views instead
export const DEFAULT_MAP_LAYERS = {} as Record<string, boolean>;
export const MOBILE_DEFAULT_MAP_LAYERS = {} as Record<string, boolean>;

// Source-to-panel mapping for data freshness
export const LAYER_TO_SOURCE: Record<string, string> = {
  rss: 'rss',
  crunchbase: 'crunchbase',
  linkedin: 'linkedin',
  sec_edgar: 'sec_edgar',
  clearbit: 'clearbit',
};
