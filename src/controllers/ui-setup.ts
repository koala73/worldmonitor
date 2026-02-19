/**
 * UISetupController — UI event listeners, search/source modals, idle detection,
 * fullscreen toggling, theme icon, header clock, and miscellaneous UI setup.
 *
 * Extracted from App.ts.  All shared state is accessed via `this.ctx`.
 */

import type { AppContext } from './app-context';
import { FEEDS, INTEL_SOURCES, SITE_VARIANT, STORAGE_KEYS } from '@/config';
import { saveToStorage, getCurrentTheme, setTheme, ExportPanel } from '@/utils';
import { escapeHtml } from '@/utils/sanitize';
import {
  SearchModal,
  StatusPanel,
  MobileWarningModal,
  PizzIntIndicator,
  CIIPanel,
  LanguageSelector,
} from '@/components';
import type { SearchResult } from '@/components/SearchModal';
import type { MapView } from '@/components';
import type { NewsItem } from '@/types';
import { INTEL_HOTSPOTS, CONFLICT_ZONES, MILITARY_BASES, UNDERSEA_CABLES, NUCLEAR_FACILITIES } from '@/config/geo';
import { PIPELINES } from '@/config/pipelines';
import { AI_DATA_CENTERS } from '@/config/ai-datacenters';
import { GAMMA_IRRADIATORS } from '@/config/irradiators';
import { TECH_COMPANIES } from '@/config/tech-companies';
import { AI_RESEARCH_LABS } from '@/config/ai-research-labs';
import { STARTUP_ECOSYSTEMS } from '@/config/startup-ecosystems';
import { TECH_HQS, ACCELERATORS } from '@/config/tech-geo';
import { STOCK_EXCHANGES, FINANCIAL_CENTERS, CENTRAL_BANKS, COMMODITY_HUBS } from '@/config/finance-geo';
import { calculateCII, TIER1_COUNTRIES } from '@/services/country-instability';
import { t, changeLanguage } from '@/services/i18n';
import { mlWorker } from '@/services/ml-worker';

/* ------------------------------------------------------------------ */
/*  Callback interface for cross-controller actions                    */
/* ------------------------------------------------------------------ */

export interface UICallbacks {
  getShareUrl: () => string | null;
  copyToClipboard: (text: string) => Promise<void>;
  setCopyLinkFeedback: (button: HTMLElement | null, message: string) => void;
  updateSearchIndex: () => void;
  openCountryBriefByCode: (code: string, name: string) => void;
}

/* ------------------------------------------------------------------ */
/*  Controller                                                         */
/* ------------------------------------------------------------------ */

export class UISetupController {
  private readonly ctx: AppContext;
  private callbacks!: UICallbacks;
  private clockIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  /** Inject callbacks after construction (avoids circular init issues). */
  setCallbacks(cb: UICallbacks): void {
    this.callbacks = cb;
  }

  /* ================================================================ */
  /*  1. setupEventListeners                                          */
  /* ================================================================ */

  setupEventListeners(): void {
    // Search button
    document.getElementById('searchBtn')?.addEventListener('click', () => {
      this.updateSearchIndex();
      this.ctx.searchModal?.open();
    });

    // Copy link button
    document.getElementById('copyLinkBtn')?.addEventListener('click', async () => {
      const shareUrl = this.callbacks.getShareUrl();
      if (!shareUrl) return;
      const button = document.getElementById('copyLinkBtn');
      try {
        await this.callbacks.copyToClipboard(shareUrl);
        this.callbacks.setCopyLinkFeedback(button, 'Copied!');
      } catch (error) {
        console.warn('Failed to copy share link:', error);
        this.callbacks.setCopyLinkFeedback(button, 'Copy failed');
      }
    });

    // Settings modal
    document.getElementById('settingsBtn')?.addEventListener('click', () => {
      document.getElementById('settingsModal')?.classList.add('active');
    });

    document.getElementById('modalClose')?.addEventListener('click', () => {
      document.getElementById('settingsModal')?.classList.remove('active');
    });

    document.getElementById('settingsModal')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement)?.classList?.contains('modal-overlay')) {
        document.getElementById('settingsModal')?.classList.remove('active');
      }
    });

    // Header theme toggle button
    document.getElementById('headerThemeToggle')?.addEventListener('click', () => {
      const next = getCurrentTheme() === 'dark' ? 'light' : 'dark';
      setTheme(next);
      this.updateHeaderThemeIcon();
    });

    // Sources modal
    this.setupSourcesModal();

    // Variant switcher: switch variant locally on desktop (reload with new config)
    if (this.ctx.isDesktopApp) {
      this.ctx.container.querySelectorAll<HTMLAnchorElement>('.variant-option').forEach(link => {
        link.addEventListener('click', (e) => {
          const variant = link.dataset.variant;
          if (variant && variant !== SITE_VARIANT) {
            e.preventDefault();
            localStorage.setItem('worldmonitor-variant', variant);
            window.location.reload();
          }
        });
      });
    }

    // Fullscreen toggle
    const fullscreenBtn = document.getElementById('fullscreenBtn');
    if (!this.ctx.isDesktopApp && fullscreenBtn) {
      fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());
      this.ctx.boundFullscreenHandler = () => {
        fullscreenBtn.textContent = document.fullscreenElement ? '⛶' : '⛶';
        fullscreenBtn.classList.toggle('active', !!document.fullscreenElement);
      };
      document.addEventListener('fullscreenchange', this.ctx.boundFullscreenHandler);
    }

    // Region selector
    const regionSelect = document.getElementById('regionSelect') as HTMLSelectElement;
    regionSelect?.addEventListener('change', () => {
      this.ctx.map?.setView(regionSelect.value as MapView);
    });

    // Language selector
    const langSelect = document.getElementById('langSelect') as HTMLSelectElement;
    langSelect?.addEventListener('change', () => {
      void changeLanguage(langSelect.value);
    });

    // Window resize
    this.ctx.boundResizeHandler = () => {
      this.ctx.map?.render();
    };
    window.addEventListener('resize', this.ctx.boundResizeHandler);

    // Pause animations when tab is hidden, unload ML models to free memory
    this.ctx.boundVisibilityHandler = () => {
      document.body.classList.toggle('animations-paused', document.hidden);
      if (document.hidden) {
        mlWorker.unloadOptionalModels();
      } else {
        this.resetIdleTimer();
      }
    };
    document.addEventListener('visibilitychange', this.ctx.boundVisibilityHandler);

    // Refresh CII when focal points are ready (ensures focal point urgency is factored in)
    window.addEventListener('focal-points-ready', () => {
      (this.ctx.panels['cii'] as CIIPanel)?.refresh(true); // forceLocal to use focal point data
    });

    // Re-render components with baked getCSSColor() values on theme change
    window.addEventListener('theme-changed', () => {
      this.ctx.map?.render();
      this.updateHeaderThemeIcon();
    });

    // Idle detection - pause animations after 2 minutes of inactivity
    this.setupIdleDetection();
  }

  /* ================================================================ */
  /*  2. setupIdleDetection                                           */
  /* ================================================================ */

  setupIdleDetection(): void {
    this.ctx.boundIdleResetHandler = () => {
      // User is active - resume animations if we were idle
      if (this.ctx.isIdle) {
        this.ctx.isIdle = false;
        document.body.classList.remove('animations-paused');
      }
      this.resetIdleTimer();
    };

    // Track user activity
    ['mousedown', 'keydown', 'scroll', 'touchstart', 'mousemove'].forEach(event => {
      document.addEventListener(event, this.ctx.boundIdleResetHandler!, { passive: true });
    });

    // Start the idle timer
    this.resetIdleTimer();
  }

  /* ================================================================ */
  /*  3. resetIdleTimer                                               */
  /* ================================================================ */

  resetIdleTimer(): void {
    if (this.ctx.idleTimeoutId) {
      clearTimeout(this.ctx.idleTimeoutId);
    }
    this.ctx.idleTimeoutId = setTimeout(() => {
      if (!document.hidden) {
        this.ctx.isIdle = true;
        document.body.classList.add('animations-paused');
        console.log('[App] User idle - pausing animations to save resources');
      }
    }, this.ctx.IDLE_PAUSE_MS);
  }

  /* ================================================================ */
  /*  4. toggleFullscreen                                             */
  /* ================================================================ */

  toggleFullscreen(): void {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => { });
    } else {
      const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
      if (el.requestFullscreen) {
        void el.requestFullscreen().catch(() => { });
      } else if (el.webkitRequestFullscreen) {
        try { el.webkitRequestFullscreen(); } catch { }
      }
    }
  }

  /* ================================================================ */
  /*  5. updateHeaderThemeIcon                                        */
  /* ================================================================ */

  updateHeaderThemeIcon(): void {
    const btn = document.getElementById('headerThemeToggle');
    if (!btn) return;
    const isDark = getCurrentTheme() === 'dark';
    btn.innerHTML = isDark
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>';
  }

  /* ================================================================ */
  /*  6. startHeaderClock  (BUG-008 fix: store interval ID)           */
  /* ================================================================ */

  startHeaderClock(): void {
    const el = document.getElementById('headerClock');
    if (!el) return;
    const tick = () => {
      el.textContent = new Date().toUTCString().replace('GMT', 'UTC');
    };
    tick();
    this.clockIntervalId = setInterval(tick, 1000);
  }

  /** Clear the header clock interval to prevent leaks. */
  clearClockInterval(): void {
    if (this.clockIntervalId !== null) {
      clearInterval(this.clockIntervalId);
      this.clockIntervalId = null;
    }
  }

  /* ================================================================ */
  /*  7. setupMobileWarning                                           */
  /* ================================================================ */

  setupMobileWarning(): void {
    if (MobileWarningModal.shouldShow()) {
      this.ctx.mobileWarningModal = new MobileWarningModal();
      this.ctx.mobileWarningModal.show();
    }
  }

  /* ================================================================ */
  /*  8. setupStatusPanel                                             */
  /* ================================================================ */

  setupStatusPanel(): void {
    this.ctx.statusPanel = new StatusPanel();
    const headerLeft = this.ctx.container.querySelector('.header-left');
    if (headerLeft) {
      headerLeft.appendChild(this.ctx.statusPanel.getElement());
    }
  }

  /* ================================================================ */
  /*  9. setupPizzIntIndicator                                        */
  /* ================================================================ */

  setupPizzIntIndicator(): void {
    // Skip DEFCON indicator for tech/startup and finance variants
    if (SITE_VARIANT === 'tech' || SITE_VARIANT === 'finance') return;

    this.ctx.pizzintIndicator = new PizzIntIndicator();
    const headerLeft = this.ctx.container.querySelector('.header-left');
    if (headerLeft) {
      headerLeft.appendChild(this.ctx.pizzintIndicator.getElement());
    }
  }

  /* ================================================================ */
  /*  10. setupExportPanel                                            */
  /* ================================================================ */

  setupExportPanel(): void {
    this.ctx.exportPanel = new ExportPanel(() => ({
      news: this.ctx.latestClusters.length > 0 ? this.ctx.latestClusters : this.ctx.allNews,
      markets: this.ctx.latestMarkets,
      predictions: this.ctx.latestPredictions,
      timestamp: Date.now(),
    }));

    const headerRight = this.ctx.container.querySelector('.header-right');
    if (headerRight) {
      headerRight.insertBefore(this.ctx.exportPanel.getElement(), headerRight.firstChild);
    }
  }

  /* ================================================================ */
  /*  11. setupLanguageSelector                                       */
  /* ================================================================ */

  setupLanguageSelector(): void {
    this.ctx.languageSelector = new LanguageSelector();
    const headerRight = this.ctx.container.querySelector('.header-right');
    const searchBtn = this.ctx.container.querySelector('#searchBtn');

    if (headerRight && searchBtn) {
      // Insert before search button or at the beginning if search button not found
      headerRight.insertBefore(this.ctx.languageSelector.getElement(), searchBtn);
    } else if (headerRight) {
      headerRight.insertBefore(this.ctx.languageSelector.getElement(), headerRight.firstChild);
    }
  }

  /* ================================================================ */
  /*  12. setupSearchModal                                            */
  /* ================================================================ */

  setupSearchModal(): void {
    const searchOptions = SITE_VARIANT === 'tech'
      ? {
        placeholder: t('modals.search.placeholderTech'),
        hint: t('modals.search.hintTech'),
      }
      : SITE_VARIANT === 'finance'
        ? {
          placeholder: t('modals.search.placeholderFinance'),
          hint: t('modals.search.hintFinance'),
        }
        : {
          placeholder: t('modals.search.placeholder'),
          hint: t('modals.search.hint'),
        };
    this.ctx.searchModal = new SearchModal(this.ctx.container, searchOptions);

    if (SITE_VARIANT === 'tech') {
      // Tech variant: tech-specific sources
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

      // Register Tech HQs (unicorns, FAANG, public companies from map)
      this.ctx.searchModal.registerSource('techhq', TECH_HQS.map(h => ({
        id: h.id,
        title: h.company,
        subtitle: `${h.type === 'faang' ? 'Big Tech' : h.type === 'unicorn' ? 'Unicorn' : 'Public'} • ${h.city}, ${h.country}`,
        data: h,
      })));

      // Register Accelerators
      this.ctx.searchModal.registerSource('accelerator', ACCELERATORS.map(a => ({
        id: a.id,
        title: a.name,
        subtitle: `${a.type} • ${a.city}, ${a.country}${a.notable ? ` • ${a.notable.slice(0, 2).join(', ')}` : ''}`,
        data: a,
      })));
    } else {
      // Full variant: geopolitical sources
      this.ctx.searchModal.registerSource('hotspot', INTEL_HOTSPOTS.map(h => ({
        id: h.id,
        title: h.name,
        subtitle: `${h.subtext || ''} ${h.keywords?.join(' ') || ''} ${h.description || ''}`.trim(),
        data: h,
      })));

      this.ctx.searchModal.registerSource('conflict', CONFLICT_ZONES.map(c => ({
        id: c.id,
        title: c.name,
        subtitle: `${c.parties?.join(' ') || ''} ${c.keywords?.join(' ') || ''} ${c.description || ''}`.trim(),
        data: c,
      })));

      this.ctx.searchModal.registerSource('base', MILITARY_BASES.map(b => ({
        id: b.id,
        title: b.name,
        subtitle: `${b.type} ${b.description || ''}`.trim(),
        data: b,
      })));

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
      // Finance variant: market-specific sources
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

      this.ctx.searchModal.registerSource('commodityhub', COMMODITY_HUBS.map(h => ({
        id: h.id,
        title: h.name,
        subtitle: `${h.type} • ${h.city}, ${h.country}${h.commodities ? ` • ${h.commodities.slice(0, 3).join(', ')}` : ''}`,
        data: h,
      })));
    }

    // Register countries for all variants
    this.ctx.searchModal.registerSource('country', this.buildCountrySearchItems());

    // Handle result selection
    this.ctx.searchModal.setOnSelect((result) => this.handleSearchResult(result));

    // Global keyboard shortcut
    this.ctx.boundKeydownHandler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (this.ctx.searchModal?.isOpen()) {
          this.ctx.searchModal.close();
        } else {
          // Update search index with latest data before opening
          this.updateSearchIndex();
          this.ctx.searchModal?.open();
        }
      }
    };
    document.addEventListener('keydown', this.ctx.boundKeydownHandler);
  }

  /* ================================================================ */
  /*  13. handleSearchResult                                          */
  /* ================================================================ */

  handleSearchResult(result: SearchResult): void {
    switch (result.type) {
      case 'news': {
        // Find and scroll to the news panel containing this item
        const item = result.data as NewsItem;
        this.scrollToPanel('politics');
        this.highlightNewsItem(item.link);
        break;
      }
      case 'hotspot': {
        // Trigger map popup for hotspot
        const hotspot = result.data as typeof INTEL_HOTSPOTS[0];
        this.ctx.map?.setView('global');
        setTimeout(() => {
          this.ctx.map?.triggerHotspotClick(hotspot.id);
        }, 300);
        break;
      }
      case 'conflict': {
        const conflict = result.data as typeof CONFLICT_ZONES[0];
        this.ctx.map?.setView('global');
        setTimeout(() => {
          this.ctx.map?.triggerConflictClick(conflict.id);
        }, 300);
        break;
      }
      case 'market': {
        this.scrollToPanel('markets');
        break;
      }
      case 'prediction': {
        this.scrollToPanel('polymarket');
        break;
      }
      case 'base': {
        const base = result.data as typeof MILITARY_BASES[0];
        this.ctx.map?.setView('global');
        setTimeout(() => {
          this.ctx.map?.triggerBaseClick(base.id);
        }, 300);
        break;
      }
      case 'pipeline': {
        const pipeline = result.data as typeof PIPELINES[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('pipelines');
        this.ctx.mapLayers.pipelines = true;
        setTimeout(() => {
          this.ctx.map?.triggerPipelineClick(pipeline.id);
        }, 300);
        break;
      }
      case 'cable': {
        const cable = result.data as typeof UNDERSEA_CABLES[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('cables');
        this.ctx.mapLayers.cables = true;
        setTimeout(() => {
          this.ctx.map?.triggerCableClick(cable.id);
        }, 300);
        break;
      }
      case 'datacenter': {
        const dc = result.data as typeof AI_DATA_CENTERS[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('datacenters');
        this.ctx.mapLayers.datacenters = true;
        setTimeout(() => {
          this.ctx.map?.triggerDatacenterClick(dc.id);
        }, 300);
        break;
      }
      case 'nuclear': {
        const nuc = result.data as typeof NUCLEAR_FACILITIES[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('nuclear');
        this.ctx.mapLayers.nuclear = true;
        setTimeout(() => {
          this.ctx.map?.triggerNuclearClick(nuc.id);
        }, 300);
        break;
      }
      case 'irradiator': {
        const irr = result.data as typeof GAMMA_IRRADIATORS[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('irradiators');
        this.ctx.mapLayers.irradiators = true;
        setTimeout(() => {
          this.ctx.map?.triggerIrradiatorClick(irr.id);
        }, 300);
        break;
      }
      case 'earthquake':
      case 'outage':
        // These are dynamic, just switch to map view
        this.ctx.map?.setView('global');
        break;
      case 'techcompany': {
        const company = result.data as typeof TECH_COMPANIES[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('techHQs');
        this.ctx.mapLayers.techHQs = true;
        setTimeout(() => {
          this.ctx.map?.setCenter(company.lat, company.lon, 4);
        }, 300);
        break;
      }
      case 'ailab': {
        const lab = result.data as typeof AI_RESEARCH_LABS[0];
        this.ctx.map?.setView('global');
        setTimeout(() => {
          this.ctx.map?.setCenter(lab.lat, lab.lon, 4);
        }, 300);
        break;
      }
      case 'startup': {
        const ecosystem = result.data as typeof STARTUP_ECOSYSTEMS[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('startupHubs');
        this.ctx.mapLayers.startupHubs = true;
        setTimeout(() => {
          this.ctx.map?.setCenter(ecosystem.lat, ecosystem.lon, 4);
        }, 300);
        break;
      }
      case 'techevent':
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('techEvents');
        this.ctx.mapLayers.techEvents = true;
        break;
      case 'techhq': {
        const hq = result.data as typeof TECH_HQS[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('techHQs');
        this.ctx.mapLayers.techHQs = true;
        setTimeout(() => {
          this.ctx.map?.setCenter(hq.lat, hq.lon, 4);
        }, 300);
        break;
      }
      case 'accelerator': {
        const acc = result.data as typeof ACCELERATORS[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('accelerators');
        this.ctx.mapLayers.accelerators = true;
        setTimeout(() => {
          this.ctx.map?.setCenter(acc.lat, acc.lon, 4);
        }, 300);
        break;
      }
      case 'exchange': {
        const exchange = result.data as typeof STOCK_EXCHANGES[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('stockExchanges');
        this.ctx.mapLayers.stockExchanges = true;
        setTimeout(() => {
          this.ctx.map?.setCenter(exchange.lat, exchange.lon, 4);
        }, 300);
        break;
      }
      case 'financialcenter': {
        const fc = result.data as typeof FINANCIAL_CENTERS[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('financialCenters');
        this.ctx.mapLayers.financialCenters = true;
        setTimeout(() => {
          this.ctx.map?.setCenter(fc.lat, fc.lon, 4);
        }, 300);
        break;
      }
      case 'centralbank': {
        const bank = result.data as typeof CENTRAL_BANKS[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('centralBanks');
        this.ctx.mapLayers.centralBanks = true;
        setTimeout(() => {
          this.ctx.map?.setCenter(bank.lat, bank.lon, 4);
        }, 300);
        break;
      }
      case 'commodityhub': {
        const hub = result.data as typeof COMMODITY_HUBS[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('commodityHubs');
        this.ctx.mapLayers.commodityHubs = true;
        setTimeout(() => {
          this.ctx.map?.setCenter(hub.lat, hub.lon, 4);
        }, 300);
        break;
      }
      case 'country': {
        const { code, name } = result.data as { code: string; name: string };
        this.callbacks.openCountryBriefByCode(code, name);
        break;
      }
    }
  }

  /* ================================================================ */
  /*  14. scrollToPanel                                               */
  /* ================================================================ */

  scrollToPanel(panelId: string): void {
    const panel = document.querySelector(`[data-panel="${panelId}"]`);
    if (panel) {
      panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
      panel.classList.add('flash-highlight');
      setTimeout(() => panel.classList.remove('flash-highlight'), 1500);
    }
  }

  /* ================================================================ */
  /*  15. highlightNewsItem                                           */
  /* ================================================================ */

  highlightNewsItem(itemId: string): void {
    setTimeout(() => {
      const item = document.querySelector(`[data-news-id="${itemId}"]`);
      if (item) {
        item.scrollIntoView({ behavior: 'smooth', block: 'center' });
        item.classList.add('flash-highlight');
        setTimeout(() => item.classList.remove('flash-highlight'), 1500);
      }
    }, 100);
  }

  /* ================================================================ */
  /*  16. updateSearchIndex                                           */
  /* ================================================================ */

  updateSearchIndex(): void {
    if (!this.ctx.searchModal) return;

    // Keep country CII labels fresh with latest ingested signals.
    this.ctx.searchModal.registerSource('country', this.buildCountrySearchItems());

    // Update news sources (use link as unique id) - index up to 500 items for better search coverage
    const newsItems = this.ctx.allNews.slice(0, 500).map(n => ({
      id: n.link,
      title: n.title,
      subtitle: n.source,
      data: n,
    }));
    console.log(`[Search] Indexing ${newsItems.length} news items (allNews total: ${this.ctx.allNews.length})`);
    this.ctx.searchModal.registerSource('news', newsItems);

    // Update predictions if available
    if (this.ctx.latestPredictions.length > 0) {
      this.ctx.searchModal.registerSource('prediction', this.ctx.latestPredictions.map(p => ({
        id: p.title,
        title: p.title,
        subtitle: `${(p.yesPrice * 100).toFixed(0)}% probability`,
        data: p,
      })));
    }

    // Update markets if available
    if (this.ctx.latestMarkets.length > 0) {
      this.ctx.searchModal.registerSource('market', this.ctx.latestMarkets.map(m => ({
        id: m.symbol,
        title: `${m.symbol} - ${m.name}`,
        subtitle: `$${m.price?.toFixed(2) || 'N/A'}`,
        data: m,
      })));
    }
  }

  /* ================================================================ */
  /*  17. buildCountrySearchItems                                     */
  /* ================================================================ */

  private buildCountrySearchItems(): { id: string; title: string; subtitle: string; data: { code: string; name: string } }[] {
    const panelScores = (this.ctx.panels['cii'] as CIIPanel | undefined)?.getScores() ?? [];
    const scores = panelScores.length > 0 ? panelScores : calculateCII();
    const ciiByCode = new Map(scores.map((score) => [score.code, score]));
    return Object.entries(TIER1_COUNTRIES).map(([code, name]) => {
      const score = ciiByCode.get(code);
      return {
        id: code,
        title: `${UISetupController.toFlagEmoji(code)} ${name}`,
        subtitle: score ? `CII: ${score.score}/100 • ${score.level}` : 'Country Brief',
        data: { code, name },
      };
    });
  }

  /* ================================================================ */
  /*  toFlagEmoji (static helper)                                     */
  /* ================================================================ */

  private static toFlagEmoji(code: string): string {
    const upperCode = code.toUpperCase();
    if (!/^[A-Z]{2}$/.test(upperCode)) return '🏳️';
    return upperCode
      .split('')
      .map((char) => String.fromCodePoint(0x1f1e6 + char.charCodeAt(0) - 65))
      .join('');
  }

  /* ================================================================ */
  /*  18. renderSourceToggles                                         */
  /* ================================================================ */

  renderSourceToggles(filter = ''): void {
    const container = document.getElementById('sourceToggles')!;
    const allSources = this.getAllSourceNames();
    const filterLower = filter.toLowerCase();
    const filteredSources = filter
      ? allSources.filter(s => s.toLowerCase().includes(filterLower))
      : allSources;

    container.innerHTML = filteredSources.map(source => {
      const isEnabled = !this.ctx.disabledSources.has(source);
      const escaped = escapeHtml(source);
      return `
        <div class="source-toggle-item ${isEnabled ? 'active' : ''}" data-source="${escaped}">
          <div class="source-toggle-checkbox">${isEnabled ? '✓' : ''}</div>
          <span class="source-toggle-label">${escaped}</span>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.source-toggle-item').forEach(item => {
      item.addEventListener('click', () => {
        const sourceName = (item as HTMLElement).dataset.source!;
        if (this.ctx.disabledSources.has(sourceName)) {
          this.ctx.disabledSources.delete(sourceName);
        } else {
          this.ctx.disabledSources.add(sourceName);
        }
        saveToStorage(STORAGE_KEYS.disabledFeeds, Array.from(this.ctx.disabledSources));
        this.renderSourceToggles(filter);
      });
    });

    // Update counter
    const enabledCount = allSources.length - this.ctx.disabledSources.size;
    const counterEl = document.getElementById('sourcesCounter');
    if (counterEl) {
      counterEl.textContent = t('header.sourcesEnabled', { enabled: String(enabledCount), total: String(allSources.length) });
    }
  }

  /* ================================================================ */
  /*  19. setupSourcesModal                                           */
  /* ================================================================ */

  setupSourcesModal(): void {
    document.getElementById('sourcesBtn')?.addEventListener('click', () => {
      document.getElementById('sourcesModal')?.classList.add('active');
      // Clear search and show all sources on open
      const searchInput = document.getElementById('sourcesSearch') as HTMLInputElement | null;
      if (searchInput) searchInput.value = '';
      this.renderSourceToggles();
    });

    document.getElementById('sourcesModalClose')?.addEventListener('click', () => {
      document.getElementById('sourcesModal')?.classList.remove('active');
    });

    document.getElementById('sourcesModal')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement)?.classList?.contains('modal-overlay')) {
        document.getElementById('sourcesModal')?.classList.remove('active');
      }
    });

    document.getElementById('sourcesSearch')?.addEventListener('input', (e) => {
      const filter = (e.target as HTMLInputElement).value;
      this.renderSourceToggles(filter);
    });

    document.getElementById('sourcesSelectAll')?.addEventListener('click', () => {
      this.ctx.disabledSources.clear();
      saveToStorage(STORAGE_KEYS.disabledFeeds, []);
      const filter = (document.getElementById('sourcesSearch') as HTMLInputElement)?.value || '';
      this.renderSourceToggles(filter);
    });

    document.getElementById('sourcesSelectNone')?.addEventListener('click', () => {
      const allSources = this.getAllSourceNames();
      this.ctx.disabledSources = new Set(allSources);
      saveToStorage(STORAGE_KEYS.disabledFeeds, allSources);
      const filter = (document.getElementById('sourcesSearch') as HTMLInputElement)?.value || '';
      this.renderSourceToggles(filter);
    });
  }

  /* ================================================================ */
  /*  20. getAllSourceNames                                            */
  /* ================================================================ */

  getAllSourceNames(): string[] {
    const sources = new Set<string>();
    Object.values(FEEDS).forEach(feeds => {
      if (feeds) feeds.forEach(f => sources.add(f.name));
    });
    INTEL_SOURCES.forEach(f => sources.add(f.name));
    return Array.from(sources).sort((a, b) => a.localeCompare(b));
  }
}
