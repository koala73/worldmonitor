import { COUNTRY_ACTIVITY_BOUNDS, isCountryActivityCoordinate, projectCountryMilitaryActivity, projectCountryMilitarySignalCounts } from '@/services/country-military-activity';
import { CountryBriefController, projectChinaCountrySummary } from '@/components/CountryBriefController';
import { createWebsiteCountryBriefSource } from '@/services/country-brief-source';
import { hasTemporalBaselineSnapshot } from '@/services/temporal-baseline';
import type { AppContext, AppModule, CountryBriefSignals } from '@/app/app-context';
import type { CountrySignalCounts } from '@/types';
import { getSignalAggregator } from '@/app/lazy-services';
import type { CountrySignalCluster } from '@/services/signal-aggregator';
import { premiumFetch } from '@/services/premium-fetch';
import { CountryTimeline } from '@/components/CountryTimeline';
import type {
  CountryDeepDiveEconomicIndicator,
  CountryDeepDiveMilitarySummary,
  CountryDeepDiveSignalDetails,
  ChinaCountrySummaryData,
} from '@/components/CountryBriefPanel';
import { reverseGeocode } from '@/utils/reverse-geocode';
import { yieldToMain } from '@/utils/after-paint';
import { effectivePubDateMs } from '@/services/feed-date';
import type { CountryCoverageEvent } from '@/services/country-coverage';
import { reconcileCountryTimelineIncidents } from '../../shared/country-timeline-events';
import { projectCountrySignalDetails } from '../../shared/country-signal-details';
import {
  COUNTRY_ALIASES,
  countryTermIndex,
  escapeRegExp,
  firstMentionPosition,
  getCountrySearchTerms,
  getOtherCountryTerms,
  isCountryHeadline,
} from '../../shared/country-headline-match';
import {
  canonicalizeCountryCode,
  getCountryAtCoordinates,
  getCountryCentroid,
  hasCountryGeometry,
  ME_STRIKE_BOUNDS,
  preloadCountryGeometry,
} from '@/services/country-geometry';
import { getCountryData, TIER1_COUNTRIES, type CountryScore } from '@/services/country-instability';
import { getCachedCountryScore, normalizeCiiCountryCode } from '@/services/cached-risk-scores';
import { dataFreshness } from '@/services/data-freshness';
import { collectStoryData } from '@/services/story-data';
// StoryModal is lazy-imported at its call site (below), and its render path
// lazy-imports story-renderer, so both stay off the eager boot graph.
// renderStoryToCanvas was already made dynamic in #4486; #4571 closes the
// remaining StoryModal eager edge. The modal opens on user interaction
// (post-paint), so the import() latency is hidden.

import { hasPremiumAccess } from '@/services/panel-gating';
import { getAuthState, subscribeAuthState } from '@/services/auth-state';
import { onEntitlementChange } from '@/services/entitlements';
import { showMapContextMenu } from '@/components/MapContextMenu';
import { BETA_MODE } from '@/config/beta';
import { mlWorker } from '@/services/ml-worker';
import { isHeadlineMemoryEnabled } from '@/services/ai-flow-settings';
import { t, getCurrentLanguage } from '@/services/i18n';
import { trackCountrySelected, trackCountryBriefOpened } from '@/services/analytics';
import { toApiUrl } from '@/services/runtime';
import { raceWebMcpAbort, throwIfWebMcpAborted } from '@/services/webmcp';
import type { StrategicPosturePanel } from '@/components/StrategicPosturePanel';
import type { NewsItem } from '@/types';
import {
  buildBriefSourceContextLines,
  collectBriefSources,
  type BriefSource,
} from '@/utils/brief-sources';
import type { IntelBriefEvidence } from '@/utils/format-intel-brief';
import { preloadInfrastructureTables } from '@/services/related-assets';
import { preloadMilitaryBases } from '@/services/military-base-config';
import { toFlagEmoji } from '@/utils/country-flag';
import { buildDependencyGraph } from '@/services/infrastructure-cascade';
import { getActiveFrameworkForPanel, subscribeFrameworkChange } from '@/services/analysis-framework-store';
import { buildImfEconomicIndicators, type ImfCountryBundle } from '@/services/imf-country-data';
import { getChinaDecisionSignalsData } from '@/services/china-decision-signals';
import { CHINA_DECISION_SIGNAL_GROUP_IDS } from '../../shared/china-decision-signals';
import { showToast as showGlobalToast } from '@/utils/toast';
import { vesselTypeLabel } from '@/utils/vessel-type-label';

// Iran-events domain sunset (war ended 2026-07). Default OFF: no strikes in the
// country deep-dive or the AI brief. Set VITE_ENABLE_IRAN_ATTACKS=true to restore.
// Guarded with the client-runtime check so node:test never dereferences import.meta.env.
const IRAN_ATTACKS_ENABLED = typeof window !== 'undefined' && import.meta.env.VITE_ENABLE_IRAN_ATTACKS === 'true';

type MilitarySignalField = 'militaryFlights' | 'militaryVessels' | 'militaryFlightsInCountry' | 'militaryVesselsInCountry';
type WebsiteCountrySignals = Omit<CountryBriefSignals, MilitarySignalField> & Pick<CountrySignalCounts, MilitarySignalField>;

type IntlDisplayNamesCtor = new (
  locales: string | string[],
  options: { type: 'region' }
) => { of: (code: string) => string | undefined };

type CountryStockSnapshot = {
  available: boolean;
  code: string;
  symbol: string;
  indexName: string;
  price: string;
  weekChangePercent: string;
  currency: string;
  fetchedAt: string;
};

type CountryIntelBriefResult = {
  brief: string;
  sources: BriefSource[];
  evidence: IntelBriefEvidence[];
  generatedAt?: string | number;
  cached?: boolean;
};

type PendingCountryBriefRequest = {
  token: number;
  owner: 'human' | 'agent';
};

type CountryBriefOpenOptions = {
  maximize?: boolean;
  trackAnalytics?: boolean;
  /** Acknowledges that the requested country page is visibly presented. */
  onPresented?: () => void;
  /** Cancels an agent-owned open before it presents visible UI. */
  signal?: AbortSignal;
  /**
   * Who initiated this open, for request arbitration only. An agent open never
   * evicts a pending human one (see claimBriefRequest). Callers that omit it
   * fall back to the AbortSignal heuristic, which no longer holds on its own:
   * no shipping browser supplies a target-side signal to WebMCP tools, so an
   * agent path without a signal must state its ownership explicitly.
   */
  owner?: 'agent' | 'human';
};

export class CountryIntelManager implements AppModule {
  private ctx: AppContext;
  private briefRequestToken = 0;
  private pendingBriefRequest: PendingCountryBriefRequest | null = null;
  private visibleBriefOwner: PendingCountryBriefRequest['owner'] | null = null;
  private frameworkUnsubscribe: (() => void) | null = null;
  private _fwDebounce: ReturnType<typeof setTimeout> | null = null;
  // Re-fire PRO-gated country sections on false→true entitlement transition.
  // Without this, a user who opens a country brief before Clerk resolves
  // keeps seeing empty national-debt / sanctions / comtrade / tariff cards
  // until they reselect the country or reload. Tracks the last-seen
  // entitlement so unrelated auth events (session refresh, prefs sync)
  // don't re-hammer fetchProSections.
  private authUnsubscribe: (() => void) | null = null;
  private entitlementUnsubscribe: (() => void) | null = null;
  private lastHadPremium = false;
  private countryController: CountryBriefController | null = null;
  private countryControllerPage: AppContext['countryBriefPage'] = null;
  private countryBriefPageLoading: Promise<boolean> | null = null;
  private currentCoverageEvents: CountryCoverageEvent[] = [];
  private coverageAbortController: AbortController | null = null;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  async init(): Promise<void> {
    await this.setupCountryIntel();
    this.frameworkUnsubscribe = subscribeFrameworkChange('country-brief', () => {
      const page = this.ctx.countryBriefPage;
      if (!page?.isVisible()) return;
      const code = page.getCode();
      const name = page.getName() ?? code;
      if (!code || !name) return;
      if (this._fwDebounce) clearTimeout(this._fwDebounce);
      this._fwDebounce = setTimeout(() => {
        void this.openCountryBriefByCode(code, name).catch((err) => this.handleCountryBriefOpenError(err));
      }, 400);
    });

    this.lastHadPremium = hasPremiumAccess(getAuthState());
    const syncPremiumAccess = () => this.handlePremiumAccessTransition(hasPremiumAccess(getAuthState()));
    this.authUnsubscribe = subscribeAuthState(syncPremiumAccess);
    this.entitlementUnsubscribe = onEntitlementChange(syncPremiumAccess);
  }

  destroy(): void {
    this.briefRequestToken++;
    this.countryController?.dispose();
    this.countryController = null;
    // Drop the handle without aborting in-flight body reads. WebKit rejects
    // those as unhandled `AbortError: Fetch is aborted` on panel teardown
    // (WORLDMONITOR-132) even when the coverage promise chain catches AbortError.
    this.coverageAbortController = null;
    this.pendingBriefRequest = null;
    if (this._fwDebounce) { clearTimeout(this._fwDebounce); this._fwDebounce = null; }
    this.ctx.countryTimeline?.destroy();
    this.ctx.countryTimeline = null;
    this.ctx.countryBriefPage = null;
    this.countryBriefPageLoading = null;
    this.frameworkUnsubscribe?.();
    this.frameworkUnsubscribe = null;
    this.authUnsubscribe?.();
    this.authUnsubscribe = null;
    this.entitlementUnsubscribe?.();
    this.entitlementUnsubscribe = null;
  }

  private handlePremiumAccessTransition(nowPremium: boolean): void {
    if (nowPremium === this.lastHadPremium) return;
    this.lastHadPremium = nowPremium;

    const page = this.ctx.countryBriefPage;
    const openCode = page?.getCode();
    if (!page?.isVisible() || !openCode || openCode === '__loading__' || openCode === '__error__') return;

    page.syncCountryPremiumSectionsAccess?.(nowPremium);
    this.getCountryController(page).refreshPremium();
  }

  private handleCountryBriefOpenError(err: unknown): void {
    console.error('[CountryBrief] Failed to open country brief:', err);
    this.ctx.map?.setRenderPaused(false);
    this.showToast('Country brief failed to open. Please try again.');
  }

  private claimBriefRequest(owner: PendingCountryBriefRequest['owner']): PendingCountryBriefRequest | null {
    const pendingRequest = this.pendingBriefRequest;
    if (
      owner === 'agent'
      && (
        (
          pendingRequest?.owner === 'human'
          && pendingRequest.token === this.briefRequestToken
        )
        || (
          this.visibleBriefOwner === 'human'
          && this.hasVisibleRealCountryBrief()
        )
      )
    ) {
      return null;
    }
    const request = { token: ++this.briefRequestToken, owner };
    this.abortCountryCoverage();
    this.pendingBriefRequest = request;
    return request;
  }

  private abortCountryCoverage(): void {
    this.coverageAbortController?.abort();
    this.coverageAbortController = null;
  }

  private startCountryCoverageRequest(): AbortSignal {
    this.abortCountryCoverage();
    const controller = new AbortController();
    this.coverageAbortController = controller;
    return controller.signal;
  }

  private clearBriefRequest(request: PendingCountryBriefRequest): void {
    if (this.pendingBriefRequest === request) this.pendingBriefRequest = null;
  }

  private isCurrentBriefRequest(request: PendingCountryBriefRequest): boolean {
    return request.token === this.briefRequestToken;
  }

  private async setupCountryIntel(): Promise<void> {
    if (!this.ctx.map) return;
    this.ctx.map.onCountryClicked((countryClick) => {
      if (countryClick.code && countryClick.name) {
        trackCountrySelected(countryClick.code, countryClick.name, 'map');
        void this.openCountryBriefByCode(countryClick.code, countryClick.name)
          .catch((err) => this.handleCountryBriefOpenError(err));
      } else {
        void this.openCountryBrief(countryClick.lat, countryClick.lon)
          .catch((err) => this.handleCountryBriefOpenError(err));
      }
    });

    this.ctx.map.onMapContextMenu((payload) => {
      const items = [];
      if (payload.countryCode && payload.countryName) {
        items.push({
          label: t('contextMenu.openCountryBrief'),
          action: () => {
            void this.openCountryBriefByCode(payload.countryCode!, payload.countryName!)
              .catch((err) => this.handleCountryBriefOpenError(err));
          },
        });
      } else {
        items.push({
          label: t('contextMenu.openCountryBrief'),
          action: () => {
            void this.openCountryBrief(payload.lat, payload.lon)
              .catch((err) => this.handleCountryBriefOpenError(err));
          },
        });
      }
      items.push({ label: t('contextMenu.copyCoordinates'), action: () => navigator.clipboard.writeText(`${payload.lat.toFixed(5)}, ${payload.lon.toFixed(5)}`).catch(() => {}) });
      showMapContextMenu(payload.screenX, payload.screenY, items);
    });
  }

  private getCountryController(page: NonNullable<AppContext['countryBriefPage']>): CountryBriefController {
    if (!this.countryController || this.countryControllerPage !== page) {
      this.countryController?.dispose();
      this.countryController = new CountryBriefController(createWebsiteCountryBriefSource(), page);
      this.countryControllerPage = page;
    }
    return this.countryController;
  }

  private async ensureCountryBriefPage(): Promise<boolean> {
    if (this.ctx.countryBriefPage) return true;
    if (!this.ctx.map || this.ctx.isDestroyed) return false;
    if (this.countryBriefPageLoading) return this.countryBriefPageLoading;
    const loading = this.createCountryBriefPage();
    this.countryBriefPageLoading = loading;
    try {
      return await loading;
    } finally {
      if (this.countryBriefPageLoading === loading) this.countryBriefPageLoading = null;
    }
  }

  private async createCountryBriefPage(): Promise<boolean> {
    const { CountryDeepDivePanel } = await import('@/components/CountryDeepDivePanel');
    if (this.ctx.isDestroyed || !this.ctx.map) return false;
    this.ctx.countryBriefPage = new CountryDeepDivePanel(this.ctx.map);
    this.getCountryController(this.ctx.countryBriefPage);

    this.ctx.countryBriefPage.onClose(() => {
      this.briefRequestToken++;
      this.countryController?.dispose();
      // Keep the controller for the next open to cancel; closing must not
      // interrupt WebKit body reads.
      this.ctx.map?.clearCountryHighlight();
      this.ctx.map?.setRenderPaused(false);
      this.ctx.countryTimeline?.destroy();
      this.ctx.countryTimeline = null;
    });
    return true;
  }

  async openCountryBrief(lat: number, lon: number): Promise<void> {
    const request = this.claimBriefRequest('human');
    if (!request) return;
    try {
      if (!(await this.ensureCountryBriefPage())) return;
      if (!this.isCurrentBriefRequest(request) || this.ctx.isDestroyed) return;
      const page = this.ctx.countryBriefPage;
      if (!page) return;
      page.showLoading();
      this.ctx.map?.setRenderPaused(true);

      const localGeo = getCountryAtCoordinates(lat, lon);
      if (localGeo) {
        if (!this.isCurrentBriefRequest(request)) return;
        await this.openCountryBriefByCodeForRequest(localGeo.code, localGeo.name, undefined, request, true);
        return;
      }

      const geo = await reverseGeocode(lat, lon);
      if (!this.isCurrentBriefRequest(request)) return;
      if (!geo) {
        page.hide();
        this.ctx.map?.setRenderPaused(false);
        return;
      }

      await this.openCountryBriefByCodeForRequest(geo.code, geo.country, undefined, request, true);
    } finally {
      this.clearBriefRequest(request);
    }
  }

  async openCountryBriefByCode(
    code: string,
    country: string,
    opts?: CountryBriefOpenOptions,
  ): Promise<void> {
    throwIfWebMcpAborted(opts?.signal);
    const requestOwner = opts?.owner ?? (opts?.signal ? 'agent' : 'human');
    const request = this.claimBriefRequest(requestOwner);
    if (!request) return;
    await this.openCountryBriefByCodeForRequest(code, country, opts, request);
  }

  private async openCountryBriefByCodeForRequest(
    code: string,
    country: string,
    opts: CountryBriefOpenOptions | undefined,
    request: PendingCountryBriefRequest,
    loadingAlreadyShown = false,
  ): Promise<void> {
    const token = request.token;
    let pageShown = false;
    let showedLoading = loadingAlreadyShown;

    try {
      throwIfWebMcpAborted(opts?.signal);
      if (!(await this.ensureCountryBriefPage())) return;
      throwIfWebMcpAborted(opts?.signal);
      if (token !== this.briefRequestToken || this.ctx.isDestroyed) return;
      const page = this.ctx.countryBriefPage;
      if (!page) return;
      // Map GeoJSON can still stamp Taiwan as CN-TW; APIs require ISO alpha-2.
      code = canonicalizeCountryCode(code);
      const hasVisibleBrief = this.hasVisibleRealCountryBrief();
      // An agent open must not replace visible state while it works. Ownership
      // is explicit because shipping WebMCP browsers omit the target signal.
      const preserveVisibleBrief = request.owner === 'agent' && hasVisibleBrief;
      if (!preserveVisibleBrief && (!hasVisibleBrief || page.getCode() !== code)) {
        if (!showedLoading) page.showLoading();
        showedLoading = true;
      }
      if (!loadingAlreadyShown) this.ctx.map?.setRenderPaused(true);
      if (opts?.trackAnalytics !== false) trackCountryBriefOpened(code);

      const canonicalName = TIER1_COUNTRIES[code] || CountryIntelManager.resolveCountryName(code);
      if (canonicalName !== code) country = canonicalName;
      const isChina = code.toUpperCase() === 'CN';

      const scoreCode = normalizeCiiCountryCode(code);
      const score = getCachedCountryScore(scoreCode);

      let signals = await raceWebMcpAbort(
        this.getCountrySignals(code, country),
        opts?.signal,
      );
      throwIfWebMcpAborted(opts?.signal);
      if (token !== this.briefRequestToken || this.ctx.isDestroyed || this.ctx.countryBriefPage !== page) return;

      page.show(country, code, score, signals);
      this.currentCoverageEvents = [];
      pageShown = true;
      this.visibleBriefOwner = request.owner;
      this.clearBriefRequest(request);
      // Agent selection needs to acknowledge the visible UI transition, not
      // wait for the slower background intelligence/LLM enrichment below.
      // Keep the callback observational so a consumer cannot break the human
      // country-open path by throwing from its acknowledgement handler.
      try {
        opts?.onPresented?.();
      } catch {
        // The page is already visible; enrichment should continue normally.
      }
      const updateChinaSummary = (data: ChinaCountrySummaryData): void => {
        if (!isChina || token !== this.briefRequestToken || this.ctx.countryBriefPage?.getCode()?.toUpperCase() !== 'CN') return;
        this.ctx.countryBriefPage.updateChinaCountrySummary?.(data);
      };
      if (isChina) {
        getChinaDecisionSignalsData().then((snapshot) => {
          if (
            token !== this.briefRequestToken
            || this.ctx.countryBriefPage?.getCode()?.toUpperCase() !== 'CN'
          ) return;
          updateChinaSummary(projectChinaCountrySummary(snapshot));
        }).catch(() => {
          updateChinaSummary({
            groups: CHINA_DECISION_SIGNAL_GROUP_IDS.map((id) => ({
              id,
              state: 'unavailable',
              signals: [],
              unavailableReason: t('countryBrief.china.decisionSignalsUnavailable'),
            })),
          });
        });

      }
      // Yield so the deep-dive panel paint lands before the map catch-up
      // (highlightCountry deck rebuild + fitCountry fitBounds animation) — country
      // click is the field #1 INP offender, presentation-delay-dominated (#4617).
      // Re-check the staleness guard after the new async gap so a newer country
      // open can't be painted over by this one.
      await yieldToMain();
      if (token !== this.briefRequestToken || this.ctx.isDestroyed || this.ctx.countryBriefPage !== page) return;
      this.ctx.map?.highlightCountry(code);
      this.ctx.map?.fitCountry(code);

      if (opts?.maximize) {
        requestAnimationFrame(() => {
          const panel = this.ctx.countryBriefPage;
          if (panel?.isVisible() && panel.getCode() === code) {
            panel.maximize?.();
          }
        });
      }
      try {
        const signalDetails = await this.buildSignalDetails(code);
        if (token === this.briefRequestToken && this.ctx.countryBriefPage?.getCode() === code) {
          page.updateSignalDetails?.(signalDetails);
        }
      } catch (err) {
        console.warn('[CountryBrief] signal details unavailable:', err);
      }
      if (token !== this.briefRequestToken || this.ctx.countryBriefPage?.getCode() !== code) return;
      const militarySummary = this.buildMilitarySummary(code, country);
      page.updateMilitaryActivity?.(militarySummary);
      page.updateSignals?.(signals, militarySummary.coverageNotes);
      page.updateEconomicIndicators?.(this.buildEconomicIndicators(code, score, null));

      let latestStock: CountryStockSnapshot | null = null;
      let latestImf: ImfCountryBundle | null = null;
      const { stockPromise } = this.getCountryController(page).hydrate(code, country, {
        stock: stock => {
          latestStock = stock;
          page.updateEconomicIndicators?.(this.buildEconomicIndicators(code, score, stock, latestImf));
        },
        imf: bundle => {
          latestImf = bundle;
          page.updateEconomicIndicators?.(this.buildEconomicIndicators(code, score, latestStock, bundle));
        },
      });

      const filteredNews = this.ctx.allNews.filter((item) => (
        CountryIntelManager.isCountryHeadline(item.title, country, code)
      )).sort((a, b) => {
        const severityDelta = this.newsSeverityRank(b) - this.newsSeverityRank(a);
        if (severityDelta !== 0) return severityDelta;
        return effectivePubDateMs(b) - effectivePubDateMs(a);
      });
      page.updateNews(filteredNews);
      const countrySearchTerms = CountryIntelManager.getCountrySearchTerms(country, code);
      const hasCountryTerm = (headline: string): boolean => (
        CountryIntelManager.firstMentionPosition(headline, countrySearchTerms) !== Infinity
      );
      const coverageSignal = this.startCountryCoverageRequest();
      void import('@/services/country-coverage')
        .then(({ fetchCountryCoverage }) => fetchCountryCoverage(country, countrySearchTerms, { signal: coverageSignal }))
        .then((coverage) => {
          if (
            coverageSignal.aborted
            || token !== this.briefRequestToken
            || this.ctx.countryBriefPage?.getCode() !== code
          ) return;
          const countryHeadlines = coverage.headlines.filter(item => (
            CountryIntelManager.isCountryHeadline(item.title, country, code)
          ));
          if (countryHeadlines.length > 0) page.updateNews(countryHeadlines);
          this.currentCoverageEvents = coverage.timelineEvents.filter(event => hasCountryTerm(event.label));
          this.mountCountryTimeline(code, country, this.currentCoverageEvents);
        })
        .catch((error) => {
          if (
            coverageSignal.aborted
            || (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError')
          ) return;
          console.warn('[CountryBrief] country coverage fetch failed:', error);
        });

      if (getCountryCentroid(code, ME_STRIKE_BOUNDS)) page.updateInfrastructure(code);
      void Promise.all([
        preloadCountryGeometry(),
        preloadMilitaryBases().catch(() => []),
        preloadInfrastructureTables().catch(() => {}),
      ])
        .then(() => {
          if (this.ctx.countryBriefPage?.getCode() === code) {
            this.ctx.countryBriefPage.updateInfrastructure(code);
            this.ctx.countryBriefPage.updateMilitaryActivity?.(this.buildMilitarySummary(code, country));
          }
        })
        .catch(() => {});

      this.mountCountryTimeline(code, country);

      try {
        const context: Record<string, unknown> = {};
        if (score) {
          context.score = score.score;
          context.level = score.level;
          context.trend = score.trend;
          context.components = score.components;
          context.change24h = score.change24h;
        }
        Object.assign(context, signals);

        const aggregator = await getSignalAggregator();
        if (token !== this.briefRequestToken || this.ctx.countryBriefPage?.getCode() !== code) return;
        const countryCluster = aggregator.getCountryClusters().find((c) => c.country === code);
        if (countryCluster) {
          context.convergenceScore = countryCluster.convergenceScore;
          context.signalTypes = [...countryCluster.signalTypes];
        }

        const convergences = aggregator.getRegionalConvergence()
          .filter((r) => r.countries.includes(code));
        if (convergences.length) {
          context.regionalConvergence = convergences.map((r) => r.description);
        }

        if (this.ctx.intelligenceCache.advisories) {
          const countryAdvisories = this.ctx.intelligenceCache.advisories.filter(a => a.country === code);
          if (countryAdvisories.length > 0) {
            context.travelAdvisories = countryAdvisories.map(a => ({ source: a.source, level: a.level, title: a.title }));
          }
        }

        const groundingNews = filteredNews.slice(0, 15);
        let briefSources = collectBriefSources(groundingNews, 6);
        const headlines = groundingNews.map((n) => n.title);
        if (headlines.length) context.headlines = headlines;
        if (briefSources.length) context.briefSources = briefSources;
        const briefHeadlines = (context.headlines as string[] | undefined) || [];

        const stockData = await stockPromise;
        if (token !== this.briefRequestToken || this.ctx.countryBriefPage?.getCode() !== code) return;
        if (stockData?.available) {
          const pct = parseFloat(stockData.weekChangePercent);
          context.stockIndex = `${stockData.indexName}: ${stockData.price} (${pct >= 0 ? '+' : ''}${stockData.weekChangePercent}% week)`;
        }

        let briefText = '';
        let briefResult: CountryIntelBriefResult | null = null;
        try {
          // Temporal feed can arrive after the initial signal snapshot; re-read
          // so chips, prompt, and fallback lines share one fresh observation set.
          signals = await this.getCountrySignals(code, country);
          if (token !== this.briefRequestToken || this.ctx.countryBriefPage?.getCode() !== code) return;
          Object.assign(context, signals);
          this.ctx.countryBriefPage?.updateScore?.(score, signals);

          let contextSnapshot = this.buildBriefContextSnapshot(country, code, score, signals, context);

          if (isHeadlineMemoryEnabled() && mlWorker.isAvailable && mlWorker.isModelLoaded('embeddings') && briefHeadlines.length > 0) {
            try {
              const results = await mlWorker.vectorStoreSearch(briefHeadlines.slice(0, 3), 5, 0.3);
              if (token !== this.briefRequestToken || this.ctx.countryBriefPage?.getCode() !== code) return;
              if (results.length > 0) {
                const historical = results.map(r =>
                  `- ${r.text} (${new Date(r.pubDate).toISOString().slice(0, 10)})`
                ).join('\n').slice(0, 350);
                contextSnapshot = contextSnapshot.slice(0, 1800)
                  + `\n[BEGIN HISTORICAL DATA]\n${historical}\n[END HISTORICAL DATA]`;
              }
            } catch { /* RAG unavailable */ }
          }

          const countryFw = getActiveFrameworkForPanel('country-brief');
          briefResult = await this.fetchCountryIntelBrief(code, contextSnapshot, countryFw?.systemPromptAppend ?? '');
          if (token !== this.briefRequestToken || this.ctx.countryBriefPage?.getCode() !== code) return;
          briefText = briefResult.brief;
          if (briefResult.sources.length > 0) {
            briefSources = briefResult.sources;
          }
        } catch { /* server unreachable */ }

        if (briefText) {
          this.ctx.countryBriefPage?.updateBrief({
            brief: briefText,
            country,
            code,
            sources: briefSources,
            evidence: briefResult?.evidence,
            generatedAt: briefResult?.generatedAt,
            cached: briefResult?.cached,
          });
        } else {
          let fallbackBrief = '';
          const sumModelId = BETA_MODE ? 'summarization-beta' : 'summarization';
          if (briefHeadlines.length >= 2 && mlWorker.isAvailable && mlWorker.isModelLoaded(sumModelId)) {
            try {
              const lang = getCurrentLanguage();
              const prompt = lang === 'fr'
                ? `Résumez la situation actuelle en ${country} à partir de ces titres : ${briefHeadlines.slice(0, 8).join('. ')}`
                : `Summarize the current situation in ${country} based on these headlines: ${briefHeadlines.slice(0, 8).join('. ')}`;

              const [summary] = await mlWorker.summarize([prompt], BETA_MODE ? 'summarization-beta' : undefined);
              if (token !== this.briefRequestToken || this.ctx.countryBriefPage?.getCode() !== code) return;
              if (summary && summary.length > 20) fallbackBrief = summary;
            } catch { /* T5 failed */ }
          }

          if (fallbackBrief) {
            this.ctx.countryBriefPage?.updateBrief({ brief: fallbackBrief, country, code, fallback: true, sources: briefSources });
          } else {
            const lines = this.buildFallbackSignalLines(score, signals, country, context);
            if (lines.length > 0) {
              this.ctx.countryBriefPage?.updateBrief({ brief: lines.join('\n'), country, code, fallback: true });
            } else {
              this.ctx.countryBriefPage?.updateBrief({ brief: '', country, code, error: 'No AI service available. Configure OPENROUTER_API_KEY in Settings for full briefs.' });
            }
          }
        }
      } catch (err) {
        console.error('[CountryBrief] fetch error:', err);
        if (token !== this.briefRequestToken || this.ctx.countryBriefPage?.getCode() !== code) return;
        this.ctx.countryBriefPage?.updateBrief({ brief: '', country, code, error: 'Failed to generate brief' });
      }
    } catch (err) {
      if (
        opts?.signal?.aborted
        || (err && typeof err === 'object' && 'name' in err && err.name === 'AbortError')
      ) {
        const activePage = this.ctx.countryBriefPage;
        const activeCode = activePage?.getCode();
        if (
          token === this.briefRequestToken
          && showedLoading
          && activePage?.isVisible()
          && (activeCode === '__loading__' || activeCode === '__error__')
        ) {
          activePage.hide();
        }
        throwIfWebMcpAborted(opts?.signal);
        throw err;
      }
      if (token !== this.briefRequestToken) {
        console.warn('[CountryBrief] Superseded country brief open failed after it was stale:', err);
        return;
      }
      console.error('[CountryBrief] Failed to open country brief:', err);
      if (!pageShown) {
        const activePage = this.ctx.countryBriefPage;
        const activeCode = activePage?.getCode();
        if (showedLoading && activePage?.isVisible() && (activeCode === '__loading__' || activeCode === '__error__')) activePage.hide();
        if (!this.hasVisibleRealCountryBrief()) this.ctx.map?.setRenderPaused(false);
        this.showToast('Country brief failed to open. Please try again.');
      }
    } finally {
      this.clearBriefRequest(request);
      if (!pageShown && token === this.briefRequestToken && !this.hasVisibleRealCountryBrief()) {
        this.ctx.map?.setRenderPaused(false);
      }
    }
  }

  private hasVisibleRealCountryBrief(): boolean {
    const page = this.ctx.countryBriefPage;
    if (!page?.isVisible()) return false;
    const activeCode = page.getCode();
    return !!activeCode && activeCode !== '__loading__' && activeCode !== '__error__';
  }

  refreshOpenBrief(): void {
    const page = this.ctx.countryBriefPage;
    if (!page?.isVisible()) return;
    const code = page.getCode();
    if (!code || code === '__loading__' || code === '__error__') return;
    const name = TIER1_COUNTRIES[code] ?? CountryIntelManager.resolveCountryName(code);
    const scoreCode = normalizeCiiCountryCode(code);
    const score = getCachedCountryScore(scoreCode);
    void this.getCountrySignals(code, name)
      .then((signals) => {
        if (!(page.isVisible() && page.getCode() === code)) return;
        page.updateScore?.(score, signals);
        page.updateSignals?.(signals, this.buildMilitarySummary(code, name).coverageNotes);
        // Fallback assessments embed temporal status inline; refresh that copy
        // when chips change so unavailable/zero/global context stays consistent.
        if (page.isFallbackBrief?.()) {
          const lines = this.buildFallbackSignalLines(score, signals, name, {});
          if (lines.length > 0) {
            page.updateBrief({ brief: lines.join('\n'), country: name, code, fallback: true });
          }
        }
      })
      .catch((err) => {
        console.warn('[CountryBrief] refreshOpenBrief signal fetch failed:', err);
      });
  }

  refreshOpenMilitaryActivity(): void {
    const page = this.ctx.countryBriefPage;
    if (!page?.isVisible()) return;
    const code = page.getCode();
    if (!code || code === '__loading__' || code === '__error__') return;
    const country = page.getName() ?? TIER1_COUNTRIES[code] ?? CountryIntelManager.resolveCountryName(code);
    page.updateMilitaryActivity?.(this.buildMilitarySummary(code, country));
  }

  refreshOpenTimeline(): void {
    const page = this.ctx.countryBriefPage;
    if (!page?.isVisible()) return;
    const code = page.getCode();
    if (!code || code === '__loading__' || code === '__error__') return;
    const country = page.getName() ?? CountryIntelManager.resolveCountryName(code);
    this.mountCountryTimeline(code, country, this.currentCoverageEvents);
  }

  private async fetchCountryIntelBrief(code: string, contextSnapshot: string, framework = ''): Promise<CountryIntelBriefResult> {
    const lang = getCurrentLanguage();
    const params = new URLSearchParams({ country_code: code, lang });
    const trimmed = contextSnapshot.trim();
    if (trimmed.length > 0) {
      // 3800 chars ≈ ~950 tokens; raised from 2200 to include infra context. Monitor p95 LLM latency if timeouts increase.
      params.set('context', trimmed.slice(0, 3800));
    }
    if (framework) {
      params.set('framework', framework.slice(0, 2000));
    }

    const resp = await premiumFetch(toApiUrl(`/api/intelligence/v1/get-country-intel-brief?${params.toString()}`), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: this.ctx.countryBriefPage?.signal,
    });
    if (!resp.ok) return { brief: '', sources: [], evidence: [] };

    const body = (await resp.json()) as {
      brief?: string;
      sources?: BriefSource[];
      evidence?: unknown;
      generatedAt?: string | number;
      cached?: boolean;
    };
    return {
      brief: typeof body.brief === 'string' ? body.brief.trim() : '',
      sources: collectBriefSources(body.sources ?? [], 6),
      evidence: Array.isArray(body.evidence)
        ? body.evidence.filter((item): item is IntelBriefEvidence =>
          !!item && typeof item === 'object' && typeof (item as IntelBriefEvidence).id === 'string')
        : [],
      generatedAt: body.generatedAt,
      cached: body.cached,
    };
  }


  private buildFallbackSignalLines(
    score: CountryScore | null,
    signals: WebsiteCountrySignals,
    _country: string,
    context: Record<string, unknown>,
  ): string[] {
    const lines: string[] = [];
    if (score) {
      lines.push(t('countryBrief.fallback.instabilityIndex', {
        score: String(score.score),
        level: t(`countryBrief.levels.${score.level}`),
        trend: t(`countryBrief.trends.${score.trend}`),
      }));
    }
    if (signals.protests > 0) lines.push(t('countryBrief.fallback.protestsDetected', { count: String(signals.protests) }));
    if ((signals.militaryFlights ?? 0) > 0) lines.push(t('countryBrief.fallback.aircraftTracked', { count: String(signals.militaryFlights) }));
    if ((signals.militaryVessels ?? 0) > 0) lines.push(t('countryBrief.fallback.vesselsTracked', { count: String(signals.militaryVessels) }));
    if (signals.activeStrikes > 0) lines.push(t('countryBrief.fallback.activeStrikes', { count: String(signals.activeStrikes) }));
    if (signals.travelAdvisoryMaxLevel === 'do-not-travel') {
      lines.push(`⚠️ Travel advisory: Do Not Travel (${signals.travelAdvisories} source${signals.travelAdvisories > 1 ? 's' : ''})`);
    } else if (signals.travelAdvisoryMaxLevel === 'reconsider') {
      lines.push(`⚠️ Travel advisory: Reconsider Travel (${signals.travelAdvisories} source${signals.travelAdvisories > 1 ? 's' : ''})`);
    }
    if (signals.outages > 0) lines.push(t('countryBrief.fallback.internetOutages', { count: String(signals.outages) }));
    if (signals.criticalNews > 0) lines.push(`🚨 Critical headlines in scope: ${signals.criticalNews}`);
    if (signals.cyberThreats > 0) lines.push(`🛡️ Cyber threat indicators: ${signals.cyberThreats}`);
    if (signals.aisDisruptions > 0) lines.push(`🚢 Maritime AIS disruptions: ${signals.aisDisruptions}`);
    if (signals.satelliteFires > 0) lines.push(`🔥 Satellite fire detections: ${signals.satelliteFires}`);
    if (signals.radiationAnomalies > 0) lines.push(`☢️ Radiation anomalies: ${signals.radiationAnomalies}`);
    if (signals.temporalAnomalies === null) lines.push('⏱️ Country temporal anomaly observations unavailable.');
    else if (signals.temporalAnomalies > 0) lines.push(`⏱️ Observed country temporal anomalies: ${signals.temporalAnomalies}`);
    if ((signals.globalTemporalAnomalies ?? 0) > 0) {
      lines.push(`Global context: ${signals.globalTemporalAnomalies} observed temporal anomalies; not attributed to this country.`);
    }
    if (signals.thermalEscalations > 0) lines.push(`🌡️ Thermal escalation clusters: ${signals.thermalEscalations}`);
    if (signals.earthquakes > 0) lines.push(t('countryBrief.fallback.recentEarthquakes', { count: String(signals.earthquakes) }));
    if (signals.orefHistory24h > 0) lines.push(`🚨 Sirens in past 24h: ${signals.orefHistory24h}`);
    if (typeof context.stockIndex === 'string' && context.stockIndex) {
      lines.push(t('countryBrief.fallback.stockIndex', { value: context.stockIndex }));
    }
    return lines;
  }

  private buildBriefContextSnapshot(
    country: string,
    code: string,
    score: CountryScore | null,
    signals: WebsiteCountrySignals,
    context: Record<string, unknown>,
  ): string {
    const lines: string[] = [];
    lines.push(`Country: ${country} (${code})`);

    // Infrastructure grounding must appear early so it survives the context char limit
    const infraContext = this.buildInfrastructureContext(code);
    if (infraContext) lines.push(infraContext);

    const briefSources = collectBriefSources(
      Array.isArray(context.briefSources) ? context.briefSources as BriefSource[] : [],
      6,
    );
    if (briefSources.length > 0) {
      lines.push('Brief source articles:');
      lines.push(...buildBriefSourceContextLines(briefSources));
    }

    if (score) {
      lines.push(`CII: ${score.score}/100 (${score.level}), trend=${score.trend}, 24h_change=${score.change24h}`);
      lines.push(`CII components: unrest=${Math.round(score.components.unrest)}, conflict=${Math.round(score.components.conflict)}, security=${Math.round(score.components.security)}, information=${Math.round(score.components.information)}`);
    }

    lines.push(
      `Signals: critical_news=${signals.criticalNews}, protests=${signals.protests}, active_strikes=${signals.activeStrikes}, military_flights=${signals.militaryFlights}, military_vessels=${signals.militaryVessels}, outages=${signals.outages}, aviation_disruptions=${signals.aviationDisruptions}, travel_advisories=${signals.travelAdvisories}, oref_sirens=${signals.orefSirens}, oref_24h=${signals.orefHistory24h}, gps_jamming_hexes=${signals.gpsJammingHexes}, ais_disruptions=${signals.aisDisruptions}, satellite_fires=${signals.satelliteFires}, radiation_anomalies=${signals.radiationAnomalies}, temporal_anomalies=${signals.temporalAnomalies ?? 'unavailable'}, cyber_threats=${signals.cyberThreats}, earthquakes=${signals.earthquakes}, conflict_events=${signals.conflictEvents}, thermal_escalations=${signals.thermalEscalations}`,
      `Temporal counts are observed signals, not source coverage. Global context: temporal_anomalies=${signals.globalTemporalAnomalies ?? 'unavailable'}; these global observations are not attributed to ${country} and must not be included in its counts.`,
    );

    if (signals.travelAdvisoryMaxLevel) {
      lines.push(`Travel advisory max level: ${signals.travelAdvisoryMaxLevel}`);
    }

    if (signals.sanctionsDesignations > 0) {
      const newPart = signals.sanctionsNewDesignations > 0 ? `, +${signals.sanctionsNewDesignations} new` : '';
      lines.push(`Sanctions: ${signals.sanctionsDesignations} active designations${newPart}`);
    }

    if (signals.displacementOutflow > 0) {
      lines.push(`Displacement outflow: ${signals.displacementOutflow.toLocaleString()} persons`);
    }
    if (signals.climateStress > 0) {
      lines.push(`Climate stress: ${Math.round(signals.climateStress)}/100`);
    }
    if (signals.isTier1) {
      lines.push(`Major power: yes`);
    }

    const stockIndex = typeof context.stockIndex === 'string' ? context.stockIndex : '';
    if (stockIndex) lines.push(`Stock index: ${stockIndex}`);

    const convergenceScore = typeof context.convergenceScore === 'number' ? context.convergenceScore : null;
    const signalTypes = Array.isArray(context.signalTypes) ? context.signalTypes as string[] : [];
    if (convergenceScore != null || signalTypes.length > 0) {
      lines.push(`Signal convergence: score=${convergenceScore ?? 0}, types=${signalTypes.slice(0, 8).join(', ')}`);
    }

    const regionalConvergence = Array.isArray(context.regionalConvergence) ? context.regionalConvergence as string[] : [];
    if (regionalConvergence.length > 0) {
      lines.push(`Regional context: ${regionalConvergence.slice(0, 3).join(' | ')}`);
    }

    const headlines = Array.isArray(context.headlines) ? context.headlines as string[] : [];
    if (headlines.length > 0) {
      lines.push(`Headlines: ${headlines.slice(0, 6).join(' | ')}`);
    }

    return lines.join('\n');
  }

  private buildInfrastructureContext(code: string): string {
    try {
      const graph = buildDependencyGraph();
      const countryId = `country:${code}`;
      const incomingEdges = graph.incoming.get(countryId) || [];
      const parts: string[] = [];

      const cables = incomingEdges
        .filter(e => (e.type === 'serves' || e.type === 'lands_at') && e.from.startsWith('cable:'))
        .sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0))
        .slice(0, 3)
        .map(e => {
          const node = graph.nodes.get(e.from);
          const share = e.strength ? ` (${Math.round(e.strength * 100)}% capacity)` : '';
          return node ? `${node.name}${share}` : '';
        }).filter(Boolean);
      if (cables.length) parts.push(`Cables: ${cables.join(', ')}`);

      const pipes = incomingEdges
        .filter(e => e.type === 'serves' && e.from.startsWith('pipeline:'))
        .sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0))
        .slice(0, 3)
        .map(e => {
          const node = graph.nodes.get(e.from);
          const status = typeof node?.metadata?.status === 'string' ? node.metadata.status : undefined;
          return node ? `${node.name}${status ? ` (${status})` : ''}` : '';
        }).filter(Boolean);
      if (pipes.length) parts.push(`Pipelines: ${pipes.join(', ')}`);

      const ports = incomingEdges
        .filter(e => e.type === 'serves' && e.from.startsWith('port:'))
        .sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0))
        .slice(0, 3)
        .map(e => {
          const node = graph.nodes.get(e.from);
          const rank = node?.metadata?.rank as number | undefined;
          const type = node?.metadata?.type as string | undefined;
          return node ? `${node.name}${rank ? ` (rank #${rank}${type ? ', ' + type : ''})` : ''}` : '';
        }).filter(Boolean);
      if (ports.length) parts.push(`Ports: ${ports.join(', ')}`);

      const chokepoints = incomingEdges
        .filter(e => e.type === 'trade_dependency' && e.from.startsWith('chokepoint:'))
        .map(e => {
          const node = graph.nodes.get(e.from);
          const reason = e.metadata?.relationship as string | undefined;
          return node ? `${node.name}${reason ? ` (${reason})` : ''}` : '';
        }).filter(Boolean)
        .slice(0, 2);
      if (chokepoints.length) parts.push(`Waterways: ${chokepoints.join(', ')}`);

      return parts.length > 0 ? `Infrastructure exposure: ${parts.join(' | ')}` : '';
    } catch {
      return '';
    }
  }

  private mountCountryTimeline(
    code: string,
    country: string,
    coverageEvents: CountryCoverageEvent[] = [],
  ): void {
    this.ctx.countryTimeline?.destroy();
    this.ctx.countryTimeline = null;

    const mount = this.ctx.countryBriefPage?.getTimelineMount();
    if (!mount) return;

    const structuredEvents: CountryCoverageEvent[] = [];
    const countryLower = country.toLowerCase();
    const hasGeoShape = hasCountryGeometry(code) || !!CountryIntelManager.COUNTRY_BOUNDS[code];
    const inCountry = (lat: number, lon: number) => hasGeoShape && this.isInCountry(lat, lon, code);
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    if (this.ctx.intelligenceCache.protests?.events) {
      for (const e of this.ctx.intelligenceCache.protests.events) {
        if (e.country?.toLowerCase() === countryLower || inCountry(e.lat, e.lon)) {
          structuredEvents.push({
            timestamp: new Date(e.time).getTime(),
            lane: 'protest',
            label: e.title || `${e.eventType} in ${e.city || e.country}`,
            severity: e.severity === 'high' ? 'high' : e.severity === 'medium' ? 'medium' : 'low',
          });
        }
      }
    }

    if (this.ctx.intelligenceCache.earthquakes) {
      for (const eq of this.ctx.intelligenceCache.earthquakes) {
        if (inCountry(eq.location?.latitude ?? 0, eq.location?.longitude ?? 0) || eq.place?.toLowerCase().includes(countryLower)) {
          structuredEvents.push({
            timestamp: eq.occurredAt,
            lane: 'natural',
            label: `M${eq.magnitude.toFixed(1)} ${eq.place}`,
            severity: eq.magnitude >= 6 ? 'critical' : eq.magnitude >= 5 ? 'high' : eq.magnitude >= 4 ? 'medium' : 'low',
          });
        }
      }
    }

    if (this.ctx.intelligenceCache.military) {
      for (const f of this.ctx.intelligenceCache.military.flights) {
        if (hasGeoShape ? this.isInCountry(f.lat, f.lon, code) : f.operatorCountry?.toUpperCase() === code) {
          structuredEvents.push({
            timestamp: new Date(f.lastSeen).getTime(),
            lane: 'military',
            label: `${f.callsign} (${f.aircraftModel || f.aircraftType})`,
            severity: f.isInteresting ? 'high' : 'low',
          });
        }
      }
      for (const v of this.ctx.intelligenceCache.military.vessels) {
        if (hasGeoShape ? this.isInCountry(v.lat, v.lon, code) : v.operatorCountry?.toUpperCase() === code) {
          structuredEvents.push({
            timestamp: new Date(v.lastAisUpdate).getTime(),
            lane: 'military',
            label: `${v.name} (${vesselTypeLabel(v)})`,
            severity: v.isDark ? 'high' : 'low',
          });
        }
      }
    }

    const ciiData = getCountryData(code);
    if (ciiData?.conflicts) {
      for (const c of ciiData.conflicts) {
        structuredEvents.push({
          timestamp: new Date(c.time).getTime(),
          lane: 'conflict',
          label: `${c.eventType}: ${c.location || c.country}`,
          severity: c.fatalities > 0 ? 'critical' : 'high',
        });
      }
    }

    for (const e of this.getCountryStrikes(code, hasGeoShape)) {
      const rawTs = Number(e.timestamp) || 0;
      const ts = rawTs < 1e12 ? rawTs * 1000 : rawTs;
      structuredEvents.push({
        timestamp: ts,
        lane: 'conflict',
        label: e.title || `Strike: ${e.locationName}`,
        severity: (e.severity.toLowerCase() === 'high' || e.severity.toLowerCase() === 'critical') ? 'critical' : 'high',
      });
    }

    const isVisibleEvent = (event: CountryCoverageEvent): boolean => (
      Number.isFinite(event.timestamp) && event.timestamp >= sevenDaysAgo
    );
    const events = reconcileCountryTimelineIncidents(
      coverageEvents.filter(isVisibleEvent),
      structuredEvents.filter(isVisibleEvent),
    );
    this.ctx.countryTimeline = new CountryTimeline(mount);
    this.ctx.countryTimeline.render(events);
  }

  async getCountrySignals(code: string, country: string): Promise<WebsiteCountrySignals> {
    const countryLower = country.toLowerCase();
    const hasGeoShape = hasCountryGeometry(code) || !!CountryIntelManager.COUNTRY_BOUNDS[code];
    // The signal-aggregator chunk is lazy-loaded; if it fails to load we still
    // render the brief from the independent intelligence caches below rather
    // than aborting the whole open. Only the cluster-derived counts degrade.
    let clusters: CountrySignalCluster[] = [];
    let clustersAvailable = false;
    try {
      clusters = (await getSignalAggregator()).getCountryClusters();
      clustersAvailable = true;
    } catch (err) {
      console.warn('[CountryBrief] signal clusters unavailable, degrading:', err);
    }
    const countryCluster = clusters.find(c => c.country === code);
    const globalCluster = clusters.find(c => c.country === 'XX');
    const signalTypeCounts = {
      aisDisruptions: 0,
      satelliteFires: 0,
      radiationAnomalies: 0,
      temporalAnomalies: 0,
    };
    if (countryCluster) {
      for (const s of countryCluster.signals) {
        if (s.type === 'ais_disruption') signalTypeCounts.aisDisruptions++;
        else if (s.type === 'satellite_fire') signalTypeCounts.satelliteFires++;
        else if (s.type === 'radiation_anomaly') signalTypeCounts.radiationAnomalies++;
        else if (s.type === 'temporal_anomaly') signalTypeCounts.temporalAnomalies++;
      }
    }
    const globalTemporalAnomalies = globalCluster
      ? globalCluster.signals.filter((s) => s.type === 'temporal_anomaly').length
      : 0;

    const criticalNews = this.ctx.latestClusters.filter((cluster) => {
      if (!CountryIntelManager.isCountryHeadline(cluster.primaryTitle, country, code)) return false;
      return cluster.isAlert || cluster.threat?.level === 'critical' || cluster.threat?.level === 'high';
    }).length;

    let protests = 0;
    if (this.ctx.intelligenceCache.protests?.events) {
      protests = this.ctx.intelligenceCache.protests.events.filter((e) =>
        e.country?.toLowerCase() === countryLower || (hasGeoShape && this.isInCountry(e.lat, e.lon, code))
      ).length;
    }

    const military = this.selectCountryMilitary(code, country).signalCounts;

    let outages = 0;
    if (this.ctx.intelligenceCache.outages) {
      outages = this.ctx.intelligenceCache.outages.filter((o) =>
        o.country?.toLowerCase() === countryLower || (hasGeoShape && this.isInCountry(o.lat, o.lon, code))
      ).length;
    }

    let earthquakes = 0;
    if (this.ctx.intelligenceCache.earthquakes) {
      earthquakes = this.ctx.intelligenceCache.earthquakes.filter((eq) => {
        if (hasGeoShape) return this.isInCountry(eq.location?.latitude ?? 0, eq.location?.longitude ?? 0, code);
        return eq.place?.toLowerCase().includes(countryLower);
      }).length;
    }

    const activeStrikes = this.getCountryStrikes(code, hasGeoShape).length;

    let aviationDisruptions = 0;
    if (this.ctx.intelligenceCache.flightDelays) {
      aviationDisruptions = this.ctx.intelligenceCache.flightDelays.filter(d =>
        (d.severity === 'major' || d.severity === 'severe' || d.delayType === 'closure') &&
        (hasGeoShape ? this.isInCountry(d.lat, d.lon, code) : d.country?.toLowerCase() === countryLower)
      ).length;
    }

    const ciiData = getCountryData(code);
    const isTier1 = !!TIER1_COUNTRIES[code];

    let orefSirens = 0;
    let orefHistory24h = 0;
    if (code === 'IL' && this.ctx.intelligenceCache.orefAlerts) {
      orefSirens = this.ctx.intelligenceCache.orefAlerts.alertCount;
      orefHistory24h = this.ctx.intelligenceCache.orefAlerts.historyCount24h;
    }

    let travelAdvisories = 0;
    let travelAdvisoryMaxLevel: string | null = null;
    const advisoryLevelRank: Record<string, number> = { 'do-not-travel': 4, 'reconsider': 3, 'caution': 2, 'normal': 1, 'info': 0 };
    if (this.ctx.intelligenceCache.advisories) {
      const countryAdvisories = this.ctx.intelligenceCache.advisories.filter(a => a.country === code);
      travelAdvisories = countryAdvisories.length;
      for (const a of countryAdvisories) {
        if (a.level && (advisoryLevelRank[a.level] || 0) > (advisoryLevelRank[travelAdvisoryMaxLevel || ''] || 0)) {
          travelAdvisoryMaxLevel = a.level;
        }
      }
    }

    let cyberThreats = 0;
    if (this.ctx.cyberThreatsCache) {
      cyberThreats = this.ctx.cyberThreatsCache.filter((threat) => {
        if (threat.country && threat.country.length === 2) return threat.country.toUpperCase() === code;
        return hasGeoShape && this.isInCountry(threat.lat, threat.lon, code);
      }).length;
    }

    let thermalEscalations = 0;
    if (this.ctx.intelligenceCache.thermalEscalation) {
      thermalEscalations = this.ctx.intelligenceCache.thermalEscalation.clusters.filter(
        (c) => c.countryCode.toUpperCase() === code && c.status !== 'normal',
      ).length;
    }

    const sanctionsCountry = this.ctx.intelligenceCache.sanctions?.countries.find(
      (c) => c.countryCode.toUpperCase() === code,
    );
    const sanctionsDesignations = sanctionsCountry?.entryCount ?? 0;
    const sanctionsNewDesignations = sanctionsCountry?.newEntryCount ?? 0;

    return {
      criticalNews,
      protests,
      ...military,
      outages,
      aisDisruptions: signalTypeCounts.aisDisruptions,
      satelliteFires: signalTypeCounts.satelliteFires,
      radiationAnomalies: signalTypeCounts.radiationAnomalies,
      temporalAnomalies: clustersAvailable && hasTemporalBaselineSnapshot() ? signalTypeCounts.temporalAnomalies : null,
      globalTemporalAnomalies: clustersAvailable && hasTemporalBaselineSnapshot() ? globalTemporalAnomalies : null,
      cyberThreats,
      earthquakes,
      displacementOutflow: ciiData?.displacementOutflow ?? 0,
      climateStress: ciiData?.climateStress ?? 0,
      conflictEvents: ciiData?.conflicts?.length ?? 0,
      activeStrikes,
      orefSirens,
      orefHistory24h,
      aviationDisruptions,
      travelAdvisories,
      travelAdvisoryMaxLevel,
      gpsJammingHexes: (ciiData?.gpsJammingHighCount ?? 0) + (ciiData?.gpsJammingMediumCount ?? 0),
      isTier1,
      thermalEscalations,
      sanctionsDesignations,
      sanctionsNewDesignations,
    };
  }

  private newsSeverityRank(item: NewsItem): number {
    const level = item.threat?.level;
    if (level === 'critical') return 5;
    if (level === 'high') return 4;
    if (level === 'medium') return 3;
    if (level === 'low') return 2;
    if (item.isAlert) return 4;
    return 1;
  }

  private async buildSignalDetails(code: string): Promise<CountryDeepDiveSignalDetails> {
    const cluster = (await getSignalAggregator()).getCountryClusters().find((entry) => entry.country === code);
    return projectCountrySignalDetails(cluster?.signals ?? []);
  }

  private selectCountryMilitary(code: string, country: string) {
    const cached = this.ctx.intelligenceCache.military;
    const flightState = cached?.flightDataState;
    const vesselState = cached?.vesselDataState;
    const flights = flightState && flightState.mode !== 'unavailable' ? cached!.flights : null;
    const vessels = vesselState && vesselState.mode !== 'unavailable' ? cached!.vessels : null;
    const flightConfirmed = flightState?.mode === 'live' && !flightState.offline;
    const vesselConfirmed = vesselState?.mode === 'live' && !vesselState.offline && cached?.vesselNegativeEvidenceConfirmed === true;
    const summary = projectCountryMilitaryActivity(code, country, flights, vessels);
    const signalCounts = projectCountryMilitarySignalCounts(code, flights, vessels);
    if (!flightConfirmed) {
      if (summary.ownFlights === 0) summary.ownFlights = null;
      if (summary.foreignFlights === 0) summary.foreignFlights = null;
      if (signalCounts.militaryFlights === 0) signalCounts.militaryFlights = null;
      if (signalCounts.militaryFlightsInCountry === 0) signalCounts.militaryFlightsInCountry = null;
    }
    if (!vesselConfirmed) {
      if (summary.nearbyVessels === 0) summary.nearbyVessels = null;
      if (signalCounts.militaryVessels === 0) signalCounts.militaryVessels = null;
      if (signalCounts.militaryVesselsInCountry === 0) signalCounts.militaryVesselsInCountry = null;
    }
    if (summary.foreignPresence === false && (!flightConfirmed || !vesselConfirmed)) summary.foreignPresence = null;
    const coverageNotes = [flightConfirmed
      ? 'Flight counts use the current supplied sample. Country-empty observations are zero.'
      : flights
        ? 'Flight counts are previous cached observations. A previous empty sample does not confirm current absence.'
        : 'Military flight observations unavailable or unconfirmed. This is not zero activity.',
      ...(cached?.vesselCoverageNotes ?? []),
      ...(vesselConfirmed ? [] : ['Military vessel coverage is partial, unavailable or cached. Positive observations remain supported; current absence is unconfirmed.']),
    ];
    return { signalCounts, summary: { ...summary, coverageNotes, coverage: flightConfirmed && vesselConfirmed ? 'complete' as const : 'partial' as const } };
  }

  private buildMilitarySummary(code: string, country: string): CountryDeepDiveMilitarySummary {
    return this.selectCountryMilitary(code, country).summary;
  }

  private buildEconomicIndicators(
    code: string,
    score: CountryScore | null,
    stock: CountryStockSnapshot | null,
    imfBundle?: ImfCountryBundle | null,
  ): CountryDeepDiveEconomicIndicator[] {
    const indicators: CountryDeepDiveEconomicIndicator[] = [];

    if (stock?.available) {
      const weekly = Number.parseFloat(stock.weekChangePercent);
      const weeklyTrend = Number.isFinite(weekly)
        ? weekly > 0 ? 'up' : weekly < 0 ? 'down' : 'flat'
        : 'flat';
      indicators.push({
        label: 'Stock Index',
        value: `${stock.indexName}: ${stock.price} ${stock.currency}`,
        trend: weeklyTrend,
        source: 'Market Service',
      });
      indicators.push({
        label: 'Weekly Momentum',
        value: `${weekly >= 0 ? '+' : ''}${stock.weekChangePercent}%`,
        trend: weeklyTrend,
      });
    }

    if (score) {
      const trend = score.trend === 'rising'
        ? 'up'
        : score.trend === 'falling'
          ? 'down'
          : 'flat';
      indicators.push({
        label: 'Instability Regime',
        value: `${score.score}/100 (${score.level})`,
        trend,
        source: 'Country Instability Index',
      });
    }

    const countryData = getCountryData(code);
    if (countryData?.displacementOutflow && countryData.displacementOutflow > 0) {
      const displaced = countryData.displacementOutflow >= 1_000_000
        ? `${(countryData.displacementOutflow / 1_000_000).toFixed(1)}M`
        : `${Math.round(countryData.displacementOutflow / 1000)}K`;
      indicators.push({
        label: 'Displacement Outflow',
        value: displaced,
        trend: 'up',
        source: 'UN-style displacement feed',
      });
    }

    // IMF WEO indicators (issue #3027): real GDP growth, inflation,
    // unemployment, GDP/capita. Appended after the live signals so that
    // markets-driven rows take priority on the limited card surface.
    if (imfBundle) {
      for (const ind of buildImfEconomicIndicators(imfBundle)) {
        indicators.push(ind);
      }
    }

    return indicators.slice(0, 6);
  }

  async openCountryStory(code: string, name: string): Promise<void> {
    if (!dataFreshness.hasSufficientData() || this.ctx.latestClusters.length === 0) {
      this.showToast('Data still loading — try again in a moment');
      return;
    }
    const posturePanel = this.ctx.panels['strategic-posture'] as StrategicPosturePanel | undefined;
    const postures = posturePanel?.getPostures() || [];
    const aggregator = await getSignalAggregator();
    const signals = await this.getCountrySignals(code, name);
    const cluster = aggregator.getCountryClusters().find(c => c.country === code);
    const regional = aggregator.getRegionalConvergence().filter(r => r.countries.includes(code));
    const convergence = cluster ? {
      score: cluster.convergenceScore,
      signalTypes: [...cluster.signalTypes],
      regionalDescriptions: regional.map(r => r.description),
    } : null;
    const data = collectStoryData(code, name, this.ctx.latestClusters, postures, this.ctx.latestPredictions, signals, convergence);
    // await (not void) so a chunk-load failure rejects openCountryStory's promise and
    // reaches the caller's existing .catch() toast handler (country-intel.ts:205).
    const { openStoryModal } = await import('@/components/StoryModal');
    openStoryModal(data);
  }

  showToast(msg: string): void {
    showGlobalToast(msg, 3000);
  }

  private getCountryStrikes(code: string, hasGeoShape: boolean): typeof this.ctx.intelligenceCache.iranEvents & object {
    if (!IRAN_ATTACKS_ENABLED) return [];
    if (!this.ctx.intelligenceCache.iranEvents) return [];
    const seen = new Set<string>();
    return this.ctx.intelligenceCache.iranEvents.filter(e => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return hasGeoShape && this.isInCountry(e.latitude, e.longitude, code);
    });
  }

  private isInCountry(lat: number, lon: number, code: string): boolean {
    return isCountryActivityCoordinate(lat, lon, code);
  }

  static COUNTRY_BOUNDS = COUNTRY_ACTIVITY_BOUNDS;

  // The alias table and the matching rules moved to
  // shared/country-headline-match.ts (#7526) so the country-coverage RPC can
  // match headlines the way this panel does — server/ may not import src/app/.
  // These stay as static delegates so no call site changed.
  static readonly COUNTRY_ALIASES: Record<string, string[]> = COUNTRY_ALIASES;

  static escapeRegExp(value: string): string {
    return escapeRegExp(value);
  }

  static countryTermIndex(text: string, term: string): number {
    return countryTermIndex(text, term);
  }

  static firstMentionPosition(text: string, terms: string[]): number {
    return firstMentionPosition(text, terms);
  }

  static getOtherCountryTerms(code: string): string[] {
    return getOtherCountryTerms(code);
  }

  static isCountryHeadline(title: string, country: string, code: string): boolean {
    return isCountryHeadline(title, country, code);
  }

  static resolveCountryName(code: string): string {
    if (TIER1_COUNTRIES[code]) return TIER1_COUNTRIES[code];

    try {
      const displayNamesCtor = (Intl as unknown as { DisplayNames?: IntlDisplayNamesCtor }).DisplayNames;
      if (!displayNamesCtor) return code;
      const displayNames = new displayNamesCtor(['en'], { type: 'region' });
      const resolved = displayNames.of(code);
      if (resolved && resolved.toUpperCase() !== code) return resolved;
    } catch {
      // Intl.DisplayNames unavailable in older runtimes.
    }

    return code;
  }

  static getCountrySearchTerms(country: string, code: string): string[] {
    return getCountrySearchTerms(country, code);
  }

  static toFlagEmoji(code: string): string {
    return toFlagEmoji(code, '🏳️');
  }
}
