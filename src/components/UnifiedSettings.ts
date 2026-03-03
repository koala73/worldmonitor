import { FEEDS, INTEL_SOURCES, SOURCE_REGION_MAP } from '@/config/feeds';
import { LANGUAGES, changeLanguage, getCurrentLanguage, t } from '@/services/i18n';
import { getAiFlowSettings, setAiFlowSetting, getStreamQuality, setStreamQuality, STREAM_QUALITY_OPTIONS } from '@/services/ai-flow-settings';
import type { StreamQuality } from '@/services/ai-flow-settings';
import { escapeHtml } from '@/utils/sanitize';
import { trackLanguageChange } from '@/services/analytics';
import type { StatusPanel } from './StatusPanel';
import { exportSettings, importSettings } from '@/utils/settings-persistence';

const GEAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

const DESKTOP_RELEASES_URL = 'https://github.com/koala73/worldmonitor/releases';

export interface UnifiedSettingsConfig {
  getDisabledSources: () => Set<string>;
  toggleSource: (name: string) => void;
  setSourcesEnabled: (names: string[], enabled: boolean) => void;
  getAllSourceNames: () => string[];
  isDesktopApp: boolean;
  statusPanel?: StatusPanel | null;
}

type TabId = 'general' | 'sources' | 'status';

export class UnifiedSettings {
  private overlay: HTMLElement;
  private config: UnifiedSettingsConfig;
  private activeTab: TabId = 'general';
  private activeSourceRegion = 'all';
  private sourceFilter = '';
  private escapeHandler: (e: KeyboardEvent) => void;

  constructor(config: UnifiedSettingsConfig) {
    this.config = config;

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

      if (target.closest('#usExportBtn')) {
        exportSettings();
        return;
      }

      if (target.closest('#usImportBtn')) {
        const input = this.overlay.querySelector<HTMLInputElement>('#usImportInput');
        input?.click();
        return;
      }
    });

    // Handle input events for search
    this.overlay.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement;
      if (target.closest('.sources-search')) {
        this.sourceFilter = target.value;
        this.renderSourcesGrid();
        this.updateSourcesCounter();
      }
    });

    // Handle change events for toggles and language select
    this.overlay.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement;

      if (target.id === 'usImportInput') {
        const file = target.files?.[0];
        if (!file) return;
        importSettings(file).catch(err => {
          console.error('Failed to import settings', err);
          alert('Failed to import settings: Invalid file format');
        });
        target.value = '';
        return;
      }

      // Stream quality select
      if (target.id === 'us-stream-quality') {
        setStreamQuality(target.value as StreamQuality);
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
          <button class="modal-close unified-settings-close" aria-label="Close">×</button>
        </div>
        <div class="unified-settings-tabs" role="tablist" aria-label="Settings">
          <button class="${tabClass('general')}" data-tab="general" role="tab" aria-selected="${this.activeTab === 'general'}" id="us-tab-general" aria-controls="us-tab-panel-general">${t('header.tabGeneral')}</button>
          <button class="${tabClass('sources')}" data-tab="sources" role="tab" aria-selected="${this.activeTab === 'sources'}" id="us-tab-sources" aria-controls="us-tab-panel-sources">${t('header.tabSources')}</button>
          <button class="${tabClass('status')}" data-tab="status" role="tab" aria-selected="${this.activeTab === 'status'}" id="us-tab-status" aria-controls="us-tab-panel-status">${t('panels.status')}</button>
        </div>
        <div class="unified-settings-tab-panel${this.activeTab === 'general' ? ' active' : ''}" data-panel-id="general" id="us-tab-panel-general" role="tabpanel" aria-labelledby="us-tab-general">
          ${this.renderGeneralContent()}
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
        <div class="unified-settings-tab-panel${this.activeTab === 'status' ? ' active' : ''}" data-panel-id="status" id="us-tab-panel-status" role="tabpanel" aria-labelledby="us-tab-status">
          <div class="us-status-content" id="usStatusContent"></div>
        </div>
      </div>
    `;

    // Populate dynamic sections after innerHTML is set
    this.renderRegionPills();
    this.renderSourcesGrid();
    this.updateSourcesCounter();
    this.renderStatusTab();
    if (!this.config.isDesktopApp) this.updateAiStatus();
  }

  private switchTab(tab: TabId): void {
    this.activeTab = tab;

    // Update tab buttons
    this.overlay.querySelectorAll('.unified-settings-tab').forEach(el => {
      const isActive = (el as HTMLElement).dataset.tab === tab;
      el.classList.toggle('active', isActive);
      el.setAttribute('aria-selected', String(isActive));
    });

    // Update tab panels
    this.overlay.querySelectorAll('.unified-settings-tab-panel').forEach(el => {
      el.classList.toggle('active', (el as HTMLElement).dataset.panelId === tab);
    });
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

    // Data Management section
    html += `<div class="ai-flow-section-label">${t('settings.dataManagementLabel')}</div>`;
    html += `
      <div style="display: flex; gap: 10px; padding: 0 16px 16px;">
        <button type="button" class="settings-btn settings-btn-secondary" id="usExportBtn" style="flex: 1;">📥 ${t('settings.exportSettings')}</button>
        <button type="button" class="settings-btn settings-btn-secondary" id="usImportBtn" style="flex: 1;">📤 ${t('settings.importSettings')}</button>
        <input type="file" id="usImportInput" accept=".json" style="display: none;" />
      </div>
    `;

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

  public refreshStatusTab(): void {
    if (this.activeTab === 'status') this.renderStatusTab();
  }

  private renderStatusTab(): void {
    const container = this.overlay.querySelector('#usStatusContent');
    if (!container) return;
    const sp = this.config.statusPanel;
    if (!sp) {
      container.innerHTML = `<div style="padding:16px;color:var(--text-dim)">${t('components.status.storageUnavailable')}</div>`;
      return;
    }

    const feeds = sp.getFeeds();
    const apis = sp.getApis();

    let html = `<div class="us-status-section">
      <div class="us-status-section-title">${t('components.status.dataFeeds')}</div>`;
    for (const feed of feeds.values()) {
      html += `<div class="status-row">
        <span class="status-dot ${feed.status}"></span>
        <span class="status-name">${escapeHtml(feed.name)}</span>
        <span class="status-detail">${feed.itemCount} items</span>
        <span class="status-time">${feed.lastUpdate ? sp.formatTime(feed.lastUpdate) : 'Never'}</span>
      </div>`;
    }
    html += `</div>`;

    html += `<div class="us-status-section">
      <div class="us-status-section-title">${t('components.status.apiStatus')}</div>`;
    for (const api of apis.values()) {
      html += `<div class="status-row">
        <span class="status-dot ${api.status}"></span>
        <span class="status-name">${escapeHtml(api.name)}</span>
        ${api.latency ? `<span class="status-detail">${api.latency}ms</span>` : ''}
      </div>`;
    }
    html += `</div>`;

    html += `<div class="us-status-section">
      <div class="us-status-section-title">${t('components.status.storage')}</div>
      <div id="usStorageInfo"></div>
    </div>`;

    html += `<div class="us-status-footer">${t('components.status.updatedAt', { time: sp.formatTime(new Date()) })}</div>`;

    container.innerHTML = html;
    this.updateStorageInfo();
  }

  private async updateStorageInfo(): Promise<void> {
    const container = this.overlay.querySelector('#usStorageInfo');
    if (!container) return;
    try {
      if ('storage' in navigator && 'estimate' in navigator.storage) {
        const estimate = await navigator.storage.estimate();
        if (!container.isConnected) return;
        const used = estimate.usage ? (estimate.usage / 1024 / 1024).toFixed(2) : '0';
        const quota = estimate.quota ? (estimate.quota / 1024 / 1024).toFixed(0) : 'N/A';
        container.innerHTML = `<div class="status-row">
          <span class="status-name">IndexedDB</span>
          <span class="status-detail">${used} MB / ${quota} MB</span>
        </div>`;
      } else {
        container.innerHTML = `<div class="status-row">${t('components.status.storageUnavailable')}</div>`;
      }
    } catch {
      if (!container.isConnected) return;
      container.innerHTML = `<div class="status-row">${t('components.status.storageUnavailable')}</div>`;
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
}
