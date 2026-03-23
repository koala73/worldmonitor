// Base configuration shared across all variants
import type { PanelConfig, MapLayers } from '@/types';

// Shared exports (re-exported by all variants)
export { SECTORS, COMMODITIES, MARKET_SYMBOLS } from '../markets';
export { UNDERSEA_CABLES } from '../geo';
export { AI_DATA_CENTERS } from '../ai-datacenters';

// Idle pause duration - shared across map and stream panels (5 minutes)
export const IDLE_PAUSE_MS = 5 * 60 * 1000;

// Refresh intervals - shared across all variants
export const REFRESH_INTERVALS = {
  feeds: 20 * 60 * 1000,
  markets: 12 * 60 * 1000,
  crypto: 12 * 60 * 1000,
  predictions: 15 * 60 * 1000,
  forecasts: 30 * 60 * 1000,
  ais: 15 * 60 * 1000,
};

// Monitor colors - shared
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

// Storage keys - shared
export const STORAGE_KEYS = {
  panels: 'worldmonitor-panels',
  monitors: 'worldmonitor-monitors',
  mapLayers: 'worldmonitor-layers',
  disabledFeeds: 'worldmonitor-disabled-feeds',
  liveChannels: 'worldmonitor-live-channels',
  mapMode: 'worldmonitor-map-mode',          // 'flat' | 'globe'
  activeChannel: 'worldmonitor-active-channel',
  webcamPrefs: 'worldmonitor-webcam-prefs',
} as const;

// Type definitions for variant configs
export interface VariantConfig {
  name: string;
  description: string;
  panels: Record<string, PanelConfig>;
  mapLayers: MapLayers;
  mobileMapLayers: MapLayers;

  // Brand configuration (optional - defaults to World Monitor)
  brand?: {
    /** Display name (e.g. "IrishTech Daily") */
    displayName: string;
    /** Logo text (e.g. "IRISHTECH") */
    logoText: string;
    /** Header text (e.g. "IRISHTECH DAILY") */
    headerText: string;
  };

  // Map configuration (optional - defaults to global view)
  map?: {
    /** Map center coordinates */
    center?: { lat: number; lng: number };
    /** Default zoom level */
    defaultZoom?: number;
    /** Minimum zoom level */
    minZoom?: number;
    /** Map bounds (SW/NE corners) */
    bounds?: {
      sw: { lng: number; lat: number };
      ne: { lng: number; lat: number };
    };
  };

  // Feature flags (optional)
  features?: {
    /** Use Ireland-specific relevance filter for data */
    irelandRelevanceFilter?: boolean;
    /** Disable country overlay on map */
    disableCountryOverlay?: boolean;
    /** Use expanded attribution text */
    expandedAttribution?: boolean;
  };
}
