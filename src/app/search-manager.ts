import type { AppContext, AppModule } from '@/app/app-context';
import type { SearchResult } from '@/components/search-types';
import type { SearchMatch } from '@/components/search-types';
import type { NewsItem, MapLayers, MilitaryBase, MilitaryFlight } from '@/types';
import type { Command } from '@/config/commands';
import { SearchModal } from '@/components/SearchModal';
import type { CIIPanel } from '@/components/CIIPanel';
import {
  SITE_VARIANT,
  ALL_PANELS,
  FREE_MAX_PANELS,
  countFreePanelCapUsage,
  getEffectivePanelConfig,
  isFreePanelCapCounted,
  isPanelEntitled,
} from '@/config';
import {
  getAllowedLayerKeys,
  isLayerCommandAllowed,
  isLayerExecutable,
  isLayerEntitled,
} from '@/config/map-layer-definitions';
import type { MapVariant, RendererKind } from '@/config/map-layer-definitions';
import { LAYER_PRESETS, LAYER_KEY_MAP } from '@/config/commands';
import { TIER1_COUNTRIES } from '@/services/country-instability';
import { getCachedCountryScores } from '@/services/cached-risk-scores';
import { getCountryBbox } from '@/services/country-geometry';
import { INTEL_HOTSPOTS, CONFLICT_ZONES } from '@/config/geo';
import { getCachedMilitaryBases, preloadMilitaryBases } from '@/services/military-base-config';
import { UNDERSEA_CABLES, NUCLEAR_FACILITIES } from '@/config/geo-map';
import { PIPELINES } from '@/config/pipelines';
import { AI_DATA_CENTERS } from '@/config/ai-datacenters';
import { GAMMA_IRRADIATORS } from '@/config/irradiators';
import { TECH_COMPANIES } from '@/config/tech-companies';
import { AI_RESEARCH_LABS } from '@/config/ai-research-labs';
import { STARTUP_ECOSYSTEMS } from '@/config/startup-ecosystems';
import { TECH_HQS, ACCELERATORS } from '@/config/tech-geo';
import { STOCK_EXCHANGES, FINANCIAL_CENTERS, CENTRAL_BANKS, COMMODITY_HUBS } from '@/config/finance-geo';
import { trackSearchResultSelected, trackCountrySelected } from '@/services/analytics';
import { t } from '@/services/i18n';
import { saveToStorage, setTheme } from '@/utils';
import { withTimeout } from '@/utils/with-timeout';
import { CountryIntelManager } from '@/app/country-intel';
import type { PositionSample } from '@/services/aviation';
import { fetchAircraftPositions } from '@/services/aviation';
import { subscribeWidgetAccess } from '@/services/widget-store';
import { getAuthState, subscribeAuthState } from '@/services/auth-state';
import { hasPremiumAccess } from '@/services/panel-gating';
import { onEntitlementChange } from '@/services/entitlements';
import { subscribeRuntimeConfig } from '@/services/runtime-config';
import {
  runWithAgentAnalyticsSuppressed,
  suppressNextAgentPanelView,
} from '@/services/agent-analytics-privacy';
import { SearchSelectionDispatcher } from '@/app/search-selection-dispatcher';
import { WebMcpSearchController } from '@/app/webmcp-search-controller';
import type {
  DashboardSearchOpenResult,
  DashboardSearchResponse,
  DashboardSearchScope,
} from '@/services/webmcp';
const FLIGHT_SEARCH_SOURCE_TTL_MS = 2 * 60 * 1000;

interface FlightSearchItem {
  id: string;
  title: string;
  subtitle: string;
  data: {
    kind: 'adsb' | 'military';
    lat: number;
    lon: number;
    layer: 'flights' | 'military';
  };
  expiresAt: number;
}

const LAYER_PRESET_PRIMARY_LAYERS: Record<string, (keyof MapLayers)[]> = {
  military: ['bases', 'flights', 'military'],
  finance: ['stockExchanges', 'financialCenters', 'centralBanks', 'commodityHubs', 'economic'],
  infra: ['cables', 'pipelines', 'datacenters', 'spaceports', 'minerals'],
  intel: ['conflicts', 'hotspots', 'protests', 'ucdpEvents', 'displacement'],
  minimal: ['conflicts', 'hotspots'],
};

export interface SearchManagerCallbacks {
  openCountryBriefByCode: (
    code: string,
    country: string,
    options?: { trackDetailedAnalytics?: boolean },
  ) => boolean | Promise<boolean>;
  /** Enables a currently-disabled panel (CMD+K "Add"). Returns false if blocked (unknown / free-tier cap). */
  enablePanel: (panelId: string, options?: { trackDetailedAnalytics?: boolean }) => boolean;
}

export class SearchManager implements AppModule {
  private static readonly SEARCH_INDEX_READY_TIMEOUT_MS = 2_000;

  private static flightObservationTime(
    value: unknown,
    fallback: number,
    now: number,
  ): number {
    const parsed = value instanceof Date
      ? value.getTime()
      : typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Date.parse(value)
          : Number.NaN;
    const timestamp = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    // A bad upstream clock must not turn a live-position result into a
    // capability with an arbitrarily long lifetime.
    return Math.min(timestamp, now);
  }

  private static buildFlightSearchItems(
    adsb: PositionSample[],
    military: MilitaryFlight[],
    adsbUpdatedAt: number,
    now: number,
  ): FlightSearchItem[] {
    const safeAdsbUpdatedAt = SearchManager.flightObservationTime(adsbUpdatedAt, now, now);
    return [
      ...adsb.map((position) => {
        const fl = Number.isFinite(position.altitudeFt)
          ? Math.round(position.altitudeFt / 100)
          : null;
        const kts = Number.isFinite(position.groundSpeedKts)
          ? Math.round(position.groundSpeedKts)
          : null;
        const observedAt = SearchManager.flightObservationTime(
          position.observedAt,
          safeAdsbUpdatedAt,
          now,
        );
        return {
          id: position.icao24,
          title: (position.callsign || position.icao24).trim().toUpperCase(),
          subtitle: position.onGround
            ? t('modals.search.flightOnGround')
            : fl !== null && kts !== null
              ? t('modals.search.flightAirborne', { fl: String(fl), kts: String(kts) })
              : fl !== null
                ? `FL${fl}`
                : t('modals.search.flightOnGround'),
          data: {
            kind: 'adsb' as const,
            lat: position.lat,
            lon: position.lon,
            layer: 'flights' as const,
          },
          expiresAt: observedAt + FLIGHT_SEARCH_SOURCE_TTL_MS,
        };
      }),
      ...military.map((flight) => {
        const fl = Number.isFinite(flight.altitude)
          ? Math.round(flight.altitude / 100)
          : null;
        // Military data is read from intelligenceCache when an independent
        // ADS-B viewport callback fires. Never use that callback's timestamp as
        // military freshness: doing so renewed a stalled military feed forever.
        const observedAt = SearchManager.flightObservationTime(flight.lastSeen, 0, now);
        return {
          id: flight.hexCode,
          title: (flight.callsign || flight.hexCode).trim().toUpperCase(),
          subtitle: flight.onGround
            ? t('modals.search.flightMilitaryOnGround', { type: flight.aircraftType })
            : fl !== null
              ? t('modals.search.flightMilitary', {
                  type: flight.aircraftType,
                  fl: String(fl),
                })
              : t('modals.search.flightMilitaryOnGround', { type: flight.aircraftType }),
          data: {
            kind: 'military' as const,
            lat: flight.lat,
            lon: flight.lon,
            layer: 'military' as const,
          },
          expiresAt: observedAt + FLIGHT_SEARCH_SOURCE_TTL_MS,
        };
      }),
    ].filter((item) => item.expiresAt > now);
  }

  private ctx: AppContext;
  private callbacks: SearchManagerCallbacks;
  private readonly searchSelection: SearchSelectionDispatcher;
  private readonly webMcpSearch: WebMcpSearchController;
  private destroyed = false;
  private flightSourceExpiresAt = 0;
  private flightSearchItems: FlightSearchItem[] = [];
  private latestAdsb: PositionSample[] = [];
  private latestMilitary: MilitaryFlight[] = [];
  private latestAdsbUpdatedAt = 0;
  private liveFlightOverlay: Array<{ position: PositionSample; expiresAt: number }> = [];
  private liveFlightLookupGeneration = 0;
  private acceptLateBaseHydration = true;
  private searchIndexReady: Promise<void> = Promise.resolve();

  constructor(ctx: AppContext, callbacks: SearchManagerCallbacks) {
    this.ctx = ctx;
    this.callbacks = callbacks;
    this.searchSelection = new SearchSelectionDispatcher({
      ctx,
      getVariant: () => SITE_VARIANT,
      hasPremiumAccess: () => hasPremiumAccess(getAuthState()),
      openCountryBriefByCode: (...args) => this.callbacks.openCountryBriefByCode(...args),
      enablePanel: (...args) => this.callbacks.enablePanel(...args),
      trackSearchResultSelected,
      trackCountrySelected,
      runWithAgentAnalyticsSuppressed,
      suppressNextAgentPanelView,
      resolveExecutableNewsPanel: (link) => this.resolveExecutableNewsPanel(link),
      saveToStorage,
      setTheme,
      // Must stay wrapped, not passed bare: the dispatcher invokes these as
      // `this.bindings.setTimeout(...)` / `this.bindings.clearTimeout(...)`,
      // a method call. The native functions require the receiver to be the
      // global object, so handing over the bare reference makes that call
      // throw `TypeError: Illegal invocation` (WORLDMONITOR-ZT). Wrapping
      // keeps the invocation unqualified, matching every other binding here.
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (timer) => clearTimeout(timer),
    });
    this.webMcpSearch = new WebMcpSearchController({
      waitForIndexReady: () => this.waitForSearchIndexReady(),
      isDestroyed: () => this.destroyed,
      refreshIndex: () => this.updateSearchIndex({ updateVisibleMetrics: false }),
      getModal: () => this.ctx.searchModal,
      hasPremiumAccess: () => hasPremiumAccess(getAuthState()),
      fetchLiveFlight: async (callsign) => {
        const generation = this.liveFlightLookupGeneration;
        const completed = await SearchManager.waitWithTimeout(
          this.fetchAndPublishLiveFlight(callsign, generation),
          SearchManager.SEARCH_INDEX_READY_TIMEOUT_MS,
          'live-flight-search',
        );
        if (!completed) this.liveFlightLookupGeneration += 1;
      },
      cancelPendingSelection: () => this.searchSelection.destroy(),
      getAuthContext: () => {
        const auth = getAuthState();
        return `${auth.user ? 'signed-in' : 'anonymous'}:${auth.isPending ? 'pending' : 'settled'}:${hasPremiumAccess(auth) ? 'premium' : 'free'}`;
      },
      getVariant: () => SITE_VARIANT,
      isMatchExecutable: (match) => this.isSearchMatchExecutable(match),
      selectMatch: (match) => this.searchSelection.selectProgrammaticMatch(match),
      subscribeAuth: subscribeAuthState,
      subscribeEntitlement: onEntitlementChange,
      subscribeRuntimeConfig,
      subscribeWidgetAccess,
      onPremiumAccessChanged: (premium, premiumRestored) => {
        if (!premium) {
          this.flightSearchItems = [];
          this.flightSourceExpiresAt = 0;
          this.liveFlightOverlay = [];
          this.ctx.searchModal?.registerSource('flight', []);
        } else if (premiumRestored) {
          this.updateFlightSource(
            this.latestAdsb,
            this.latestMilitary,
            this.latestAdsbUpdatedAt,
          );
          this.ctx.searchModal?.refreshSearch();
        }
      },
    });
  }

  init(): void {
    this.destroyed = false;
    this.observeSecurityContext();
    this.setupSearchModal();
  }

  public whenSearchIndexReady(): Promise<void> {
    return this.searchIndexReady;
  }

  destroy(): void {
    this.destroyed = true;
    this.liveFlightLookupGeneration += 1;
    this.acceptLateBaseHydration = false;
    this.ctx.searchModal?.cancelPendingWork();
    this.webMcpSearch.destroy();
    this.searchSelection.destroy();
    this.flightSearchItems = [];
    this.flightSourceExpiresAt = 0;
    this.liveFlightOverlay = [];
    this.latestAdsb = [];
    this.latestMilitary = [];
    this.latestAdsbUpdatedAt = 0;
  }

  private setupSearchModal(): void {
    const searchOptions = SITE_VARIANT === 'tech'
      ? { placeholder: t('modals.search.placeholderTech') }
      : SITE_VARIANT === 'happy'
        ? { placeholder: 'Search or type a command...' }
        : SITE_VARIANT === 'finance'
          ? { placeholder: t('modals.search.placeholderFinance') }
          : { placeholder: t('modals.search.placeholder') };
    this.ctx.searchModal = new SearchModal(this.ctx.container, searchOptions);

    if (SITE_VARIANT === 'happy') {
      // Happy variant: no geopolitical/military/infrastructure sources
    } else if (SITE_VARIANT === 'tech') {
      this.ctx.searchModal.registerSource('techcompany', TECH_COMPANIES.map(c => ({
        id: c.id,
        title: c.name,
        subtitle: `${c.sector} ${c.city} ${c.keyProducts?.join(' ') || ''}`.trim(),
        data: c,
      })));

      this.ctx.searchModal.registerSource('ailab', AI_RESEARCH_LABS.map(l => ({
        id: l.id,
        title: l.name,
        subtitle: `${l.type} ${l.city} ${l.focusAreas?.join(' ') || ''}`.trim(),
        data: l,
      })));

      this.ctx.searchModal.registerSource('startup', STARTUP_ECOSYSTEMS.map(s => ({
        id: s.id,
        title: s.name,
        subtitle: `${s.ecosystemTier} ${s.topSectors?.join(' ') || ''} ${s.notableStartups?.join(' ') || ''}`.trim(),
        data: s,
      })));

      this.ctx.searchModal.registerSource('datacenter', AI_DATA_CENTERS.map(d => ({
        id: d.id,
        title: d.name,
        subtitle: `${d.owner} ${d.chipType || ''}`.trim(),
        data: d,
      })));

      this.ctx.searchModal.registerSource('cable', UNDERSEA_CABLES.map(c => ({
        id: c.id,
        title: c.name,
        subtitle: c.major ? 'Major internet backbone' : 'Undersea cable',
        data: c,
      })));

      this.ctx.searchModal.registerSource('techhq', TECH_HQS.map(h => ({
        id: h.id,
        title: h.company,
        subtitle: `${h.type === 'faang' ? 'Big Tech' : h.type === 'unicorn' ? 'Unicorn' : 'Public'} • ${h.city}, ${h.country}`,
        data: h,
      })));

      this.ctx.searchModal.registerSource('accelerator', ACCELERATORS.map(a => ({
        id: a.id,
        title: a.name,
        subtitle: `${a.type} • ${a.city}, ${a.country}${a.notable ? ` • ${a.notable.slice(0, 2).join(', ')}` : ''}`,
        data: a,
      })));
    } else {
      this.ctx.searchModal.registerSource('hotspot', INTEL_HOTSPOTS.map(h => ({
        id: h.id,
        title: h.name,
        subtitle: h.subtext || 'Intelligence hotspot',
        searchText: `${h.keywords?.join(' ') || ''} ${h.description || ''}`.trim(),
        data: h,
      })));

      this.ctx.searchModal.registerSource('conflict', CONFLICT_ZONES.map(c => ({
        id: c.id,
        title: c.name,
        subtitle: c.parties?.join(' ') || 'Conflict zone',
        searchText: `${c.keywords?.join(' ') || ''} ${c.description || ''}`.trim(),
        data: c,
      })));

      if (getAllowedLayerKeys((SITE_VARIANT || 'full') as MapVariant).has('bases')) {
        this.searchIndexReady = this.registerBaseSearchSource();
      }

      this.ctx.searchModal.registerSource('pipeline', PIPELINES.map(p => ({
        id: p.id,
        title: p.name,
        subtitle: `${p.type} ${p.operator || ''} ${p.countries?.join(' ') || ''}`.trim(),
        data: p,
      })));

      this.ctx.searchModal.registerSource('cable', UNDERSEA_CABLES.map(c => ({
        id: c.id,
        title: c.name,
        subtitle: c.major ? 'Major cable' : '',
        data: c,
      })));

      this.ctx.searchModal.registerSource('datacenter', AI_DATA_CENTERS.map(d => ({
        id: d.id,
        title: d.name,
        subtitle: `${d.owner} ${d.chipType || ''}`.trim(),
        data: d,
      })));

      this.ctx.searchModal.registerSource('nuclear', NUCLEAR_FACILITIES.map(n => ({
        id: n.id,
        title: n.name,
        subtitle: `${n.type} ${n.operator || ''}`.trim(),
        data: n,
      })));

      this.ctx.searchModal.registerSource('irradiator', GAMMA_IRRADIATORS.map(g => ({
        id: g.id,
        title: `${g.city}, ${g.country}`,
        subtitle: g.organization || '',
        data: g,
      })));
    }

    if (SITE_VARIANT === 'finance') {
      this.ctx.searchModal.registerSource('exchange', STOCK_EXCHANGES.map(e => ({
        id: e.id,
        title: `${e.shortName} - ${e.name}`,
        subtitle: `${e.tier} • ${e.city}, ${e.country}${e.marketCap ? ` • $${e.marketCap}T` : ''}`,
        data: e,
      })));

      this.ctx.searchModal.registerSource('financialcenter', FINANCIAL_CENTERS.map(f => ({
        id: f.id,
        title: f.name,
        subtitle: `${f.type} financial center${f.gfciRank ? ` • GFCI #${f.gfciRank}` : ''}${f.specialties ? ` • ${f.specialties.slice(0, 3).join(', ')}` : ''}`,
        data: f,
      })));

      this.ctx.searchModal.registerSource('centralbank', CENTRAL_BANKS.map(b => ({
        id: b.id,
        title: `${b.shortName} - ${b.name}`,
        subtitle: `${b.type}${b.currency ? ` • ${b.currency}` : ''} • ${b.city}, ${b.country}`,
        data: b,
      })));

    }

    if (getAllowedLayerKeys((SITE_VARIANT || 'full') as MapVariant).has('commodityHubs')) {
      this.ctx.searchModal.registerSource('commodityhub', COMMODITY_HUBS.map(h => ({
        id: h.id,
        title: h.name,
        subtitle: `${h.type} • ${h.city}, ${h.country}${h.commodities ? ` • ${h.commodities.slice(0, 3).join(', ')}` : ''}`,
        data: h,
      })));
    }

    this.ctx.searchModal.registerSource('country', this.buildCountrySearchItems());

    this.syncPanelSearchIndex();
    // Filter CMD+K layer commands by (a) variant-allowed, (b) renderer-kind
    // compatibility (a deck-only layer can't run on the SVG fallback or the
    // globe), (c) premium entitlement for locked layers. Without (a)–(b), layer
    // commands surface where they'd silently fail the variant/renderer guard
    // (e.g. `layer:storageFacilities` on tech/finance/commodity/happy, or globe
    // / SVG-mobile). Without (c), free users could enable locked layers like
    // resilienceScore, leaving a checked+disabled checkbox (#6045).
    // Currently-on locked layers stay visible so free users can turn them off
    // if stuck state survived from an older session.
    this.ctx.searchModal.setLayerExecutableFn((layerKey) => {
      const key = (LAYER_KEY_MAP[layerKey] || layerKey) as keyof MapLayers;
      if (!(key in this.ctx.mapLayers)) return false;
      const variantAllowed = getAllowedLayerKeys((SITE_VARIANT || 'full') as MapVariant);
      if (!variantAllowed.has(key)) return false;
      const kind = this.ctx.map?.isGlobeMode?.()
        ? 'globe'
        : (this.ctx.map?.isDeckGLActive?.() ? 'deck' : 'svg');
      return isLayerCommandAllowed(
        key,
        this.ctx.mapLayers[key],
        kind,
        hasPremiumAccess(getAuthState()),
      );
    });
    this.ctx.searchModal.setCommandVisibleFn((command) => this.isModalCommandVisible(command));
    this.ctx.searchModal.setResultVisibleFn((result) => this.isSearchResultVisible(result));
    this.ctx.searchModal.setOnSelect((result) => this.searchSelection.handleSearchResult(result));
    this.ctx.searchModal.setOnCommand((cmd) => this.searchSelection.handleCommand(cmd));
    // Always wire flight search; check pro status reactively inside the callback
    // so mid-session sign-ins get the feature without a page reload.
    this.ctx.searchModal.setOnFlightSearch((callsign) => {
      this.handleLiveFlightSearch(callsign);
    });

  }

  private handleLiveFlightSearch(callsign: string): void {
    if (!hasPremiumAccess(getAuthState())) return;
    void this.fetchAndPublishLiveFlight(callsign)
      .then(() => {
        if (!this.destroyed) this.ctx.searchModal?.refreshSearch();
      })
      .catch(() => {
        // Callsign lookup is optional enrichment. Keep the current viewport
        // ADS-B and military index intact when that single request fails.
      });
  }

  private static adsbIdentities(position: PositionSample): string[] {
    return [position.icao24, position.callsign]
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean);
  }

  private mergeLiveAdsb(
    current: PositionSample[],
    live: PositionSample[],
  ): PositionSample[] {
    const liveIdentities = new Set(live.flatMap(SearchManager.adsbIdentities));
    return [
      ...current.filter((position) => (
        !SearchManager.adsbIdentities(position).some((id) => liveIdentities.has(id))
      )),
      ...live,
    ];
  }

  private async fetchAndPublishLiveFlight(
    callsign: string,
    generation = this.liveFlightLookupGeneration,
  ): Promise<void> {
    const positions = await fetchAircraftPositions({ callsign });
    if (this.destroyed || generation !== this.liveFlightLookupGeneration) return;
    // Deduplicate by callsign: keep the most recently observed entry per callsign.
    const seen = new Map<string, PositionSample>();
    for (const p of positions) {
      const key = (p.callsign || p.icao24).trim().toUpperCase();
      const existing = seen.get(key);
      if (!existing || p.observedAt > existing.observedAt) {
        seen.set(key, p);
      }
    }
    const now = Date.now();
    this.rememberLiveFlightLookup([...seen.values()], now);
    this.updateFlightSource(this.latestAdsb, this.latestMilitary, now);
  }

  private rememberLiveFlightLookup(positions: PositionSample[], now: number): void {
    const incomingIdentities = new Set(positions.flatMap(SearchManager.adsbIdentities));
    this.liveFlightOverlay = this.liveFlightOverlay.filter((entry) => (
      entry.expiresAt > now
      && !SearchManager.adsbIdentities(entry.position).some((id) => incomingIdentities.has(id))
    ));
    for (const position of positions) {
      const expiresAt = SearchManager.flightObservationTime(position.observedAt, now, now)
        + FLIGHT_SEARCH_SOURCE_TTL_MS;
      if (expiresAt > now) this.liveFlightOverlay.push({ position, expiresAt });
    }
  }

  private pruneLiveFlightOverlay(now: number): PositionSample[] {
    this.liveFlightOverlay = this.liveFlightOverlay.filter((entry) => entry.expiresAt > now);
    return this.liveFlightOverlay.map((entry) => entry.position);
  }

  private async registerBaseSearchSource(): Promise<void> {
    const register = (bases: MilitaryBase[]) => {
      if (this.destroyed || !this.acceptLateBaseHydration) return;
      this.ctx.searchModal?.registerSource('base', bases.map(b => ({
        id: b.id,
        title: b.name,
        subtitle: `${b.type} ${b.description || ''}`.trim(),
        data: b,
      })));
    };

    const cached = getCachedMilitaryBases();
    if (cached.length > 0) {
      register(cached);
      return;
    }
    const hydration = Promise.resolve()
      .then(() => preloadMilitaryBases())
      .then(register);
    const completed = await SearchManager.waitWithTimeout(
      hydration,
      SearchManager.SEARCH_INDEX_READY_TIMEOUT_MS,
      'military-base-search-hydration',
    );
    if (!completed) this.acceptLateBaseHydration = false;
  }

  private static async waitWithTimeout(
    promise: Promise<unknown>,
    timeoutMs: number,
    label: string,
  ): Promise<boolean> {
    try {
      await withTimeout(promise, timeoutMs, label);
      return true;
    } catch {
      // Optional search enrichment must not block the dashboard search path.
      return false;
    }
  }

  private async waitForSearchIndexReady(): Promise<void> {
    await SearchManager.waitWithTimeout(
      this.searchIndexReady,
      SearchManager.SEARCH_INDEX_READY_TIMEOUT_MS,
      'search-index-ready',
    );
  }

  public async searchDashboard(
    query: string,
    scope: DashboardSearchScope,
    limit: number,
  ): Promise<DashboardSearchResponse> {
    return this.webMcpSearch.search(query, scope, limit);
  }

  public async openSearchResult(
    resultKey: string,
    waitForMapReady?: () => Promise<void>,
  ): Promise<DashboardSearchOpenResult> {
    return this.webMcpSearch.open(resultKey, waitForMapReady);
  }

  private observeSecurityContext(): void {
    this.webMcpSearch.observeSecurityContext();
  }

  private isSearchMatchExecutable(match: SearchMatch): boolean {
    if (match.kind === 'command') return this.isCommandExecutable(match.command);
    return this.isSearchResultExecutable(match.result);
  }

  /** Human CMD+K keeps its complete command deck; agent issuance is narrower. */
  private isModalCommandVisible(command: Command): boolean {
    const [category = '', action = ''] = command.id.split(':', 2);
    if (category === 'panel') {
      const panelId = action.split('@')[0];
      if (!panelId) return false;
      const effective = ALL_PANELS[panelId]
        ? getEffectivePanelConfig(panelId, SITE_VARIANT)
        : undefined;
      return !!effective && isPanelEntitled(
        panelId,
        effective,
        hasPremiumAccess(getAuthState()),
      );
    }
    if (category === 'layer') return this.isLayerCommandExecutable(action);
    if (category === 'layers') return this.hasVisibleLayerPreset(action);
    if (category === 'view' && action === 'resilience') {
      return this.isLayerCommandExecutable('resilienceScore');
    }
    if (category === 'country-map') return getCountryBbox(action) !== null;
    return ['nav', 'country', 'time', 'view'].includes(category);
  }

  private isCommandExecutable(command: Command): boolean {
    const [category, action = ''] = command.id.split(':', 2);
    switch (category) {
      case 'panel': {
        const panelId = action.split('@')[0];
        if (!panelId) return false;
        const config = this.ctx.panelSettings[panelId];
        if (!config) return false;
        const effective = ALL_PANELS[panelId]
          ? getEffectivePanelConfig(panelId, SITE_VARIANT)
          : undefined;
        const premium = hasPremiumAccess(getAuthState());
        if (!effective || !isPanelEntitled(panelId, effective, premium)) return false;
        if (config.enabled) return this.hasLivePanelTarget(panelId);
        if (premium) return true;
        return !isFreePanelCapCounted(panelId)
          || countFreePanelCapUsage(this.ctx.panelSettings) < FREE_MAX_PANELS;
      }
      case 'layer':
        return this.isLayerCommandExecutable(action);
      case 'layers':
        return this.hasExecutableLayerPreset(action);
      case 'nav':
      case 'country':
        return true;
      case 'time':
        return !(this.ctx.map?.isGlobeMode?.() ?? false);
      case 'country-map':
        return getCountryBbox(action) !== null;
      case 'view':
        if (action === 'resilience') return this.isLayerCommandExecutable('resilienceScore');
        // Settings/route-explorer emit their own content-bearing or account-
        // tier analytics, refresh tears down the capability response, and
        // fullscreen requires a transient user activation WebMCP cannot grant.
        // Keep those visible in CMD+K but out of agent-issued descriptors.
        return ['dark', 'light'].includes(action);
      default:
        return false;
    }
  }

  private hasLivePanelTarget(panelId: string): boolean {
    const panel = this.ctx.panels[panelId];
    if (panel?.getElement().isConnected) return true;
    // Deferred shells are live navigation targets: scrolling them into the
    // IntersectionObserver margin is what mounts the real panel in place.
    return [...document.querySelectorAll<HTMLElement>('[data-panel]')]
      .some((element) => element.dataset.panel === panelId);
  }

  private resolveExecutableNewsPanel(
    link: string,
  ): [string, AppContext['newsPanels'][string]] | null {
    for (const [panelId, panel] of Object.entries(this.ctx.newsPanels)) {
      if (
        this.ctx.panelSettings[panelId]?.enabled === true
        && this.hasLivePanelTarget(panelId)
        && panel.hasNewsItem(link)
      ) {
        return [panelId, panel];
      }
    }
    return null;
  }

  private isLayerCommandExecutable(layerKey: string): boolean {
    const key = (LAYER_KEY_MAP[layerKey] || layerKey) as keyof MapLayers;
    if (!(key in this.ctx.mapLayers)) return false;
    const allowed = getAllowedLayerKeys((SITE_VARIANT || 'full') as MapVariant);
    if (!allowed.has(key)) return false;
    const renderer: RendererKind = this.ctx.map?.isGlobeMode?.()
      ? 'globe'
      : (this.ctx.map?.isDeckGLActive?.() ? 'deck' : 'svg');
    return isLayerCommandAllowed(
      key,
      this.ctx.mapLayers[key],
      renderer,
      hasPremiumAccess(getAuthState()),
    );
  }

  private hasExecutableLayerPreset(action: string): boolean {
    if (action === 'none') return true;
    if (action === 'all') {
      return Object.keys(this.ctx.mapLayers).some((key) => this.isLayerCommandExecutable(key));
    }
    const primaryLayers = LAYER_PRESET_PRIMARY_LAYERS[action];
    if (!primaryLayers) return false;
    // Minimal promises both of its named layers. Larger presets may contain
    // contextual extras (for example waterways in military); require at least
    // one defining layer so an incidental overlap cannot advertise the preset.
    if (action === 'minimal') {
      return primaryLayers.every((key) => this.isLayerCommandExecutable(key));
    }
    return primaryLayers.some((key) => this.isLayerCommandExecutable(key));
  }

  private hasVisibleLayerPreset(action: string): boolean {
    if (action === 'none') return true;
    if (action === 'all') {
      return Object.keys(this.ctx.mapLayers).some((key) => this.isLayerCommandExecutable(key));
    }
    return (LAYER_PRESETS[action] ?? []).some((key) => this.isLayerCommandExecutable(key));
  }

  private isSearchResultExecutable(result: SearchResult): boolean {
    if (!this.isSearchResultVisible(result)) return false;
    const requiredLayer = this.resultRequiredLayer(result);
    if (requiredLayer && !this.isEntityLayerExecutable(requiredLayer)) return false;
    if (
      this.ctx.map?.isGlobeMode?.()
      && (
        requiredLayer === 'flights'
        || [
          'hotspot', 'conflict', 'base', 'pipeline', 'cable', 'datacenter', 'nuclear', 'irradiator',
          'techcompany', 'ailab', 'startup', 'techevent', 'techhq', 'accelerator',
          'exchange', 'financialcenter', 'centralbank', 'commodityhub',
        ]
          .includes(result.type)
      )
    ) return false;
    switch (result.type) {
      case 'news':
        return this.resolveExecutableNewsPanel((result.data as NewsItem).link) !== null;
      case 'market':
        return this.ctx.panelSettings.markets?.enabled === true
          && this.hasLivePanelTarget('markets');
      case 'prediction':
        return this.ctx.panelSettings.polymarket?.enabled === true
          && this.hasLivePanelTarget('polymarket');
      case 'flight':
        return hasPremiumAccess(getAuthState());
      default:
        return true;
    }
  }

  private isSearchResultVisible(result: SearchResult): boolean {
    if (result.type === 'flight' && !hasPremiumAccess(getAuthState())) return false;
    const requiredLayer = this.resultRequiredLayer(result);
    if (!requiredLayer) return true;
    return getAllowedLayerKeys((SITE_VARIANT || 'full') as MapVariant).has(requiredLayer);
  }

  private isEntityLayerExecutable(layer: keyof MapLayers): boolean {
    const allowed = getAllowedLayerKeys((SITE_VARIANT || 'full') as MapVariant);
    if (!allowed.has(layer)) return false;
    const renderer: RendererKind = this.ctx.map?.isGlobeMode?.()
      ? 'globe'
      : (this.ctx.map?.isDeckGLActive?.() ? 'deck' : 'svg');
    return isLayerExecutable(
      layer,
      renderer,
    ) && isLayerEntitled(layer, hasPremiumAccess(getAuthState()));
  }

  private resultRequiredLayer(result: SearchResult): keyof MapLayers | null {
    switch (result.type) {
      case 'hotspot': return 'hotspots';
      case 'conflict': return 'conflicts';
      case 'base': return 'bases';
      case 'pipeline': return 'pipelines';
      case 'cable': return 'cables';
      case 'datacenter': return 'datacenters';
      case 'nuclear': return 'nuclear';
      case 'irradiator': return 'irradiators';
      case 'earthquake': return 'natural';
      case 'outage': return 'outages';
      case 'techcompany':
      case 'techhq': return 'techHQs';
      case 'startup': return 'startupHubs';
      case 'techevent': return 'techEvents';
      case 'accelerator': return 'accelerators';
      case 'exchange': return 'stockExchanges';
      case 'financialcenter': return 'financialCenters';
      case 'centralbank': return 'centralBanks';
      case 'commodityhub': return 'commodityHubs';
      case 'flight': {
        const layer = (result.data as { layer?: unknown }).layer;
        return layer === 'military' ? 'military' : 'flights';
      }
      default: return null;
    }
  }

  updateFlightSource(
    adsb: PositionSample[],
    military: MilitaryFlight[],
    adsbUpdatedAt = Date.now(),
  ): void {
    if (this.destroyed) return;
    this.latestAdsb = [...adsb];
    this.latestMilitary = [...military];
    this.latestAdsbUpdatedAt = adsbUpdatedAt;
    if (!this.ctx.searchModal) return;
    if (!hasPremiumAccess(getAuthState())) {
      this.flightSearchItems = [];
      this.flightSourceExpiresAt = 0;
      this.liveFlightOverlay = [];
      this.ctx.searchModal.registerSource('flight', []);
      return;
    }
    const now = Date.now();
    const mergedAdsb = this.mergeLiveAdsb(adsb, this.pruneLiveFlightOverlay(now));
    this.flightSearchItems = SearchManager.buildFlightSearchItems(
      mergedAdsb,
      military,
      adsbUpdatedAt,
      now,
    );
    this.publishCurrentFlightSearchItems(now);
  }

  private publishCurrentFlightSearchItems(
    now: number,
    options?: { updateVisibleMetrics?: boolean },
  ): void {
    this.flightSearchItems = this.flightSearchItems.filter((item) => item.expiresAt > now);
    this.flightSourceExpiresAt = this.flightSearchItems.length > 0
      ? Math.min(...this.flightSearchItems.map((item) => item.expiresAt))
      : 0;
    this.ctx.searchModal?.registerSource('flight', this.flightSearchItems.map((item) => ({
      id: item.id,
      title: item.title,
      subtitle: item.subtitle,
      data: item.data,
    })), options);
  }

  updateSearchIndex(options?: { updateVisibleMetrics?: boolean }): void {
    if (!this.ctx.searchModal) return;

    const sourceOptions = { updateVisibleMetrics: options?.updateVisibleMetrics !== false };
    if (this.flightSourceExpiresAt > 0 && Date.now() >= this.flightSourceExpiresAt) {
      this.publishCurrentFlightSearchItems(Date.now(), sourceOptions);
    }
    this.syncPanelSearchIndex(sourceOptions);
    this.ctx.searchModal.registerSource('country', this.buildCountrySearchItems(), sourceOptions);

    const newsItems = this.ctx.allNews.slice(0, 500).map(n => ({
      id: n.link,
      title: n.title,
      subtitle: n.source,
      data: n,
    }));
    console.log(`[Search] Indexing ${newsItems.length} news items (allNews total: ${this.ctx.allNews.length})`);
    this.ctx.searchModal.registerSource('news', newsItems, sourceOptions);

    this.ctx.searchModal.registerSource('prediction', this.ctx.latestPredictions.map(p => ({
      id: p.title,
      title: p.title,
      subtitle: `${Math.round(p.yesPrice)}% probability`,
      data: p,
    })), sourceOptions);

    this.ctx.searchModal.registerSource('market', this.ctx.latestMarkets.map(m => ({
      id: m.symbol,
      title: `${m.symbol} - ${m.name}`,
      subtitle: `$${m.price?.toFixed(2) || 'N/A'}`,
      data: m,
    })), sourceOptions);

    if (SITE_VARIANT === 'tech') {
      this.ctx.searchModal.registerSource('techevent', this.ctx.latestTechEvents.map((e) => ({
        id: e.id,
        title: e.title,
        subtitle: `${e.location} • ${new Date(e.startDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
        data: e,
      })), sourceOptions);
    }
  }

  /**
   * Feeds CMD+K two panel sets: `active` (currently enabled) and `available`
   * (every entitled panel the user could cross-enable on this variant — all
   * of ALL_PANELS merge into panelSettings per App.ts). The modal surfaces
   * available-but-disabled panels with an "Add" affordance; selecting one
   * routes through enablePanel(). Without the available set, search could
   * only jump to panels already on screen — the core discoverability gap.
   */
  private syncPanelSearchIndex(options?: { updateVisibleMetrics?: boolean }): void {
    if (!this.ctx.searchModal) return;
    const hasPremium = hasPremiumAccess(getAuthState());
    this.ctx.searchModal.setActivePanels(
      Object.entries(this.ctx.panelSettings).filter(([, v]) => v.enabled).map(([k]) => k),
      options,
    );
    this.ctx.searchModal.setAvailablePanels(
      Object.keys(this.ctx.panelSettings).filter((k) => {
        // Keep unregistered/dynamic keys out of search; the resolver would
        // otherwise return a disabled synthetic fallback for unknown keys.
        const cfg = ALL_PANELS[k] ? getEffectivePanelConfig(k, SITE_VARIANT) : undefined;
        return cfg ? isPanelEntitled(k, cfg, hasPremium) : false;
      }),
      options,
    );
  }

  private buildCountrySearchItems(): { id: string; title: string; subtitle: string; data: { code: string; name: string } }[] {
    const cachedScores = getCachedCountryScores();
    const panelScores = (this.ctx.panels.cii as CIIPanel | undefined)?.getScores() ?? [];
    const scores = cachedScores.length > 0
      ? cachedScores
      : panelScores;
    const ciiByCode = new Map(scores.map((score) => [score.code, score]));
    return Object.entries(TIER1_COUNTRIES).map(([code, name]) => {
      const score = ciiByCode.get(code);
      return {
        id: code,
        title: `${CountryIntelManager.toFlagEmoji(code)} ${name}`,
        subtitle: score ? `CII: ${score.score}/100 • ${score.level}` : 'Country Brief',
        data: { code, name },
      };
    });
  }
}
