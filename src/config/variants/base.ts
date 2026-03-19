// Base configuration shared across all variants
import type { PanelConfig, MapLayers } from '@/types';

// Shared exports (re-exported by all variants)
export { SECTORS, COMMODITIES, MARKET_SYMBOLS } from '../markets';
export { UNDERSEA_CABLES } from '../geo';
export { AI_DATA_CENTERS } from '../ai-datacenters';

// Idle pause duration - shared across map and stream panels (5 minutes)
export const IDLE_PAUSE_MS = 5 * 60 * 1000;

// Refresh intervals (ms) - shared across all variants
export const REFRESH_INTERVALS = {
  feeds: 20 * 60 * 1000,
  markets: 12 * 60 * 1000,
  crypto: 12 * 60 * 1000,
  predictions: 15 * 60 * 1000,
  forecasts: 30 * 60 * 1000,
  ais: 15 * 60 * 1000,
  pizzint: 10 * 60 * 1000,
  natural: 60 * 60 * 1000,
  weather: 10 * 60 * 1000,
  fred: 6 * 60 * 60 * 1000,
  oil: 6 * 60 * 60 * 1000,
  spending: 6 * 60 * 60 * 1000,
  bis: 6 * 60 * 60 * 1000,
  firms: 30 * 60 * 1000,
  cables: 30 * 60 * 1000,
  cableHealth: 2 * 60 * 60 * 1000,
  flights: 2 * 60 * 60 * 1000,
  cyberThreats: 10 * 60 * 1000,
  stockAnalysis: 15 * 60 * 1000,
  dailyMarketBrief: 60 * 60 * 1000,
  stockBacktest: 4 * 60 * 60 * 1000,
  serviceStatus: 3 * 60 * 1000,
  stablecoins: 15 * 60 * 1000,
  etfFlows: 15 * 60 * 1000,
  macroSignals: 15 * 60 * 1000,
  strategicPosture: 15 * 60 * 1000,
  strategicRisk: 5 * 60 * 1000,
  temporalBaseline: 10 * 60 * 1000,
  tradePolicy: 60 * 60 * 1000,
  supplyChain: 60 * 60 * 1000,
  telegramIntel: 60 * 1000,
  gulfEconomies: 10 * 60 * 1000,
  intelligence: 15 * 60 * 1000,
  correlationEngine: 5 * 60 * 1000,
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
}
