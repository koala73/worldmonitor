import type { AppContext, AppModule } from '@/app/app-context';
import { normalizeExclusiveChoropleths } from '@/components/resilience-choropleth-utils';
import { replayPendingCalls, clearAllPendingCalls } from '@/app/pending-panel-data';
import { getAlertsNearLocation } from '@/services/geo-convergence';
import type { ClusteredEvent } from '@/types';
import type { RelatedAsset } from '@/types';
import type { TheaterPostureSummary } from '@/services/military-surge';
import {
  MapContainer,
  NewsPanel,
  MarketPanel,
  StockAnalysisPanel,
  StockBacktestPanel,
  HeatmapPanel,
  CommoditiesPanel,
  CryptoPanel,
  CryptoHeatmapPanel,
  DefiTokensPanel,
  AiTokensPanel,
  OtherTokensPanel,
  PredictionPanel,
  MonitorPanel,
  EconomicPanel,
  ConsumerPricesPanel,
  EnergyComplexPanel,
  GdeltIntelPanel,
  LiveNewsPanel,
  getDefaultLiveChannels,
  loadChannelsFromStorage,
  LiveWebcamsPanel,
  PinnedWebcamsPanel,
  CIIPanel,
  CascadePanel,
  StrategicRiskPanel,
  StrategicPosturePanel,
  TechEventsPanel,
  ServiceStatusPanel,
  InternetDisruptionsPanel,
  RuntimeConfigPanel,
  InsightsPanel,
  MacroSignalsPanel,
  FearGreedPanel,
  MarketBreadthPanel,
  ETFFlowsPanel,
  StablecoinPanel,
  UcdpEventsPanel,
  InvestmentsPanel,
  TradePolicyPanel,
  SupplyChainPanel,
  SanctionsPressurePanel,
  GulfEconomiesPanel,
  GroceryBasketPanel,
  BigMacPanel,
  FuelPricesPanel,
  FaoFoodPriceIndexPanel,
  ClimateNewsPanel,
  WorldClockPanel,
  AirlineIntelPanel,
  AviationCommandBar,
  MilitaryCorrelationPanel,
  EscalationCorrelationPanel,
  EconomicCorrelationPanel,
  DisasterCorrelationPanel,
  DefensePatentsPanel,
  HormuzPanel,
  MacroTilesPanel,
  FSIPanel,
  YieldCurvePanel,
  EarningsCalendarPanel,
  EconomicCalendarPanel,
  CotPositioningPanel,
  DiseaseOutbreaksPanel,
  SocialVelocityPanel,
  WsbTickerScannerPanel,
  AAIISentimentPanel,
} from '@/components';
import { SatelliteFiresPanel } from '@/components/SatelliteFiresPanel';
import { focusInvestmentOnMap } from '@/services/investments-focus';
import { debounce, saveToStorage, loadFromStorage } from '@/utils';
import { escapeHtml } from '@/utils/sanitize';
import {
  FEEDS,
  INTEL_SOURCES,
  STORAGE_KEYS,
  SITE_VARIANT,
  ALL_PANELS,
  VARIANT_DEFAULTS,
} from '@/config';
import { BETA_MODE } from '@/config/beta';
import { t } from '@/services/i18n';
import { getCurrentTheme } from '@/utils';
import { trackCriticalBannerAction } from '@/services/analytics';
import { CustomWidgetPanel } from '@/components/CustomWidgetPanel';
import { openWidgetChatModal } from '@/components/WidgetChatModal';
import { loadWidgets, saveWidget } from '@/services/widget-store';
import type { CustomWidgetSpec } from '@/services/widget-store';
import { initEntitlementSubscription, destroyEntitlementSubscription, isEntitled, onEntitlementChange } from '@/services/entitlements';
import { initSubscriptionWatch, destroySubscriptionWatch } from '@/services/billing';
import { getUserId } from '@/services/user-identity';
import { initPaymentFailureBanner } from '@/components/payment-failure-banner';
import { handleCheckoutReturn } from '@/services/checkout-return';
import { initCheckoutOverlay, destroyCheckoutOverlay, showCheckoutSuccess } from '@/services/checkout';
import { McpDataPanel } from '@/components/McpDataPanel';
import { openMcpConnectModal } from '@/components/McpConnectModal';
import { loadMcpPanels, saveMcpPanel } from '@/services/mcp-store';
import type { McpPanelSpec } from '@/services/mcp-store';
import { getAuthState, subscribeAuthState } from '@/services/auth-state';
import type { AuthSession } from '@/services/auth-state';
import { PanelGateReason, getPanelGateReason, hasPremiumAccess } from '@/services/panel-gating';
import type { Panel } from '@/components/Panel';

/** Panels that require premium access on web. Auth-based gating applies to these. */
const WEB_PREMIUM_PANELS = new Set([
  'stock-analysis',
  'stock-backtest',
  'daily-market-brief',
  'market-implications',
  'deduction',
  'chat-analyst',
  'wsb-ticker-scanner',
]);

export interface PanelLayoutManagerCallbacks {
  openCountryStory: (code: string, name: string) => void;
  openCountryBrief: (code: string) => void;
  loadAllData: () => Promise<void>;
  updateMonitorResults: () => void;
  loadSecurityAdvisories?: () => Promise<void>;
}

export class PanelLayoutManager implements AppModule {
  private ctx: AppContext;
  private callbacks: PanelLayoutManagerCallbacks;
  private panelDragCleanupHandlers: Array<() => void> = [];
  private resolvedPanelOrder: string[] = [];
  private bottomSetMemory: Set<string> = new Set();
  private criticalBannerEl: HTMLElement | null = null;
  private aviationCommandBar: AviationCommandBar | null = null;
  private readonly applyTimeRangeFilterDebounced: (() => void) & { cancel(): void };
  private unsubscribeAuth: (() => void) | null = null;
  private proBlockUnsubscribe: (() => void) | null = null;
  private boundWidgetCreatorHandler: ((e: Event) => void) | null = null;
  private unsubscribeEntitlementChange: (() => void) | null = null;
  private unsubscribePaymentFailureBanner: (() => void) | null = null;

  constructor(ctx: AppContext, callbacks: PanelLayoutManagerCallbacks) {
    this.ctx = ctx;
    this.callbacks = callbacks;
    this.applyTimeRangeFilterDebounced = debounce(() => {
      this.applyTimeRangeFilterToNewsPanels();
    }, 120);

    // Dodo Payments: entitlement subscription + billing watch for ALL users.
    // Free users need the subscription active so they receive real-time
    // entitlement updates after purchasing (P1: newly upgraded users must
    // see their premium access without a manual page reload).
    if (handleCheckoutReturn()) {
      showCheckoutSuccess();
    }

    const userId = getUserId();
    if (userId) {
      initEntitlementSubscription(userId).catch(() => {});
      initSubscriptionWatch(userId).catch(() => {});
      this.unsubscribePaymentFailureBanner = initPaymentFailureBanner();
    }

    initCheckoutOverlay(() => showCheckoutSuccess());

    // Listen for entitlement changes — reload panels to pick up new gating state.
    // Skip the initial snapshot to avoid a reload loop for users who already have
    // premium via legacy signals (API key / wm-pro-key).
    let skipInitialSnapshot = true;
    this.unsubscribeEntitlementChange = onEntitlementChange(() => {
      if (skipInitialSnapshot) {
        skipInitialSnapshot = false;
        return;
      }
      if (isEntitled()) {
        console.log('[entitlements] Subscription activated — reloading to unlock panels');
        window.location.reload();
      }
    });
  }

  init(): void {
    this.renderLayout();

    // Subscribe to auth state for reactive panel gating on web
    this.unsubscribeAuth = subscribeAuthState((state) => {
      this.updatePanelGating(state);
    });
    this.fetchGitHubStars();

    // Handle analyst action chip "Create chart widget →" click
    this.boundWidgetCreatorHandler = ((e: CustomEvent<{ initialMessage?: string }>) => {
      openWidgetChatModal({
        mode: 'create',
        tier: 'pro',
        initialMessage: e.detail.initialMessage,
        onComplete: (spec) => this.addCustomWidget(spec),
      });
    }) as EventListener;
    this.ctx.container.addEventListener('wm:open-widget-creator', this.boundWidgetCreatorHandler);
  }

  destroy(): void {
    clearAllPendingCalls();
    this.applyTimeRangeFilterDebounced.cancel();
    this.unsubscribeAuth?.();
    this.unsubscribeAuth = null;
    this.proBlockUnsubscribe?.();
    this.proBlockUnsubscribe = null;
    if (this.boundWidgetCreatorHandler) {
      this.ctx.container.removeEventListener('wm:open-widget-creator', this.boundWidgetCreatorHandler);
      this.boundWidgetCreatorHandler = null;
    }
    this.panelDragCleanupHandlers.forEach((cleanup) => cleanup());
    this.panelDragCleanupHandlers = [];
    if (this.criticalBannerEl) {
      this.criticalBannerEl.remove();
      this.criticalBannerEl = null;
    }
    // Clean up happy variant panels
    this.ctx.tvMode?.destroy();
    this.ctx.tvMode = null;
    this.ctx.countersPanel?.destroy();
    this.ctx.progressPanel?.destroy();
    this.ctx.breakthroughsPanel?.destroy();
    this.ctx.heroPanel?.destroy();
    this.ctx.digestPanel?.destroy();
    this.ctx.speciesPanel?.destroy();
    this.ctx.renewablePanel?.destroy();

    // Clean up aviation components
    this.aviationCommandBar?.destroy();
    this.aviationCommandBar = null;
    this.ctx.panels['airline-intel']?.destroy();

    // Clean up billing subscription watch + entitlement subscription
    destroySubscriptionWatch();
    destroyEntitlementSubscription();

    // Clean up entitlement change listener
    this.unsubscribeEntitlementChange?.();
    this.unsubscribeEntitlementChange = null;

    // Clean up payment failure banner subscription
    this.unsubscribePaymentFailureBanner?.();
    this.unsubscribePaymentFailureBanner = null;

    // Reset checkout overlay so next layout init can register its callback
    destroyCheckoutOverlay();

    window.removeEventListener('resize', this.ensureCorrectZones);
  }

  /** Reactively update premium panel gating based on auth state. */
  private updatePanelGating(state: AuthSession): void {
    for (const [key, panel] of Object.entries(this.ctx.panels)) {
      const isPremium = WEB_PREMIUM_PANELS.has(key);
      const reason = getPanelGateReason(state, isPremium);

      if (reason === PanelGateReason.NONE) {
        // User has access -- unlock if previously locked
        (panel as Panel).unlockPanel();
      } else {
        // User does NOT have access -- show appropriate CTA
        const onAction = this.getGateAction(reason);
        (panel as Panel).showGatedCta(reason, onAction);
      }
    }
  }

  /** Return the action callback for a given gate reason. */
  private getGateAction(reason: PanelGateReason): () => void {
    switch (reason) {
      case PanelGateReason.ANONYMOUS:
        return () => this.ctx.authModal?.open();
      case PanelGateReason.FREE_TIER:
        return () => window.open('https://worldmonitor.app/pro', '_blank');
      default:
        return () => {};
    }
  }

  private async fetchGitHubStars(): Promise<void> {
    try {
      const response = await fetch('https://api.github.com/repos/koala73/worldmonitor');
      if (!response.ok) return;
      const data = await response.json();
      const starsEl = document.getElementById('githubStars');
      if (starsEl) {
        const count = data.stargazers_count;
        const k = Math.round(count / 1000);
        starsEl.textContent = `${k}k`;
      }
    } catch (e) {
      // ignore errors
    }
  }

  renderLayout(): void {
    this.ctx.container.innerHTML = `
      ${this.ctx.isDesktopApp ? '<div class="tauri-titlebar" data-tauri-drag-region></div>' : ''}
      <div class="header">
        <div class="header-left">
          <button class="hamburger-btn" id="hamburgerBtn" aria-label="Menu">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
          <div class="variant-switcher">${(() => {
        const local = this.ctx.isDesktopApp || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
        const inIframe = window.self !== window.top;
        const vHref = (v: string, prod: string) => local || SITE_VARIANT === v ? '#' : prod;
        const vTarget = (v: string) => !local && SITE_VARIANT !== v && inIframe ? 'target="_blank" rel="noopener"' : '';
        return `
            <a href="${vHref('full', 'https://worldmonitor.app')}"
               class="variant-option ${SITE_VARIANT === 'full' ? 'active' : ''}"
               data-variant="full"
               ${vTarget('full')}
               title="${t('header.world')}${SITE_VARIANT === 'full' ? ` ${t('common.currentVariant')}` : ''}">
              <span class="variant-icon">🌍</span>
              <span class="variant-label">${t('header.world')}</span>
            </a>
            <span class="variant-divider"></span>
            <a href="${vHref('tech', 'https://tech.worldmonitor.app')}"
               class="variant-option ${SITE_VARIANT === 'tech' ? 'active' : ''}"
               data-variant="tech"
               ${vTarget('tech')}
               title="${t('header.tech')}${SITE_VARIANT === 'tech' ? ` ${t('common.currentVariant')}` : ''}">
              <span class="variant-icon">💻</span>
              <span class="variant-label">${t('header.tech')}</span>
            </a>
            <span class="variant-divider"></span>
            <a href="${vHref('finance', 'https://finance.worldmonitor.app')}"
               class="variant-option ${SITE_VARIANT === 'finance' ? 'active' : ''}"
               data-variant="finance"
               ${vTarget('finance')}
               title="${t('header.finance')}${SITE_VARIANT === 'finance' ? ` ${t('common.currentVariant')}` : ''}">
              <span class="variant-icon">📈</span>
              <span class="variant-label">${t('header.finance')}</span>
            </a>
            <span class="variant-divider"></span>
            <a href="${vHref('commodity', 'https://commodity.worldmonitor.app')}"
               class="variant-option ${SITE_VARIANT === 'commodity' ? 'active' : ''}"
               data-variant="commodity"
               ${vTarget('commodity')}
               title="${t('header.commodity')}${SITE_VARIANT === 'commodity' ? ` ${t('common.currentVariant')}` : ''}">
              <span class="variant-icon">⛏️</span>
              <span class="variant-label">${t('header.commodity')}</span>
            </a>
            <span class="variant-divider"></span>
            <a href="${vHref('happy', 'https://happy.worldmonitor.app')}"
               class="variant-option ${SITE_VARIANT === 'happy' ? 'active' : ''}"
               data-variant="happy"
               ${vTarget('happy')}
               title="Good News${SITE_VARIANT === 'happy' ? ` ${t('common.currentVariant')}` : ''}">
              <span class="variant-icon">☀️</span>
              <span class="variant-label">Good News</span>
            </a>`;
      })()}</div>
          <span class="logo">MONITOR</span><span class="logo-mobile">World Monitor</span><span class="version">v${__APP_VERSION__}</span>${BETA_MODE ? '<span class="beta-badge">BETA</span>' : ''}
          <a href="https://x.com/eliehabib" target="_blank" rel="noopener" class="credit-link">
            <svg class="x-logo" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
            <span class="credit-text">@eliehabib</span>
          </a>
          <a href="https://github.com/koala73/worldmonitor" target="_blank" rel="noopener" class="github-link" title="${t('header.viewOnGitHub')}">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
            <span class="github-stars" id="githubStars"></span>
          </a>
          <button class="mobile-settings-btn" id="mobileSettingsBtn" title="${t('header.settings')}">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
          <div class="status-indicator">
            <span class="status-dot"></span>
            <span>${t('header.live')}</span>
          </div>
          <div class="region-selector">
            <select id="regionSelect" class="region-select">
              <option value="global">${t('components.deckgl.views.global')}</option>
              <option value="america">${t('components.deckgl.views.americas')}</option>
              <option value="mena">${t('components.deckgl.views.mena')}</option>
              <option value="eu">${t('components.deckgl.views.europe')}</option>
              <option value="asia">${t('components.deckgl.views.asia')}</option>
              <option value="latam">${t('components.deckgl.views.latam')}</option>
              <option value="africa">${t('components.deckgl.views.africa')}</option>
              <option value="oceania">${t('components.deckgl.views.oceania')}</option>
            </select>
          </div>
          <button class="mobile-search-btn" id="mobileSearchBtn" aria-label="${t('header.search')}">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </button>
        </div>
        <div class="header-right">
          <button class="search-btn" id="searchBtn"><kbd>⌘K</kbd> ${t('header.search')}</button>
          ${this.ctx.isDesktopApp ? '' : `<button class="copy-link-btn" id="copyLinkBtn">${t('header.copyLink')}</button>`}
          ${this.ctx.isDesktopApp ? '' : `<button class="fullscreen-btn" id="fullscreenBtn" title="${t('header.fullscreen')}">⛶</button>`}
          ${SITE_VARIANT === 'happy' ? `<button class="tv-mode-btn" id="tvModeBtn" title="TV Mode (Shift+T)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></button>` : ''}
          <span id="unifiedSettingsMount"></span>
          <span id="authWidgetMount"></span>
        </div>
      </div>
      <div class="mobile-menu-overlay" id="mobileMenuOverlay"></div>
      <nav class="mobile-menu" id="mobileMenu">
        <div class="mobile-menu-header">
          <span class="mobile-menu-title">WORLD MONITOR</span>
          <button class="mobile-menu-close" id="mobileMenuClose" aria-label="Close menu">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="mobile-menu-divider"></div>
        ${(() => {
        const variants = [
          { key: 'full', icon: '🌍', label: t('header.world') },
          { key: 'tech', icon: '💻', label: t('header.tech') },
          { key: 'finance', icon: '📈', label: t('header.finance') },
          { key: 'commodity', icon: '⛏️', label: t('header.commodity') },
          { key: 'happy', icon: '☀️', label: 'Good News' },
        ];
        return variants.map(v =>
          `<button class="mobile-menu-item mobile-menu-variant ${v.key === SITE_VARIANT ? 'active' : ''}" data-variant="${v.key}">
            <span class="mobile-menu-item-icon">${v.icon}</span>
            <span class="mobile-menu-item-label">${v.label}</span>
            ${v.key === SITE_VARIANT ? '<span class="mobile-menu-check">✓</span>' : ''}
          </button>`
        ).join('');
      })()}
        <div class="mobile-menu-divider"></div>
        <button class="mobile-menu-item" id="mobileMenuRegion">
          <span class="mobile-menu-item-icon">🌐</span>
          <span class="mobile-menu-item-label">${t('components.deckgl.views.global')}</span>
          <span class="mobile-menu-chevron">▸</span>
        </button>
        <div class="mobile-menu-divider"></div>
        <button class="mobile-menu-item" id="mobileMenuSettings">
          <span class="mobile-menu-item-icon">⚙️</span>
          <span class="mobile-menu-item-label">${t('header.settings')}</span>
        </button>
        <button class="mobile-menu-item" id="mobileMenuTheme">
          <span class="mobile-menu-item-icon">${getCurrentTheme() === 'dark' ? '☀️' : '🌙'}</span>
          <span class="mobile-menu-item-label">${getCurrentTheme() === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>
        </button>
        <a class="mobile-menu-item" href="https://x.com/eliehabib" target="_blank" rel="noopener">
          <span class="mobile-menu-item-icon"><svg class="x-logo" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg></span>
          <span class="mobile-menu-item-label">@eliehabib</span>
        </a>
        <div class="mobile-menu-divider"></div>
        <div class="mobile-menu-footer-links">
          <a href="${this.ctx.isDesktopApp ? 'https://worldmonitor.app/pro' : 'https://www.worldmonitor.app/pro'}" target="_blank" rel="noopener">Pro</a>
          <a href="${this.ctx.isDesktopApp ? 'https://worldmonitor.app/blog/' : 'https://www.worldmonitor.app/blog/'}" target="_blank" rel="noopener">Blog</a>
          <a href="${this.ctx.isDesktopApp ? 'https://worldmonitor.app/docs' : 'https://www.worldmonitor.app/docs'}" target="_blank" rel="noopener">Docs</a>
          <a href="https://status.worldmonitor.app/" target="_blank" rel="noopener">Status</a>
        </div>
        <div class="mobile-menu-version">v${__APP_VERSION__}</div>
      </nav>
      <div class="region-sheet-backdrop" id="regionSheetBackdrop"></div>
      <div class="region-bottom-sheet" id="regionBottomSheet">
        <div class="region-sheet-header">${t('header.selectRegion')}</div>
        <div class="region-sheet-divider"></div>
        ${[
        { value: 'global', label: t('components.deckgl.views.global') },
        { value: 'america', label: t('components.deckgl.views.americas') },
        { value: 'mena', label: t('components.deckgl.views.mena') },
        { value: 'eu', label: t('components.deckgl.views.europe') },
        { value: 'asia', label: t('components.deckgl.views.asia') },
        { value: 'latam', label: t('components.deckgl.views.latam') },
        { value: 'africa', label: t('components.deckgl.views.africa') },
        { value: 'oceania', label: t('components.deckgl.views.oceania') },
      ].map(r =>
        `<button class="region-sheet-option ${r.value === 'global' ? 'active' : ''}" data-region="${r.value}">
          <span>${r.label}</span>
          <span class="region-sheet-check">${r.value === 'global' ? '✓' : ''}</span>
        </button>`
      ).join('')}
      </div>
      <div class="main-content${this.ctx.isDesktopApp ? ' desktop-grid' : ''}">
        <div class="map-section" id="mapSection">
          <div class="panel-header">
            <div class="panel-header-left">
              <span class="panel-title">${SITE_VARIANT === 'tech' ? t('panels.techMap') : SITE_VARIANT === 'happy' ? 'Good News Map' : t('panels.map')}</span>
            </div>
            <span class="header-clock" id="headerClock" translate="no"></span>
            <div class="map-header-actions">
              <div class="map-dimension-toggle" id="mapDimensionToggle">
                <button class="map-dim-btn${loadFromStorage<string>(STORAGE_KEYS.mapMode, 'flat') === 'globe' ? '' : ' active'}" data-mode="flat" title="2D Map">2D</button>
                <button class="map-dim-btn${loadFromStorage<string>(STORAGE_KEYS.mapMode, 'flat') === 'globe' ? ' active' : ''}" data-mode="globe" title="3D Globe">3D</button>
              </div>
              <button class="map-pin-btn" id="mapFullscreenBtn" title="Fullscreen">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
              </button>
              <button class="map-pin-btn" id="mapPinBtn" title="${t('header.pinMap')}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 17v5M9 10.76a2 2 0 01-1.11 1.79l-1.78.9A2 2 0 005 15.24V16a1 1 0 001 1h12a1 1 0 001-1v-.76a2 2 0 00-1.11-1.79l-1.78-.9A2 2 0 0115 10.76V7a1 1 0 011-1 1 1 0 001-1V4a1 1 0 00-1-1H8a1 1 0 00-1 1v1a1 1 0 001 1 1 1 0 011 1v3.76z"/>
                </svg>
              </button>
            </div>
          </div>
          <div class="map-container" id="mapContainer"></div>
          ${SITE_VARIANT === 'happy' ? '<button class="tv-exit-btn" id="tvExitBtn">Exit TV Mode</button>' : ''}
          <div class="map-resize-handle" id="mapResizeHandle"></div>
          <div class="map-bottom-grid" id="mapBottomGrid"></div>
        </div>
        <div class="map-width-resize-handle" id="mapWidthResizeHandle"></div>
        <div class="panels-grid" id="panelsGrid"></div>
        <button class="search-mobile-fab" id="searchMobileFab" aria-label="Search">\u{1F50D}</button>
      </div>
      <footer class="site-footer">
        <div class="site-footer-brand">
          <img src="/favico/favicon-32x32.png" alt="" width="28" height="28" class="site-footer-icon" />
          <div class="site-footer-brand-text">
            <span class="site-footer-name">WORLD MONITOR</span>
            <span class="site-footer-sub">v${__APP_VERSION__} &middot; <a href="https://x.com/eliehabib" target="_blank" rel="noopener" class="site-footer-credit">@eliehabib</a></span>
          </div>
        </div>
        <nav>
          <a href="${this.ctx.isDesktopApp ? 'https://worldmonitor.app/pro' : 'https://www.worldmonitor.app/pro'}" target="_blank" rel="noopener">Pro</a>
          <a href="${this.ctx.isDesktopApp ? 'https://worldmonitor.app/blog/' : 'https://www.worldmonitor.app/blog/'}" target="_blank" rel="noopener">Blog</a>
          <a href="${this.ctx.isDesktopApp ? 'https://worldmonitor.app/docs' : 'https://www.worldmonitor.app/docs'}" target="_blank" rel="noopener">Docs</a>
          <a href="https://status.worldmonitor.app/" target="_blank" rel="noopener">Status</a>
          <a href="https://github.com/koala73/worldmonitor" target="_blank" rel="noopener">GitHub</a>
          <a href="https://discord.gg/re63kWKxaz" target="_blank" rel="noopener">Discord</a>
          <a href="https://x.com/worldmonitorai" target="_blank" rel="noopener">X</a>
          ${this.ctx.isDesktopApp ? '' : `<span id="footerDownloadMount"></span>`}
        </nav>
        <span class="site-footer-copy">&copy; ${new Date().getFullYear()} World Monitor</span>
      </footer>
    `;

    this.createPanels();

    if (this.ctx.isMobile) {
      this.setupMobileMapToggle();
    }
  }

  private setupMobileMapToggle(): void {
    const mapSection = document.getElementById('mapSection');
    const headerLeft = mapSection?.querySelector('.panel-header-left');
    if (!mapSection || !headerLeft) return;

    const stored = localStorage.getItem('mobile-map-collapsed');
    const collapsed = stored === 'true';
    if (collapsed) mapSection.classList.add('collapsed');

    const updateBtn = (btn: HTMLButtonElement, isCollapsed: boolean) => {
      btn.textContent = isCollapsed ? `▶ ${t('components.map.showMap')}` : `▼ ${t('components.map.hideMap')}`;
    };

    const btn = document.createElement('button');
    btn.className = 'map-collapse-btn';
    updateBtn(btn, collapsed);
    headerLeft.after(btn);

    btn.addEventListener('click', () => {
      const isCollapsed = mapSection.classList.toggle('collapsed');
      updateBtn(btn, isCollapsed);
      localStorage.setItem('mobile-map-collapsed', String(isCollapsed));
      if (!isCollapsed) window.dispatchEvent(new Event('resize'));
    });
  }

  renderCriticalBanner(postures: TheaterPostureSummary[]): void {
    if (this.ctx.isMobile) {
      if (this.criticalBannerEl) {
        this.criticalBannerEl.remove();
        this.criticalBannerEl = null;
      }
      document.body.classList.remove('has-critical-banner');
      return;
    }

    const dismissedAt = sessionStorage.getItem('banner-dismissed');
    if (dismissedAt && Date.now() - parseInt(dismissedAt, 10) < 30 * 60 * 1000) {
      return;
    }

    const critical = postures.filter(
      (p) => p.postureLevel === 'critical' || (p.postureLevel === 'elevated' && p.strikeCapable)
    );

    if (critical.length === 0) {
      if (this.criticalBannerEl) {
        this.criticalBannerEl.remove();
        this.criticalBannerEl = null;
        document.body.classList.remove('has-critical-banner');
      }
      return;
    }

    const top = critical[0]!;
    const isCritical = top.postureLevel === 'critical';

    if (!this.criticalBannerEl) {
      this.criticalBannerEl = document.createElement('div');
      this.criticalBannerEl.className = 'critical-posture-banner';
      const header = document.querySelector('.header');
      if (header) header.insertAdjacentElement('afterend', this.criticalBannerEl);
    }

    document.body.classList.add('has-critical-banner');
    this.criticalBannerEl.className = `critical-posture-banner ${isCritical ? 'severity-critical' : 'severity-elevated'}`;
    this.criticalBannerEl.innerHTML = `
      <div class="banner-content">
        <span class="banner-icon">${isCritical ? '🚨' : '⚠️'}</span>
        <span class="banner-headline">${escapeHtml(top.headline)}</span>
        <span class="banner-stats">${top.totalAircraft} aircraft • ${escapeHtml(top.summary)}</span>
        ${top.strikeCapable ? '<span class="banner-strike">STRIKE CAPABLE</span>' : ''}
      </div>
      <button class="banner-view" data-lat="${top.centerLat}" data-lon="${top.centerLon}">View Region</button>
      <button class="banner-dismiss">×</button>
    `;

    this.criticalBannerEl.querySelector('.banner-view')?.addEventListener('click', () => {
      console.log('[Banner] View Region clicked:', top.theaterId, 'lat:', top.centerLat, 'lon:', top.centerLon);
      trackCriticalBannerAction('view', top.theaterId);
      if (typeof top.centerLat === 'number' && typeof top.centerLon === 'number') {
        this.ctx.map?.setCenter(top.centerLat, top.centerLon, 4);
      } else {
        console.error('[Banner] Missing coordinates for', top.theaterId);
      }
    });

    this.criticalBannerEl.querySelector('.banner-dismiss')?.addEventListener('click', () => {
      trackCriticalBannerAction('dismiss', top.theaterId);
      this.criticalBannerEl?.classList.add('dismissed');
      document.body.classList.remove('has-critical-banner');
      sessionStorage.setItem('banner-dismissed', Date.now().toString());
    });
  }

  applyPanelSettings(): void {
    Object.entries(this.ctx.panelSettings).forEach(([key, config]) => {
      if (key === 'map') {
        const mapSection = document.getElementById('mapSection');
        if (mapSection) {
          mapSection.classList.toggle('hidden', !config.enabled);
          const mainContent = document.querySelector('.main-content');
          if (mainContent) {
            mainContent.classList.toggle('map-hidden', !config.enabled);
          }
          this.ensureCorrectZones();
        }
        return;
      }
      const panel = this.ctx.panels[key];
      panel?.toggle(config.enabled);
    });
  }

  /**
   * Lazily instantiates and mounts LiveNewsPanel when channels become available
   * mid-session (e.g. user adds channels via the standalone manager on a variant
   * whose defaults are empty). No-op if the panel already exists or still has no
   * channels. Called from the liveChannels storage event handler.
   */
  mountLiveNewsIfReady(): void {
    if (this.ctx.panels['live-news']) return;
    if (getDefaultLiveChannels().length === 0 && loadChannelsFromStorage().length === 0) return;
    const panel = new LiveNewsPanel();
    this.ctx.panels['live-news'] = panel;
    const el = panel.getElement();
    this.makeDraggable(el, 'live-news');
    const grid = document.getElementById('panelsGrid');
    if (grid) {
      const addBlock = grid.querySelector('.add-panel-block');
      if (addBlock) grid.insertBefore(el, addBlock);
      else grid.appendChild(el);
    }
    this.applyPanelSettings();
  }

  private shouldCreatePanel(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.ctx.panelSettings, key);
  }

  private static readonly NEWS_PANEL_TOOLTIPS: Record<string, string> = {
    centralbanks: t('components.centralBankWatch.infoTooltip'),
  };

  private createNewsPanel(key: string, labelKey: string): NewsPanel | null {
    if (!this.shouldCreatePanel(key)) return null;
    const panel = new NewsPanel(key, t(labelKey), PanelLayoutManager.NEWS_PANEL_TOOLTIPS[key]);
    this.attachRelatedAssetHandlers(panel);
    panel.setRiskScoreGetter(PanelLayoutManager.computeEventRisk);
    this.ctx.newsPanels[key] = panel;
    this.ctx.panels[key] = panel;
    return panel;
  }

  // 0-100 event risk score: 0.40×severity + 0.30×geoConvergence + 0.30×CII
  // CII component omitted until lat/lon→country lookup is added; weights rebalanced to 0.57+0.43
  private static computeEventRisk(cluster: ClusteredEvent): number | null {
    if (!cluster.threat) return null;
    const levelScore: Record<string, number> = { critical: 95, high: 75, medium: 50, low: 25, info: 10 };
    const severity = (levelScore[cluster.threat.level] ?? 10) * (cluster.threat.confidence ?? 1);

    const geoAlert = (cluster.lat != null && cluster.lon != null)
      ? getAlertsNearLocation(cluster.lat, cluster.lon, 500)
      : null;
    const geoScore = geoAlert?.score ?? 0;

    // Rebalanced (CII pending): 0.57×severity + 0.43×geoConvergence
    return Math.round(0.57 * severity + 0.43 * geoScore);
  }

  private createPanel<T extends import('@/components/Panel').Panel>(key: string, factory: () => T): T | null {
    if (!this.shouldCreatePanel(key)) return null;
    const panel = factory();
    this.ctx.panels[key] = panel;
    return panel;
  }

  private createPanels(): void {
    const panelsGrid = document.getElementById('panelsGrid')!;

    const mapContainer = document.getElementById('mapContainer') as HTMLElement;
    const preferGlobe = loadFromStorage<string>(STORAGE_KEYS.mapMode, 'flat') === 'globe';
    this.ctx.map = new MapContainer(mapContainer, {
      zoom: this.ctx.isMobile ? 2.5 : 1.0,
      pan: { x: 0, y: 0 },
      view: this.ctx.isMobile ? this.ctx.resolvedLocation : 'global',
      layers: this.ctx.mapLayers,
      timeRange: '7d',
    }, preferGlobe);

    if (this.ctx.mapLayers.resilienceScore && !this.ctx.map.isDeckGLActive?.()) {
      this.ctx.mapLayers = { ...this.ctx.mapLayers, resilienceScore: false };
      saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
    }

    this.ctx.map.initEscalationGetters();
    this.ctx.currentTimeRange = this.ctx.map.getTimeRange();

    this.createNewsPanel('politics', 'panels.politics');
    this.createNewsPanel('tech', 'panels.tech');
    this.createNewsPanel('finance', 'panels.finance');

    this.createPanel('heatmap', () => new HeatmapPanel());
    this.createPanel('markets', () => new MarketPanel());
    this.createPanel('stock-analysis', () => new StockAnalysisPanel());
    this.createPanel('stock-backtest', () => new StockBacktestPanel());
    // Web premium gating for stock-analysis and stock-backtest is handled
    // reactively by updatePanelGating() via auth state subscription.

    const monitorPanel = this.createPanel('monitors', () => new MonitorPanel(this.ctx.monitors));
    monitorPanel?.onChanged((monitors) => {
      this.ctx.monitors = monitors;
      saveToStorage(STORAGE_KEYS.monitors, monitors);
      this.callbacks.updateMonitorResults();
    });

    this.createPanel('commodities', () => new CommoditiesPanel());
    this.createPanel('energy-complex', () => new EnergyComplexPanel());
    this.createPanel('polymarket', () => new PredictionPanel());

    this.createNewsPanel('gov', 'panels.gov');
    this.createNewsPanel('intel', 'panels.intel');

    this.createPanel('crypto', () => new CryptoPanel());
    this.createPanel('crypto-heatmap', () => new CryptoHeatmapPanel());
    this.createPanel('defi-tokens', () => new DefiTokensPanel());
    this.createPanel('ai-tokens', () => new AiTokensPanel());
    this.createPanel('other-tokens', () => new OtherTokensPanel());
    this.createNewsPanel('middleeast', 'panels.middleeast');
    this.createNewsPanel('layoffs', 'panels.layoffs');
    this.createNewsPanel('ai', 'panels.ai');
    this.createNewsPanel('startups', 'panels.startups');
    this.createNewsPanel('vcblogs', 'panels.vcblogs');
    this.createNewsPanel('regionalStartups', 'panels.regionalStartups');
    this.createNewsPanel('unicorns', 'panels.unicorns');
    this.createNewsPanel('accelerators', 'panels.accelerators');
    this.createNewsPanel('funding', 'panels.funding');
    this.createNewsPanel('producthunt', 'panels.producthunt');
    this.createNewsPanel('security', 'panels.security');
    this.createNewsPanel('policy', 'panels.policy');
    this.createNewsPanel('hardware', 'panels.hardware');
    this.createNewsPanel('cloud', 'panels.cloud');
    this.createNewsPanel('dev', 'panels.dev');
    this.createNewsPanel('github', 'panels.github');
    this.createNewsPanel('ipo', 'panels.ipo');
    this.createNewsPanel('thinktanks', 'panels.thinktanks');
    this.createPanel('economic', () => new EconomicPanel());
    this.createPanel('consumer-prices', () => new ConsumerPricesPanel());

    this.createPanel('trade-policy', () => new TradePolicyPanel());
    this.createPanel('sanctions-pressure', () => new SanctionsPressurePanel());
    const supplyChainPanel = this.createPanel('supply-chain', () => new SupplyChainPanel());
    if (supplyChainPanel) {
      supplyChainPanel.setOnScenarioActivate((id, result) => {
        this.ctx.map?.activateScenario(id, result);
      });
      supplyChainPanel.setOnDismissScenario(() => {
        this.ctx.map?.deactivateScenario();
      });
      this.ctx.map?.setSupplyChainPanel(supplyChainPanel);
    }

    this.createNewsPanel('africa', 'panels.africa');
    this.createNewsPanel('latam', 'panels.latam');
    this.createNewsPanel('asia', 'panels.asia');
    this.createNewsPanel('energy', 'panels.energy');

    for (const key of Object.keys(FEEDS)) {
      if (this.ctx.newsPanels[key]) continue;
      if (!Array.isArray((FEEDS as Record<string, unknown>)[key])) continue;
      const panelKey = this.ctx.panels[key] && !this.ctx.newsPanels[key] ? `${key}-news` : key;
      if (this.ctx.panels[panelKey]) continue;
      if (!this.ctx.panelSettings[panelKey] && !this.ctx.panelSettings[key]) continue;
      const panelConfig = this.ctx.panelSettings[panelKey] ?? this.ctx.panelSettings[key] ?? ALL_PANELS[panelKey] ?? ALL_PANELS[key];
      const label = panelConfig?.name ?? key.charAt(0).toUpperCase() + key.slice(1);
      const tooltip = PanelLayoutManager.NEWS_PANEL_TOOLTIPS[panelKey] ?? PanelLayoutManager.NEWS_PANEL_TOOLTIPS[key];
      const panel = new NewsPanel(panelKey, label, tooltip);
      this.attachRelatedAssetHandlers(panel);
      panel.setRiskScoreGetter(PanelLayoutManager.computeEventRisk);
      this.ctx.newsPanels[key] = panel;
      this.ctx.panels[panelKey] = panel;
    }

    this.createPanel('gdelt-intel', () => new GdeltIntelPanel());

    import('@/components/DeductionPanel').then(({ DeductionPanel }) => {
      const deductionPanel = new DeductionPanel(() => this.ctx.allNews);
      this.ctx.panels['deduction'] = deductionPanel;
      const el = deductionPanel.getElement();
      this.makeDraggable(el, 'deduction');
      const grid = document.getElementById('panelsGrid');
      if (grid) {
        const gdeltEl = this.ctx.panels['gdelt-intel']?.getElement();
        if (gdeltEl?.parentNode === grid && gdeltEl.nextSibling) {
          grid.insertBefore(el, gdeltEl.nextSibling);
        } else {
          grid.appendChild(el);
        }
      }
      this.applyPanelSettings();
      this.updatePanelGating(getAuthState());
    });

    import('@/components/RegionalIntelligenceBoard').then(({ RegionalIntelligenceBoard }) => {
      const regionalBoard = new RegionalIntelligenceBoard();
      this.ctx.panels['regional-intelligence'] = regionalBoard;
      const el = regionalBoard.getElement();
      this.makeDraggable(el, 'regional-intelligence');
      const grid = document.getElementById('panelsGrid');
      if (grid) {
        const deductionEl = this.ctx.panels['deduction']?.getElement();
        if (deductionEl?.parentNode === grid && deductionEl.nextSibling) {
          grid.insertBefore(el, deductionEl.nextSibling);
        } else {
          grid.appendChild(el);
        }
      }
      this.applyPanelSettings();
      this.updatePanelGating(getAuthState());
    });

    if (this.shouldCreatePanel('cii')) {
      const ciiPanel = new CIIPanel();
      ciiPanel.setShareStoryHandler((code, name) => {
        this.callbacks.openCountryStory(code, name);
      });
      ciiPanel.setCountryClickHandler((code) => {
        this.callbacks.openCountryBrief(code);
      });
      this.ctx.panels['cii'] = ciiPanel;
    }

    this.createPanel('cascade', () => new CascadePanel());
    this.createPanel('satellite-fires', () => new SatelliteFiresPanel());

    this.createPanel('defense-patents', () => new DefensePatentsPanel());

    // Correlation engine panels
    if (this.shouldCreatePanel('military-correlation')) {
      const p = new MilitaryCorrelationPanel();
      p.setMapNavigateHandler((lat, lon) => { this.ctx.map?.setCenter(lat, lon, 6); });
      this.ctx.panels['military-correlation'] = p;
    }
    if (this.shouldCreatePanel('escalation-correlation')) {
      const p = new EscalationCorrelationPanel();
      p.setMapNavigateHandler((lat, lon) => { this.ctx.map?.setCenter(lat, lon, 4); });
      this.ctx.panels['escalation-correlation'] = p;
    }
    if (this.shouldCreatePanel('economic-correlation')) {
      const p = new EconomicCorrelationPanel();
      p.setMapNavigateHandler((lat, lon) => { this.ctx.map?.setCenter(lat, lon, 4); });
      this.ctx.panels['economic-correlation'] = p;
    }
    if (this.shouldCreatePanel('disaster-correlation')) {
      const p = new DisasterCorrelationPanel();
      p.setMapNavigateHandler((lat, lon) => { this.ctx.map?.setCenter(lat, lon, 5); });
      this.ctx.panels['disaster-correlation'] = p;
    }

    if (this.shouldCreatePanel('strategic-risk')) {
      const strategicRiskPanel = new StrategicRiskPanel();
      strategicRiskPanel.setLocationClickHandler((lat, lon) => {
        this.ctx.map?.setCenter(lat, lon, 4);
      });
      this.ctx.panels['strategic-risk'] = strategicRiskPanel;
    }

    if (this.shouldCreatePanel('strategic-posture')) {
      const strategicPosturePanel = new StrategicPosturePanel(() => this.ctx.allNews);
      strategicPosturePanel.setLocationClickHandler((lat, lon) => {
        console.log('[App] StrategicPosture handler called:', { lat, lon, hasMap: !!this.ctx.map });
        this.ctx.map?.setCenter(lat, lon, 4);
      });
      this.ctx.panels['strategic-posture'] = strategicPosturePanel;
    }

    if (this.shouldCreatePanel('ucdp-events')) {
      const ucdpEventsPanel = new UcdpEventsPanel();
      ucdpEventsPanel.setEventClickHandler((lat, lon) => {
        this.ctx.map?.setCenter(lat, lon, 5);
      });
      this.ctx.panels['ucdp-events'] = ucdpEventsPanel;
    }

    this.createPanel('disease-outbreaks', () => new DiseaseOutbreaksPanel());
    this.createPanel('social-velocity', () => new SocialVelocityPanel());
    this.createPanel('wsb-ticker-scanner', () => new WsbTickerScannerPanel());

    this.lazyPanel('displacement', () =>
      import('@/components/DisplacementPanel').then(m => {
        const p = new m.DisplacementPanel();
        p.setCountryClickHandler((lat: number, lon: number) => { this.ctx.map?.setCenter(lat, lon, 4); });
        return p;
      }),
    );

    this.lazyPanel('climate', () =>
      import('@/components/ClimateAnomalyPanel').then(m => {
        const p = new m.ClimateAnomalyPanel();
        p.setZoneClickHandler((lat: number, lon: number) => { this.ctx.map?.setCenter(lat, lon, 4); });
        return p;
      }),
    );

    this.lazyPanel('population-exposure', () =>
      import('@/components/PopulationExposurePanel').then(m => new m.PopulationExposurePanel()),
    );

    this.lazyPanel('security-advisories', () =>
      import('@/components/SecurityAdvisoriesPanel').then(m => {
        const p = new m.SecurityAdvisoriesPanel();
        p.setRefreshHandler(() => { void this.callbacks.loadSecurityAdvisories?.(); });
        return p;
      }),
    );

    this.lazyPanel('radiation-watch', () =>
      import('@/components/RadiationWatchPanel').then(m => {
        const p = new m.RadiationWatchPanel();
        p.setLocationClickHandler((lat: number, lon: number) => { this.ctx.map?.setCenter(lat, lon, 4); });
        return p;
      }),
    );

    this.lazyPanel('thermal-escalation', () =>
      import('@/components/ThermalEscalationPanel').then(m => {
        const p = new m.ThermalEscalationPanel();
        p.setLocationClickHandler((lat: number, lon: number) => { this.ctx.map?.setCenter(lat, lon, 4); });
        return p;
      }),
    );

    const _lockPanels = this.ctx.isDesktopApp && !hasPremiumAccess();

    this.lazyPanel('daily-market-brief', () =>
      import('@/components/DailyMarketBriefPanel').then(m => new m.DailyMarketBriefPanel()),
    );

    this.lazyPanel('market-implications', () =>
      import('@/components/MarketImplicationsPanel').then(m => new m.MarketImplicationsPanel()),
    );
    // Gating for daily-market-brief, market-implications, and chat-analyst is handled
    // reactively by updatePanelGating() via auth state subscription (all in WEB_PREMIUM_PANELS).

    this.lazyPanel('chat-analyst', () =>
      import('@/components/ChatAnalystPanel').then(m => new m.ChatAnalystPanel()),
    );

    this.lazyPanel('forecast', () =>
      import('@/components/ForecastPanel').then(m => new m.ForecastPanel()),
      undefined,
      _lockPanels ? ['AI-powered geopolitical forecasts', 'Cross-domain cascade predictions', 'Prediction market calibration'] : undefined,
    );

    this.lazyPanel('oref-sirens', () =>
      import('@/components/OrefSirensPanel').then(m => new m.OrefSirensPanel()),
      undefined,
      _lockPanels ? [t('premium.features.orefSirens1'), t('premium.features.orefSirens2')] : undefined,
    );

    this.lazyPanel('telegram-intel', () =>
      import('@/components/TelegramIntelPanel').then(m => new m.TelegramIntelPanel()),
      undefined,
      _lockPanels ? [t('premium.features.telegramIntel1'), t('premium.features.telegramIntel2')] : undefined,
    );

    if (this.shouldCreatePanel('gcc-investments')) {
      const investmentsPanel = new InvestmentsPanel((inv) => {
        focusInvestmentOnMap(this.ctx.map, this.ctx.mapLayers, inv.lat, inv.lon);
      });
      this.ctx.panels['gcc-investments'] = investmentsPanel;
    }

    if (this.shouldCreatePanel('world-clock')) {
      this.ctx.panels['world-clock'] = new WorldClockPanel();
    }

    if (this.shouldCreatePanel('airline-intel')) {
      this.ctx.panels['airline-intel'] = new AirlineIntelPanel();
      this.aviationCommandBar = new AviationCommandBar();
    }

    if (this.shouldCreatePanel('gulf-economies') && !this.ctx.panels['gulf-economies']) {
      this.ctx.panels['gulf-economies'] = new GulfEconomiesPanel();
    }

    if (this.shouldCreatePanel('grocery-basket') && !this.ctx.panels['grocery-basket']) {
      this.ctx.panels['grocery-basket'] = new GroceryBasketPanel();
    }

    if (this.shouldCreatePanel('bigmac') && !this.ctx.panels['bigmac']) {
      this.ctx.panels['bigmac'] = new BigMacPanel();
    }

    if (this.shouldCreatePanel('fuel-prices') && !this.ctx.panels['fuel-prices']) {
      this.ctx.panels['fuel-prices'] = new FuelPricesPanel();
    }

    if (this.shouldCreatePanel('fao-food-price-index') && !this.ctx.panels['fao-food-price-index']) {
      this.ctx.panels['fao-food-price-index'] = new FaoFoodPriceIndexPanel();
    }

    if (this.shouldCreatePanel('climate-news') && !this.ctx.panels['climate-news']) {
      this.ctx.panels['climate-news'] = new ClimateNewsPanel();
    }

    if (this.shouldCreatePanel('live-news') &&
        (getDefaultLiveChannels().length > 0 || loadChannelsFromStorage().length > 0)) {
      this.ctx.panels['live-news'] = new LiveNewsPanel();
    }

    if (this.shouldCreatePanel('live-webcams')) {
      this.ctx.panels['live-webcams'] = new LiveWebcamsPanel();
    }

    if (this.shouldCreatePanel('windy-webcams')) {
      this.ctx.panels['windy-webcams'] = new PinnedWebcamsPanel();
    }

    this.createPanel('events', () => new TechEventsPanel('events', () => this.ctx.allNews));
    this.createPanel('internet-disruptions', () => new InternetDisruptionsPanel());
    this.createPanel('service-status', () => new ServiceStatusPanel());

    this.lazyPanel('tech-readiness', () =>
      import('@/components/TechReadinessPanel').then(m => {
        const p = new m.TechReadinessPanel();
        void p.refresh();
        return p;
      }),
    );

    this.lazyPanel('national-debt', () =>
      import('@/components/NationalDebtPanel').then(m => {
        const p = new m.NationalDebtPanel();
        void p.refresh();
        return p;
      }),
    );

    this.lazyPanel('cross-source-signals', () =>
      import('@/components/CrossSourceSignalsPanel').then(m => new m.CrossSourceSignalsPanel()),
    );

    this.lazyPanel('geo-hubs', () =>
      import('@/components/GeoHubsPanel').then(m => {
        const p = new m.GeoHubsPanel();
        p.setOnHubClick((hub) => { this.ctx.map?.setCenter(hub.lat, hub.lon, 4); });
        return p;
      }),
    );

    this.lazyPanel('tech-hubs', () =>
      import('@/components/TechHubsPanel').then(m => {
        const p = new m.TechHubsPanel();
        p.setOnHubClick((hub) => { this.ctx.map?.setCenter(hub.lat, hub.lon, 4); });
        return p;
      }),
    );

    this.lazyPanel('ai-regulation', () =>
      import('@/components/RegulationPanel').then(m => new m.RegulationPanel('ai-regulation')),
    );

    this.createPanel('macro-signals', () => new MacroSignalsPanel());
    this.createPanel('fear-greed', () => new FearGreedPanel());
    this.createPanel('aaii-sentiment', () => new AAIISentimentPanel());
    this.createPanel('market-breadth', () => new MarketBreadthPanel());
    this.createPanel('macro-tiles', () => new MacroTilesPanel());
    this.createPanel('fsi', () => new FSIPanel());
    this.createPanel('yield-curve', () => new YieldCurvePanel());
    this.createPanel('earnings-calendar', () => new EarningsCalendarPanel());
    this.createPanel('economic-calendar', () => new EconomicCalendarPanel());
    this.createPanel('cot-positioning', () => new CotPositioningPanel());
    this.createPanel('hormuz-tracker', () => new HormuzPanel());
    this.createPanel('etf-flows', () => new ETFFlowsPanel());
    this.createPanel('stablecoins', () => new StablecoinPanel());

    if (this.ctx.isDesktopApp) {
      const runtimeConfigPanel = new RuntimeConfigPanel({ mode: 'alert' });
      this.ctx.panels['runtime-config'] = runtimeConfigPanel;
    }

    this.createPanel('insights', () => new InsightsPanel());

    // Global Giving panel (all variants)
    this.lazyPanel('giving', () =>
      import('@/components/GivingPanel').then(m => new m.GivingPanel()),
    );

    // Happy variant panels (lazy-loaded — only relevant for happy variant)
    if (SITE_VARIANT === 'happy') {
      this.lazyPanel('positive-feed', () =>
        import('@/components/PositiveNewsFeedPanel').then(m => {
          const p = new m.PositiveNewsFeedPanel();
          this.ctx.positivePanel = p;
          return p;
        }),
      );

      this.lazyPanel('counters', () =>
        import('@/components/CountersPanel').then(m => {
          const p = new m.CountersPanel();
          p.startTicking();
          this.ctx.countersPanel = p;
          return p;
        }),
      );

      this.lazyPanel('progress', () =>
        import('@/components/ProgressChartsPanel').then(m => {
          const p = new m.ProgressChartsPanel();
          this.ctx.progressPanel = p;
          return p;
        }),
      );

      this.lazyPanel('breakthroughs', () =>
        import('@/components/BreakthroughsTickerPanel').then(m => {
          const p = new m.BreakthroughsTickerPanel();
          this.ctx.breakthroughsPanel = p;
          return p;
        }),
      );

      this.lazyPanel('spotlight', () =>
        import('@/components/HeroSpotlightPanel').then(m => {
          const p = new m.HeroSpotlightPanel();
          p.onLocationRequest = (lat: number, lon: number) => {
            this.ctx.map?.setCenter(lat, lon, 4);
            this.ctx.map?.flashLocation(lat, lon, 3000);
          };
          this.ctx.heroPanel = p;
          return p;
        }),
      );

      this.lazyPanel('digest', () =>
        import('@/components/GoodThingsDigestPanel').then(m => {
          const p = new m.GoodThingsDigestPanel();
          this.ctx.digestPanel = p;
          return p;
        }),
      );

      this.lazyPanel('species', () =>
        import('@/components/SpeciesComebackPanel').then(m => {
          const p = new m.SpeciesComebackPanel();
          this.ctx.speciesPanel = p;
          return p;
        }),
      );

      this.lazyPanel('renewable', () =>
        import('@/components/RenewableEnergyPanel').then(m => {
          const p = new m.RenewableEnergyPanel();
          this.ctx.renewablePanel = p;
          return p;
        }),
      );
    }

    // Always load custom widgets — Pro gating is handled reactively by auth state.
    for (const spec of loadWidgets()) {
      const panel = new CustomWidgetPanel(spec);
      this.ctx.panels[spec.id] = panel;
      if (!this.ctx.panelSettings[spec.id]) {
        this.ctx.panelSettings[spec.id] = { name: spec.title, enabled: true, priority: 3 };
      }
    }

    for (const spec of loadMcpPanels()) {
      const panel = new McpDataPanel(spec);
      this.ctx.panels[spec.id] = panel;
      if (!this.ctx.panelSettings[spec.id]) {
        this.ctx.panelSettings[spec.id] = { name: spec.title, enabled: true, priority: 3 };
      }
    }

    const variantOrder = (VARIANT_DEFAULTS[SITE_VARIANT] ?? VARIANT_DEFAULTS['full'] ?? []).filter(k => k !== 'map');
    const activePanelSet = new Set(Object.keys(this.ctx.panelSettings));
    const crossVariantKeys = Object.keys(this.ctx.panelSettings).filter(k => !variantOrder.includes(k) && k !== 'map');
    const defaultOrder = [...variantOrder.filter(k => activePanelSet.has(k)), ...crossVariantKeys];
    const activePanelKeys = Object.keys(this.ctx.panelSettings).filter(k => k !== 'map');
    const bottomSet = this.getSavedBottomSet();
    const savedOrder = this.getSavedPanelOrder();
    this.bottomSetMemory = bottomSet;
    const effectiveUltraWide = this.getEffectiveUltraWide();
    this.wasUltraWide = effectiveUltraWide;

    const hasSavedOrder = savedOrder.length > 0;
    let allOrder: string[];

    if (hasSavedOrder) {
      const valid = savedOrder.filter(k => activePanelKeys.includes(k));
      const missing = activePanelKeys.filter(k => !valid.includes(k));

      missing.forEach(k => {
        if (k === 'monitors') return;
        const defaultIdx = defaultOrder.indexOf(k);
        if (defaultIdx === -1) { valid.push(k); return; }
        let inserted = false;
        for (let i = defaultIdx + 1; i < defaultOrder.length; i++) {
          const afterIdx = valid.indexOf(defaultOrder[i]!);
          if (afterIdx !== -1) { valid.splice(afterIdx, 0, k); inserted = true; break; }
        }
        if (!inserted) valid.push(k);
      });

      const monitorsIdx = valid.indexOf('monitors');
      if (monitorsIdx !== -1) valid.splice(monitorsIdx, 1);
      if (SITE_VARIANT !== 'happy') valid.push('monitors');
      allOrder = valid;
    } else {
      allOrder = [...defaultOrder];

      if (SITE_VARIANT !== 'happy') {
        const liveNewsIdx = allOrder.indexOf('live-news');
        if (liveNewsIdx > 0) {
          allOrder.splice(liveNewsIdx, 1);
          allOrder.unshift('live-news');
        }

        const webcamsIdx = allOrder.indexOf('live-webcams');
        if (webcamsIdx !== -1 && webcamsIdx !== allOrder.indexOf('live-news') + 1) {
          allOrder.splice(webcamsIdx, 1);
          const afterNews = allOrder.indexOf('live-news') + 1;
          allOrder.splice(afterNews, 0, 'live-webcams');
        }
      }

      if (this.ctx.isDesktopApp) {
        const runtimeIdx = allOrder.indexOf('runtime-config');
        if (runtimeIdx > 1) {
          allOrder.splice(runtimeIdx, 1);
          allOrder.splice(1, 0, 'runtime-config');
        } else if (runtimeIdx === -1) {
          allOrder.splice(1, 0, 'runtime-config');
        }
      }
    }

    this.resolvedPanelOrder = allOrder;

    const sidebarOrder = effectiveUltraWide
      ? allOrder.filter(k => !this.bottomSetMemory.has(k))
      : allOrder;
    const bottomOrder = effectiveUltraWide
      ? allOrder.filter(k => this.bottomSetMemory.has(k))
      : [];

    sidebarOrder.forEach((key: string) => {
      const panel = this.ctx.panels[key];
      if (panel && !panel.getElement().parentElement) {
        const el = panel.getElement();
        this.makeDraggable(el, key);
        panelsGrid.appendChild(el);
      }
    });

    // "+" Add Panel block at the end of the grid
    const addPanelBlock = document.createElement('button');
    addPanelBlock.className = 'add-panel-block';
    addPanelBlock.setAttribute('aria-label', t('components.panel.addPanel'));
    const addIcon = document.createElement('span');
    addIcon.className = 'add-panel-block-icon';
    addIcon.textContent = '+';
    const addLabel = document.createElement('span');
    addLabel.className = 'add-panel-block-label';
    addLabel.textContent = t('components.panel.addPanel');
    addPanelBlock.appendChild(addIcon);
    addPanelBlock.appendChild(addLabel);
    addPanelBlock.addEventListener('click', () => {
      this.ctx.unifiedSettings?.open('panels');
    });
    panelsGrid.appendChild(addPanelBlock);

    // Always create Pro and MCP add-panel blocks — show/hide reactively via auth state.
    const proBlock = document.createElement('button');
    proBlock.className = 'add-panel-block ai-widget-block ai-widget-block-pro';
    proBlock.setAttribute('aria-label', t('widgets.createInteractive'));
    const proIcon = document.createElement('span');
    proIcon.className = 'add-panel-block-icon';
    proIcon.textContent = '\u26a1';
    const proLabel = document.createElement('span');
    proLabel.className = 'add-panel-block-label';
    proLabel.textContent = t('widgets.createInteractive');
    const proBadge = document.createElement('span');
    proBadge.className = 'widget-pro-badge';
    proBadge.textContent = t('widgets.proBadge');
    proBlock.appendChild(proIcon);
    proBlock.appendChild(proLabel);
    proBlock.appendChild(proBadge);
    proBlock.addEventListener('click', () => {
      openWidgetChatModal({
        mode: 'create',
        tier: 'pro',
        onComplete: (spec) => this.addCustomWidget(spec),
      });
    });
    panelsGrid.appendChild(proBlock);

    const mcpBlock = document.createElement('button');
    mcpBlock.className = 'add-panel-block mcp-panel-block';
    mcpBlock.setAttribute('aria-label', t('mcp.connectPanel'));
    const mcpIcon = document.createElement('span');
    mcpIcon.className = 'add-panel-block-icon';
    mcpIcon.textContent = '\u26a1';
    const mcpLabel = document.createElement('span');
    mcpLabel.className = 'add-panel-block-label';
    mcpLabel.textContent = t('mcp.connectPanel');
    const mcpBadge = document.createElement('span');
    mcpBadge.className = 'widget-pro-badge';
    mcpBadge.textContent = t('widgets.proBadge');
    mcpBlock.appendChild(mcpIcon);
    mcpBlock.appendChild(mcpLabel);
    mcpBlock.appendChild(mcpBadge);
    mcpBlock.addEventListener('click', () => {
      openMcpConnectModal({
        onComplete: (spec) => this.addMcpPanel(spec),
      });
    });
    panelsGrid.appendChild(mcpBlock);

    // Reactively show/hide Pro-only UI blocks based on auth state
    const proBlocks = [proBlock, mcpBlock];
    const applyProBlockGating = (isPro: boolean) => {
      for (const block of proBlocks) {
        block.style.display = isPro ? '' : 'none';
      }
    };
    applyProBlockGating(hasPremiumAccess(getAuthState()));
    this.proBlockUnsubscribe = subscribeAuthState((state) => {
      applyProBlockGating(hasPremiumAccess(state));
    });

    const bottomGrid = document.getElementById('mapBottomGrid');
    if (bottomGrid) {
      bottomOrder.forEach(key => {
        const panel = this.ctx.panels[key];
        if (panel && !panel.getElement().parentElement) {
          const el = panel.getElement();
          this.makeDraggable(el, key);
          this.insertByOrder(bottomGrid, el, key);
        }
      });
    }

    window.addEventListener('resize', () => this.ensureCorrectZones());

    this.ctx.map.onTimeRangeChanged((range) => {
      this.ctx.currentTimeRange = range;
      this.applyTimeRangeFilterDebounced();
    });

    this.applyPanelSettings();
    this.applyInitialUrlState();

    if (import.meta.env.DEV) {
      const configured = new Set(Object.keys(ALL_PANELS).filter(k => k !== 'map'));
      const created = new Set(Object.keys(this.ctx.panels));
      const extra = [...created].filter(k => !configured.has(k) && k !== 'runtime-config' && !k.startsWith('cw-') && !k.startsWith('mcp-'));
      if (extra.length) console.warn('[PanelLayoutManager] Panels created but not in ALL_PANELS:', extra);
    }
  }

  private applyTimeRangeFilterToNewsPanels(): void {
    Object.entries(this.ctx.newsByCategory).forEach(([category, items]) => {
      const panel = this.ctx.newsPanels[category];
      if (!panel) return;
      const filtered = this.filterItemsByTimeRange(items);
      if (filtered.length === 0 && items.length > 0) {
        panel.renderFilteredEmpty(`No items in ${this.getTimeRangeLabel()}`);
        return;
      }
      panel.renderNews(filtered);
    });
  }

  private filterItemsByTimeRange(items: import('@/types').NewsItem[], range: import('@/components').TimeRange = this.ctx.currentTimeRange): import('@/types').NewsItem[] {
    if (range === 'all') return items;
    const ranges: Record<string, number> = {
      '1h': 60 * 60 * 1000, '6h': 6 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000, '48h': 48 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000, 'all': Infinity,
    };
    const cutoff = Date.now() - (ranges[range] ?? Infinity);
    return items.filter((item) => {
      const ts = item.pubDate instanceof Date ? item.pubDate.getTime() : new Date(item.pubDate).getTime();
      return Number.isFinite(ts) ? ts >= cutoff : true;
    });
  }

  private getTimeRangeLabel(): string {
    const labels: Record<string, string> = {
      '1h': 'the last hour', '6h': 'the last 6 hours',
      '24h': 'the last 24 hours', '48h': 'the last 48 hours',
      '7d': 'the last 7 days', 'all': 'all time',
    };
    return labels[this.ctx.currentTimeRange] ?? 'the last 7 days';
  }

  private applyInitialUrlState(): void {
    if (!this.ctx.initialUrlState || !this.ctx.map) return;

    const { view, zoom, lat, lon, timeRange, layers } = this.ctx.initialUrlState;

    if (view) {
      // Pass URL zoom so the preset's default zoom doesn't overwrite it.
      this.ctx.map.setView(view, zoom);
    }

    if (timeRange) {
      this.ctx.map.setTimeRange(timeRange);
    }

    if (layers) {
      let normalized = normalizeExclusiveChoropleths(layers, this.ctx.mapLayers);
      if (normalized.resilienceScore && !this.ctx.map.isDeckGLActive?.()) {
        normalized = { ...normalized, resilienceScore: false };
      }
      this.ctx.mapLayers = normalized;
      saveToStorage(STORAGE_KEYS.mapLayers, normalized);
      this.ctx.map.setLayers(normalized);
    }

    if (lat !== undefined && lon !== undefined) {
      // Always honour URL lat/lon regardless of zoom level.
      this.ctx.map.setCenter(lat, lon, zoom);
    } else if (!view && zoom !== undefined) {
      // zoom-only without a view preset: apply directly.
      this.ctx.map.setZoom(zoom);
    }

    const regionSelect = document.getElementById('regionSelect') as HTMLSelectElement;
    const currentView = this.ctx.map.getState().view;
    if (regionSelect && currentView) {
      regionSelect.value = currentView;
    }
  }

  addCustomWidget(spec: CustomWidgetSpec): void {
    saveWidget(spec);
    const panel = new CustomWidgetPanel(spec);
    this.ctx.panels[spec.id] = panel;
    this.ctx.panelSettings[spec.id] = { name: spec.title, enabled: true, priority: 3 };
    saveToStorage(STORAGE_KEYS.panels, this.ctx.panelSettings);
    const el = panel.getElement();
    this.makeDraggable(el, spec.id);
    const grid = document.getElementById('panelsGrid');
    if (grid) {
      const addBlock = grid.querySelector('.add-panel-block');
      if (addBlock) {
        grid.insertBefore(el, addBlock);
      } else {
        grid.appendChild(el);
      }
    }
    this.savePanelOrder();
    this.applyPanelSettings();
  }

  addMcpPanel(spec: McpPanelSpec): void {
    saveMcpPanel(spec);
    const panel = new McpDataPanel(spec);
    this.ctx.panels[spec.id] = panel;
    this.ctx.panelSettings[spec.id] = { name: spec.title, enabled: true, priority: 3 };
    saveToStorage(STORAGE_KEYS.panels, this.ctx.panelSettings);
    const el = panel.getElement();
    this.makeDraggable(el, spec.id);
    const grid = document.getElementById('panelsGrid');
    if (grid) {
      const addBlock = grid.querySelector('.add-panel-block');
      if (addBlock) {
        grid.insertBefore(el, addBlock);
      } else {
        grid.appendChild(el);
      }
    }
    this.savePanelOrder();
    this.applyPanelSettings();
  }

  private getSavedPanelOrder(): string[] {
    try {
      const saved = localStorage.getItem(this.ctx.PANEL_ORDER_KEY);
      if (!saved) return [];
      const parsed = JSON.parse(saved);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((v: unknown) => typeof v === 'string') as string[];
    } catch {
      return [];
    }
  }

  savePanelOrder(): void {
    const grid = document.getElementById('panelsGrid');
    const bottomGrid = document.getElementById('mapBottomGrid');
    if (!grid || !bottomGrid) return;

    const sidebarIds = Array.from(grid.children)
      .map((el) => (el as HTMLElement).dataset.panel)
      .filter((key): key is string => !!key);

    const bottomIds = Array.from(bottomGrid.children)
      .map((el) => (el as HTMLElement).dataset.panel)
      .filter((key): key is string => !!key);

    const allOrder = this.buildUnifiedOrder(sidebarIds, bottomIds);
    this.resolvedPanelOrder = allOrder;
    localStorage.setItem(this.ctx.PANEL_ORDER_KEY, JSON.stringify(allOrder));
    localStorage.setItem(this.ctx.PANEL_ORDER_KEY + '-bottom-set', JSON.stringify(Array.from(this.bottomSetMemory)));
  }

  private buildUnifiedOrder(sidebarIds: string[], bottomIds: string[]): string[] {
    const presentIds = [...sidebarIds, ...bottomIds];
    const uniqueIds: string[] = [];
    const seen = new Set<string>();

    presentIds.forEach((id) => {
      if (seen.has(id)) return;
      seen.add(id);
      uniqueIds.push(id);
    });

    const previousOrder = new Map<string, number>();
    this.resolvedPanelOrder.forEach((id, index) => {
      if (seen.has(id) && !previousOrder.has(id)) {
        previousOrder.set(id, index);
      }
    });
    uniqueIds.forEach((id, index) => {
      if (!previousOrder.has(id)) {
        previousOrder.set(id, this.resolvedPanelOrder.length + index);
      }
    });

    const edges = new Map<string, Set<string>>();
    const indegree = new Map<string, number>();
    uniqueIds.forEach((id) => {
      edges.set(id, new Set());
      indegree.set(id, 0);
    });

    const addConstraints = (ids: string[]) => {
      for (let i = 1; i < ids.length; i++) {
        const prev = ids[i - 1]!;
        const next = ids[i]!;
        if (prev === next || !seen.has(prev) || !seen.has(next)) continue;
        const nextIds = edges.get(prev);
        if (!nextIds || nextIds.has(next)) continue;
        nextIds.add(next);
        indegree.set(next, (indegree.get(next) ?? 0) + 1);
      }
    };

    addConstraints(sidebarIds);
    addConstraints(bottomIds);

    const compareIds = (a: string, b: string) =>
      (previousOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (previousOrder.get(b) ?? Number.MAX_SAFE_INTEGER);

    const available = uniqueIds
      .filter((id) => (indegree.get(id) ?? 0) === 0)
      .sort(compareIds);
    const merged: string[] = [];

    while (available.length > 0) {
      const current = available.shift()!;
      merged.push(current);

      edges.get(current)?.forEach((next) => {
        const nextIndegree = (indegree.get(next) ?? 0) - 1;
        indegree.set(next, nextIndegree);
        if (nextIndegree === 0) {
          available.push(next);
        }
      });
      available.sort(compareIds);
    }

    return merged.length === uniqueIds.length
      ? merged
      : uniqueIds.sort(compareIds);
  }

  private getSavedBottomSet(): Set<string> {
    try {
      const saved = localStorage.getItem(this.ctx.PANEL_ORDER_KEY + '-bottom-set');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          return new Set(parsed.filter((v: unknown) => typeof v === 'string'));
        }
      }
    } catch { /* ignore */ }
    try {
      const legacy = localStorage.getItem(this.ctx.PANEL_ORDER_KEY + '-bottom');
      if (legacy) {
        const parsed = JSON.parse(legacy);
        if (Array.isArray(parsed)) {
          const bottomIds = parsed.filter((v: unknown) => typeof v === 'string') as string[];
          const set = new Set(bottomIds);
          // Merge old sidebar + bottom into unified PANEL_ORDER_KEY
          const sidebarOrder = this.getSavedPanelOrder();
          const seen = new Set(sidebarOrder);
          const unified = [...sidebarOrder];
          for (const id of bottomIds) {
            if (!seen.has(id)) { unified.push(id); seen.add(id); }
          }
          localStorage.setItem(this.ctx.PANEL_ORDER_KEY, JSON.stringify(unified));
          localStorage.setItem(this.ctx.PANEL_ORDER_KEY + '-bottom-set', JSON.stringify([...set]));
          localStorage.removeItem(this.ctx.PANEL_ORDER_KEY + '-bottom');
          return set;
        }
      }
    } catch { /* ignore */ }
    return new Set();
  }

  private getEffectiveUltraWide(): boolean {
    const mapSection = document.getElementById('mapSection');
    const mapEnabled = !mapSection?.classList.contains('hidden');
    const minWidth = this.ctx.isDesktopApp ? 900 : 1600;
    return window.innerWidth >= minWidth && mapEnabled;
  }

  private insertByOrder(grid: HTMLElement, el: HTMLElement, key: string): void {
    const idx = this.resolvedPanelOrder.indexOf(key);
    if (idx === -1) { grid.appendChild(el); return; }
    for (let i = idx + 1; i < this.resolvedPanelOrder.length; i++) {
      const nextKey = this.resolvedPanelOrder[i]!;
      const nextEl = grid.querySelector(`[data-panel="${CSS.escape(nextKey)}"]`);
      if (nextEl) { grid.insertBefore(el, nextEl); return; }
    }
    grid.appendChild(el);
  }

  private wasUltraWide = false;

  public ensureCorrectZones(): void {
    const effectiveUltraWide = this.getEffectiveUltraWide();

    if (effectiveUltraWide === this.wasUltraWide) return;
    this.wasUltraWide = effectiveUltraWide;

    const grid = document.getElementById('panelsGrid');
    const bottomGrid = document.getElementById('mapBottomGrid');
    if (!grid || !bottomGrid) return;

    if (!effectiveUltraWide) {
      const panelsInBottom = Array.from(bottomGrid.querySelectorAll('.panel')) as HTMLElement[];
      panelsInBottom.forEach(panelEl => {
        const id = panelEl.dataset.panel;
        if (!id) return;
        this.insertByOrder(grid, panelEl, id);
      });
    } else {
      this.bottomSetMemory.forEach(id => {
        const el = grid.querySelector(`[data-panel="${CSS.escape(id)}"]`);
        if (el) {
          this.insertByOrder(bottomGrid, el as HTMLElement, id);
        }
      });
    }
  }

  private attachRelatedAssetHandlers(panel: NewsPanel): void {
    panel.setRelatedAssetHandlers({
      onRelatedAssetClick: (asset) => this.handleRelatedAssetClick(asset),
      onRelatedAssetsFocus: (assets) => this.ctx.map?.highlightAssets(assets),
      onRelatedAssetsClear: () => this.ctx.map?.highlightAssets(null),
    });
  }

  private handleRelatedAssetClick(asset: RelatedAsset): void {
    if (!this.ctx.map) return;

    switch (asset.type) {
      case 'pipeline':
        this.ctx.map.enableLayer('pipelines');
        this.ctx.mapLayers.pipelines = true;
        saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
        this.ctx.map.triggerPipelineClick(asset.id);
        break;
      case 'cable':
        this.ctx.map.enableLayer('cables');
        this.ctx.mapLayers.cables = true;
        saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
        this.ctx.map.triggerCableClick(asset.id);
        break;
      case 'datacenter':
        this.ctx.map.enableLayer('datacenters');
        this.ctx.mapLayers.datacenters = true;
        saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
        this.ctx.map.triggerDatacenterClick(asset.id);
        break;
      case 'base':
        this.ctx.map.enableLayer('bases');
        this.ctx.mapLayers.bases = true;
        saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
        this.ctx.map.triggerBaseClick(asset.id);
        break;
      case 'nuclear':
        this.ctx.map.enableLayer('nuclear');
        this.ctx.mapLayers.nuclear = true;
        saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
        this.ctx.map.triggerNuclearClick(asset.id);
        break;
    }
  }

  private lazyPanel<T extends { getElement(): HTMLElement }>(
    key: string,
    loader: () => Promise<T>,
    setup?: (panel: T) => void,
    lockedFeatures?: string[],
  ): void {
    if (!this.shouldCreatePanel(key)) return;
    loader().then(async (panel) => {
      this.ctx.panels[key] = panel as unknown as import('@/components/Panel').Panel;
      if (lockedFeatures) {
        (panel as unknown as import('@/components/Panel').Panel).showLocked(lockedFeatures);
      } else {
        // Re-apply auth gating for panels that loaded after the initial auth state fire
        this.updatePanelGating(getAuthState());
        await replayPendingCalls(key, panel);
        if (setup) setup(panel);
      }
      const el = panel.getElement();
      this.makeDraggable(el, key);

      const bottomGrid = document.getElementById('mapBottomGrid');
      if (bottomGrid && this.getEffectiveUltraWide() && this.bottomSetMemory.has(key)) {
        this.insertByOrder(bottomGrid, el, key);
      } else {
        const grid = document.getElementById('panelsGrid');
        if (!grid) return;
        this.insertByOrder(grid, el, key);
      }

      // applyPanelSettings() already ran at startup before this lazy promise resolved.
      // If the user had this panel disabled, it must be hidden immediately after insertion
      // or it reappears until the next applyPanelSettings() call.
      const savedConfig = this.ctx.panelSettings[key];
      if (savedConfig && !savedConfig.enabled) {
        this.ctx.panels[key]?.hide();
      }
    }).catch((err) => {
      console.error(`[panel] failed to lazy-load "${key}"`, err);
    });
  }

  private makeDraggable(el: HTMLElement, key: string): void {
    el.dataset.panel = key;
    let isDragging = false;
    let dragStarted = false;
    let startX = 0;
    let startY = 0;
    let rafId = 0;
    let ghostEl: HTMLElement | null = null;
    let dropIndicator: HTMLElement | null = null;
    let originalParent: HTMLElement | null = null;
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    let originalIndex = -1;
    let onKeyDown: ((e: KeyboardEvent) => void) | null = null;
    const DRAG_THRESHOLD = 8;

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (el.dataset.resizing === 'true') return;
      if (
        target.classList?.contains('panel-resize-handle') ||
        target.closest?.('.panel-resize-handle') ||
        target.classList?.contains('panel-col-resize-handle') ||
        target.closest?.('.panel-col-resize-handle')
      ) return;
      if (target.closest('button, a, input, select, textarea')) return;

      isDragging = true;
      dragStarted = false;
      startX = e.clientX;
      startY = e.clientY;
      
      // Calculate offset within the element for smooth dragging
      const rect = el.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;
      
      e.preventDefault();
    };

    const createGhostElement = (): HTMLElement => {
      const ghost = el.cloneNode(true) as HTMLElement;
      // Strip iframes to prevent duplicate network requests and postMessage handlers
      ghost.querySelectorAll('iframe').forEach(ifr => ifr.remove());
      ghost.classList.add('panel-drag-ghost');
      ghost.style.position = 'fixed';
      ghost.style.pointerEvents = 'none';
      ghost.style.zIndex = '10000';
      ghost.style.opacity = '0.8';
      ghost.style.boxShadow = '0 10px 40px rgba(0, 0, 0, 0.3)';
      ghost.style.transform = 'scale(1.02)';
      
      // Copy dimensions from original
      const rect = el.getBoundingClientRect();
      ghost.style.width = rect.width + 'px';
      ghost.style.height = rect.height + 'px';
      
      document.body.appendChild(ghost);
      return ghost;
    };

    const createDropIndicator = (): HTMLElement => {
      const indicator = document.createElement('div');
      indicator.classList.add('panel-drop-indicator');
      // overlay on body so it doesn't shift grid children
      indicator.style.position = 'fixed';
      indicator.style.pointerEvents = 'none';
      indicator.style.zIndex = '9999';
      document.body.appendChild(indicator);
      return indicator;
    };
    const swapElements = (a: HTMLElement, b: HTMLElement) => {
      if (a === b) return;
      const aParent = a.parentElement;
      const bParent = b.parentElement;
      if (!aParent || !bParent) return;

      const aNext = a.nextSibling;
      const bNext = b.nextSibling;

      if (aParent === bParent) {
        if (aNext === b) {
          aParent.insertBefore(b, a);
        } else if (bNext === a) {
          aParent.insertBefore(a, b);
        } else {
          aParent.insertBefore(b, aNext);
          aParent.insertBefore(a, bNext);
        }
      } else {
        aParent.insertBefore(b, aNext);
        bParent.insertBefore(a, bNext);
      }
    };

    const updateGhostPosition = (clientX: number, clientY: number) => {
      if (!ghostEl) return;
      ghostEl.style.left = (clientX - dragOffsetX) + 'px';
      ghostEl.style.top = (clientY - dragOffsetY) + 'px';
    };

    const findDropPosition = (clientX: number, clientY: number) => {
      const grid = document.getElementById('panelsGrid');
      const bottomGrid = document.getElementById('mapBottomGrid');
      if (!grid || !bottomGrid) return null;

      // Temporarily hide the ghost to get accurate hit detection
      const prevPointerEvents = ghostEl?.style.pointerEvents;
      if (ghostEl) ghostEl.style.pointerEvents = 'none';
      const target = document.elementFromPoint(clientX, clientY);
      if (ghostEl && typeof prevPointerEvents === 'string') ghostEl.style.pointerEvents = prevPointerEvents;

      if (!target) return null;

      const targetGrid = (target.closest('.panels-grid') || target.closest('.map-bottom-grid')) as HTMLElement | null;
      const targetPanel = target.closest('.panel') as HTMLElement | null;

      if (!targetGrid && !targetPanel) return null;

      const currentTargetGrid = targetGrid || (targetPanel ? targetPanel.parentElement as HTMLElement : null);
      if (!currentTargetGrid || (currentTargetGrid !== grid && currentTargetGrid !== bottomGrid)) return null;

      return {
        grid: currentTargetGrid,
        panel: targetPanel && targetPanel !== el ? targetPanel : null,
      };
    };

    let lastTargetPanel: HTMLElement | null = null;

    const updateDropIndicator = (clientX: number, clientY: number) => {
      const dropPos = findDropPosition(clientX, clientY);
      if (!dropPos) {
        if (dropIndicator) dropIndicator.style.opacity = '0';
        if (lastTargetPanel) {
          lastTargetPanel.classList.remove('panel-drop-target');
          lastTargetPanel = null;
        }
        return;
      }

      const { grid, panel } = dropPos;
      if (!dropIndicator) return;

      // highlight hovered panel
      if (panel !== lastTargetPanel) {
        if (lastTargetPanel) lastTargetPanel.classList.remove('panel-drop-target');
        if (panel) panel.classList.add('panel-drop-target');
        lastTargetPanel = panel;
      }

      // compute absolute coordinates for the indicator
      let top = 0;
      let left = 0;
      let width = 0;

      if (panel) {
        const panelRect = panel.getBoundingClientRect();
        const panelMid = panelRect.top + panelRect.height / 2;
        const shouldInsertBefore = clientY < panelMid;
        width = panelRect.width;
        left = panelRect.left;
        top = shouldInsertBefore ? panelRect.top - 4 : panelRect.bottom;
      } else {
        // dropping into empty grid: position at grid bottom
        const gridRect = grid.getBoundingClientRect();
        width = gridRect.width;
        left = gridRect.left;
        top = gridRect.bottom;
      }

      dropIndicator.style.width = width + 'px';
      dropIndicator.style.left = left + 'px';
      dropIndicator.style.top = top + 'px';
      dropIndicator.style.opacity = '0.8';
    };

    let lastX = 0;
    let lastY = 0;

    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      if (!dragStarted) {
        const dx = Math.abs(e.clientX - startX);
        const dy = Math.abs(e.clientY - startY);
        if (dx < DRAG_THRESHOLD && dy < DRAG_THRESHOLD) return;
        dragStarted = true;
        
        // Initialize drag visualization
        el.classList.add('dragging-source');
        originalParent = el.parentElement as HTMLElement;
        originalIndex = Array.from(originalParent.children).indexOf(el);
        ghostEl = createGhostElement();
        dropIndicator = createDropIndicator();
        onKeyDown = (e: KeyboardEvent) => {
          if (e.key === 'Escape') {
            // Cancel drag and restore original position
            el.classList.remove('dragging-source');
            if (ghostEl) {
              ghostEl.style.opacity = '0';
              const g = ghostEl;
              setTimeout(() => g.remove(), 200);
              ghostEl = null;
            }
            if (dropIndicator) {
              dropIndicator.style.opacity = '0';
              const d = dropIndicator;
              setTimeout(() => d.remove(), 200);
              dropIndicator = null;
            }
            if (lastTargetPanel) {
              lastTargetPanel.classList.remove('panel-drop-target');
              lastTargetPanel = null;
            }

            if (originalParent && originalIndex >= 0) {
              const children = Array.from(originalParent.children);
              const insertBefore = children[originalIndex];
              if (insertBefore) {
                originalParent.insertBefore(el, insertBefore);
              } else {
                originalParent.appendChild(el);
              }
            }

            document.removeEventListener('keydown', onKeyDown!);
            onKeyDown = null;
            isDragging = false;
            dragStarted = false;
            if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
          }
        };
        document.addEventListener('keydown', onKeyDown);
      }

      lastX = e.clientX;
      lastY = e.clientY;
      const cx = e.clientX;
      const cy = e.clientY;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (dragStarted) {
          updateGhostPosition(cx, cy);
          updateDropIndicator(cx, cy);
        }
        rafId = 0;
      });
    };

    const onMouseUp = () => {
      if (!isDragging) return;
      isDragging = false;
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      
      if (dragStarted) {
        // Find final drop position using most recent cursor coords
        const dropPos = findDropPosition(lastX, lastY);
        
        if (dropPos) {
          const { grid, panel } = dropPos;

          if (panel && panel !== el) {
            swapElements(el, panel);
          } else if (grid !== originalParent) {
            grid.appendChild(el);
          }
        }
        
        // Clean up drag visualization
        el.classList.remove('dragging-source');
        if (ghostEl) {
          ghostEl.style.opacity = '0';
          const g = ghostEl;
          setTimeout(() => g.remove(), 200);
          ghostEl = null;
        }
        if (dropIndicator) {
          dropIndicator.style.opacity = '0';
          const d = dropIndicator;
          setTimeout(() => d.remove(), 200);
          dropIndicator = null;
        }
        if (lastTargetPanel) {
          lastTargetPanel.classList.remove('panel-drop-target');
          lastTargetPanel = null;
        }
        
        // Update status
        const isInBottom = !!el.closest('.map-bottom-grid');
        if (isInBottom) {
          this.bottomSetMemory.add(key);
        } else {
          this.bottomSetMemory.delete(key);
        }
        this.savePanelOrder();
      }
      dragStarted = false;
      if (onKeyDown) {
        document.removeEventListener('keydown', onKeyDown);
        onKeyDown = null;
      }
    };

    el.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    this.panelDragCleanupHandlers.push(() => {
      el.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      if (onKeyDown) {
        document.removeEventListener('keydown', onKeyDown);
        onKeyDown = null;
      }
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      if (ghostEl) ghostEl.remove();
      if (dropIndicator) dropIndicator.remove();
      isDragging = false;
      dragStarted = false;
      el.classList.remove('dragging-source');
    });
  }

  getLocalizedPanelName(panelKey: string, fallback: string): string {
    if (panelKey === 'runtime-config') {
      return t('modals.runtimeConfig.title');
    }
    const key = panelKey.replace(/-([a-z])/g, (_match, group: string) => group.toUpperCase());
    const lookup = `panels.${key}`;
    const localized = t(lookup);
    return localized === lookup ? fallback : localized;
  }

  getAllSourceNames(): string[] {
    const sources = new Set<string>();
    Object.values(FEEDS).forEach(feeds => {
      if (feeds) feeds.forEach(f => sources.add(f.name));
    });
    INTEL_SOURCES.forEach(f => sources.add(f.name));
    return Array.from(sources).sort((a, b) => a.localeCompare(b));
  }
}
