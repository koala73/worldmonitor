import '@/styles/settings-window.css';
import { FEEDS, INTEL_SOURCES, SOURCE_REGION_MAP } from '@/config/feeds';
import { PANEL_CATEGORY_MAP, ALL_PANELS, VARIANT_DEFAULTS, getEffectivePanelConfig, isPanelEntitled, FREE_MAX_PANELS } from '@/config/panels';
import { isProUser } from '@/services/widget-store';
import { SITE_VARIANT } from '@/config/variant';
import { t } from '@/services/i18n';
import type { MapProvider } from '@/config/basemap';
import { escapeHtml } from '@/utils/sanitize';
import type { PanelConfig } from '@/types';
import { renderPreferences } from '@/services/preferences-content';
import { renderNotificationsSettings, type NotificationsSettingsResult } from '@/services/notifications-settings';
import { getAuthState } from '@/services/auth-state';
import { track } from '@/services/analytics';
import { isEntitled, hasFeature, onEntitlementChange, getEntitlementState } from '@/services/entitlements';
import { hasPremiumAccess } from '@/services/panel-gating';
import { getSubscription, openBillingPortal, prereserveBillingPortalTab } from '@/services/billing';
import { createApiKey, listApiKeys, revokeApiKey, type ApiKeyInfo } from '@/services/api-keys';

function showToast(msg: string): void {
  document.querySelector('.toast-notification')?.remove();
  const el = document.createElement('div');
  el.className = 'toast-notification';
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('visible'));
  setTimeout(() => { el.classList.remove('visible'); setTimeout(() => el.remove(), 300); }, 4000);
}

const GEAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

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
}

type TabId = 'settings' | 'panels' | 'sources' | 'notifications' | 'api-keys';

export class UnifiedSettings {
  private overlay: HTMLElement;
  private config: UnifiedSettingsConfig;
  private activeTab: TabId = 'settings';
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
  private apiKeys: ApiKeyInfo[] = [];
  private apiKeysLoading = false;
  private apiKeysError = '';
  private newlyCreatedKey: string | null = null;
  private unsubscribeEntitlement: (() => void) | null = null;
  // Bounded "entitlement snapshot might still arrive" window. Starts false
  // on open() when currentState is null, flips true on first snapshot OR
  // after a fallback timeout so signed-in free users aren't stranded on an
  // empty placeholder when Convex is disabled / auth times out / init
  // silently fails (all of which leave currentState === null forever — see
  // src/services/entitlements.ts:41,47,58,78).
  private entitlementReady = false;
  private entitlementReadyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: UnifiedSettingsConfig) {
    this.config = config;

    this.overlay = document.createElement('div');
    this.overlay.className = 'modal-overlay';
    this.overlay.id = 'unifiedSettingsModal';
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-label', t('header.settings'));

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

      if (target.closest('.manage-billing-btn')) {
        // Pre-reserve the portal tab synchronously inside the click
        // handler so the popup blocker doesn't suppress the eventual
        // window.open inside openBillingPortal (which runs after an
        // await of the Convex action).
        const reservedWin = prereserveBillingPortalTab();
        void openBillingPortal(reservedWin);
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
          window.open('/pro', '_blank');
          return;
        }
        this.toggleDraftPanel(panelItem.dataset.panel);
        return;
      }

      const sourceItem = target.closest<HTMLElement>('.source-toggle-item');
      if (sourceItem?.dataset.source) {
        this.config.toggleSource(sourceItem.dataset.source);
        this.renderSourcesGrid();
        this.updateSourcesCounter();
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
  }

  public open(tab?: TabId): void {
    if (tab) this.activeTab = tab;
    this.resetPanelDraft();
    // Seed entitlementReady BEFORE render() so the first paint of
    // renderUpgradeSection branches on the current snapshot state, not the
    // stale value left over from a previous open/close cycle.
    this.entitlementReady = getEntitlementState() !== null;
    this.render();
    this.overlay.classList.add('active');
    localStorage.setItem('wm-settings-open', '1');
    document.addEventListener('keydown', this.escapeHandler);
    track('settings-open', { tab: tab ?? 'default' });

    // Re-render API Keys panel when entitlements arrive (cold-load race:
    // hasFeature('apiAccess') returns false until the Convex subscription
    // delivers data, so a paid API Starter user sees the upgrade CTA briefly).
    this.unsubscribeEntitlement?.();
    this.unsubscribeEntitlement = onEntitlementChange(() => {
      this.entitlementReady = true;
      const panel = this.overlay.querySelector<HTMLElement>('[data-panel-id="api-keys"]');
      if (panel) {
        panel.innerHTML = this.renderApiKeysContent();
        // Re-attach CTA and input handlers for the refreshed content
        this.attachApiKeysHandlers();
        if (this.activeTab === 'api-keys' && getAuthState().user && hasFeature('apiAccess')) {
          void this.loadApiKeys();
        }
      }
      this.replaceUpgradeSection();
    });
    // Bounded fallback: the entitlement listener can legitimately never
    // fire (no VITE_CONVEX_URL, Convex API fails to load, waitForConvexAuth
    // times out at 10s, or init throws — see entitlements.ts:41,47,58,78).
    // Without this timer, the signed-in-free branch of renderUpgradeSection
    // would show a blank placeholder for the entire session. 12s > the 10s
    // auth timeout so the healthy-but-slow path lands on the real state;
    // any later path falls back to "Upgrade to Pro" with handleUpgradeClick
    // defensively re-checking isEntitled() at click time.
    if (this.entitlementReadyTimer) clearTimeout(this.entitlementReadyTimer);
    if (!this.entitlementReady) {
      this.entitlementReadyTimer = setTimeout(() => {
        this.entitlementReadyTimer = null;
        if (this.entitlementReady) return;
        this.entitlementReady = true;
        this.replaceUpgradeSection();
      }, 12_000);
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
    fresh.innerHTML = this.renderUpgradeSection().trim();
    const next = fresh.content.firstElementChild;
    if (next) upgradeSection.replaceWith(next);
  }

  public close(): void {
    if (this.hasPendingPanelChanges() && !confirm(t('header.unsavedChanges'))) return;
    this.overlay.classList.remove('active');
    this.prefsCleanup?.();
    this.prefsCleanup = null;
    this.notifCleanup?.();
    this.notifCleanup = null;
    this.pendingNotifs = null;
    this.unsubscribeEntitlement?.();
    this.unsubscribeEntitlement = null;
    if (this.entitlementReadyTimer) {
      clearTimeout(this.entitlementReadyTimer);
      this.entitlementReadyTimer = null;
    }
    this.resetPanelDraft();
    localStorage.removeItem('wm-settings-open');
    document.removeEventListener('keydown', this.escapeHandler);
  }

  public refreshPanelToggles(): void {
    this.resetPanelDraft();
    if (this.activeTab === 'panels') this.renderPanelsTab();
  }

  public getButton(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'unified-settings-btn';
    btn.id = 'unifiedSettingsBtn';
    btn.setAttribute('aria-label', t('header.settings'));
    btn.innerHTML = GEAR_SVG;
    btn.addEventListener('click', () => this.open());
    return btn;
  }

  public destroy(): void {
    if (this.savedTimeout) clearTimeout(this.savedTimeout);
    this.prefsCleanup?.();
    this.prefsCleanup = null;
    this.notifCleanup?.();
    this.notifCleanup = null;
    this.pendingNotifs = null;
    this.unsubscribeEntitlement?.();
    this.unsubscribeEntitlement = null;
    // Mirror close() — without this, a destroy() during the 12s fallback
    // window leaves the timer live; it fires after teardown and calls
    // replaceUpgradeSection() against a detached overlay (no-op via the
    // querySelector early return, but a stray async callback + DOM
    // reference alive longer than intended).
    if (this.entitlementReadyTimer) {
      clearTimeout(this.entitlementReadyTimer);
      this.entitlementReadyTimer = null;
    }
    document.removeEventListener('keydown', this.escapeHandler);
    this.overlay.remove();
  }

  private render(): void {
    this.prefsCleanup?.();
    this.prefsCleanup = null;
    this.notifCleanup?.();
    this.notifCleanup = null;
    this.pendingNotifs = null;

    const tabClass = (id: TabId) => `unified-settings-tab${this.activeTab === id ? ' active' : ''}`;
    const isSignedIn = !this.config.isDesktopApp && (getAuthState().user !== null);
    const prefs = renderPreferences({
      isDesktopApp: this.config.isDesktopApp,
      onMapProviderChange: this.config.onMapProviderChange,
      isSignedIn,
    });
    const showNotificationsTab = !this.config.isDesktopApp;
    const notifs = showNotificationsTab
      ? renderNotificationsSettings({ isSignedIn })
      : null;

    this.overlay.innerHTML = `
      <div class="modal unified-settings-modal">
        <div class="modal-header">
          <span class="modal-title">${t('header.settings')}</span>
          <button class="modal-close unified-settings-close" aria-label="Close">\u00d7</button>
        </div>
        <div class="unified-settings-tabs" role="tablist" aria-label="Settings">
          <button class="${tabClass('settings')}" data-tab="settings" role="tab" aria-selected="${this.activeTab === 'settings'}" id="us-tab-settings" aria-controls="us-tab-panel-settings">${t('header.tabSettings')}</button>
          <button class="${tabClass('panels')}" data-tab="panels" role="tab" aria-selected="${this.activeTab === 'panels'}" id="us-tab-panels" aria-controls="us-tab-panel-panels">${t('header.tabPanels')}</button>
          <button class="${tabClass('sources')}" data-tab="sources" role="tab" aria-selected="${this.activeTab === 'sources'}" id="us-tab-sources" aria-controls="us-tab-panel-sources">${t('header.tabSources')}</button>
          ${showNotificationsTab ? `<button class="${tabClass('notifications')}" data-tab="notifications" role="tab" aria-selected="${this.activeTab === 'notifications'}" id="us-tab-notifications" aria-controls="us-tab-panel-notifications">${t('header.tabNotifications')}</button>` : ''}
          <button class="${tabClass('api-keys')}" data-tab="api-keys" role="tab" aria-selected="${this.activeTab === 'api-keys'}" id="us-tab-api-keys" aria-controls="us-tab-panel-api-keys">API Keys <span class="panel-pro-badge">PRO</span></button>
        </div>
        <div class="unified-settings-tab-panel${this.activeTab === 'settings' ? ' active' : ''}" data-panel-id="settings" id="us-tab-panel-settings" role="tabpanel" aria-labelledby="us-tab-settings">
          ${prefs.html}
          ${this.renderUpgradeSection()}
        </div>
        <div class="unified-settings-tab-panel${this.activeTab === 'panels' ? ' active' : ''}" data-panel-id="panels" id="us-tab-panel-panels" role="tabpanel" aria-labelledby="us-tab-panels">
          <div class="unified-settings-region-wrapper">
            <div class="unified-settings-region-bar" id="usPanelCatBar"></div>
          </div>
          <div class="panels-search">
            <input type="text" placeholder="${t('header.filterPanels')}" value="${escapeHtml(this.panelFilter)}" />
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
          <div class="sources-search">
            <input type="text" placeholder="${t('header.filterSources')}" value="${escapeHtml(this.sourceFilter)}" />
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
      </div>
    `;

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

    this.renderPanelCategoryPills();
    this.renderPanelsTab();
    this.renderRegionPills();
    this.renderSourcesGrid();
    this.updateSourcesCounter();

    this.attachApiKeysHandlers();
    if (this.activeTab === 'api-keys' && getAuthState().user && hasFeature('apiAccess')) {
      void this.loadApiKeys();
    }
  }

  private switchTab(tab: TabId): void {
    this.activeTab = tab;

    this.overlay.querySelectorAll('.unified-settings-tab').forEach(el => {
      const isActive = (el as HTMLElement).dataset.tab === tab;
      el.classList.toggle('active', isActive);
      el.setAttribute('aria-selected', String(isActive));
    });

    this.overlay.querySelectorAll('.unified-settings-tab-panel').forEach(el => {
      el.classList.toggle('active', (el as HTMLElement).dataset.panelId === tab);
    });

    if (tab === 'api-keys' && getAuthState().user && hasFeature('apiAccess')) {
      void this.loadApiKeys();
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

  private renderUpgradeSection(): string {
    // Non-Dodo premium (API key / tester key / Clerk pro role without a
    // Convex subscription): neither "Upgrade" nor "Manage Billing" is
    // actionable. Checked FIRST so these users don't get stuck on the
    // loading placeholder below — their Convex entitlement snapshot may
    // never arrive at all.
    if (!isEntitled() && hasPremiumAccess()) {
      return '<div class="upgrade-pro-section upgrade-pro-hidden" hidden></div>';
    }
    // Signed-in user whose Convex entitlement snapshot has not arrived yet
    // AND whose bounded-wait window has not expired. Rendering "Upgrade to
    // Pro" in this window is how paying users click through to
    // /api/create-checkout and hit 409 duplicate_subscription — same race
    // as the 2026-04-17/18 panel-overlay incident fixed in panel-gating.ts,
    // different surface. The entitlementReady flag is flipped either by
    // the onEntitlementChange listener (healthy path) or by a 12s fallback
    // timer in open() (Convex-disabled / auth-timeout / init-fail paths
    // where currentState would otherwise stay null forever and strand a
    // signed-in free user on an empty placeholder).
    if (!this.entitlementReady && getAuthState().user && getEntitlementState() === null) {
      // `hidden` so the browser's default `[hidden] { display: none }`
      // suppresses the empty card — without it, the base `.upgrade-pro-
      // section` styles (margin + padding + border + surface background
      // in main.css:22833) paint a visibly empty bordered box during the
      // Convex cold-load window, which is exactly the state we're trying
      // to clean up. Element stays queryable for the replaceWith swap in
      // open().
      return '<div class="upgrade-pro-section upgrade-pro-loading" hidden aria-hidden="true"></div>';
    }
    if (isEntitled()) {
      const sub = getSubscription();
      const planName = sub?.displayName ?? 'Pro';
      const statusColor = sub?.status === 'active' ? '#22c55e' : sub?.status === 'on_hold' ? '#eab308' : '#ef4444';
      const statusBorderColor = sub?.status === 'active' ? '#22c55e33' : sub?.status === 'on_hold' ? '#eab30833' : '#ef444433';
      const statusBgColor = sub?.status === 'active' ? '#22c55e0a' : sub?.status === 'on_hold' ? '#eab3080a' : '#ef44440a';

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
        }
      }

      return `
        <div class="upgrade-pro-section upgrade-pro-active" style="margin-top:16px;padding:14px 16px;border:1px solid ${statusBorderColor};border-radius:6px;background:${statusBgColor};">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:${statusLine ? '8' : '0'}px;">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${statusColor};flex-shrink:0;"></span>
            <span style="color:${statusColor};font-weight:600;font-size:13px;">${escapeHtml(planName)}</span>
          </div>
          ${statusLine ? `<div class="upgrade-pro-status-line">${escapeHtml(statusLine)}</div>` : ''}
          <button class="manage-billing-btn">Manage Billing</button>
        </div>
      `;
    }

    // Fallback branch: 12s timer fired but Convex never delivered a
    // snapshot. entitlementReady===true does NOT prove the user is free —
    // it just means we've given up waiting. A paying user whose auth/query
    // is simply very slow (beyond the 10s waitForConvexAuth timeout) would
    // otherwise race into in-modal startCheckout here and reproduce the
    // 409 duplicate_subscription cascade this PR exists to eliminate.
    // Render the card with a plain anchor to /pro instead: /pro has its
    // own entitlement gating on fresh page load, and navigating away is a
    // no-op for backend subscription state. The `upgrade-pro-cta-link`
    // class does NOT match the `.upgrade-pro-cta` delegated click handler
    // (line ~95), so the browser handles the navigation natively.
    if (getAuthState().user && getEntitlementState() === null) {
      return `
        <div class="upgrade-pro-section upgrade-pro-fallback">
          <div class="upgrade-pro-title">Upgrade to Pro</div>
          <div class="upgrade-pro-desc">Unlock all panels, AI analysis, and priority data refresh.</div>
          <a class="upgrade-pro-cta-link" href="/pro" target="_blank" rel="noopener">View plans →</a>
        </div>
      `;
    }

    return `
      <div class="upgrade-pro-section">
        <div class="upgrade-pro-title">Upgrade to Pro</div>
        <div class="upgrade-pro-desc">Unlock all panels, AI analysis, and priority data refresh.</div>
        <button class="upgrade-pro-cta">Upgrade to Pro</button>
      </div>
    `;
  }

  private handleUpgradeClick(): void {
    // Defense in depth: the upgrade CTA can only be clicked when either (a)
    // the user is genuinely free-tier, or (b) the 12s fallback timer fired
    // before the Convex snapshot arrived. In (b), the snapshot might land
    // AFTER the timer but BEFORE the click — re-check isEntitled() here so
    // a late-arriving "you're a paying user" state routes to the billing
    // portal instead of triggering /api/create-checkout against an active
    // subscription (which would 409 and re-enter the duplicate_subscription
    // → getCustomerPortalUrl cascade this PR is trying to eliminate).
    if (isEntitled()) {
      this.close();
      const reservedWin = prereserveBillingPortalTab();
      void openBillingPortal(reservedWin);
      return;
    }
    this.close();
    if (this.config.isDesktopApp) {
      window.open('https://worldmonitor.app/pro', '_blank');
      return;
    }
    import('@/services/checkout').then(m => import('@/config/products').then(p => m.startCheckout(p.DEFAULT_UPGRADE_PRODUCT))).catch(() => {
      window.open('https://worldmonitor.app/pro', '_blank');
    });
  }

  private categoryMatchesVariant(catDef: { variants?: string[] }): boolean {
    return !catDef.variants || catDef.variants.includes(SITE_VARIANT);
  }

  private getAvailablePanelCategories(): Array<{ key: string; label: string }> {
    const settings = this.config.getPanelSettings();
    const categories: Array<{ key: string; label: string }> = [
      { key: 'all', label: t('header.sourceRegionAll') }
    ];

    for (const [catKey, catDef] of Object.entries(PANEL_CATEGORY_MAP)) {
      if (!this.categoryMatchesVariant(catDef)) continue;
      const hasEnabledPanel = catDef.panelKeys.some(pk => settings[pk]?.enabled);
      if (hasEnabledPanel) {
        categories.push({ key: catKey, label: t(catDef.labelKey) });
      }
    }

    return categories;
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
    bar.innerHTML = categories.map(c =>
      `<button class="unified-settings-region-pill${this.activePanelCategory === c.key ? ' active' : ''}" data-panel-cat="${c.key}">${escapeHtml(c.label)}</button>`
    ).join('');
  }

  private renderPanelsTab(): void {
    const container = this.overlay.querySelector('#usPanelToggles');
    if (!container) return;

    const savedSettings = this.config.getPanelSettings();
    const pro = isProUser();
    const entries = this.getVisiblePanelEntries();
    container.innerHTML = entries.map(([key, panel]) => {
      const entitled = isPanelEntitled(key, ALL_PANELS[key] ?? panel, pro);
      const locked = !entitled;
      const changed = !locked && savedSettings[key]?.enabled !== panel.enabled;
      const displayName = this.config.getLocalizedPanelName(key, getEffectivePanelConfig(key, SITE_VARIANT).name ?? panel.name);
      return `
        <div class="panel-toggle-item ${panel.enabled && !locked ? 'active' : ''}${changed ? ' changed' : ''}${locked ? ' pro-locked' : ''}" data-panel="${escapeHtml(key)}" aria-pressed="${panel.enabled && !locked}" ${locked ? 'data-pro-locked="1"' : ''}>
          <div class="panel-toggle-checkbox">${panel.enabled && !locked ? '\u2713' : ''}${locked ? '\uD83D\uDD12' : ''}</div>
          <span class="panel-toggle-label">${escapeHtml(displayName)}</span>
          ${(locked || (ALL_PANELS[key] ?? panel).premium) ? '<span class="panel-toggle-pro-badge">PRO</span>' : ''}
        </div>
      `;
    }).join('');

    this.updatePanelsFooter();
  }

  private clonePanelSettings(source: Record<string, PanelConfig> = this.config.getPanelSettings()): Record<string, PanelConfig> {
    const cloned: Record<string, PanelConfig> = Object.fromEntries(
      Object.entries(source).map(([key, panel]) => [key, { ...panel }]),
    );
    const variantDefaults = new Set(VARIANT_DEFAULTS[SITE_VARIANT] ?? []);
    for (const key of Object.keys(ALL_PANELS)) {
      if (!(key in cloned)) {
        cloned[key] = { ...getEffectivePanelConfig(key, SITE_VARIANT), enabled: variantDefaults.has(key) };
      }
    }
    return cloned;
  }

  private resetPanelDraft(): void {
    this.draftPanelSettings = this.clonePanelSettings();
    this.panelsJustSaved = false;
  }

  private hasPendingPanelChanges(): boolean {
    const savedSettings = this.config.getPanelSettings();
    return Object.entries(this.draftPanelSettings).some(([key, panel]) => savedSettings[key]?.enabled !== panel.enabled);
  }

  private toggleDraftPanel(key: string): void {
    const panel = this.draftPanelSettings[key];
    if (!panel) return;
    if (!panel.enabled && !isPanelEntitled(key, ALL_PANELS[key] ?? panel, isProUser())) return;
    if (!panel.enabled && !isProUser()) {
      const enabledCount = Object.entries(this.draftPanelSettings).filter(([k, p]) => p.enabled && !k.startsWith('cw-')).length;
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
    const feedKeys = new Set(Object.keys(FEEDS));
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
      const hasFeeds = regionDef.feedKeys.some(fk => feedKeys.has(fk));
      if (hasFeeds) {
        regions.push({ key: regionKey, label: t(regionDef.labelKey) });
      }
    }

    return regions;
  }

  private getSourcesByRegion(): Map<string, string[]> {
    const map = new Map<string, string[]>();
    const feedKeys = new Set(Object.keys(FEEDS));

    for (const [regionKey, regionDef] of Object.entries(SOURCE_REGION_MAP)) {
      const sources: string[] = [];
      if (regionKey === 'intel') {
        INTEL_SOURCES.forEach(f => sources.push(f.name));
      } else {
        for (const fk of regionDef.feedKeys) {
          if (feedKeys.has(fk)) {
            FEEDS[fk]!.forEach(f => sources.push(f.name));
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
    bar.innerHTML = regions.map(r =>
      `<button class="unified-settings-region-pill${this.activeSourceRegion === r.key ? ' active' : ''}" data-region="${r.key}">${escapeHtml(r.label)}</button>`
    ).join('');
  }

  private renderSourcesGrid(): void {
    const container = this.overlay.querySelector('#usSourceToggles');
    if (!container) return;

    const sources = this.getVisibleSourceNames();
    const disabled = this.config.getDisabledSources();

    container.innerHTML = sources.map(source => {
      const isEnabled = !disabled.has(source);
      const escaped = escapeHtml(source);
      return `
        <div class="source-toggle-item ${isEnabled ? 'active' : ''}" data-source="${escaped}">
          <div class="source-toggle-checkbox">${isEnabled ? '\u2713' : ''}</div>
          <span class="source-toggle-label">${escaped}</span>
        </div>
      `;
    }).join('');
  }

  private updateSourcesCounter(): void {
    const counter = this.overlay.querySelector('#usSourcesCounter');
    if (!counter) return;

    const disabled = this.config.getDisabledSources();
    const allSources = this.config.getAllSourceNames();
    const enabledTotal = allSources.length - disabled.size;

    counter.textContent = t('header.sourcesEnabled', { enabled: String(enabledTotal), total: String(allSources.length) });
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
            window.open('https://worldmonitor.app/pro', '_blank');
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
          <button class="panel-locked-cta api-keys-gate-btn">Upgrade to API Starter</button>
        </div>`;
    }

    return `
      <div class="api-keys-section">
        <div class="api-keys-header">
          <p class="api-keys-desc">Create API keys to access WorldMonitor data programmatically. Keys are shown once on creation — store them securely.</p>
        </div>
        <div class="api-keys-create-form">
          <input type="text" class="api-keys-name-input" placeholder="Key name (e.g. my-app)" maxlength="64" />
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
    this.apiKeysLoading = true;
    this.apiKeysError = '';
    this.renderApiKeysList();

    try {
      this.apiKeys = await listApiKeys();
    } catch (err) {
      this.apiKeysError = err instanceof Error ? err.message : 'Failed to load keys';
    } finally {
      this.apiKeysLoading = false;
      this.renderApiKeysList();
    }
  }

  private async handleCreateApiKey(): Promise<void> {
    const input = this.overlay.querySelector<HTMLInputElement>('.api-keys-name-input');
    const btn = this.overlay.querySelector<HTMLButtonElement>('.api-keys-create-btn');
    const name = input?.value.trim();
    if (!name || !input || !btn) return;

    btn.disabled = true;
    btn.textContent = 'Creating...';
    this.apiKeysError = '';
    this.newlyCreatedKey = null;
    this.hideBanner();

    try {
      const result = await createApiKey(name);
      this.newlyCreatedKey = result.key;
      input.value = '';
      this.showCreatedBanner(result.key);
      await this.loadApiKeys();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create key';
      this.apiKeysError = msg.includes('KEY_LIMIT_REACHED')
        ? 'Maximum of 5 active keys reached. Revoke an existing key first.'
        : msg.includes('API_ACCESS_REQUIRED')
        ? 'API keys require an API access subscription (API Starter or higher).'
        : msg;
      this.renderApiKeysError();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Create Key';
    }
  }

  private async handleRevokeApiKey(keyId: string): Promise<void> {
    const keyInfo = this.apiKeys.find(k => k.id === keyId);
    const keyName = keyInfo?.name ?? 'this key';
    if (!confirm(`Revoke "${keyName}"? This cannot be undone. Any applications using this key will stop working.`)) return;

    try {
      await revokeApiKey(keyId);
      await this.loadApiKeys();
    } catch (err) {
      this.apiKeysError = err instanceof Error ? err.message : 'Failed to revoke key';
      this.renderApiKeysError();
    }
  }

  private showCreatedBanner(key: string): void {
    const banner = this.overlay.querySelector<HTMLElement>('#usApiKeysBanner');
    if (!banner) return;

    banner.style.display = 'block';
    banner.innerHTML = `
      <div class="api-keys-banner-title">Key created — copy it now, it won't be shown again</div>
      <div class="api-keys-banner-key">
        <code class="api-keys-key-value">${escapeHtml(key)}</code>
        <button class="btn btn-secondary api-keys-copy-btn">Copy</button>
      </div>
    `;
  }

  private hideBanner(): void {
    const banner = this.overlay.querySelector<HTMLElement>('#usApiKeysBanner');
    if (banner) {
      banner.style.display = 'none';
      banner.innerHTML = '';
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
      container.innerHTML = '<div class="api-keys-loading">Loading...</div>';
      return;
    }

    this.renderApiKeysError();

    const active = this.apiKeys.filter(k => !k.revokedAt);
    const revoked = this.apiKeys.filter(k => k.revokedAt);

    if (active.length === 0 && revoked.length === 0) {
      container.innerHTML = '<div class="api-keys-empty">No API keys yet. Create one above to get started.</div>';
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

    container.innerHTML = active.map(renderKey).join('')
      + (revoked.length > 0 ? `<div class="api-keys-revoked-section"><div class="api-keys-revoked-label">Revoked</div>${revoked.map(renderKey).join('')}</div>` : '');
  }
}
