import type { CountryBriefSignals } from '@/app/app-context';
import { getSourcePropagandaRisk, getSourceTier } from '@/config/feeds';
import { getCountryCentroid, ME_STRIKE_BOUNDS } from '@/services/country-geometry';
import type { CountryScore } from '@/services/country-instability';
import { t } from '@/services/i18n';
import { getNearbyInfrastructure } from '@/services/related-assets';
import type { PredictionMarket } from '@/services/prediction';
import type { AssetType, NewsItem, RelatedAsset } from '@/types';
import { sanitizeUrl, escapeHtml } from '@/utils/sanitize';
import { getCSSColor } from '@/utils';
import { PORTS } from '@/config/ports';
import { haversineDistanceKm } from '@/services/related-assets';
import type {
  CountryBriefPanel,
  CountryIntelData,
  StockIndexData,
  CountryDeepDiveSignalDetails,
  CountryDeepDiveSignalItem,
  CountryDeepDiveMilitarySummary,
  CountryDeepDiveEconomicIndicator,
  CountryFactsData,
} from './CountryBriefPanel';
import type { MapContainer } from './MapContainer';

type ThreatLevel = 'critical' | 'high' | 'medium' | 'low' | 'info';
type TrendDirection = 'up' | 'down' | 'flat';

const INFRA_TYPES: AssetType[] = ['pipeline', 'cable', 'datacenter', 'base', 'nuclear'];

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

export class CountryDeepDivePanel implements CountryBriefPanel {
  private panel: HTMLElement;
  private content: HTMLElement;
  private closeButton: HTMLButtonElement;
  private currentCode: string | null = null;
  private currentName: string | null = null;
  private isMaximizedState = false;
  private onCloseCallback?: () => void;
  private onStateChangeCallback?: (state: { visible: boolean; maximized: boolean }) => void;
  private onShareStory?: (code: string, name: string) => void;
  private onExportImage?: (code: string, name: string) => void;
  private map: MapContainer | null;
  private abortController: AbortController = new AbortController();
  private lastFocusedElement: HTMLElement | null = null;
  private economicIndicators: CountryDeepDiveEconomicIndicator[] = [];
  private infrastructureByType = new Map<AssetType, RelatedAsset[]>();
  private maximizeButton: HTMLButtonElement | null = null;
  private currentHeadlineCount = 0;

  private signalsBody: HTMLElement | null = null;
  private signalBreakdownBody: HTMLElement | null = null;
  private signalRecentBody: HTMLElement | null = null;
  private newsBody: HTMLElement | null = null;
  private militaryBody: HTMLElement | null = null;
  private infrastructureBody: HTMLElement | null = null;
  private economicBody: HTMLElement | null = null;
  private marketsBody: HTMLElement | null = null;
  private briefBody: HTMLElement | null = null;
  private timelineBody: HTMLElement | null = null;
  private scoreCard: HTMLElement | null = null;
  private factsBody: HTMLElement | null = null;

  private readonly handleGlobalKeydown = (event: KeyboardEvent): void => {
    if (!this.panel.classList.contains('active')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (this.isMaximizedState) {
        this.minimize();
      } else {
        this.hide();
      }
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

    this.panel.addEventListener('click', (e) => {
      if (this.isMaximizedState && !(e.target as HTMLElement).closest('.panel-content')) {
        this.minimize();
      }
    });
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

  public showGeoError(onRetry: () => void): void {
    this.currentCode = '__error__';
    this.currentName = null;
    this.content.replaceChildren();

    const wrapper = this.el('div', 'cdp-geo-error');
    wrapper.append(
      this.el('div', 'cdp-geo-error-icon', '\u26A0\uFE0F'),
      this.el('div', 'cdp-geo-error-msg', t('countryBrief.geocodeFailed')),
    );

    const actions = this.el('div', 'cdp-geo-error-actions');

    const retryBtn = this.el('button', 'cdp-geo-error-retry', t('countryBrief.retryBtn')) as HTMLButtonElement;
    retryBtn.type = 'button';
    retryBtn.addEventListener('click', () => onRetry(), { once: true });

    const closeBtn = this.el('button', 'cdp-geo-error-close', t('countryBrief.closeBtn')) as HTMLButtonElement;
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', () => this.hide(), { once: true });

    actions.append(retryBtn, closeBtn);
    wrapper.append(actions);
    this.content.append(wrapper);
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
    if (this.isMaximizedState) {
      this.isMaximizedState = false;
      this.panel.classList.remove('maximized');
      if (this.maximizeButton) this.maximizeButton.textContent = '\u26F6';
    }
    this.abortController.abort();
    this.close();
    this.currentCode = null;
    this.currentName = null;
    this.onCloseCallback?.();
    this.onStateChangeCallback?.({ visible: false, maximized: false });
  }

  public onClose(cb: () => void): void {
    this.onCloseCallback = cb;
  }

  public onStateChange(cb: (state: { visible: boolean; maximized: boolean }) => void): void {
    this.onStateChangeCallback = cb;
  }

  public maximize(): void {
    if (this.isMaximizedState) return;
    this.isMaximizedState = true;
    this.panel.classList.add('maximized');
    if (this.maximizeButton) this.maximizeButton.textContent = '\u229F';
    this.onStateChangeCallback?.({ visible: true, maximized: true });
  }

  public minimize(): void {
    if (!this.isMaximizedState) return;
    this.isMaximizedState = false;
    this.panel.classList.remove('maximized');
    if (this.maximizeButton) this.maximizeButton.textContent = '\u26F6';
    this.onStateChangeCallback?.({ visible: true, maximized: false });
  }

  public getIsMaximized(): boolean {
    return this.isMaximizedState;
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
    return this.timelineBody;
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
      .slice(0, 10);

    this.currentHeadlineCount = items.length;

    if (items.length === 0) {
      this.newsBody.append(this.makeEmpty(t('countryBrief.noNews')));
      return;
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const row = this.el('a', 'cdp-news-item');
      row.id = `cdp-news-${i + 1}`;
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
      const levelKey = severity === 'info' ? 'low' : severity === 'medium' ? 'moderate' : severity;
      const severityLabel = t(`countryBrief.levels.${levelKey}`);
      top.append(this.badge(severityLabel.toUpperCase(), `cdp-severity-badge sev-${severity}`));

      const risk = getSourcePropagandaRisk(item.source);
      if (risk.stateAffiliated) {
        top.append(this.badge(`State-affiliated: ${risk.stateAffiliated}`, 'cdp-state-badge'));
      }

      const title = this.el('div', 'cdp-news-title', this.decodeEntities(item.title));
      const meta = this.el('div', 'cdp-news-meta', `${item.source} • ${this.formatRelativeTime(item.pubDate)}`);
      row.append(top, title, meta);

      if (i >= 5) {
        const wrapper = this.el('div', 'cdp-expanded-only');
        wrapper.append(row);
        this.newsBody.append(wrapper);
      } else {
        this.newsBody.append(row);
      }
    }
  }

  public updateMilitaryActivity(summary: CountryDeepDiveMilitarySummary): void {
    if (!this.militaryBody) return;
    this.militaryBody.replaceChildren();

    const stats = this.el('div', 'cdp-military-grid');
    stats.append(
      this.metric(t('countryBrief.ownFlights'), String(summary.ownFlights), 'cdp-chip-neutral'),
      this.metric(t('countryBrief.foreignFlights'), String(summary.foreignFlights), summary.foreignFlights > 0 ? 'cdp-chip-danger' : 'cdp-chip-neutral'),
      this.metric(t('countryBrief.navalVessels'), String(summary.nearbyVessels), 'cdp-chip-neutral'),
      this.metric(t('countryBrief.foreignPresence'), summary.foreignPresence ? t('countryBrief.detected') : t('countryBrief.notDetected'), summary.foreignPresence ? 'cdp-chip-danger' : 'cdp-chip-success'),
    );
    this.militaryBody.append(stats);

    const basesTitle = this.el('div', 'cdp-subtitle', t('countryBrief.nearestBases'));
    this.militaryBody.append(basesTitle);

    if (summary.nearestBases.length === 0) {
      this.militaryBody.append(this.makeEmpty(t('countryBrief.noBasesNearby')));
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

    const centroid = getCountryCentroid(countryCode, ME_STRIKE_BOUNDS);
    if (!centroid) {
      this.infrastructureBody.append(this.makeEmpty(t('countryBrief.noGeometry')));
      return;
    }

    const assets = getNearbyInfrastructure(centroid.lat, centroid.lon, INFRA_TYPES);
    if (assets.length === 0) {
      this.infrastructureBody.append(this.makeEmpty(t('countryBrief.noInfrastructure')));
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
      const label = this.el('span', 'cdp-infra-label', t(`countryBrief.infra.${type}`));
      const count = this.el('span', 'cdp-infra-count', String(list.length));
      card.append(icon, label, count);
      grid.append(card);
    }
    this.infrastructureBody.append(grid);

    const expandedDetails = this.el('div', 'cdp-expanded-only');
    for (const type of INFRA_TYPES) {
      const list = this.infrastructureByType.get(type) ?? [];
      if (list.length === 0) continue;
      const typeLabel = this.el('div', 'cdp-subtitle', `${INFRA_ICONS[type]} ${t(`countryBrief.infra.${type}`)}`);
      expandedDetails.append(typeLabel);
      const ul = this.el('ul', 'cdp-base-list');
      for (const asset of list.slice(0, 5)) {
        const li = this.el('li', 'cdp-base-item');
        li.append(
          this.el('span', 'cdp-base-name', asset.name),
          this.el('span', 'cdp-base-distance', `${Math.round(asset.distanceKm)} km`),
        );
        ul.append(li);
      }
      expandedDetails.append(ul);
    }

    const nearbyPorts = PORTS
      .map((port) => ({
        ...port,
        distanceKm: haversineDistanceKm(centroid.lat, centroid.lon, port.lat, port.lon),
      }))
      .filter((port) => port.distanceKm <= 1500)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 5);

    if (nearbyPorts.length > 0) {
      const portsTitle = this.el('div', 'cdp-subtitle', `\u2693 ${t('countryBrief.nearbyPorts')}`);
      expandedDetails.append(portsTitle);
      const portList = this.el('ul', 'cdp-base-list');
      for (const port of nearbyPorts) {
        const li = this.el('li', 'cdp-base-item');
        li.append(
          this.el('span', 'cdp-base-name', `${port.name} (${port.type})`),
          this.el('span', 'cdp-base-distance', `${Math.round(port.distanceKm)} km`),
        );
        portList.append(li);
      }
      expandedDetails.append(portList);
    }

    this.infrastructureBody.append(expandedDetails);
  }

  public updateEconomicIndicators(indicators: CountryDeepDiveEconomicIndicator[]): void {
    this.economicIndicators = indicators;
    this.renderEconomicIndicators();
  }

  public updateCountryFacts(data: CountryFactsData): void {
    if (!this.factsBody) return;
    this.factsBody.replaceChildren();

    if (!data.headOfState && !data.wikipediaSummary && data.population === 0 && !data.capital) {
      this.factsBody.append(this.makeEmpty(t('countryBrief.noFacts')));
      return;
    }

    if (data.wikipediaThumbnailUrl) {
      const img = this.el('img', 'cdp-facts-thumbnail');
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.src = sanitizeUrl(data.wikipediaThumbnailUrl);
      this.factsBody.append(img);
    }

    if (data.wikipediaSummary) {
      const summaryText = data.wikipediaSummary.length > 300
        ? data.wikipediaSummary.slice(0, 300) + '...'
        : data.wikipediaSummary;
      this.factsBody.append(this.el('p', 'cdp-facts-summary', summaryText));
    }

    const grid = this.el('div', 'cdp-facts-grid');

    const popStr = data.population >= 1_000_000_000
      ? `${(data.population / 1_000_000_000).toFixed(1)}B`
      : data.population >= 1_000_000
        ? `${(data.population / 1_000_000).toFixed(1)}M`
        : data.population.toLocaleString();
    grid.append(this.factItem(t('countryBrief.facts.population'), popStr));
    grid.append(this.factItem(t('countryBrief.facts.capital'), data.capital));
    grid.append(this.factItem(t('countryBrief.facts.area'), `${data.areaSqKm.toLocaleString()} km\u00B2`));

    const rawTitle = data.headOfStateTitle || '';
    const hosLabel = rawTitle.length > 30 ? t('countryBrief.facts.headOfState') : (rawTitle || t('countryBrief.facts.headOfState'));
    grid.append(this.factItem(hosLabel, data.headOfState));
    grid.append(this.factItem(t('countryBrief.facts.languages'), data.languages.join(', ')));
    grid.append(this.factItem(t('countryBrief.facts.currencies'), data.currencies.join(', ')));

    this.factsBody.append(grid);
  }

  private factItem(label: string, value: string): HTMLElement {
    const wrapper = this.el('div', 'cdp-fact-item');
    wrapper.append(this.el('div', 'cdp-fact-label', label));
    wrapper.append(this.el('div', '', value));
    return wrapper;
  }

  public updateScore(score: CountryScore | null, _signals: CountryBriefSignals): void {
    if (!this.scoreCard) return;
    // Partial DOM update: score number, level color, trend, component bars only
    const top = this.scoreCard.firstElementChild as HTMLElement | null;
    while (this.scoreCard.childElementCount > 1) {
      this.scoreCard.lastElementChild?.remove();
    }
    if (top) {
      const updatedEl = top.querySelector('.cdp-updated');
      if (updatedEl) updatedEl.textContent = `Updated ${this.shortDate(score?.lastUpdated ?? new Date())}`;
    }
    if (score) {
      const band = this.ciiBand(score.score);
      const scoreRow = this.el('div', 'cdp-score-row');
      const value = this.el('div', `cdp-score-value cii-${band}`, `${score.score}/100`);
      const trend = this.el('div', 'cdp-trend', `${this.trendArrow(score.trend)} ${score.trend}`);
      scoreRow.append(value, trend);
      this.scoreCard.append(scoreRow);
      this.scoreCard.append(this.renderComponentBars(score.components));
    } else {
      this.scoreCard.append(this.makeEmpty(t('countryBrief.ciiUnavailable')));
    }
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
      this.marketsBody.append(this.makeEmpty(t('countryBrief.noMarkets')));
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

      const expanded = this.el('div', 'cdp-expanded-only');
      if (market.volume != null) {
        expanded.append(this.el('div', 'cdp-market-volume', `Volume: $${market.volume.toLocaleString()}`));
      }
      const yesPercent = Math.round(market.yesPrice);
      const noPercent = 100 - yesPercent;
      const bar = this.el('div', 'cdp-market-bar');
      const barYes = this.el('div', 'cdp-market-bar-yes');
      barYes.style.width = `${yesPercent}%`;
      const barNo = this.el('div', 'cdp-market-bar-no');
      barNo.style.width = `${noPercent}%`;
      bar.append(barYes, barNo);
      expanded.append(bar);
      item.append(expanded);

      this.marketsBody.append(item);
    }
  }

  public updateBrief(data: CountryIntelData): void {
    if (!this.briefBody || data.code !== this.currentCode) return;
    this.briefBody.replaceChildren();

    if (data.error || data.skipped || !data.brief) {
      this.briefBody.append(this.makeEmpty(data.error || data.reason || t('countryBrief.assessmentUnavailable')));
      return;
    }

    const summaryHtml = this.formatBrief(this.summarizeBrief(data.brief), 0);
    const text = this.el('div', 'cdp-assessment-text cdp-summary-only');
    text.innerHTML = summaryHtml;

    const metaTokens: string[] = [];
    if (data.cached) metaTokens.push('Cached');
    if (data.fallback) metaTokens.push('Fallback');
    if (data.generatedAt) metaTokens.push(`Updated ${new Date(data.generatedAt).toLocaleTimeString()}`);
    const meta = this.el('div', 'cdp-assessment-meta', metaTokens.join(' • '));
    this.briefBody.append(text, meta);

    const expandedBrief = this.el('div', 'cdp-expanded-only');
    const fullText = this.el('div', 'cdp-assessment-text');
    fullText.innerHTML = this.formatBrief(data.brief, this.currentHeadlineCount);
    expandedBrief.append(fullText);
    this.briefBody.append(expandedBrief);
  }

  private renderLoading(): void {
    this.scoreCard = null;
    this.content.replaceChildren();
    const loading = this.el('div', 'cdp-loading');
    loading.append(
      this.el('div', 'cdp-loading-title', t('countryBrief.identifying')),
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

    const maxBtn = this.el('button', 'cdp-maximize-btn', '\u26F6') as HTMLButtonElement;
    maxBtn.setAttribute('type', 'button');
    maxBtn.setAttribute('aria-label', 'Toggle maximize');
    maxBtn.addEventListener('click', () => {
      if (this.isMaximizedState) this.minimize();
      else this.maximize();
    });
    this.maximizeButton = maxBtn;

    const shareBtn = this.el('button', 'cdp-action-btn cdp-share-btn') as HTMLButtonElement;
    shareBtn.setAttribute('type', 'button');
    shareBtn.setAttribute('aria-label', t('components.countryBrief.shareLink'));
    shareBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a2 2 0 002 2h12a2 2 0 002-2v-7"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>';
    shareBtn.addEventListener('click', () => {
      if (!this.currentCode || !this.currentName) return;
      const url = `${window.location.origin}/?c=${this.currentCode}`;
      navigator.clipboard.writeText(url).then(() => {
        const orig = shareBtn.innerHTML;
        shareBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        setTimeout(() => { shareBtn.innerHTML = orig; }, 1500);
      }).catch(() => {});
    });

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
    right.append(shareBtn, maxBtn, storyButton, exportButton);
    header.append(left, right);

    const scoreCard = this.el('section', 'cdp-card cdp-score-card');
    this.scoreCard = scoreCard;
    const top = this.el('div', 'cdp-score-top');
    const label = this.el('span', 'cdp-score-label', t('countryBrief.instabilityIndex'));
    const updated = this.el('span', 'cdp-updated', `Updated ${this.shortDate(score?.lastUpdated ?? new Date())}`);
    top.append(label, updated);
    scoreCard.append(top);

    if (score) {
      const band = this.ciiBand(score.score);
      const scoreRow = this.el('div', 'cdp-score-row');
      const value = this.el('div', `cdp-score-value cii-${band}`, `${score.score}/100`);
      const trend = this.el('div', 'cdp-trend', `${this.trendArrow(score.trend)} ${score.trend}`);
      scoreRow.append(value, trend);
      scoreCard.append(scoreRow);
      scoreCard.append(this.renderComponentBars(score.components));
    } else {
      scoreCard.append(this.makeEmpty(t('countryBrief.ciiUnavailable')));
    }

    const bodyGrid = this.el('div', 'cdp-grid');
    const [signalsCard, signalBody] = this.sectionCard(t('countryBrief.activeSignals'));
    const [timelineCard, timelineBody] = this.sectionCard(t('countryBrief.timeline'));
    const [newsCard, newsBody] = this.sectionCard(t('countryBrief.topNews'));
    const [militaryCard, militaryBody] = this.sectionCard(t('countryBrief.militaryActivity'));
    const [infraCard, infraBody] = this.sectionCard(t('countryBrief.infrastructure'));
    const [economicCard, economicBody] = this.sectionCard(t('countryBrief.economicIndicators'));
    const [marketsCard, marketsBody] = this.sectionCard(t('countryBrief.predictionMarkets'));
    const [briefCard, briefBody] = this.sectionCard(t('countryBrief.intelBrief'));

    const [factsCard, factsBody] = this.sectionCard(t('countryBrief.countryFacts'));
    this.factsBody = factsBody;
    factsBody.append(this.makeLoading(t('countryBrief.loadingFacts')));
    const factsExpanded = this.el('div', 'cdp-expanded-only');
    factsExpanded.append(factsCard);

    this.signalsBody = signalBody;
    this.timelineBody = timelineBody;
    this.timelineBody.classList.add('cdp-timeline-mount');
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
    marketsBody.append(this.makeLoading(t('countryBrief.loadingMarkets')));
    briefBody.append(this.makeLoading(t('countryBrief.generatingBrief')));

    bodyGrid.append(briefCard, factsExpanded, signalsCard, timelineCard, newsCard, militaryCard, infraCard, economicCard, marketsCard);
    shell.append(header, scoreCard, bodyGrid);
    this.content.append(shell);
  }

  private renderInitialSignals(signals: CountryBriefSignals): void {
    if (!this.signalsBody) return;
    this.signalsBody.replaceChildren();

    const chips = this.el('div', 'cdp-signal-chips');
    this.addSignalChip(chips, signals.criticalNews, t('countryBrief.chips.criticalNews'), '🚨', 'conflict');
    this.addSignalChip(chips, signals.protests, t('countryBrief.chips.protests'), '📢', 'protest');
    this.addSignalChip(chips, signals.militaryFlights, t('countryBrief.chips.militaryAir'), '✈️', 'military');
    this.addSignalChip(chips, signals.militaryVessels, t('countryBrief.chips.navalVessels'), '⚓', 'military');
    this.addSignalChip(chips, signals.outages, t('countryBrief.chips.outages'), '🌐', 'outage');
    this.addSignalChip(chips, signals.aisDisruptions, t('countryBrief.chips.aisDisruptions'), '🚢', 'outage');
    this.addSignalChip(chips, signals.satelliteFires, t('countryBrief.chips.satelliteFires'), '🔥', 'climate');
    this.addSignalChip(chips, signals.temporalAnomalies, t('countryBrief.chips.temporalAnomalies'), '⏱️', 'outage');
    this.addSignalChip(chips, signals.cyberThreats, t('countryBrief.chips.cyberThreats'), '🛡️', 'conflict');
    this.addSignalChip(chips, signals.earthquakes, t('countryBrief.chips.earthquakes'), '🌍', 'quake');
    if (signals.displacementOutflow > 0) {
      const fmt = signals.displacementOutflow >= 1_000_000
        ? `${(signals.displacementOutflow / 1_000_000).toFixed(1)}M`
        : `${(signals.displacementOutflow / 1000).toFixed(0)}K`;
      chips.append(this.makeSignalChip(`🌊 ${fmt} ${t('countryBrief.chips.displaced')}`, 'displacement'));
    }
    this.addSignalChip(chips, signals.climateStress, t('countryBrief.chips.climateStress'), '🌡️', 'climate');
    this.addSignalChip(chips, signals.conflictEvents, t('countryBrief.chips.conflictEvents'), '⚔️', 'conflict');
    this.addSignalChip(chips, signals.activeStrikes, t('countryBrief.chips.activeStrikes'), '💥', 'conflict');
    if (signals.travelAdvisories > 0 && signals.travelAdvisoryMaxLevel) {
      const advLabel = signals.travelAdvisoryMaxLevel === 'do-not-travel' ? t('countryBrief.chips.doNotTravel')
        : signals.travelAdvisoryMaxLevel === 'reconsider' ? t('countryBrief.chips.reconsiderTravel')
        : t('countryBrief.chips.exerciseCaution');
      chips.append(this.makeSignalChip(`⚠️ ${signals.travelAdvisories} ${t('countryBrief.chips.advisory')}: ${advLabel}`, 'advisory'));
    }
    this.addSignalChip(chips, signals.orefSirens, t('countryBrief.chips.activeSirens'), '🚨', 'conflict');
    this.addSignalChip(chips, signals.orefHistory24h, t('countryBrief.chips.sirens24h'), '🕓', 'conflict');
    this.addSignalChip(chips, signals.aviationDisruptions, t('countryBrief.chips.aviationDisruptions'), '🚫', 'outage');
    this.addSignalChip(chips, signals.gpsJammingHexes, t('countryBrief.chips.gpsJammingZones'), '📡', 'outage');
    this.signalsBody.append(chips);

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

  private addSignalChip(container: HTMLElement, count: number, label: string, icon: string, cls: string): void {
    if (count <= 0) return;
    container.append(this.makeSignalChip(`${icon} ${count} ${label}`, cls));
  }

  private makeSignalChip(text: string, cls: string): HTMLElement {
    return this.el('span', `cdp-signal-chip chip-${cls}`, text);
  }

  private renderComponentBars(components: CountryScore['components']): HTMLElement {
    const wrap = this.el('div', 'cdp-components');
    const items = [
      { label: t('countryBrief.components.unrest'), value: components.unrest, icon: '📢' },
      { label: t('countryBrief.components.conflict'), value: components.conflict, icon: '⚔' },
      { label: t('countryBrief.components.security'), value: components.security, icon: '🛡️' },
      { label: t('countryBrief.components.information'), value: components.information, icon: '📡' },
    ];
    for (const item of items) {
      const row = this.el('div', 'cdp-score-row');
      const icon = this.el('span', 'cdp-comp-icon', item.icon);
      const label = this.el('span', 'cdp-comp-label', item.label);
      const barOuter = this.el('div', 'cdp-comp-bar');
      const pct = Math.min(100, Math.max(0, item.value));
      const color = pct >= 70 ? getCSSColor('--semantic-critical')
        : pct >= 50 ? getCSSColor('--semantic-high')
        : pct >= 30 ? getCSSColor('--semantic-elevated')
        : getCSSColor('--semantic-normal');
      const barFill = this.el('div', 'cdp-comp-fill');
      barFill.style.width = `${pct}%`;
      barFill.style.background = color;
      barOuter.append(barFill);
      const val = this.el('span', 'cdp-comp-val', String(Math.round(item.value)));
      row.append(icon, label, barOuter, val);
      wrap.append(row);
    }
    return wrap;
  }

  private renderSignalBreakdown(details: CountryDeepDiveSignalDetails): void {
    if (!this.signalBreakdownBody) return;
    this.signalBreakdownBody.replaceChildren();

    this.signalBreakdownBody.append(
      this.metric(t('countryBrief.levels.critical'), String(details.critical), 'cdp-chip-danger'),
      this.metric(t('countryBrief.levels.high'), String(details.high), 'cdp-chip-warn'),
      this.metric(t('countryBrief.levels.moderate'), String(details.medium), 'cdp-chip-neutral'),
      this.metric(t('countryBrief.levels.low'), String(details.low), 'cdp-chip-success'),
    );
  }

  private renderRecentSignals(items: CountryDeepDiveSignalItem[]): void {
    if (!this.signalRecentBody) return;
    this.signalRecentBody.replaceChildren();

    if (items.length === 0) {
      this.signalRecentBody.append(this.makeEmpty(t('countryBrief.noSignals')));
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
      this.economicBody.append(this.makeEmpty(t('countryBrief.noIndicators')));
      return;
    }

    for (const indicator of this.economicIndicators.slice(0, 3)) {
      const row = this.el('div', 'cdp-economic-item');
      const top = this.el('div', 'cdp-economic-top');
      const isMarketRow = indicator.label === 'Stock Index' || indicator.label === 'Weekly Momentum';
      const trendClass = isMarketRow ? `trend-market-${indicator.trend}` : `trend-${indicator.trend}`;
      top.append(
        this.el('span', 'cdp-economic-label', indicator.label),
        this.el('span', `cdp-trend-token ${trendClass}`, this.trendArrowFromDirection(indicator.trend)),
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
    this.onStateChangeCallback?.({ visible: true, maximized: this.isMaximizedState });
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
      .filter((el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true' && el.offsetParent !== null);
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

  private formatBrief(text: string, headlineCount = 0): string {
    let html = escapeHtml(text)
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>')
      .replace(/^/, '<p>')
      .replace(/$/, '</p>');

    if (headlineCount > 0) {
      html = html.replace(/\[(\d{1,2})\]/g, (_match, numStr) => {
        const n = parseInt(numStr, 10);
        if (n >= 1 && n <= headlineCount) {
          return `<a href="#cdp-news-${n}" class="cb-citation">[${n}]</a>`;
        }
        return `[${numStr}]`;
      });
    }

    return html;
  }

  private summarizeBrief(brief: string): string {
    const stripped = brief.replace(/\*\*(.*?)\*\*/g, '$1');
    const lines = stripped.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length >= 3) {
      return lines.slice(0, 3).join('\n');
    }
    const normalized = stripped.replace(/\s+/g, ' ').trim();
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

  private decodeEntities(text: string): string {
    return text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&#x2F;/g, '/');
  }

  private toThreatLevel(level: string | undefined): ThreatLevel {
    if (level === 'critical' || level === 'high' || level === 'medium' || level === 'low' || level === 'info') {
      return level;
    }
    return 'low';
  }

  private toTimestamp(date: Date | string): number {
    const d = date instanceof Date ? date : new Date(date);
    return Number.isFinite(d.getTime()) ? d.getTime() : 0;
  }

  private shortDate(value: Date | string): string {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return 'Unknown';
    return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  private formatRelativeTime(value: Date | string): string {
    const ms = Date.now() - this.toTimestamp(value);
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return t('countryBrief.timeAgo.m', { count: 1 });
    if (mins < 60) return t('countryBrief.timeAgo.m', { count: mins });
    const hours = Math.floor(mins / 60);
    if (hours < 24) return t('countryBrief.timeAgo.h', { count: hours });
    const days = Math.floor(hours / 24);
    return t('countryBrief.timeAgo.d', { count: days });
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
