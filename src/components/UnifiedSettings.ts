import { FEEDS, INTEL_SOURCES, SOURCE_REGION_MAP } from '@/config/feeds';
import { PANEL_CATEGORY_MAP } from '@/config/panels';
import { SITE_VARIANT } from '@/config/variant';
import { getCurrentLanguage, t } from '@/services/i18n';
import type { MapProvider } from '@/config/basemap';
import { escapeHtml } from '@/utils/sanitize';
import type { PanelConfig } from '@/types';
import { renderPreferences } from '@/services/preferences-content';

const DIGEST_VARIANT_CATEGORIES: Record<string, string[]> = {
  full: ['politics', 'us', 'europe', 'middleeast', 'asia', 'africa', 'latam', 'tech', 'ai', 'finance', 'energy', 'gov', 'thinktanks', 'intel', 'crisis'],
  tech: ['tech', 'ai', 'startups', 'security', 'github', 'funding', 'cloud', 'layoffs', 'finance'],
  finance: ['markets', 'forex', 'bonds', 'commodities', 'crypto', 'centralbanks', 'economic', 'ipo', 'fintech', 'regulation', 'analysis'],
  happy: ['positive', 'science'],
};

const DIGEST_FREQUENCIES = [
  { value: 'hourly', labelKey: 'digest.frequencyHourly' },
  { value: '2h', labelKey: 'digest.frequency2h' },
  { value: '6h', labelKey: 'digest.frequency6h' },
  { value: 'daily', labelKey: 'digest.frequencyDaily' },
  { value: 'weekly', labelKey: 'digest.frequencyWeekly' },
  { value: 'monthly', labelKey: 'digest.frequencyMonthly' },
] as const;

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

type TabId = 'settings' | 'panels' | 'sources' | 'digest';

export class UnifiedSettings {
  private overlay: HTMLElement;
  private config: UnifiedSettingsConfig;
  private activeTab: TabId = 'settings';
  private activeSourceRegion = 'all';
  private sourceFilter = '';
  private activePanelCategory = 'all';
  private panelFilter = '';
  private escapeHandler: (e: KeyboardEvent) => void;
  private digestEmail = '';
  private digestFrequency = 'daily';
  private digestCategories: Set<string> = new Set();
  private digestStatus: 'none' | 'pending' | 'confirmed' = 'none';
  private digestToken = '';
  private digestSubmitting = false;
  private prefsCleanup: (() => void) | null = null;
  private draftPanelSettings: Record<string, PanelConfig> = {};
  private panelsJustSaved = false;
  private savedTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(config: UnifiedSettingsConfig) {
    this.config = config;

    // Restore digest state from localStorage
    this.digestEmail = localStorage.getItem('wm-digest-email') || '';
    this.digestToken = localStorage.getItem('wm-digest-token') || '';
    const storedStatus = localStorage.getItem('wm-digest-status');
    this.digestStatus = (storedStatus === 'pending' || storedStatus === 'confirmed') ? storedStatus : 'none';
    this.digestFrequency = localStorage.getItem('wm-digest-frequency') || 'daily';
    const storedCats = localStorage.getItem('wm-digest-categories');
    const variant = SITE_VARIANT || 'full';
    const allCats = DIGEST_VARIANT_CATEGORIES[variant] || DIGEST_VARIANT_CATEGORIES.full;
    this.digestCategories = storedCats ? new Set(JSON.parse(storedCats)) : new Set(allCats);

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

      // Digest category pill toggle
      const digestPill = target.closest<HTMLElement>('.digest-category-pill');
      if (digestPill?.dataset.category) {
        const cat = digestPill.dataset.category;
        if (this.digestCategories.has(cat)) {
          this.digestCategories.delete(cat);
        } else {
          this.digestCategories.add(cat);
        }
        digestPill.classList.toggle('active');
        return;
      }

      // Digest subscribe button
      if (target.closest('.digest-subscribe-btn')) {
        void this.handleDigestSubscribe();
        return;
      }

      // Digest update button
      if (target.closest('.digest-update-btn')) {
        void this.handleDigestUpdate();
        return;
      }

      // Digest unsubscribe button
      if (target.closest('.digest-unsub-btn')) {
        void this.handleDigestUnsubscribe();
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
      } else if (target.id === 'digestEmailInput') {
        this.digestEmail = target.value;
        // Simple email validation feedback
        const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        target.classList.toggle('invalid', target.value.length > 0 && !emailRe.test(target.value));
      }
    });

    this.overlay.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement | HTMLSelectElement;

      if (target.id === 'digestFrequencySelect') {
        this.digestFrequency = target.value;
      }
    });
    this.render();
    document.body.appendChild(this.overlay);
  }

  public open(tab?: TabId): void {
    if (tab) this.activeTab = tab;
    this.resetPanelDraft();
    this.render();
    this.overlay.classList.add('active');
    localStorage.setItem('wm-settings-open', '1');
    document.addEventListener('keydown', this.escapeHandler);
  }

  public close(): void {
    if (this.hasPendingPanelChanges() && !confirm(t('header.unsavedChanges'))) return;
    this.overlay.classList.remove('active');
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
    document.removeEventListener('keydown', this.escapeHandler);
    this.overlay.remove();
  }

  private render(): void {
    this.prefsCleanup?.();
    this.prefsCleanup = null;

    const tabClass = (id: TabId) => `unified-settings-tab${this.activeTab === id ? ' active' : ''}`;
    const prefs = renderPreferences({
      isDesktopApp: this.config.isDesktopApp,
      onMapProviderChange: this.config.onMapProviderChange,
    });

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
          <button class="${tabClass('digest')}" data-tab="digest" role="tab" aria-selected="${this.activeTab === 'digest'}" id="us-tab-digest" aria-controls="us-tab-panel-digest">${t('header.tabDigest')}</button>
        </div>
        <div class="unified-settings-tab-panel${this.activeTab === 'settings' ? ' active' : ''}" data-panel-id="settings" id="us-tab-panel-settings" role="tabpanel" aria-labelledby="us-tab-settings">
          ${prefs.html}
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
        <div class="unified-settings-tab-panel${this.activeTab === 'digest' ? ' active' : ''}" data-panel-id="digest" id="us-tab-panel-digest" role="tabpanel" aria-labelledby="us-tab-digest">
          ${this.renderDigestContent()}
        </div>
      </div>
    `;

    const settingsPanel = this.overlay.querySelector('#us-tab-panel-settings');
    if (settingsPanel) {
      this.prefsCleanup = prefs.attach(settingsPanel as HTMLElement);
    }

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

    // When opening digest tab with pending status, check if confirmed
    if (tab === 'digest' && this.digestStatus === 'pending' && this.digestEmail) {
      void this.checkDigestConfirmation();
    }
  }

  private async checkDigestConfirmation(): Promise<void> {
    try {
      const resp = await fetch('/api/digest/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: this.digestEmail,
          frequency: this.digestFrequency,
          variant: SITE_VARIANT || 'full',
          lang: getCurrentLanguage(),
          categories: [...this.digestCategories],
        }),
      });
      const data = await resp.json();
      if (data.status === 'already_subscribed') {
        this.digestStatus = 'confirmed';
        this.digestToken = data.token;
        this.persistDigestState();
        // Re-render the digest panel content
        const panel = this.overlay.querySelector('[data-panel-id="digest"]');
        if (panel) panel.innerHTML = this.renderDigestContent();
      }
    } catch {
      // Silently ignore — will check again next time
    }
  }

  private getAvailablePanelCategories(): Array<{ key: string; label: string }> {
    const panelKeys = new Set(Object.keys(this.config.getPanelSettings()));
    const variant = SITE_VARIANT || 'full';
    const categories: Array<{ key: string; label: string }> = [
      { key: 'all', label: t('header.sourceRegionAll') }
    ];

    for (const [catKey, catDef] of Object.entries(PANEL_CATEGORY_MAP)) {
      if (catDef.variants && !catDef.variants.includes(variant)) continue;
      const hasPanel = catDef.panelKeys.some(pk => panelKeys.has(pk));
      if (hasPanel) {
        categories.push({ key: catKey, label: t(catDef.labelKey) });
      }
    }

    return categories;
  }

  private getVisiblePanelEntries(): Array<[string, PanelConfig]> {
    const panelSettings = this.draftPanelSettings;
    const variant = SITE_VARIANT || 'full';
    let entries = Object.entries(panelSettings)
      .filter(([key]) => key !== 'runtime-config' || this.config.isDesktopApp);

    if (this.activePanelCategory !== 'all') {
      const catDef = PANEL_CATEGORY_MAP[this.activePanelCategory];
      if (catDef && (!catDef.variants || catDef.variants.includes(variant))) {
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
    const entries = this.getVisiblePanelEntries();
    container.innerHTML = entries.map(([key, panel]) => {
      const changed = savedSettings[key]?.enabled !== panel.enabled;
      return `
        <div class="panel-toggle-item ${panel.enabled ? 'active' : ''}${changed ? ' changed' : ''}" data-panel="${escapeHtml(key)}" aria-pressed="${panel.enabled}">
          <div class="panel-toggle-checkbox">${panel.enabled ? '\u2713' : ''}</div>
          <span class="panel-toggle-label">${escapeHtml(this.config.getLocalizedPanelName(key, panel.name))}</span>
        </div>
      `;
    }).join('');

    this.updatePanelsFooter();
  }

  private clonePanelSettings(source: Record<string, PanelConfig> = this.config.getPanelSettings()): Record<string, PanelConfig> {
    return Object.fromEntries(
      Object.entries(source).map(([key, panel]) => [key, { ...panel }]),
    );
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
    panel.enabled = !panel.enabled;
    this.panelsJustSaved = false;
    this.renderPanelsTab();
  }

  private savePanelChanges(): void {
    if (!this.hasPendingPanelChanges()) return;
    this.config.savePanelSettings(this.clonePanelSettings(this.draftPanelSettings));
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

  private renderDigestContent(): string {
    const variant = SITE_VARIANT || 'full';
    const categories = DIGEST_VARIANT_CATEGORIES[variant] ?? DIGEST_VARIANT_CATEGORIES.full!;

    if (this.digestStatus === 'pending') {
      return `
        <div class="digest-form">
          <div class="digest-status pending">${t('digest.confirmPending')}</div>
          <div class="digest-description">${t('digest.description')}</div>
          <div class="digest-current">
            <div class="digest-current-row">
              <span class="digest-current-label">${t('digest.emailLabel')}</span>
              <span class="digest-current-value">${escapeHtml(this.digestEmail)}</span>
            </div>
          </div>
        </div>
      `;
    }

    if (this.digestStatus === 'confirmed') {
      const freqLabel = DIGEST_FREQUENCIES.find(f => f.value === this.digestFrequency);
      return `
        <div class="digest-form">
          <div class="digest-status success">${t('digest.subscribed', { frequency: freqLabel ? t(freqLabel.labelKey) : this.digestFrequency })}</div>
          <div class="digest-current">
            <div class="digest-current-row">
              <span class="digest-current-label">${t('digest.emailLabel')}</span>
              <span class="digest-current-value">${escapeHtml(this.digestEmail)}</span>
            </div>
          </div>

          <div class="digest-field-label">${t('digest.frequencyLabel')}</div>
          <select class="digest-frequency-select" id="digestFrequencySelect">
            ${DIGEST_FREQUENCIES.map(f =>
        `<option value="${f.value}"${this.digestFrequency === f.value ? ' selected' : ''}>${t(f.labelKey)}</option>`
      ).join('')}
          </select>

          <div class="digest-field-label">${t('digest.categoriesLabel')}</div>
          <div class="digest-category-pills">
            ${categories.map(cat =>
        `<button class="digest-category-pill${this.digestCategories.has(cat) ? ' active' : ''}" data-category="${escapeHtml(cat)}">${escapeHtml(cat)}</button>`
      ).join('')}
          </div>

          <button class="digest-submit-btn digest-update-btn">${t('digest.update')}</button>
          <button class="digest-submit-btn danger digest-unsub-btn">${t('digest.unsubscribe')}</button>
        </div>
      `;
    }

    // Default: unsubscribed state — show subscription form
    return `
      <div class="digest-form">
        <div class="digest-description">${t('digest.description')}</div>

        <div class="digest-field-label">${t('digest.emailLabel')}</div>
        <input type="email" class="digest-input" id="digestEmailInput"
          placeholder="${t('digest.emailPlaceholder')}" value="${escapeHtml(this.digestEmail)}" />

        <div class="digest-field-label">${t('digest.frequencyLabel')}</div>
        <select class="digest-frequency-select" id="digestFrequencySelect">
          ${DIGEST_FREQUENCIES.map(f =>
      `<option value="${f.value}"${this.digestFrequency === f.value ? ' selected' : ''}>${t(f.labelKey)}</option>`
    ).join('')}
        </select>

        <div class="digest-field-label">${t('digest.categoriesLabel')}</div>
        <div class="digest-category-pills">
          ${categories.map(cat =>
      `<button class="digest-category-pill${this.digestCategories.has(cat) ? ' active' : ''}" data-category="${escapeHtml(cat)}">${escapeHtml(cat)}</button>`
    ).join('')}
        </div>

        <button class="digest-submit-btn digest-subscribe-btn"${this.digestSubmitting ? ' disabled' : ''}>${t('digest.subscribe')}</button>
        <div class="digest-status-area" id="digestStatusArea"></div>
      </div>
    `;
  }

  private async handleDigestSubscribe(): Promise<void> {
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!this.digestEmail || !emailRe.test(this.digestEmail)) {
      this.showDigestStatus('error', t('digest.invalidEmail'));
      return;
    }

    this.digestSubmitting = true;
    const btn = this.overlay.querySelector<HTMLButtonElement>('.digest-subscribe-btn');
    if (btn) btn.disabled = true;

    try {
      const variant = SITE_VARIANT || 'full';
      const lang = getCurrentLanguage();
      const resp = await fetch('/api/digest/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: this.digestEmail,
          frequency: this.digestFrequency,
          variant,
          lang,
          categories: [...this.digestCategories],
        }),
      });

      const data = await resp.json();

      if (!resp.ok) {
        this.showDigestStatus('error', data.error || t('digest.error'));
        return;
      }

      if (data.status === 'already_subscribed') {
        this.digestStatus = 'confirmed';
        this.digestToken = data.token;
        this.persistDigestState();
        this.render();
        return;
      }

      // New subscription or pending — show confirmation message
      this.digestStatus = 'pending';
      this.digestToken = data.token;
      this.persistDigestState();
      this.render();
    } catch {
      this.showDigestStatus('error', t('digest.error'));
    } finally {
      this.digestSubmitting = false;
    }
  }

  private async handleDigestUpdate(): Promise<void> {
    if (!this.digestToken) return;

    try {
      const resp = await fetch('/api/digest/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: this.digestEmail,
          frequency: this.digestFrequency,
          variant: SITE_VARIANT || 'full',
          lang: getCurrentLanguage(),
          categories: [...this.digestCategories],
        }),
      });

      if (resp.ok) {
        localStorage.setItem('wm-digest-frequency', this.digestFrequency);
        localStorage.setItem('wm-digest-categories', JSON.stringify([...this.digestCategories]));
        this.showDigestStatus('success', t('digest.subscribed', { frequency: this.digestFrequency }));
      } else {
        this.showDigestStatus('error', t('digest.error'));
      }
    } catch {
      this.showDigestStatus('error', t('digest.error'));
    }
  }

  private async handleDigestUnsubscribe(): Promise<void> {
    if (!this.digestToken) return;

    try {
      const resp = await fetch(`/api/digest/unsubscribe?token=${encodeURIComponent(this.digestToken)}`);
      if (resp.ok || resp.status === 404) {
        this.digestStatus = 'none';
        this.digestToken = '';
        this.digestEmail = '';
        localStorage.removeItem('wm-digest-email');
        localStorage.removeItem('wm-digest-token');
        localStorage.removeItem('wm-digest-status');
        localStorage.removeItem('wm-digest-frequency');
        localStorage.removeItem('wm-digest-categories');
        this.render();
      }
    } catch {
      this.showDigestStatus('error', t('digest.error'));
    }
  }

  private showDigestStatus(type: 'success' | 'error' | 'pending', message: string): void {
    const area = this.overlay.querySelector('#digestStatusArea');
    if (area) {
      area.innerHTML = `<div class="digest-status ${type}">${escapeHtml(message)}</div>`;
    }
  }

  private persistDigestState(): void {
    localStorage.setItem('wm-digest-email', this.digestEmail);
    localStorage.setItem('wm-digest-token', this.digestToken);
    localStorage.setItem('wm-digest-status', this.digestStatus);
    localStorage.setItem('wm-digest-frequency', this.digestFrequency);
    localStorage.setItem('wm-digest-categories', JSON.stringify([...this.digestCategories]));
  }
}
