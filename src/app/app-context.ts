import type { InternetOutage, SocialUnrestEvent, MilitaryFlight, MilitaryFlightCluster, MilitaryVessel, MilitaryVesselCluster, USNIFleetReport, PanelConfig, MapLayers, NewsItem, MarketData, ClusteredEvent, CyberThreat, Monitor, AisDisruptionEvent } from '@/types';
import type { AirportDelayAlert, PositionSample } from '@/services/aviation';
import type { IranEvent } from '@/generated/client/worldmonitor/conflict/v1/service_client';
import type { ConflictEvent } from '@/services/conflict';
import type { GpsJamHex } from '@/services/gps-interference';

// Geometry-resolved satellite-fire shape ingested into CII. Mirrors the inline
// projection built in DataLoaderManager.loadFirmsData so the cache can replay it
// once precision country geometry is ready (#4512).
export type SatelliteFireSignal = {
  lat: number;
  lon: number;
  brightness: number;
  frp: number;
  region?: string;
};
import type { SanctionsPressureResult } from '@/services/sanctions-pressure';
import type { RadiationWatchResult } from '@/services/radiation';
import type { SecurityAdvisory } from '@/services/security-advisories';
import type { Earthquake } from '@/services/earthquakes';

export type { CountryBriefSignals } from '@/types';

import type { UnifiedSettingsTabId } from '@/components/settings-types';
export type { UnifiedSettingsTabId };

export interface UnifiedSettingsController {
  open(tab?: UnifiedSettingsTabId): void;
  refreshPanelToggles(): void;
  getButton(): HTMLButtonElement;
  destroy(): void;
}

export interface IntelligenceCache {
  conflicts?: ConflictEvent[];
  // Coordinate-resolved sources whose CII attribution depends on precision
  // country geometry. They are ingested during the visible-data fan-out (before
  // geometry is ready, so attribution is coarse/empty) and replayed once
  // geometry lands — see refreshGeometryDependentCiiAfterCountryGeometry (#4512).
  gpsJamming?: GpsJamHex[];
  aisDisruptions?: AisDisruptionEvent[];
  satelliteFires?: SatelliteFireSignal[];
  flightDelays?: AirportDelayAlert[];
  thermalEscalation?: import('@/services/thermal-escalation').ThermalEscalationWatch;
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
  latestTechEvents: Array<{ id: string; title: string; location: string; startDate: string; [key: string]: unknown }>;
  latestClusters: ClusteredEvent[];
  intelligenceCache: IntelligenceCache;
  cyberThreatsCache: CyberThreat[] | null;

  disabledSources: Set<string>;
  currentTimeRange: import('@/components').TimeRange;

  inFlight: Set<string>;
  seenGeoAlerts: Set<string>;
  monitors: Monitor[];

  signalModal: import('@/components/SignalModal').SignalModal | null;
  ensureSignalModal: () => Promise<import('@/components/SignalModal').SignalModal>;
  statusPanel: import('@/components').StatusPanel | null;
  searchModal: import('@/components').SearchModal | null;
  findingsBadge: import('@/components').IntelligenceGapBadge | null;
  breakingBanner: import('@/components/BreakingNewsBanner').BreakingNewsBanner | null;
  playbackControl: import('@/components').PlaybackControl | null;
  exportPanel: import('@/utils/export').ExportPanel | null;
  unifiedSettings: UnifiedSettingsController | null;
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
  authModal: { open(): void; close(): void; destroy(): void } | null;
  authHeaderWidget: import('@/components/AuthHeaderWidget').AuthHeaderWidget | null;
  tvMode: import('@/services/tv-mode').TvModeController | null;
  happyAllItems: NewsItem[];
  isDestroyed: boolean;
  isPlaybackMode: boolean;
  isIdle: boolean;
  initialLoadComplete: boolean;
  resolvedLocation: 'global' | 'america' | 'mena' | 'eu' | 'asia' | 'latam' | 'africa' | 'oceania';
  activeChokepoint: string | null;

  initialUrlState: import('@/utils').ParsedMapUrlState | null;
  readonly PANEL_ORDER_KEY: string;
  readonly PANEL_SPANS_KEY: string;
}

export interface AppModule {
  init(): void | Promise<void>;
  destroy(): void;
}
