import type {
  AppContext,
  AppModule,
  UnifiedSettingsController,
  UnifiedSettingsTabId,
} from '@/app/app-context';
import type { UnifiedSettingsConfig } from '@/components/UnifiedSettings';
import type { AirlineIntelPanel } from '@/components/AirlineIntelPanel';
import type { CustomWidgetPanel } from '@/components/CustomWidgetPanel';
import { deleteWidget, getWidget, saveWidget, isProUser } from '@/services/widget-store';
import {
  FREE_MAX_PANELS,
  FREE_MAX_SOURCES,
  countFreePanelCapUsage,
  isFreePanelCapCounted,
} from '@/config/panels';
import type { McpDataPanel } from '@/components/McpDataPanel';
import { deleteMcpPanel, getMcpPanel, saveMcpPanel } from '@/services/mcp-store';
import type { PanelConfig, MapLayers, MilitaryFlight } from '@/types';
import type { MapView } from '@/components/MapContainer';
import type { PositionSample } from '@/services/aviation';
import type { ClusteredEvent } from '@/types';
import type { DashboardSnapshot } from '@/services/storage';
import { PlaybackControl } from '@/components/PlaybackControl';
import { PizzIntIndicator } from '@/components/PizzIntIndicator';
import { LlmStatusIndicator } from '@/components/LlmStatusIndicator';
import type { PredictionPanel } from '@/components/PredictionPanel';
import {
  buildMapUrl,
  debounce,
  saveToStorage,
  getCurrentTheme,
  setTheme,
  showToast,
} from '@/utils';
import { clearPanelColSpans, clearPanelSpans } from '@/utils/panel-storage';
import {
  IDLE_PAUSE_MS,
  DEFAULT_MAP_LAYERS,
  MOBILE_DEFAULT_MAP_LAYERS,
  STORAGE_KEYS,
  SITE_VARIANT,
  LAYER_TO_SOURCE,
  FEEDS,
  CANONICAL_FEEDS,
  INTEL_SOURCES,
} from '@/config';
import { resolveNewsCategories, enabledNewsCategoryKeys } from '@/config/feed-resolution';
import { VARIANT_META } from '@/config/variant-meta';
import { isDesktopRuntime } from '@/services/runtime';
import {
  MISSION_PRESETS,
  applyMissionPresetToState,
  clearMissionPreset,
  dismissMissionPresetPrompt,
  filterMissionLayersForRenderer,
  isMissionPresetPromptDismissed,
  loadStoredMissionPreset,
  resetMissionPresetState,
  saveMissionPreset,
  type MissionPreset,
  type MissionPresetId,
} from '@/services/mission-presets';
import {
  saveSnapshot,
  initAisStream,
  disconnectAisStream,
  isAisConfigured,
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
import { WM_OPEN_NOTIFICATIONS_FOR_COUNTRY } from '@/utils/notify-country-link';
import { AuthLauncher } from '@/components/AuthLauncher';
import { AuthHeaderWidget } from '@/components/AuthHeaderWidget';
import { t } from '@/services/i18n';
import { TvModeController } from '@/services/tv-mode';
import { getAuthState, subscribeAuthState } from '@/services/auth-state';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { scheduleAfterFirstPaint } from '@/utils/after-paint';
import { escapeHtml } from '@/utils/sanitize';
import { buildEmbedIframeSnippet, buildEmbedMapUrl, type EmbedVariant } from '@/embed/embed-url';
import { createSettingsButton } from '@/components/settings-button';

function readStorageValue(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorageValue(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // UI preferences remain in memory for the current page.
  }
}

function removeStorageValue(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage is optional for UI preferences.
  }
}

type RealUnifiedSettings = import('@/components/UnifiedSettings').UnifiedSettings;

class LazyUnifiedSettings implements UnifiedSettingsController {
  private readonly button: HTMLButtonElement;
  private instance: RealUnifiedSettings | null = null;
  private loadPromise: Promise<RealUnifiedSettings> | null = null;
  private destroyed = false;

  constructor(private readonly config: UnifiedSettingsConfig) {
    this.button = createSettingsButton(() => this.open());
  }

  getButton(): HTMLButtonElement {
    return this.button;
  }

  open(tab?: UnifiedSettingsTabId): void {
    void this.load().then((settings) => {
      if (!this.destroyed) settings.open(tab);
    }).catch((error) => {
      // A rejection because the controller was torn down mid-load is a
      // deliberate unmount, not a failure the user should be toasted about.
      if (this.destroyed) return;
      console.warn('[settings] Failed to load settings window:', error);
      showToast(t('common.error'));
    });
  }

  refreshPanelToggles(): void {
    this.instance?.refreshPanelToggles();
  }

  destroy(): void {
    this.destroyed = true;
    this.instance?.destroy();
    this.instance = null;
  }

  private load(): Promise<RealUnifiedSettings> {
    if (this.destroyed) {
      return Promise.reject(new Error('Settings controller destroyed'));
    }
    if (this.instance) return Promise.resolve(this.instance);
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = import('@/components/UnifiedSettings')
      .then(({ UnifiedSettings }) => {
        const settings = new UnifiedSettings(this.config);
        if (this.destroyed) {
          settings.destroy();
          throw new Error('Settings controller destroyed during load');
        }
        this.instance = settings;
        return settings;
      })
      .finally(() => {
        this.loadPromise = null;
      });

    return this.loadPromise;
  }
}


export interface EventHandlerCallbacks {
  openSearch: (options?: { toggle?: boolean }) => void;
  updateSearchIndex: () => void;
  updateFlightSource?: (adsb: PositionSample[], military: MilitaryFlight[]) => void;
  loadAllData: () => Promise<void>;
  flushStaleRefreshes: () => void;
  setHiddenSince: (ts: number) => void;
  loadDataForLayer: (layer: string) => void;
  waitForAisData: () => void;
  syncDataFreshnessWithLayers: () => void;
  ensureCorrectZones: () => void;
  applySavedPanelOrder?: (panelOrder?: string[]) => void;
  refreshCiiAfterFocalPointsReady?: () => void;
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
  private readonly registeredSearchButtons = new Set<string>();
  private boundSearchKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  private boundMobileMenuKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  private boundPanelCloseHandler: ((e: Event) => void) | null = null;
  private boundWidgetModifyHandler: ((e: Event) => void) | null = null;
  private boundUndoHandler: ((e: KeyboardEvent) => void) | null = null;
  private boundNotifyForCountryHandler: ((e: Event) => void) | null = null;
  private boundMissionOutsideHandler: ((e: MouseEvent) => void) | null = null;
  private boundMissionKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private boundEmbedModalKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private missionPresetPopover: HTMLElement | null = null;
  private missionDataRefreshTimer: number | null = null;
  private proGateUnsubscribers: Array<() => void> = [];
  private exportPanelLoad: Promise<NonNullable<AppContext['exportPanel']>> | null = null;
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
    this.setupSearchControls();
    this.setupEventListeners();
    this.setupIdleDetection();
    this.setupTvMode();
  }

  private performUndo(): void {
    const panelId = this.closedPanelStack.pop();
    if (!panelId) return;
    this.enablePanelById(panelId);
  }

  /**
   * Enables a registered panel (undo-restore, CMD+K "Add", etc.). Returns
   * false when the panel is unknown or the free-tier cap blocks it. Already
   * enabled → true (no-op). Single source of truth for runtime panel-enable
   * so search-add and undo-restore stay in lockstep.
   */
  enablePanelById(panelId: string): boolean {
    const config = this.ctx.panelSettings[panelId];
    if (!config) return false;
    if (config.enabled) return true;
    if (!isProUser() && isFreePanelCapCounted(panelId)) {
      const enabledCount = countFreePanelCapUsage(this.ctx.panelSettings);
      if (enabledCount >= FREE_MAX_PANELS) {
        // Tell the user why nothing happened instead of failing silently.
        // (Undo-restore can't reach this branch — closing a panel frees a
        // slot first — so only the CMD+K "Add" path surfaces the toast.)
        showToast(t('modals.settingsWindow.freePanelLimit', { max: String(FREE_MAX_PANELS) }));
        return false;
      }
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
    return true;
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
    this.closeEmbedDialog();
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
    if (this.boundSearchKeyHandler) {
      document.removeEventListener('keydown', this.boundSearchKeyHandler);
      this.boundSearchKeyHandler = null;
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
    if (this.boundNotifyForCountryHandler) {
      window.removeEventListener(
        WM_OPEN_NOTIFICATIONS_FOR_COUNTRY,
        this.boundNotifyForCountryHandler,
      );
      this.boundNotifyForCountryHandler = null;
    }
    this.closeMissionPresetPopover();
    if (this.missionDataRefreshTimer) {
      window.clearTimeout(this.missionDataRefreshTimer);
      this.missionDataRefreshTimer = null;
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

  setupSearchControls(): void {
    // Wire each button independently and idempotently. setupSearchControls() is
    // called across several init phases (buttons are injected at different
    // times); tracking registered IDs in a Set means a button absent at an
    // early call still gets wired when it appears, instead of being permanently
    // skipped by a single latched boolean. (#4403 review)
    const wireSearchButton = (id: string, source: string) => {
      if (this.registeredSearchButtons.has(id)) return;
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('click', () => {
        track('search-open', { source });
        this.callbacks.openSearch();
      });
      this.registeredSearchButtons.add(id);
    };
    wireSearchButton('searchBtn', 'desktop');
    wireSearchButton('mobileSearchBtn', 'mobile');
    wireSearchButton('searchMobileFab', 'fab');
    if (!this.boundSearchKeyHandler) {
      this.boundSearchKeyHandler = (e: KeyboardEvent) => {
        // !e.shiftKey so Cmd/Ctrl+Shift+K (e.g. Firefox web console) doesn't
        // also toggle search; .toLowerCase() still tolerates CapsLock. (#4403)
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          this.callbacks.openSearch({ toggle: true });
        }
      };
      document.addEventListener('keydown', this.boundSearchKeyHandler);
    }
  }

  private setupEventListeners(): void {
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

    document.getElementById('embedLinkBtn')?.addEventListener('click', () => {
      this.openEmbedDialog();
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
      // Live-media teardown is handled centrally by applyPanelSettings() below, which
      // calls stopLiveMediaForClose() on every now-disabled panel. Calling it here too
      // double-fired the lifecycle hook for live-news / live-webcams.
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
      void import('@/components/WidgetChatModal').then((m) => m.openWidgetChatModal({
        mode: 'modify',
        existingSpec: spec,
        onComplete: (updated) => {
          saveWidget(updated);
          (this.ctx.panels[updated.id] as CustomWidgetPanel | undefined)?.updateSpec(updated);
        },
      })).catch((err) => console.error('[widget-chat] failed to lazy-load WidgetChatModal', err));
    }) as EventListener;
    this.ctx.container.addEventListener('wm:widget-modify', this.boundWidgetModifyHandler);

    this.ctx.container.addEventListener('wm:mcp-configure', ((e: CustomEvent<{ panelId: string }>) => {
      const spec = getMcpPanel(e.detail.panelId);
      if (!spec) return;
      void import('@/components/McpConnectModal').then((m) => m.openMcpConnectModal({
        existingSpec: spec,
        onComplete: (updated) => {
          saveMcpPanel(updated);
          (this.ctx.panels[updated.id] as McpDataPanel | undefined)?.updateSpec(updated);
        },
      })).catch((err) => console.error('[mcp-connect] failed to lazy-load McpConnectModal', err));
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
      this.callbacks.refreshCiiAfterFocalPointsReady?.();
    };
    window.addEventListener('focal-points-ready', this.boundFocalPointsReadyHandler);

    this.boundThemeChangedHandler = () => {
      this.ctx.map?.render();
      this.updateMobileMenuThemeItem();
    };
    window.addEventListener('theme-changed', this.boundThemeChangedHandler);

    this.setupMobileMenu();
    this.setupMissionPresets();

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
          window.open(url.toString(), '_blank', 'noopener,noreferrer');
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

  private setupMissionPresets(): void {
    this.renderMissionPresetControl();

    document.getElementById('mobileMenuMission')?.addEventListener('click', () => {
      this.closeMobileMenu();
      this.openMissionPresetPopover(document.getElementById('hamburgerBtn'), true);
    });

    const shouldPrompt =
      !this.ctx.isMobile &&
      !window.location.search &&
      !loadStoredMissionPreset() &&
      !isMissionPresetPromptDismissed();
    if (shouldPrompt) {
      // Defer the onboarding auto-open to browser idle after first paint so it
      // never competes with load or first-interaction work. This replaced a
      // fixed 700ms timeout that forced layout reads (getBoundingClientRect +
      // offsetHeight) on the post-load path. Re-check state at fire time since
      // the idle wait can outlast an early user choice.
      scheduleAfterFirstPaint(() => {
        if (this.ctx.isDestroyed) return;
        if (loadStoredMissionPreset() || isMissionPresetPromptDismissed()) return;
        this.openMissionPresetPopover(document.getElementById('missionPresetBtn'), false);
      });
    }
  }

  private renderMissionPresetControl(): void {
    const mount = document.getElementById('missionPresetMount');
    if (!mount) return;

    const active = loadStoredMissionPreset();
    const label = active?.shortLabel ?? 'Mission';
    const icon = active?.icon ?? '◎';
    const activeClass = active ? ' mission-preset-button--active' : '';
    const suggestedClass = !active && !isMissionPresetPromptDismissed() ? ' mission-preset-button--suggested' : '';

    setTrustedHtml(mount, trustedHtml(`
      <button
        id="missionPresetBtn"
        class="mission-preset-button${activeClass}${suggestedClass}"
        type="button"
        aria-haspopup="dialog"
        aria-expanded="false"
        title="${escapeHtml(active ? `Mission: ${active.label}` : 'Choose mission preset')}"
      >
        <span class="mission-preset-button__icon">${escapeHtml(icon)}</span>
        <span class="mission-preset-button__label">${escapeHtml(label)}</span>
      </button>
    `, 'Mission preset control renders static preset metadata with escaped values'));

    document.getElementById('missionPresetBtn')?.addEventListener('click', () => {
      this.toggleMissionPresetPopover(document.getElementById('missionPresetBtn'), false);
    });

    this.updateMobileMissionLabel(active);
  }

  private updateMobileMissionLabel(active: MissionPreset | null = loadStoredMissionPreset()): void {
    const item = document.getElementById('mobileMenuMission');
    const label = item?.querySelector('.mobile-menu-item-label');
    if (label) label.textContent = active ? `Mission: ${active.shortLabel}` : 'Mission';
  }

  private toggleMissionPresetPopover(anchor: HTMLElement | null, mobile: boolean): void {
    if (this.missionPresetPopover) {
      this.closeMissionPresetPopover();
      return;
    }
    this.openMissionPresetPopover(anchor, mobile);
  }

  private openMissionPresetPopover(anchor: HTMLElement | null, mobile: boolean): void {
    this.closeMissionPresetPopover();

    const active = loadStoredMissionPreset();
    const popover = document.createElement('div');
    popover.className = `mission-preset-popover${mobile ? ' mission-preset-popover--mobile' : ''}`;
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', 'Mission presets');
    popover.tabIndex = -1;

    const cards = MISSION_PRESETS.map((preset) => {
      const selected = active?.id === preset.id;
      return `
        <button
          type="button"
          class="mission-preset-card${selected ? ' selected' : ''}"
          data-mission-id="${escapeHtml(preset.id)}"
          aria-pressed="${selected ? 'true' : 'false'}"
        >
          <span class="mission-preset-card__icon">${escapeHtml(preset.icon)}</span>
          <span class="mission-preset-card__body">
            <strong>${escapeHtml(preset.label)}</strong>
            <small>${escapeHtml(preset.description)}</small>
          </span>
          <span class="mission-preset-card__check">${selected ? '✓' : ''}</span>
        </button>
      `;
    }).join('');

    setTrustedHtml(popover, trustedHtml(`
      <div class="mission-preset-popover__header">
        <div>
          <span>Mission</span>
          <strong>${escapeHtml(active?.label ?? 'Choose Workspace')}</strong>
        </div>
        <div class="mission-preset-popover__actions">
          <button type="button" class="mission-preset-reset" data-mission-reset>Reset</button>
          <button type="button" class="mission-preset-close" data-mission-close aria-label="Close mission presets">×</button>
        </div>
      </div>
      <div class="mission-preset-popover__list">${cards}</div>
    `, 'Mission preset popover renders static preset metadata with escaped values'));

    document.body.appendChild(popover);
    this.missionPresetPopover = popover;
    document.getElementById('missionPresetBtn')?.setAttribute('aria-expanded', 'true');

    if (!mobile && anchor) {
      const rect = anchor.getBoundingClientRect();
      const width = 360;
      const left = Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - width - 12));
      const height = Math.min(popover.offsetHeight || 620, Math.max(120, window.innerHeight - 24));
      const top = Math.min(
        Math.max(12, rect.bottom + 8),
        Math.max(12, window.innerHeight - height - 12),
      );
      popover.style.left = `${left}px`;
      popover.style.top = `${top}px`;
    }

    popover.querySelector('[data-mission-close]')?.addEventListener('click', () => {
      dismissMissionPresetPrompt();
      this.renderMissionPresetControl();
      this.closeMissionPresetPopover();
    });
    popover.querySelector('[data-mission-reset]')?.addEventListener('click', () => {
      this.resetMissionPreset();
    });
    this.boundMissionKeydownHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      dismissMissionPresetPrompt();
      this.renderMissionPresetControl();
      this.closeMissionPresetPopover();
    };
    popover.addEventListener('keydown', this.boundMissionKeydownHandler);
    popover.querySelectorAll<HTMLButtonElement>('[data-mission-id]').forEach((button) => {
      button.addEventListener('click', () => {
        const presetId = button.dataset.missionId as MissionPresetId | undefined;
        if (presetId) this.applyMissionPreset(presetId);
      });
    });

    this.boundMissionOutsideHandler = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (popover.contains(target) || anchor?.contains(target)) return;
      dismissMissionPresetPrompt();
      this.renderMissionPresetControl();
      this.closeMissionPresetPopover();
    };
    window.setTimeout(() => {
      if (this.missionPresetPopover === popover) {
        popover.focus({ preventScroll: true });
      }
      if (this.boundMissionOutsideHandler) {
        document.addEventListener('click', this.boundMissionOutsideHandler);
      }
    }, 0);
  }

  private closeMissionPresetPopover(): void {
    if (this.boundMissionOutsideHandler) {
      document.removeEventListener('click', this.boundMissionOutsideHandler);
      this.boundMissionOutsideHandler = null;
    }
    if (this.boundMissionKeydownHandler && this.missionPresetPopover) {
      this.missionPresetPopover.removeEventListener('keydown', this.boundMissionKeydownHandler);
      this.boundMissionKeydownHandler = null;
    }
    this.missionPresetPopover?.remove();
    this.missionPresetPopover = null;
    document.getElementById('missionPresetBtn')?.setAttribute('aria-expanded', 'false');
  }

  private getMissionDefaultLayers(): MapLayers {
    return this.ctx.isMobile ? MOBILE_DEFAULT_MAP_LAYERS : DEFAULT_MAP_LAYERS;
  }

  private filterMissionLayersForCurrentRenderer(layers: MapLayers): MapLayers {
    const renderer = this.ctx.map?.isGlobeMode?.() ? 'globe' : 'flat';
    const isDeckGLActive = this.ctx.map?.isDeckGLActive?.() ?? !this.ctx.isMobile;
    return this.filterMissionLayersForAvailableServices(
      filterMissionLayersForRenderer(layers, renderer, isDeckGLActive, this.getMissionDefaultLayers()),
    );
  }

  private filterMissionLayersForAvailableServices(layers: MapLayers): MapLayers {
    if (layers.ais && !isAisConfigured()) {
      return { ...layers, ais: false };
    }
    return layers;
  }

  private persistMissionPanelOrder(panelOrder: string[]): void {
    saveToStorage(this.ctx.PANEL_ORDER_KEY, panelOrder);
    saveToStorage(this.ctx.PANEL_ORDER_KEY + '-bottom-set', []);
    try {
      localStorage.removeItem(this.ctx.PANEL_ORDER_KEY + '-bottom');
    } catch {
      // Storage can be unavailable; the current session still applies the in-memory order.
    }
  }

  private scheduleMissionDataRefresh(): void {
    if (this.missionDataRefreshTimer) {
      window.clearTimeout(this.missionDataRefreshTimer);
    }
    this.missionDataRefreshTimer = window.setTimeout(() => {
      this.missionDataRefreshTimer = null;
      void this.callbacks.loadAllData();
    }, 150);
  }

  private runMapLayerSideEffects(layer: keyof MapLayers, enabled: boolean): void {
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
  }

  private applyMissionMapLayerTransitions(previousLayers: MapLayers, nextLayers: MapLayers): void {
    const layerKeys = new Set([
      ...Object.keys(previousLayers),
      ...Object.keys(nextLayers),
    ] as Array<keyof MapLayers>);

    for (const layer of layerKeys) {
      const enabled = !!nextLayers[layer];
      if (!!previousLayers[layer] === enabled) continue;
      trackMapLayerToggle(layer, enabled, 'programmatic');
      this.runMapLayerSideEffects(layer, enabled);
    }
  }

  private applyMissionPreset(presetId: MissionPresetId): void {
    const applied = applyMissionPresetToState(
      presetId,
      this.ctx.panelSettings,
      this.getMissionDefaultLayers(),
      SITE_VARIANT,
    );
    const mapLayers = this.filterMissionLayersForCurrentRenderer(applied.mapLayers);
    const previousMapLayers = { ...this.ctx.mapLayers };

    this.ctx.panelSettings = applied.panelSettings;
    this.ctx.mapLayers = mapLayers;
    saveToStorage(STORAGE_KEYS.panels, applied.panelSettings);
    saveToStorage(STORAGE_KEYS.mapLayers, mapLayers);
    this.persistMissionPanelOrder(applied.panelOrder);
    saveMissionPreset(applied.preset.id);

    this.applyPanelSettings();
    this.callbacks.applySavedPanelOrder?.(applied.panelOrder);
    this.ctx.unifiedSettings?.refreshPanelToggles();
    this.ctx.map?.setLayers(mapLayers);
    this.applyMissionMapLayerTransitions(previousMapLayers, mapLayers);
    this.ctx.map?.setView(applied.preset.view as MapView, applied.preset.zoom);
    this.ctx.map?.setTimeRange(applied.preset.timeRange);
    this.callbacks.mountLiveNewsIfReady?.();
    this.callbacks.syncDataFreshnessWithLayers();
    this.scheduleMissionDataRefresh();
    this.syncUrlState();
    showToast(`Mission preset applied: ${applied.preset.label}`);
    this.renderMissionPresetControl();
    this.closeMissionPresetPopover();
  }

  private resetMissionPreset(): void {
    const reset = resetMissionPresetState(
      this.ctx.panelSettings,
      this.getMissionDefaultLayers(),
      SITE_VARIANT,
    );
    const mapLayers = this.filterMissionLayersForCurrentRenderer(reset.mapLayers);
    const previousMapLayers = { ...this.ctx.mapLayers };

    this.ctx.panelSettings = reset.panelSettings;
    this.ctx.mapLayers = mapLayers;
    saveToStorage(STORAGE_KEYS.panels, reset.panelSettings);
    saveToStorage(STORAGE_KEYS.mapLayers, mapLayers);
    this.persistMissionPanelOrder(reset.panelOrder);
    clearMissionPreset();

    this.applyPanelSettings();
    this.callbacks.applySavedPanelOrder?.(reset.panelOrder);
    this.ctx.unifiedSettings?.refreshPanelToggles();
    this.ctx.map?.setLayers(mapLayers);
    this.applyMissionMapLayerTransitions(previousMapLayers, mapLayers);
    this.ctx.map?.setView('global');
    this.ctx.map?.setTimeRange('7d');
    this.callbacks.mountLiveNewsIfReady?.();
    this.callbacks.syncDataFreshnessWithLayers();
    this.scheduleMissionDataRefresh();
    this.syncUrlState();
    showToast('Mission preset reset');
    this.renderMissionPresetControl();
    this.closeMissionPresetPopover();
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

    // Skip the immediate sync only when applyInitialUrlState() will start an
    // async flyTo that makes getCenter() return stale intermediate coordinates.
    // Two cases qualify:
    //   (a) lat+lon pair  → setCenter() flyTo; both must be present since
    //       applyInitialUrlState only calls setCenter when both exist.
    //   (b) bare zoom     → setZoom() animated zoom (no view preset).
    //
    // view is intentionally excluded: all renderers set this.state.view
    // synchronously at the top of setView(), so the debounced read is always
    // correct regardless of renderer. GlobeMap.onStateChanged is a no-op and
    // SVG Map fires emitStateChange before the listener is installed — neither
    // can rely on a later onStateChanged to drive the URL write, so they must
    // use the immediate debounce path.
    const { view, lat, lon, zoom, chokepoint } = this.ctx.initialUrlState ?? {};
    const urlHasAsyncFlyTo =
      (lat !== undefined && lon !== undefined) ||   // setCenter → flyTo (requires both)
      (!view && zoom !== undefined) ||              // zoom-only → setZoom animated
      chokepoint !== undefined;                     // chokepoint opens after renderer readiness
    if (!urlHasAsyncFlyTo) {
      this.debouncedUrlSync();
    }
  }

  syncUrlState(): void {
    this.debouncedUrlSync();
  }

  applyMapLayerChange(layer: keyof MapLayers, enabled: boolean, source: 'user' | 'programmatic'): void {
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
      this.callbacks.stopLayerActivity?.(layer);
    }
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
      chokepoint: !isCountryVisible ? (this.ctx.activeChokepoint ?? undefined) : undefined,
    });
  }

  private getEmbedUrl(): string | null {
    if (!this.ctx.map) return null;
    const state = this.ctx.map.getState();
    return buildEmbedMapUrl(`${window.location.origin}/embed`, {
      layers: state.layers,
      center: this.ctx.map.getCenter(),
      zoom: state.zoom,
      theme: getCurrentTheme(),
      variant: SITE_VARIANT as EmbedVariant,
    });
  }

  private openEmbedDialog(): void {
    const embedUrl = this.getEmbedUrl();
    if (!embedUrl) return;
    const snippet = buildEmbedIframeSnippet(embedUrl);
    this.closeEmbedDialog();

    const overlay = document.createElement('div');
    overlay.className = 'embed-modal-overlay active';
    overlay.id = 'embedModalOverlay';
    overlay.setAttribute('role', 'presentation');

    const dialog = document.createElement('div');
    dialog.className = 'embed-modal';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'embedModalTitle');

    const header = document.createElement('div');
    header.className = 'embed-modal-header';
    const title = document.createElement('h2');
    title.id = 'embedModalTitle';
    title.textContent = 'Embed this map';
    const closeButton = document.createElement('button');
    closeButton.className = 'embed-modal-close';
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Close embed dialog');
    closeButton.textContent = 'x';
    header.append(title, closeButton);

    const preview = document.createElement('iframe');
    preview.className = 'embed-preview-frame';
    preview.title = 'World Monitor live map preview';
    preview.loading = 'lazy';
    preview.referrerPolicy = 'strict-origin-when-cross-origin';
    preview.src = embedUrl;

    const label = document.createElement('label');
    label.className = 'embed-snippet-label';
    label.htmlFor = 'embedSnippetTextarea';
    label.textContent = 'Iframe snippet';

    const textarea = document.createElement('textarea');
    textarea.className = 'embed-snippet-textarea';
    textarea.id = 'embedSnippetTextarea';
    textarea.readOnly = true;
    textarea.value = snippet;

    const actions = document.createElement('div');
    actions.className = 'embed-modal-actions';
    const copyButton = document.createElement('button');
    copyButton.className = 'embed-copy-btn';
    copyButton.type = 'button';
    copyButton.textContent = 'Copy snippet';
    actions.append(copyButton);

    dialog.append(header, preview, label, textarea, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    closeButton.addEventListener('click', () => this.closeEmbedDialog());
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) this.closeEmbedDialog();
    });
    copyButton.addEventListener('click', async () => {
      try {
        await this.copyToClipboard(snippet);
        copyButton.textContent = 'Copied!';
      } catch (error) {
        console.warn('Failed to copy embed snippet:', error);
        copyButton.textContent = 'Copy failed';
      }
    });
    this.boundEmbedModalKeydownHandler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') this.closeEmbedDialog();
    };
    document.addEventListener('keydown', this.boundEmbedModalKeydownHandler);
    textarea.focus();
    textarea.select();
  }

  private closeEmbedDialog(): void {
    document.getElementById('embedModalOverlay')?.remove();
    if (this.boundEmbedModalKeydownHandler) {
      document.removeEventListener('keydown', this.boundEmbedModalKeydownHandler);
      this.boundEmbedModalKeydownHandler = null;
    }
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

      setTrustedHtml(dropdown, trustedHtml(`
        <div class="dl-dd-tagline">${t('modals.downloadBanner.description')}</div>
        <div class="dl-dd-buttons">${primaryHtml}</div>
        ${others.length ? `<button class="dl-dd-toggle" id="dlDdToggle">${t('modals.downloadBanner.showAllPlatforms')}</button>
        <div class="dl-dd-others" id="dlDdOthers">${othersHtml}</div>` : ''}
      `, "legacy direct innerHTML migration"));

      dropdown.querySelectorAll<HTMLAnchorElement>('.dl-dd-btn').forEach(a => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const plat = new URL(a.href, location.origin).searchParams.get('platform') || 'unknown';
          trackDownloadClicked(plat);
          window.open(a.href, '_blank', 'noopener,noreferrer');
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
      window.open(btn.href, '_blank', 'noopener,noreferrer');
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
      writeStorageValue('worldmonitor-variant', variant);
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
    void import('@/components/StatusPanel')
      .then(({ StatusPanel }) => {
        if (this.ctx.isDestroyed) return;
        this.ctx.statusPanel = new StatusPanel();
      })
      .catch((err) => {
        console.error('[status-panel] failed to lazy-load StatusPanel', err);
      });
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
    const getExportData = () => {
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
    };

    const attachExportPanel = (panel: NonNullable<AppContext['exportPanel']>): void => {
      const el = panel.getElement();
      if (el.parentElement) return;
      const headerRight = this.ctx.container.querySelector('.header-right');
      if (headerRight) {
        headerRight.insertBefore(el, headerRight.firstChild);
      }
    };

    const ensureExportPanel = (): Promise<NonNullable<AppContext['exportPanel']>> => {
      if (this.ctx.exportPanel) {
        attachExportPanel(this.ctx.exportPanel);
        return Promise.resolve(this.ctx.exportPanel);
      }
      if (this.exportPanelLoad) return this.exportPanelLoad;

      this.exportPanelLoad = import('@/utils/export')
        .then(({ ExportPanel }) => {
          if (this.ctx.isDestroyed) {
            throw new Error('EventHandlerManager destroyed before export panel loaded');
          }
          const panel = new ExportPanel(getExportData);
          this.ctx.exportPanel = panel;
          attachExportPanel(panel);
          return panel;
        })
        .catch((err) => {
          this.exportPanelLoad = null;
          throw err;
        });

      return this.exportPanelLoad;
    };

    let currentIsPro = getAuthState().user?.role === 'pro';
    const applyProGate = (isPro: boolean, initial = false) => {
      currentIsPro = isPro;
      if (!isPro) {
        const el = this.ctx.exportPanel?.getElement();
        if (el) el.style.display = 'none';
        if (initial) trackGateHit('export');
        return;
      }

      void ensureExportPanel()
        .then((panel) => {
          panel.getElement().style.display = currentIsPro ? '' : 'none';
        })
        .catch((err) => {
          console.warn('[export-panel] Failed to lazy-load ExportPanel:', err);
        });
    };
    applyProGate(currentIsPro, true);
    this.proGateUnsubscribers.push(subscribeAuthState(state => applyProGate(state.user?.role === 'pro')));
  }

  setupUnifiedSettings(): void {
    this.ctx.unifiedSettings = new LazyUnifiedSettings({
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
        clearPanelSpans();
        clearPanelColSpans();
        removeStorageValue(this.ctx.PANEL_ORDER_KEY);
        removeStorageValue(this.ctx.PANEL_ORDER_KEY + '-bottom');
        removeStorageValue(this.ctx.PANEL_ORDER_KEY + '-bottom-set');
        removeStorageValue('map-height');
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

    // U8 (degraded path) — listen for the deep-dive "Notify me about this
    // country" sub-action and open the notifications tab. Today the
    // event detail.country is informational only; when the alertRules
    // schema PR lands, the future PR will read it here and forward to
    // a pre-filled create-form open. See plan U8 R9 + the TODO inside
    // src/utils/notify-country-link.ts.
    //
    // Stored on a bound handler field so `destroy()` can remove it.
    // Same-document reinit (HMR, test harnesses, multiple App instances)
    // would otherwise accumulate anonymous listeners that retain the
    // stale AppContext closure — every click would fire all of them.
    this.boundNotifyForCountryHandler = (_e: Event) => {
      this.ctx.unifiedSettings?.open('notifications');
    };
    window.addEventListener(
      WM_OPEN_NOTIFICATIONS_FOR_COUNTRY,
      this.boundNotifyForCountryHandler,
    );
  }

  setupAuthWidget(): void {
    const modal = new AuthLauncher();
    this.ctx.authModal = modal;

    // The settings gear is rendered once by the standalone unifiedSettings
    // button (#unifiedSettingsMount), which is mounted regardless of auth state
    // (so signed-out users keep it too). Passing onSettingsClick here makes
    // AuthHeaderWidget render a second gear next to the avatar for signed-in
    // users — a duplicate. Leave it unset.
    const widget = new AuthHeaderWidget(() => modal.open());
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
      this.applyMapLayerChange(layer, enabled, source);
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

    const savedHeight = readStorageValue('map-height');
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
          writeStorageValue('map-height', `${clamped}px`);
        }
      } else {
        removeStorageValue('map-height');
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
      writeStorageValue('map-height', getTarget().style.height);
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
        writeStorageValue('map-height', `${finalHeight}px`);
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

    const saved = readStorageValue('map-col-width');
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
      if (current) writeStorageValue('map-col-width', current);
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

    const isPinned = readStorageValue('map-pinned') === 'true';
    if (isPinned) {
      mapSection.classList.add('pinned');
      pinBtn.classList.add('active');
    }

    pinBtn.addEventListener('click', () => {
      const nowPinned = mapSection.classList.toggle('pinned');
      pinBtn.classList.toggle('active', nowPinned);
      writeStorageValue('map-pinned', String(nowPinned));
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
        if (this.ctx.mapLayers.resilienceScore && !this.ctx.map?.isDeckGLActive?.()) {
          this.ctx.mapLayers = { ...this.ctx.mapLayers, resilienceScore: false };
          saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
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
      setTrustedHtml(btn, trustedHtml(isFullscreen ? shrinkSvg : expandSvg, "legacy direct innerHTML migration"));
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
    // Preset feeds + sources from any custom news panels the user added, so
    // the source manager stays in sync with what loadNews() actually fetches.
    const categories = resolveNewsCategories(FEEDS, CANONICAL_FEEDS, enabledNewsCategoryKeys(this.ctx.newsPanels, this.ctx.panels, this.ctx.panelSettings, Object.keys(CANONICAL_FEEDS)));
    categories.forEach(({ feeds }) => feeds.forEach(f => sources.add(f.name)));
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
      const liveMediaPanel = panel as { stopLiveMediaForClose?: () => void; resumeLiveMediaForShow?: () => void } | undefined;
      if (!config.enabled) {
        liveMediaPanel?.stopLiveMediaForClose?.();
      }
      panel?.toggle(config.enabled);
      if (config.enabled) {
        liveMediaPanel?.resumeLiveMediaForShow?.();
      }
    });
  }
}
