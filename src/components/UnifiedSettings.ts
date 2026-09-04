import { CANONICAL_FEEDS, INTEL_SOURCES, SOURCE_REGION_MAP } from '@/config/feeds';
import { WEB_APP_ORIGIN } from '@/config/web-origin';
import { openExternalUrl } from '@/services/external-navigation';
import { THEATER_PRESETS, getTheaterPreset, getTheaterPresetEnableList, resolveTheaterPresetSources, type TheaterPreset } from '@/config/theater-presets';
import {
  PANEL_CATEGORY_MAP,
  ALL_PANELS,
  getEffectivePanelConfig,
  getVariantPanelCategories,
  isPanelEntitled,
  FREE_MAX_PANELS,
  countFreePanelCapUsage,
  isFreePanelCapCounted,
  isPanelInVariantDefaults,
} from '@/config/panels';
import { isProUser } from '@/services/widget-store';
import { SITE_VARIANT } from '@/config/variant';
import { t } from '@/services/i18n';
import { createSettingsButton } from '@/components/settings-button';
import { confirmDialog } from '@/components/confirm-dialog';
import type { UnifiedSettingsTabId } from '@/components/settings-types';
import {
  getPanelToggleA11yState,
  getSettingsTabNavigationIndex,
  normalizeSettingsTab,
  restoreSettingsToggleFocus,
  updateSettingsTabSelection,
} from '@/components/unified-settings-interactions';
import type { MapProvider } from '@/config/basemap';
import { escapeHtml } from '@/utils/sanitize';
import type { PanelConfig } from '@/types';
import { renderPreferences } from '@/services/preferences-content';
import { renderNotificationsSettings, type NotificationsSettingsResult } from '@/services/notifications-settings';
import { getAuthState, subscribeAuthState } from '@/services/auth-state';
import { track, trackApiAction } from '@/services/analytics';
import {
  getEntitlementState,
  getEntitlementVerificationStatus,
  hasFeature,
  isEntitled,
  onEntitlementChange,
  onEntitlementVerificationChange,
} from '@/services/entitlements';
import { hasPremiumAccess } from '@/services/panel-gating';
import { getSubscription, isSubscriptionLoaded, onSubscriptionChange, openBillingPortal, prereserveBillingPortalTab } from '@/services/billing';
import { BusinessSeatsSection } from '@/components/BusinessSeatsSection';
import {
  deriveBillingUxState,
  getReactivationHref,
  getSubscriptionStatusTone,
  type BillingStatusTone,
} from '@/services/billing-state';
import { createApiKey, listApiKeys, revokeApiKey, type ApiKeyInfo } from '@/services/api-keys';
import { listMcpClients, revokeMcpClient, fetchMcpQuota, type McpClientInfo, type McpQuota } from '@/services/mcp-clients';
import {
  acknowledgePlanLimitNotice,
  listCurrentPlanLimitNotices,
  type ApiPlanLimitNotice,
} from '@/services/api-plan-limit-notices';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { checkoutConsentHtml, legalLinksHtml, LEGAL_LINK_ATTR } from '@/utils/legal-links';
import { createFocusTrap, type FocusTrap } from '@/utils/focus-trap';
import {
  overlayHistory,
  type OverlayCloseOrigin,
  type OverlayId,
} from '@/utils/overlay-history';
import { isMobileDevice } from '@/utils';
import {
  FONT_SCALE_STEPS,
  fontScaleLabel,
  parseFontScale,
} from '@/services/font-scale-settings';
import { showToast } from '@/utils/toast';

export interface UnifiedSettingsConfig {
  getPanelSettings: () => Record<string, PanelConfig>;
  savePanelSettings: (panels: Record<string, PanelConfig>) => void;
  getDisabledSources: () => Set<string>;
  toggleSource: (name: string) => void;
  setSourcesEnabled: (names: string[], enabled: boolean) => void;
  getAllSourceNames: () => string[];
  getLocalizedPanelName: (key: string, fallback: string) => string;
  resetLayout: () => void;
  isDesktopApp: boolean;
  onMapProviderChange?: (provider: MapProvider) => void;
  /**
   * The user finished editing Settings → SOURCES and the enabled set is not
   * what it was when the overlay opened.
   *
   * Sources apply to `ctx.disabledSources` on click (no draft/Save step like
   * panels), but nothing subscribed to that write, so the change only reached
   * the dashboard at the next `REFRESH_INTERVALS.feeds` tick — 20 minutes
   * (#6380). This is the subscription.
   *
   * Fired on teardown rather than per click on purpose: the overlay covers the
   * dashboard, so nothing is observable until it closes, and a per-click
   * refetch would be a request storm while the user works through the grid
   * (the budget guarded by e2e/dashboard-news-request-budget.spec.ts). Once per
   * settings session, and only when the selection genuinely moved.
   */
  onSourcesChanged?: () => void;
}

type TabId = UnifiedSettingsTabId;
type AccountRequest = { userId: string; generation: number };

/**
 * Plan-card palette per billing status tone (#7315).
 *
 * The tone comes from the shared coverage predicate in billing-state.ts, never
 * from a status string compared here — a cancelled plan still inside its paid
 * window is a paying customer and must not be painted like a dead account.
 *
 * `unknown` (a provider status this client does not model) is deliberately the
 * neutral grey, not red: we are inside the isEntitled() branch, so claiming a
 * problem we have not established would repeat the bug in a new colour.
 *
 * Colours live on `--billing-tone-*` in main.css so [data-theme="light"] can
 * raise every tone to WCAG AA for the 13px-bold plan name. The card only
 * stamps `data-billing-tone`; it must not inline hex, or those overrides
 * never apply. The status sentence stays on theme-aware var(--text-dim).
 */

export class UnifiedSettings {
  private overlay: HTMLElement;
  private focusTrap: FocusTrap;
  private config: UnifiedSettingsConfig;
  private activeTab: TabId = 'settings';
  private legalLinkHandoffAttached = false;
  private activeSourceRegion = 'all';
  private sourceFilter = '';
  private activePanelCategory = 'all';
  private panelFilter = '';
  private escapeHandler: (e: KeyboardEvent) => void;
  private prefsCleanup: (() => void) | null = null;
  private notifCleanup: (() => void) | null = null;
  private pendingNotifs: NotificationsSettingsResult | null = null;
  private draftPanelSettings: Record<string, PanelConfig> = {};
  private panelsJustSaved = false;
  private savedTimeout: ReturnType<typeof setTimeout> | null = null;
  private confirmingClose = false;
  private historyRegistered = false;
  /**
   * `sourceSelectionSignature()` as of the last open(), or null while closed.
   *
   * A signature rather than a "something was toggled" flag: a source click can
   * legitimately fail to mutate anything (the free-tier cap toasts and returns
   * without touching the set), and toggling a source off and back on again is a
   * net no-op the dashboard must not be asked to reload for.
   */
  private sourceSelectionBaseline: string | null = null;
  private apiKeys: ApiKeyInfo[] = [];
  private apiKeysLoading = false;
  private apiKeysError = '';
  private newlyCreatedKey: string | null = null;
  private planLimitNotices: ApiPlanLimitNotice[] = [];
  private planLimitNoticesLoading = false;
  private planLimitNoticesError = '';
  // ---- Business Pro seats (plan 2026-07-24-001 U7) ----
  private readonly businessSeatsSection: BusinessSeatsSection;
  // ---- Connected MCP clients tab (plan 2026-05-10-001 U9) ----
  private mcpClients: McpClientInfo[] = [];
  private mcpClientsLoading = false;
  private mcpClientsError = '';
  private mcpQuota: McpQuota | null = null;
  /** setInterval handle for quota auto-refresh; cleared on close()/destroy()/tab-switch. */
  private mcpQuotaTimer: ReturnType<typeof setInterval> | null = null;
  private accountUserId: string | null = getAuthState().user?.id ?? null;
  private accountDataGeneration = 0;
  private accountEntitlementRefreshPending = false;
  private unsubscribeAuth: (() => void) | null = null;
  private unsubscribeEntitlement: (() => void) | null = null;
  private unsubscribeEntitlementVerification: (() => void) | null = null;
  private unsubscribeSubscription: (() => void) | null = null;

  constructor(config: UnifiedSettingsConfig) {
    this.config = config;

    this.overlay = document.createElement('div');
    this.overlay.className = 'modal-overlay';
    this.overlay.id = 'unifiedSettingsModal';
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.setAttribute('aria-label', t('header.settings'));
    this.focusTrap = createFocusTrap(this.overlay);
    this.businessSeatsSection = new BusinessSeatsSection(this.overlay);

    this.resetPanelDraft();

    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.close();
    };

    this.overlay.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      if (target === this.overlay) {
        this.close();
        return;
      }

      if (target.closest('.unified-settings-close')) {
        this.close();
        return;
      }

      if (target.closest('.upgrade-pro-cta')) {
        this.handleUpgradeClick();
        return;
      }

      if (target.closest('.retry-plan-status-btn')) {
        window.location.reload();
        return;
      }

      if (target.closest('.upgrade-to-business-btn')) {
        // Self-serve Starter→Business upgrade (#4634): open the Dodo customer
        // portal, which surfaces the prorated plan change via the product
        // collection ("Allow Subscription Updates" enabled). Same hosted open
        // path as Manage Billing — Dodo owns payment + 3DS + proration; a failed
        // charge (prevent_change) leaves the customer on Starter.
        const reservedWin = prereserveBillingPortalTab();
        void openBillingPortal(reservedWin).then((result) => {
          // The portal session exists but no window opened (native handoff
          // refused and the browser fallback was blocked). Saying nothing here
          // reads as a dead click on a paid feature.
          if (result.outcome === 'open-failed') {
            showToast('Could not open the billing portal. Please allow pop-ups and try again.');
            return;
          }
          if (result.outcome === 'no-customer') {
            showToast(
              'Subscription is managed outside Dodo. Email support@worldmonitor.app for help.',
            );
          }
        });
        return;
      }

      if (target.closest('.manage-billing-btn')) {
        // Pre-reserve the portal tab synchronously inside the click
        // handler so the popup blocker doesn't suppress the eventual
        // window.open inside openBillingPortal (which runs after an
        // await of the Convex action).
        const reservedWin = prereserveBillingPortalTab();
        void openBillingPortal(reservedWin).then((result) => {
          // NO_CUSTOMER: user is entitled but has no Dodo customer row
          // (comp grant, restore race, or post-purge cancellation). Send
          // them somewhere actionable instead of leaving them in a
          // generic Dodo portal that won't recognise them.
          // The portal session exists but no window opened (native handoff
          // refused and the browser fallback was blocked). Saying nothing here
          // reads as a dead click on a paid feature.
          if (result.outcome === 'open-failed') {
            showToast('Could not open the billing portal. Please allow pop-ups and try again.');
            return;
          }
          if (result.outcome === 'no-customer') {
            showToast(
              'Subscription is managed outside Dodo. Email support@worldmonitor.app for help.',
            );
          }
        });
        return;
      }

      const planNoticeAck = target.closest<HTMLElement>('[data-plan-limit-ack]');
      if (planNoticeAck?.dataset.planLimitAck) {
        void this.handleAcknowledgePlanLimitNotice(planNoticeAck.dataset.planLimitAck);
        return;
      }

      const planNoticeCta = target.closest<HTMLElement>('[data-plan-limit-cta]');
      if (planNoticeCta?.dataset.planLimitCta) {
        this.handlePlanLimitNoticeCta(planNoticeCta.dataset.planLimitCta);
        return;
      }

      const tab = target.closest<HTMLElement>('.unified-settings-tab');
      if (tab?.dataset.tab) {
        this.switchTab(tab.dataset.tab as TabId);
        return;
      }

      const panelCatPill = target.closest<HTMLElement>('[data-panel-cat]');
      if (panelCatPill?.dataset.panelCat) {
        this.activePanelCategory = panelCatPill.dataset.panelCat;
        this.panelFilter = '';
        const searchInput = this.overlay.querySelector<HTMLInputElement>('.panels-search input');
        if (searchInput) searchInput.value = '';
        this.renderPanelCategoryPills();
        this.renderPanelsTab();
        return;
      }

      if (target.closest('.panels-reset-layout')) {
        this.config.resetLayout();
        return;
      }

      if (target.closest('.panels-save-layout')) {
        this.savePanelChanges();
        return;
      }

      const panelItem = target.closest<HTMLElement>('.panel-toggle-item');
      if (panelItem?.dataset.panel) {
        if (panelItem.dataset.proLocked) {
          // Absolute + routed: a relative /pro resolves against tauri://localhost
          // in the desktop WebView, where no such route is served (#5911).
          void openExternalUrl(`${WEB_APP_ORIGIN}/pro`);
          return;
        }
        const panelKey = panelItem.dataset.panel;
        const shouldRestoreFocus = document.activeElement === panelItem;
        this.toggleDraftPanel(panelKey);
        restoreSettingsToggleFocus(
          shouldRestoreFocus,
          this.overlay.querySelectorAll<HTMLElement>('.panel-toggle-item'),
          'panel',
          panelKey,
        );
        return;
      }

      const sourceItem = target.closest<HTMLElement>('.source-toggle-item');
      if (sourceItem?.dataset.source) {
        const sourceName = sourceItem.dataset.source;
        const shouldRestoreFocus = document.activeElement === sourceItem;
        this.config.toggleSource(sourceName);
        this.renderSourcesGrid();
        this.updateSourcesCounter();
        restoreSettingsToggleFocus(
          shouldRestoreFocus,
          this.overlay.querySelectorAll<HTMLElement>('.source-toggle-item'),
          'source',
          sourceName,
        );
        return;
      }

      const pill = target.closest<HTMLElement>('.unified-settings-region-pill');
      if (pill?.dataset.region) {
        this.activeSourceRegion = pill.dataset.region;
        this.sourceFilter = '';
        const searchInput = this.overlay.querySelector<HTMLInputElement>('.sources-search input');
        if (searchInput) searchInput.value = '';
        this.renderRegionPills();
        this.renderSourcesGrid();
        this.updateSourcesCounter();
        return;
      }

      if (target.closest('.sources-select-all')) {
        const visible = this.getVisibleSourceNames();
        this.config.setSourcesEnabled(visible, true);
        this.renderSourcesGrid();
        this.updateSourcesCounter();
        return;
      }

      const presetChip = target.closest<HTMLElement>('.unified-settings-preset-chip');
      if (presetChip?.dataset.presetId) {
        this.applyCoveragePreset(presetChip.dataset.presetId);
        return;
      }

      if (target.closest('.sources-select-none')) {
        const visible = this.getVisibleSourceNames();
        this.config.setSourcesEnabled(visible, false);
        this.renderSourcesGrid();
        this.updateSourcesCounter();
        return;
      }

      if (target.closest('.api-keys-create-btn')) {
        void this.handleCreateApiKey();
        return;
      }

      const revokeBtn = target.closest<HTMLElement>('.api-keys-revoke-btn');
      if (revokeBtn?.dataset.keyId) {
        void this.handleRevokeApiKey(revokeBtn.dataset.keyId);
        return;
      }

      if (target.closest('.api-keys-copy-btn')) {
        const key = this.newlyCreatedKey;
        if (key) {
          void navigator.clipboard.writeText(key).then(() => {
            const btn = this.overlay.querySelector<HTMLElement>('.api-keys-copy-btn');
            if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); }
          });
        }
        return;
      }

      const mcpRevokeBtn = target.closest<HTMLElement>('.mcp-clients-revoke-btn');
      if (mcpRevokeBtn?.dataset.tokenId) {
        void this.handleRevokeMcpClient(mcpRevokeBtn.dataset.tokenId);
        return;
      }

      const businessInviteBtn = target.closest<HTMLElement>('.business-seats-invite-btn');
      if (businessInviteBtn) {
        void this.businessSeatsSection.handleInvite();
        return;
      }

      const businessRemoveBtn = target.closest<HTMLElement>('.business-seat-remove-btn');
      if (businessRemoveBtn?.dataset.grantId) {
        void this.businessSeatsSection.handleRemove(businessRemoveBtn.dataset.grantId);
        return;
      }

      const mcpCopyUrlBtn = target.closest<HTMLElement>('.mcp-clients-copy-url-btn');
      if (mcpCopyUrlBtn?.dataset.copyValue) {
        const value = mcpCopyUrlBtn.dataset.copyValue;
        // navigator.clipboard is async + can reject (insecure context, perms);
        // fall back gracefully so the button never silently no-ops.
        const showCopied = () => {
          mcpCopyUrlBtn.textContent = 'Copied!';
          setTimeout(() => { mcpCopyUrlBtn.textContent = 'Copy URL'; }, 1500);
        };
        if (navigator.clipboard?.writeText) {
          void navigator.clipboard.writeText(value).then(showCopied).catch(() => {
            mcpCopyUrlBtn.textContent = 'Copy failed';
            setTimeout(() => { mcpCopyUrlBtn.textContent = 'Copy URL'; }, 1500);
          });
        } else {
          mcpCopyUrlBtn.textContent = 'Copy unavailable';
          setTimeout(() => { mcpCopyUrlBtn.textContent = 'Copy URL'; }, 1500);
        }
        return;
      }
    });

    this.overlay.addEventListener('change', (e) => {
      const select = (e.target as HTMLElement).closest<HTMLSelectElement>('[data-panel-font-scale]');
      const panelKey = select?.dataset.panelFontScale;
      if (!select || !panelKey) return;
      const panel = this.draftPanelSettings[panelKey];
      if (!panel) return;

      if (select.value === 'global') {
        delete panel.fontScale;
      } else {
        const scale = parseFontScale(select.value);
        if (scale === undefined) {
          select.value = panel.fontScale === undefined ? 'global' : String(panel.fontScale);
          return;
        }
        panel.fontScale = scale;
      }

      this.panelsJustSaved = false;
      select.closest('.panel-settings-item')
        ?.querySelector('.panel-toggle-item')
        ?.classList.toggle(
          'changed',
          this.isPanelDraftChanged(panelKey, panel, this.config.getPanelSettings()),
        );
      this.updatePanelsFooter();
    });

    this.overlay.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement;
      if (target.closest('.panels-search')) {
        this.panelFilter = target.value;
        this.renderPanelsTab();
      } else if (target.closest('.sources-search')) {
        this.sourceFilter = target.value;
        this.renderSourcesGrid();
        this.updateSourcesCounter();
      }
    });

    this.render();
    document.body.appendChild(this.overlay);
    this.unsubscribeAuth = subscribeAuthState((state) => {
      this.handleAccountIdentityChange(state.user?.id ?? null);
    });
  }

  private handleAccountIdentityChange(nextUserId: string | null): void {
    if (nextUserId === this.accountUserId) return;

    this.accountUserId = nextUserId;
    this.accountDataGeneration += 1;
    this.accountEntitlementRefreshPending = true;
    this.apiKeys = [];
    this.apiKeysLoading = false;
    this.apiKeysError = '';
    this.newlyCreatedKey = null;
    this.planLimitNotices = [];
    this.planLimitNoticesLoading = false;
    this.planLimitNoticesError = '';
    this.mcpClients = [];
    this.mcpClientsLoading = false;
    this.mcpClientsError = '';
    this.mcpQuota = null;
    this.stopMcpQuotaPolling();
    this.businessSeatsSection.resetForAccountChange();

    // Replace any rendered A-owned plaintext/list data synchronously. Account
    // loaders stay suppressed until the new entitlement snapshot rerenders.
    if (this.overlay.classList.contains('active')) {
      this.render(false);
    }
  }

  private captureAccountRequest(): AccountRequest | null {
    const userId = getAuthState().user?.id ?? null;
    if (!userId || userId !== this.accountUserId) return null;
    return { userId, generation: this.accountDataGeneration };
  }

  private isAccountRequestCurrent(request: AccountRequest): boolean {
    return request.generation === this.accountDataGeneration
      && request.userId === this.accountUserId
      && request.userId === getAuthState().user?.id;
  }

  public open(tab?: TabId, replaceOverlayId?: OverlayId): void {
    const requestedTab = tab ?? this.activeTab;
    this.activeTab = requestedTab === 'mcp-clients' && !hasFeature('mcpAccess')
      ? 'settings'
      : requestedTab;
    this.resetPanelDraft();
    // Only on a FRESH session. open() is re-entrant on an overlay that is
    // already up (the deep-dive "Notify me about this country" jump to the
    // notifications tab, an overlayHistory replace), and re-snapshotting there
    // would adopt a source change already made in this session as the baseline
    // — silently discarding the very reload this exists to trigger.
    if (this.sourceSelectionBaseline === null) {
      this.sourceSelectionBaseline = this.sourceSelectionSignature();
    }
    this.render();
    this.overlay.classList.add('active');
    this.focusTrap.activate();
    if (isMobileDevice()) {
      this.historyRegistered = true;
      const close = (origin: OverlayCloseOrigin) => this.close(origin);
      if (replaceOverlayId) overlayHistory.replace(replaceOverlayId, 'settings', close);
      else overlayHistory.open('settings', close);
    }
    localStorage.setItem('wm-settings-open', '1');
    document.addEventListener('keydown', this.escapeHandler);
    (this.overlay.querySelector('.unified-settings-tabs') as HTMLElement)?.addEventListener('keydown', (e: KeyboardEvent) => this.handleKeyDown(e));
    track('settings-open', { tab: tab ?? 'default' });

    // Re-render API Keys panel when entitlements arrive (cold-load race:
    // hasFeature('apiAccess') returns false until the Convex subscription
    // delivers data, so a paid API Starter user sees the upgrade CTA briefly).
    this.unsubscribeEntitlement?.();
    this.unsubscribeEntitlement = onEntitlementChange((state) => {
      if (this.accountEntitlementRefreshPending) {
        // Entitlements are account-scoped. Rebuild every account surface so a
        // direct A→B handoff removes/adds MCP and API tabs using B's snapshot.
        // Keep the marker through the reset(null) emission; the first real B
        // snapshot must rebuild once more before ordinary targeted refreshes.
        if (state !== null) this.accountEntitlementRefreshPending = false;
        this.render();
        return;
      }

      const hasMcpClientsTab = this.overlay.querySelector('[data-tab="mcp-clients"]') !== null;
      if (hasMcpClientsTab !== hasFeature('mcpAccess')) {
        // Entitlements can legitimately progress from a free/default snapshot
        // to Pro after the account handoff's first non-null emission. Rebuild
        // the tab shape whenever MCP capability changes in either direction.
        this.render();
        return;
      }

      const panel = this.overlay.querySelector<HTMLElement>('[data-panel-id="api-keys"]');
      if (panel) {
        setTrustedHtml(panel, trustedHtml(this.renderApiKeysContent(), "legacy direct innerHTML migration"));
        this.attachApiKeysHandlers();
        if (this.activeTab === 'api-keys' && getAuthState().user && hasFeature('apiAccess')) {
          void this.loadApiKeys();
        }
      }
      this.replaceUpgradeSection();
    });
    this.unsubscribeEntitlementVerification?.();
    this.unsubscribeEntitlementVerification = onEntitlementVerificationChange(() => {
      this.replaceUpgradeSection();
    });
    this.unsubscribeSubscription?.();
    this.unsubscribeSubscription = onSubscriptionChange(() => {
      this.replaceUpgradeSection();
      // Ask for seats whenever the account has ANY subscription row, and let
      // the server decide who owns seats. Filtering here on the display row's
      // plan/status would miss an owner whose Business row is outranked by
      // another subscription (see BusinessSeatsSection.businessSubscriptionId);
      // free accounts have no row at all, so they still never query.
      if (getSubscription() !== null) {
        void this.businessSeatsSection.load();
      }
    });
    if (getSubscription() !== null) {
      void this.businessSeatsSection.load();
    }
  }

  /**
   * Swap the .upgrade-pro-section wrapper in place. Click handlers are
   * delegated at overlay level, so replacing the node needs no rebind.
   */
  private replaceUpgradeSection(): void {
    const upgradeSection = this.overlay.querySelector('.upgrade-pro-section');
    if (!upgradeSection) return;
    const fresh = document.createElement('template');
    setTrustedHtml(fresh, trustedHtml(this.renderUpgradeSection().trim(), "legacy direct innerHTML migration"));
    const next = fresh.content.firstElementChild;
    if (next) upgradeSection.replaceWith(next);
  }

  public close(origin: OverlayCloseOrigin = 'control'): void {
    if (origin === 'history') this.historyRegistered = false;
    // Unsaved panel changes → confirm before tearing down. The confirm is a
    // non-blocking in-app dialog (#4559): close() stays synchronous (8 callers)
    // and defers teardown to the user's choice instead of a blocking confirm().
    if (origin !== 'replacement' && this.hasPendingPanelChanges()) {
      if (origin === 'history' && !this.historyRegistered) {
        this.historyRegistered = true;
        overlayHistory.open('settings', (nextOrigin) => this.close(nextOrigin));
      }
      if (this.confirmingClose) return; // a confirm is already on screen
      this.confirmingClose = true;
      void confirmDialog({ message: t('header.unsavedChanges') }).then((discard) => {
        this.confirmingClose = false;
        if (discard) this.teardownSettings('control');
      });
      return;
    }
    this.teardownSettings(origin);
  }

  public hasPendingChanges(): boolean {
    return this.hasPendingPanelChanges();
  }

  private teardownSettings(origin: OverlayCloseOrigin = 'control'): void {
    if (origin === 'control' && this.historyRegistered) {
      overlayHistory.close('settings');
    }
    this.historyRegistered = false;
    this.overlay.classList.remove('active');
    this.focusTrap.deactivate();
    this.prefsCleanup?.();
    this.prefsCleanup = null;
    this.notifCleanup?.();
    this.notifCleanup = null;
    this.pendingNotifs = null;
    this.unsubscribeEntitlement?.();
    this.unsubscribeEntitlement = null;
    this.unsubscribeEntitlementVerification?.();
    this.unsubscribeEntitlementVerification = null;
    this.unsubscribeSubscription?.();
    this.unsubscribeSubscription = null;
    this.stopMcpQuotaPolling();
    this.resetPanelDraft();
    localStorage.removeItem('wm-settings-open');
    document.removeEventListener('keydown', this.escapeHandler);
    // Last: the host reloads data in response, and the overlay covering the
    // dashboard has to be gone before that lands for the user to see it.
    this.notifySourceSelectionChanged();
  }

  /**
   * Order-independent fingerprint of the currently DISABLED source names.
   *
   * NUL is the separator because source names contain spaces ("BBC World"):
   * any separator a name can itself hold collapses `["A B"]` and `["A", "B"]`
   * into one string, which is a silent miss for exactly the swap-one-source-
   * for-another case this comparison exists to catch.
   */
  private sourceSelectionSignature(): string {
    return [...this.config.getDisabledSources()].sort().join('\u0000');
  }

  /**
   * Tell the host the source selection moved during this settings session.
   *
   * Every close path funnels through teardownSettings — the close button, Esc,
   * the overlay backdrop, mobile history back, and the discard branch of the
   * unsaved-panel-changes confirm — so this is the single chokepoint. `destroy()`
   * deliberately does not reach it: the dashboard is going away.
   */
  private notifySourceSelectionChanged(): void {
    const baseline = this.sourceSelectionBaseline;
    this.sourceSelectionBaseline = null;
    // null baseline = never opened. A teardown without an open has no session
    // to compare against, and firing there would reload on a spurious close.
    if (baseline === null || baseline === this.sourceSelectionSignature()) return;
    this.config.onSourcesChanged?.();
  }

  public refreshPanelToggles(): void {
    this.resetPanelDraft();
    if (this.activeTab === 'panels') this.renderPanelsTab();
  }

  public getButton(): HTMLButtonElement {
    return createSettingsButton(() => this.open());
  }

  public destroy(): void {
    if (this.historyRegistered) overlayHistory.close('settings');
    this.historyRegistered = false;
    if (this.savedTimeout) clearTimeout(this.savedTimeout);
    this.prefsCleanup?.();
    this.prefsCleanup = null;
    this.notifCleanup?.();
    this.notifCleanup = null;
    this.pendingNotifs = null;
    this.unsubscribeEntitlement?.();
    this.unsubscribeEntitlement = null;
    this.unsubscribeEntitlementVerification?.();
    this.unsubscribeEntitlementVerification = null;
    this.unsubscribeSubscription?.();
    this.unsubscribeSubscription = null;
    this.unsubscribeAuth?.();
    this.unsubscribeAuth = null;
    this.stopMcpQuotaPolling();
    document.removeEventListener('keydown', this.escapeHandler);
    // Teardown, not a user-initiated close: release the trap's document
    // listener without handing focus back to a trigger that is also going away.
    this.focusTrap.deactivate({ restoreFocus: false });
    this.overlay.remove();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (!(e.target instanceof HTMLElement)) return;
    const tablist = this.overlay.querySelector('.unified-settings-tabs');
    if (!tablist || !tablist.contains(e.target)) return;
    const tabs = Array.from(tablist.querySelectorAll<HTMLButtonElement>('button[role="tab"]'));
    const currentIndex = tabs.indexOf(e.target.closest('button[role="tab"]') as HTMLButtonElement);
    const nextIndex = getSettingsTabNavigationIndex(e.key, currentIndex, tabs.length);
    if (nextIndex === null) return;

    e.preventDefault();

    const nextTab = tabs[nextIndex];
    const tabId = nextTab?.dataset.tab as TabId | undefined;
    if (!tabId || !nextTab) return;
    this.switchTab(tabId);
    nextTab.focus();
  }

  private render(loadAccountData = true): void {
    this.prefsCleanup?.();
    this.prefsCleanup = null;
    this.notifCleanup?.();
    this.notifCleanup = null;
    this.pendingNotifs = null;

    const isSignedIn = getAuthState().user !== null;
    const prefs = renderPreferences({
      isDesktopApp: this.config.isDesktopApp,
      onMapProviderChange: this.config.onMapProviderChange,
      onSettingSaved: () => showToast(t('modals.settingsWindow.saved')),
      isSignedIn,
    });
    const showNotificationsTab = !this.config.isDesktopApp;
    const notifs = showNotificationsTab
      ? renderNotificationsSettings({ isSignedIn })
      : null;
    const showMcpClientsTab = hasFeature('mcpAccess');
    const availableTabs: TabId[] = [
      'settings',
      ...(isSignedIn ? ['billing' as const] : []),
      'panels',
      'sources',
      ...(showNotificationsTab ? ['notifications' as const] : []),
      'api-keys',
      ...(showMcpClientsTab ? ['mcp-clients' as const] : []),
    ];
    this.activeTab = normalizeSettingsTab(this.activeTab, availableTabs);
    const tabClass = (id: TabId) => `unified-settings-tab${this.activeTab === id ? ' active' : ''}`;
    const applicablePresets = this.getApplicableTheaterPresets();

    setTrustedHtml(this.overlay, trustedHtml(`
      <div class="modal unified-settings-modal">
        <div class="modal-header">
          <span class="modal-title">${t('header.settings')}</span>
          <button class="modal-close unified-settings-close" aria-label="Close">\u00d7</button>
        </div>
        <div class="unified-settings-tabs" role="tablist" aria-label="Settings">
          <button class="${tabClass('settings')}" tabindex="${this.activeTab === 'settings' ? 0 : -1}" data-tab="settings" role="tab" aria-selected="${this.activeTab === 'settings'}" id="us-tab-settings" aria-controls="us-tab-panel-settings">${t('header.tabSettings')}</button>
          ${isSignedIn ? `<button class="${tabClass('billing')}" tabindex="${this.activeTab === 'billing' ? 0 : -1}" data-tab="billing" role="tab" aria-selected="${this.activeTab === 'billing'}" id="us-tab-billing" aria-controls="us-tab-panel-billing">Plan &amp; billing</button>` : ''}
          <button class="${tabClass('panels')}" tabindex="${this.activeTab === 'panels' ? 0 : -1}" data-tab="panels" role="tab" aria-selected="${this.activeTab === 'panels'}" id="us-tab-panels" aria-controls="us-tab-panel-panels">${t('header.tabPanels')}</button>
          <button class="${tabClass('sources')}" tabindex="${this.activeTab === 'sources' ? 0 : -1}" data-tab="sources" role="tab" aria-selected="${this.activeTab === 'sources'}" id="us-tab-sources" aria-controls="us-tab-panel-sources">${t('header.tabSources')}</button>
          ${showNotificationsTab ? `<button class="${tabClass('notifications')}" tabindex="${this.activeTab === 'notifications' ? 0 : -1}" data-tab="notifications" role="tab" aria-selected="${this.activeTab === 'notifications'}" id="us-tab-notifications" aria-controls="us-tab-panel-notifications">${t('header.tabNotifications')}</button>` : ''}
          <button class="${tabClass('api-keys')}" tabindex="${this.activeTab === 'api-keys' ? 0 : -1}" data-tab="api-keys" role="tab" aria-selected="${this.activeTab === 'api-keys'}" id="us-tab-api-keys" aria-controls="us-tab-panel-api-keys">API Keys <span class="panel-pro-badge">PRO</span></button>
          ${showMcpClientsTab ? `<button class="${tabClass('mcp-clients')}" tabindex="${this.activeTab === 'mcp-clients' ? 0 : -1}" data-tab="mcp-clients" role="tab" aria-selected="${this.activeTab === 'mcp-clients'}" id="us-tab-mcp-clients" aria-controls="us-tab-panel-mcp-clients">MCP Clients <span class="panel-pro-badge">PRO</span></button>` : ''}
        </div>
        <div class="unified-settings-tab-panel${this.activeTab === 'settings' ? ' active' : ''}" data-panel-id="settings" id="us-tab-panel-settings" role="tabpanel" aria-labelledby="us-tab-settings">
          ${prefs.html}
        </div>
        ${isSignedIn ? `
        <div class="unified-settings-tab-panel${this.activeTab === 'billing' ? ' active' : ''}" data-panel-id="billing" id="us-tab-panel-billing" role="tabpanel" aria-labelledby="us-tab-billing">
          <div class="billing-settings-intro">
            <h2>Plan &amp; billing</h2>
            <p>See your current plan and manage payment details, invoices, or cancellation.</p>
          </div>
          ${this.renderUpgradeSection()}
        </div>
        ` : ''}
        <div class="unified-settings-tab-panel${this.activeTab === 'panels' ? ' active' : ''}" data-panel-id="panels" id="us-tab-panel-panels" role="tabpanel" aria-labelledby="us-tab-panels">
          <div class="unified-settings-region-wrapper">
            <div class="unified-settings-region-bar" id="usPanelCatBar"></div>
          </div>
          <div class="panels-search">
            <input type="text" placeholder="${t('header.filterPanels')}" aria-label="${t('header.filterPanels')}" value="${escapeHtml(this.panelFilter)}" />
          </div>
          <div class="panel-toggle-grid" id="usPanelToggles"></div>
          <div class="panels-footer">
            <span class="panels-status" id="usPanelsStatus" aria-live="polite"></span>
            <button class="panels-save-layout">${t('modals.story.save')}</button>
            <button class="panels-reset-layout" title="${t('header.resetLayoutTooltip')}" aria-label="${t('header.resetLayoutTooltip')}">${t('header.resetLayout')}</button>
          </div>
        </div>
        <div class="unified-settings-tab-panel${this.activeTab === 'sources' ? ' active' : ''}" data-panel-id="sources" id="us-tab-panel-sources" role="tabpanel" aria-labelledby="us-tab-sources">
          <div class="unified-settings-region-wrapper">
            <div class="unified-settings-region-bar" id="usRegionBar"></div>
          </div>
          ${applicablePresets.length > 0 ? `
          <div class="unified-settings-presets" id="usCoveragePresets">
            <span class="unified-settings-presets-label">${t('theaterPresets.label')}</span>
            ${applicablePresets.map(preset =>
              `<button type="button" class="unified-settings-region-pill unified-settings-preset-chip" data-preset-id="${preset.id}" title="${escapeHtml(t(preset.descriptionKey))}">${escapeHtml(t(preset.labelKey))}</button>`
            ).join('')}
          </div>
          ` : ''}
          <div class="sources-search">
            <input type="text" placeholder="${t('header.filterSources')}" aria-label="${t('header.filterSources')}" value="${escapeHtml(this.sourceFilter)}" />
          </div>
          <div class="sources-toggle-grid" id="usSourceToggles"></div>
          <div class="sources-footer">
            <span class="sources-counter" id="usSourcesCounter"></span>
            <button class="sources-select-all">${t('common.selectAll')}</button>
            <button class="sources-select-none">${t('common.selectNone')}</button>
          </div>
        </div>
        ${notifs ? `
        <div class="unified-settings-tab-panel${this.activeTab === 'notifications' ? ' active' : ''}" data-panel-id="notifications" id="us-tab-panel-notifications" role="tabpanel" aria-labelledby="us-tab-notifications">
          ${notifs.html}
        </div>
        ` : ''}
        <div class="unified-settings-tab-panel${this.activeTab === 'api-keys' ? ' active' : ''}" data-panel-id="api-keys" id="us-tab-panel-api-keys" role="tabpanel" aria-labelledby="us-tab-api-keys">
          ${this.renderApiKeysContent()}
        </div>
        ${showMcpClientsTab ? `
        <div class="unified-settings-tab-panel${this.activeTab === 'mcp-clients' ? ' active' : ''}" data-panel-id="mcp-clients" id="us-tab-panel-mcp-clients" role="tabpanel" aria-labelledby="us-tab-mcp-clients">
          ${this.renderMcpClientsContent()}
        </div>
        ` : ''}
        ${legalLinksHtml(WEB_APP_ORIGIN)}
      </div>
    `, "legacy direct innerHTML migration"));

    const settingsPanel = this.overlay.querySelector('#us-tab-panel-settings');
    if (settingsPanel) {
      this.prefsCleanup = prefs.attach(settingsPanel as HTMLElement);
    }

    // Defer notifications attach until the tab is first activated —
    // otherwise Pro users pay a getChannelsData() fetch on every modal
    // open even if they never visit this tab.
    this.pendingNotifs = notifs;
    if (this.activeTab === 'notifications') this.attachNotificationsTab();

    const closeBtn = this.overlay.querySelector<HTMLButtonElement>('.unified-settings-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this.close();
      });
    }

    this.attachLegalLinkHandoff();

    this.renderPanelCategoryPills();
    this.renderPanelsTab();
    this.renderRegionPills();
    this.renderSourcesGrid();
    this.updateSourcesCounter();

    this.attachApiKeysHandlers();
    if (loadAccountData) {
      if (this.activeTab === 'api-keys' || this.activeTab === 'mcp-clients') {
        void this.loadPlanLimitNotices();
      }
      if (this.activeTab === 'api-keys' && getAuthState().user && hasFeature('apiAccess')) {
        void this.loadApiKeys();
      }
      if (this.activeTab === 'mcp-clients' && getAuthState().user && hasFeature('mcpAccess')) {
        void this.loadMcpClients();
        this.startMcpQuotaPolling();
      }
    }
  }

  /**
   * Desktop hands legal links to the OS browser (#5911 precedent). A plain
   * `target="_blank"` anchor inside the Tauri WebView opens another WebView
   * window with no chrome, which is how a user ends up stranded on the Terms
   * with no way back. Delegated on the overlay so it covers the legal row AND
   * every checkout-consent line rendered inside a tab panel, including the ones
   * re-rendered after this handler is attached.
   */
  private attachLegalLinkHandoff(): void {
    if (!this.config.isDesktopApp || this.legalLinkHandoffAttached) return;
    // The overlay element outlives every re-render, so an unguarded attach
    // would stack one listener per render and open N windows on one click.
    this.legalLinkHandoffAttached = true;
    this.overlay.addEventListener('click', (e) => {
      const link = (e.target as HTMLElement | null)?.closest?.(`a[${LEGAL_LINK_ATTR}]`);
      const href = link instanceof HTMLAnchorElement ? link.href : '';
      if (!href) return;
      e.preventDefault();
      void openExternalUrl(href);
    });
  }

  private switchTab(tab: TabId): void {
    this.activeTab = tab;

    updateSettingsTabSelection(
      this.overlay.querySelectorAll<HTMLElement>('.unified-settings-tab'),
      this.overlay.querySelectorAll<HTMLElement>('.unified-settings-tab-panel'),
      tab,
    );

    if (tab === 'api-keys' && getAuthState().user && hasFeature('apiAccess')) {
      void this.loadPlanLimitNotices();
      void this.loadApiKeys();
    }

    if (tab === 'mcp-clients' && getAuthState().user && hasFeature('mcpAccess')) {
      void this.loadPlanLimitNotices();
      void this.loadMcpClients();
      this.startMcpQuotaPolling();
    } else {
      // Stop polling when switching away — no need to keep the timer running
      // for a hidden tab.
      this.stopMcpQuotaPolling();
    }

    if (tab === 'notifications') {
      this.attachNotificationsTab();
    }
  }

  private attachNotificationsTab(): void {
    if (this.notifCleanup || !this.pendingNotifs) return;
    const notifPanel = this.overlay.querySelector('#us-tab-panel-notifications');
    if (notifPanel) {
      this.notifCleanup = this.pendingNotifs.attach(notifPanel as HTMLElement);
    }
  }

  // Pending state shown while the plan is still resolving — used both before
  // the entitlement snapshot arrives and, for an entitled owner, while the
  // subscription watch is still settling (#6772).
  private renderPlanCheckingState(): string {
    return `
        <div class="upgrade-pro-section upgrade-pro-loading" role="status" aria-live="polite">
          <div class="upgrade-pro-title">Checking your plan…</div>
          <div class="upgrade-pro-desc">This usually takes only a moment.</div>
        </div>
      `;
  }

  private renderUpgradeSection(): string {
    // Non-Dodo premium (API key / tester key / Clerk pro role without a
    // Convex subscription): neither "Upgrade" nor "Manage Billing" is
    // actionable. Still explain the account state here; a hidden billing
    // section would recreate the discoverability problem this tab fixes.
    if (!isEntitled() && hasPremiumAccess()) {
      return `
        <div class="upgrade-pro-section upgrade-pro-external" data-billing-state="external">
          <div class="upgrade-pro-title">Premium access</div>
          <div class="upgrade-pro-desc">This access is not billed through your WorldMonitor account. No payment method or invoices are available here.</div>
        </div>
      `;
    }
    const sub = getSubscription();
    const billingState = deriveBillingUxState(sub, getEntitlementState(), Date.now());
    if (billingState === 'lapsed') {
      const planName = sub?.displayName ?? 'Pro';
      return `
        <div class="upgrade-pro-section upgrade-pro-lapsed" data-billing-state="lapsed">
          <div class="upgrade-pro-title">${escapeHtml(t('components.billingState.resubscribe'))}: ${escapeHtml(planName)}</div>
          <div class="upgrade-pro-desc">${escapeHtml(t('components.billingState.lapsedDesc'))}</div>
          <a class="upgrade-pro-cta-link" href="${WEB_APP_ORIGIN}${getReactivationHref(sub?.planKey)}" target="_blank" rel="noopener">${escapeHtml(t('components.billingState.resubscribe'))} →</a>
        </div>
      `;
    }
    // Signed-in user whose Convex entitlement snapshot has not arrived yet.
    // Rendering "Upgrade to Pro" in this window is how paying users click through to
    // /api/create-checkout and hit 409 duplicate_subscription — same race
    // as the 2026-04-17/18 panel-overlay incident fixed in panel-gating.ts,
    // different surface. The verification service stays pending across the
    // complete Clerk/Convex retry schedule and publishes unavailable only
    // after a terminal handoff or subscription failure.
    const verificationStatus = getEntitlementVerificationStatus();
    if (
      getAuthState().user
      && getEntitlementState() === null
      && (verificationStatus === 'idle' || verificationStatus === 'pending')
    ) {
      return this.renderPlanCheckingState();
    }
    if (isEntitled()) {
      const sub = getSubscription();
      // A Pro owner's entitlement snapshot can arrive before their own
      // subscription watch settles. In that window getSubscription() is null
      // but the user is NOT a Business invitee — falling through would render
      // "Billing is managed by your plan owner" and hide Manage Billing from a
      // paying owner. Treat an unresolved watch like the pending state above;
      // the invitee copy below is reserved for a *settled* null (#6772).
      if (sub === null && !isSubscriptionLoaded()) {
        return this.renderPlanCheckingState();
      }
      const planName = sub?.displayName ?? 'Pro';
      const now = Date.now();
      // A Business Pro grant invitee has no own subscription row (sub === null)
      // but IS entitled (we're inside the isEntitled() branch) — they hold a
      // grant that is working, so paint them like an active plan.
      const tone: BillingStatusTone = sub === null
        ? 'active'
        : getSubscriptionStatusTone(sub, now);

      let statusLine = '';
      if (sub?.currentPeriodEnd) {
        const dateStr = new Date(sub.currentPeriodEnd).toLocaleDateString();
        if (sub.status === 'active') {
          statusLine = `Renews: ${dateStr}`;
        } else if (sub.status === 'on_hold') {
          statusLine = 'On hold -- please update payment method';
        } else if (sub.status === 'cancelled') {
          statusLine = `Cancelled -- access until ${dateStr}`;
        } else if (sub.status === 'expired') {
          statusLine = 'Expired';
        } else {
          // A status this client does not model yet. We are inside the
          // isEntitled() branch, so access is working — say only that, and
          // point at the billing portal rather than leaving the `unknown`
          // tone as a bare grey dot with no sentence at all.
          statusLine = 'See Manage Billing for your current plan details.';
        }
      }

      // An invitee holding a Business Pro grant has Pro features but no own
      // subscription row — they hold a grant, not a subscription, so the
      // billing surface remains owner-only. Show their plan status without
      // the Manage Billing CTA that would 404 against Dodo.
      const hasOwnSubscription = sub !== null;
      if (!hasOwnSubscription) {
        statusLine = 'Billing is managed by your plan owner.';
      }

      return `
        <div class="upgrade-pro-section upgrade-pro-active" data-billing-tone="${tone}">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:${statusLine ? '8' : '0'}px;">
            <span class="upgrade-pro-tone-dot"></span>
            <span class="upgrade-pro-plan-name">${escapeHtml(planName)}</span>
          </div>
          ${statusLine ? `<div class="upgrade-pro-status-line">${escapeHtml(statusLine)}</div>` : ''}
          ${sub?.planKey === 'api_starter' ? `<button class="upgrade-to-business-btn" style="margin-right:8px;">Upgrade to Business</button>` : ''}
          ${hasOwnSubscription ? `<button class="manage-billing-btn">Manage Billing</button>` : ''}
        </div>
        ${hasOwnSubscription ? `<div id="usBusinessSeats">${this.businessSeatsSection.renderContent()}</div>` : ''}
      `;
    }

    // A terminal auth/subscription failure still does not prove the user is
    // free. Keep checkout unavailable, offer a fresh verification attempt,
    // and retain the safe /pro link in a separate tab.
    if (getAuthState().user && getEntitlementState() === null) {
      return `
        <div class="upgrade-pro-section upgrade-pro-fallback">
          <div class="upgrade-pro-title">Plan status unavailable</div>
          <div class="upgrade-pro-desc">We could not verify your current plan. Try again or view plans in a new tab.</div>
          <button class="manage-billing-btn retry-plan-status-btn" style="margin-bottom:8px;">Try again</button>
          <a class="upgrade-pro-cta-link" href="${WEB_APP_ORIGIN}/pro" target="_blank" rel="noopener">View plans →</a>
        </div>
      `;
    }

    return `
      <div class="upgrade-pro-section" data-billing-state="free">
        <div class="upgrade-pro-title">WorldMonitor Free</div>
        <div class="upgrade-pro-desc">Your current plan is Free. Upgrade for all panels, AI analysis, and priority data refresh.</div>
        ${checkoutConsentHtml(WEB_APP_ORIGIN)}
        <button class="upgrade-pro-cta">Upgrade to Pro</button>
      </div>
    `;
  }

  // Business Pro seats (#4634/#4635) state/render/handlers live in
  // BusinessSeatsSection — see this.businessSeatsSection.

  private handleUpgradeClick(): void {
    // Defense in depth: re-check at click time so a late-arriving "you're a
    // paying user" snapshot routes to the billing portal instead of creating
    // a second checkout against an active subscription.
    if (isEntitled()) {
      this.close();
      const reservedWin = prereserveBillingPortalTab();
      void openBillingPortal(reservedWin).then((result) => {
        // The portal session exists but no window opened (native handoff
        // refused and the browser fallback was blocked). Saying nothing here
        // reads as a dead click on a paid feature.
        if (result.outcome === 'open-failed') {
          showToast('Could not open the billing portal. Please allow pop-ups and try again.');
          return;
        }
        if (result.outcome === 'no-customer') {
          showToast(
            'Subscription is managed outside Dodo. Email support@worldmonitor.app for help.',
          );
        }
      });
      return;
    }
    this.close();
    if (this.config.isDesktopApp) {
      // Desktop deliberately skips in-app checkout and sends the user to the
      // pricing page — but a bare window.open only opens another WebView
      // window. `openExternalUrl` hands it to the OS browser (#5911).
      void openExternalUrl(`${WEB_APP_ORIGIN}/pro`);
      return;
    }
    import('@/services/checkout').then(m => import('@/config/products').then(p => m.startCheckout(p.DEFAULT_UPGRADE_PRODUCT))).catch(() => {
      void openExternalUrl(`${WEB_APP_ORIGIN}/pro`);
    });
  }

  private categoryMatchesVariant(catDef: { variants?: string[] }): boolean {
    return !catDef.variants || catDef.variants.includes(SITE_VARIANT);
  }

  private getAvailablePanelCategories(): Array<{ key: string; label: string }> {
    return [
      { key: 'all', label: t('header.sourceRegionAll') },
      ...getVariantPanelCategories(this.config.getPanelSettings(), SITE_VARIANT)
        .map(({ key, labelKey }) => ({ key, label: t(labelKey) })),
    ];
  }

  private getVisiblePanelEntries(): Array<[string, PanelConfig]> {
    const panelSettings = this.draftPanelSettings;
    let entries = Object.entries(panelSettings)
      .filter(([key]) => key !== 'runtime-config' || this.config.isDesktopApp)
      .filter(([key]) => !key.startsWith('cw-'));

    if (this.activePanelCategory !== 'all') {
      const catDef = PANEL_CATEGORY_MAP[this.activePanelCategory];
      if (catDef) {
        if (!this.categoryMatchesVariant(catDef)) {
          return [];
        }
        const allowed = new Set(catDef.panelKeys);
        entries = entries.filter(([key]) => allowed.has(key));
      }
    }

    if (this.panelFilter) {
      const lower = this.panelFilter.toLowerCase();
      entries = entries.filter(([key, panel]) =>
        key.toLowerCase().includes(lower) ||
        panel.name.toLowerCase().includes(lower) ||
        this.config.getLocalizedPanelName(key, panel.name).toLowerCase().includes(lower)
      );
    }

    return entries;
  }

  private renderPanelCategoryPills(): void {
    const bar = this.overlay.querySelector('#usPanelCatBar');
    if (!bar) return;

    const categories = this.getAvailablePanelCategories();
    setTrustedHtml(bar, trustedHtml(categories.map(c =>
      `<button class="unified-settings-region-pill${this.activePanelCategory === c.key ? ' active' : ''}" data-panel-cat="${c.key}">${escapeHtml(c.label)}</button>`
    ).join(''), "legacy direct innerHTML migration"));
  }

  private renderPanelsTab(): void {
    const container = this.overlay.querySelector('#usPanelToggles');
    if (!container) return;

    const savedSettings = this.config.getPanelSettings();
    const pro = isProUser();
    const entries = this.getVisiblePanelEntries();
    const panelFontScaleLabel = t('preferences.panelFontScale', { defaultValue: 'Text size' });
    const followGlobalFontScaleLabel = t('preferences.followGlobalFontScale', { defaultValue: 'Use global' });
    setTrustedHtml(container, trustedHtml(entries.map(([key, panel]) => {
      // Preserve saved config for dynamic cw-* panels; unknown keys should not
      // collapse to getEffectivePanelConfig's disabled synthetic fallback.
      const resolvedPanel = ALL_PANELS[key] ? getEffectivePanelConfig(key, SITE_VARIANT) : panel;
      const entitled = isPanelEntitled(key, resolvedPanel, pro);
      const locked = !entitled;
      const changed = !locked && this.isPanelDraftChanged(key, panel, savedSettings);
      const displayName = this.config.getLocalizedPanelName(key, resolvedPanel.name ?? panel.name);
      const a11yState = getPanelToggleA11yState(locked, panel.enabled, displayName);
      // Sandboxed MCP iframes cannot inherit the host panel's CSS scale.
      const supportsPanelFontScale = key !== 'map' && !key.startsWith('mcp-');
      return `
        <div class="panel-settings-item">
          <button type="button" class="panel-toggle-item ${panel.enabled && !locked ? 'active' : ''}${changed ? ' changed' : ''}${locked ? ' pro-locked' : ''}" data-panel="${escapeHtml(key)}" ${a11yState.ariaPressed === null ? '' : `aria-pressed="${a11yState.ariaPressed}"`} ${a11yState.ariaLabel === null ? '' : `aria-label="${escapeHtml(a11yState.ariaLabel)}"`} ${locked ? 'data-pro-locked="1"' : ''}>
            <div class="panel-toggle-checkbox" aria-hidden="true">${panel.enabled && !locked ? '\u2713' : ''}${locked ? '\uD83D\uDD12' : ''}</div>
            <span class="panel-toggle-label">${escapeHtml(displayName)}</span>
            ${(locked || resolvedPanel.premium) ? '<span class="panel-toggle-pro-badge" aria-hidden="true">PRO</span>' : ''}
          </button>
          ${supportsPanelFontScale ? `<label class="panel-font-scale-control">
            <span>${escapeHtml(panelFontScaleLabel)}</span>
            <select data-panel-font-scale="${escapeHtml(key)}" aria-label="${escapeHtml(`${displayName}: ${panelFontScaleLabel}`)}"${locked ? ' disabled' : ''}>
              <option value="global"${panel.fontScale === undefined ? ' selected' : ''}>${escapeHtml(followGlobalFontScaleLabel)}</option>
              ${FONT_SCALE_STEPS.map(scale => `<option value="${scale}"${panel.fontScale === scale ? ' selected' : ''}>${fontScaleLabel(scale)}</option>`).join('')}
            </select>
          </label>` : ''}
        </div>
      `;
    }).join(''), "legacy direct innerHTML migration"));

    this.updatePanelsFooter();
  }

  private clonePanelSettings(source: Record<string, PanelConfig> = this.config.getPanelSettings()): Record<string, PanelConfig> {
    const cloned: Record<string, PanelConfig> = Object.fromEntries(
      Object.entries(source).map(([key, panel]) => [key, { ...panel }]),
    );
    for (const key of Object.keys(ALL_PANELS)) {
      if (!(key in cloned)) {
        cloned[key] = { ...getEffectivePanelConfig(key, SITE_VARIANT), enabled: isPanelInVariantDefaults(key) };
      }
    }
    return cloned;
  }

  private resetPanelDraft(): void {
    this.draftPanelSettings = this.clonePanelSettings();
    this.panelsJustSaved = false;
  }

  private getSavedPanelEnabled(key: string, savedSettings: Record<string, PanelConfig>): boolean {
    const savedPanel = savedSettings[key];
    if (savedPanel) return savedPanel.enabled;
    return Boolean(ALL_PANELS[key]) && isPanelInVariantDefaults(key);
  }

  private getSavedPanelFontScale(
    key: string,
    savedSettings: Record<string, PanelConfig>,
  ): PanelConfig['fontScale'] {
    return savedSettings[key]?.fontScale;
  }

  private isPanelDraftChanged(
    key: string,
    panel: PanelConfig,
    savedSettings: Record<string, PanelConfig>,
  ): boolean {
    return this.getSavedPanelEnabled(key, savedSettings) !== panel.enabled
      || this.getSavedPanelFontScale(key, savedSettings) !== panel.fontScale;
  }

  private hasPendingPanelChanges(): boolean {
    const savedSettings = this.config.getPanelSettings();
    return Object.entries(this.draftPanelSettings).some(
      ([key, panel]) => this.isPanelDraftChanged(key, panel, savedSettings),
    );
  }

  private toggleDraftPanel(key: string): void {
    const panel = this.draftPanelSettings[key];
    if (!panel) return;
    // Preserve saved config for dynamic cw-* panels; unknown keys should not
    // collapse to getEffectivePanelConfig's disabled synthetic fallback.
    const resolvedPanel = ALL_PANELS[key] ? getEffectivePanelConfig(key, SITE_VARIANT) : panel;
    if (!panel.enabled && !isPanelEntitled(key, resolvedPanel, isProUser())) return;
    if (!panel.enabled && !isProUser() && isFreePanelCapCounted(key)) {
      const enabledCount = countFreePanelCapUsage(this.draftPanelSettings);
      if (enabledCount >= FREE_MAX_PANELS) {
        showToast(t('modals.settingsWindow.freePanelLimit', { max: String(FREE_MAX_PANELS) }));
        return;
      }
    }
    panel.enabled = !panel.enabled;
    this.panelsJustSaved = false;
    this.renderPanelsTab();
  }

  private savePanelChanges(): void {
    if (!this.hasPendingPanelChanges()) return;
    this.config.savePanelSettings(Object.fromEntries(Object.entries(this.draftPanelSettings).map(([k, v]) => [k, { ...v }])));
    this.draftPanelSettings = this.clonePanelSettings();
    this.panelsJustSaved = true;
    this.renderPanelsTab();
    if (this.savedTimeout) clearTimeout(this.savedTimeout);
    this.savedTimeout = setTimeout(() => {
      this.panelsJustSaved = false;
      this.savedTimeout = null;
      this.updatePanelsFooter();
    }, 2000);
  }

  private updatePanelsFooter(): void {
    const status = this.overlay.querySelector<HTMLElement>('#usPanelsStatus');
    const saveButton = this.overlay.querySelector<HTMLButtonElement>('.panels-save-layout');
    const hasPendingChanges = this.hasPendingPanelChanges();

    if (saveButton) {
      saveButton.disabled = !hasPendingChanges;
    }

    if (status) {
      status.textContent = this.panelsJustSaved ? t('modals.settingsWindow.saved') : '';
      status.classList.toggle('visible', this.panelsJustSaved);
    }
  }

  private getAvailableRegions(): Array<{ key: string; label: string }> {
    // A region pill shows when at least one of its sources is actually being
    // loaded — getAllSourceNames() covers the active preset PLUS any cross-
    // variant panels the user enabled, so customized-in regions appear too.
    const allowed = new Set(this.config.getAllSourceNames());
    const regions: Array<{ key: string; label: string }> = [
      { key: 'all', label: t('header.sourceRegionAll') }
    ];

    for (const [regionKey, regionDef] of Object.entries(SOURCE_REGION_MAP)) {
      if (regionKey === 'intel') {
        if (INTEL_SOURCES.length > 0) {
          regions.push({ key: regionKey, label: t(regionDef.labelKey) });
        }
        continue;
      }
      const hasFeeds = regionDef.feedKeys.some(fk =>
        (CANONICAL_FEEDS[fk] ?? []).some(f => allowed.has(f.name)));
      if (hasFeeds) {
        regions.push({ key: regionKey, label: t(regionDef.labelKey) });
      }
    }

    return regions;
  }

  private getSourcesByRegion(): Map<string, string[]> {
    const map = new Map<string, string[]>();
    // Resolve region membership from CANONICAL_FEEDS (the all-variant union),
    // then intersect with the sources actually loaded — getAllSourceNames()
    // already covers the active preset + any custom panels the user enabled —
    // so a customized-in panel's sources show under their proper region pill,
    // not just the 'all' view.
    const allowed = new Set(this.config.getAllSourceNames());

    for (const [regionKey, regionDef] of Object.entries(SOURCE_REGION_MAP)) {
      const sources: string[] = [];
      if (regionKey === 'intel') {
        INTEL_SOURCES.forEach(f => sources.push(f.name));
      } else {
        for (const fk of regionDef.feedKeys) {
          for (const f of CANONICAL_FEEDS[fk] ?? []) {
            if (allowed.has(f.name)) sources.push(f.name);
          }
        }
      }
      if (sources.length > 0) {
        map.set(regionKey, sources.sort((a, b) => a.localeCompare(b)));
      }
    }

    return map;
  }

  private getVisibleSourceNames(): string[] {
    let sources: string[];
    if (this.activeSourceRegion === 'all') {
      sources = this.config.getAllSourceNames();
    } else {
      const byRegion = this.getSourcesByRegion();
      sources = byRegion.get(this.activeSourceRegion) || [];
    }

    if (this.sourceFilter) {
      const lower = this.sourceFilter.toLowerCase();
      sources = sources.filter(s => s.toLowerCase().includes(lower));
    }

    return sources;
  }

  private renderRegionPills(): void {
    const bar = this.overlay.querySelector('#usRegionBar');
    if (!bar) return;

    const regions = this.getAvailableRegions();
    setTrustedHtml(bar, trustedHtml(regions.map(r =>
      `<button class="unified-settings-region-pill${this.activeSourceRegion === r.key ? ' active' : ''}" data-region="${r.key}">${escapeHtml(r.label)}</button>`
    ).join(''), "legacy direct innerHTML migration"));
  }

  private renderSourcesGrid(): void {
    const container = this.overlay.querySelector('#usSourceToggles');
    if (!container) return;

    const sources = this.getVisibleSourceNames();
    const disabled = this.config.getDisabledSources();

    setTrustedHtml(container, trustedHtml(sources.map(source => {
      const isEnabled = !disabled.has(source);
      const escaped = escapeHtml(source);
      return `
        <button type="button" class="source-toggle-item ${isEnabled ? 'active' : ''}" aria-pressed="${isEnabled}" data-source="${escaped}">
          <div class="source-toggle-checkbox" aria-hidden="true">${isEnabled ? '\u2713' : ''}</div>
          <span class="source-toggle-label">${escaped}</span>
        </button>
      `;
    }).join(''), "legacy direct innerHTML migration"));
  }

  private updateSourcesCounter(): void {
    const counter = this.overlay.querySelector('#usSourcesCounter');
    if (!counter) return;

    const disabled = this.config.getDisabledSources();
    const allSources = this.config.getAllSourceNames();
    const enabledTotal = allSources.length - disabled.size;

    counter.textContent = t('header.sourcesEnabled', { enabled: String(enabledTotal), total: String(allSources.length) });
  }

  /**
   * Presets with at least one source that resolves in the runtime-known
   * source set. Narrow variants (or disabled news panels) can leave a preset
   * with nothing to enable — those chips are dead, so don't offer them.
   */
  private getApplicableTheaterPresets(): readonly TheaterPreset[] {
    const known = new Set(this.config.getAllSourceNames());
    return THEATER_PRESETS.filter((preset) => resolveTheaterPresetSources(preset, known).length > 0);
  }

  /**
   * Theater coverage preset (#5956): additively enable the preset's sources.
   * Uses the same bulk primitive as select-all, so persistence, the free
   * source cap, and cloud sync behave identically; unrelated sources are
   * never touched.
   */
  private applyCoveragePreset(presetId: string): void {
    const preset = getTheaterPreset(presetId);
    if (!preset) return;

    const known = new Set(this.config.getAllSourceNames());
    const resolvable = resolveTheaterPresetSources(preset, known);
    const toEnable = getTheaterPresetEnableList(preset, this.config.getDisabledSources(), known);
    const label = t(preset.labelKey);

    // Zero resolvable sources (narrow variant or unloaded panels) is not the
    // same as "already applied" — say so. Normally unreachable because the
    // chips row only renders applicable presets; kept as a defensive guard.
    if (resolvable.length === 0) {
      showToast(t('theaterPresets.unavailable', { preset: label }));
      return;
    }

    if (toEnable.length === 0) {
      showToast(t('theaterPresets.alreadyApplied', { preset: label }));
      return;
    }

    // setSourcesEnabled no-ops (with its own free-cap toast) when the free
    // source cap would be exceeded — only re-render and claim success when
    // state actually changed.
    const disabledSizeBefore = this.config.getDisabledSources().size;
    this.config.setSourcesEnabled(toEnable, true);
    if (this.config.getDisabledSources().size !== disabledSizeBefore) {
      this.renderSourcesGrid();
      this.updateSourcesCounter();
      showToast(t('theaterPresets.applied', { preset: label, count: String(toEnable.length) }));
    }
  }

  private async loadPlanLimitNotices(): Promise<void> {
    const request = this.captureAccountRequest();
    if (!request || this.planLimitNoticesLoading) return;
    this.planLimitNoticesLoading = true;
    this.planLimitNoticesError = '';
    try {
      const notices = await listCurrentPlanLimitNotices();
      if (!this.isAccountRequestCurrent(request)) return;
      this.planLimitNotices = notices;
    } catch (err) {
      if (!this.isAccountRequestCurrent(request)) return;
      console.warn('[settings] Failed to load API plan-limit notices:', err);
      this.planLimitNoticesError = err instanceof Error
        ? err.message
        : 'Failed to load API plan-limit notices';
    } finally {
      if (this.isAccountRequestCurrent(request)) {
        this.planLimitNoticesLoading = false;
        this.renderPlanLimitNoticeBlocks();
      }
    }
  }

  private renderPlanLimitNoticeBlocks(): void {
    const html = this.renderPlanLimitNotices();
    this.overlay.querySelectorAll<HTMLElement>('[data-plan-limit-notices]').forEach((el) => {
      setTrustedHtml(el, trustedHtml(html, "legacy direct innerHTML migration"));
    });
  }

  private planLimitDimensionLabel(dimension: ApiPlanLimitNotice['dimension']): string {
    switch (dimension) {
      case 'api_daily_requests': return 'Daily API requests';
      case 'api_minute_burst': return 'API burst traffic';
      case 'mcp_daily_calls': return 'Daily MCP calls';
      case 'mcp_minute_burst': return 'MCP burst traffic';
    }
  }

  private planLimitStateLabel(state: ApiPlanLimitNotice['state']): string {
    if (state === 'warning') return 'Nearing plan limit';
    if (state === 'sustained_burst') return 'Burst limit exceeded';
    return 'Plan limit exceeded';
  }

  private renderPlanLimitNotices(): string {
    if (!this.planLimitNoticesError && this.planLimitNotices.length === 0) return '';
    const error = this.planLimitNoticesError
      ? `<div class="api-keys-error api-plan-limit-notices-error" role="alert">${escapeHtml(this.planLimitNoticesError)}</div>`
      : '';
    const nf = new Intl.NumberFormat();
    return `
      <div class="api-plan-limit-notices" aria-live="polite">
        ${error}
        ${this.planLimitNotices.map((notice) => {
          const limit = notice.limit == null ? 'unlimited' : nf.format(notice.limit);
          const usage = nf.format(notice.usage);
          const ratio = notice.usageRatio == null ? '' : ` (${Math.round(notice.usageRatio * 100)}%)`;
          const cta = notice.ctaKind === 'contact_support'
            ? 'Contact support'
            : notice.ctaKind === 'billing_portal'
            ? 'Manage billing'
            : notice.ctaKind === 'checkout'
            ? 'Upgrade'
            : '';
          return `
            <div class="api-plan-limit-notice ${escapeHtml(notice.state)}">
              <div class="api-plan-limit-notice-main">
                <div class="api-plan-limit-notice-title">${escapeHtml(this.planLimitStateLabel(notice.state))}</div>
                <div class="api-plan-limit-notice-body">
                  ${escapeHtml(this.planLimitDimensionLabel(notice.dimension))}: ${escapeHtml(usage)} used / ${escapeHtml(limit)} included${escapeHtml(ratio)} in ${escapeHtml(notice.windowKey)}.
                  You can upgrade for more room or reduce traffic to stay on this plan.
                </div>
              </div>
              <div class="api-plan-limit-notice-actions">
                ${notice.ctaKind === 'checkout' ? checkoutConsentHtml(WEB_APP_ORIGIN) : ''}
                ${cta ? `<button class="btn btn-primary api-plan-limit-notice-cta" data-plan-limit-cta="${escapeHtml(notice._id)}">${escapeHtml(cta)}</button>` : ''}
                <button class="btn btn-ghost api-plan-limit-notice-ack" data-plan-limit-ack="${escapeHtml(notice._id)}">Dismiss</button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  private async handleAcknowledgePlanLimitNotice(noticeId: string): Promise<void> {
    const request = this.captureAccountRequest();
    if (!request) return;
    try {
      await acknowledgePlanLimitNotice(noticeId);
      if (!this.isAccountRequestCurrent(request)) return;
      this.planLimitNotices = this.planLimitNotices.filter((notice) => notice._id !== noticeId);
      this.renderPlanLimitNoticeBlocks();
    } catch (err) {
      if (!this.isAccountRequestCurrent(request)) return;
      console.warn('[settings] Failed to acknowledge API plan-limit notice:', err);
      showToast('Could not dismiss this notice. Try again.');
    }
  }

  private handlePlanLimitNoticeCta(noticeId: string): void {
    const notice = this.planLimitNotices.find((item) => item._id === noticeId);
    if (!notice) return;
    if (notice.ctaKind === 'billing_portal') {
      const reservedWin = prereserveBillingPortalTab();
      void openBillingPortal(reservedWin).then((result) => {
        // The portal session exists but no window opened (native handoff
        // refused and the browser fallback was blocked). Saying nothing here
        // reads as a dead click on a paid feature.
        if (result.outcome === 'open-failed') {
          showToast('Could not open the billing portal. Please allow pop-ups and try again.');
          return;
        }
        if (result.outcome === 'no-customer') {
          showToast('Subscription is managed outside Dodo. Email support@worldmonitor.app for help.');
        }
      });
      return;
    }
    if (notice.ctaKind === 'checkout') {
      // Never send an active subscriber to a fresh checkout. The upgrade target
      // (api_starter) sits in a DIFFERENT tierGroup than an existing Pro sub, and
      // getCheckoutBlockingSubscription only blocks a same-tierGroup duplicate
      // (#4797) — so startCheckout would STACK a second live subscription and
      // double-charge. Route entitled users to the billing portal instead (same
      // precedent as handleUpgradeClick); its no-customer outcome surfaces the
      // support path for a subscription managed outside Dodo.
      if (isEntitled()) {
        const reservedWin = prereserveBillingPortalTab();
        void openBillingPortal(reservedWin).then((result) => {
          // The portal session exists but no window opened (native handoff
          // refused and the browser fallback was blocked). Saying nothing here
          // reads as a dead click on a paid feature.
          if (result.outcome === 'open-failed') {
            showToast('Could not open the billing portal. Please allow pop-ups and try again.');
            return;
          }
          if (result.outcome === 'no-customer') {
            showToast('Subscription is managed outside Dodo. Email support@worldmonitor.app for help.');
          }
        });
        return;
      }
      this.close();
      import('@/services/checkout').then(m => import('@/config/products').then((p) => {
        const product = notice.upgradeTargetPlanKey === 'api_starter'
          ? p.DODO_PRODUCTS.API_STARTER_MONTHLY
          : p.DODO_PRODUCTS.PRO_MONTHLY;
        return m.startCheckout(product);
      })).catch(() => {
        void openExternalUrl(`${WEB_APP_ORIGIN}/pro`);
      });
      return;
    }
    if (notice.ctaKind === 'contact_support') {
      window.location.href = `mailto:support@worldmonitor.app?subject=${encodeURIComponent('WorldMonitor API plan limit upgrade')}`;
    }
  }

  // ---------------------------------------------------------------------------
  // API Keys tab
  // ---------------------------------------------------------------------------

  private attachApiKeysHandlers(): void {
    // Enter to submit (only exists when entitled user sees full UI)
    const apiKeyInput = this.overlay.querySelector<HTMLInputElement>('.api-keys-name-input');
    if (apiKeyInput) {
      apiKeyInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void this.handleCreateApiKey();
      });
    }

    // Gate CTA click (sign-in for anonymous, checkout for free)
    const gateBtn = this.overlay.querySelector<HTMLElement>('.api-keys-gate-btn');
    if (gateBtn) {
      gateBtn.addEventListener('click', () => {
        if (!getAuthState().user) {
          this.close();
          import('@/services/clerk').then(m => m.openSignIn()).catch(() => {});
        } else {
          this.close();
          import('@/services/checkout').then(m => import('@/config/products').then(p => m.startCheckout(p.DODO_PRODUCTS.API_STARTER_MONTHLY))).catch(() => {
            void openExternalUrl(`${WEB_APP_ORIGIN}/pro`);
          });
        }
      });
    }
  }

  private renderApiKeysContent(): string {
    const authState = getAuthState();

    if (!authState.user) {
      const lockIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>`;
      return `
        <div class="panel-locked-state">
          <div class="panel-locked-icon">${lockIcon}</div>
          <div class="panel-locked-desc">Sign in to unlock API Keys</div>
          <button class="panel-locked-cta api-keys-gate-btn">Sign In</button>
        </div>`;
    }

    if (!hasFeature('apiAccess')) {
      const upgradeIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="16 12 12 8 8 12"/><line x1="12" y1="16" x2="12" y2="8"/></svg>`;
      return `
        <div class="panel-locked-state">
          <div class="panel-locked-icon">${upgradeIcon}</div>
          <div class="panel-locked-desc">Create and manage API keys to access WorldMonitor data programmatically.</div>
          ${checkoutConsentHtml(WEB_APP_ORIGIN)}
          <button class="panel-locked-cta api-keys-gate-btn">Upgrade to API Starter</button>
        </div>`;
    }

    return `
      <div class="api-keys-section">
        <div data-plan-limit-notices>${this.renderPlanLimitNotices()}</div>
        <div class="api-keys-header">
          <p class="api-keys-desc">Create API keys to access WorldMonitor data programmatically. Keys are shown once on creation — store them securely.</p>
        </div>
        <div class="api-keys-create-form">
          <input type="text" class="api-keys-name-input" placeholder="Key name (e.g. my-app)" aria-label="API key name" maxlength="64" />
          <button class="btn btn-primary api-keys-create-btn">Create Key</button>
        </div>
        <div class="api-keys-created-banner" id="usApiKeysBanner" style="display:none;"></div>
        <div class="api-keys-error" id="usApiKeysError" style="display:none;"></div>
        <div class="api-keys-list" id="usApiKeysList">
          <div class="api-keys-loading">Loading...</div>
        </div>
      </div>`;
  }

  private async loadApiKeys(): Promise<void> {
    const request = this.captureAccountRequest();
    if (!request || this.apiKeysLoading) return;
    this.apiKeysLoading = true;
    this.apiKeysError = '';
    this.renderApiKeysList();

    try {
      const keys = await listApiKeys();
      if (!this.isAccountRequestCurrent(request)) return;
      this.apiKeys = keys;
    } catch (err) {
      if (!this.isAccountRequestCurrent(request)) return;
      this.apiKeysError = err instanceof Error ? err.message : 'Failed to load keys';
    } finally {
      if (this.isAccountRequestCurrent(request)) {
        this.apiKeysLoading = false;
        this.renderApiKeysList();
      }
    }
  }

  private async handleCreateApiKey(): Promise<void> {
    const input = this.overlay.querySelector<HTMLInputElement>('.api-keys-name-input');
    const btn = this.overlay.querySelector<HTMLButtonElement>('.api-keys-create-btn');
    const name = input?.value.trim();
    if (!name || !input || !btn) return;
    const request = this.captureAccountRequest();
    if (!request) return;

    btn.disabled = true;
    btn.textContent = 'Creating...';
    this.apiKeysError = '';
    this.newlyCreatedKey = null;
    this.hideBanner();

    try {
      const result = await createApiKey(name);
      if (!this.isAccountRequestCurrent(request)) return;
      trackApiAction('key-created');
      this.newlyCreatedKey = result.key;
      input.value = '';
      this.showCreatedBanner(result.key);
      await this.loadApiKeys();
    } catch (err) {
      if (!this.isAccountRequestCurrent(request)) return;
      const msg = err instanceof Error ? err.message : 'Failed to create key';
      this.apiKeysError = msg.includes('KEY_LIMIT_REACHED')
        ? 'Maximum of 5 active keys reached. Revoke an existing key first.'
        : msg.includes('API_ACCESS_REQUIRED')
        ? 'API keys require an API access subscription (API Starter or higher).'
        : msg;
      this.renderApiKeysError();
    } finally {
      if (this.isAccountRequestCurrent(request)) {
        btn.disabled = false;
        btn.textContent = 'Create Key';
      }
    }
  }

  private async handleRevokeApiKey(keyId: string): Promise<void> {
    const request = this.captureAccountRequest();
    if (!request) return;
    const keyInfo = this.apiKeys.find(k => k.id === keyId);
    const keyName = keyInfo?.name ?? 'this key';
    if (!confirm(`Revoke "${keyName}"? This cannot be undone. Any applications using this key will stop working.`)) return;

    try {
      await revokeApiKey(keyId);
      if (!this.isAccountRequestCurrent(request)) return;
      trackApiAction('key-revoked');
      await this.loadApiKeys();
    } catch (err) {
      if (!this.isAccountRequestCurrent(request)) return;
      this.apiKeysError = err instanceof Error ? err.message : 'Failed to revoke key';
      this.renderApiKeysError();
    }
  }

  private showCreatedBanner(key: string): void {
    const banner = this.overlay.querySelector<HTMLElement>('#usApiKeysBanner');
    if (!banner) return;

    banner.style.display = 'block';
    setTrustedHtml(banner, trustedHtml(`
      <div class="api-keys-banner-title">Key created — copy it now, it won't be shown again</div>
      <div class="api-keys-banner-key">
        <code class="api-keys-key-value">${escapeHtml(key)}</code>
        <button class="btn btn-secondary api-keys-copy-btn">Copy</button>
      </div>
    `, "legacy direct innerHTML migration"));
  }

  private hideBanner(): void {
    const banner = this.overlay.querySelector<HTMLElement>('#usApiKeysBanner');
    if (banner) {
      banner.style.display = 'none';
      setTrustedHtml(banner, trustedHtml('', "legacy direct innerHTML migration"));
    }
  }

  private renderApiKeysError(): void {
    const el = this.overlay.querySelector<HTMLElement>('#usApiKeysError');
    if (!el) return;
    if (this.apiKeysError) {
      el.style.display = 'block';
      el.textContent = this.apiKeysError;
    } else {
      el.style.display = 'none';
      el.textContent = '';
    }
  }

  private renderApiKeysList(): void {
    const container = this.overlay.querySelector('#usApiKeysList');
    if (!container) return;

    if (this.apiKeysLoading && this.apiKeys.length === 0) {
      setTrustedHtml(container, trustedHtml('<div class="api-keys-loading">Loading...</div>', "legacy direct innerHTML migration"));
      return;
    }

    this.renderApiKeysError();

    const active = this.apiKeys.filter(k => !k.revokedAt);
    const revoked = this.apiKeys.filter(k => k.revokedAt);

    if (active.length === 0 && revoked.length === 0) {
      setTrustedHtml(container, trustedHtml('<div class="api-keys-empty">No API keys yet. Create one above to get started.</div>', "legacy direct innerHTML migration"));
      return;
    }

    const formatDate = (ts: number) => new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

    const renderKey = (k: ApiKeyInfo) => {
      const isRevoked = !!k.revokedAt;
      return `
        <div class="api-keys-item${isRevoked ? ' revoked' : ''}">
          <div class="api-keys-item-main">
            <span class="api-keys-item-name">${escapeHtml(k.name)}</span>
            <code class="api-keys-item-prefix">${escapeHtml(k.keyPrefix)}${'*'.repeat(8)}</code>
          </div>
          <div class="api-keys-item-meta">
            <span>Created ${formatDate(k.createdAt)}</span>
            ${k.lastUsedAt ? `<span>Last used ${formatDate(k.lastUsedAt)}</span>` : ''}
            ${isRevoked ? `<span class="api-keys-item-revoked-badge">Revoked ${formatDate(k.revokedAt!)}</span>` : ''}
          </div>
          ${!isRevoked ? `<button class="btn btn-ghost api-keys-revoke-btn" data-key-id="${escapeHtml(k.id)}">Revoke</button>` : ''}
        </div>
      `;
    };

    setTrustedHtml(container, trustedHtml(active.map(renderKey).join('')
      + (revoked.length > 0 ? `<div class="api-keys-revoked-section"><div class="api-keys-revoked-label">Revoked</div>${revoked.map(renderKey).join('')}</div>` : ''), "legacy direct innerHTML migration"));
  }

  // ---------------------------------------------------------------------------
  // Connected MCP clients tab (plan 2026-05-10-001 U9)
  //
  // Distinct from the API Keys tab above (gated on `apiAccess`). This tab is
  // gated on `mcpAccess` so Pro users (where `apiAccess === false`) see ONLY
  // this tab. API Starter+ users (`apiAccess && mcpAccess`) see BOTH tabs;
  // they manage independent surfaces (manual API keys vs auto-issued OAuth
  // tokens for Claude Desktop / Cursor / etc).
  // ---------------------------------------------------------------------------

  private renderMcpClientsContent(): string {
    const authState = getAuthState();

    if (!authState.user) {
      const lockIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>`;
      return `
        <div class="panel-locked-state">
          <div class="panel-locked-icon">${lockIcon}</div>
          <div class="panel-locked-desc">Sign in to manage connected MCP clients</div>
        </div>`;
    }

    if (!hasFeature('mcpAccess')) {
      // Defensive — if the user lost mcpAccess (subscription lapsed) but the
      // tab was still rendered, show an upgrade CTA. Normal flow hides the
      // tab entirely.
      const upgradeIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="16 12 12 8 8 12"/><line x1="12" y1="16" x2="12" y2="8"/></svg>`;
      return `
        <div class="panel-locked-state">
          <div class="panel-locked-icon">${upgradeIcon}</div>
          <div class="panel-locked-desc">Connect Claude Desktop and other AI clients to your WorldMonitor account.</div>
        </div>`;
    }

    return `
      <div class="mcp-clients-section">
        <div data-plan-limit-notices>${this.renderPlanLimitNotices()}</div>
        <div class="mcp-clients-header">
          <p class="mcp-clients-desc">Connect Claude Desktop, Cursor, and other AI clients to your WorldMonitor account. Each client gets its own credential — revoke any time.</p>
        </div>
        <div class="mcp-clients-quota" id="usMcpQuota" aria-live="polite">${this.renderMcpQuotaText()}</div>
        <div class="mcp-clients-error" id="usMcpClientsError" style="display:none;"></div>
        <div class="mcp-clients-list" id="usMcpClientsList">
          <div class="mcp-clients-loading">Loading...</div>
        </div>
      </div>`;
  }

  private renderMcpQuotaText(): string {
    const q = this.mcpQuota;
    if (!q) {
      return `<span class="mcp-clients-quota-loading">Loading quota...</span>`;
    }
    const reset = this.formatQuotaReset(q.resetsAt);
    // `limit: null` = unlimited plan (Enterprise) — there is no denominator to
    // show, so the counter reads "120 / unlimited".
    const limitLabel = q.limit === null ? 'unlimited' : String(q.limit);
    return `<span class="mcp-clients-quota-label">MCP daily quota:</span>
      <strong>${q.used} / ${limitLabel}</strong>
      <span class="mcp-clients-quota-reset">used today, resets ${escapeHtml(reset)}</span>`;
  }

  private formatQuotaReset(iso: string): string {
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) return 'at next UTC midnight';
    const ms = ts - Date.now();
    if (ms <= 0) return 'momentarily';
    const totalSec = Math.floor(ms / 1000);
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    if (hrs > 0) return `in ${hrs}h ${mins}m`;
    if (mins > 0) return `in ${mins}m`;
    return 'in under a minute';
  }

  private async loadMcpClients(): Promise<void> {
    const request = this.captureAccountRequest();
    if (!request || this.mcpClientsLoading) return;
    this.mcpClientsLoading = true;
    this.mcpClientsError = '';
    this.renderMcpClientsList();

    try {
      const clients = await listMcpClients();
      if (!this.isAccountRequestCurrent(request)) return;
      this.mcpClients = clients;
    } catch (err) {
      if (!this.isAccountRequestCurrent(request)) return;
      this.mcpClientsError = err instanceof Error ? err.message : 'Failed to load MCP clients';
    } finally {
      if (this.isAccountRequestCurrent(request)) {
        this.mcpClientsLoading = false;
        this.renderMcpClientsList();
      }
    }

    // Kick a fresh quota fetch alongside the list so the user sees current
    // numbers immediately on tab open (the polling timer takes 30s otherwise).
    if (this.isAccountRequestCurrent(request)) void this.refreshMcpQuota();
  }

  private async refreshMcpQuota(): Promise<void> {
    const request = this.captureAccountRequest();
    if (!request) return;
    try {
      const quota = await fetchMcpQuota();
      if (!this.isAccountRequestCurrent(request)) return;
      this.mcpQuota = quota;
    } catch {
      if (!this.isAccountRequestCurrent(request)) return;
      // fetchMcpQuota already returns sane fallbacks, but defensive catch.
      this.mcpQuota = null;
    }
    if (this.isAccountRequestCurrent(request)) this.renderMcpQuotaInPlace();
  }

  private renderMcpQuotaInPlace(): void {
    const el = this.overlay.querySelector<HTMLElement>('#usMcpQuota');
    if (el) setTrustedHtml(el, trustedHtml(this.renderMcpQuotaText(), "legacy direct innerHTML migration"));
  }

  /**
   * Auto-refresh the quota counter every 30s while the tab is visible.
   * Cleared on tab-switch, close(), and destroy() — see stopMcpQuotaPolling.
   */
  private startMcpQuotaPolling(): void {
    if (this.mcpQuotaTimer) return; // idempotent
    this.mcpQuotaTimer = setInterval(() => {
      // Skip silently if the tab is no longer visible — can happen if the
      // overlay was hidden via display:none rather than full destroy().
      if (this.activeTab !== 'mcp-clients') return;
      void this.refreshMcpQuota();
    }, 30_000);
  }

  private stopMcpQuotaPolling(): void {
    if (this.mcpQuotaTimer) {
      clearInterval(this.mcpQuotaTimer);
      this.mcpQuotaTimer = null;
    }
  }

  private async handleRevokeMcpClient(tokenId: string): Promise<void> {
    const request = this.captureAccountRequest();
    if (!request) return;
    const client = this.mcpClients.find(c => c.id === tokenId);
    const label = client?.name?.trim() ? `"${client.name}"` : 'this client';
    if (!confirm(`Revoke ${label}? The connected AI client will need to re-authorize before its next request.`)) return;

    try {
      await revokeMcpClient(tokenId);
      if (!this.isAccountRequestCurrent(request)) return;
      // Refresh both list (Convex query result cached locally) and quota
      // (revoke does not change the daily counter, but the user might have
      // crossed the boundary while the modal was open).
      await this.loadMcpClients();
    } catch (err) {
      if (!this.isAccountRequestCurrent(request)) return;
      this.mcpClientsError = err instanceof Error ? err.message : 'Failed to revoke MCP client';
      this.renderMcpClientsError();
    }
  }

  private renderMcpClientsError(): void {
    const el = this.overlay.querySelector<HTMLElement>('#usMcpClientsError');
    if (!el) return;
    if (this.mcpClientsError) {
      el.style.display = 'block';
      el.textContent = this.mcpClientsError;
    } else {
      el.style.display = 'none';
      el.textContent = '';
    }
  }

  private renderMcpClientsList(): void {
    const container = this.overlay.querySelector('#usMcpClientsList');
    if (!container) return;

    if (this.mcpClientsLoading && this.mcpClients.length === 0) {
      setTrustedHtml(container, trustedHtml('<div class="mcp-clients-loading">Loading...</div>', "legacy direct innerHTML migration"));
      return;
    }

    this.renderMcpClientsError();

    const active = this.mcpClients.filter(c => !c.revokedAt);
    const revoked = this.mcpClients.filter(c => c.revokedAt);

    if (active.length === 0 && revoked.length === 0) {
      const mcpUrl = 'https://api.worldmonitor.app/mcp';
      setTrustedHtml(container, trustedHtml(`
        <div class="mcp-clients-empty">
          <div class="mcp-clients-empty-title">No connected MCP clients yet</div>
          <div class="mcp-clients-empty-desc">To connect Claude Desktop or another AI client, paste this URL into the client's MCP server settings and sign in with your WorldMonitor Pro account:</div>
          <div class="mcp-clients-empty-url">
            <code>${escapeHtml(mcpUrl)}</code>
            <button class="btn btn-secondary mcp-clients-copy-url-btn" data-copy-value="${escapeHtml(mcpUrl)}">Copy URL</button>
          </div>
        </div>`, "legacy direct innerHTML migration"));
      return;
    }

    const formatDate = (ts: number) => new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    const formatRelative = (ts: number): string => {
      const ms = Date.now() - ts;
      const sec = Math.floor(ms / 1000);
      if (sec < 60) return 'just now';
      const min = Math.floor(sec / 60);
      if (min < 60) return `${min}m ago`;
      const hrs = Math.floor(min / 60);
      if (hrs < 24) return `${hrs}h ago`;
      return formatDate(ts);
    };

    const renderClient = (c: McpClientInfo) => {
      const isRevoked = !!c.revokedAt;
      const name = c.name?.trim() || 'Connected MCP client';
      const lastUsed = c.lastUsedAt ? formatRelative(c.lastUsedAt) : 'never';
      return `
        <div class="mcp-clients-item${isRevoked ? ' revoked' : ''}">
          <div class="mcp-clients-item-main">
            <span class="mcp-clients-item-name">${escapeHtml(name)}</span>
          </div>
          <div class="mcp-clients-item-meta">
            <span>Connected ${formatDate(c.createdAt)}</span>
            <span>Last used ${escapeHtml(lastUsed)}</span>
            ${isRevoked ? `<span class="mcp-clients-item-revoked-badge">Revoked ${formatDate(c.revokedAt!)}</span>` : ''}
          </div>
          ${!isRevoked ? `<button class="btn btn-ghost mcp-clients-revoke-btn" data-token-id="${escapeHtml(c.id)}">Revoke</button>` : ''}
        </div>
      `;
    };

    setTrustedHtml(container, trustedHtml(active.map(renderClient).join('')
      + (revoked.length > 0 ? `<div class="mcp-clients-revoked-section"><div class="mcp-clients-revoked-label">Revoked</div>${revoked.map(renderClient).join('')}</div>` : ''), "legacy direct innerHTML migration"));
  }
}
