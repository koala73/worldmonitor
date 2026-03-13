import type { AppContext, AppModule } from '@/app/app-context';
import type { AirlineIntelPanel } from '@/components/AirlineIntelPanel';
import type { CustomWidgetPanel } from '@/components/CustomWidgetPanel';
import { openWidgetChatModal } from '@/components/WidgetChatModal';
import { deleteWidget, getWidget, saveWidget, isProUser } from '@/services/widget-store';
import { FREE_MAX_PANELS, FREE_MAX_SOURCES } from '@/config/panels';
import type { McpDataPanel } from '@/components/McpDataPanel';
import { openMcpConnectModal } from '@/components/McpConnectModal';
import { deleteMcpPanel, getMcpPanel, saveMcpPanel } from '@/services/mcp-store';
import type { PanelConfig, MapLayers, MilitaryFlight } from '@/types';
import type { MapView } from '@/components';
import type { PositionSample } from '@/services/aviation';
import type { ClusteredEvent } from '@/types';
import type { DashboardSnapshot } from '@/services/storage';
import {
  PlaybackControl,
  StatusPanel,
  PizzIntIndicator,
  LlmStatusIndicator,
  CIIPanel,
  PredictionPanel,
} from '@/components';
import {
  buildMapUrl,
  debounce,
  saveToStorage,
  ExportPanel,
  getCurrentTheme,
  setTheme,
} from '@/utils';
import {
  IDLE_PAUSE_MS,
  STORAGE_KEYS,
  SITE_VARIANT,
  LAYER_TO_SOURCE,
  FEEDS,
  INTEL_SOURCES,
} from '@/config';
import { VARIANT_META } from '@/config/variant-meta';
import { isDesktopRuntime } from '@/services/runtime';
import {
  saveSnapshot,
  initAisStream,
  disconnectAisStream,
} from '@/services';
import {
  track,
  trackPanelView,
  trackVariantSwitch,
  trackThemeChanged,
  trackMapViewChange,
  trackMapLayerToggle,
  trackPanelToggled,
  trackDownloadClicked,
  trackGateHit,
} from '@/services/analytics';
import { detectPlatform, allButtons, buttonsForPlatform } from '@/components/DownloadBanner';
import type { Platform } from '@/components/DownloadBanner';
import { invokeTauri } from '@/services/tauri-bridge';
import { getCachedGpsInterference } from '@/services/gps-interference';
import { dataFreshness } from '@/services/data-freshness';
import { mlWorker } from '@/services/ml-worker';
import { UnifiedSettings } from '@/components/UnifiedSettings';
import { AuthLauncher } from '@/components/AuthLauncher';
import { AuthHeaderWidget } from '@/components/AuthHeaderWidget';
import { t } from '@/services/i18n';
import { TvModeController } from '@/services/tv-mode';
import { getAuthState, subscribeAuthState } from '@/services/auth-state';

export interface EventHandlerCallbacks {
  updateSearchIndex: () => void;
  updateFlightSource?: (adsb: PositionSample[], military: MilitaryFlight[]) => void;
  loadAllData: () => Promise<void>;
  flushStaleRefreshes: () => void;
  setHiddenSince: (ts: number) => void;
  loadDataForLayer: (layer: string) => void;
  waitForAisData: () => void;
  syncDataFreshnessWithLayers: () => void;
  ensureCorrectZones: () => void;
  refreshOpenCountryBrief?: () => void;
  stopLayerActivity?: (layer: keyof MapLayers) => void;
  mountLiveNewsIfReady?: () => void;
}

export class EventHandlerManager implements AppModule {
  private ctx: AppContext;
  private callbacks: EventHandlerCallbacks;

  private boundFullscreenHandler: (() => void) | null = null;
  private boundResizeHandler: (() => void) | null = null;
  private boundVisibilityHandler: (() => void) | null = null;
  private boundDesktopExternalLinkHandler: ((e: MouseEvent) => void) | null = null;
  private boundIdleResetHandler: (() => void) | null = null;
  private boundStorageHandler: ((e: StorageEvent) => void) | null = null;
  private boundTvKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private boundFocalPointsReadyHandler: (() => void) | null = null;
  private boundThemeChangedHandler: (() => void) | null = null;
  private boundDropdownClickHandler: ((e: MouseEvent) => void) | null = null;
  private boundDropdownKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private boundMapResizeMoveHandler: ((e: MouseEvent) => void) | null = null;
  private boundMapEndResizeHandler: (() => void) | null = null;
  private boundMapResizeVisChangeHandler: (() => void) | null = null;
  private boundMapWidthResizeMoveHandler: ((e: MouseEvent) => void) | null = null;
  private boundMapWidthEndResizeHandler: (() => void) | null = null;
  private boundMapFullscreenEscHandler: ((e: KeyboardEvent) => void) | null = null;
  private boundMobileMenuKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  private boundPanelCloseHandler: ((e: Event) => void) | null = null;
  private boundWidgetModifyHandler: ((e: Event) => void) | null = null;
  private boundUndoHandler: ((e: KeyboardEvent) => void) | null = null;
  private proGateUnsubscribers: Array<() => void> = [];
  private closedPanelStack: string[] = []; // max-items: 20
  private idleTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private snapshotIntervalId: ReturnType<typeof setInterval> | null = null;
  private clockIntervalId: ReturnType<typeof setInterval> | null = null;

  private readonly idlePauseMs = IDLE_PAUSE_MS;
  private readonly debouncedUrlSync = debounce(() => {
    const shareUrl = this.getShareUrl();
    if (!shareUrl) return;
    try { history.replaceState(null, '', shareUrl); } catch { }
  }, 250);

  private readonly debouncedWebcamReload = debounce(() => {
    if (this.ctx.mapLayers?.webcams) {
      this.callbacks.loadDataForLayer('webcams');
    }
  }, 350);

  constructor(ctx: AppContext, callbacks: EventHandlerCallbacks) {
    this.ctx = ctx;
    this.callbacks = callbacks;
  }

  init(): void {
    this.setupEventListeners();
    this.setupIdleDetection();
    this.setupTvMode();
  }

  private performUndo(): void {
    const panelId = this.closedPanelStack.pop();
    if (!panelId) return;
    const config = this.ctx.panelSettings[panelId];
    if (!config) return;
    if (!isProUser()) {
      const enabledCount = Object.entries(this.ctx.panelSettings).filter(([k, p]) => p.enabled && !k.startsWith('cw-')).length;
      if (enabledCount >= FREE_MAX_PANELS) return;
    }
    config.enabled = true;
    trackPanelToggled(panelId, true);
    saveToStorage(STORAGE_KEYS.panels, this.ctx.panelSettings);
    this.applyPanelSettings();
    this.ctx.unifiedSettings?.refreshPanelToggles();

    // Ensure restored panel fetches fresh data (otherwise it may show no content)
    const panel = this.ctx.panels[panelId];
    if (panel && 'fetchData' in panel && typeof (panel as { fetchData: unknown }).fetchData === 'function') {
      (panel as { fetchData: () => void }).fetchData();
    }
  }

  private setupTvMode(): void {
    if (SITE_VARIANT !== 'happy') return;

    const tvBtn = document.getElementById('tvModeBtn');
    const tvExitBtn = document.getElementById('tvExitBtn');
    if (tvBtn) {
      tvBtn.addEventListener('click', () => this.toggleTvMode());
    }
    if (tvExitBtn) {
      tvExitBtn.addEventListener('click', () => this.toggleTvMode());
    }
    // Keyboard shortcut: Shift+T
    this.boundTvKeydownHandler = (e: KeyboardEvent) => {
      if (e.shiftKey && e.key === 'T' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const active = document.activeElement;
        if (active?.tagName !== 'INPUT' && active?.tagName !== 'TEXTAREA') {
          e.preventDefault();
          this.toggleTvMode();
        }
      }
    };
    document.addEventListener('keydown', this.boundTvKeydownHandler);
  }

  private toggleTvMode(): void {
    const panelKeys = Object.keys(this.ctx.panelSettings).filter(
      key => this.ctx.panelSettings[key]?.enabled !== false
    );
    if (!this.ctx.tvMode) {
      this.ctx.tvMode = new TvModeController({
        panelKeys,
        onPanelChange: () => {
          document.getElementById('tvModeBtn')?.classList.toggle('active', this.ctx.tvMode?.active ?? false);
        }
      });
    } else {
      this.ctx.tvMode.updatePanelKeys(panelKeys);
    }
    this.ctx.tvMode.toggle();
    document.getElementById('tvModeBtn')?.classList.toggle('active', this.ctx.tvMode.active);
  }

  destroy(): void {
    this.debouncedUrlSync.cancel();
    this.debouncedWebcamReload.cancel();
    if (this.boundFullscreenHandler) {
      document.removeEventListener('fullscreenchange', this.boundFullscreenHandler);
      this.boundFullscreenHandler = null;
    }
    if (this.boundResizeHandler) {
      window.removeEventListener('resize', this.boundResizeHandler);
      this.boundResizeHandler = null;
    }
    if (this.boundVisibilityHandler) {
      document.removeEventListener('visibilitychange', this.boundVisibilityHandler);
      this.boundVisibilityHandler = null;
    }
    if (this.boundDesktopExternalLinkHandler) {
      document.removeEventListener('click', this.boundDesktopExternalLinkHandler, true);
      this.boundDesktopExternalLinkHandler = null;
    }
    if (this.idleTimeoutId) {
      clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }
    if (this.boundIdleResetHandler) {
      ['mousedown', 'keydown', 'scroll', 'touchstart', 'mousemove'].forEach(event => {
        document.removeEventListener(event, this.boundIdleResetHandler!);
      });
      this.boundIdleResetHandler = null;
    }
    if (this.snapshotIntervalId) {
      clearInterval(this.snapshotIntervalId);
      this.snapshotIntervalId = null;
    }
    if (this.clockIntervalId) {
      clearInterval(this.clockIntervalId);
      this.clockIntervalId = null;
    }
    if (this.boundStorageHandler) {
      window.removeEventListener('storage', this.boundStorageHandler);
      this.boundStorageHandler = null;
    }
    if (this.boundTvKeydownHandler) {
      document.removeEventListener('keydown', this.boundTvKeydownHandler);
      this.boundTvKeydownHandler = null;
    }
    if (this.boundFocalPointsReadyHandler) {
      window.removeEventListener('focal-points-ready', this.boundFocalPointsReadyHandler);
      this.boundFocalPointsReadyHandler = null;
    }
    if (this.boundThemeChangedHandler) {
      window.removeEventListener('theme-changed', this.boundThemeChangedHandler);
      this.boundThemeChangedHandler = null;
    }
    if (this.boundDropdownClickHandler) {
      document.removeEventListener('click', this.boundDropdownClickHandler);
      this.boundDropdownClickHandler = null;
    }
    if (this.boundDropdownKeydownHandler) {
      document.removeEventListener('keydown', this.boundDropdownKeydownHandler);
      this.boundDropdownKeydownHandler = null;
    }
    if (this.boundMapResizeMoveHandler) {
      document.removeEventListener('mousemove', this.boundMapResizeMoveHandler);
      this.boundMapResizeMoveHandler = null;
    }
    if (this.boundMapEndResizeHandler) {
      document.removeEventListener('mouseup', this.boundMapEndResizeHandler);
      window.removeEventListener('blur', this.boundMapEndResizeHandler);
      this.boundMapEndResizeHandler = null;
    }
    if (this.boundMapWidthResizeMoveHandler) {
      document.removeEventListener('mousemove', this.boundMapWidthResizeMoveHandler);
      this.boundMapWidthResizeMoveHandler = null;
    }
    if (this.boundMapWidthEndResizeHandler) {
      document.removeEventListener('mouseup', this.boundMapWidthEndResizeHandler);
      window.removeEventListener('blur', this.boundMapWidthEndResizeHandler);
      this.boundMapWidthEndResizeHandler = null;
    }
    if (this.boundMapResizeVisChangeHandler) {
      document.removeEventListener('visibilitychange', this.boundMapResizeVisChangeHandler);
      this.boundMapResizeVisChangeHandler = null;
    }
    if (this.boundMapFullscreenEscHandler) {
      document.removeEventListener('keydown', this.boundMapFullscreenEscHandler);
      this.boundMapFullscreenEscHandler = null;
    }
    if (this.boundMobileMenuKeyHandler) {
      document.removeEventListener('keydown', this.boundMobileMenuKeyHandler);
      this.boundMobileMenuKeyHandler = null;
    }
    if (this.boundPanelCloseHandler) {
      this.ctx.container.removeEventListener('wm:panel-close', this.boundPanelCloseHandler);
      this.boundPanelCloseHandler = null;
    }
    if (this.boundWidgetModifyHandler) {
      this.ctx.container.removeEventListener('wm:widget-modify', this.boundWidgetModifyHandler);
      this.boundWidgetModifyHandler = null;
    }
    if (this.boundUndoHandler) {
      document.removeEventListener('keydown', this.boundUndoHandler);
      this.boundUndoHandler = null;
    }
    for (const unsub of this.proGateUnsubscribers) unsub();
    this.proGateUnsubscribers = [];
    this.ctx.tvMode?.destroy();
    this.ctx.tvMode = null;
    this.ctx.unifiedSettings?.destroy();
    this.ctx.unifiedSettings = null;
    this.ctx.authHeaderWidget?.destroy();
    this.ctx.authHeaderWidget = null;
    this.ctx.authModal?.destroy();
    this.ctx.authModal = null;
  }

  private setupEventListeners(): void {
    const openSearch = () => {
      this.callbacks.updateSearchIndex();
      this.ctx.searchModal?.open();
    };
    document.getElementById('searchBtn')?.addEventListener('click', () => {
      track('search-open', { source: 'desktop' });
      openSearch();
    });
    document.getElementById('mobileSearchBtn')?.addEventListener('click', () => {
      track('search-open', { source: 'mobile' });
      openSearch();
    });
    document.getElementById('searchMobileFab')?.addEventListener('click', () => {
      track('search-open', { source: 'fab' });
      openSearch();
    });

    document.getElementById('copyLinkBtn')?.addEventListener('click', async () => {
      const shareUrl = this.getShareUrl();
      if (!shareUrl) return;
      const button = document.getElementById('copyLinkBtn');
      try {
        await this.copyToClipboard(shareUrl);
        this.setCopyLinkFeedback(button, 'Copied!');
      } catch (error) {
        console.warn('Failed to copy share link:', error);
        this.setCopyLinkFeedback(button, 'Copy failed');
      }
    });

    this.initDownloadDropdown();
    this.initFooterDownload();

    this.boundStorageHandler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEYS.panels && e.newValue) {
        try {
          this.ctx.panelSettings = JSON.parse(e.newValue) as Record<string, PanelConfig>;
          this.applyPanelSettings();
          this.ctx.unifiedSettings?.refreshPanelToggles();
        } catch (_) { }
      }
      if (e.key === STORAGE_KEYS.liveChannels && e.newValue) {
        const panel = this.ctx.panels['live-news'];
        if (panel) {
          if (typeof (panel as unknown as { refreshChannelsFromStorage?: () => void }).refreshChannelsFromStorage === 'function') {
            (panel as unknown as { refreshChannelsFromStorage: () => void }).refreshChannelsFromStorage();
          }
        } else {
          this.callbacks.mountLiveNewsIfReady?.();
        }
      }
    };
    window.addEventListener('storage', this.boundStorageHandler);

    // Handle panel close (X) button clicks
    this.boundPanelCloseHandler = ((e: CustomEvent<{ panelId: string }>) => {
      const { panelId } = e.detail;

      if (panelId.startsWith('cw-')) {
        if (!window.confirm(t('widgets.confirmDelete'))) return;
        deleteWidget(panelId);
        const panel = this.ctx.panels[panelId];
        panel?.destroy();
        delete this.ctx.panels[panelId];
        delete this.ctx.panelSettings[panelId];
        saveToStorage(STORAGE_KEYS.panels, this.ctx.panelSettings);
        panel?.getElement()?.remove();
        return;
      }

      if (panelId.startsWith('mcp-')) {
        if (!window.confirm(t('mcp.confirmDelete'))) return;
        deleteMcpPanel(panelId);
        const panel = this.ctx.panels[panelId];
        panel?.destroy();
        delete this.ctx.panels[panelId];
        delete this.ctx.panelSettings[panelId];
        saveToStorage(STORAGE_KEYS.panels, this.ctx.panelSettings);
        panel?.getElement()?.remove();
        return;
      }

      const config = this.ctx.panelSettings[panelId];
      if (!config) return;
      config.enabled = false;
      trackPanelToggled(panelId, false);
      saveToStorage(STORAGE_KEYS.panels, this.ctx.panelSettings);
      this.applyPanelSettings();
      this.ctx.unifiedSettings?.refreshPanelToggles();
      // push to undo stack (cap size for memory safety)
      this.closedPanelStack.push(panelId);
      if (this.closedPanelStack.length > 20) this.closedPanelStack.shift();
    }) as EventListener;
    this.ctx.container.addEventListener('wm:panel-close', this.boundPanelCloseHandler);

    this.boundWidgetModifyHandler = ((e: CustomEvent<{ widgetId: string }>) => {
      const spec = getWidget(e.detail.widgetId);
      if (!spec) return;
      openWidgetChatModal({
        mode: 'modify',
        existingSpec: spec,
        onComplete: (updated) => {
          saveWidget(updated);
          (this.ctx.panels[updated.id] as CustomWidgetPanel | undefined)?.updateSpec(updated);
        },
      });
    }) as EventListener;
    this.ctx.container.addEventListener('wm:widget-modify', this.boundWidgetModifyHandler);

    this.ctx.container.addEventListener('wm:mcp-configure', ((e: CustomEvent<{ panelId: string }>) => {
      const spec = getMcpPanel(e.detail.panelId);
      if (!spec) return;
      openMcpConnectModal({
        existingSpec: spec,
        onComplete: (updated) => {
          saveMcpPanel(updated);
          (this.ctx.panels[updated.id] as McpDataPanel | undefined)?.updateSpec(updated);
        },
      });
    }) as EventListener);

    // undo via Ctrl/Cmd+Z
    this.boundUndoHandler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        const tag = (e.target as HTMLElement)?.tagName ?? '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
        e.preventDefault();
        this.performUndo();
      }
    };
    document.addEventListener('keydown', this.boundUndoHandler);

    const isLocalDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    this.ctx.container.querySelectorAll<HTMLAnchorElement>('.variant-option').forEach(link => {
      link.addEventListener('click', (e) => {
        const variant = link.dataset.variant;
        if (!variant || variant === SITE_VARIANT) return;
        e.preventDefault();
        void this.navigateToVariant(variant, {
          href: link.href,
          isLocalDev,
        });
      });
    });

    const fullscreenBtn = document.getElementById('fullscreenBtn');
    if (!this.ctx.isDesktopApp && fullscreenBtn) {
      fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());
      this.boundFullscreenHandler = () => {
        fullscreenBtn.textContent = document.fullscreenElement ? '\u26F6' : '\u26F6';
        fullscreenBtn.classList.toggle('active', !!document.fullscreenElement);
        this.syncMapAfterLayoutChange();
      };
      document.addEventListener('fullscreenchange', this.boundFullscreenHandler);
    }

    const regionSelect = document.getElementById('regionSelect') as HTMLSelectElement;
    regionSelect?.addEventListener('change', () => {
      this.ctx.map?.setView(regionSelect.value as MapView);
      trackMapViewChange(regionSelect.value);
    });

    this.boundResizeHandler = debounce(() => {
      this.ctx.map?.setIsResizing(false);
      this.ctx.map?.render();
    }, 150);
    window.addEventListener('resize', this.boundResizeHandler);

    this.setupMapResize();
    this.setupMapWidthResize();
    this.setupMapPin();

    this.boundVisibilityHandler = () => {
      document.body?.classList.toggle('animations-paused', document.hidden);
      if (this.ctx.isDesktopApp) {
        this.ctx.map?.setRenderPaused(document.hidden);
      }
      if (document.hidden) {
        this.callbacks.setHiddenSince(Date.now());
        mlWorker.unloadOptionalModels();
      } else {
        this.resetIdleTimer();
        this.callbacks.flushStaleRefreshes();
      }
    };
    document.addEventListener('visibilitychange', this.boundVisibilityHandler);

    this.boundFocalPointsReadyHandler = () => {
      (this.ctx.panels.cii as CIIPanel)?.refresh(true);
      this.callbacks.refreshOpenCountryBrief?.();
    };
    window.addEventListener('focal-points-ready', this.boundFocalPointsReadyHandler);

    this.boundThemeChangedHandler = () => {
      this.ctx.map?.render();
      this.updateMobileMenuThemeItem();
    };
    window.addEventListener('theme-changed', this.boundThemeChangedHandler);

    this.setupMobileMenu();

    if (this.ctx.isDesktopApp) {
      if (this.boundDesktopExternalLinkHandler) {
        document.removeEventListener('click', this.boundDesktopExternalLinkHandler, true);
      }
      this.boundDesktopExternalLinkHandler = (e: MouseEvent) => {
        if (!(e.target instanceof Element)) return;
        const anchor = e.target.closest('a[href]') as HTMLAnchorElement | null;
        if (!anchor) return;
        const href = anchor.href;
        if (!href || href.startsWith('javascript:') || href === '#' || href.startsWith('#')) return;
        // Only handle valid http(s) URLs
        let url: URL;
        try {
          url = new URL(href, window.location.href);
        } catch {
          // Malformed URL, let browser handle
          return;
        }
        if (url.origin === window.location.origin) return;
        if (!/^https?:$/.test(url.protocol)) return; // Only allow http(s) links
        e.preventDefault();
        e.stopPropagation();
        void invokeTauri<void>('open_url', { url: url.toString() }).catch(() => {
          window.open(url.toString(), '_blank');
        });
      };
      document.addEventListener('click', this.boundDesktopExternalLinkHandler, true);
    }
  }

  private setupMobileMenu(): void {
    const hamburger = document.getElementById('hamburgerBtn');
    const overlay = document.getElementById('mobileMenuOverlay');
    const menu = document.getElementById('mobileMenu');
    const closeBtn = document.getElementById('mobileMenuClose');
    if (!hamburger || !overlay || !menu || !closeBtn) return;

    hamburger.addEventListener('click', () => this.openMobileMenu());
    overlay.addEventListener('click', () => this.closeMobileMenu());
    closeBtn.addEventListener('click', () => this.closeMobileMenu());

    const isLocalDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    menu.querySelectorAll<HTMLButtonElement>('.mobile-menu-variant').forEach(btn => {
      btn.addEventListener('click', () => {
        const variant = btn.dataset.variant;
        if (!variant || variant === SITE_VARIANT) return;
        void this.navigateToVariant(variant, { isLocalDev });
      });
    });

    document.getElementById('mobileMenuRegion')?.addEventListener('click', () => {
      this.closeMobileMenu();
      this.openRegionSheet();
    });

    document.getElementById('mobileMenuSettings')?.addEventListener('click', () => {
      this.closeMobileMenu();
      this.ctx.unifiedSettings?.open();
    });

    document.getElementById('mobileMenuTheme')?.addEventListener('click', () => {
      this.closeMobileMenu();
      const next = getCurrentTheme() === 'dark' ? 'light' : 'dark';
      setTheme(next);
      trackThemeChanged(next);
    });

    const sheetBackdrop = document.getElementById('regionSheetBackdrop');
    sheetBackdrop?.addEventListener('click', () => this.closeRegionSheet());

    const sheet = document.getElementById('regionBottomSheet');
    sheet?.querySelectorAll<HTMLButtonElement>('.region-sheet-option').forEach(opt => {
      opt.addEventListener('click', () => {
        const region = opt.dataset.region;
        if (!region) return;
        this.ctx.map?.setView(region as MapView);
        trackMapViewChange(region);
        const regionSelect = document.getElementById('regionSelect') as HTMLSelectElement;
        if (regionSelect) regionSelect.value = region;
        sheet.querySelectorAll('.region-sheet-option').forEach(o => {
          o.classList.toggle('active', o === opt);
          const check = o.querySelector('.region-sheet-check');
          if (check) check.textContent = o === opt ? '✓' : '';
        });
        const menuRegionLabel = document.getElementById('mobileMenuRegion')?.querySelector('.mobile-menu-item-label');
        if (menuRegionLabel) menuRegionLabel.textContent = opt.querySelector('span')?.textContent ?? '';
        this.closeRegionSheet();
      });
    });

    this.boundMobileMenuKeyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (sheet?.classList.contains('open')) {
          this.closeRegionSheet();
        } else if (menu.classList.contains('open')) {
          this.closeMobileMenu();
        }
      }
    };
    document.addEventListener('keydown', this.boundMobileMenuKeyHandler);
  }

  private openMobileMenu(): void {
    const overlay = document.getElementById('mobileMenuOverlay');
    const menu = document.getElementById('mobileMenu');
    if (!overlay || !menu) return;
    overlay.classList.add('open');
    requestAnimationFrame(() => menu.classList.add('open'));
    document.body.style.overflow = 'hidden';
  }

  private closeMobileMenu(): void {
    const overlay = document.getElementById('mobileMenuOverlay');
    const menu = document.getElementById('mobileMenu');
    if (!overlay || !menu) return;
    menu.classList.remove('open');
    overlay.classList.remove('open');
    const sheetOpen = document.getElementById('regionBottomSheet')?.classList.contains('open');
    if (!sheetOpen) document.body.style.overflow = '';
  }

  private openRegionSheet(): void {
    const backdrop = document.getElementById('regionSheetBackdrop');
    const sheet = document.getElementById('regionBottomSheet');
    if (!backdrop || !sheet) return;
    backdrop.classList.add('open');
    requestAnimationFrame(() => sheet.classList.add('open'));
    document.body.style.overflow = 'hidden';
  }

  private closeRegionSheet(): void {
    const backdrop = document.getElementById('regionSheetBackdrop');
    const sheet = document.getElementById('regionBottomSheet');
    if (!backdrop || !sheet) return;
    sheet.classList.remove('open');
    backdrop.classList.remove('open');
    document.body.style.overflow = '';
  }

  private setupIdleDetection(): void {
    this.boundIdleResetHandler = () => {
      if (this.ctx.isIdle) {
        this.ctx.isIdle = false;
        document.body?.classList.remove('animations-paused');
      }
      this.resetIdleTimer();
    };

    ['mousedown', 'keydown', 'scroll', 'touchstart', 'mousemove'].forEach(event => {
      document.addEventListener(event, this.boundIdleResetHandler!, { passive: true });
    });

    this.resetIdleTimer();
  }

  resetIdleTimer(): void {
    if (this.idleTimeoutId) {
      clearTimeout(this.idleTimeoutId);
    }
    this.idleTimeoutId = setTimeout(() => {
      if (!document.hidden) {
        this.ctx.isIdle = true;
        document.body?.classList.add('animations-paused');
        console.log('[App] User idle - pausing animations to save resources');
      }
    }, this.idlePauseMs);
  }

  setupUrlStateSync(): void {
    if (!this.ctx.map) return;

    this.ctx.map.onStateChanged(() => {
      this.debouncedUrlSync();
      const regionSelect = document.getElementById('regionSelect') as HTMLSelectElement;
      if (regionSelect && this.ctx.map) {
        const state = this.ctx.map.getState();
        if (regionSelect.value !== state.view) {
          regionSelect.value = state.view;
        }
      }
      this.debouncedWebcamReload();
    });
    this.debouncedUrlSync();
  }

  syncUrlState(): void {
    this.debouncedUrlSync();
  }

  getShareUrl(): string | null {
    if (!this.ctx.map) return null;
    const state = this.ctx.map.getState();
    const center = this.ctx.map.getCenter();
    const baseUrl = `${window.location.origin}${window.location.pathname}`;
    const briefPage = this.ctx.countryBriefPage;
    const isCountryVisible = briefPage?.isVisible() ?? false;
    return buildMapUrl(baseUrl, {
      view: state.view,
      zoom: state.zoom,
      center,
      timeRange: state.timeRange,
      layers: state.layers,
      country: isCountryVisible ? (briefPage?.getCode() ?? undefined) : undefined,
      expanded: isCountryVisible && briefPage?.getIsMaximized?.() ? true : undefined,
    });
  }

  private async copyToClipboard(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }

  private platformLabel(p: Platform): string {
    switch (p) {
      case 'macos-arm64': return '\uF8FF Silicon';
      case 'macos-x64': return '\uF8FF Intel';
      case 'macos': return '\uF8FF macOS';
      case 'windows': return 'Windows';
      case 'linux': return 'Linux';
      default: return t('header.downloadApp');
    }
  }

  private initDownloadDropdown(): void {
    const btn = document.getElementById('downloadBtn');
    const dropdown = document.getElementById('downloadDropdown');
    const label = document.getElementById('downloadBtnLabel');
    if (!btn || !dropdown) return;

    const platform = detectPlatform();
    if (label) label.textContent = this.platformLabel(platform);

    const primary = buttonsForPlatform(platform);
    const all = allButtons();
    const others = all.filter(b => !primary.some(p => p.href === b.href));

    const renderDropdown = () => {
      const primaryHtml = primary.map(b =>
        `<a class="dl-dd-btn ${b.cls} primary" href="${b.href}">${b.label}</a>`
      ).join('');
      const othersHtml = others.map(b =>
        `<a class="dl-dd-btn ${b.cls}" href="${b.href}">${b.label}</a>`
      ).join('');

      dropdown.innerHTML = `
        <div class="dl-dd-tagline">${t('modals.downloadBanner.description')}</div>
        <div class="dl-dd-buttons">${primaryHtml}</div>
        ${others.length ? `<button class="dl-dd-toggle" id="dlDdToggle">${t('modals.downloadBanner.showAllPlatforms')}</button>
        <div class="dl-dd-others" id="dlDdOthers">${othersHtml}</div>` : ''}
      `;

      dropdown.querySelectorAll<HTMLAnchorElement>('.dl-dd-btn').forEach(a => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const plat = new URL(a.href, location.origin).searchParams.get('platform') || 'unknown';
          trackDownloadClicked(plat);
          window.open(a.href, '_blank');
          dropdown.classList.remove('open');
        });
      });

      const toggle = dropdown.querySelector('#dlDdToggle');
      const othersEl = dropdown.querySelector('#dlDdOthers') as HTMLElement | null;
      if (toggle && othersEl) {
        toggle.addEventListener('click', () => {
          const showing = othersEl.classList.toggle('show');
          toggle.textContent = showing
            ? t('modals.downloadBanner.showLess')
            : t('modals.downloadBanner.showAllPlatforms');
        });
      }
    };

    renderDropdown();

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('open');
    });

    this.boundDropdownClickHandler = (e: MouseEvent) => {
      if (!dropdown.contains(e.target as Node) && !btn.contains(e.target as Node)) {
        dropdown.classList.remove('open');
      }
    };
    document.addEventListener('click', this.boundDropdownClickHandler);

    this.boundDropdownKeydownHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dropdown.classList.remove('open');
    };
    document.addEventListener('keydown', this.boundDropdownKeydownHandler);
  }

  private initFooterDownload(): void {
    const mount = document.getElementById('footerDownloadMount');
    if (!mount) return;
    const platform = detectPlatform();
    const primary = buttonsForPlatform(platform);
    const btn = primary[0];
    if (!btn) return;
    const a = document.createElement('a');
    a.href = btn.href;
    a.textContent = t('header.downloadApp');
    a.className = 'site-footer-download-link';
    a.target = '_blank';
    a.rel = 'noopener';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const plat = new URL(btn.href, location.origin).searchParams.get('platform') || 'unknown';
      trackDownloadClicked(plat);
      window.open(btn.href, '_blank');
    });
    mount.replaceWith(a);
  }

  private setCopyLinkFeedback(button: HTMLElement | null, message: string): void {
    if (!button) return;
    const originalText = button.textContent ?? '';
    button.textContent = message;
    button.classList.add('copied');
    window.setTimeout(() => {
      button.textContent = originalText;
      button.classList.remove('copied');
    }, 1500);
  }

  private getFullscreenDocument(): Document & {
    webkitFullscreenElement?: Element | null;
    webkitExitFullscreen?: () => Promise<void> | void;
  } {
    return document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => Promise<void> | void;
    };
  }

  private syncMapAfterLayoutChange(delayMs = 320): void {
    const sync = () => {
      this.ctx.map?.setIsResizing(false);
      this.ctx.map?.resize();
    };

    requestAnimationFrame(sync);
    window.setTimeout(sync, delayMs);
  }

  private async exitFullscreenForNavigation(): Promise<void> {
    const fullscreenDocument = this.getFullscreenDocument();
    if (!fullscreenDocument.fullscreenElement && !fullscreenDocument.webkitFullscreenElement) return;
    try {
      if (typeof fullscreenDocument.exitFullscreen === 'function') {
        await fullscreenDocument.exitFullscreen();
        return;
      }
      await fullscreenDocument.webkitExitFullscreen?.();
    } catch { /* proceed with navigation regardless */ }
  }

  private async navigateToVariant(
    variant: string,
    options: { href?: string; isLocalDev: boolean },
  ): Promise<void> {
    trackVariantSwitch(SITE_VARIANT, variant);
    await this.exitFullscreenForNavigation();

    if (this.ctx.isDesktopApp || options.isLocalDev) {
      localStorage.setItem('worldmonitor-variant', variant);
      window.location.reload();
      return;
    }

    const target = options.href || VARIANT_META[variant]?.url;
    if (!target) return;
    try {
      const parsed = new URL(target, window.location.href);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
      window.location.href = parsed.toString();
    } catch {
      return;
    }
  }

  toggleFullscreen(): void {
    const fullscreenDocument = this.getFullscreenDocument();
    if (fullscreenDocument.fullscreenElement || fullscreenDocument.webkitFullscreenElement) {
      try {
        const exitResult = typeof fullscreenDocument.exitFullscreen === 'function'
          ? fullscreenDocument.exitFullscreen()
          : fullscreenDocument.webkitExitFullscreen?.();
        void Promise.resolve(exitResult).catch(() => { });
      } catch { }
    } else {
      const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
      if (el.requestFullscreen) {
        try { void el.requestFullscreen()?.catch(() => { }); } catch { }
      } else if (el.webkitRequestFullscreen) {
        try { el.webkitRequestFullscreen(); } catch { }
      }
    }
  }

  private updateMobileMenuThemeItem(): void {
    const btn = document.getElementById('mobileMenuTheme');
    if (!btn) return;
    const isDark = getCurrentTheme() === 'dark';
    const icon = btn.querySelector('.mobile-menu-item-icon');
    const label = btn.querySelector('.mobile-menu-item-label');
    if (icon) icon.textContent = isDark ? '☀️' : '🌙';
    if (label) label.textContent = isDark ? 'Light Mode' : 'Dark Mode';
  }

  startHeaderClock(): void {
    const el = document.getElementById('headerClock');
    if (!el) return;
    const tick = () => {
      el.textContent = new Date().toUTCString().replace('GMT', 'UTC');
    };
    tick();
    this.clockIntervalId = setInterval(tick, 1000);
  }

  setupStatusPanel(): void {
    this.ctx.statusPanel = new StatusPanel();
  }

  setupPizzIntIndicator(): void {
    if (SITE_VARIANT !== 'full') return;

    this.ctx.pizzintIndicator = new PizzIntIndicator();
    const headerLeft = this.ctx.container.querySelector('.header-left');
    if (headerLeft) {
      headerLeft.appendChild(this.ctx.pizzintIndicator.getElement());
    }
  }

  setupLlmStatusIndicator(): void {
    if (!isDesktopRuntime()) return;
    this.ctx.llmStatusIndicator = new LlmStatusIndicator();
    const headerRight = this.ctx.container.querySelector('.header-right');
    if (headerRight) {
      headerRight.appendChild(this.ctx.llmStatusIndicator.getElement());
    }
  }

  setupExportPanel(): void {
    // Always create — show/hide reactively via auth state subscription below.
    this.ctx.exportPanel = new ExportPanel(() => {
      const allCards = this.ctx.correlationEngine?.getAllCards() ?? [];
      const disabledCount = this.ctx.disabledSources.size;
      return {
        meta: {
          exportedAt: new Date().toISOString(),
          note: disabledCount > 0
            ? `Export reflects currently enabled sources only. ${disabledCount} source(s) are disabled and not included.`
            : 'Export reflects all active sources.',
        },
        timestamp: Date.now(),
        news: this.ctx.allNews,
        newsClusters: this.ctx.latestClusters.length > 0 ? this.ctx.latestClusters : undefined,
        newsByCategory: this.ctx.newsByCategory,
        markets: this.ctx.latestMarkets,
        predictions: this.ctx.latestPredictions,
        intelligence: this.ctx.intelligenceCache,
        cyberThreats: this.ctx.cyberThreatsCache ?? undefined,
        gpsJamming: getCachedGpsInterference() ?? undefined,
        convergenceCards: allCards.map(({ assessment: _a, ...card }) => card),
        monitors: this.ctx.monitors.length > 0 ? this.ctx.monitors : undefined,
      };
    });

    const el = this.ctx.exportPanel.getElement();
    const headerRight = this.ctx.container.querySelector('.header-right');
    if (headerRight) {
      headerRight.insertBefore(el, headerRight.firstChild);
    }

    const applyProGate = (isPro: boolean, initial = false) => {
      el.style.display = isPro ? '' : 'none';
      if (initial && !isPro) trackGateHit('export');
    };
    applyProGate(getAuthState().user?.role === 'pro', true);
    this.proGateUnsubscribers.push(subscribeAuthState(state => applyProGate(state.user?.role === 'pro')));
  }

  setupUnifiedSettings(): void {
    this.ctx.unifiedSettings = new UnifiedSettings({
      getPanelSettings: () => this.ctx.panelSettings,
      savePanelSettings: (panels: Record<string, PanelConfig>) => {
        Object.entries(panels).forEach(([key, nextConfig]) => {
          const current = this.ctx.panelSettings[key];
          if (!current) {
            this.ctx.panelSettings[key] = { ...nextConfig };
            trackPanelToggled(key, nextConfig.enabled);
            return;
          }
          if (current.enabled !== nextConfig.enabled) {
            trackPanelToggled(key, nextConfig.enabled);
          }
          Object.assign(current, nextConfig);
        });
        saveToStorage(STORAGE_KEYS.panels, this.ctx.panelSettings);
        this.applyPanelSettings();
        this.callbacks.updateSearchIndex();
      },
      getDisabledSources: () => this.ctx.disabledSources,
      toggleSource: (name: string) => {
        const reenabling = this.ctx.disabledSources.has(name);
        if (reenabling && !isProUser()) {
          const allSources = this.getAllSourceNames();
          const currentlyEnabled = allSources.filter(n => !this.ctx.disabledSources.has(n)).length;
          if (currentlyEnabled + 1 > FREE_MAX_SOURCES) {
            this.showToast(t('modals.settingsWindow.freeSourceLimit', { max: String(FREE_MAX_SOURCES) }));
            return;
          }
        }
        if (reenabling) {
          this.ctx.disabledSources.delete(name);
        } else {
          this.ctx.disabledSources.add(name);
        }
        saveToStorage(STORAGE_KEYS.disabledFeeds, Array.from(this.ctx.disabledSources));
      },
      setSourcesEnabled: (names: string[], enabled: boolean) => {
        if (enabled && !isProUser()) {
          const allSources = this.getAllSourceNames();
          const currentlyEnabled = allSources.filter(n => !this.ctx.disabledSources.has(n)).length;
          const wouldEnable = names.filter(n => this.ctx.disabledSources.has(n) && allSources.includes(n)).length;
          if (currentlyEnabled + wouldEnable > FREE_MAX_SOURCES) {
            this.showToast(t('modals.settingsWindow.freeSourceLimit', { max: String(FREE_MAX_SOURCES) }));
            return;
          }
        }
        for (const name of names) {
          if (enabled) this.ctx.disabledSources.delete(name);
          else this.ctx.disabledSources.add(name);
        }
        saveToStorage(STORAGE_KEYS.disabledFeeds, Array.from(this.ctx.disabledSources));
      },
      getAllSourceNames: () => this.getAllSourceNames(),
      getLocalizedPanelName: (key: string, fallback: string) => this.getLocalizedPanelName(key, fallback),
      resetLayout: () => {
        localStorage.removeItem(this.ctx.PANEL_SPANS_KEY);
        localStorage.removeItem('worldmonitor-panel-col-spans');
        localStorage.removeItem(this.ctx.PANEL_ORDER_KEY);
        localStorage.removeItem(this.ctx.PANEL_ORDER_KEY + '-bottom');
        localStorage.removeItem(this.ctx.PANEL_ORDER_KEY + '-bottom-set');
        localStorage.removeItem('map-height');
        window.location.reload();
      },
      isDesktopApp: this.ctx.isDesktopApp,
      onMapProviderChange: () => {
        this.ctx.map?.reloadBasemap();
      },
    });

    const mount = document.getElementById('unifiedSettingsMount');
    if (mount) {
      mount.appendChild(this.ctx.unifiedSettings.getButton());
    }

    const mobileBtn = document.getElementById('mobileSettingsBtn');
    if (mobileBtn) {
      mobileBtn.addEventListener('click', () => this.ctx.unifiedSettings?.open());
    }
  }

  setupAuthWidget(): void {
    const modal = new AuthLauncher();
    this.ctx.authModal = modal;

    const widget = new AuthHeaderWidget(
      () => modal.open(),
      () => this.ctx.unifiedSettings?.open(),
    );
    this.ctx.authHeaderWidget = widget;
    const mount = document.getElementById('authWidgetMount');
    if (mount) {
      mount.appendChild(widget.getElement());
    }
  }

  setupPlaybackControl(): void {
    // Always create — show/hide reactively via auth state subscription below.
    this.ctx.playbackControl = new PlaybackControl();
    this.ctx.playbackControl.onSnapshot((snapshot) => {
      if (snapshot) {
        this.ctx.isPlaybackMode = true;
        this.restoreSnapshot(snapshot);
      } else {
        this.ctx.isPlaybackMode = false;
        this.callbacks.loadAllData();
      }
    });

    const el = this.ctx.playbackControl.getElement();
    const headerRight = this.ctx.container.querySelector('.header-right');
    if (headerRight) {
      headerRight.insertBefore(el, headerRight.firstChild);
    }

    const applyProGate = (isPro: boolean, initial = false) => {
      el.style.display = isPro ? '' : 'none';
      if (initial && !isPro) trackGateHit('playback');
    };
    applyProGate(getAuthState().user?.role === 'pro', true);
    this.proGateUnsubscribers.push(subscribeAuthState(state => applyProGate(state.user?.role === 'pro')));
  }

  setupSnapshotSaving(): void {
    const saveCurrentSnapshot = async () => {
      if (this.ctx.isPlaybackMode || this.ctx.isDestroyed) return;

      const marketPrices: Record<string, number> = {};
      this.ctx.latestMarkets.forEach(m => {
        if (m.price !== null) marketPrices[m.symbol] = m.price;
      });

      await saveSnapshot({
        timestamp: Date.now(),
        events: this.ctx.latestClusters,
        marketPrices,
        predictions: this.ctx.latestPredictions.map(p => ({
          title: p.title,
          yesPrice: p.yesPrice
        })),
        hotspotLevels: this.ctx.map?.getHotspotLevels() ?? {}
      });
    };

    void saveCurrentSnapshot().catch((e) => console.warn('[Snapshot] save failed:', e));
    this.snapshotIntervalId = setInterval(() => void saveCurrentSnapshot().catch((e) => console.warn('[Snapshot] save failed:', e)), 15 * 60 * 1000);
  }

  restoreSnapshot(snapshot: DashboardSnapshot): void {
    for (const panel of Object.values(this.ctx.newsPanels)) {
      panel.showLoading();
    }

    const events = snapshot.events as ClusteredEvent[];
    this.ctx.latestClusters = events;

    const predictions = snapshot.predictions.map((p, i) => ({
      id: `snap-${i}`,
      title: p.title,
      yesPrice: p.yesPrice,
      noPrice: 100 - p.yesPrice,
      volume24h: 0,
      liquidity: 0,
    }));
    this.ctx.latestPredictions = predictions;
    (this.ctx.panels.polymarket as PredictionPanel | undefined)?.renderPredictions(predictions);

    this.ctx.map?.setHotspotLevels(snapshot.hotspotLevels);
  }

  setupMapLayerHandlers(): void {
    this.ctx.map?.setOnLayerChange((layer, enabled, source) => {
      console.log(`[App.onLayerChange] ${layer}: ${enabled} (${source})`);
      trackMapLayerToggle(layer, enabled, source);
      this.ctx.mapLayers[layer] = enabled;
      saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
      this.syncUrlState();

      const sourceIds = LAYER_TO_SOURCE[layer];
      if (sourceIds) {
        for (const sourceId of sourceIds) {
          dataFreshness.setEnabled(sourceId, enabled);
        }
      }

      if (layer === 'ais') {
        if (enabled) {
          this.ctx.map?.setLayerLoading('ais', true);
          initAisStream();
          this.callbacks.waitForAisData();
        } else {
          disconnectAisStream();
        }
        return;
      }

      if (layer === 'flights') {
        const airlineIntel = this.ctx.panels['airline-intel'] as AirlineIntelPanel | undefined;
        airlineIntel?.setLiveMode(enabled);
      }

      if (enabled) {
        this.callbacks.loadDataForLayer(layer);
      } else {
        this.callbacks.stopLayerActivity?.(layer as keyof MapLayers);
      }
    });

    // Forward live aircraft positions from map to AirlineIntelPanel + cache + search index
    this.ctx.map?.setOnAircraftPositionsUpdate((positions) => {
      this.ctx.intelligenceCache.aircraftPositions = positions;
      const airlineIntel = this.ctx.panels['airline-intel'] as AirlineIntelPanel | undefined;
      airlineIntel?.updateLivePositions(positions);
      const military = this.ctx.intelligenceCache.military?.flights ?? [];
      this.callbacks.updateFlightSource?.(positions, military);
    });
  }

  setupPanelViewTracking(): void {
    const viewedPanels = new Set<string>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio >= 0.3) {
          const id = (entry.target as HTMLElement).dataset.panel;
          if (id && !viewedPanels.has(id)) {
            viewedPanels.add(id);
            trackPanelView(id);
          }
        }
      }
    }, { threshold: 0.3 });

    const grid = document.getElementById('panelsGrid');
    if (grid) {
      for (const child of Array.from(grid.children)) {
        if ((child as HTMLElement).dataset.panel) {
          observer.observe(child);
        }
      }
    }
  }

  showToast(msg: string): void {
    document.querySelector('.toast-notification')?.remove();
    const el = document.createElement('div');
    el.className = 'toast-notification';
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('visible'));
    setTimeout(() => { el.classList.remove('visible'); setTimeout(() => el.remove(), 300); }, 3000);
  }

  shouldShowIntelligenceNotifications(): boolean {
    return !this.ctx.isMobile && !!this.ctx.findingsBadge?.isPopupEnabled();
  }

  setupMapResize(): void {
    const mapSection = document.getElementById('mapSection');
    const mapContainer = document.getElementById('mapContainer');
    const resizeHandle = document.getElementById('mapResizeHandle');
    if (!mapSection || !resizeHandle || !mapContainer) return;

    const getMinHeight = () => (window.innerWidth >= 1600 ? 280 : 350);
    const getMaxHeight = () => {
      if (window.innerWidth < 1600) return Math.max(getMinHeight(), window.innerHeight - 150);

      const bottomGrid = document.getElementById('mapBottomGrid');
      const isEmpty = !bottomGrid || bottomGrid.children.length === 0;
      const headerHeight = 60;
      const totalAvailable = window.innerHeight - headerHeight;

      if (isEmpty) {
        return totalAvailable - 25;
      } else {
        return totalAvailable - 300;
      }
    };

    const savedHeight = localStorage.getItem('map-height');
    if (savedHeight) {
      const numeric = Number.parseInt(savedHeight, 10);
      if (Number.isFinite(numeric)) {
        const clamped = Math.max(getMinHeight(), Math.min(numeric, getMaxHeight()));
        if (window.innerWidth >= 1600) {
          mapContainer.style.flex = 'none';
          mapContainer.style.height = `${clamped}px`;
        } else {
          mapSection.style.height = `${clamped}px`;
        }
        if (clamped !== numeric) {
          localStorage.setItem('map-height', `${clamped}px`);
        }
      } else {
        localStorage.removeItem('map-height');
      }
    }

    let isResizing = false;
    let startY = 0;
    let startHeight = 0;

    const getTarget = () => (window.innerWidth >= 1600 ? mapContainer : mapSection);

    this.boundMapEndResizeHandler = () => {
      if (!isResizing) return;
      isResizing = false;
      this.ctx.map?.setIsResizing(false);
      this.ctx.map?.resize();
      mapSection.classList.remove('resizing');
      document.body.style.cursor = '';
      localStorage.setItem('map-height', getTarget().style.height);
    };
    const endResize = this.boundMapEndResizeHandler;

    resizeHandle.addEventListener('mousedown', (e) => {
      isResizing = true;
      startY = e.clientY;
      const target = getTarget();
      startHeight = target.offsetHeight;
      this.ctx.map?.setIsResizing(true);
      mapSection.classList.add('resizing');
      document.body.style.cursor = 'ns-resize';
      e.preventDefault();
    });

    resizeHandle.addEventListener('dblclick', () => {
      const isWide = window.innerWidth >= 1600;
      const target = isWide ? mapContainer : mapSection;

      const targetHeight = window.innerHeight * 0.5;
      const finalHeight = Math.max(getMinHeight(), Math.min(targetHeight, getMaxHeight()));

      this.ctx.map?.setIsResizing(true);
      target.classList.add('map-section-smooth');

      if (isWide) target.style.flex = 'none';
      target.style.height = `${finalHeight}px`;

      let fired = false;
      const onEnd = () => {
        if (fired) return;
        fired = true;

        target.classList.remove('map-section-smooth');
        target.removeEventListener('transitionend', onEnd);
        localStorage.setItem('map-height', `${finalHeight}px`);
        this.ctx.map?.setIsResizing(false);
        this.ctx.map?.resize();
      };

      target.addEventListener('transitionend', onEnd);
      this.ctx.map?.resize();
      setTimeout(onEnd, 500);
    });

    this.boundMapResizeMoveHandler = (e: MouseEvent) => {
      if (!isResizing) return;
      const isWide = window.innerWidth >= 1600;
      const target = isWide ? mapContainer : mapSection;

      const deltaY = e.clientY - startY;
      const newHeight = Math.max(getMinHeight(), Math.min(startHeight + deltaY, getMaxHeight()));

      if (isWide) target.style.flex = 'none';
      target.style.height = `${newHeight}px`;

      this.ctx.map?.resize();
    };
    document.addEventListener('mousemove', this.boundMapResizeMoveHandler);

    document.addEventListener('mouseup', endResize);
    window.addEventListener('blur', endResize);
    this.boundMapResizeVisChangeHandler = () => {
      if (document.hidden) endResize();
    };
    document.addEventListener('visibilitychange', this.boundMapResizeVisChangeHandler);
  }

  setupMapWidthResize(): void {
    const mainContent = document.querySelector<HTMLElement>('.main-content');
    const widthHandle = document.getElementById('mapWidthResizeHandle');
    if (!mainContent || !widthHandle) return;

    const saved = localStorage.getItem('map-col-width');
    if (saved) mainContent.style.setProperty('--map-col-width', saved);

    let isResizing = false;
    let startX = 0;
    let startTotalWidth = 0;
    let startColPx = 0;

    this.boundMapWidthEndResizeHandler = () => {
      if (!isResizing) return;
      isResizing = false;
      this.ctx.map?.setIsResizing(false);
      this.ctx.map?.resize();
      document.body.classList.remove('map-width-resizing');
      widthHandle.classList.remove('resizing');
      const current = mainContent.style.getPropertyValue('--map-col-width');
      if (current) localStorage.setItem('map-col-width', current);
    };

    widthHandle.addEventListener('mousedown', (e) => {
      isResizing = true;
      startX = e.clientX;
      startTotalWidth = mainContent.offsetWidth;
      const raw = mainContent.style.getPropertyValue('--map-col-width') || '60%';
      startColPx = startTotalWidth * (parseFloat(raw) / 100);
      this.ctx.map?.setIsResizing(true);
      document.body.classList.add('map-width-resizing');
      widthHandle.classList.add('resizing');
      e.preventDefault();
    });

    this.boundMapWidthResizeMoveHandler = (e: MouseEvent) => {
      if (!isResizing) return;
      const delta = e.clientX - startX;
      const newPct = Math.max(25, Math.min(75, ((startColPx + delta) / startTotalWidth) * 100));
      mainContent.style.setProperty('--map-col-width', `${newPct.toFixed(1)}%`);
      this.ctx.map?.resize();
    };

    document.addEventListener('mousemove', this.boundMapWidthResizeMoveHandler);
    document.addEventListener('mouseup', this.boundMapWidthEndResizeHandler);
    window.addEventListener('blur', this.boundMapWidthEndResizeHandler);
  }

  setupMapPin(): void {
    const mapSection = document.getElementById('mapSection');
    const pinBtn = document.getElementById('mapPinBtn');
    if (!mapSection || !pinBtn) return;

    const isPinned = localStorage.getItem('map-pinned') === 'true';
    if (isPinned) {
      mapSection.classList.add('pinned');
      pinBtn.classList.add('active');
    }

    pinBtn.addEventListener('click', () => {
      const nowPinned = mapSection.classList.toggle('pinned');
      pinBtn.classList.toggle('active', nowPinned);
      localStorage.setItem('map-pinned', String(nowPinned));
    });

    this.setupMapFullscreen(mapSection);
    this.setupMapDimensionToggle();
  }

  private setupMapDimensionToggle(): void {
    const toggle = document.getElementById('mapDimensionToggle');
    if (!toggle) return;
    toggle.querySelectorAll<HTMLButtonElement>('.map-dim-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        if (!mode) return;
        const isGlobe = mode === 'globe';
        const alreadyGlobe = this.ctx.map?.isGlobeMode() ?? false;
        if (isGlobe === alreadyGlobe) return;
        toggle.querySelectorAll('.map-dim-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        saveToStorage(STORAGE_KEYS.mapMode, isGlobe ? 'globe' : 'flat');
        if (isGlobe) {
          this.ctx.map?.switchToGlobe();
        } else {
          this.ctx.map?.switchToFlat();
        }
      });
    });
  }

  private setupMapFullscreen(mapSection: HTMLElement): void {
    const btn = document.getElementById('mapFullscreenBtn');
    if (!btn) return;
    const expandSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
    const shrinkSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/></svg>';
    let isFullscreen = false;

    const toggle = () => {
      isFullscreen = !isFullscreen;
      mapSection.classList.toggle('live-news-fullscreen', isFullscreen);
      document.body.classList.toggle('live-news-fullscreen-active', isFullscreen);
      btn.innerHTML = isFullscreen ? shrinkSvg : expandSvg;
      btn.title = isFullscreen ? 'Exit fullscreen' : 'Fullscreen';
      this.syncMapAfterLayoutChange();
    };

    btn.addEventListener('click', toggle);
    this.boundMapFullscreenEscHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isFullscreen) toggle();
    };
    document.addEventListener('keydown', this.boundMapFullscreenEscHandler);
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
          this.callbacks.ensureCorrectZones();
        }
        return;
      }
      const panel = this.ctx.panels[key];
      panel?.toggle(config.enabled);
    });
  }
}
