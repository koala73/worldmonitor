import type { CountryBriefSignals } from '@/types';
import { getSourcePropagandaRisk, getSourceTier } from '@/config/feeds';
import { getCountryCentroid, ME_STRIKE_BOUNDS } from '@/services/country-geometry';
import type { CountryScore } from '@/services/country-instability';
import { t } from '@/services/i18n';
import { getCountryInfrastructure } from '@/services/related-assets';
import type { PredictionMarket } from '@/services/prediction';
import type { AssetType, NewsItem, RelatedAsset } from '@/types';
import { sanitizeUrl, escapeHtml } from '@/utils/sanitize';
import { computeAlternativeSuppliers, type ChokepointScoreMap, type EnrichedExporter } from '@/utils/supplier-route-risk';
import { formatIntelBrief } from '@/utils/format-intel-brief';
import { getCSSColor } from '@/utils';
import { toFlagEmoji } from '@/utils/country-flag';
import { PORTS } from '@/config/ports';
import { getChokepointRoutes } from '@/config/trade-routes';
import { STRATEGIC_WATERWAYS } from '@/config/geo';
import { hasPremiumAccess } from '@/services/panel-gating';
import { getAuthState } from '@/services/auth-state';
import { trackGateHit } from '@/services/analytics';
import { fetchBypassOptions, fetchChokepointStatus } from '@/services/supply-chain';
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
  CountryEnergyProfileData,
  CountryPortActivityData,
} from './CountryBriefPanel';
import type { GetCountryChokepointIndexResponse, SectorExposureSummary, CountryProductsResponse, CountryProduct } from '@/services/supply-chain';
import type { MapContainer } from './MapContainer';
import { ResilienceWidget } from './ResilienceWidget';

const DEPENDENCY_FLAG_LABELS: Record<string, { text: string; cls: string }> = {
  DEPENDENCY_FLAG_SINGLE_SOURCE_CRITICAL:   { text: 'Single Source',   cls: 'cdp-dep-critical' },
  DEPENDENCY_FLAG_SINGLE_CORRIDOR_CRITICAL: { text: 'Single Corridor', cls: 'cdp-dep-critical' },
  DEPENDENCY_FLAG_COMPOUND_RISK:            { text: 'Compound Risk',   cls: 'cdp-dep-compound' },
  DEPENDENCY_FLAG_DIVERSIFIABLE:            { text: 'Diversifiable',   cls: 'cdp-dep-ok' },
};
import { toApiUrl } from '@/services/runtime';
import type { ComputeEnergyShockScenarioResponse, ProductImpact } from '@/generated/client/worldmonitor/intelligence/v1/service_client';

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
  private resilienceWidget: ResilienceWidget | null = null;
  private energyBody: HTMLElement | null = null;
  private maritimeBody: HTMLElement | null = null;
  private tradeExposureBody: HTMLElement | null = null;
  private selectedSectorHs2: string | null = null;
  private sectorBypassAbort: AbortController | null = null;
  private cachedTradeExposureData: GetCountryChokepointIndexResponse | null = null;
  private cachedSectors: SectorExposureSummary[] = [];
  private productImportsBody: HTMLElement | null = null;
  private debtBody: HTMLElement | null = null;
  private sanctionsBody: HTMLElement | null = null;
  private comtradeBody: HTMLElement | null = null;
  private tariffBody: HTMLElement | null = null;
  private chokepointBody: HTMLElement | null = null;
  private costShockBody: HTMLElement | null = null;

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
    this.resetPanelContent();

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
    this.content.scrollTop = 0;
    this.open();
  }

  public hide(): void {
    this.destroyResilienceWidget();
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

    const assets = getCountryInfrastructure(centroid.lat, centroid.lon, countryCode, INFRA_TYPES);
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

  public updateNationalDebt(entry: { debtToGdp: number; debtUsd: number; annualGrowth: number; source: string } | null): void {
    if (!this.debtBody) return;
    this.debtBody.replaceChildren();
    if (!entry) {
      this.debtBody.append(this.makeEmpty('No national debt data available'));
      return;
    }
    const grid = this.el('div', 'cdp-pro-metric-grid');
    grid.append(
      this.proMetricBox('Debt-to-GDP', `${entry.debtToGdp.toFixed(1)}%`),
      this.proMetricBox('Total Debt', this.formatMoney(entry.debtUsd)),
      this.proMetricBox('YoY Growth', this.formatPctTrend(entry.annualGrowth)),
      this.proMetricBox('Source', entry.source),
    );
    this.debtBody.append(grid);
  }

  public updateSanctionsPressure(data: { entryCount: number; sanctionsActive?: boolean } | null): void {
    if (!this.sanctionsBody) return;
    this.sanctionsBody.replaceChildren();
    if (!data) {
      this.sanctionsBody.append(this.makeEmpty('No sanctions data available'));
      return;
    }
    const grid = this.el('div', 'cdp-pro-metric-grid');
    grid.append(
      this.proMetricBox('Sanctioned Entities', String(data.entryCount)),
      this.proMetricBox('Status', data.sanctionsActive ? 'Active' : 'None'),
    );
    this.sanctionsBody.append(grid);
  }

  public updateComtradeFlows(flows: Array<{ partnerName: string; cmdDesc: string; tradeValueUsd: number; yoyChange: number }> | null): void {
    if (!this.comtradeBody) return;
    this.comtradeBody.replaceChildren();
    if (!flows || flows.length === 0) {
      this.comtradeBody.append(this.makeEmpty('No trade flow data available'));
      return;
    }
    const table = this.el('table', 'cdp-pro-flow-table');
    const thead = this.el('thead');
    const hr = this.el('tr');
    for (const col of ['Partner', 'Commodity', 'Value', 'YoY']) {
      hr.append(this.el('th', '', col));
    }
    thead.append(hr);
    table.append(thead);
    const tbody = this.el('tbody');
    for (const f of flows.slice(0, 5)) {
      const tr = this.el('tr');
      tr.append(this.el('td', '', f.partnerName));
      const cmdTd = this.el('td', '');
      cmdTd.textContent = f.cmdDesc.length > 25 ? f.cmdDesc.slice(0, 22) + '...' : f.cmdDesc;
      cmdTd.title = f.cmdDesc;
      tr.append(cmdTd);
      tr.append(this.el('td', '', this.formatMoney(f.tradeValueUsd)));
      const yoyTd = this.el('td', f.yoyChange >= 0 ? 'cdp-pro-trend-up' : 'cdp-pro-trend-down');
      yoyTd.textContent = this.formatPctTrend(f.yoyChange);
      tr.append(yoyTd);
      tbody.append(tr);
    }
    table.append(tbody);
    this.comtradeBody.append(table);
  }

  public updateTariffTrends(data: { currentRate: number; trend: string; datapoints: Array<{ year: number; tariffRate: number }> } | null): void {
    if (!this.tariffBody) return;
    this.tariffBody.replaceChildren();
    if (!data) {
      this.tariffBody.append(this.makeEmpty('No tariff data available'));
      return;
    }
    const grid = this.el('div', 'cdp-pro-metric-grid');
    grid.append(
      this.proMetricBox('Effective Rate', `${data.currentRate.toFixed(2)}%`),
      this.proMetricBox('Trend', data.trend === 'rising' ? '\u2191 Rising' : '\u2193 Falling'),
    );
    this.tariffBody.append(grid);
  }

  public updateChokepointExposure(data: { vulnerabilityIndex: number; exposures: Array<{ chokepointName: string; exposureScore: number }> } | null): void {
    if (!this.chokepointBody) return;
    this.chokepointBody.replaceChildren();
    if (!data) {
      this.chokepointBody.append(this.makeEmpty('No chokepoint exposure data'));
      return;
    }
    const vulnClass = data.vulnerabilityIndex >= 75 ? 'cdp-pro-badge-critical'
      : data.vulnerabilityIndex >= 50 ? 'cdp-pro-badge-high'
      : data.vulnerabilityIndex >= 25 ? 'cdp-pro-badge-elevated'
      : 'cdp-pro-badge-normal';
    const badge = this.el('span', `cdp-pro-badge ${vulnClass}`, `Vulnerability: ${data.vulnerabilityIndex.toFixed(0)}`);
    this.chokepointBody.append(badge);
    for (const exp of data.exposures.slice(0, 3)) {
      const row = this.el('div', 'cdp-pro-exposure-item');
      row.append(this.el('span', 'cdp-pro-exposure-name', exp.chokepointName));
      const scoreEl = this.el('span', 'cdp-pro-exposure-score');
      scoreEl.textContent = exp.exposureScore.toFixed(1);
      scoreEl.style.background = exp.exposureScore >= 60
        ? 'color-mix(in srgb, var(--semantic-critical) 20%, transparent)'
        : 'color-mix(in srgb, var(--semantic-normal) 20%, transparent)';
      row.append(scoreEl);
      this.chokepointBody.append(row);
    }
  }

  public updateCostShock(data: { supplyDeficitPct: number; coverageDays: number; warRiskTier: string } | null): void {
    if (!this.costShockBody) return;
    this.costShockBody.replaceChildren();
    if (!data) {
      this.costShockBody.append(this.makeEmpty('No cost shock data'));
      return;
    }
    const grid = this.el('div', 'cdp-pro-metric-grid');
    grid.append(
      this.proMetricBox('Supply Deficit', `${data.supplyDeficitPct.toFixed(1)}%`),
      this.proMetricBox('Coverage Days', String(Math.round(data.coverageDays))),
    );
    this.costShockBody.append(grid);
    const tierLabel = data.warRiskTier.replace('WAR_RISK_TIER_', '').replace(/_/g, ' ');
    const tierClass = tierLabel === 'CRITICAL' || tierLabel === 'WAR ZONE' ? 'cdp-pro-badge-critical'
      : tierLabel === 'HIGH' ? 'cdp-pro-badge-high'
      : tierLabel === 'ELEVATED' ? 'cdp-pro-badge-elevated'
      : 'cdp-pro-badge-normal';
    const tierBadge = this.el('span', `cdp-pro-badge ${tierClass}`, `War Risk: ${tierLabel}`);
    tierBadge.style.marginTop = '8px';
    tierBadge.style.display = 'inline-block';
    this.costShockBody.append(tierBadge);
  }

  private makeProLocked(text: string): HTMLElement {
    const wrap = this.el('div', 'cdp-pro-locked');
    wrap.append(
      this.el('span', 'cdp-pro-lock-icon', '\uD83D\uDD12'),
      this.el('span', 'cdp-pro-lock-text', text),
    );
    return wrap;
  }

  private proMetricBox(label: string, value: string): HTMLElement {
    const box = this.el('div', 'cdp-pro-metric-box');
    box.append(
      this.el('div', 'cdp-pro-metric-label', label),
      this.el('div', 'cdp-pro-metric-value', value),
    );
    return box;
  }

  private formatMoney(usd: number): string {
    if (usd >= 1e12) return `$${(usd / 1e12).toFixed(1)}T`;
    if (usd >= 1e9) return `$${(usd / 1e9).toFixed(1)}B`;
    if (usd >= 1e6) return `$${(usd / 1e6).toFixed(1)}M`;
    return `$${Math.round(usd).toLocaleString()}`;
  }

  private formatPctTrend(pct: number): string {
    const sign = pct >= 0 ? '+' : '';
    return `${sign}${pct.toFixed(1)}%`;
  }

  public updateEnergyProfile(data: CountryEnergyProfileData): void {
    if (!this.energyBody) return;
    this.renderEnergyProfile(data);
    this.resilienceWidget?.setEnergyMix(data);
  }

  private renderEnergyProfile(data: CountryEnergyProfileData): void {
    if (!this.energyBody) return;
    this.energyBody.replaceChildren();

    const hasAny = data.mixAvailable || data.jodiOilAvailable || data.ieaStocksAvailable
      || data.jodiGasAvailable || data.gasStorageAvailable || data.electricityAvailable
      || data.emberAvailable || data.sprAvailable;

    if (!hasAny) {
      this.energyBody.append(this.makeEmpty('Energy data unavailable for this country.'));
      return;
    }

    if (data.mixAvailable) {
      const segments: Array<{ label: string; color: string; value: number }> = [
        { label: 'Coal', color: '#6b6b6b', value: data.coalShare },
        { label: 'Oil', color: '#8B4513', value: data.oilShare },
        { label: 'Gas', color: '#D2691E', value: data.gasShare },
        { label: 'Nuclear', color: '#6A0DAD', value: data.nuclearShare },
        { label: 'Hydro', color: '#1E90FF', value: data.hydroShare },
        { label: 'Wind', color: '#87CEEB', value: data.windShare },
        { label: 'Solar', color: '#FFD700', value: data.solarShare },
        { label: 'Other renew', color: '#32CD32', value: Math.max(0, data.renewShare - data.windShare - data.solarShare - data.hydroShare) },
      ];

      const total = segments.reduce((s, seg) => s + seg.value, 0);
      const norm = total > 0 ? total : 1;

      const wrap = this.el('div', 'cdp-energy-donut-wrap');
      wrap.append(this.buildDonutSvg(segments, norm, 'Primary\nEnergy'));
      const legend = this.el('div', 'cdp-energy-legend');
      for (const seg of segments) {
        const pct = (seg.value / norm) * 100;
        if (pct <= 0.5) continue;
        const row = this.el('div', 'cdp-energy-legend-row');
        const dot = this.el('span', 'cdp-energy-legend-dot');
        dot.style.background = seg.color;
        const label = this.el('span', '', `${seg.label}  ${Math.round(pct)}%`);
        row.append(dot, label);
        legend.append(row);
      }
      wrap.append(legend);
      this.energyBody.append(wrap);

      const src = this.el('div', 'cdp-economic-source', `Data: ${data.mixYear} (OWID)`);
      this.energyBody.append(src);
    }

    if (data.mixAvailable) {
      const importPct = data.importShare;
      const color = importPct > 60 ? '#ef4444'
        : importPct >= 30 ? '#f59e0b'
        : importPct > 0 ? '#22c55e'
        : '#6b7280';
      const labelText = importPct <= 0 ? 'Net exporter' : `${Math.round(importPct)}%`;
      const row = this.el('div', '');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:6px';
      const label = this.el('span', 'cdp-economic-source', 'Import dependency:');
      const badge = this.el('span', '');
      badge.style.cssText = `background:${color};color:#fff;padding:1px 6px;border-radius:3px;font-size:11px`;
      badge.textContent = labelText;
      row.append(label, badge);
      this.energyBody.append(row);
    }

    if (data.jodiOilAvailable) {
      const section = this.el('div', '');
      section.style.cssText = 'margin-top:10px';
      section.append(this.el('div', 'cdp-subtitle', `Oil Product Supply (${data.jodiOilDataMonth})`));

      const table = this.el('table', '');
      table.style.cssText = 'width:100%;font-size:11px;border-collapse:collapse';

      const thead = this.el('thead', '');
      const hr = this.el('tr', '');
      for (const h of ['Product', 'Demand', 'Imports']) {
        const th = this.el('th', '');
        th.textContent = h;
        th.style.cssText = 'text-align:left;color:#aaa;padding:2px 4px';
        hr.append(th);
      }
      thead.append(hr);
      table.append(thead);

      const tbody = this.el('tbody', '');
      const rows: Array<{ label: string; demand: number; imports: number }> = [
        { label: 'Gasoline', demand: data.gasolineDemandKbd, imports: data.gasolineImportsKbd },
        { label: 'Diesel', demand: data.dieselDemandKbd, imports: data.dieselImportsKbd },
        { label: 'Jet fuel', demand: data.jetDemandKbd, imports: data.jetImportsKbd },
        { label: 'LPG', demand: data.lpgDemandKbd, imports: data.lpgImportsKbd },
      ];
      for (const r of rows) {
        const tr = this.el('tr', '');
        const fmtKbd = (v: number) => v > 0 ? `${v} kbd` : '\u2014';
        for (const val of [r.label, fmtKbd(r.demand), fmtKbd(r.imports)]) {
          const td = this.el('td', '');
          td.textContent = val;
          td.style.cssText = 'padding:2px 4px';
          tr.append(td);
        }
        tbody.append(tr);
      }
      if (data.crudeImportsKbd > 0) {
        const tr = this.el('tr', '');
        for (const val of ['Crude', '\u2014', `${data.crudeImportsKbd} kbd`]) {
          const td = this.el('td', '');
          td.textContent = val;
          td.style.cssText = 'padding:2px 4px';
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(tbody);
      section.append(table);
      section.append(this.el('div', 'cdp-economic-source', 'Source: JODI'));
      this.energyBody.append(section);
    }

    if (data.jodiGasAvailable) {
      const totalBcm = Math.round(data.gasTotalDemandTj / 36000);
      const lngShare = data.gasLngShare;
      const pipeShare = Math.max(0, 100 - lngShare);
      const lngColor = lngShare > 80 ? '#ef4444' : lngShare >= 40 ? '#f59e0b' : '#22c55e';

      const section = this.el('div', '');
      section.style.cssText = 'margin-top:10px';
      const row = this.el('div', '');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px';

      const gasLabel = this.el('span', '', `Gas demand: ${totalBcm} BCM/yr`);
      const lngBadge = this.el('span', '');
      lngBadge.style.cssText = `background:${lngColor};color:#fff;padding:1px 5px;border-radius:3px;font-size:11px`;
      lngBadge.textContent = `LNG ${lngShare.toFixed(0)}%`;
      const pipeBadge = this.el('span', '');
      pipeBadge.style.cssText = 'background:#6b7280;color:#fff;padding:1px 5px;border-radius:3px;font-size:11px';
      pipeBadge.textContent = `Pipeline ${pipeShare.toFixed(0)}%`;

      row.append(gasLabel, lngBadge, pipeBadge);
      section.append(row);
      this.energyBody.append(section);
    }

    if (data.ieaStocksAvailable) {
      const section = this.el('div', '');
      section.style.cssText = 'margin-top:10px';

      if (data.ieaNetExporter) {
        const msg = this.el('div', '');
        msg.style.cssText = 'color:#22c55e;font-size:12px';
        msg.textContent = 'IEA oil stocks: Net Exporter';
        section.append(msg);
      } else {
        const coverLabel = this.el('div', '');
        coverLabel.style.cssText = 'font-size:12px;margin-bottom:4px;display:flex;align-items:center;gap:6px';
        const txt = this.el('span', '', `IEA Oil Stocks: ${data.ieaDaysOfCover} days of cover`);
        coverLabel.append(txt);

        if (data.ieaBelowObligation) {
          const warn = this.el('span', '');
          warn.style.cssText = 'background:#ef4444;color:#fff;padding:1px 5px;border-radius:3px;font-size:11px';
          warn.textContent = 'Below 90-day obligation';
          coverLabel.append(warn);
        }
        section.append(coverLabel);

        const barOuter = this.el('div', '');
        barOuter.style.cssText = 'position:relative;width:100%;height:8px;border-radius:4px;background:#374151;overflow:visible';
        const fillPct = Math.min(data.ieaDaysOfCover / 180 * 100, 100);
        const fill = this.el('div', '');
        fill.style.cssText = `width:${fillPct}%;height:100%;background:#3b82f6;border-radius:4px`;
        const marker = this.el('div', '');
        marker.style.cssText = 'position:absolute;top:-2px;left:50%;width:2px;height:12px;background:#f59e0b;transform:translateX(-50%)';
        barOuter.append(fill, marker);
        section.append(barOuter);
      }
      this.energyBody.append(section);
    }

    if (data.sprAvailable && data.sprRegime === 'government_spr' && !data.sprIeaMember) {
      const section = this.el('div', '');
      section.style.cssText = 'margin-top:10px';
      const row = this.el('div', '');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px';
      const badge = this.el('span', '');
      badge.style.cssText = 'background:#3b82f6;color:#fff;padding:1px 6px;border-radius:3px;font-size:11px';
      const capText = data.sprCapacityMb > 0 ? ` (${data.sprCapacityMb}Mb)` : '';
      badge.textContent = `Strategic Reserve: ${data.sprOperator || 'Government SPR'}${capText}`;
      row.append(badge);
      section.append(row);
      this.energyBody.append(section);
    } else if (data.sprAvailable && data.sprRegime === 'spare_capacity') {
      const section = this.el('div', '');
      section.style.cssText = 'margin-top:10px';
      const muted = this.el('div', '');
      muted.style.cssText = 'color:#6b7280;font-size:11px';
      muted.textContent = 'Spare capacity producer (no formal SPR)';
      section.append(muted);
      this.energyBody.append(section);
    } else if (data.sprAvailable && data.sprRegime === 'none') {
      const note = this.el('div', 'cdp-economic-source');
      note.style.cssText += ';color:#ef4444;opacity:0.7';
      note.textContent = 'No known strategic petroleum reserve program';
      this.energyBody.append(note);
    }

    const hasLiveSignals = data.gasStorageAvailable || data.electricityAvailable;
    if (hasLiveSignals) {
      const section = this.el('div', '');
      section.style.cssText = 'margin-top:10px';
      section.append(this.el('div', 'cdp-subtitle', 'Live Signals'));

      if (data.gasStorageAvailable) {
        const row = this.el('div', '');
        row.style.cssText = 'font-size:12px;margin-bottom:4px';
        const deltaSign = data.gasStorageChange1d >= 0 ? '+' : '';
        row.textContent = `EU Gas Storage: ${data.gasStorageFillPct.toFixed(1)}% (${deltaSign}${data.gasStorageChange1d.toFixed(1)}% today, ${data.gasStorageTrend}) as of ${data.gasStorageDate}`;
        section.append(row);
      }

      if (data.electricityAvailable) {
        const row = this.el('div', '');
        row.style.cssText = 'font-size:12px';
        row.textContent = `Electricity: \u20AC${data.electricityPriceMwh.toFixed(1)}/MWh as of ${data.electricityDate}`;
        section.append(row);
      }
      this.energyBody.append(section);
    }

    if (data.emberAvailable) {
      const section = this.el('div', '');
      section.style.cssText = 'margin-top:10px';
      const monthLabel = data.emberDataMonth || 'latest';
      section.append(this.el('div', 'cdp-subtitle', `Monthly Generation Mix (${monthLabel})`));

      const segments: Array<{ label: string; color: string; value: number }> = [
        { label: 'Fossil', color: '#8B4513', value: data.emberFossilShare },
        { label: 'Renewable', color: '#22c55e', value: data.emberRenewShare },
        { label: 'Nuclear', color: '#6A0DAD', value: data.emberNuclearShare },
      ];
      const total = segments.reduce((acc, seg) => acc + seg.value, 0);
      const norm = total > 0 ? total : 1;

      const wrap = this.el('div', 'cdp-energy-donut-wrap');
      wrap.append(this.buildDonutSvg(segments, norm, 'Monthly\nMix'));
      const legend = this.el('div', 'cdp-energy-legend');
      for (const seg of segments) {
        const pct = (seg.value / norm) * 100;
        if (pct <= 0.5) continue;
        const row = this.el('div', 'cdp-energy-legend-row');
        const dot = this.el('span', 'cdp-energy-legend-dot');
        dot.style.background = seg.color;
        const label = this.el('span', '', `${seg.label}  ${Math.round(pct)}%`);
        row.append(dot, label);
        legend.append(row);
      }
      wrap.append(legend);
      section.append(wrap);

      if (data.emberCoalShare > 0 || data.emberGasShare > 0) {
        const breakdown = this.el('div', '');
        breakdown.style.cssText = 'font-size:11px;color:#aaa;margin-top:4px';
        const parts: string[] = [];
        if (data.emberCoalShare > 0) parts.push(`Coal ${Math.round(data.emberCoalShare)}%`);
        if (data.emberGasShare > 0) parts.push(`Gas ${Math.round(data.emberGasShare)}%`);
        breakdown.textContent = `Fossil breakdown: ${parts.join(', ')}`;
        section.append(breakdown);
      }

      if (data.emberDemandTwh > 0) {
        const demand = this.el('div', '');
        demand.style.cssText = 'font-size:11px;color:#aaa;margin-top:2px';
        demand.textContent = `Total demand: ${data.emberDemandTwh.toFixed(1)} TWh`;
        section.append(demand);
      }

      section.append(this.el('div', 'cdp-economic-source', 'Source: Ember Climate (monthly)'));
      this.energyBody!.append(section);
    }

    if (data.jodiOilAvailable || data.jodiGasAvailable) {
      this.energyBody.append(this.renderShockScenarioWidget());
    }
  }

  private buildDonutSvg(
    segments: Array<{ label: string; color: string; value: number }>,
    norm: number,
    centerText: string,
  ): HTMLElement {
    const size = 120;
    const r = 46;
    const stroke = 18;
    const cx = size / 2;
    const cy = size / 2;
    const circ = 2 * Math.PI * r;

    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);

    let offset = 0;
    for (const seg of segments) {
      const pct = (seg.value / norm) * 100;
      if (pct <= 0.5) continue;
      const dash = (pct / 100) * circ;
      const gap = circ - dash;
      const circle = document.createElementNS(ns, 'circle');
      circle.setAttribute('cx', String(cx));
      circle.setAttribute('cy', String(cy));
      circle.setAttribute('r', String(r));
      circle.setAttribute('fill', 'none');
      circle.setAttribute('stroke', seg.color);
      circle.setAttribute('stroke-width', String(stroke));
      circle.setAttribute('stroke-dasharray', `${dash} ${gap}`);
      circle.setAttribute('stroke-dashoffset', String(-offset));
      svg.append(circle);
      offset += dash;
    }

    const wrap = this.el('div', 'cdp-energy-donut');
    wrap.append(svg);
    const label = this.el('div', 'cdp-energy-donut-label');
    label.textContent = centerText;
    wrap.append(label);
    return wrap;
  }

  private renderShockScenarioWidget(): HTMLElement {
    const wrapper = this.el('div', '');
    wrapper.style.cssText = 'margin-top:12px;border-top:1px solid #374151;padding-top:10px';

    const title = this.el('div', 'cdp-subtitle', 'Shock Scenario');
    wrapper.append(title);

    const controls = this.el('div', '');
    controls.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px';

    const chokepointSelect = this.el('select', '') as HTMLSelectElement;
    chokepointSelect.style.cssText = 'background:#1f2937;color:#e5e7eb;border:1px solid #374151;border-radius:4px;padding:3px 6px;font-size:11px';
    const chopkpts: Array<[string, string]> = [['hormuz_strait', 'Strait of Hormuz'], ['malacca_strait', 'Strait of Malacca'], ['suez', 'Suez Canal'], ['bab_el_mandeb', 'Bab el-Mandeb']];
    for (const [cpValue, cpLabel] of chopkpts) {
      const opt = this.el('option', '') as HTMLOptionElement;
      opt.value = cpValue;
      opt.textContent = cpLabel;
      chokepointSelect.append(opt);
    }

    const disruptionSelect = this.el('select', '') as HTMLSelectElement;
    disruptionSelect.style.cssText = 'background:#1f2937;color:#e5e7eb;border:1px solid #374151;border-radius:4px;padding:3px 6px;font-size:11px';
    for (const pct of [25, 50, 75, 100]) {
      const opt = this.el('option', '') as HTMLOptionElement;
      opt.value = String(pct);
      opt.textContent = `${pct}% disruption`;
      disruptionSelect.append(opt);
    }

    const fuelModeSelect = this.el('select', '') as HTMLSelectElement;
    fuelModeSelect.style.cssText = disruptionSelect.style.cssText;
    for (const [val, label] of [['oil', 'Oil'], ['gas', 'Gas (LNG)'], ['both', 'Both']] as const) {
      const opt = this.el('option', '') as HTMLOptionElement;
      opt.value = val;
      opt.textContent = label;
      fuelModeSelect.append(opt);
    }

    const computeBtn = this.el('button', 'cdp-action-btn') as HTMLButtonElement;
    computeBtn.type = 'button';
    computeBtn.textContent = 'Compute';
    computeBtn.style.cssText += ';font-size:11px;padding:3px 8px';

    const coverageBadge = this.el('span', '');
    coverageBadge.style.cssText = 'display:none;font-size:10px;padding:2px 5px;border-radius:3px;font-weight:600';

    controls.append(chokepointSelect, disruptionSelect, fuelModeSelect, computeBtn, coverageBadge);
    wrapper.append(controls);

    const resultArea = this.el('div', '');
    resultArea.style.cssText = 'margin-top:8px';
    wrapper.append(resultArea);

    computeBtn.addEventListener('click', () => {
      const code = this.currentCode;
      if (!code) return;
      const chokepoint = chokepointSelect.value;
      const disruption = parseInt(disruptionSelect.value, 10);

      resultArea.replaceChildren();
      const loading = this.el('div', 'cdp-economic-source', 'Computing\u2026');
      resultArea.append(loading);
      computeBtn.disabled = true;
      coverageBadge.style.display = 'none';
      coverageBadge.textContent = '';

      const url = toApiUrl(`/api/intelligence/v1/compute-energy-shock?country_code=${encodeURIComponent(code)}&chokepoint_id=${encodeURIComponent(chokepoint)}&disruption_pct=${disruption}&fuel_mode=${encodeURIComponent(fuelModeSelect.value)}`);
      globalThis.fetch(url)
        .then((r) => r.json() as Promise<ComputeEnergyShockScenarioResponse>)
        .then((result) => {
          resultArea.replaceChildren();
          resultArea.append(this.renderShockResult(result));
          const lvl = result.coverageLevel ?? '';
          if (lvl) {
            const colors: Record<string, string> = {
              full: 'background:#15803d;color:#dcfce7',
              partial: 'background:#b45309;color:#fef3c7',
              unsupported: 'background:#b91c1c;color:#fee2e2',
            };
            coverageBadge.style.cssText = `display:inline-block;font-size:10px;padding:2px 5px;border-radius:3px;font-weight:600;${colors[lvl] ?? ''}`;
            coverageBadge.textContent = lvl;
          } else {
            coverageBadge.style.display = 'none';
          }
        })
        .catch(() => {
          resultArea.replaceChildren();
          resultArea.append(this.el('div', 'cdp-economic-source', 'Failed to compute scenario.'));
        })
        .finally(() => {
          computeBtn.disabled = false;
        });
    });

    return wrapper;
  }

  private renderShockResult(result: ComputeEnergyShockScenarioResponse): HTMLElement {
    const container = this.el('div', '');

    if (!result.dataAvailable && !(result as any).gasImpact?.dataAvailable) {
      container.append(this.el('div', 'cdp-economic-source', result.assessment));
      return container;
    }

    if (result.degraded) {
      const warn = this.el('div', '');
      warn.style.cssText = 'font-size:10px;color:#f59e0b;margin-bottom:6px;padding:3px 6px;background:#1c1400;border-radius:3px';
      warn.textContent = 'Live flow data unavailable — using historical baseline';
      container.append(warn);
    }

    if (result.products.length > 0) {
      const table = this.el('table', '');
      table.style.cssText = 'width:100%;font-size:11px;border-collapse:collapse;margin-bottom:6px';
      const thead = this.el('thead', '');
      const hr = this.el('tr', '');
      const headers = ['Product', 'Demand', 'Loss', 'Deficit'];
      if (result.portwatchCoverage && result.liveFlowRatio != null) headers.push('Flow');
      for (const h of headers) {
        const th = this.el('th', '');
        th.textContent = h;
        th.style.cssText = 'text-align:left;color:#aaa;padding:2px 4px';
        hr.append(th);
      }
      thead.append(hr);
      table.append(thead);

      const tbody = this.el('tbody', '');
      for (const p of result.products as ProductImpact[]) {
        const tr = this.el('tr', '');
        const defColor = p.deficitPct > 30 ? '#ef4444' : p.deficitPct > 10 ? '#f59e0b' : '#22c55e';
        const cells = [
          p.product,
          `${p.demandKbd} kbd`,
          `${p.outputLossKbd} kbd`,
          `${p.deficitPct.toFixed(1)}%`,
        ];
        if (result.portwatchCoverage && result.liveFlowRatio != null) {
          cells.push(`${Math.round(result.liveFlowRatio * 100)}%`);
        }
        cells.forEach((val, i) => {
          const td = this.el('td', '');
          td.textContent = val;
          td.style.cssText = `padding:2px 4px${i === 3 ? `;color:${defColor}` : ''}`;
          tr.append(td);
        });
        tbody.append(tr);
      }
      table.append(tbody);
      container.append(table);
    }

    if (result.ieaStocksCoverage) {
      const coverRow = this.el('div', 'cdp-economic-source');
      coverRow.style.cssText += ';margin-bottom:4px';
      let coverText: string;
      if (result.effectiveCoverDays < 0) {
        coverText = 'Net oil exporter — strategic reserve cover not applicable';
      } else if (result.effectiveCoverDays > 0) {
        coverText = `IEA cover: ~${result.effectiveCoverDays} days under this scenario`;
      } else {
        coverText = 'IEA cover: 0 days (reserves exhausted under this scenario)';
      }
      coverRow.textContent = coverText;
      container.append(coverRow);
    }

    const assessmentEl = this.el('div', '');
    assessmentEl.style.cssText = 'font-size:11px;color:#d1d5db;line-height:1.4;margin-top:4px';
    assessmentEl.textContent = result.assessment;
    container.append(assessmentEl);

    if (result.limitations && result.limitations.length > 0) {
      const details = this.el('details', '') as HTMLDetailsElement;
      details.style.cssText = 'margin-top:6px;font-size:10px;color:#9ca3af';
      const summary = this.el('summary', '');
      summary.style.cssText = 'cursor:pointer;color:#6b7280';
      summary.textContent = 'Model assumptions';
      details.append(summary);
      const ul = this.el('ul', '');
      ul.style.cssText = 'margin:4px 0 0 12px;padding:0;list-style:disc';
      for (const lim of result.limitations) {
        const li = this.el('li', '');
        li.textContent = lim;
        ul.append(li);
      }
      details.append(ul);
      container.append(details);
    }

    if (result.gasImpact?.dataAvailable) {
      const gi = result.gasImpact;
      const gasSection = this.el('div', '');
      gasSection.style.cssText = 'margin-top:10px;border-top:1px solid #374151;padding-top:8px';

      const gasTitle = this.el('div', '');
      gasTitle.style.cssText = 'font-size:11px;font-weight:600;color:#e5e7eb;margin-bottom:4px';
      gasTitle.textContent = 'Gas / LNG Impact';
      gasSection.append(gasTitle);

      const metrics = this.el('div', 'cdp-economic-source');
      metrics.textContent = `LNG share: ${(gi.lngShareOfImports * 100).toFixed(0)}% | Disruption: ${gi.lngDisruptionTj.toFixed(0)} TJ | Deficit: ${gi.deficitPct.toFixed(1)}%`;
      gasSection.append(metrics);

      if (gi.storage) {
        const s = gi.storage;
        const storageDiv = this.el('div', 'cdp-economic-source');
        storageDiv.style.cssText += ';margin-top:4px';
        storageDiv.textContent = `Gas storage: ${s.fillPct.toFixed(1)}% full (${s.gasTwh.toFixed(0)} TWh), buffer ~${s.bufferDays} days, ${s.trend} (${s.scope})`;
        gasSection.append(storageDiv);
      }

      const srcBadge = this.el('div', '');
      srcBadge.style.cssText = 'font-size:10px;color:#9ca3af;margin-top:2px';
      srcBadge.textContent = `Source: ${gi.dataSource === 'gie_daily' ? 'GIE (daily, Europe)' : 'JODI (monthly, global)'}`;
      gasSection.append(srcBadge);

      const gasAssess = this.el('div', '');
      gasAssess.style.cssText = 'font-size:11px;color:#d1d5db;line-height:1.4;margin-top:4px';
      gasAssess.textContent = gi.assessment;
      gasSection.append(gasAssess);

      container.append(gasSection);
    }

    return container;
  }

  public updateMaritimeActivity(data: CountryPortActivityData): void {
    if (!this.maritimeBody) return;

    if (!data.available || data.ports.length === 0) {
      this.maritimeBody.parentElement?.remove();
      this.maritimeBody = null;
      return;
    }

    this.maritimeBody.replaceChildren();

    const table = this.el('table', 'cdp-maritime-table');
    const thead = this.el('thead');
    const headerRow = this.el('tr');
    for (const col of ['Port', 'Tanker Calls (30d)', 'Trend', 'Import DWT', 'Export DWT']) {
      const th = this.el('th', '', col);
      headerRow.append(th);
    }
    thead.append(headerRow);
    table.append(thead);

    const tbody = this.el('tbody');
    for (const port of data.ports) {
      const tr = this.el('tr');

      const nameCell = this.el('td', 'cdp-maritime-port');
      nameCell.textContent = port.portName;
      if (port.anomalySignal) {
        const badge = this.el('span', 'cdp-maritime-anomaly', '\u26A0');
        badge.title = 'Traffic anomaly detected';
        nameCell.append(badge);
      }
      tr.append(nameCell);

      const callsCell = this.el('td', '', String(port.tankerCalls30d));
      tr.append(callsCell);

      const trendCell = this.el('td', 'cdp-maritime-trend');
      const pct = port.trendDeltaPct;
      if (pct !== 0 || port.tankerCalls30d > 0) {
        const sign = pct > 0 ? '+' : '';
        trendCell.textContent = `${sign}${pct.toFixed(1)}%`;
        if (pct > 0) trendCell.classList.add('cdp-trend-up');
        else if (pct < 0) trendCell.classList.add('cdp-trend-down');
      } else {
        trendCell.textContent = 'n/a';
      }
      tr.append(trendCell);

      const fmtDwt = (v: number): string =>
        v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `${(v / 1_000).toFixed(0)}K` : String(Math.round(v));

      tr.append(this.el('td', '', fmtDwt(port.importTankerDwt)));
      tr.append(this.el('td', '', fmtDwt(port.exportTankerDwt)));

      tbody.append(tr);
    }
    table.append(tbody);
    const scrollWrap = this.el('div', 'cdp-maritime-scroll');
    scrollWrap.append(table);
    this.maritimeBody.append(scrollWrap);

    if (data.fetchedAt) {
      const dateStr = data.fetchedAt.split('T')[0] ?? data.fetchedAt;
      const footer = this.el('div', 'cdp-section-source', `Source: IMF PortWatch \u00B7 as of ${dateStr}`);
      this.maritimeBody.append(footer);
    }
  }

  public updateTradeExposure(data: GetCountryChokepointIndexResponse | null, sectors?: SectorExposureSummary[]): void {
    if (!this.tradeExposureBody) return;

    if (data == null || data.exposures.length === 0) {
      this.tradeExposureBody.parentElement?.remove();
      this.tradeExposureBody = null;
      return;
    }

    this.cachedTradeExposureData = data;
    this.cachedSectors = sectors ?? [];

    this.renderTradeExposureContent();
  }

  private renderTradeExposureContent(): void {
    if (!this.tradeExposureBody || !this.cachedTradeExposureData) return;
    const data = this.cachedTradeExposureData;
    const sectors = this.cachedSectors;

    this.tradeExposureBody.replaceChildren();

    const vulnDiv = this.el('div', 'cdp-vuln-index', `Vulnerability: ${Math.round(data.vulnerabilityIndex)}/100`);
    this.tradeExposureBody.append(vulnDiv);

    if (sectors && sectors.length > 0) {
      const sectorLabel = this.el('div', 'cdp-section-sublabel', 'Sector exposure by primary chokepoint');
      this.tradeExposureBody.append(sectorLabel);

      const table = this.el('table', 'cdp-trade-exposure-table');
      const thead = this.el('thead');
      const headerRow = this.el('tr');
      headerRow.append(this.el('th', '', 'Sector'));
      headerRow.append(this.el('th', '', 'Chokepoint'));
      headerRow.append(this.el('th', 'cdp-exposure-score-header', 'Risk'));
      thead.append(headerRow);
      table.append(thead);

      const tbody = this.el('tbody');
      for (const s of sectors.slice(0, 10)) {
        const isSelected = this.selectedSectorHs2 === s.hs2;
        const tr = this.el('tr');
        tr.className = `cdp-sector-row${isSelected ? ' cdp-sector-row--selected' : ''}`;
        tr.dataset.hs2 = s.hs2;
        const sectorCell = this.el('td', 'cdp-sector-label');
        sectorCell.textContent = s.label;
        const flag = DEPENDENCY_FLAG_LABELS[s.dependencyFlag];
        if (flag) {
          const badge = this.el('span', `cdp-dep-badge ${flag.cls}`, flag.text);
          sectorCell.append(document.createTextNode(' '), badge);
        }
        const cpCell = this.el('td', 'cdp-chokepoint-name');
        cpCell.textContent = s.primaryChokepointName;
        const scoreCell = this.el('td', 'cdp-exposure-score');
        const scoreColor = s.exposureScore >= 70 ? 'var(--danger, #ef4444)' : s.exposureScore > 30 ? 'var(--warning, #f59e0b)' : 'var(--text-muted, #64748b)';
        scoreCell.textContent = `${s.exposureScore.toFixed(0)}`;
        scoreCell.style.color = scoreColor;
        tr.append(sectorCell, cpCell, scoreCell);
        tbody.append(tr);

        if (isSelected) {
          const detailRow = this.el('tr');
          detailRow.className = 'cdp-sector-detail-row';
          const detailCell = this.el('td');
          detailCell.setAttribute('colspan', '3');
          detailCell.append(this.buildRouteDetail(s));
          detailRow.append(detailCell);
          tbody.append(detailRow);
        }
      }
      table.append(tbody);

      tbody.addEventListener('click', (e) => {
        const row = (e.target as HTMLElement).closest<HTMLElement>('tr.cdp-sector-row');
        if (!row?.dataset.hs2) return;
        this.handleSectorRowClick(row.dataset.hs2);
      });

      this.tradeExposureBody.append(table);
    } else {
      const sorted = [...data.exposures].sort((a, b) => b.exposureScore - a.exposureScore).slice(0, 3);
      const table = this.el('table', 'cdp-trade-exposure-table');
      const tbody = this.el('tbody');
      for (const entry of sorted) {
        const tr = this.el('tr');
        const nameCell = this.el('td', 'cdp-chokepoint-name');
        nameCell.textContent = entry.chokepointName || entry.chokepointId.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
        const barWrap = this.el('td', 'cdp-exposure-bar-wrap');
        const bar = this.el('div', 'cdp-exposure-bar');
        bar.style.width = `${Math.min(entry.exposureScore, 100)}%`;
        barWrap.append(bar);
        const pctCell = this.el('td', 'cdp-exposure-pct', `${entry.exposureScore.toFixed(1)}`);
        tr.append(nameCell, barWrap, pctCell);
        tbody.append(tr);
      }
      table.append(tbody);
      this.tradeExposureBody.append(table);
    }

    const footer = this.el('div', 'cdp-card-footer', 'Source: Comtrade \u00B7 HS2 sectors \u00B7 Scores indicate route overlap, not share');
    this.tradeExposureBody.append(footer);
  }

  private handleSectorRowClick(hs2: string): void {
    this.sectorBypassAbort?.abort();
    this.sectorBypassAbort = null;
    this.map?.clearHighlightedRoute();

    if (this.selectedSectorHs2 === hs2) {
      this.selectedSectorHs2 = null;
      this.renderTradeExposureContent();
      return;
    }

    if (this.isMaximizedState) this.minimize();

    this.selectedSectorHs2 = hs2;
    this.renderTradeExposureContent();

    const sector = this.cachedSectors.find(s => s.hs2 === hs2);
    if (!sector) return;

    const matchingRoutes = getChokepointRoutes(sector.primaryChokepointId);
    const matchingRouteIds = matchingRoutes.map(r => r.id);

    if (matchingRouteIds.length > 0) {
      this.map?.highlightRoute(matchingRouteIds);
      this.map?.zoomToRoutes(matchingRouteIds);
    }
  }

  private buildRouteDetail(sector: SectorExposureSummary): HTMLElement {
    const wrap = this.el('div', 'cdp-route-detail');

    const matchingRoutes = getChokepointRoutes(sector.primaryChokepointId);

    if (matchingRoutes.length === 0) {
      wrap.append(this.el('div', 'cdp-route-path', 'No maritime route data'));
      return wrap;
    }

    const portMap = new Map(PORTS.map(p => [p.id, p.name]));
    const waterwayMap = new Map(STRATEGIC_WATERWAYS.map(w => [w.id, w.name]));

    const cpName = waterwayMap.get(sector.primaryChokepointId) ?? sector.primaryChokepointName;
    const routesLabel = this.el('div', 'cdp-bypass-heading', `Routes via ${cpName}:`);
    wrap.append(routesLabel);

    for (const route of matchingRoutes) {
      const pathParts: string[] = [];
      pathParts.push(portMap.get(route.from) ?? route.from);
      for (const wp of route.waypoints) {
        pathParts.push(waterwayMap.get(wp) ?? wp);
      }
      pathParts.push(portMap.get(route.to) ?? route.to);
      const pathStr = pathParts.map(p => escapeHtml(p)).join(' \u2192 ');

      const pathEl = this.el('div', 'cdp-route-path');
      pathEl.innerHTML = `${escapeHtml(route.name)}: ${pathStr}`;
      wrap.append(pathEl);
    }

    const statsEl = this.el('div', 'cdp-route-stats');
    const distEl = this.el('div');
    distEl.innerHTML = `Distance: <span>\u2014</span>`;
    const transitEl = this.el('div');
    transitEl.innerHTML = `Transit: <span>\u2014</span>`;
    const riskEl = this.el('div');
    const riskScore = sector.exposureScore;
    const riskColor = riskScore >= 70 ? '#ef4444' : riskScore > 30 ? '#f59e0b' : '#94a3b8';
    riskEl.innerHTML = `Chokepoint Risk: <span style="color:${riskColor}">${riskScore.toFixed(0)}/100</span>`;
    const routeCountEl = this.el('div');
    routeCountEl.innerHTML = `Routes via chokepoint: <span>${matchingRoutes.length}</span>`;
    statsEl.append(distEl, transitEl, riskEl, routeCountEl);
    wrap.append(statsEl);

    const bypassSection = this.el('div', 'cdp-bypass-section');
    const bypassHeading = this.el('div', 'cdp-bypass-heading', 'Bypass Options');
    bypassSection.append(bypassHeading);
    const bypassContent = this.el('div');

    const isPro = hasPremiumAccess(getAuthState());
    if (!isPro) {
      const gateEl = this.makeProLocked('Bypass corridors available with PRO');
      gateEl.addEventListener('click', () => trackGateHit('sector-bypass-corridors'), { once: true });
      bypassContent.append(gateEl);
    } else {
      bypassContent.append(this.makeLoading('Loading bypass options\u2026'));
      this.sectorBypassAbort = new AbortController();
      const signal = this.sectorBypassAbort.signal;
      void fetchBypassOptions(sector.primaryChokepointId, 'container', 100).then(resp => {
        if (signal.aborted) return;
        bypassContent.replaceChildren();
        const top3 = resp.options.slice(0, 3);
        if (top3.length === 0) {
          bypassContent.append(this.el('div', 'cdp-route-path', 'No bypass options available'));
          return;
        }
        const tbl = this.el('table', 'cdp-trade-exposure-table');
        const tHead = this.el('thead');
        const hRow = this.el('tr');
        hRow.append(this.el('th', '', 'Corridor'), this.el('th', '', '+Days'), this.el('th', '', '+Cost'), this.el('th', '', 'Risk'));
        tHead.append(hRow);
        tbl.append(tHead);
        const tBody = this.el('tbody');
        const riskTierMap: Record<string, string> = {
          WAR_RISK_TIER_UNSPECIFIED: 'Normal',
          WAR_RISK_TIER_WAR_ZONE: 'War Zone',
          WAR_RISK_TIER_CRITICAL: 'Critical',
          WAR_RISK_TIER_HIGH: 'High',
          WAR_RISK_TIER_ELEVATED: 'Elevated',
          WAR_RISK_TIER_NORMAL: 'Normal',
        };
        for (const opt of top3) {
          const r = this.el('tr');
          r.append(
            this.el('td', '', opt.name),
            this.el('td', '', opt.addedTransitDays > 0 ? `+${opt.addedTransitDays}d` : '\u2014'),
            this.el('td', '', opt.addedCostMultiplier > 1 ? `+${((opt.addedCostMultiplier - 1) * 100).toFixed(0)}%` : '\u2014'),
            this.el('td', '', riskTierMap[opt.bypassWarRiskTier] ?? opt.bypassWarRiskTier),
          );
          tBody.append(r);
        }
        tbl.append(tBody);
        bypassContent.append(tbl);
      }).catch(() => {
        if (signal.aborted) return;
        bypassContent.replaceChildren();
        bypassContent.append(this.el('div', 'cdp-route-path', 'Bypass data unavailable'));
      });
    }

    bypassSection.append(bypassContent);
    wrap.append(bypassSection);
    return wrap;
  }

  public updateProductImports(data: CountryProductsResponse | null): void {
    if (!this.productImportsBody) return;
    this.productImportsBody.replaceChildren();
    if (!data || data.products.length === 0) {
      this.productImportsBody.append(this.makeEmpty('No product import data available'));
      return;
    }
    this.renderProductSelector(data.products);
  }

  private renderProductSelector(products: CountryProduct[]): void {
    if (!this.productImportsBody) return;
    const wrap = this.el('div', 'cdp-product-selector');
    const input = this.el('input', 'cdp-product-search');
    input.type = 'text';
    input.placeholder = 'Search products...';
    input.setAttribute('autocomplete', 'off');

    const list = this.el('div', 'cdp-product-list');
    const detailMount = this.el('div', 'cdp-product-detail');

    const renderList = (filter: string) => {
      list.replaceChildren();
      const lower = filter.toLowerCase();
      const filtered = lower
        ? products.filter(p => p.description.toLowerCase().includes(lower) || p.hs4.includes(lower))
        : products;
      for (const p of filtered.slice(0, 12)) {
        const item = this.el('button', 'cdp-product-item');
        item.type = 'button';
        item.textContent = `${p.description} (HS ${p.hs4})`;
        item.addEventListener('click', () => {
          input.value = p.description;
          list.replaceChildren();
          this.renderProductDetail(detailMount, p);
        });
        list.append(item);
      }
    };

    input.addEventListener('input', () => renderList(input.value));
    input.addEventListener('focus', () => {
      if (list.children.length === 0) renderList(input.value);
    });

    this.productImportsBody.addEventListener('click', (e) => {
      if (!(e.target instanceof HTMLElement) || e.target.closest('.cdp-product-selector')) return;
      list.replaceChildren();
    });

    wrap.append(input, list);
    this.productImportsBody.append(wrap, detailMount);

    const first = products[0];
    if (first) {
      input.value = first.description;
      this.renderProductDetail(detailMount, first);
    }
  }

  private renderProductDetail(mount: HTMLElement, product: CountryProduct): void {
    mount.replaceChildren();

    const header = this.el('div', 'cdp-product-header');
    header.append(
      this.el('span', 'cdp-product-name', `${product.description} (HS ${product.hs4})`),
      this.el('span', 'cdp-product-value', this.formatMoney(product.totalValue)),
    );
    mount.append(header);

    if (product.topExporters.length === 0) {
      mount.append(this.makeEmpty('No exporter data'));
      return;
    }

    const table = this.el('table', 'cdp-product-suppliers-table');
    const thead = this.el('thead');
    const hr = this.el('tr');
    hr.append(this.el('th', '', 'Supplier'));
    hr.append(this.el('th', '', 'Share'));
    hr.append(this.el('th', '', 'Value'));
    hr.append(this.el('th', '', 'Route Risk'));
    thead.append(hr);
    table.append(thead);

    const tbody = this.el('tbody');
    const recsMount = this.el('div', 'cdp-recommendations');

    type ExporterRow = { partnerIso2: string; share: number; value: number; risk: EnrichedExporter['risk'] | null };

    const renderRows = (enriched: EnrichedExporter[] | null) => {
      tbody.replaceChildren();
      recsMount.replaceChildren();

      const rows: ExporterRow[] = enriched ?? product.topExporters.map(exp => ({
        partnerIso2: exp.partnerIso2,
        share: exp.share,
        value: exp.value,
        risk: null,
      }));

      for (const exp of rows) {
        const tr = this.el('tr');
        const supplierTd = this.el('td', 'cdp-product-supplier');
        const flag = exp.partnerIso2 ? CountryDeepDivePanel.toFlagEmoji(exp.partnerIso2) : '';
        supplierTd.textContent = `${flag} ${exp.partnerIso2 || 'N/A'}`;
        tr.append(supplierTd);

        const shareTd = this.el('td', 'cdp-product-share');
        const pct = Math.round(exp.share * 100);
        shareTd.textContent = `${pct}%`;
        const barWrap = this.el('div', 'cdp-product-share-bar-wrap');
        const bar = this.el('div', 'cdp-product-share-bar');
        bar.style.width = `${Math.min(pct, 100)}%`;
        if (pct >= 50) bar.classList.add('cdp-product-share-high');
        barWrap.append(bar);
        shareTd.append(barWrap);
        tr.append(shareTd);

        tr.append(this.el('td', 'cdp-product-val', this.formatMoney(exp.value)));

        const riskTd = this.el('td', 'cdp-product-risk');
        if (exp.risk) {
          const badgeCls = `cdp-risk-badge cdp-risk-${exp.risk.riskLevel.replace('_', '-')}`;
          const badgeLabels: Record<string, string> = { safe: 'Safe', at_risk: 'At Risk', critical: 'Critical', unknown: 'Unknown' };
          const badge = this.el('span', badgeCls, badgeLabels[exp.risk.riskLevel] ?? exp.risk.riskLevel);
          riskTd.append(badge);

          if (exp.risk.transitChokepoints.length > 0) {
            const cpNames = exp.risk.transitChokepoints
              .map(cp => cp.chokepointName)
              .join(', ');
            const cpInfo = this.el('div', 'cdp-risk-chokepoints');
            cpInfo.textContent = cpNames;
            riskTd.append(cpInfo);
          }
        } else {
          riskTd.textContent = '\u2014';
        }
        tr.append(riskTd);
        tbody.append(tr);
      }

      if (enriched) {
        const hasCritical = enriched.some(e => e.risk.riskLevel === 'critical' || e.risk.riskLevel === 'at_risk');
        if (hasCritical) {
          for (const exp of enriched) {
            if (exp.risk.riskLevel === 'safe' || exp.risk.riskLevel === 'unknown') continue;
            const recCls = exp.risk.riskLevel === 'critical' ? 'cdp-recommendation-critical' : 'cdp-recommendation-warn';
            const item = this.el('div', `cdp-recommendation-item ${recCls}`);
            const expPct = Math.round(exp.share * 100);
            let text = `\u26A0 ${product.description} imports from ${exp.partnerIso2} (${expPct}%) transit`;
            if (exp.risk.transitChokepoints.length === 0) continue;
            const worstCp = exp.risk.transitChokepoints.reduce((a, b) => a.disruptionScore > b.disruptionScore ? a : b);
            text += ` ${worstCp.chokepointName} (disruption ${worstCp.disruptionScore}/100).`;
            if (exp.safeAlternative) {
              const alt = enriched.find(e => e.partnerIso2 === exp.safeAlternative);
              const altPct = alt ? Math.round(alt.share * 100) : 0;
              const altFlag = CountryDeepDivePanel.toFlagEmoji(exp.safeAlternative);
              text += ` ${altFlag} ${exp.safeAlternative} supplies ${altPct}% via routes avoiding this chokepoint.`;
            }
            item.textContent = text;
            recsMount.append(item);
          }
        } else {
          const safeItem = this.el('div', 'cdp-recommendation-item cdp-recommendation-safe');
          safeItem.textContent = '\u2713 All current suppliers use routes that avoid disrupted chokepoints.';
          recsMount.append(safeItem);
        }
      }
    };

    renderRows(null);
    table.append(tbody);
    mount.append(table, recsMount);

    const importerIso2 = this.currentCode;
    const capturedCode = this.getCode();
    if (importerIso2) {
      fetchChokepointStatus().then(resp => {
        if (this.getCode() !== capturedCode) return;
        if (!resp.chokepoints.length) return;
        const scores: ChokepointScoreMap = new Map();
        for (const cp of resp.chokepoints) {
          scores.set(cp.id, cp.disruptionScore);
        }
        const enriched = computeAlternativeSuppliers(product.topExporters, importerIso2, scores);
        renderRows(enriched);
      }).catch(() => {
        console.warn('[deep-dive] Chokepoint status unavailable for route risk enrichment');
      });
    }

    const source = this.el('div', 'cdp-card-footer', `Source: UN Comtrade HS4 bilateral \u00B7 ${product.year}`);
    mount.append(source);
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
    this.resetPanelContent();
    const loading = this.el('div', 'cdp-loading');
    loading.append(
      this.el('div', 'cdp-loading-title', t('countryBrief.identifying')),
      this.el('div', 'cdp-loading-line'),
      this.el('div', 'cdp-loading-line cdp-loading-line-short'),
    );
    this.content.append(loading);
  }

  private renderSkeleton(country: string, code: string, score: CountryScore | null, signals: CountryBriefSignals): void {
    this.resetPanelContent();

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
      const url = `${window.location.origin}/?c=${encodeURIComponent(this.currentCode)}`;
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

    this.resilienceWidget = new ResilienceWidget(code);
    const summaryGrid = this.el('div', 'cdp-summary-grid');
    summaryGrid.append(scoreCard, this.resilienceWidget.getElement());

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

    const [energyCard, energyBody] = this.sectionCard('Energy Profile', 'Oil import dependency, chokepoint exposure, and energy shock data from JODI, IEA, and PortWatch.');
    this.energyBody = energyBody;
    energyBody.append(this.makeLoading('Loading energy data\u2026'));

    const [maritimeCard, maritimeBody] = this.sectionCard('Maritime Activity', 'Port-level tanker call volume and import/export cargo weight over 30 days. ⚠ badge = port running below 50% of its 30-day baseline. Source: IMF PortWatch.');
    this.maritimeBody = maritimeBody;
    maritimeBody.append(this.makeLoading('Loading port activity\u2026'));

    const [tradeCard, tradeBody] = this.sectionCard('Trade Exposure', 'Chokepoints most critical to this country\'s imports by sector');
    this.tradeExposureBody = tradeBody;
    tradeBody.append(this.makeLoading('Loading trade exposure\u2026'));

    const isPro = hasPremiumAccess(getAuthState());

    const [productImportsCard, productImportsCardBody] = this.sectionCard('Product Imports', 'Top imported products by HS4 code with supplier breakdown and concentration risk.');
    this.productImportsBody = productImportsCardBody;
    productImportsCardBody.append(isPro ? this.makeLoading('Loading product data\u2026') : this.makeProLocked('Upgrade to PRO for product import data'));

    const [debtCard, debtBody] = this.sectionCard('National Debt', 'Government debt-to-GDP ratio, total debt, and year-over-year growth.');
    this.debtBody = debtBody;
    debtBody.append(isPro ? this.makeLoading('Loading debt data\u2026') : this.makeProLocked('Upgrade to PRO for national debt data'));

    const [sanctionsCard, sanctionsBody] = this.sectionCard('Sanctions Pressure', 'Sanctioned entities, vessels, and aircraft linked to this country.');
    this.sanctionsBody = sanctionsBody;
    sanctionsBody.append(isPro ? this.makeLoading('Loading sanctions data\u2026') : this.makeProLocked('Upgrade to PRO for sanctions data'));

    const [comtradeCard, comtradeBody] = this.sectionCard('Trade Flows', 'Top Comtrade trade flows sorted by value, with partner and commodity.');
    this.comtradeBody = comtradeBody;
    comtradeBody.append(isPro ? this.makeLoading('Loading trade flows\u2026') : this.makeProLocked('Upgrade to PRO for trade flow data'));

    const [tariffCard, tariffBody] = this.sectionCard('Tariff Trends', 'Effective tariff rate and historical trend direction.');
    this.tariffBody = tariffBody;
    tariffBody.append(isPro ? this.makeLoading('Loading tariff data\u2026') : this.makeProLocked('Upgrade to PRO for tariff trend data'));

    const [chokepointCard, chokepointBody] = this.sectionCard('Chokepoint Exposure', 'Vulnerability index and top chokepoint exposures for energy imports (HS 27).');
    this.chokepointBody = chokepointBody;
    chokepointBody.append(isPro ? this.makeLoading('Loading chokepoint data\u2026') : this.makeProLocked('Upgrade to PRO for chokepoint exposure'));

    const [costShockCard, costShockBody] = this.sectionCard('Cost Shock', 'Supply deficit, coverage days, and war risk tier for the primary chokepoint.');
    this.costShockBody = costShockBody;
    costShockBody.append(isPro ? this.makeLoading('Loading cost shock data\u2026') : this.makeProLocked('Upgrade to PRO for cost shock analysis'));

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

    bodyGrid.append(briefCard, factsExpanded, energyCard, maritimeCard, tradeCard, productImportsCard, debtCard, sanctionsCard, comtradeCard, tariffCard, chokepointCard, costShockCard, signalsCard, timelineCard, newsCard, militaryCard, infraCard, economicCard, marketsCard);
    shell.append(header, summaryGrid, bodyGrid);
    this.content.append(shell);
  }

  private destroyResilienceWidget(): void {
    this.resilienceWidget?.destroy();
    this.resilienceWidget = null;
  }

  private resetPanelContent(): void {
    this.destroyResilienceWidget();
    this.selectedSectorHs2 = null;
    this.sectorBypassAbort?.abort();
    this.sectorBypassAbort = null;
    this.cachedTradeExposureData = null;
    this.cachedSectors = [];
    this.map?.clearHighlightedRoute();
    this.scoreCard = null;
    this.energyBody = null;
    this.maritimeBody = null;
    this.tradeExposureBody = null;
    this.productImportsBody = null;
    this.debtBody = null;
    this.sanctionsBody = null;
    this.comtradeBody = null;
    this.tariffBody = null;
    this.chokepointBody = null;
    this.costShockBody = null;
    this.content.replaceChildren();
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
    this.addSignalChip(chips, signals.radiationAnomalies, 'Radiation anomalies', '☢️', 'outage');
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
      medium: signals.outages + signals.cyberThreats + signals.aisDisruptions + signals.radiationAnomalies,
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

  private sectionCard(title: string, helpText?: string): [HTMLElement, HTMLElement] {
    const card = this.el('section', 'cdp-card');
    const heading = this.el('h3', 'cdp-card-title', title);
    if (helpText) {
      const tip = this.el('button', 'cdp-card-help', '?');
      tip.setAttribute('title', helpText);
      tip.setAttribute('type', 'button');
      heading.append(tip);
    }
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
    return formatIntelBrief(text, headlineCount > 0 ? { count: headlineCount, hrefPrefix: '#cdp-news-' } : undefined);
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
    return toFlagEmoji(code, '🌍');
  }
}
