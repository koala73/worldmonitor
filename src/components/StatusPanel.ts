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
  /** Items that reached ranking before the 20-per-category cap; 0 when unreported. */
  itemsConsidered: number;
  /** Distinct publishers among those items; 0 when unreported. */
  publishersConsidered: number;
  /**
   * Who is serving old content: the server replaying, this browser after its
   * request failed, or this browser while a language switch loads.
   */
  staleCause: 'server' | 'device' | 'switching' | null;
  /** Server stale reason: build-error | empty-rebuild | gate-held ('' otherwise). */
  staleReason: string;
  /** Age of the shown content in seconds, when known. */
  contentAgeSeconds: number | null;
}

const DIGEST_COVERAGE_EXPLANATIONS: Record<Exclude<DigestCoverageSummary['state'], 'stale'>, string> = {
  complete: 'every configured category was covered in this cycle',
  partial: 'some categories had no completed feed in this cycle',
  unavailable: 'no news content could be loaded',
  unknown: 'the news service did not report coverage',
};

const formatCount = (n: number): string => n.toLocaleString('en-US');

function formatAge(seconds: number): string {
  if (seconds < 60) return 'under a minute';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}

function staleExplanation(coverage: DigestCoverageSummary): string {
  const age = coverage.contentAgeSeconds !== null && coverage.contentAgeSeconds >= 0
    ? ` from ${formatAge(coverage.contentAgeSeconds)} ago`
    : '';
  if (coverage.staleCause === 'device') {
    return `the news service did not respond, so this is the copy saved on this device${age}`;
  }
  if (coverage.staleCause === 'switching') {
    return `showing the copy saved on this device${age} while this language loads`;
  }
  // gate-held: the rebuild succeeded but the acceptance gate kept the
  // incumbent content live. It is not a failure.
  if (coverage.staleReason === 'gate-held') {
    return `showing content${age}; the latest rebuild was held back by a quality check`;
  }
  if (coverage.staleReason === 'empty-rebuild') {
    return `showing content${age}; the latest rebuild came back empty`;
  }
  return `showing content${age}; the latest rebuild failed`;
}

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
    const explanation = coverage.state === 'stale'
      ? staleExplanation(coverage)
      : DIGEST_COVERAGE_EXPLANATIONS[coverage.state];
    // The digest shows at most 20 stories per category, so the served slice
    // understates how many publishers fed this cycle. Report the ranked pool
    // when the server sent it.
    const breadth = coverage.publishersConsidered > 0 && coverage.itemsConsidered > coverage.itemsServed
      ? `${formatCount(coverage.publishersConsidered)} publishers, ${formatCount(coverage.itemsConsidered)} stories reviewed, top ${formatCount(coverage.itemsServed)} shown`
      : `${formatCount(coverage.publisherCount)} publishers, ${formatCount(coverage.itemsServed)} stories`;
    const missing = coverage.missingCategories.length > 0
      ? ` (no completed feed: ${coverage.missingCategories.slice(0, 4).join(', ')}${coverage.missingCategories.length > 4 ? ', …' : ''})`
      : '';
    const text = coverage.state === 'unavailable' || coverage.state === 'unknown'
      ? `News coverage: ${coverage.state} — ${explanation}`
      : `News coverage: ${coverage.state} — ${breadth}, feeds ${coverage.feedsCompleted}/${coverage.feedsTotal}, categories ${coverage.categoriesCompleted}/${coverage.categoriesTotal}${missing} (${explanation})`;
    if (!this.digestCoverageRow) {
      this.digestCoverageRow = h('div', {
        className: 'digest-coverage-row',
        role: 'status',
        'aria-live': 'polite',
        'aria-label': 'News coverage status',
      });
      this.element.appendChild(this.digestCoverageRow);
    }
    this.ensureCoverageRowMounted();
    this.digestCoverageRow.textContent = text;
    // The compact footer (#10461) ellipsizes this row on one line; keep the
    // full text (missing categories, stale cause) readable as a tooltip.
    this.digestCoverageRow.title = text;
  }

  /**
   * Nothing else mounts this panel — it is otherwise a write-only data sink
   * (no getElement() callers), so the row must reach the document from here
   * or it renders into a detached node no user or screen reader can see.
   * The compact site footer (#10461) always exists by the first digest load
   * (layout Phase 1 precedes data loading), so a missing footer only means a
   * non-dashboard document; the row then stays detached rather than throwing.
   * CSS keeps the row on the same 28px footer line via ellipsis.
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
