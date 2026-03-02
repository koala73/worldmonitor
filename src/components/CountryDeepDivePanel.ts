import type { CountryBriefSignals } from '@/app/app-context';
import { getSourcePropagandaRisk, getSourceTier } from '@/config/feeds';
import { getCountryBbox } from '@/services/country-geometry';
import type { CountryScore } from '@/services/country-instability';
import { getNearbyInfrastructure } from '@/services/related-assets';
import type { PredictionMarket } from '@/services/prediction';
import type { AssetType, NewsItem, RelatedAsset } from '@/types';
import { sanitizeUrl } from '@/utils/sanitize';
import type { MapContainer } from './MapContainer';

type ThreatLevel = 'critical' | 'high' | 'medium' | 'low' | 'info';
type TrendDirection = 'up' | 'down' | 'flat';

export interface CountryDeepDiveSignalItem {
  type: 'MILITARY' | 'PROTEST' | 'CYBER' | 'DISASTER' | 'OUTAGE' | 'OTHER';
  severity: ThreatLevel;
  description: string;
  timestamp: Date;
}

export interface CountryDeepDiveSignalDetails {
  critical: number;
  high: number;
  medium: number;
  low: number;
  recentHigh: CountryDeepDiveSignalItem[];
}

export interface CountryDeepDiveBaseSummary {
  id: string;
  name: string;
  distanceKm: number;
  country?: string;
}

export interface CountryDeepDiveMilitarySummary {
  ownFlights: number;
  foreignFlights: number;
  nearbyVessels: number;
  nearestBases: CountryDeepDiveBaseSummary[];
  foreignPresence: boolean;
}

export interface CountryDeepDiveEconomicIndicator {
  label: string;
  value: string;
  trend: TrendDirection;
  source?: string;
}

interface CountryIntelData {
  brief: string;
  country: string;
  code: string;
  cached?: boolean;
  generatedAt?: string;
  error?: string;
  skipped?: boolean;
  reason?: string;
  fallback?: boolean;
}

interface StockIndexData {
  available: boolean;
  code: string;
  symbol: string;
  indexName: string;
  price: string;
  weekChangePercent: string;
  currency: string;
  cached?: boolean;
}

const INFRA_TYPES: AssetType[] = ['pipeline', 'cable', 'datacenter', 'base', 'nuclear'];

const INFRA_LABELS: Record<AssetType, string> = {
  pipeline: 'Pipelines',
  cable: 'Undersea Cables',
  datacenter: 'Datacenters',
  base: 'Military Bases',
  nuclear: 'Nuclear Sites',
};

const INFRA_ICONS: Record<AssetType, string> = {
  pipeline: '🛢️',
  cable: '🌐',
  datacenter: '🖥️',
  base: '🛡️',
  nuclear: '☢️',
};

const SEVERITY_ORDER: Record<ThreatLevel, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

export class CountryDeepDivePanel {
  private panel: HTMLElement;
  private content: HTMLElement;
  private closeButton: HTMLButtonElement;
  private currentCode: string | null = null;
  private currentName: string | null = null;
  private onCloseCallback?: () => void;
  private onShareStory?: (code: string, name: string) => void;
  private onExportImage?: (code: string, name: string) => void;
  private map: MapContainer | null;
  private abortController: AbortController = new AbortController();
  private lastFocusedElement: HTMLElement | null = null;
  private economicIndicators: CountryDeepDiveEconomicIndicator[] = [];
  private infrastructureByType = new Map<AssetType, RelatedAsset[]>();

  private signalsBody: HTMLElement | null = null;
  private signalBreakdownBody: HTMLElement | null = null;
  private signalRecentBody: HTMLElement | null = null;
  private newsBody: HTMLElement | null = null;
  private militaryBody: HTMLElement | null = null;
  private infrastructureBody: HTMLElement | null = null;
  private economicBody: HTMLElement | null = null;
  private marketsBody: HTMLElement | null = null;
  private briefBody: HTMLElement | null = null;

  private readonly handleGlobalKeydown = (event: KeyboardEvent): void => {
    if (!this.panel.classList.contains('active')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.hide();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = this.getFocusableElements();
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;

    const current = document.activeElement as HTMLElement | null;
    if (event.shiftKey && current === first) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus();
    }
  };

  constructor(map: MapContainer | null = null) {
    this.map = map;
    this.panel = this.getOrCreatePanel();

    const content = this.panel.querySelector<HTMLElement>('#deep-dive-content');
    const closeButton = this.panel.querySelector<HTMLButtonElement>('#deep-dive-close');
    if (!content || !closeButton) {
      throw new Error('Country deep-dive panel structure is invalid');
    }
    this.content = content;
    this.closeButton = closeButton;

    this.closeButton.addEventListener('click', () => this.hide());
  }

  public setMap(map: MapContainer | null): void {
    this.map = map;
  }

  public setShareStoryHandler(handler: (code: string, name: string) => void): void {
    this.onShareStory = handler;
  }

  public setExportImageHandler(handler: (code: string, name: string) => void): void {
    this.onExportImage = handler;
  }

  public get signal(): AbortSignal {
    return this.abortController.signal;
  }

  public showLoading(): void {
    this.currentCode = '__loading__';
    this.currentName = null;
    this.renderLoading();
    this.open();
  }

  public show(country: string, code: string, score: CountryScore | null, signals: CountryBriefSignals): void {
    this.abortController.abort();
    this.abortController = new AbortController();
    this.currentCode = code;
    this.currentName = country;
    this.economicIndicators = [];
    this.infrastructureByType.clear();
    this.renderSkeleton(country, code, score, signals);
    this.open();
  }

  public hide(): void {
    this.abortController.abort();
    this.close();
    this.currentCode = null;
    this.currentName = null;
    this.onCloseCallback?.();
  }

  public onClose(cb: () => void): void {
    this.onCloseCallback = cb;
  }

  public isVisible(): boolean {
    return this.panel.classList.contains('active');
  }

  public getCode(): string | null {
    return this.currentCode;
  }

  public getName(): string | null {
    return this.currentName;
  }

  public getTimelineMount(): HTMLElement | null {
    return null;
  }

  public updateSignalDetails(details: CountryDeepDiveSignalDetails): void {
    if (!this.signalBreakdownBody || !this.signalRecentBody) return;
    this.renderSignalBreakdown(details);
    this.renderRecentSignals(details.recentHigh);
  }

  public updateNews(headlines: NewsItem[]): void {
    if (!this.newsBody) return;
    this.newsBody.replaceChildren();

    const items = [...headlines]
      .sort((a, b) => {
        const sa = SEVERITY_ORDER[this.toThreatLevel(a.threat?.level)];
        const sb = SEVERITY_ORDER[this.toThreatLevel(b.threat?.level)];
        if (sb !== sa) return sb - sa;
        return this.toTimestamp(b.pubDate) - this.toTimestamp(a.pubDate);
      })
      .slice(0, 5);

    if (items.length === 0) {
      this.newsBody.append(this.makeEmpty('No recent country-specific coverage.'));
      return;
    }

    for (const item of items) {
      const row = this.el('a', 'cdp-news-item');
      const href = sanitizeUrl(item.link);
      if (href) {
        row.setAttribute('href', href);
        row.setAttribute('target', '_blank');
        row.setAttribute('rel', 'noopener');
      } else {
        row.removeAttribute('href');
      }

      const top = this.el('div', 'cdp-news-top');
      const tier = item.tier ?? getSourceTier(item.source);
      top.append(this.badge(`Tier ${tier}`, `cdp-tier-badge tier-${Math.max(1, Math.min(4, tier))}`));

      const severity = this.toThreatLevel(item.threat?.level);
      top.append(this.badge(severity.toUpperCase(), `cdp-severity-badge sev-${severity}`));

      const risk = getSourcePropagandaRisk(item.source);
      if (risk.stateAffiliated) {
        top.append(this.badge(`State-affiliated: ${risk.stateAffiliated}`, 'cdp-state-badge'));
      }

      const title = this.el('div', 'cdp-news-title', item.title);
      const meta = this.el('div', 'cdp-news-meta', `${item.source} • ${this.formatRelativeTime(item.pubDate)}`);
      row.append(top, title, meta);
      this.newsBody.append(row);
    }
  }

  public updateMilitaryActivity(summary: CountryDeepDiveMilitarySummary): void {
    if (!this.militaryBody) return;
    this.militaryBody.replaceChildren();

    const stats = this.el('div', 'cdp-military-grid');
    stats.append(
      this.metric('Own Flights', String(summary.ownFlights), 'cdp-chip-neutral'),
      this.metric('Foreign Flights', String(summary.foreignFlights), summary.foreignFlights > 0 ? 'cdp-chip-danger' : 'cdp-chip-neutral'),
      this.metric('Naval Vessels', String(summary.nearbyVessels), 'cdp-chip-neutral'),
      this.metric('Foreign Presence', summary.foreignPresence ? 'Detected' : 'No', summary.foreignPresence ? 'cdp-chip-danger' : 'cdp-chip-success'),
    );
    this.militaryBody.append(stats);

    const basesTitle = this.el('div', 'cdp-subtitle', 'Nearest Military Bases');
    this.militaryBody.append(basesTitle);

    if (summary.nearestBases.length === 0) {
      this.militaryBody.append(this.makeEmpty('No nearby bases within 600 km.'));
      return;
    }

    const list = this.el('ul', 'cdp-base-list');
    for (const base of summary.nearestBases.slice(0, 3)) {
      const item = this.el('li', 'cdp-base-item');
      const left = this.el('span', 'cdp-base-name', base.name);
      const right = this.el('span', 'cdp-base-distance', `${Math.round(base.distanceKm)} km`);
      item.append(left, right);
      list.append(item);
    }
    this.militaryBody.append(list);
  }

  public updateInfrastructure(countryCode: string): void {
    if (!this.infrastructureBody) return;
    this.infrastructureBody.replaceChildren();

    const centroid = this.countryCentroid(countryCode);
    if (!centroid) {
      this.infrastructureBody.append(this.makeEmpty('No geometry available for infrastructure correlation.'));
      return;
    }

    const assets = getNearbyInfrastructure(centroid.lat, centroid.lon, INFRA_TYPES);
    if (assets.length === 0) {
      this.infrastructureBody.append(this.makeEmpty('No critical infrastructure found within 600 km.'));
      return;
    }

    this.infrastructureByType.clear();
    for (const type of INFRA_TYPES) {
      const matches = assets.filter((asset) => asset.type === type);
      this.infrastructureByType.set(type, matches);
    }

    const grid = this.el('div', 'cdp-infra-grid');
    for (const type of INFRA_TYPES) {
      const list = this.infrastructureByType.get(type) ?? [];
      if (list.length === 0) continue;
      const card = this.el('button', 'cdp-infra-card');
      card.setAttribute('type', 'button');
      card.addEventListener('click', () => this.highlightInfrastructure(type));

      const icon = this.el('span', 'cdp-infra-icon', INFRA_ICONS[type]);
      const label = this.el('span', 'cdp-infra-label', INFRA_LABELS[type]);
      const count = this.el('span', 'cdp-infra-count', String(list.length));
      card.append(icon, label, count);
      grid.append(card);
    }
    this.infrastructureBody.append(grid);
  }

  public updateEconomicIndicators(indicators: CountryDeepDiveEconomicIndicator[]): void {
    this.economicIndicators = indicators;
    this.renderEconomicIndicators();
  }

  public updateStock(data: StockIndexData): void {
    if (!data.available) {
      this.renderEconomicIndicators();
      return;
    }

    const delta = Number.parseFloat(data.weekChangePercent);
    const trend: TrendDirection = Number.isFinite(delta)
      ? delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'
      : 'flat';

    const base = this.economicIndicators.filter((item) => item.label !== 'Stock Index');
    base.unshift({
      label: 'Stock Index',
      value: `${data.indexName}: ${data.price} ${data.currency}`,
      trend,
      source: 'Market Service',
    });
    this.economicIndicators = base.slice(0, 3);
    this.renderEconomicIndicators();
  }

  public updateMarkets(markets: PredictionMarket[]): void {
    if (!this.marketsBody) return;
    this.marketsBody.replaceChildren();

    if (markets.length === 0) {
      this.marketsBody.append(this.makeEmpty('No active markets for this country.'));
      return;
    }

    for (const market of markets.slice(0, 5)) {
      const item = this.el('div', 'cdp-market-item');
      const top = this.el('div', 'cdp-market-top');
      const title = this.el('div', 'cdp-market-title', market.title);
      top.append(title);

      const link = sanitizeUrl(market.url || '');
      if (link) {
        const anchor = this.el('a', 'cdp-market-link', 'Open');
        anchor.setAttribute('href', link);
        anchor.setAttribute('target', '_blank');
        anchor.setAttribute('rel', 'noopener');
        top.append(anchor);
      }

      const prob = this.el('div', 'cdp-market-prob', `Probability: ${Math.round(market.yesPrice)}%`);
      const meta = this.el('div', 'cdp-market-meta', market.endDate ? `Ends ${this.shortDate(market.endDate)}` : 'Active');
      item.append(top, prob, meta);
      this.marketsBody.append(item);
    }
  }

  public updateBrief(data: CountryIntelData): void {
    if (!this.briefBody || data.code !== this.currentCode) return;
    this.briefBody.replaceChildren();

    if (data.error || data.skipped || !data.brief) {
      this.briefBody.append(this.makeEmpty(data.error || data.reason || 'Assessment unavailable.'));
      return;
    }

    const summary = this.summarizeBrief(data.brief);
    const text = this.el('p', 'cdp-assessment-text', summary);
    const metaTokens: string[] = [];
    if (data.cached) metaTokens.push('Cached');
    if (data.fallback) metaTokens.push('Fallback');
    if (data.generatedAt) metaTokens.push(`Updated ${new Date(data.generatedAt).toLocaleTimeString()}`);
    const meta = this.el('div', 'cdp-assessment-meta', metaTokens.join(' • '));
    this.briefBody.append(text, meta);
  }

  private renderLoading(): void {
    this.content.replaceChildren();
    const loading = this.el('div', 'cdp-loading');
    loading.append(
      this.el('div', 'cdp-loading-title', 'Locating country…'),
      this.el('div', 'cdp-loading-line'),
      this.el('div', 'cdp-loading-line cdp-loading-line-short'),
    );
    this.content.append(loading);
  }

  private renderSkeleton(country: string, code: string, score: CountryScore | null, signals: CountryBriefSignals): void {
    this.content.replaceChildren();

    const shell = this.el('div', 'cdp-shell');
    const header = this.el('header', 'cdp-header');
    const left = this.el('div', 'cdp-header-left');
    const flag = this.el('span', 'cdp-flag', CountryDeepDivePanel.toFlagEmoji(code));
    const titleWrap = this.el('div', 'cdp-title-wrap');
    const name = this.el('h2', 'cdp-country-name', country);
    const subtitle = this.el('div', 'cdp-country-subtitle', `${code.toUpperCase()} • Country Intelligence`);
    titleWrap.append(name, subtitle);
    left.append(flag, titleWrap);

    const right = this.el('div', 'cdp-header-right');
    const storyButton = this.el('button', 'cdp-action-btn', 'Story') as HTMLButtonElement;
    storyButton.setAttribute('type', 'button');
    storyButton.addEventListener('click', () => {
      if (this.onShareStory && this.currentCode && this.currentName) {
        this.onShareStory(this.currentCode, this.currentName);
      }
    });

    const exportButton = this.el('button', 'cdp-action-btn', 'Export') as HTMLButtonElement;
    exportButton.setAttribute('type', 'button');
    exportButton.addEventListener('click', () => {
      if (this.onExportImage && this.currentCode && this.currentName) {
        this.onExportImage(this.currentCode, this.currentName);
      }
    });
    right.append(storyButton, exportButton);
    header.append(left, right);

    const scoreCard = this.el('section', 'cdp-card cdp-score-card');
    const top = this.el('div', 'cdp-score-top');
    const label = this.el('span', 'cdp-score-label', 'Country Instability Index');
    const updated = this.el('span', 'cdp-updated', `Updated ${this.shortDate(score?.lastUpdated ?? new Date())}`);
    top.append(label, updated);
    scoreCard.append(top);

    if (score) {
      const band = this.ciiBand(score.score);
      const value = this.el('div', `cdp-score-value cii-${band}`, `${score.score}/100`);
      const trend = this.el('div', 'cdp-trend', `Trend ${this.trendArrow(score.trend)} ${score.trend}`);
      scoreCard.append(value, trend);
    } else {
      scoreCard.append(this.makeEmpty('CII score unavailable for this country.'));
    }

    const bodyGrid = this.el('div', 'cdp-grid');
    const [signalsCard, signalBody] = this.sectionCard('Active Signals');
    const [newsCard, newsBody] = this.sectionCard('Recent News');
    const [militaryCard, militaryBody] = this.sectionCard('Military Activity');
    const [infraCard, infraBody] = this.sectionCard('Infrastructure Risk');
    const [economicCard, economicBody] = this.sectionCard('Economic Indicators');
    const [marketsCard, marketsBody] = this.sectionCard('Prediction Markets');
    const [briefCard, briefBody] = this.sectionCard('AI Assessment');

    this.signalsBody = signalBody;
    this.newsBody = newsBody;
    this.militaryBody = militaryBody;
    this.infrastructureBody = infraBody;
    this.economicBody = economicBody;
    this.marketsBody = marketsBody;
    this.briefBody = briefBody;

    this.renderInitialSignals(signals);
    newsBody.append(this.makeLoading('Loading country headlines…'));
    militaryBody.append(this.makeLoading('Loading flights, vessels, and nearby bases…'));
    infraBody.append(this.makeLoading('Computing nearby critical infrastructure…'));
    economicBody.append(this.makeLoading('Loading available indicators…'));
    marketsBody.append(this.makeLoading('Loading active markets…'));
    briefBody.append(this.makeLoading('Generating analytical assessment…'));

    bodyGrid.append(signalsCard, newsCard, militaryCard, infraCard, economicCard, marketsCard, briefCard);
    shell.append(header, scoreCard, bodyGrid);
    this.content.append(shell);
  }

  private renderInitialSignals(signals: CountryBriefSignals): void {
    if (!this.signalsBody) return;
    this.signalsBody.replaceChildren();

    this.signalBreakdownBody = this.el('div', 'cdp-signal-breakdown');
    this.signalRecentBody = this.el('div', 'cdp-signal-recent');
    this.signalsBody.append(this.signalBreakdownBody, this.signalRecentBody);

    const seeded: CountryDeepDiveSignalDetails = {
      critical: signals.criticalNews + Math.max(0, signals.activeStrikes),
      high: signals.militaryFlights + signals.militaryVessels + signals.protests,
      medium: signals.outages + signals.cyberThreats + signals.aisDisruptions,
      low: signals.earthquakes + signals.temporalAnomalies + signals.satelliteFires,
      recentHigh: [],
    };
    this.renderSignalBreakdown(seeded);
    this.signalRecentBody.append(this.makeLoading('Loading top high-severity signals…'));
  }

  private renderSignalBreakdown(details: CountryDeepDiveSignalDetails): void {
    if (!this.signalBreakdownBody) return;
    this.signalBreakdownBody.replaceChildren();

    this.signalBreakdownBody.append(
      this.metric('Critical', String(details.critical), 'cdp-chip-danger'),
      this.metric('High', String(details.high), 'cdp-chip-warn'),
      this.metric('Medium', String(details.medium), 'cdp-chip-neutral'),
      this.metric('Low', String(details.low), 'cdp-chip-success'),
    );
  }

  private renderRecentSignals(items: CountryDeepDiveSignalItem[]): void {
    if (!this.signalRecentBody) return;
    this.signalRecentBody.replaceChildren();

    if (items.length === 0) {
      this.signalRecentBody.append(this.makeEmpty('No recent high-severity signals.'));
      return;
    }

    for (const item of items.slice(0, 3)) {
      const row = this.el('div', 'cdp-signal-item');
      const line = this.el('div', 'cdp-signal-line');
      line.append(
        this.badge(item.type, 'cdp-type-badge'),
        this.badge(item.severity.toUpperCase(), `cdp-severity-badge sev-${item.severity}`),
      );
      const desc = this.el('div', 'cdp-signal-desc', item.description);
      const ts = this.el('div', 'cdp-signal-time', this.formatRelativeTime(item.timestamp));
      row.append(line, desc, ts);
      this.signalRecentBody.append(row);
    }
  }

  private renderEconomicIndicators(): void {
    if (!this.economicBody) return;
    this.economicBody.replaceChildren();

    if (this.economicIndicators.length === 0) {
      this.economicBody.append(this.makeEmpty('No country-specific indicators available.'));
      return;
    }

    for (const indicator of this.economicIndicators.slice(0, 3)) {
      const row = this.el('div', 'cdp-economic-item');
      const top = this.el('div', 'cdp-economic-top');
      top.append(
        this.el('span', 'cdp-economic-label', indicator.label),
        this.el('span', `cdp-trend-token trend-${indicator.trend}`, this.trendArrowFromDirection(indicator.trend)),
      );
      const value = this.el('div', 'cdp-economic-value', indicator.value);
      row.append(top, value);
      if (indicator.source) {
        row.append(this.el('div', 'cdp-economic-source', indicator.source));
      }
      this.economicBody.append(row);
    }
  }

  private highlightInfrastructure(type: AssetType): void {
    if (!this.map) return;
    const assets = this.infrastructureByType.get(type) ?? [];
    if (assets.length === 0) return;
    this.map.flashAssets(type, assets.map((asset) => asset.id));
  }

  private open(): void {
    if (this.panel.classList.contains('active')) return;
    this.lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.panel.classList.add('active');
    this.panel.setAttribute('aria-hidden', 'false');
    document.addEventListener('keydown', this.handleGlobalKeydown);
    requestAnimationFrame(() => this.closeButton.focus());
  }

  private close(): void {
    if (!this.panel.classList.contains('active')) return;
    this.panel.classList.remove('active');
    this.panel.setAttribute('aria-hidden', 'true');
    document.removeEventListener('keydown', this.handleGlobalKeydown);
    if (this.lastFocusedElement) this.lastFocusedElement.focus();
  }

  private getFocusableElements(): HTMLElement[] {
    const selectors = 'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
    return Array.from(this.panel.querySelectorAll<HTMLElement>(selectors))
      .filter((el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true');
  }

  private getOrCreatePanel(): HTMLElement {
    const existing = document.getElementById('country-deep-dive-panel');
    if (existing) return existing;

    const panel = this.el('aside', 'country-deep-dive');
    panel.id = 'country-deep-dive-panel';
    panel.setAttribute('aria-label', 'Country Intelligence');
    panel.setAttribute('aria-hidden', 'true');

    const shell = this.el('div', 'country-deep-dive-shell');
    const close = this.el('button', 'panel-close', '×') as HTMLButtonElement;
    close.id = 'deep-dive-close';
    close.setAttribute('aria-label', 'Close');

    const content = this.el('div', 'panel-content');
    content.id = 'deep-dive-content';
    shell.append(close, content);
    panel.append(shell);
    document.body.append(panel);
    return panel;
  }

  private sectionCard(title: string): [HTMLElement, HTMLElement] {
    const card = this.el('section', 'cdp-card');
    const heading = this.el('h3', 'cdp-card-title', title);
    const body = this.el('div', 'cdp-card-body');
    card.append(heading, body);
    return [card, body];
  }

  private metric(label: string, value: string, chipClass: string): HTMLElement {
    const box = this.el('div', 'cdp-metric');
    box.append(
      this.el('span', 'cdp-metric-label', label),
      this.badge(value, `cdp-metric-value ${chipClass}`),
    );
    return box;
  }

  private makeLoading(text: string): HTMLElement {
    const wrap = this.el('div', 'cdp-loading-inline');
    wrap.append(
      this.el('div', 'cdp-loading-line'),
      this.el('div', 'cdp-loading-line cdp-loading-line-short'),
      this.el('span', 'cdp-loading-text', text),
    );
    return wrap;
  }

  private makeEmpty(text: string): HTMLElement {
    return this.el('div', 'cdp-empty', text);
  }

  private badge(text: string, className: string): HTMLElement {
    return this.el('span', className, text);
  }

  private summarizeBrief(brief: string): string {
    const normalized = brief.replace(/\s+/g, ' ').trim();
    const sentences = normalized.split(/(?<=[.!?])\s+/).filter((part) => part.length > 0);
    return sentences.slice(0, 3).join(' ') || normalized;
  }

  private trendArrow(trend: CountryScore['trend']): string {
    if (trend === 'rising') return '↑';
    if (trend === 'falling') return '↓';
    return '→';
  }

  private trendArrowFromDirection(trend: TrendDirection): string {
    if (trend === 'up') return '↑';
    if (trend === 'down') return '↓';
    return '→';
  }

  private ciiBand(score: number): 'stable' | 'elevated' | 'high' | 'critical' {
    if (score <= 25) return 'stable';
    if (score <= 50) return 'elevated';
    if (score <= 75) return 'high';
    return 'critical';
  }

  private countryCentroid(code: string): { lat: number; lon: number } | null {
    const bbox = getCountryBbox(code);
    if (!bbox) return null;
    const [minLon, minLat, maxLon, maxLat] = bbox;
    return {
      lat: (minLat + maxLat) / 2,
      lon: (minLon + maxLon) / 2,
    };
  }

  private toThreatLevel(level: string | undefined): ThreatLevel {
    if (level === 'critical' || level === 'high' || level === 'medium' || level === 'low' || level === 'info') {
      return level;
    }
    return 'low';
  }

  private toTimestamp(date: Date): number {
    return Number.isFinite(date.getTime()) ? date.getTime() : 0;
  }

  private shortDate(value: Date | string): string {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return 'Unknown';
    return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  private formatRelativeTime(value: Date): string {
    const ms = Date.now() - this.toTimestamp(value);
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  private el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  public static toFlagEmoji(code: string): string {
    const upperCode = code.toUpperCase();
    if (!/^[A-Z]{2}$/.test(upperCode)) return '🌍';
    return upperCode
      .split('')
      .map((char) => String.fromCodePoint(0x1f1e6 + char.charCodeAt(0) - 65))
      .join('');
  }
}
