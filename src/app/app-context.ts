import type { InternetOutage, SocialUnrestEvent, MilitaryFlight, MilitaryFlightCluster, MilitaryVessel, MilitaryVesselCluster, USNIFleetReport, PanelConfig, MapLayers, NewsItem, MarketData, ClusteredEvent, CyberThreat, Monitor } from '@/types';

export interface IntelligenceCache {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
  outages?: InternetOutage[];
  protests?: { events: SocialUnrestEvent[]; sources: { acled: number; gdelt: number } };
  military?: { flights: MilitaryFlight[]; flightClusters: MilitaryFlightCluster[]; vessels: MilitaryVessel[]; vesselClusters: MilitaryVesselCluster[] };
  usniFleet?: USNIFleetReport;
  iranEvents?: unknown[];
  orefAlerts?: { alertCount: number; historyCount24h: number };
}

export interface AppContext {
  map: import('@/components').MapContainer | null;
  readonly isMobile: boolean;
  readonly isDesktopApp: boolean;
  readonly container: HTMLElement;

  panels: Record<string, import('@/components').Panel>;
  newsPanels: Record<string, import('@/components').NewsPanel>;
  panelSettings: Record<string, PanelConfig>;

  mapLayers: MapLayers;

  allNews: NewsItem[];
  newsByCategory: Record<string, NewsItem[]>;
  latestMarkets: MarketData[];
  latestPredictions: unknown[];
  latestClusters: ClusteredEvent[];
  intelligenceCache: IntelligenceCache;
  cyberThreatsCache: CyberThreat[] | null;

  disabledSources: Set<string>;
  currentTimeRange: import('@/components').TimeRange;

  inFlight: Set<string>;
  seenGeoAlerts: Set<string>;
  monitors: Monitor[];

  signalModal: null;
  statusPanel: import('@/components').StatusPanel | null;
  searchModal: import('@/components').SearchModal | null;
  findingsBadge: null;
  breakingBanner: null;
  playbackControl: null;
  exportPanel: import('@/utils').ExportPanel | null;
  unifiedSettings: import('@/components/UnifiedSettings').UnifiedSettings | null;
  pizzintIndicator: import('@/components').PizzIntIndicator | null;
  correlationEngine: null;
  llmStatusIndicator: import('@/components').LlmStatusIndicator | null;
  countryBriefPage: null;
  countryTimeline: null;

  positivePanel: null;
  countersPanel: null;
  progressPanel: null;
  breakthroughsPanel: null;
  heroPanel: null;
  digestPanel: null;
  speciesPanel: null;
  renewablePanel: null;
  authModal: { open(): void; close(): void; destroy(): void } | null;
  authHeaderWidget: import('@/components/AuthHeaderWidget').AuthHeaderWidget | null;
  tvMode: import('@/services/tv-mode').TvModeController | null;
  happyAllItems: NewsItem[];
  isDestroyed: boolean;
  isPlaybackMode: boolean;
  isIdle: boolean;
  initialLoadComplete: boolean;
  resolvedLocation: 'global' | 'america' | 'mena' | 'eu' | 'asia' | 'latam' | 'africa' | 'oceania';

  initialUrlState: import('@/utils').ParsedMapUrlState | null;
  readonly PANEL_ORDER_KEY: string;
  readonly PANEL_SPANS_KEY: string;
}

export interface AppModule {
  init(): void | Promise<void>;
  destroy(): void;
}
