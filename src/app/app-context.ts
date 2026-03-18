import type { InternetOutage, SocialUnrestEvent, MilitaryFlight, MilitaryFlightCluster, MilitaryVessel, MilitaryVesselCluster, USNIFleetReport, PanelConfig, MapLayers, NewsItem, MarketData, ClusteredEvent, CyberThreat, Monitor } from '@/types';
import type { AirportDelayAlert, PositionSample } from '@/services/aviation';
import type { IranEvent } from '@/generated/client/worldmonitor/conflict/v1/service_client';
import type { SanctionsPressureResult } from '@/services/sanctions-pressure';
import type { RadiationWatchResult } from '@/services/radiation';
import type { SecurityAdvisory } from '@/services/security-advisories';
import type { Earthquake } from '@/services/earthquakes';

export type { CountryBriefSignals } from '@/types';

export interface IntelligenceCache {
  flightDelays?: AirportDelayAlert[];
  aircraftPositions?: PositionSample[];
  outages?: InternetOutage[];
  protests?: { events: SocialUnrestEvent[]; sources: { acled: number; gdelt: number } };
  military?: { flights: MilitaryFlight[]; flightClusters: MilitaryFlightCluster[]; vessels: MilitaryVessel[]; vesselClusters: MilitaryVesselCluster[] };
  earthquakes?: Earthquake[];
  usniFleet?: USNIFleetReport;
  iranEvents?: IranEvent[];
  orefAlerts?: { alertCount: number; historyCount24h: number };
  advisories?: SecurityAdvisory[];
  sanctions?: SanctionsPressureResult;
  radiation?: RadiationWatchResult;
  imageryScenes?: Array<{ id: string; satellite: string; datetime: string; resolutionM: number; mode: string; geometryGeojson: string; previewUrl: string; assetUrl: string }>;
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
  latestPredictions: import('@/services/prediction').PredictionMarket[];
  latestClusters: ClusteredEvent[];
  intelligenceCache: IntelligenceCache;
  cyberThreatsCache: CyberThreat[] | null;

  disabledSources: Set<string>;
  currentTimeRange: import('@/components').TimeRange;

  inFlight: Set<string>;
  seenGeoAlerts: Set<string>;
  monitors: Monitor[];

  signalModal: import('@/components').SignalModal | null;
  statusPanel: import('@/components').StatusPanel | null;
  searchModal: import('@/components').SearchModal | null;
  findingsBadge: import('@/components').IntelligenceGapBadge | null;
  breakingBanner: import('@/components/BreakingNewsBanner').BreakingNewsBanner | null;
  playbackControl: import('@/components').PlaybackControl | null;
  exportPanel: import('@/utils').ExportPanel | null;
  unifiedSettings: import('@/components/UnifiedSettings').UnifiedSettings | null;
  pizzintIndicator: import('@/components').PizzIntIndicator | null;
  correlationEngine: import('@/services/correlation-engine').CorrelationEngine | null;
  llmStatusIndicator: import('@/components').LlmStatusIndicator | null;
  countryBriefPage: import('@/components/CountryBriefPanel').CountryBriefPanel | null;
  countryTimeline: import('@/components/CountryTimeline').CountryTimeline | null;

  positivePanel: import('@/components/PositiveNewsFeedPanel').PositiveNewsFeedPanel | null;
  countersPanel: import('@/components/CountersPanel').CountersPanel | null;
  progressPanel: import('@/components/ProgressChartsPanel').ProgressChartsPanel | null;
  breakthroughsPanel: import('@/components/BreakthroughsTickerPanel').BreakthroughsTickerPanel | null;
  heroPanel: import('@/components/HeroSpotlightPanel').HeroSpotlightPanel | null;
  digestPanel: import('@/components/GoodThingsDigestPanel').GoodThingsDigestPanel | null;
  speciesPanel: import('@/components/SpeciesComebackPanel').SpeciesComebackPanel | null;
  renewablePanel: import('@/components/RenewableEnergyPanel').RenewableEnergyPanel | null;
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
