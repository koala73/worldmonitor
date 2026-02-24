import { isFeatureAvailable, type RuntimeFeatureId } from './runtime-config';

export type LocalityClass = 'fully-local' | 'api-key' | 'cloud-fallback';

export interface DesktopParityFeature {
  id: string;
  panel: string;
  serviceFiles: string[];
  apiRoutes: string[];
  apiHandlers: string[];
  locality: LocalityClass;
  fallback: string;
  priority: 1 | 2 | 3;
}

export interface DesktopReadinessCheck {
  id: string;
  label: string;
  ready: boolean;
}

const keyBackedFeatures: RuntimeFeatureId[] = [
  'aiOllama',
  'aiGroq',
  'aiOpenRouter',
  'economicFred',
  'internetOutages',
  'acledConflicts',
  'abuseChThreatIntel',
  'alienvaultOtxThreatIntel',
  'abuseIpdbThreatIntel',
  'aisRelay',
  'openskyRelay',
  'wingbitsEnrichment',
  'energyEia',
];

export const DESKTOP_PARITY_FEATURES: DesktopParityFeature[] = [
  {
    id: 'live-news',
    panel: 'LiveNewsPanel',
    serviceFiles: ['src/services/live-news.ts'],
    apiRoutes: ['/api/youtube/live'],
    apiHandlers: ['api/youtube/live.js'],
    locality: 'fully-local',
    fallback: 'Channel fallback video IDs are used when live detection fails.',
    priority: 1,
  },
  {
    id: 'monitor',
    panel: 'MonitorPanel',
    serviceFiles: [],
    apiRoutes: [],
    apiHandlers: [],
    locality: 'fully-local',
    fallback: 'Keyword monitoring runs fully client-side on loaded news corpus.',
    priority: 1,
  },
  {
    id: 'strategic-risk',
    panel: 'StrategicRiskPanel',
    serviceFiles: ['src/services/cached-risk-scores.ts'],
    apiRoutes: ['/api/risk-scores'],
    apiHandlers: ['api/risk-scores.js'],
    locality: 'api-key',
    fallback: 'Panel stays available with local aggregate scoring when cached backend scores are unavailable.',
    priority: 1,
  },
  {
    id: 'map-layers-core',
    panel: 'Map layers (conflicts/outages/cyber/ais/flights)',
    serviceFiles: ['src/services/conflict/index.ts', 'src/services/infrastructure/index.ts', 'src/services/cyber/index.ts', 'src/services/maritime/index.ts', 'src/services/military-flights.ts'],
    apiRoutes: ['/api/conflict/v1/list-acled-events', '/api/infrastructure/v1/list-internet-outages', '/api/cyber/v1/list-cyber-threats', '/api/maritime/v1/get-vessel-snapshot', '/api/military/v1/list-military-flights'],
    apiHandlers: ['server/worldmonitor/conflict/v1/handler.ts', 'server/worldmonitor/infrastructure/v1/handler.ts', 'server/worldmonitor/cyber/v1/handler.ts', 'server/worldmonitor/maritime/v1/handler.ts', 'server/worldmonitor/military/v1/handler.ts'],
    locality: 'api-key',
    fallback: 'Unavailable feeds are disabled while map rendering remains active for local/static layers.',
    priority: 1,
  },
  {
    id: 'summaries',
    panel: 'Summaries',
    serviceFiles: ['src/services/summarization.ts'],
    apiRoutes: ['/api/news/v1/summarize-article'],
    apiHandlers: ['server/worldmonitor/news/v1/handler.ts'],
    locality: 'api-key',
    fallback: 'Browser summarizer executes when hosted LLM providers are unavailable.',
    priority: 2,
  },
  {
    id: 'market-panel',
    panel: 'MarketPanel',
    serviceFiles: ['src/services/market/index.ts', 'src/services/prediction/index.ts'],
    apiRoutes: ['/api/market/v1/list-crypto-quotes', '/api/market/v1/list-stablecoin-markets', '/api/market/v1/list-etf-flows'],
    apiHandlers: ['server/worldmonitor/market/v1/handler.ts'],
    locality: 'fully-local',
    fallback: 'Multi-source market fetchers degrade to remaining providers and cached values.',
    priority: 2,
  },
  {
    id: 'wingbits-enrichment',
    panel: 'Map layers (flight enrichment)',
    serviceFiles: ['src/services/wingbits.ts'],
    apiRoutes: ['/api/military/v1/get-aircraft-details', '/api/military/v1/get-aircraft-details-batch', '/api/military/v1/get-wingbits-status'],
    apiHandlers: ['server/worldmonitor/military/v1/handler.ts'],
    locality: 'api-key',
    fallback: 'Flight tracks continue with heuristic classification when Wingbits credentials are unavailable.',
    priority: 3,
  },
  {
    id: 'opensky-relay-cloud',
    panel: 'Map layers (military flights relay)',
    serviceFiles: ['src/services/military-flights.ts'],
    apiRoutes: ['/api/military/v1/list-military-flights'],
    apiHandlers: ['server/worldmonitor/military/v1/handler.ts'],
    locality: 'cloud-fallback',
    fallback: 'If relay is unreachable, service falls back to Vercel proxy path and then no-data mode.',
    priority: 3,
  },
];

export function getNonParityFeatures(): DesktopParityFeature[] {
  return DESKTOP_PARITY_FEATURES.filter(feature => feature.locality !== 'fully-local');
}

export function getDesktopReadinessChecks(localBackendEnabled: boolean): DesktopReadinessCheck[] {
  const liveTrackingReady = isFeatureAvailable('aisRelay') || isFeatureAvailable('openskyRelay');

  return [
    { id: 'startup', label: 'Desktop startup + sidecar API health', ready: localBackendEnabled },
    { id: 'map', label: 'Map rendering (local layers + static geo assets)', ready: true },
    { id: 'core-intel', label: 'Core intelligence panels (Live News, Monitor, Strategic Risk)', ready: true },
    { id: 'summaries', label: 'Summaries (provider-backed or browser fallback)', ready: isFeatureAvailable('aiOllama') || isFeatureAvailable('aiGroq') || isFeatureAvailable('aiOpenRouter') },
    { id: 'market', label: 'Market panel live data paths', ready: true },
    { id: 'live-tracking', label: 'At least one live-tracking mode (AIS or OpenSky)', ready: liveTrackingReady },
  ];
}

export function getKeyBackedAvailabilitySummary(): { available: number; total: number } {
  const available = keyBackedFeatures.filter(featureId => isFeatureAvailable(featureId)).length;
  return { available, total: keyBackedFeatures.length };
}
