import { SITE_VARIANT } from '@/config';
import { h } from '@/utils/dom-utils'; // kept for Panel base class compat

export type StatusLevel = 'ok' | 'warning' | 'error' | 'disabled';

export interface FeedStatus {
  name: string;
  lastUpdate: Date | null;
  status: StatusLevel;
  itemCount: number;
  errorMessage?: string;
}

export interface ApiStatus {
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
  'Cyber Threats', 'GPS Jam'
]);
const WORLD_APIS = new Set([
  'RSS2JSON', 'Finnhub', 'CoinGecko', 'Polymarket', 'USGS', 'FRED',
  'AISStream', 'GDELT Doc', 'EIA', 'USASpending', 'PizzINT', 'FIRMS',
  'Cyber Threats API', 'BIS', 'WTO', 'SupplyChain'
]);

import { t } from '../services/i18n';
import { Panel } from './Panel';

export class StatusPanel extends Panel {
  private feeds: Map<string, FeedStatus> = new Map();
  private apis: Map<string, ApiStatus> = new Map();
  private allowedFeeds!: Set<string>;
  private allowedApis!: Set<string>;
  public onUpdate: (() => void) | null = null;

  constructor() {
    super({ id: 'status', title: t('panels.status') });
    this.init();
  }

  private init(): void {
    this.allowedFeeds = SITE_VARIANT === 'tech' ? TECH_FEEDS : WORLD_FEEDS;
    this.allowedApis = SITE_VARIANT === 'tech' ? TECH_APIS : WORLD_APIS;

    this.element = h('div', { className: 'status-panel-container' });
    this.initDefaultStatuses();
  }

  private initDefaultStatuses(): void {
    this.allowedFeeds.forEach(name => {
      this.feeds.set(name, { name, lastUpdate: null, status: 'disabled', itemCount: 0 });
    });
    this.allowedApis.forEach(name => {
      this.apis.set(name, { name, status: 'disabled' });
    });
  }

  public getFeeds(): Map<string, FeedStatus> { return this.feeds; }
  public getApis(): Map<string, ApiStatus> { return this.apis; }

  public updateFeed(name: string, status: Partial<FeedStatus>): void {
    if (!this.allowedFeeds.has(name)) return;
    const existing = this.feeds.get(name) || { name, lastUpdate: null, status: 'ok' as const, itemCount: 0 };
    this.feeds.set(name, { ...existing, ...status, lastUpdate: new Date() });
    this.onUpdate?.();
  }

  public updateApi(name: string, status: Partial<ApiStatus>): void {
    if (!this.allowedApis.has(name)) return;
    const existing = this.apis.get(name) || { name, status: 'ok' as const };
    this.apis.set(name, { ...existing, ...status });
    this.onUpdate?.();
  }

  public setFeedDisabled(name: string): void {
    const existing = this.feeds.get(name);
    if (existing) {
      this.feeds.set(name, { ...existing, status: 'disabled', itemCount: 0, lastUpdate: null });
      this.onUpdate?.();
    }
  }

  public setApiDisabled(name: string): void {
    const existing = this.apis.get(name);
    if (existing) {
      this.apis.set(name, { ...existing, status: 'disabled' });
      this.onUpdate?.();
    }
  }

  public formatTime(date: Date): string {
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
