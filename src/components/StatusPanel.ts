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
  errorMessage?: string;
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
  'Cyber Threats API', 'Signal Aggregator'
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
  'Global Procurement',
  'Cyber Threats API', 'BIS', 'WTO', 'SupplyChain', 'OFAC', 'Signal Aggregator'
]);

import { t } from '../services/i18n';
import { Panel } from './Panel';

/** Compact digest coverage summary rendered as the panel's status row (#7085). */
export interface DigestCoverageSummary {
  state: 'complete' | 'partial' | 'stale' | 'unavailable' | 'unknown';
  itemsServed: number;
  publisherCount: number;
  feedsCompleted: number;
  feedsTotal: number;
  categoriesCompleted: number;
  categoriesTotal: number;
  missingCategories: string[];
}

const DIGEST_COVERAGE_EXPLANATIONS: Record<DigestCoverageSummary['state'], string> = {
  complete: 'every configured category was covered in this cycle',
  partial: 'some categories had no completed feed in this cycle',
  stale: 'older accepted content is being served after a failed rebuild',
  unavailable: 'no digest content could be served',
  unknown: 'the digest did not report coverage',
};

export class StatusPanel extends Panel {
  private feeds: Map<string, FeedStatus> = new Map();
  private apis: Map<string, ApiStatus> = new Map();
  private digestCoverage: DigestCoverageSummary | null = null;
  private digestCoverageRow: HTMLElement | null = null;
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

  /**
   * #7085 digest coverage row: one text line stating what the served digest
   * covers and why it may be degraded. Text only — never color alone — with
   * an accessible name and a short explanation, announced politely.
   */
  public updateDigestCoverage(coverage: DigestCoverageSummary): void {
    this.digestCoverage = coverage;
    const explanation = DIGEST_COVERAGE_EXPLANATIONS[coverage.state];
    const missing = coverage.missingCategories.length > 0
      ? ` (no completed feed: ${coverage.missingCategories.slice(0, 4).join(', ')}${coverage.missingCategories.length > 4 ? ', …' : ''})`
      : '';
    const text = coverage.state === 'unavailable' || coverage.state === 'unknown'
      ? `Digest coverage: ${coverage.state} — ${explanation}`
      : `Digest coverage: ${coverage.state} — ${coverage.publisherCount} publishers, ${coverage.itemsServed} items, feeds ${coverage.feedsCompleted}/${coverage.feedsTotal}, categories ${coverage.categoriesCompleted}/${coverage.categoriesTotal}${missing} (${explanation})`;
    if (!this.digestCoverageRow) {
      this.digestCoverageRow = h('div', {
        className: 'digest-coverage-row',
        role: 'status',
        'aria-live': 'polite',
        'aria-label': 'Digest coverage status',
      });
      this.element.appendChild(this.digestCoverageRow);
    }
    this.ensureCoverageRowMounted();
    this.digestCoverageRow.textContent = text;
  }

  /**
   * Nothing else mounts this panel — it is otherwise a write-only data sink
   * (no getElement() callers), so the row must reach the document from here
   * or it renders into a detached node no user or screen reader can see.
   * The site footer always exists by the first digest load (layout Phase 1
   * precedes data loading), so a missing footer only means a non-dashboard
   * document; the row then stays detached rather than throwing.
   */
  private ensureCoverageRowMounted(): void {
    if (this.element.isConnected) return;
    document.querySelector('.site-footer')?.appendChild(this.element);
  }

  public getDigestCoverage(): DigestCoverageSummary | null {
    return this.digestCoverage;
  }

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
