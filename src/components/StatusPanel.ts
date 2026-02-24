import { SITE_VARIANT } from '@/config';
import { h, replaceChildren } from '@/utils/dom-utils';

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
    this.allowedFeeds = SITE_VARIANT === 'tech' ? TECH_FEEDS : WORLD_FEEDS;
    this.allowedApis = SITE_VARIANT === 'tech' ? TECH_APIS : WORLD_APIS;

    const panel = h('div', { className: 'status-panel hidden' },
      h('div', { className: 'status-panel-header' },
        h('span', null, t('panels.status')),
        h('button', {
          className: 'status-panel-close',
          onClick: () => { this.isOpen = false; panel.classList.add('hidden'); },
        }, '×'),
      ),
      h('div', { className: 'status-panel-content' },
        h('div', { className: 'status-section' },
          h('div', { className: 'status-section-title' }, t('components.status.dataFeeds')),
          h('div', { className: 'feeds-list' }),
        ),
        h('div', { className: 'status-section' },
          h('div', { className: 'status-section-title' }, t('components.status.apiStatus')),
          h('div', { className: 'apis-list' }),
        ),
        h('div', { className: 'status-section' },
          h('div', { className: 'status-section-title' }, t('components.status.storage')),
          h('div', { className: 'storage-info' }),
        ),
      ),
      h('div', { className: 'status-panel-footer' },
        h('span', { className: 'last-check' }, t('components.status.updatedJustNow')),
      ),
    );

    this.element = h('div', { className: 'status-panel-container' },
      h('button', {
        className: 'status-panel-toggle',
        title: t('components.status.systemStatus'),
        onClick: () => {
          this.isOpen = !this.isOpen;
          panel.classList.toggle('hidden', !this.isOpen);
          if (this.isOpen) this.updateDisplay();
        },
      },
        h('span', { className: 'status-icon' }, '◉'),
      ),
      panel,
    );

    this.initDefaultStatuses();
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

    replaceChildren(feedsList,
      ...[...this.feeds.values()].map(feed =>
        h('div', { className: 'status-row' },
          h('span', { className: `status-dot ${feed.status}` }),
          h('span', { className: 'status-name' }, feed.name),
          h('span', { className: 'status-detail' }, `${feed.itemCount} items`),
          h('span', { className: 'status-time' }, feed.lastUpdate ? this.formatTime(feed.lastUpdate) : 'Never'),
        ),
      ),
    );

    replaceChildren(apisList,
      ...[...this.apis.values()].map(api =>
        h('div', { className: 'status-row' },
          h('span', { className: `status-dot ${api.status}` }),
          h('span', { className: 'status-name' }, api.name),
          api.latency ? h('span', { className: 'status-detail' }, `${api.latency}ms`) : false,
        ),
      ),
    );

    this.updateStorageInfo(storageInfo);
    lastCheck.textContent = t('components.status.updatedAt', { time: this.formatTime(new Date()) });
  }

  private async updateStorageInfo(container: Element): Promise<void> {
    try {
      if ('storage' in navigator && 'estimate' in navigator.storage) {
        const estimate = await navigator.storage.estimate();
        const used = estimate.usage ? (estimate.usage / 1024 / 1024).toFixed(2) : '0';
        const quota = estimate.quota ? (estimate.quota / 1024 / 1024).toFixed(0) : 'N/A';
        replaceChildren(container,
          h('div', { className: 'status-row' },
            h('span', { className: 'status-name' }, 'IndexedDB'),
            h('span', { className: 'status-detail' }, `${used} MB / ${quota} MB`),
          ),
        );
      } else {
        replaceChildren(container, h('div', { className: 'status-row' }, t('components.status.storageUnavailable')));
      }
    } catch {
      replaceChildren(container, h('div', { className: 'status-row' }, t('components.status.storageUnavailable')));
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
