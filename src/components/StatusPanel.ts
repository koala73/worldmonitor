import { escapeHtml } from '@/utils/sanitize';
import { batchReplaceChildren } from '@/utils/dom-utils';
import { SITE_VARIANT } from '@/config';

type StatusLevel = 'ok' | 'warning' | 'error' | 'disabled';

interface FeedStatus {
  name: string;
  lastUpdate: Date | null;
  status: StatusLevel;
  itemCount: number;
  errorMessage?: string;
}

interface ApiStatus {
  name: string;
  status: StatusLevel;
  latency?: number;
}

// Allowlists for each variant
const TECH_FEEDS = new Set([
  'Tech', 'Ai', 'Startups', 'Vcblogs', 'RegionalStartups',
  'Unicorns', 'Accelerators', 'Security', 'Policy', 'Layoffs',
  'Finance', 'Hardware', 'Cloud', 'Dev', 'Tech Events', 'Crypto',
  'Markets', 'Events', 'Producthunt', 'Funding', 'Polymarket',
  'Cyber Threats'
]);
const TECH_APIS = new Set([
  'RSS Proxy', 'Finnhub', 'CoinGecko', 'Tech Events API', 'Service Status', 'Polymarket',
  'Cyber Threats API'
]);

const WORLD_FEEDS = new Set([
  'Politics', 'Middleeast', 'Tech', 'Ai', 'Finance',
  'Gov', 'Intel', 'Layoffs', 'Thinktanks', 'Energy',
  'Polymarket', 'Weather', 'NetBlocks', 'Shipping', 'Military',
  'Cyber Threats'
]);
const WORLD_APIS = new Set([
  'RSS2JSON', 'Finnhub', 'CoinGecko', 'Polymarket', 'USGS', 'FRED',
  'AISStream', 'GDELT Doc', 'EIA', 'USASpending', 'PizzINT', 'FIRMS',
  'Cyber Threats API'
]);

import { t } from '../services/i18n';
import { Panel } from './Panel';

export class StatusPanel extends Panel {
  private isOpen = false;
  private feeds: Map<string, FeedStatus> = new Map();
  private apis: Map<string, ApiStatus> = new Map();
  private allowedFeeds!: Set<string>;
  private allowedApis!: Set<string>;

  constructor() {
    super({ id: 'status', title: t('panels.status') });
    // Title is hidden in CSS, we use custom header
    this.init();
  }

  private init(): void {
    // Set allowlists based on variant
    this.allowedFeeds = SITE_VARIANT === 'tech' ? TECH_FEEDS : WORLD_FEEDS;
    this.allowedApis = SITE_VARIANT === 'tech' ? TECH_APIS : WORLD_APIS;

    this.element = document.createElement('div');
    this.element.className = 'status-panel-container';
    this.element.innerHTML = `
      <button class="status-panel-toggle" title="${t('components.status.systemStatus')}">
        <span class="status-icon">◉</span>
      </button>
      <div class="status-panel hidden">
        <div class="status-panel-header">
          <span>${t('panels.status')}</span>
          <button class="status-panel-close">×</button>
        </div>
        <div class="status-panel-content">
          <div class="status-section">
            <div class="status-section-title">${t('components.status.dataFeeds')}</div>
            <div class="feeds-list"></div>
          </div>
          <div class="status-section">
            <div class="status-section-title">${t('components.status.apiStatus')}</div>
            <div class="apis-list"></div>
          </div>
          <div class="status-section">
            <div class="status-section-title">${t('components.status.storage')}</div>
            <div class="storage-info"></div>
          </div>
        </div>
        <div class="status-panel-footer">
          <span class="last-check">${t('components.status.updatedJustNow')}</span>
        </div>
      </div>
    `;

    this.setupEventListeners();
    this.initDefaultStatuses();
  }

  private setupEventListeners(): void {
    const toggle = this.element.querySelector('.status-panel-toggle')!;
    const panel = this.element.querySelector('.status-panel')!;
    const closeBtn = this.element.querySelector('.status-panel-close')!;

    toggle.addEventListener('click', () => {
      this.isOpen = !this.isOpen;
      panel.classList.toggle('hidden', !this.isOpen);
      if (this.isOpen) this.updateDisplay();
    });

    closeBtn.addEventListener('click', () => {
      this.isOpen = false;
      panel.classList.add('hidden');
    });
  }

  private initDefaultStatuses(): void {
    // Initialize all allowed feeds/APIs as disabled
    // They get enabled when App.ts reports data
    this.allowedFeeds.forEach(name => {
      this.feeds.set(name, { name, lastUpdate: null, status: 'disabled', itemCount: 0 });
    });

    this.allowedApis.forEach(name => {
      this.apis.set(name, { name, status: 'disabled' });
    });
  }

  public updateFeed(name: string, status: Partial<FeedStatus>): void {
    // Only track feeds relevant to current variant
    if (!this.allowedFeeds.has(name)) return;

    const existing = this.feeds.get(name) || { name, lastUpdate: null, status: 'ok' as const, itemCount: 0 };
    this.feeds.set(name, { ...existing, ...status, lastUpdate: new Date() });
    this.updateStatusIcon();
    if (this.isOpen) this.updateDisplay();
  }

  public updateApi(name: string, status: Partial<ApiStatus>): void {
    // Only track APIs relevant to current variant
    if (!this.allowedApis.has(name)) return;

    const existing = this.apis.get(name) || { name, status: 'ok' as const };
    this.apis.set(name, { ...existing, ...status });
    this.updateStatusIcon();
    if (this.isOpen) this.updateDisplay();
  }

  public setFeedDisabled(name: string): void {
    const existing = this.feeds.get(name);
    if (existing) {
      this.feeds.set(name, { ...existing, status: 'disabled', itemCount: 0, lastUpdate: null });
      this.updateStatusIcon();
      if (this.isOpen) this.updateDisplay();
    }
  }

  public setApiDisabled(name: string): void {
    const existing = this.apis.get(name);
    if (existing) {
      this.apis.set(name, { ...existing, status: 'disabled' });
      this.updateStatusIcon();
      if (this.isOpen) this.updateDisplay();
    }
  }

  private updateStatusIcon(): void {
    const icon = this.element.querySelector('.status-icon')!;
    // Only count enabled feeds/APIs (not 'disabled') for status indicator
    const enabledFeeds = [...this.feeds.values()].filter(f => f.status !== 'disabled');
    const enabledApis = [...this.apis.values()].filter(a => a.status !== 'disabled');

    const hasError = enabledFeeds.some(f => f.status === 'error') ||
      enabledApis.some(a => a.status === 'error');
    const hasWarning = enabledFeeds.some(f => f.status === 'warning') ||
      enabledApis.some(a => a.status === 'warning');

    icon.className = 'status-icon';
    if (hasError) {
      icon.classList.add('error');
      icon.textContent = '◉';
    } else if (hasWarning) {
      icon.classList.add('warning');
      icon.textContent = '◉';
    } else {
      icon.classList.add('ok');
      icon.textContent = '◉';
    }
  }

  private updateDisplay(): void {
    const feedsList = this.element.querySelector('.feeds-list')!;
    const apisList = this.element.querySelector('.apis-list')!;
    const storageInfo = this.element.querySelector('.storage-info')!;
    const lastCheck = this.element.querySelector('.last-check')!;

    batchReplaceChildren(feedsList, [...this.feeds.values()].map(feed => this.createFeedRow(feed)));
    batchReplaceChildren(apisList, [...this.apis.values()].map(api => this.createApiRow(api)));

    this.updateStorageInfo(storageInfo);
    lastCheck.textContent = t('components.status.updatedAt', { time: this.formatTime(new Date()) });
  }

  private createFeedRow(feed: FeedStatus): HTMLElement {
    const row = document.createElement('div');
    row.className = 'status-row';

    const dot = document.createElement('span');
    dot.className = `status-dot ${escapeHtml(feed.status)}`;

    const name = document.createElement('span');
    name.className = 'status-name';
    name.textContent = feed.name;

    const detail = document.createElement('span');
    detail.className = 'status-detail';
    detail.textContent = `${feed.itemCount} items`;

    const time = document.createElement('span');
    time.className = 'status-time';
    time.textContent = feed.lastUpdate ? this.formatTime(feed.lastUpdate) : 'Never';

    row.append(dot, name, detail, time);
    return row;
  }

  private createApiRow(api: ApiStatus): HTMLElement {
    const row = document.createElement('div');
    row.className = 'status-row';

    const dot = document.createElement('span');
    dot.className = `status-dot ${escapeHtml(api.status)}`;

    const name = document.createElement('span');
    name.className = 'status-name';
    name.textContent = api.name;

    row.append(dot, name);

    if (api.latency) {
      const detail = document.createElement('span');
      detail.className = 'status-detail';
      detail.textContent = `${api.latency}ms`;
      row.append(detail);
    }

    return row;
  }

  private async updateStorageInfo(container: Element): Promise<void> {
    try {
      if ('storage' in navigator && 'estimate' in navigator.storage) {
        const estimate = await navigator.storage.estimate();
        const used = estimate.usage ? (estimate.usage / 1024 / 1024).toFixed(2) : '0';
        const quota = estimate.quota ? (estimate.quota / 1024 / 1024).toFixed(0) : 'N/A';
        container.innerHTML = `
          <div class="status-row">
            <span class="status-name">IndexedDB</span>
            <span class="status-detail">${used} MB / ${quota} MB</span>
          </div>
        `;
      } else {
        container.innerHTML = `<div class="status-row">${t('components.status.storageUnavailable')}</div>`;
      }
    } catch {
      container.innerHTML = `<div class="status-row">${t('components.status.storageUnavailable')}</div>`;
    }
  }

  private formatTime(date: Date): string {
    const now = Date.now();
    const diff = now - date.getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }

  public getElement(): HTMLElement {
    return this.element;
  }
}
