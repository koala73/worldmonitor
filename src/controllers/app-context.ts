/**
 * AppContext — shared mutable state surface exposed to controllers.
 *
 * The `App` class implements this interface.  Controllers receive it in their
 * constructor so they can read/write shared state without importing App.ts
 * directly (avoids circular dependencies).
 */

import type {
  NewsItem,
  Monitor,
  PanelConfig,
  MapLayers,
  InternetOutage,
  SocialUnrestEvent,
  MilitaryFlight,
  MilitaryVessel,
  MilitaryFlightCluster,
  MilitaryVesselCluster,
  CyberThreat,
  ClusteredEvent,
  PredictionMarket,
  MarketData,
  Earthquake,
} from '@/types';
import type {
  MapContainer,
  TimeRange,
  NewsPanel,
  Panel,
  SignalModal,
  PlaybackControl,
  StatusPanel,
  SearchModal,
  MobileWarningModal,
  PizzIntIndicator,
  IntelligenceGapBadge,
  LanguageSelector,
} from '@/components';
import type { ExportPanel, ParsedMapUrlState } from '@/utils';
import type { CountryBriefPage } from '@/components/CountryBriefPage';
import type { CountryTimeline } from '@/components/CountryTimeline';

/* ------------------------------------------------------------------ */
/*  Intelligence cache                                                 */
/* ------------------------------------------------------------------ */

export interface IntelligenceCache {
  outages?: InternetOutage[];
  protests?: {
    events: SocialUnrestEvent[];
    sources: { acled: number; gdelt: number };
  };
  military?: {
    flights: MilitaryFlight[];
    flightClusters: MilitaryFlightCluster[];
    vessels: MilitaryVessel[];
    vesselClusters: MilitaryVesselCluster[];
  };
  earthquakes?: Earthquake[];
}

/* ------------------------------------------------------------------ */
/*  Country brief signals (re-exported from App for external use)      */
/* ------------------------------------------------------------------ */

export interface CountryBriefSignals {
  protests: number;
  militaryFlights: number;
  militaryVessels: number;
  outages: number;
  earthquakes: number;
  displacementOutflow: number;
  climateStress: number;
  conflictEvents: number;
  isTier1: boolean;
}

/* ------------------------------------------------------------------ */
/*  AppContext interface                                                */
/* ------------------------------------------------------------------ */

export interface AppContext {
  /* ---- DOM ---- */
  container: HTMLElement;

  /* ---- Map ---- */
  map: MapContainer | null;
  mapLayers: MapLayers;

  /* ---- Panels ---- */
  panels: Record<string, Panel>;
  newsPanels: Record<string, NewsPanel>;
  panelSettings: Record<string, PanelConfig>;

  /* ---- Data state ---- */
  allNews: NewsItem[];
  newsByCategory: Record<string, NewsItem[]>;
  latestClusters: ClusteredEvent[];
  latestMarkets: MarketData[];
  latestPredictions: PredictionMarket[];
  currentTimeRange: TimeRange;
  monitors: Monitor[];

  /* ---- Intelligence cache ---- */
  intelligenceCache: IntelligenceCache;
  cyberThreatsCache: CyberThreat[] | null;

  /* ---- Singleton components ---- */
  signalModal: SignalModal | null;
  findingsBadge: IntelligenceGapBadge | null;
  statusPanel: StatusPanel | null;
  searchModal: SearchModal | null;
  playbackControl: PlaybackControl | null;
  exportPanel: ExportPanel | null;
  countryBriefPage: CountryBriefPage | null;
  countryTimeline: CountryTimeline | null;
  pizzintIndicator: PizzIntIndicator | null;
  mobileWarningModal: MobileWarningModal | null;
  languageSelector: LanguageSelector | null;
  criticalBannerEl: HTMLElement | null;

  /* ---- Flags / lifecycle ---- */
  isPlaybackMode: boolean;
  isMobile: boolean;
  readonly isDesktopApp: boolean;
  isDestroyed: boolean;
  isIdle: boolean;
  initialLoadComplete: boolean;

  /* ---- In-flight tracking ---- */
  inFlight: Set<string>;
  disabledSources: Set<string>;
  seenGeoAlerts: Set<string>;

  /* ---- Timers / intervals ---- */
  refreshTimeoutIds: Map<string, ReturnType<typeof setTimeout>>;
  snapshotIntervalId: ReturnType<typeof setInterval> | null;
  updateCheckIntervalId: ReturnType<typeof setInterval> | null;
  idleTimeoutId: ReturnType<typeof setTimeout> | null;

  /* ---- Event handler refs (for cleanup) ---- */
  boundKeydownHandler: ((e: KeyboardEvent) => void) | null;
  boundFullscreenHandler: (() => void) | null;
  boundResizeHandler: (() => void) | null;
  boundVisibilityHandler: (() => void) | null;
  boundIdleResetHandler: (() => void) | null;

  /* ---- URL / deep link state ---- */
  initialUrlState: ParsedMapUrlState | null;
  pendingDeepLinkCountry: string | null;
  briefRequestToken: number;

  /* ---- Map flash cache ---- */
  mapFlashCache: Map<string, number>;
  readonly MAP_FLASH_COOLDOWN_MS: number;

  /* ---- Constants ---- */
  readonly IDLE_PAUSE_MS: number;
  readonly PANEL_ORDER_KEY: string;
  readonly PANEL_SPANS_KEY: string;
  readonly UPDATE_CHECK_INTERVAL_MS: number;
}
