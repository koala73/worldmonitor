import { FEEDS, INTEL_SOURCES, SOURCE_REGION_MAP } from '@/config/feeds';
import { PANEL_CATEGORY_MAP } from '@/config/panels';
import { SITE_VARIANT } from '@/config/variant';
import { LANGUAGES, changeLanguage, getCurrentLanguage, t } from '@/services/i18n';
import { getAiFlowSettings, setAiFlowSetting, getStreamQuality, setStreamQuality, STREAM_QUALITY_OPTIONS } from '@/services/ai-flow-settings';
import type { StreamQuality } from '@/services/ai-flow-settings';
import { escapeHtml } from '@/utils/sanitize';
import { trackLanguageChange } from '@/services/analytics';
import type { PanelConfig } from '@/types';

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

const DESKTOP_RELEASES_URL = 'https://github.com/koala73/worldmonitor/releases';

export interface UnifiedSettingsConfig {
  getPanelSettings: () => Record<string, PanelConfig>;
  togglePanel: (key: string) => void;
  getDisabledSources: () => Set<string>;
  toggleSource: (name: string) => void;
  setSourcesEnabled: (names: string[], enabled: boolean) => void;
  getAllSourceNames: () => string[];
  getLocalizedPanelName: (key: string, fallback: string) => string;
  isDesktopApp: boolean;
}

type TabId = 'general' | 'panels' | 'sources' | 'digest';

export class UnifiedSettings {
  private overlay: HTMLElement;
  private config: UnifiedSettingsConfig;
  private activeTab: TabId = 'general';
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

    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.close();
    };

    // Event delegation on stable overlay element
    this.overlay.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      // Close on overlay background click
      if (target === this.overlay) {
        this.close();
        return;
      }

      // Close button
      if (target.closest('.unified-settings-close')) {
        this.close();
        return;
      }

      // Tab switching
      const tab = target.closest<HTMLElement>('.unified-settings-tab');
      if (tab?.dataset.tab) {
        this.switchTab(tab.dataset.tab as TabId);
        return;
      }

      // Panel category pill
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

      // Panel toggle
      const panelItem = target.closest<HTMLElement>('.panel-toggle-item');
      if (panelItem?.dataset.panel) {
        this.config.togglePanel(panelItem.dataset.panel);
        this.renderPanelsTab();
        return;
      }

      // Source toggle
      const sourceItem = target.closest<HTMLElement>('.source-toggle-item');
      if (sourceItem?.dataset.source) {
        this.config.toggleSource(sourceItem.dataset.source);
        this.renderSourcesGrid();
        this.updateSourcesCounter();
        return;
      }

      // Region pill
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

      // Select All
      if (target.closest('.sources-select-all')) {
        const visible = this.getVisibleSourceNames();
        this.config.setSourcesEnabled(visible, true);
        this.renderSourcesGrid();
        this.updateSourcesCounter();
        return;
      }

      // Select None
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

    // Handle input events for search and digest email
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

    // Handle change events for toggles and language select
    this.overlay.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement;

      // Stream quality select
      if (target.id === 'us-stream-quality') {
        setStreamQuality(target.value as StreamQuality);
        return;
      }

      // Digest frequency select
      if (target.id === 'digestFrequencySelect') {
        this.digestFrequency = target.value;
        return;
      }

      // Language select
      if (target.closest('.unified-settings-lang-select')) {
        trackLanguageChange(target.value);
        void changeLanguage(target.value);
        return;
      }

      if (target.id === 'us-cloud') {
        setAiFlowSetting('cloudLlm', target.checked);
        this.updateAiStatus();
      } else if (target.id === 'us-browser') {
        setAiFlowSetting('browserModel', target.checked);
        const warn = this.overlay.querySelector('.ai-flow-toggle-warn') as HTMLElement;
        if (warn) warn.style.display = target.checked ? 'block' : 'none';
        this.updateAiStatus();
      } else if (target.id === 'us-map-flash') {
        setAiFlowSetting('mapNewsFlash', target.checked);
      } else if (target.id === 'us-headline-memory') {
        setAiFlowSetting('headlineMemory', target.checked);
      } else if (target.id === 'us-badge-anim') {
        setAiFlowSetting('badgeAnimation', target.checked);
      }
    });

    this.render();
    document.body.appendChild(this.overlay);
  }

  public open(tab?: TabId): void {
    if (tab) this.activeTab = tab;
    this.render();
    this.overlay.classList.add('active');
    localStorage.setItem('wm-settings-open', '1');
    document.addEventListener('keydown', this.escapeHandler);
  }

  public close(): void {
    this.overlay.classList.remove('active');
    localStorage.removeItem('wm-settings-open');
    document.removeEventListener('keydown', this.escapeHandler);
  }

  public refreshPanelToggles(): void {
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
    document.removeEventListener('keydown', this.escapeHandler);
    this.overlay.remove();
  }

  private render(): void {
    const tabClass = (id: TabId) => `unified-settings-tab${this.activeTab === id ? ' active' : ''}`;

    this.overlay.innerHTML = `
      <div class="modal unified-settings-modal">
        <div class="modal-header">
          <span class="modal-title">${t('header.settings')}</span>
          <button class="modal-close unified-settings-close">×</button>
        </div>
        <div class="unified-settings-tabs">
          <button class="${tabClass('general')}" data-tab="general">${t('header.tabGeneral')}</button>
          <button class="${tabClass('panels')}" data-tab="panels">${t('header.tabPanels')}</button>
          <button class="${tabClass('sources')}" data-tab="sources">${t('header.tabSources')}</button>
          <button class="${tabClass('digest')}" data-tab="digest">${t('header.tabDigest')}</button>
        </div>
        <div class="unified-settings-tab-panel${this.activeTab === 'general' ? ' active' : ''}" data-panel-id="general">
          ${this.renderGeneralContent()}
        </div>
        <div class="unified-settings-tab-panel${this.activeTab === 'panels' ? ' active' : ''}" data-panel-id="panels">
          <div class="unified-settings-region-wrapper">
            <div class="unified-settings-region-bar" id="usPanelCatBar"></div>
          </div>
          <div class="panels-search">
            <input type="text" placeholder="${t('header.filterPanels')}" value="${escapeHtml(this.panelFilter)}" />
          </div>
          <div class="panel-toggle-grid" id="usPanelToggles"></div>
        </div>
        <div class="unified-settings-tab-panel${this.activeTab === 'sources' ? ' active' : ''}" data-panel-id="sources">
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
        <div class="unified-settings-tab-panel${this.activeTab === 'digest' ? ' active' : ''}" data-panel-id="digest">
          ${this.renderDigestContent()}
        </div>
      </div>
    `;

    // Populate dynamic sections after innerHTML is set
    this.renderPanelCategoryPills();
    this.renderPanelsTab();
    this.renderRegionPills();
    this.renderSourcesGrid();
    this.updateSourcesCounter();
    if (!this.config.isDesktopApp) this.updateAiStatus();
  }

  private switchTab(tab: TabId): void {
    this.activeTab = tab;

    // Update tab buttons
    this.overlay.querySelectorAll('.unified-settings-tab').forEach(el => {
      el.classList.toggle('active', (el as HTMLElement).dataset.tab === tab);
    });

    // Update tab panels
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

  private renderGeneralContent(): string {
    const settings = getAiFlowSettings();
    const currentLang = getCurrentLanguage();

    let html = '';

    // Map section
    html += `<div class="ai-flow-section-label">${t('components.insights.sectionMap')}</div>`;
    html += this.toggleRowHtml('us-map-flash', t('components.insights.mapFlashLabel'), t('components.insights.mapFlashDesc'), settings.mapNewsFlash);

    // Panels section
    html += `<div class="ai-flow-section-label">${t('components.insights.sectionPanels')}</div>`;
    html += this.toggleRowHtml('us-badge-anim', t('components.insights.badgeAnimLabel'), t('components.insights.badgeAnimDesc'), settings.badgeAnimation);

    // AI Analysis section (web-only)
    if (!this.config.isDesktopApp) {
      html += `<div class="ai-flow-section-label">${t('components.insights.sectionAi')}</div>`;
      html += this.toggleRowHtml('us-cloud', t('components.insights.aiFlowCloudLabel'), t('components.insights.aiFlowCloudDesc'), settings.cloudLlm);

      html += this.toggleRowHtml('us-browser', t('components.insights.aiFlowBrowserLabel'), t('components.insights.aiFlowBrowserDesc'), settings.browserModel);
      html += `<div class="ai-flow-toggle-warn" style="display:${settings.browserModel ? 'block' : 'none'}">${t('components.insights.aiFlowBrowserWarn')}</div>`;

      // Ollama CTA
      html += `
        <div class="ai-flow-cta">
          <div class="ai-flow-cta-title">${t('components.insights.aiFlowOllamaCta')}</div>
          <div class="ai-flow-cta-desc">${t('components.insights.aiFlowOllamaCtaDesc')}</div>
          <a href="${DESKTOP_RELEASES_URL}" target="_blank" rel="noopener noreferrer" class="ai-flow-cta-link">${t('components.insights.aiFlowDownloadDesktop')}</a>
        </div>
      `;
    }

    // Intelligence section
    html += `<div class="ai-flow-section-label">${t('components.insights.sectionIntelligence')}</div>`;
    html += this.toggleRowHtml('us-headline-memory', t('components.insights.headlineMemoryLabel'), t('components.insights.headlineMemoryDesc'), settings.headlineMemory);

    // Streaming quality section
    const currentQuality = getStreamQuality();
    html += `<div class="ai-flow-section-label">${t('components.insights.sectionStreaming')}</div>`;
    html += `<div class="ai-flow-toggle-row">
      <div class="ai-flow-toggle-label-wrap">
        <div class="ai-flow-toggle-label">${t('components.insights.streamQualityLabel')}</div>
        <div class="ai-flow-toggle-desc">${t('components.insights.streamQualityDesc')}</div>
      </div>
    </div>`;
    html += `<select class="unified-settings-lang-select" id="us-stream-quality">`;
    for (const opt of STREAM_QUALITY_OPTIONS) {
      const selected = opt.value === currentQuality ? ' selected' : '';
      html += `<option value="${opt.value}"${selected}>${opt.label}</option>`;
    }
    html += `</select>`;

    // Language section
    html += `<div class="ai-flow-section-label">${t('header.languageLabel')}</div>`;
    html += `<select class="unified-settings-lang-select">`;
    for (const lang of LANGUAGES) {
      const selected = lang.code === currentLang ? ' selected' : '';
      html += `<option value="${lang.code}"${selected}>${lang.flag} ${lang.label}</option>`;
    }
    html += `</select>`;

    // AI status footer (web-only)
    if (!this.config.isDesktopApp) {
      html += `<div class="ai-flow-popup-footer"><span class="ai-flow-status-dot" id="usStatusDot"></span><span class="ai-flow-status-text" id="usStatusText"></span></div>`;
    }

    return html;
  }

  private toggleRowHtml(id: string, label: string, desc: string, checked: boolean): string {
    return `
      <div class="ai-flow-toggle-row">
        <div class="ai-flow-toggle-label-wrap">
          <div class="ai-flow-toggle-label">${label}</div>
          <div class="ai-flow-toggle-desc">${desc}</div>
        </div>
        <label class="ai-flow-switch">
          <input type="checkbox" id="${id}"${checked ? ' checked' : ''}>
          <span class="ai-flow-slider"></span>
        </label>
      </div>
    `;
  }

  private updateAiStatus(): void {
    const settings = getAiFlowSettings();
    const dot = this.overlay.querySelector('#usStatusDot');
    const text = this.overlay.querySelector('#usStatusText');
    if (!dot || !text) return;

    dot.className = 'ai-flow-status-dot';
    if (settings.cloudLlm && settings.browserModel) {
      dot.classList.add('active');
      text.textContent = t('components.insights.aiFlowStatusCloudAndBrowser');
    } else if (settings.cloudLlm) {
      dot.classList.add('active');
      text.textContent = t('components.insights.aiFlowStatusActive');
    } else if (settings.browserModel) {
      dot.classList.add('browser-only');
      text.textContent = t('components.insights.aiFlowStatusBrowserOnly');
    } else {
      dot.classList.add('disabled');
      text.textContent = t('components.insights.aiFlowStatusDisabled');
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
    const panelSettings = this.config.getPanelSettings();
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

    const entries = this.getVisiblePanelEntries();
    container.innerHTML = entries.map(([key, panel]) => `
      <div class="panel-toggle-item ${panel.enabled ? 'active' : ''}" data-panel="${escapeHtml(key)}">
        <div class="panel-toggle-checkbox">${panel.enabled ? '✓' : ''}</div>
        <span class="panel-toggle-label">${escapeHtml(this.config.getLocalizedPanelName(key, panel.name))}</span>
      </div>
    `).join('');
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
          <div class="source-toggle-checkbox">${isEnabled ? '✓' : ''}</div>
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
