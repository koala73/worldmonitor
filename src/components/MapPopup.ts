import type { ConflictZone, Hotspot, NewsItem, MilitaryBase, StrategicWaterway, APTGroup, NuclearFacility, EconomicCenter, GammaIrradiator, Pipeline, UnderseaCable, CableAdvisory, RepairShip, InternetOutage, AIDataCenter, AisDisruptionEvent, SocialUnrestEvent, MilitaryFlight, MilitaryVessel, MilitaryFlightCluster, MilitaryVesselCluster, NaturalEvent, Port, Spaceport, CriticalMineralProject, CyberThreat } from '@/types';
import type { AirportDelayAlert } from '@/services/aviation';
import type { Earthquake } from '@/services/earthquakes';
import type { WeatherAlert } from '@/services/weather';
import { UNDERSEA_CABLES } from '@/config';
import type { StartupHub, Accelerator, TechHQ, CloudRegion } from '@/config/tech-geo';
import type { TechHubActivity } from '@/services/tech-activity';
import type { GeoHubActivity } from '@/services/geo-activity';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { isMobileDevice, getCSSColor } from '@/utils';
import { t } from '@/services/i18n';
import { fetchHotspotContext, formatArticleDate, extractDomain, type GdeltArticle } from '@/services/gdelt-intel';
import { getNaturalEventIcon } from '@/services/eonet';
import { getHotspotEscalation, getEscalationChange24h } from '@/services/hotspot-escalation';
import { getCableHealthRecord } from '@/services/cable-health';

export type PopupType = 'conflict' | 'hotspot' | 'earthquake' | 'weather' | 'base' | 'waterway' | 'apt' | 'cyberThreat' | 'nuclear' | 'economic' | 'irradiator' | 'pipeline' | 'cable' | 'cable-advisory' | 'repair-ship' | 'outage' | 'datacenter' | 'datacenterCluster' | 'ais' | 'protest' | 'protestCluster' | 'flight' | 'militaryFlight' | 'militaryVessel' | 'militaryFlightCluster' | 'militaryVesselCluster' | 'natEvent' | 'port' | 'spaceport' | 'mineral' | 'startupHub' | 'cloudRegion' | 'techHQ' | 'accelerator' | 'techEvent' | 'techHQCluster' | 'techEventCluster' | 'techActivity' | 'geoActivity' | 'stockExchange' | 'financialCenter' | 'centralBank' | 'commodityHub';

interface TechEventPopupData {
  id: string;
  title: string;
  location: string;
  lat: number;
  lng: number;
  country: string;
  startDate: string;
  endDate: string;
  url: string | null;
  daysUntil: number;
}

interface TechHQClusterData {
  items: TechHQ[];
  city: string;
  country: string;
  count?: number;
  faangCount?: number;
  unicornCount?: number;
  publicCount?: number;
  sampled?: boolean;
}

interface TechEventClusterData {
  items: TechEventPopupData[];
  location: string;
  country: string;
  count?: number;
  soonCount?: number;
  sampled?: boolean;
}

// Finance popup data types
interface StockExchangePopupData {
  id: string;
  name: string;
  shortName: string;
  city: string;
  country: string;
  tier: string;
  marketCap?: number;
  tradingHours?: string;
  timezone?: string;
  description?: string;
}

interface FinancialCenterPopupData {
  id: string;
  name: string;
  city: string;
  country: string;
  type: string;
  gfciRank?: number;
  specialties?: string[];
  description?: string;
}

interface CentralBankPopupData {
  id: string;
  name: string;
  shortName: string;
  city: string;
  country: string;
  type: string;
  currency?: string;
  description?: string;
}

interface CommodityHubPopupData {
  id: string;
  name: string;
  city: string;
  country: string;
  type: string;
  commodities?: string[];
  description?: string;
}

interface ProtestClusterData {
  items: SocialUnrestEvent[];
  country: string;
  count?: number;
  riotCount?: number;
  highSeverityCount?: number;
  verifiedCount?: number;
  totalFatalities?: number;
  sampled?: boolean;
}

interface DatacenterClusterData {
  items: AIDataCenter[];
  region: string;
  country: string;
  count?: number;
  totalChips?: number;
  totalPowerMW?: number;
  existingCount?: number;
  plannedCount?: number;
  sampled?: boolean;
}

interface PopupData {
  type: PopupType;
  data: ConflictZone | Hotspot | Earthquake | WeatherAlert | MilitaryBase | StrategicWaterway | APTGroup | CyberThreat | NuclearFacility | EconomicCenter | GammaIrradiator | Pipeline | UnderseaCable | CableAdvisory | RepairShip | InternetOutage | AIDataCenter | AisDisruptionEvent | SocialUnrestEvent | AirportDelayAlert | MilitaryFlight | MilitaryVessel | MilitaryFlightCluster | MilitaryVesselCluster | NaturalEvent | Port | Spaceport | CriticalMineralProject | StartupHub | CloudRegion | TechHQ | Accelerator | TechEventPopupData | TechHQClusterData | TechEventClusterData | ProtestClusterData | DatacenterClusterData | TechHubActivity | GeoHubActivity | StockExchangePopupData | FinancialCenterPopupData | CentralBankPopupData | CommodityHubPopupData;
  relatedNews?: NewsItem[];
  x: number;
  y: number;
}

export class MapPopup {
  private container: HTMLElement;
  private popup: HTMLElement | null = null;
  private onClose?: () => void;
  private cableAdvisories: CableAdvisory[] = [];
  private repairShips: RepairShip[] = [];
  private isMobileSheet = false;
  private sheetTouchStartY: number | null = null;
  private sheetCurrentOffset = 0;
  private readonly mobileDismissThreshold = 96;
  private outsideListenerTimeoutId: number | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  public show(data: PopupData): void {
    this.hide();

    this.isMobileSheet = isMobileDevice();
    this.popup = document.createElement('div');
    this.popup.className = this.isMobileSheet ? 'map-popup map-popup-sheet' : 'map-popup';

    const content = this.renderContent(data);
    this.popup.innerHTML = this.isMobileSheet
      ? `<button class="map-popup-sheet-handle" aria-label="${t('common.close')}"></button>${content}`
      : content;

    // Get container's viewport position for absolute positioning
    const containerRect = this.container.getBoundingClientRect();

    if (this.isMobileSheet) {
      this.popup.style.left = '';
      this.popup.style.top = '';
      this.popup.style.transform = '';
    } else {
      this.positionDesktopPopup(data, containerRect);
    }

    // Append to body to avoid container overflow clipping
    document.body.appendChild(this.popup);

    // Close button handler
    this.popup.querySelector('.popup-close')?.addEventListener('click', () => this.hide());
    this.popup.querySelector('.map-popup-sheet-handle')?.addEventListener('click', () => this.hide());

    if (this.isMobileSheet) {
      this.popup.addEventListener('touchstart', this.handleSheetTouchStart, { passive: true });
      this.popup.addEventListener('touchmove', this.handleSheetTouchMove, { passive: false });
      this.popup.addEventListener('touchend', this.handleSheetTouchEnd);
      this.popup.addEventListener('touchcancel', this.handleSheetTouchEnd);
      requestAnimationFrame(() => {
        if (!this.popup) return;
        this.popup.classList.add('open');
        // Remove will-change after slide-in transition to free GPU memory
        this.popup.addEventListener('transitionend', () => {
          if (this.popup) this.popup.style.willChange = 'auto';
        }, { once: true });
      });
    }

    // Click outside to close
    if (this.outsideListenerTimeoutId !== null) {
      window.clearTimeout(this.outsideListenerTimeoutId);
    }
    this.outsideListenerTimeoutId = window.setTimeout(() => {
      document.addEventListener('click', this.handleOutsideClick);
      document.addEventListener('touchstart', this.handleOutsideClick);
      document.addEventListener('keydown', this.handleEscapeKey);
      this.outsideListenerTimeoutId = null;
    }, 0);
  }

  private positionDesktopPopup(data: PopupData, containerRect: DOMRect): void {
    if (!this.popup) return;

    const popupWidth = 380;
    const bottomBuffer = 50; // Buffer from viewport bottom
    const topBuffer = 60; // Header height

    // Temporarily append popup off-screen to measure actual height
    this.popup.style.visibility = 'hidden';
    this.popup.style.top = '0';
    this.popup.style.left = '-9999px';
    document.body.appendChild(this.popup);
    const popupHeight = this.popup.offsetHeight;
    document.body.removeChild(this.popup);
    this.popup.style.visibility = '';

    // Convert container-relative coords to viewport coords
    const viewportX = containerRect.left + data.x;
    const viewportY = containerRect.top + data.y;

    // Horizontal positioning (viewport-relative)
    const maxX = window.innerWidth - popupWidth - 20;
    let left = viewportX + 20;
    if (left > maxX) {
      // Position to the left of click if it would overflow right
      left = Math.max(10, viewportX - popupWidth - 20);
    }

    // Vertical positioning - prefer below click, but flip above if needed
    const availableBelow = window.innerHeight - viewportY - bottomBuffer;
    const availableAbove = viewportY - topBuffer;

    let top: number;
    if (availableBelow >= popupHeight) {
      // Enough space below - position below click
      top = viewportY + 10;
    } else if (availableAbove >= popupHeight) {
      // Not enough below, but enough above - position above click
      top = viewportY - popupHeight - 10;
    } else {
      // Limited space both ways - position at top buffer
      top = topBuffer;
    }

    // CRITICAL: Ensure popup stays within viewport vertically
    top = Math.max(topBuffer, top);
    const maxTop = window.innerHeight - popupHeight - bottomBuffer;
    if (maxTop > topBuffer) {
      top = Math.min(top, maxTop);
    }

    this.popup.style.left = `${left}px`;
    this.popup.style.top = `${top}px`;
  }

  private handleOutsideClick = (e: Event) => {
    if (this.popup && !this.popup.contains(e.target as Node)) {
      this.hide();
    }
  };

  private handleEscapeKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      this.hide();
    }
  };

  private handleSheetTouchStart = (e: TouchEvent): void => {
    if (!this.popup || !this.isMobileSheet || e.touches.length !== 1) return;

    const target = e.target as HTMLElement | null;
    const popupBody = this.popup.querySelector('.popup-body');
    if (target?.closest('.popup-body') && popupBody && popupBody.scrollTop > 0) {
      this.sheetTouchStartY = null;
      return;
    }

    this.sheetTouchStartY = e.touches[0]?.clientY ?? null;
    this.sheetCurrentOffset = 0;
    this.popup.classList.add('dragging');
  };

  private handleSheetTouchMove = (e: TouchEvent): void => {
    if (!this.popup || !this.isMobileSheet || this.sheetTouchStartY === null) return;

    const currentY = e.touches[0]?.clientY;
    if (currentY == null) return;

    const delta = Math.max(0, currentY - this.sheetTouchStartY);
    if (delta <= 0) return;

    this.sheetCurrentOffset = delta;
    this.popup.style.transform = `translate3d(0, ${delta}px, 0)`;
    e.preventDefault();
  };

  private handleSheetTouchEnd = (): void => {
    if (!this.popup || !this.isMobileSheet || this.sheetTouchStartY === null) return;

    const shouldDismiss = this.sheetCurrentOffset >= this.mobileDismissThreshold;
    this.popup.classList.remove('dragging');
    this.sheetTouchStartY = null;

    if (shouldDismiss) {
      this.hide();
      return;
    }

    this.sheetCurrentOffset = 0;
    this.popup.style.transform = '';
    this.popup.classList.add('open');
  };

  public hide(): void {
    if (this.outsideListenerTimeoutId !== null) {
      window.clearTimeout(this.outsideListenerTimeoutId);
      this.outsideListenerTimeoutId = null;
    }

    if (this.popup) {
      this.popup.removeEventListener('touchstart', this.handleSheetTouchStart);
      this.popup.removeEventListener('touchmove', this.handleSheetTouchMove);
      this.popup.removeEventListener('touchend', this.handleSheetTouchEnd);
      this.popup.removeEventListener('touchcancel', this.handleSheetTouchEnd);
      this.popup.remove();
      this.popup = null;
      this.isMobileSheet = false;
      this.sheetTouchStartY = null;
      this.sheetCurrentOffset = 0;
      document.removeEventListener('click', this.handleOutsideClick);
      document.removeEventListener('touchstart', this.handleOutsideClick);
      document.removeEventListener('keydown', this.handleEscapeKey);
      this.onClose?.();
    }
  }

  public setOnClose(callback: () => void): void {
    this.onClose = callback;
  }

  public setCableActivity(advisories: CableAdvisory[], repairShips: RepairShip[]): void {
    this.cableAdvisories = advisories;
    this.repairShips = repairShips;
  }

  private renderContent(data: PopupData): string {
    switch (data.type) {
      case 'conflict':
        return this.renderConflictPopup(data.data as ConflictZone);
      case 'hotspot':
        return this.renderHotspotPopup(data.data as Hotspot, data.relatedNews);
      case 'earthquake':
        return this.renderEarthquakePopup(data.data as Earthquake);
      case 'weather':
        return this.renderWeatherPopup(data.data as WeatherAlert);
      case 'base':
        return this.renderBasePopup(data.data as MilitaryBase);
      case 'waterway':
        return this.renderWaterwayPopup(data.data as StrategicWaterway);
      case 'apt':
        return this.renderAPTPopup(data.data as APTGroup);
      case 'cyberThreat':
        return this.renderCyberThreatPopup(data.data as CyberThreat);
      case 'nuclear':
        return this.renderNuclearPopup(data.data as NuclearFacility);
      case 'economic':
        return this.renderEconomicPopup(data.data as EconomicCenter);
      case 'irradiator':
        return this.renderIrradiatorPopup(data.data as GammaIrradiator);
      case 'pipeline':
        return this.renderPipelinePopup(data.data as Pipeline);
      case 'cable':
        return this.renderCablePopup(data.data as UnderseaCable);
      case 'cable-advisory':
        return this.renderCableAdvisoryPopup(data.data as CableAdvisory);
      case 'repair-ship':
        return this.renderRepairShipPopup(data.data as RepairShip);
      case 'outage':
        return this.renderOutagePopup(data.data as InternetOutage);
      case 'datacenter':
        return this.renderDatacenterPopup(data.data as AIDataCenter);
      case 'datacenterCluster':
        return this.renderDatacenterClusterPopup(data.data as DatacenterClusterData);
      case 'ais':
        return this.renderAisPopup(data.data as AisDisruptionEvent);
      case 'protest':
        return this.renderProtestPopup(data.data as SocialUnrestEvent);
      case 'protestCluster':
        return this.renderProtestClusterPopup(data.data as ProtestClusterData);
      case 'flight':
        return this.renderFlightPopup(data.data as AirportDelayAlert);
      case 'militaryFlight':
        return this.renderMilitaryFlightPopup(data.data as MilitaryFlight);
      case 'militaryVessel':
        return this.renderMilitaryVesselPopup(data.data as MilitaryVessel);
      case 'militaryFlightCluster':
        return this.renderMilitaryFlightClusterPopup(data.data as MilitaryFlightCluster);
      case 'militaryVesselCluster':
        return this.renderMilitaryVesselClusterPopup(data.data as MilitaryVesselCluster);
      case 'natEvent':
        return this.renderNaturalEventPopup(data.data as NaturalEvent);
      case 'port':
        return this.renderPortPopup(data.data as Port);
      case 'spaceport':
        return this.renderSpaceportPopup(data.data as Spaceport);
      case 'mineral':
        return this.renderMineralPopup(data.data as CriticalMineralProject);
      case 'startupHub':
        return this.renderStartupHubPopup(data.data as StartupHub);
      case 'cloudRegion':
        return this.renderCloudRegionPopup(data.data as CloudRegion);
      case 'techHQ':
        return this.renderTechHQPopup(data.data as TechHQ);
      case 'accelerator':
        return this.renderAcceleratorPopup(data.data as Accelerator);
      case 'techEvent':
        return this.renderTechEventPopup(data.data as TechEventPopupData);
      case 'techHQCluster':
        return this.renderTechHQClusterPopup(data.data as TechHQClusterData);
      case 'techEventCluster':
        return this.renderTechEventClusterPopup(data.data as TechEventClusterData);
      case 'stockExchange':
        return this.renderStockExchangePopup(data.data as StockExchangePopupData);
      case 'financialCenter':
        return this.renderFinancialCenterPopup(data.data as FinancialCenterPopupData);
      case 'centralBank':
        return this.renderCentralBankPopup(data.data as CentralBankPopupData);
      case 'commodityHub':
        return this.renderCommodityHubPopup(data.data as CommodityHubPopupData);
      default:
        return '';
    }
  }

  private renderConflictPopup(conflict: ConflictZone): string {
    const severityClass = conflict.intensity === 'high' ? 'high' : conflict.intensity === 'medium' ? 'medium' : 'low';
    const severityLabel = escapeHtml(conflict.intensity?.toUpperCase() || t('popups.unknown').toUpperCase());

    return `
      <div class="popup-header conflict">
        <span class="popup-title">${escapeHtml(conflict.name.toUpperCase())}</span>
        <span class="popup-badge ${severityClass}">${severityLabel}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.startDate')}</span>
            <span class="stat-value">${escapeHtml(conflict.startDate || t('popups.unknown'))}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.casualties')}</span>
            <span class="stat-value">${escapeHtml(conflict.casualties || t('popups.unknown'))}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.displaced')}</span>
            <span class="stat-value">${escapeHtml(conflict.displaced || t('popups.unknown'))}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.location')}</span>
            <span class="stat-value">${escapeHtml(conflict.location || `${conflict.center[1]}°N, ${conflict.center[0]}°E`)}</span>
          </div>
        </div>
        ${conflict.description ? `<p class="popup-description">${escapeHtml(conflict.description)}</p>` : ''}
        ${conflict.parties && conflict.parties.length > 0 ? `
          <div class="popup-section">
            <span class="section-label">${t('popups.belligerents')}</span>
            <div class="popup-tags">
              ${conflict.parties.map(p => `<span class="popup-tag">${escapeHtml(p)}</span>`).join('')}
            </div>
          </div>
        ` : ''}
        ${conflict.keyDevelopments && conflict.keyDevelopments.length > 0 ? `
          <div class="popup-section">
            <span class="section-label">${t('popups.keyDevelopments')}</span>
            <ul class="popup-list">
              ${conflict.keyDevelopments.map(d => `<li>${escapeHtml(d)}</li>`).join('')}
            </ul>
          </div>
        ` : ''}
      </div>
    `;
  }

  private getLocalizedHotspotSubtext(subtext: string): string {
    const slug = subtext
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    const key = `popups.hotspotSubtexts.${slug}`;
    const localized = t(key);
    return localized === key ? subtext : localized;
  }

  private renderHotspotPopup(hotspot: Hotspot, relatedNews?: NewsItem[]): string {
    const severityClass = hotspot.level || 'low';
    const severityLabel = escapeHtml((hotspot.level || 'low').toUpperCase());
    const localizedSubtext = hotspot.subtext ? this.getLocalizedHotspotSubtext(hotspot.subtext) : '';

    // Get dynamic escalation score
    const dynamicScore = getHotspotEscalation(hotspot.id);
    const change24h = getEscalationChange24h(hotspot.id);

    // Escalation score display
    const escalationColors: Record<number, string> = {
      1: getCSSColor('--semantic-normal'),
      2: getCSSColor('--semantic-normal'),
      3: getCSSColor('--semantic-elevated'),
      4: getCSSColor('--semantic-high'),
      5: getCSSColor('--semantic-critical'),
    };
    const escalationLabels: Record<number, string> = {
      1: t('popups.hotspot.levels.stable'),
      2: t('popups.hotspot.levels.watch'),
      3: t('popups.hotspot.levels.elevated'),
      4: t('popups.hotspot.levels.high'),
      5: t('popups.hotspot.levels.critical')
    };
    const trendIcons: Record<string, string> = { 'escalating': '↑', 'stable': '→', 'de-escalating': '↓' };
    const trendColors: Record<string, string> = { 'escalating': getCSSColor('--semantic-critical'), 'stable': getCSSColor('--semantic-elevated'), 'de-escalating': getCSSColor('--semantic-normal') };

    const displayScore = dynamicScore?.combinedScore ?? hotspot.escalationScore ?? 3;
    const displayScoreInt = Math.round(displayScore);
    const displayTrend = dynamicScore?.trend ?? hotspot.escalationTrend ?? 'stable';

    const escalationSection = `
      <div class="popup-section escalation-section">
        <span class="section-label">${t('popups.hotspot.escalation')}</span>
        <div class="escalation-display">
          <div class="escalation-score" style="background: ${escalationColors[displayScoreInt] || getCSSColor('--text-dim')}">
            <span class="score-value">${displayScore.toFixed(1)}/5</span>
            <span class="score-label">${escalationLabels[displayScoreInt] || t('popups.unknown')}</span>
          </div>
          <div class="escalation-trend" style="color: ${trendColors[displayTrend] || getCSSColor('--text-dim')}">
            <span class="trend-icon">${trendIcons[displayTrend] || ''}</span>
            <span class="trend-label">${escapeHtml(displayTrend.toUpperCase())}</span>
          </div>
        </div>
        ${dynamicScore ? `
          <div class="escalation-breakdown">
            <div class="breakdown-header">
              <span class="baseline-label">${t('popups.hotspot.baseline')}: ${dynamicScore.staticBaseline}/5</span>
              ${change24h ? `
                <span class="change-label ${change24h.change >= 0 ? 'rising' : 'falling'}">
                  24h: ${change24h.change >= 0 ? '+' : ''}${change24h.change}
                </span>
              ` : ''}
            </div>
            <div class="breakdown-components">
              <div class="breakdown-row">
                <span class="component-label">${t('popups.hotspot.components.news')}</span>
                <div class="component-bar-bg">
                  <div class="component-bar news" style="width: ${dynamicScore.components.newsActivity}%"></div>
                </div>
                <span class="component-value">${Math.round(dynamicScore.components.newsActivity)}</span>
              </div>
              <div class="breakdown-row">
                <span class="component-label">${t('popups.hotspot.components.cii')}</span>
                <div class="component-bar-bg">
                  <div class="component-bar cii" style="width: ${dynamicScore.components.ciiContribution}%"></div>
                </div>
                <span class="component-value">${Math.round(dynamicScore.components.ciiContribution)}</span>
              </div>
              <div class="breakdown-row">
                <span class="component-label">${t('popups.hotspot.components.geo')}</span>
                <div class="component-bar-bg">
                  <div class="component-bar geo" style="width: ${dynamicScore.components.geoConvergence}%"></div>
                </div>
                <span class="component-value">${Math.round(dynamicScore.components.geoConvergence)}</span>
              </div>
              <div class="breakdown-row">
                <span class="component-label">${t('popups.hotspot.components.military')}</span>
                <div class="component-bar-bg">
                  <div class="component-bar military" style="width: ${dynamicScore.components.militaryActivity}%"></div>
                </div>
                <span class="component-value">${Math.round(dynamicScore.components.militaryActivity)}</span>
              </div>
            </div>
          </div>
        ` : ''}
        ${hotspot.escalationIndicators && hotspot.escalationIndicators.length > 0 ? `
          <div class="escalation-indicators">
            ${hotspot.escalationIndicators.map(i => `<span class="indicator-tag">• ${escapeHtml(i)}</span>`).join('')}
          </div>
        ` : ''}
      </div>
    `;

    // Historical context section
    const historySection = hotspot.history ? `
      <div class="popup-section history-section">
        <span class="section-label">${t('popups.historicalContext')}</span>
        <div class="history-content">
          ${hotspot.history.lastMajorEvent ? `
            <div class="history-event">
              <span class="history-label">${t('popups.lastMajorEvent')}:</span>
              <span class="history-value">${escapeHtml(hotspot.history.lastMajorEvent)} ${hotspot.history.lastMajorEventDate ? `(${escapeHtml(hotspot.history.lastMajorEventDate)})` : ''}</span>
            </div>
          ` : ''}
          ${hotspot.history.precedentDescription ? `
            <div class="history-event">
              <span class="history-label">${t('popups.precedents')}:</span>
              <span class="history-value">${escapeHtml(hotspot.history.precedentDescription)}</span>
            </div>
          ` : ''}
          ${hotspot.history.cyclicalRisk ? `
            <div class="history-event cyclical">
              <span class="history-label">${t('popups.cyclicalPattern')}:</span>
              <span class="history-value">${escapeHtml(hotspot.history.cyclicalRisk)}</span>
            </div>
          ` : ''}
        </div>
      </div>
    ` : '';

    // "Why it matters" section
    const whyItMattersSection = hotspot.whyItMatters ? `
      <div class="popup-section why-matters-section">
        <span class="section-label">${t('popups.whyItMatters')}</span>
        <p class="why-matters-text">${escapeHtml(hotspot.whyItMatters)}</p>
      </div>
    ` : '';

    return `
      <div class="popup-header hotspot">
        <span class="popup-title">${escapeHtml(hotspot.name.toUpperCase())}</span>
        <span class="popup-badge ${severityClass}">${severityLabel}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        ${localizedSubtext ? `<div class="popup-subtitle">${escapeHtml(localizedSubtext)}</div>` : ''}
        ${hotspot.description ? `<p class="popup-description">${escapeHtml(hotspot.description)}</p>` : ''}
        ${escalationSection}
        <div class="popup-stats">
          ${hotspot.location ? `
            <div class="popup-stat">
              <span class="stat-label">${t('popups.location')}</span>
              <span class="stat-value">${escapeHtml(hotspot.location)}</span>
            </div>
          ` : ''}
          <div class="popup-stat">
            <span class="stat-label">${t('popups.coordinates')}</span>
            <span class="stat-value">${escapeHtml(`${hotspot.lat.toFixed(2)}°N, ${hotspot.lon.toFixed(2)}°E`)}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.status')}</span>
            <span class="stat-value">${escapeHtml(hotspot.status || t('popups.monitoring'))}</span>
          </div>
        </div>
        ${whyItMattersSection}
        ${historySection}
        ${hotspot.agencies && hotspot.agencies.length > 0 ? `
          <div class="popup-section">
            <span class="section-label">${t('popups.keyEntities')}</span>
            <div class="popup-tags">
              ${hotspot.agencies.map(a => `<span class="popup-tag">${escapeHtml(a)}</span>`).join('')}
            </div>
          </div>
        ` : ''}
        ${relatedNews && relatedNews.length > 0 ? `
          <div class="popup-section">
          <div class="popup-section">
            <span class="section-label">${t('popups.relatedHeadlines')}</span>
            <div class="popup-news">
              ${relatedNews.slice(0, 5).map(n => `
                <div class="popup-news-item">
                  <span class="news-source">${escapeHtml(n.source)}</span>
                  <a href="${sanitizeUrl(n.link)}" target="_blank" class="news-title">${escapeHtml(n.title)}</a>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
        <div class="hotspot-gdelt-context" data-hotspot-id="${escapeHtml(hotspot.id)}">
          <div class="hotspot-gdelt-header">${t('popups.liveIntel')}</div>
          <div class="hotspot-gdelt-loading">${t('popups.loadingNews')}</div>
        </div>
      </div>
    `;
  }

  public async loadHotspotGdeltContext(hotspot: Hotspot): Promise<void> {
    if (!this.popup) return;

    const container = this.popup.querySelector('.hotspot-gdelt-context');
    if (!container) return;

    try {
      const articles = await fetchHotspotContext(hotspot);

      if (!this.popup || !container.isConnected) return;

      if (articles.length === 0) {
        container.innerHTML = `
          <div class="hotspot-gdelt-header">${t('popups.liveIntel')}</div>
          <div class="hotspot-gdelt-loading">${t('popups.noCoverage')}</div>
        `;
        return;
      }

      container.innerHTML = `
        <div class="hotspot-gdelt-header">${t('popups.liveIntel')}</div>
        <div class="hotspot-gdelt-articles">
          ${articles.slice(0, 5).map(article => this.renderGdeltArticle(article)).join('')}
        </div>
      `;
    } catch (error) {
      if (container.isConnected) {
        container.innerHTML = `
          <div class="hotspot-gdelt-header">${t('popups.liveIntel')}</div>
          <div class="hotspot-gdelt-loading">${t('common.error')}</div>
        `;
      }
    }
  }

  private renderGdeltArticle(article: GdeltArticle): string {
    const domain = article.source || extractDomain(article.url);
    const timeAgo = formatArticleDate(article.date);

    return `
      <a href="${sanitizeUrl(article.url)}" target="_blank" rel="noopener" class="hotspot-gdelt-article">
        <div class="article-meta">
          <span>${escapeHtml(domain)}</span>
          <span>${escapeHtml(timeAgo)}</span>
        </div>
        <div class="article-title">${escapeHtml(article.title)}</div>
      </a>
    `;
  }

  private renderEarthquakePopup(earthquake: Earthquake): string {
    const severity = earthquake.magnitude >= 6 ? 'high' : earthquake.magnitude >= 5 ? 'medium' : 'low';
    const severityLabel = earthquake.magnitude >= 6 ? t('popups.earthquake.levels.major') : earthquake.magnitude >= 5 ? t('popups.earthquake.levels.moderate') : t('popups.earthquake.levels.minor');

    const timeAgo = this.getTimeAgo(new Date(earthquake.occurredAt));

    return `
      <div class="popup-header earthquake">
        <span class="popup-title magnitude">M${earthquake.magnitude.toFixed(1)}</span>
        <span class="popup-badge ${severity}">${severityLabel}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <p class="popup-location">${escapeHtml(earthquake.place)}</p>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.depth')}</span>
            <span class="stat-value">${earthquake.depthKm.toFixed(1)} km</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.coordinates')}</span>
            <span class="stat-value">${(earthquake.location?.latitude ?? 0).toFixed(2)}°, ${(earthquake.location?.longitude ?? 0).toFixed(2)}°</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.time')}</span>
            <span class="stat-value">${timeAgo}</span>
          </div>
        </div>
        <a href="${sanitizeUrl(earthquake.sourceUrl)}" target="_blank" class="popup-link">${t('popups.viewUSGS')} →</a>
      </div>
    `;
  }

  private getTimeAgo(date: Date): string {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return t('popups.timeAgo.s', { count: seconds });
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return t('popups.timeAgo.m', { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('popups.timeAgo.h', { count: hours });
    const days = Math.floor(hours / 24);
    return t('popups.timeAgo.d', { count: days });
  }

  private renderWeatherPopup(alert: WeatherAlert): string {
    const severityClass = escapeHtml(alert.severity.toLowerCase());
    const expiresIn = this.getTimeUntil(alert.expires);

    return `
      <div class="popup-header weather ${severityClass}">
        <span class="popup-title">${escapeHtml(alert.event.toUpperCase())}</span>
        <span class="popup-badge ${severityClass}">${escapeHtml(alert.severity.toUpperCase())}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <p class="popup-headline">${escapeHtml(alert.headline)}</p>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.area')}</span>
            <span class="stat-value">${escapeHtml(alert.areaDesc)}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.expires')}</span>
            <span class="stat-value">${expiresIn}</span>
          </div>
        </div>
        <p class="popup-description">${escapeHtml(alert.description.slice(0, 300))}${alert.description.length > 300 ? '...' : ''}</p>
      </div>
    `;
  }

  private getTimeUntil(date: Date): string {
    const ms = date.getTime() - Date.now();
    if (ms <= 0) return t('popups.expired');
    const hours = Math.floor(ms / (1000 * 60 * 60));
    if (hours < 1) return `${Math.floor(ms / (1000 * 60))}${t('popups.timeUnits.m')}`;
    if (hours < 24) return `${hours}${t('popups.timeUnits.h')}`;
    return `${Math.floor(hours / 24)}${t('popups.timeUnits.d')}`;
  }

  private renderBasePopup(base: MilitaryBase): string {
    const typeLabels: Record<string, string> = {
      'us-nato': t('popups.base.types.us-nato'),
      'china': t('popups.base.types.china'),
      'russia': t('popups.base.types.russia'),
    };
    const typeColors: Record<string, string> = {
      'us-nato': 'elevated',
      'china': 'high',
      'russia': 'high',
    };

    return `
      <div class="popup-header base">
        <span class="popup-title">${escapeHtml(base.name.toUpperCase())}</span>
        <span class="popup-badge ${typeColors[base.type] || 'low'}">${escapeHtml(typeLabels[base.type] || base.type.toUpperCase())}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        ${base.description ? `<p class="popup-description">${escapeHtml(base.description)}</p>` : ''}
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.type')}</span>
            <span class="stat-value">${escapeHtml(typeLabels[base.type] || base.type)}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.coordinates')}</span>
            <span class="stat-value">${base.lat.toFixed(2)}°, ${base.lon.toFixed(2)}°</span>
          </div>
        </div>
      </div>
    `;
  }

  private renderWaterwayPopup(waterway: StrategicWaterway): string {
    return `
      <div class="popup-header waterway">
        <span class="popup-title">${escapeHtml(waterway.name)}</span>
        <span class="popup-badge elevated">${t('popups.strategic')}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        ${waterway.description ? `<p class="popup-description">${escapeHtml(waterway.description)}</p>` : ''}
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.coordinates')}</span>
            <span class="stat-value">${waterway.lat.toFixed(2)}°, ${waterway.lon.toFixed(2)}°</span>
          </div>
        </div>
      </div>
    `;
  }

  private renderAisPopup(event: AisDisruptionEvent): string {
    const severityClass = escapeHtml(event.severity);
    const severityLabel = escapeHtml(event.severity.toUpperCase());
    const typeLabel = event.type === 'gap_spike' ? t('popups.aisGapSpike') : t('popups.chokepointCongestion');
    const changeLabel = event.type === 'gap_spike' ? t('popups.darkening') : t('popups.density');
    const countLabel = event.type === 'gap_spike' ? t('popups.darkShips') : t('popups.vesselCount');
    const countValue = event.type === 'gap_spike'
      ? event.darkShips?.toString() || '—'
      : event.vesselCount?.toString() || '—';

    return `
      <div class="popup-header ais">
        <span class="popup-title">${escapeHtml(event.name.toUpperCase())}</span>
        <span class="popup-badge ${severityClass}">${severityLabel}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${typeLabel}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${changeLabel}</span>
            <span class="stat-value">${event.changePct}% ↑</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${countLabel}</span>
            <span class="stat-value">${countValue}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.window')}</span>
            <span class="stat-value">${event.windowHours}H</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.region')}</span>
            <span class="stat-value">${escapeHtml(event.region || `${event.lat.toFixed(2)}°, ${event.lon.toFixed(2)}°`)}</span>
          </div>
        </div>
        <p class="popup-description">${escapeHtml(event.description)}</p>
      </div>
    `;
  }

  private renderProtestPopup(event: SocialUnrestEvent): string {
    const severityClass = escapeHtml(event.severity);
    const severityLabel = escapeHtml(event.severity.toUpperCase());
    const eventTypeLabel = escapeHtml(event.eventType.replace('_', ' ').toUpperCase());
    const icon = event.eventType === 'riot' ? '🔥' : event.eventType === 'strike' ? '✊' : '📢';
    const sourceLabel = event.sourceType === 'acled' ? t('popups.protest.acledVerified') : t('popups.protest.gdelt');
    const validatedBadge = event.validated ? `<span class="popup-badge verified">${t('popups.verified')}</span>` : '';
    const fatalitiesSection = event.fatalities
      ? `<div class="popup-stat"><span class="stat-label">${t('popups.fatalities')}</span><span class="stat-value alert">${event.fatalities}</span></div>`
      : '';
    const actorsSection = event.actors?.length
      ? `<div class="popup-stat"><span class="stat-label">${t('popups.actors')}</span><span class="stat-value">${event.actors.map(a => escapeHtml(a)).join(', ')}</span></div>`
      : '';
    const tagsSection = event.tags?.length
      ? `<div class="popup-tags">${event.tags.map(t => `<span class="popup-tag">${escapeHtml(t)}</span>`).join('')}</div>`
      : '';
    const relatedHotspots = event.relatedHotspots?.length
      ? `<div class="popup-related">${t('popups.near')}: ${event.relatedHotspots.map(h => escapeHtml(h)).join(', ')}</div>`
      : '';

    return `
      <div class="popup-header protest ${severityClass}">
        <span class="popup-icon">${icon}</span>
        <span class="popup-title">${eventTypeLabel}</span>
        <span class="popup-badge ${severityClass}">${severityLabel}</span>
        ${validatedBadge}
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${event.city ? `${escapeHtml(event.city)}, ` : ''}${escapeHtml(event.country)}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.time')}</span>
            <span class="stat-value">${event.time.toLocaleDateString()}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.source')}</span>
            <span class="stat-value">${sourceLabel}</span>
          </div>
          ${fatalitiesSection}
          ${actorsSection}
        </div>
        ${event.title ? `<p class="popup-description">${escapeHtml(event.title)}</p>` : ''}
        ${tagsSection}
        ${relatedHotspots}
      </div>
    `;
  }

  private renderProtestClusterPopup(data: ProtestClusterData): string {
    const totalCount = data.count ?? data.items.length;
    const riots = data.riotCount ?? data.items.filter(e => e.eventType === 'riot').length;
    const highSeverity = data.highSeverityCount ?? data.items.filter(e => e.severity === 'high').length;
    const verified = data.verifiedCount ?? data.items.filter(e => e.validated).length;
    const totalFatalities = data.totalFatalities ?? data.items.reduce((sum, e) => sum + (e.fatalities || 0), 0);

    const sortedItems = [...data.items].sort((a, b) => {
      const severityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
      const typeOrder: Record<string, number> = { riot: 0, civil_unrest: 1, strike: 2, demonstration: 3, protest: 4 };
      const sevDiff = (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3);
      if (sevDiff !== 0) return sevDiff;
      return (typeOrder[a.eventType] ?? 5) - (typeOrder[b.eventType] ?? 5);
    });

    const listItems = sortedItems.slice(0, 10).map(event => {
      const icon = event.eventType === 'riot' ? '🔥' : event.eventType === 'strike' ? '✊' : '📢';
      const sevClass = event.severity;
      const dateStr = event.time.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const city = event.city ? escapeHtml(event.city) : '';
      const title = event.title ? `: ${escapeHtml(event.title.slice(0, 40))}${event.title.length > 40 ? '...' : ''}` : '';
      return `<li class="cluster-item ${sevClass}">${icon} ${dateStr}${city ? ` • ${city}` : ''}${title}</li>`;
    }).join('');

    const renderedCount = Math.min(10, data.items.length);
    const remainingCount = Math.max(0, totalCount - renderedCount);
    const moreCount = remainingCount > 0 ? `<li class="cluster-more">+${remainingCount} ${t('popups.moreEvents')}</li>` : '';
    const headerClass = highSeverity > 0 ? 'high' : riots > 0 ? 'medium' : 'low';

    return `
      <div class="popup-header protest ${headerClass} cluster">
        <span class="popup-title">📢 ${escapeHtml(data.country)}</span>
        <span class="popup-badge">${totalCount} ${t('popups.events').toUpperCase()}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body cluster-popup">
        <div class="cluster-summary">
          ${riots ? `<span class="summary-item riot">🔥 ${riots} ${t('popups.protest.riots')}</span>` : ''}
          ${highSeverity ? `<span class="summary-item high">⚠️ ${highSeverity} ${t('popups.protest.highSeverity')}</span>` : ''}
          ${verified ? `<span class="summary-item verified">✓ ${verified} ${t('popups.verified')}</span>` : ''}
          ${totalFatalities > 0 ? `<span class="summary-item fatalities">💀 ${totalFatalities} ${t('popups.fatalities')}</span>` : ''}
        </div>
        <ul class="cluster-list">${listItems}${moreCount}</ul>
        ${data.sampled ? `<p class="popup-more">${t('popups.sampledList', { count: data.items.length })}</p>` : ''}
      </div>
    `;
  }

  private renderFlightPopup(delay: AirportDelayAlert): string {
    const severityClass = escapeHtml(delay.severity);
    const severityLabel = escapeHtml(delay.severity.toUpperCase());
    const delayTypeLabels: Record<string, string> = {
      'ground_stop': t('popups.flight.groundStop'),
      'ground_delay': t('popups.flight.groundDelay'),
      'departure_delay': t('popups.flight.departureDelay'),
      'arrival_delay': t('popups.flight.arrivalDelay'),
      'general': t('popups.flight.delaysReported'),
    };
    const delayTypeLabel = delayTypeLabels[delay.delayType] || t('popups.flight.delays');
    const icon = delay.delayType === 'ground_stop' ? '🛑' : delay.severity === 'severe' ? '✈️' : '🛫';
    const sourceLabels: Record<string, string> = {
      'faa': t('popups.flight.sources.faa'),
      'eurocontrol': t('popups.flight.sources.eurocontrol'),
      'computed': t('popups.flight.sources.computed'),
    };
    const sourceLabel = sourceLabels[delay.source] || escapeHtml(delay.source);
    const regionLabels: Record<string, string> = {
      'americas': t('popups.flight.regions.americas'),
      'europe': t('popups.flight.regions.europe'),
      'apac': t('popups.flight.regions.apac'),
      'mena': t('popups.flight.regions.mena'),
      'africa': t('popups.flight.regions.africa'),
    };
    const regionLabel = regionLabels[delay.region] || escapeHtml(delay.region);

    const avgDelaySection = delay.avgDelayMinutes > 0
      ? `<div class="popup-stat"><span class="stat-label">${t('popups.flight.avgDelay')}</span><span class="stat-value alert">+${delay.avgDelayMinutes} ${t('popups.timeUnits.m')}</span></div>`
      : '';
    const reasonSection = delay.reason
      ? `<div class="popup-stat"><span class="stat-label">${t('popups.reason')}</span><span class="stat-value">${escapeHtml(delay.reason)}</span></div>`
      : '';
    const cancelledSection = delay.cancelledFlights
      ? `<div class="popup-stat"><span class="stat-label">${t('popups.flight.cancelled')}</span><span class="stat-value alert">${delay.cancelledFlights} ${t('popups.events')}</span></div>`
      : '';

    return `
      <div class="popup-header flight ${severityClass}">
        <span class="popup-icon">${icon}</span>
        <span class="popup-title">${escapeHtml(delay.iata)} - ${delayTypeLabel}</span>
        <span class="popup-badge ${severityClass}">${severityLabel}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${escapeHtml(delay.name)}</div>
        <div class="popup-location">${escapeHtml(delay.city)}, ${escapeHtml(delay.country)}</div>
        <div class="popup-stats">
          ${avgDelaySection}
          ${reasonSection}
          ${cancelledSection}
          <div class="popup-stat">
            <span class="stat-label">${t('popups.region')}</span>
            <span class="stat-value">${regionLabel}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.source')}</span>
            <span class="stat-value">${sourceLabel}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.updated')}</span>
            <span class="stat-value">${delay.updatedAt.toLocaleTimeString()}</span>
          </div>
        </div>
      </div>
    `;
  }

  private renderAPTPopup(apt: APTGroup): string {
    return `
      <div class="popup-header apt">
        <span class="popup-title">${escapeHtml(apt.name)}</span>
        <span class="popup-badge high">${t('popups.threat')}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${t('popups.aka')}: ${escapeHtml(apt.aka)}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.sponsor')}</span>
            <span class="stat-value">${escapeHtml(apt.sponsor)}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.origin')}</span>
            <span class="stat-value">${apt.lat.toFixed(1)}°, ${apt.lon.toFixed(1)}°</span>
          </div>
        </div>
        <p class="popup-description">${t('popups.apt.description')}</p>
      </div>
    `;
  }


  private renderCyberThreatPopup(threat: CyberThreat): string {
    const severityClass = escapeHtml(threat.severity);
    const sourceLabels: Record<string, string> = {
      feodo: 'Feodo Tracker',
      urlhaus: 'URLhaus',
      c2intel: 'C2 Intel Feeds',
      otx: 'AlienVault OTX',
      abuseipdb: 'AbuseIPDB',
    };
    const sourceLabel = sourceLabels[threat.source] || threat.source;
    const typeLabel = threat.type.replace(/_/g, ' ').toUpperCase();
    const tags = (threat.tags || []).slice(0, 6);

    return `
      <div class="popup-header apt ${severityClass}">
        <span class="popup-title">${t('popups.cyberThreat.title')}</span>
        <span class="popup-badge ${severityClass}">${escapeHtml(threat.severity.toUpperCase())}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${escapeHtml(typeLabel)}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${escapeHtml(threat.indicatorType.toUpperCase())}</span>
            <span class="stat-value">${escapeHtml(threat.indicator)}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.country')}</span>
            <span class="stat-value">${escapeHtml(threat.country || t('popups.unknown'))}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.source')}</span>
            <span class="stat-value">${escapeHtml(sourceLabel)}</span>
          </div>
          ${threat.malwareFamily ? `<div class="popup-stat">
            <span class="stat-label">${t('popups.malware')}</span>
            <span class="stat-value">${escapeHtml(threat.malwareFamily)}</span>
          </div>` : ''}
          <div class="popup-stat">
            <span class="stat-label">${t('popups.lastSeen')}</span>
            <span class="stat-value">${escapeHtml(threat.lastSeen ? new Date(threat.lastSeen).toLocaleString() : t('popups.unknown'))}</span>
          </div>
        </div>
        ${tags.length > 0 ? `
        <div class="popup-tags">
          ${tags.map((tag) => `<span class="popup-tag">${escapeHtml(tag)}</span>`).join('')}
        </div>` : ''}
      </div>
    `;
  }

  private renderNuclearPopup(facility: NuclearFacility): string {
    const typeLabels: Record<string, string> = {
      'plant': t('popups.nuclear.types.plant'),
      'enrichment': t('popups.nuclear.types.enrichment'),
      'weapons': t('popups.nuclear.types.weapons'),
      'research': t('popups.nuclear.types.research'),
    };
    const statusColors: Record<string, string> = {
      'active': 'elevated',
      'contested': 'high',
      'decommissioned': 'low',
    };

    return `
      <div class="popup-header nuclear">
        <span class="popup-title">${escapeHtml(facility.name.toUpperCase())}</span>
        <span class="popup-badge ${statusColors[facility.status] || 'low'}">${escapeHtml(facility.status.toUpperCase())}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.type')}</span>
            <span class="stat-value">${escapeHtml(typeLabels[facility.type] || facility.type.toUpperCase())}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.status')}</span>
            <span class="stat-value">${escapeHtml(facility.status.toUpperCase())}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.coordinates')}</span>
            <span class="stat-value">${facility.lat.toFixed(2)}°, ${facility.lon.toFixed(2)}°</span>
          </div>
        </div>
        <p class="popup-description">${t('popups.nuclear.description')}</p>
      </div>
    `;
  }

  private renderEconomicPopup(center: EconomicCenter): string {
    const typeLabels: Record<string, string> = {
      'exchange': t('popups.economic.types.exchange'),
      'central-bank': t('popups.economic.types.centralBank'),
      'financial-hub': t('popups.economic.types.financialHub'),
    };
    const typeIcons: Record<string, string> = {
      'exchange': '📈',
      'central-bank': '🏛',
      'financial-hub': '💰',
    };

    const marketStatus = center.marketHours ? this.getMarketStatus(center.marketHours) : null;
    const marketStatusLabel = marketStatus
      ? marketStatus === 'open'
        ? t('popups.open')
        : marketStatus === 'closed'
        ? t('popups.economic.closed')
        : t('popups.unknown')
      : '';

    return `
      <div class="popup-header economic ${center.type}">
        <span class="popup-title">${typeIcons[center.type] || ''} ${escapeHtml(center.name.toUpperCase())}</span>
        <span class="popup-badge ${marketStatus === 'open' ? 'elevated' : 'low'}">${escapeHtml(marketStatusLabel || typeLabels[center.type] || '')}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        ${center.description ? `<p class="popup-description">${escapeHtml(center.description)}</p>` : ''}
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.type')}</span>
            <span class="stat-value">${escapeHtml(typeLabels[center.type] || center.type.toUpperCase())}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.country')}</span>
            <span class="stat-value">${escapeHtml(center.country)}</span>
          </div>
          ${center.marketHours ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.tradingHours')}</span>
            <span class="stat-value">${escapeHtml(center.marketHours.open)} - ${escapeHtml(center.marketHours.close)}</span>
          </div>
          ` : ''}
          <div class="popup-stat">
            <span class="stat-label">${t('popups.coordinates')}</span>
            <span class="stat-value">${center.lat.toFixed(2)}°, ${center.lon.toFixed(2)}°</span>
          </div>
        </div>
      </div>
    `;
  }


  private renderIrradiatorPopup(irradiator: GammaIrradiator): string {
    return `
      <div class="popup-header irradiator">
        <span class="popup-title">☢ ${escapeHtml(irradiator.city.toUpperCase())}</span>
        <span class="popup-badge elevated">${t('popups.gamma')}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${t('popups.irradiator.subtitle')}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.country')}</span>
            <span class="stat-value">${escapeHtml(irradiator.country)}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.city')}</span>
            <span class="stat-value">${escapeHtml(irradiator.city)}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.coordinates')}</span>
            <span class="stat-value">${irradiator.lat.toFixed(2)}°, ${irradiator.lon.toFixed(2)}°</span>
          </div>
        </div>
        <p class="popup-description">${t('popups.irradiator.description')}</p>
      </div>
    `;
  }


  private renderPipelinePopup(pipeline: Pipeline): string {
    const typeLabels: Record<string, string> = {
      'oil': t('popups.pipeline.types.oil'),
      'gas': t('popups.pipeline.types.gas'),
      'products': t('popups.pipeline.types.products'),
    };
    const typeColors: Record<string, string> = {
      'oil': 'high',
      'gas': 'elevated',
      'products': 'low',
    };
    const statusLabels: Record<string, string> = {
      'operating': t('popups.pipeline.status.operating'),
      'construction': t('popups.pipeline.status.construction'),
    };
    const typeIcon = pipeline.type === 'oil' ? '🛢' : pipeline.type === 'gas' ? '🔥' : '⛽';

    return `
      <div class="popup-header pipeline ${pipeline.type}">
        <span class="popup-title">${typeIcon} ${escapeHtml(pipeline.name.toUpperCase())}</span>
        <span class="popup-badge ${typeColors[pipeline.type] || 'low'}">${escapeHtml(pipeline.type.toUpperCase())}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${typeLabels[pipeline.type] || t('popups.pipeline.title')}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.status')}</span>
            <span class="stat-value">${escapeHtml(statusLabels[pipeline.status] || pipeline.status.toUpperCase())}</span>
          </div>
          ${pipeline.capacity ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.capacity')}</span>
            <span class="stat-value">${escapeHtml(pipeline.capacity)}</span>
          </div>
          ` : ''}
          ${pipeline.length ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.length')}</span>
            <span class="stat-value">${escapeHtml(pipeline.length)}</span>
          </div>
          ` : ''}
          ${pipeline.operator ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.operator')}</span>
            <span class="stat-value">${escapeHtml(pipeline.operator)}</span>
          </div>
          ` : ''}
        </div>
        ${pipeline.countries && pipeline.countries.length > 0 ? `
          <div class="popup-section">
            <span class="section-label">${t('popups.countries')}</span>
            <div class="popup-tags">
              ${pipeline.countries.map(c => `<span class="popup-tag">${escapeHtml(c)}</span>`).join('')}
            </div>
          </div>
        ` : ''}
        <p class="popup-description">${t('popups.pipeline.description', { type: pipeline.type, status: pipeline.status === 'operating' ? t('popups.pipelineStatusDesc.operating') : t('popups.pipelineStatusDesc.construction') })}</p>
      </div>
    `;
  }


  private renderCablePopup(cable: UnderseaCable): string {
    const advisory = this.getLatestCableAdvisory(cable.id);
    const repairShip = this.getPriorityRepairShip(cable.id);
    const healthRecord = getCableHealthRecord(cable.id);

    // Health data takes priority over advisory for status display
    let statusLabel: string;
    let statusBadge: string;
    if (healthRecord?.status === 'fault') {
      statusLabel = t('popups.cable.fault');
      statusBadge = 'high';
    } else if (healthRecord?.status === 'degraded') {
      statusLabel = t('popups.cable.degraded');
      statusBadge = 'elevated';
    } else if (advisory) {
      statusLabel = advisory.severity === 'fault' ? t('popups.cable.fault') : t('popups.cable.degraded');
      statusBadge = advisory.severity === 'fault' ? 'high' : 'elevated';
    } else {
      statusLabel = t('popups.cable.active');
      statusBadge = 'low';
    }
    const repairEta = repairShip?.eta || advisory?.repairEta;
    const cableName = escapeHtml(cable.name.toUpperCase());
    const safeStatusLabel = escapeHtml(statusLabel);
    const safeRepairEta = repairEta ? escapeHtml(repairEta) : '';
    const advisoryTitle = advisory ? escapeHtml(advisory.title) : '';
    const advisoryImpact = advisory ? escapeHtml(advisory.impact) : '';
    const advisoryDescription = advisory ? escapeHtml(advisory.description) : '';
    const repairShipName = repairShip ? escapeHtml(repairShip.name) : '';
    const repairShipNote = repairShip ? escapeHtml(repairShip.note || t('popups.repairShip.note')) : '';

    return `
      <div class="popup-header cable">
        <span class="popup-title">🌐 ${cableName}</span>
        <span class="popup-badge ${statusBadge}">${cable.major ? t('popups.cable.major') : t('popups.cable.cable')}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${t('popups.cable.subtitle')}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.type')}</span>
            <span class="stat-value">${t('popups.cable.type')}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.waypoints')}</span>
            <span class="stat-value">${cable.points.length}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.status')}</span>
            <span class="stat-value">${safeStatusLabel}</span>
          </div>
          ${repairEta ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.repairEta')}</span>
            <span class="stat-value">${safeRepairEta}</span>
          </div>
          ` : ''}
        </div>
        ${advisory ? `
          <div class="popup-section">
            <span class="section-label">${t('popups.cable.advisory')}</span>
            <div class="popup-tags">
              <span class="popup-tag">${advisoryTitle}</span>
              <span class="popup-tag">${advisoryImpact}</span>
            </div>
            <p class="popup-description">${advisoryDescription}</p>
          </div>
        ` : ''}
        ${repairShip ? `
          <div class="popup-section">
            <span class="section-label">${t('popups.cable.repairDeployment')}</span>
            <div class="popup-tags">
              <span class="popup-tag">${repairShipName}</span>
              <span class="popup-tag">${repairShip.status === 'on-station' ? t('popups.cable.repairStatus.onStation') : t('popups.cable.repairStatus.enRoute')}</span>
            </div>
            <p class="popup-description">${repairShipNote}</p>
          </div>
        ` : ''}
        ${healthRecord?.evidence?.length ? `
          <div class="popup-section">
            <span class="section-label">${t('popups.cable.health.evidence')}</span>
            <ul class="evidence-list">
              ${healthRecord.evidence.map((e) => `<li class="evidence-item"><strong>${escapeHtml(e.source)}</strong>: ${escapeHtml(e.summary)}</li>`).join('')}
            </ul>
          </div>
        ` : ''}
        <p class="popup-description">${t('popups.cable.description')}</p>
      </div>
    `;
  }

  private renderCableAdvisoryPopup(advisory: CableAdvisory): string {
    const cable = UNDERSEA_CABLES.find((item) => item.id === advisory.cableId);
    const timeAgo = this.getTimeAgo(advisory.reported);
    const statusLabel = advisory.severity === 'fault' ? t('popups.cable.fault') : t('popups.cable.degraded');
    const cableName = escapeHtml(cable?.name.toUpperCase() || advisory.cableId.toUpperCase());
    const advisoryTitle = escapeHtml(advisory.title);
    const advisoryImpact = escapeHtml(advisory.impact);
    const advisoryEta = advisory.repairEta ? escapeHtml(advisory.repairEta) : '';
    const advisoryDescription = escapeHtml(advisory.description);

    return `
      <div class="popup-header cable">
        <span class="popup-title">🚨 ${cableName}</span>
        <span class="popup-badge ${advisory.severity === 'fault' ? 'high' : 'elevated'}">${statusLabel}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${advisoryTitle}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.cableAdvisory.reported')}</span>
            <span class="stat-value">${timeAgo}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.cableAdvisory.impact')}</span>
            <span class="stat-value">${advisoryImpact}</span>
          </div>
          ${advisory.repairEta ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.cableAdvisory.eta')}</span>
            <span class="stat-value">${advisoryEta}</span>
          </div>
          ` : ''}
        </div>
        <p class="popup-description">${advisoryDescription}</p>
      </div>
    `;
  }

  private renderRepairShipPopup(ship: RepairShip): string {
    const cable = UNDERSEA_CABLES.find((item) => item.id === ship.cableId);
    const shipName = escapeHtml(ship.name.toUpperCase());
    const cableLabel = escapeHtml(cable?.name || ship.cableId);
    const shipEta = escapeHtml(ship.eta);
    const shipOperator = ship.operator ? escapeHtml(ship.operator) : '';
    const shipNote = escapeHtml(ship.note || t('popups.repairShip.description'));

    return `
      <div class="popup-header cable">
        <span class="popup-title">🚢 ${shipName}</span>
        <span class="popup-badge elevated">${t('popups.repairShip.badge')}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${cableLabel}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.status')}</span>
            <span class="stat-value">${ship.status === 'on-station' ? t('popups.repairShip.status.onStation') : t('popups.repairShip.status.enRoute')}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.cableAdvisory.eta')}</span>
            <span class="stat-value">${shipEta}</span>
          </div>
          ${ship.operator ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.operator')}</span>
            <span class="stat-value">${shipOperator}</span>
          </div>
          ` : ''}
        </div>
        <p class="popup-description">${shipNote}</p>
      </div>
    `;
  }

  private getLatestCableAdvisory(cableId: string): CableAdvisory | undefined {
    const advisories = this.cableAdvisories.filter((item) => item.cableId === cableId);
    return advisories.reduce<CableAdvisory | undefined>((latest, advisory) => {
      if (!latest) return advisory;
      return advisory.reported.getTime() > latest.reported.getTime() ? advisory : latest;
    }, undefined);
  }

  private getPriorityRepairShip(cableId: string): RepairShip | undefined {
    const ships = this.repairShips.filter((item) => item.cableId === cableId);
    if (ships.length === 0) return undefined;
    const onStation = ships.find((ship) => ship.status === 'on-station');
    return onStation || ships[0];
  }

  private renderOutagePopup(outage: InternetOutage): string {
    const severityColors: Record<string, string> = {
      'total': 'high',
      'major': 'elevated',
      'partial': 'low',
    };
    const severityLabels: Record<string, string> = {
      'total': t('popups.outage.levels.total'),
      'major': t('popups.outage.levels.major'),
      'partial': t('popups.outage.levels.partial'),
    };
    const timeAgo = this.getTimeAgo(outage.pubDate);
    const severityClass = escapeHtml(outage.severity);

    return `
      <div class="popup-header outage ${severityClass}">
        <span class="popup-title">📡 ${escapeHtml(outage.country.toUpperCase())}</span>
        <span class="popup-badge ${severityColors[outage.severity] || 'low'}">${severityLabels[outage.severity] || t('popups.outage.levels.disruption')}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${escapeHtml(outage.title)}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.severity')}</span>
            <span class="stat-value">${escapeHtml(outage.severity.toUpperCase())}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.outage.reported')}</span>
            <span class="stat-value">${timeAgo}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.coordinates')}</span>
            <span class="stat-value">${outage.lat.toFixed(2)}°, ${outage.lon.toFixed(2)}°</span>
          </div>
        </div>
        ${outage.categories && outage.categories.length > 0 ? `
          <div class="popup-section">
            <span class="section-label">${t('popups.outage.categories')}</span>
            <div class="popup-tags">
              ${outage.categories.slice(0, 5).map(c => `<span class="popup-tag">${escapeHtml(c)}</span>`).join('')}
            </div>
          </div>
        ` : ''}
        <p class="popup-description">${escapeHtml(outage.description.slice(0, 250))}${outage.description.length > 250 ? '...' : ''}</p>
        <a href="${sanitizeUrl(outage.link)}" target="_blank" class="popup-link">${t('popups.outage.readReport')} →</a>
      </div>
    `;
  }

  private renderDatacenterPopup(dc: AIDataCenter): string {
    const statusColors: Record<string, string> = {
      'existing': 'normal',
      'planned': 'elevated',
      'decommissioned': 'low',
    };
    const statusLabels: Record<string, string> = {
      'existing': t('popups.datacenter.status.existing'),
      'planned': t('popups.datacenter.status.planned'),
      'decommissioned': t('popups.datacenter.status.decommissioned'),
    };

    const formatNumber = (n: number) => {
      if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
      if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
      return n.toString();
    };

    return `
      <div class="popup-header datacenter ${dc.status}">
        <span class="popup-title">🖥️ ${escapeHtml(dc.name)}</span>
        <span class="popup-badge ${statusColors[dc.status] || 'normal'}">${statusLabels[dc.status] || t('popups.datacenter.status.unknown')}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${escapeHtml(dc.owner)} • ${escapeHtml(dc.country)}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.datacenter.gpuChipCount')}</span>
            <span class="stat-value">${formatNumber(dc.chipCount)}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.datacenter.chipType')}</span>
            <span class="stat-value">${escapeHtml(dc.chipType || t('popups.unknown'))}</span>
          </div>
          ${dc.powerMW ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.datacenter.power')}</span>
            <span class="stat-value">${dc.powerMW.toFixed(0)} MW</span>
          </div>
          ` : ''}
          ${dc.sector ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.datacenter.sector')}</span>
            <span class="stat-value">${escapeHtml(dc.sector)}</span>
          </div>
          ` : ''}
        </div>
        ${dc.note ? `<p class="popup-description">${escapeHtml(dc.note)}</p>` : ''}
        <div class="popup-attribution">${t('popups.datacenter.attribution')}</div>
      </div>
    `;
  }

  private renderDatacenterClusterPopup(data: DatacenterClusterData): string {
    const totalCount = data.count ?? data.items.length;
    const totalChips = data.totalChips ?? data.items.reduce((sum, dc) => sum + dc.chipCount, 0);
    const totalPower = data.totalPowerMW ?? data.items.reduce((sum, dc) => sum + (dc.powerMW || 0), 0);
    const existingCount = data.existingCount ?? data.items.filter(dc => dc.status === 'existing').length;
    const plannedCount = data.plannedCount ?? data.items.filter(dc => dc.status === 'planned').length;

    const formatNumber = (n: number) => {
      if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
      if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
      return n.toString();
    };

    const dcListHtml = data.items.slice(0, 8).map(dc => `
      <div class="cluster-item">
        <span class="cluster-item-icon">${dc.status === 'planned' ? '🔨' : '🖥️'}</span>
        <div class="cluster-item-info">
          <span class="cluster-item-name">${escapeHtml(dc.name.slice(0, 40))}${dc.name.length > 40 ? '...' : ''}</span>
          <span class="cluster-item-detail">${escapeHtml(dc.owner)} • ${formatNumber(dc.chipCount)} ${t('popups.datacenter.chips')}</span>
        </div>
      </div>
    `).join('');

    return `
      <div class="popup-header datacenter cluster">
        <span class="popup-title">🖥️ ${t('popups.datacenter.cluster.title', { count: String(totalCount) })}</span>
        <span class="popup-badge elevated">${escapeHtml(data.region)}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${escapeHtml(data.country)}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.datacenter.cluster.totalChips')}</span>
            <span class="stat-value">${formatNumber(totalChips)}</span>
          </div>
          ${totalPower > 0 ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.datacenter.cluster.totalPower')}</span>
            <span class="stat-value">${totalPower.toFixed(0)} MW</span>
          </div>
          ` : ''}
          <div class="popup-stat">
            <span class="stat-label">${t('popups.datacenter.cluster.operational')}</span>
            <span class="stat-value">${existingCount}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.datacenter.cluster.planned')}</span>
            <span class="stat-value">${plannedCount}</span>
          </div>
        </div>
        <div class="cluster-list">
          ${dcListHtml}
        </div>
        ${totalCount > 8 ? `<p class="popup-more">${t('popups.datacenter.cluster.moreDataCenters', { count: String(Math.max(0, totalCount - 8)) })}</p>` : ''}
        ${data.sampled ? `<p class="popup-more">${t('popups.datacenter.cluster.sampledSites', { count: String(data.items.length) })}</p>` : ''}
        <div class="popup-attribution">${t('popups.datacenter.attribution')}</div>
      </div>
    `;
  }

  private renderStartupHubPopup(hub: StartupHub): string {
    const tierLabels: Record<string, string> = {
      'mega': t('popups.startupHub.tiers.mega'),
      'major': t('popups.startupHub.tiers.major'),
      'emerging': t('popups.startupHub.tiers.emerging'),
    };
    const tierIcons: Record<string, string> = { 'mega': '🦄', 'major': '🚀', 'emerging': '💡' };
    return `
      <div class="popup-header startup-hub ${hub.tier}">
        <span class="popup-title">${tierIcons[hub.tier] || '🚀'} ${escapeHtml(hub.name)}</span>
        <span class="popup-badge ${hub.tier}">${tierLabels[hub.tier] || t('popups.startupHub.tiers.hub')}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${escapeHtml(hub.city)}, ${escapeHtml(hub.country)}</div>
        ${hub.unicorns ? `
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.startupHub.unicorns')}</span>
            <span class="stat-value">${hub.unicorns}+</span>
          </div>
        </div>
        ` : ''}
        ${hub.description ? `<p class="popup-description">${escapeHtml(hub.description)}</p>` : ''}
      </div>
    `;
  }

  private renderCloudRegionPopup(region: CloudRegion): string {
    const providerNames: Record<string, string> = { 'aws': 'Amazon Web Services', 'gcp': 'Google Cloud Platform', 'azure': 'Microsoft Azure', 'cloudflare': 'Cloudflare' };
    const providerIcons: Record<string, string> = { 'aws': '🟠', 'gcp': '🔵', 'azure': '🟣', 'cloudflare': '🟡' };
    return `
      <div class="popup-header cloud-region ${region.provider}">
        <span class="popup-title">${providerIcons[region.provider] || '☁️'} ${escapeHtml(region.name)}</span>
        <span class="popup-badge ${region.provider}">${escapeHtml(region.provider.toUpperCase())}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${escapeHtml(region.city)}, ${escapeHtml(region.country)}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.cloudRegion.provider')}</span>
            <span class="stat-value">${escapeHtml(providerNames[region.provider] || region.provider)}</span>
          </div>
          ${region.zones ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.cloudRegion.availabilityZones')}</span>
            <span class="stat-value">${region.zones}</span>
          </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  private renderTechHQPopup(hq: TechHQ): string {
    const typeLabels: Record<string, string> = {
      'faang': t('popups.techHQ.types.faang'),
      'unicorn': t('popups.techHQ.types.unicorn'),
      'public': t('popups.techHQ.types.public'),
    };
    const typeIcons: Record<string, string> = { 'faang': '🏛️', 'unicorn': '🦄', 'public': '🏢' };
    return `
      <div class="popup-header tech-hq ${hq.type}">
        <span class="popup-title">${typeIcons[hq.type] || '🏢'} ${escapeHtml(hq.company)}</span>
        <span class="popup-badge ${hq.type}">${typeLabels[hq.type] || t('popups.techHQ.types.tech')}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${escapeHtml(hq.city)}, ${escapeHtml(hq.country)}</div>
        <div class="popup-stats">
          ${hq.marketCap ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.techHQ.marketCap')}</span>
            <span class="stat-value">${escapeHtml(hq.marketCap)}</span>
          </div>
          ` : ''}
          ${hq.employees ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.techHQ.employees')}</span>
            <span class="stat-value">${hq.employees.toLocaleString()}</span>
          </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  private renderAcceleratorPopup(acc: Accelerator): string {
    const typeLabels: Record<string, string> = {
      'accelerator': t('popups.accelerator.types.accelerator'),
      'incubator': t('popups.accelerator.types.incubator'),
      'studio': t('popups.accelerator.types.studio'),
    };
    const typeIcons: Record<string, string> = { 'accelerator': '🎯', 'incubator': '🔬', 'studio': '🎨' };
    return `
      <div class="popup-header accelerator ${acc.type}">
        <span class="popup-title">${typeIcons[acc.type] || '🎯'} ${escapeHtml(acc.name)}</span>
        <span class="popup-badge ${acc.type}">${typeLabels[acc.type] || t('popups.accelerator.types.accelerator')}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${escapeHtml(acc.city)}, ${escapeHtml(acc.country)}</div>
        <div class="popup-stats">
          ${acc.founded ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.accelerator.founded')}</span>
            <span class="stat-value">${acc.founded}</span>
          </div>
          ` : ''}
        </div>
        ${acc.notable && acc.notable.length > 0 ? `
        <div class="popup-notable">
          <span class="notable-label">${t('popups.accelerator.notableAlumni')}</span>
          <span class="notable-list">${acc.notable.map(n => escapeHtml(n)).join(', ')}</span>
        </div>
        ` : ''}
      </div>
    `;
  }

  private renderTechEventPopup(event: TechEventPopupData): string {
    const startDate = new Date(event.startDate);
    const endDate = new Date(event.endDate);
    const dateStr = startDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const endDateStr = endDate > startDate && endDate.toDateString() !== startDate.toDateString()
      ? ` - ${endDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
      : '';

    const urgencyClass = event.daysUntil <= 7 ? 'urgent' : event.daysUntil <= 30 ? 'soon' : '';
    const daysLabel = event.daysUntil === 0
      ? t('popups.techEvent.days.today')
      : event.daysUntil === 1
      ? t('popups.techEvent.days.tomorrow')
      : t('popups.techEvent.days.inDays', { count: String(event.daysUntil) });

    return `
      <div class="popup-header tech-event ${urgencyClass}">
        <span class="popup-title">📅 ${escapeHtml(event.title)}</span>
        <span class="popup-badge ${urgencyClass}">${daysLabel}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">📍 ${escapeHtml(event.location)}, ${escapeHtml(event.country)}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.techEvent.date')}</span>
            <span class="stat-value">${dateStr}${endDateStr}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.location')}</span>
            <span class="stat-value">${escapeHtml(event.location)}</span>
          </div>
        </div>
        ${event.url ? `
        <a href="${sanitizeUrl(event.url)}" target="_blank" rel="noopener noreferrer" class="popup-link">
          ${t('popups.techEvent.moreInformation')} →
        </a>
        ` : ''}
      </div>
    `;
  }

  private renderTechHQClusterPopup(data: TechHQClusterData): string {
    const totalCount = data.count ?? data.items.length;
    const unicornCount = data.unicornCount ?? data.items.filter(h => h.type === 'unicorn').length;
    const faangCount = data.faangCount ?? data.items.filter(h => h.type === 'faang').length;
    const publicCount = data.publicCount ?? data.items.filter(h => h.type === 'public').length;

    const sortedItems = [...data.items].sort((a, b) => {
      const typeOrder = { faang: 0, unicorn: 1, public: 2 };
      return (typeOrder[a.type] ?? 3) - (typeOrder[b.type] ?? 3);
    });

    const listItems = sortedItems.map(hq => {
      const icon = hq.type === 'faang' ? '🏛️' : hq.type === 'unicorn' ? '🦄' : '🏢';
      const marketCap = hq.marketCap ? ` (${escapeHtml(hq.marketCap)})` : '';
      return `<li class="cluster-item ${hq.type}">${icon} ${escapeHtml(hq.company)}${marketCap}</li>`;
    }).join('');

    return `
      <div class="popup-header tech-hq cluster">
        <span class="popup-title">🏙️ ${escapeHtml(data.city)}</span>
        <span class="popup-badge">${t('popups.techHQCluster.companiesCount', { count: String(totalCount) })}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body cluster-popup">
        <div class="popup-subtitle">📍 ${escapeHtml(data.city)}, ${escapeHtml(data.country)}</div>
        <div class="cluster-summary">
          ${faangCount ? `<span class="summary-item faang">🏛️ ${t('popups.techHQCluster.bigTechCount', { count: String(faangCount) })}</span>` : ''}
          ${unicornCount ? `<span class="summary-item unicorn">🦄 ${t('popups.techHQCluster.unicornsCount', { count: String(unicornCount) })}</span>` : ''}
          ${publicCount ? `<span class="summary-item public">🏢 ${t('popups.techHQCluster.publicCount', { count: String(publicCount) })}</span>` : ''}
        </div>
        <ul class="cluster-list">${listItems}</ul>
        ${data.sampled ? `<p class="popup-more">${t('popups.techHQCluster.sampled', { count: String(data.items.length) })}</p>` : ''}
      </div>
    `;
  }

  private renderTechEventClusterPopup(data: TechEventClusterData): string {
    const totalCount = data.count ?? data.items.length;
    const upcomingSoon = data.soonCount ?? data.items.filter(e => e.daysUntil <= 14).length;
    const sortedItems = [...data.items].sort((a, b) => a.daysUntil - b.daysUntil);

    const listItems = sortedItems.map(event => {
      const startDate = new Date(event.startDate);
      const dateStr = startDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const urgencyClass = event.daysUntil <= 7 ? 'urgent' : event.daysUntil <= 30 ? 'soon' : '';
      return `<li class="cluster-item ${urgencyClass}">📅 ${dateStr}: ${escapeHtml(event.title)}</li>`;
    }).join('');

    return `
      <div class="popup-header tech-event cluster">
        <span class="popup-title">📅 ${escapeHtml(data.location)}</span>
        <span class="popup-badge">${t('popups.techEventCluster.eventsCount', { count: String(totalCount) })}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body cluster-popup">
        <div class="popup-subtitle">📍 ${escapeHtml(data.location)}, ${escapeHtml(data.country)}</div>
        ${upcomingSoon ? `<div class="cluster-summary"><span class="summary-item soon">⚡ ${t('popups.techEventCluster.upcomingWithin2Weeks', { count: String(upcomingSoon) })}</span></div>` : ''}
        <ul class="cluster-list">${listItems}</ul>
        ${data.sampled ? `<p class="popup-more">${t('popups.techEventCluster.sampled', { count: String(data.items.length) })}</p>` : ''}
      </div>
    `;
  }

  private getMarketStatus(hours: { open: string; close: string; timezone: string }): 'open' | 'closed' | 'unknown' {
    try {
      const now = new Date();
      const formatter = new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: hours.timezone,
      });
      const currentTime = formatter.format(now);
      const [openH = 0, openM = 0] = hours.open.split(':').map(Number);
      const [closeH = 0, closeM = 0] = hours.close.split(':').map(Number);
      const [currH = 0, currM = 0] = currentTime.split(':').map(Number);

      const openMins = openH * 60 + openM;
      const closeMins = closeH * 60 + closeM;
      const currMins = currH * 60 + currM;

      if (currMins >= openMins && currMins < closeMins) {
        return 'open';
      }
      return 'closed';
    } catch {
      return 'unknown';
    }
  }

  private renderMilitaryFlightPopup(flight: MilitaryFlight): string {
    const operatorLabels: Record<string, string> = {
      usaf: 'US Air Force',
      usn: 'US Navy',
      usmc: 'US Marines',
      usa: 'US Army',
      raf: 'Royal Air Force',
      rn: 'Royal Navy',
      faf: 'French Air Force',
      gaf: 'German Air Force',
      plaaf: 'PLA Air Force',
      plan: 'PLA Navy',
      vks: 'Russian Aerospace',
      iaf: 'Israeli Air Force',
      nato: 'NATO',
      other: t('popups.unknown'),
    };
    const typeLabels: Record<string, string> = {
      fighter: t('popups.militaryFlight.types.fighter'),
      bomber: t('popups.militaryFlight.types.bomber'),
      transport: t('popups.militaryFlight.types.transport'),
      tanker: t('popups.militaryFlight.types.tanker'),
      awacs: t('popups.militaryFlight.types.awacs'),
      reconnaissance: t('popups.militaryFlight.types.reconnaissance'),
      helicopter: t('popups.militaryFlight.types.helicopter'),
      drone: t('popups.militaryFlight.types.drone'),
      patrol: t('popups.militaryFlight.types.patrol'),
      special_ops: t('popups.militaryFlight.types.specialOps'),
      vip: t('popups.militaryFlight.types.vip'),
      unknown: t('popups.unknown'),
    };
    const confidenceColors: Record<string, string> = {
      high: 'elevated',
      medium: 'low',
      low: 'low',
    };
    const callsign = escapeHtml(flight.callsign || t('popups.unknown'));
    const aircraftTypeBadge = escapeHtml(flight.aircraftType.toUpperCase());
    const operatorLabel = escapeHtml(operatorLabels[flight.operator] || flight.operatorCountry || t('popups.unknown'));
    const hexCode = escapeHtml(flight.hexCode || '');
    const aircraftType = escapeHtml(typeLabels[flight.aircraftType] || flight.aircraftType);
    const squawk = flight.squawk ? escapeHtml(flight.squawk) : '';
    const note = flight.note ? escapeHtml(flight.note) : '';

    return `
      <div class="popup-header military-flight ${flight.operator}">
        <span class="popup-title">${callsign}</span>
        <span class="popup-badge ${confidenceColors[flight.confidence] || 'low'}">${aircraftTypeBadge}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${operatorLabel}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.militaryFlight.altitude')}</span>
            <span class="stat-value">${flight.altitude > 0 ? `FL${Math.round(flight.altitude / 100)}` : t('popups.militaryFlight.ground')}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.militaryFlight.speed')}</span>
            <span class="stat-value">${flight.speed} kts</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.militaryFlight.heading')}</span>
            <span class="stat-value">${Math.round(flight.heading)}°</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.militaryFlight.hexCode')}</span>
            <span class="stat-value">${hexCode}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.type')}</span>
            <span class="stat-value">${aircraftType}</span>
          </div>
          ${flight.squawk ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.militaryFlight.squawk')}</span>
            <span class="stat-value">${squawk}</span>
          </div>
          ` : ''}
        </div>
        ${flight.note ? `<p class="popup-description">${note}</p>` : ''}
        <div class="popup-attribution">${t('popups.militaryFlight.attribution')}</div>
      </div>
    `;
  }

  private renderMilitaryVesselPopup(vessel: MilitaryVessel): string {
    const operatorLabels: Record<string, string> = {
      usn: 'US Navy',
      uscg: 'US Coast Guard',
      rn: 'Royal Navy',
      fn: 'French Navy',
      plan: 'PLA Navy',
      ruf: 'Russian Navy',
      jmsdf: 'Japan Maritime SDF',
      rokn: 'ROK Navy',
      other: t('popups.unknown'),
    };
    const typeLabels: Record<string, string> = {
      carrier: 'Aircraft Carrier',
      destroyer: 'Destroyer',
      frigate: 'Frigate',
      submarine: 'Submarine',
      amphibious: 'Amphibious',
      patrol: 'Patrol',
      auxiliary: 'Auxiliary',
      research: 'Research',
      icebreaker: 'Icebreaker',
      special: 'Special',
      unknown: t('popups.unknown'),
    };

    const darkWarning = vessel.isDark
      ? `<span class="popup-badge high">${t('popups.militaryVessel.aisDark')}</span>`
      : '';

    // USNI deployment status badge
    const deploymentBadge = vessel.usniDeploymentStatus && vessel.usniDeploymentStatus !== 'unknown'
      ? `<span class="popup-badge ${vessel.usniDeploymentStatus === 'deployed' ? 'high' : vessel.usniDeploymentStatus === 'underway' ? 'elevated' : 'low'}">${vessel.usniDeploymentStatus.toUpperCase().replace('-', ' ')}</span>`
      : '';

    // Show AIS ship type when military type is unknown
    const displayType = vessel.vesselType === 'unknown' && vessel.aisShipType
      ? vessel.aisShipType
      : (typeLabels[vessel.vesselType] || vessel.vesselType);
    const badgeType = vessel.vesselType === 'unknown' && vessel.aisShipType
      ? vessel.aisShipType.toUpperCase()
      : vessel.vesselType.toUpperCase();
    const vesselName = escapeHtml(vessel.name || `${t('popups.militaryVessel.vessel')} ${vessel.mmsi}`);
    const vesselOperator = escapeHtml(operatorLabels[vessel.operator] || vessel.operatorCountry || t('popups.unknown'));
    const vesselTypeLabel = escapeHtml(displayType);
    const vesselBadgeType = escapeHtml(badgeType);
    const vesselMmsi = escapeHtml(vessel.mmsi || '—');
    const vesselHull = vessel.hullNumber ? escapeHtml(vessel.hullNumber) : '';
    const vesselNote = vessel.note ? escapeHtml(vessel.note) : '';

    return `
      <div class="popup-header military-vessel ${vessel.operator}">
        <span class="popup-title">${vesselName}</span>
        ${darkWarning}
        ${deploymentBadge}
        <span class="popup-badge elevated">${vesselBadgeType}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${vesselOperator}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.type')}</span>
            <span class="stat-value">${vesselTypeLabel}</span>
          </div>
          ${vessel.usniRegion ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.militaryVessel.region')}</span>
            <span class="stat-value">${escapeHtml(vessel.usniRegion)}</span>
          </div>
          ` : ''}
          ${vessel.usniStrikeGroup ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.militaryVessel.strikeGroup')}</span>
            <span class="stat-value">${escapeHtml(vessel.usniStrikeGroup)}</span>
          </div>
          ` : ''}
          <div class="popup-stat">
            <span class="stat-label">${t('popups.militaryVessel.speed')}</span>
            <span class="stat-value">${vessel.speed} kts</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.militaryVessel.heading')}</span>
            <span class="stat-value">${Math.round(vessel.heading)}°</span>
          </div>
          ${vessel.mmsi ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.militaryVessel.mmsi')}</span>
            <span class="stat-value">${vesselMmsi}</span>
          </div>
          ` : ''}
          ${vessel.hullNumber ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.militaryVessel.hull')}</span>
            <span class="stat-value">${vesselHull}</span>
          </div>
          ` : ''}
        </div>
        ${vessel.usniActivityDescription ? `<p class="popup-description"><strong>${t('popups.militaryVessel.usniIntel')}:</strong> ${escapeHtml(vessel.usniActivityDescription)}</p>` : ''}
        ${vessel.note ? `<p class="popup-description">${vesselNote}</p>` : ''}
        ${vessel.isDark ? `<p class="popup-description alert">${t('popups.militaryVessel.darkDescription')}</p>` : ''}
        ${vessel.usniSource ? `<p class="popup-description" style="opacity:0.7;font-size:0.85em">${t('popups.militaryVessel.approximatePosition')}</p>` : ''}
        ${vessel.usniArticleUrl ? `<div class="popup-attribution"><a href="${escapeHtml(vessel.usniArticleUrl)}" target="_blank" rel="noopener">${t('popups.militaryVessel.usniSource')}${vessel.usniArticleDate ? ` (${new Date(vessel.usniArticleDate).toLocaleDateString()})` : ''}</a></div>` : ''}
      </div>
    `;
  }

  private renderMilitaryFlightClusterPopup(cluster: MilitaryFlightCluster): string {
    const activityLabels: Record<string, string> = {
      exercise: t('popups.militaryCluster.flightActivity.exercise'),
      patrol: t('popups.militaryCluster.flightActivity.patrol'),
      transport: t('popups.militaryCluster.flightActivity.transport'),
      unknown: t('popups.militaryCluster.flightActivity.unknown'),
    };
    const activityColors: Record<string, string> = {
      exercise: 'high',
      patrol: 'elevated',
      transport: 'low',
      unknown: 'low',
    };

    const activityType = cluster.activityType || 'unknown';
    const clusterName = escapeHtml(cluster.name);
    const activityTypeLabel = escapeHtml(activityType.toUpperCase());
    const dominantOperator = cluster.dominantOperator ? escapeHtml(cluster.dominantOperator.toUpperCase()) : '';
    const flightSummary = cluster.flights
      .slice(0, 5)
      .map(f => `<div class="cluster-flight-item">${escapeHtml(f.callsign)} - ${escapeHtml(f.aircraftType)}</div>`)
      .join('');
    const moreFlights = cluster.flightCount > 5
      ? `<div class="cluster-more">${t('popups.militaryCluster.moreAircraft', { count: String(cluster.flightCount - 5) })}</div>`
      : '';

    return `
      <div class="popup-header military-cluster">
        <span class="popup-title">${clusterName}</span>
        <span class="popup-badge ${activityColors[activityType] || 'low'}">${t('popups.militaryCluster.aircraftCount', { count: String(cluster.flightCount) })}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${activityLabels[activityType] || t('popups.militaryCluster.flightActivity.unknown')}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.militaryCluster.aircraft')}</span>
            <span class="stat-value">${cluster.flightCount}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.militaryCluster.activity')}</span>
            <span class="stat-value">${activityTypeLabel}</span>
          </div>
          ${cluster.dominantOperator ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.militaryCluster.primary')}</span>
            <span class="stat-value">${dominantOperator}</span>
          </div>
          ` : ''}
        </div>
        <div class="popup-section">
          <span class="section-label">${t('popups.militaryCluster.trackedAircraft')}</span>
          <div class="cluster-flights">
            ${flightSummary}
            ${moreFlights}
          </div>
        </div>
      </div>
    `;
  }

  private renderMilitaryVesselClusterPopup(cluster: MilitaryVesselCluster): string {
    const activityLabels: Record<string, string> = {
      exercise: t('popups.militaryCluster.vesselActivity.exercise'),
      deployment: t('popups.militaryCluster.vesselActivity.deployment'),
      patrol: t('popups.militaryCluster.vesselActivity.patrol'),
      transit: t('popups.militaryCluster.vesselActivity.transit'),
      unknown: t('popups.militaryCluster.vesselActivity.unknown'),
    };
    const activityColors: Record<string, string> = {
      exercise: 'high',
      deployment: 'high',
      patrol: 'elevated',
      transit: 'low',
      unknown: 'low',
    };

    const activityType = cluster.activityType || 'unknown';
    const clusterName = escapeHtml(cluster.name);
    const activityTypeLabel = escapeHtml(activityType.toUpperCase());
    const region = cluster.region ? escapeHtml(cluster.region) : '';
    const vesselSummary = cluster.vessels
      .slice(0, 5)
      .map(v => `<div class="cluster-vessel-item">${escapeHtml(v.name)} - ${escapeHtml(v.vesselType)}</div>`)
      .join('');
    const moreVessels = cluster.vesselCount > 5
      ? `<div class="cluster-more">${t('popups.militaryCluster.moreVessels', { count: String(cluster.vesselCount - 5) })}</div>`
      : '';

    return `
      <div class="popup-header military-cluster">
        <span class="popup-title">${clusterName}</span>
        <span class="popup-badge ${activityColors[activityType] || 'low'}">${t('popups.militaryCluster.vesselsCount', { count: String(cluster.vesselCount) })}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${activityLabels[activityType] || t('popups.militaryCluster.vesselActivity.unknown')}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.militaryCluster.vessels')}</span>
            <span class="stat-value">${cluster.vesselCount}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.militaryCluster.activity')}</span>
            <span class="stat-value">${activityTypeLabel}</span>
          </div>
          ${cluster.region ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.region')}</span>
            <span class="stat-value">${region}</span>
          </div>
          ` : ''}
        </div>
        <div class="popup-section">
          <span class="section-label">${t('popups.militaryCluster.trackedVessels')}</span>
          <div class="cluster-vessels">
            ${vesselSummary}
            ${moreVessels}
          </div>
        </div>
      </div>
    `;
  }

  private renderNaturalEventPopup(event: NaturalEvent): string {
    const categoryColors: Record<string, string> = {
      severeStorms: 'high',
      wildfires: 'high',
      volcanoes: 'high',
      earthquakes: 'elevated',
      floods: 'elevated',
      landslides: 'elevated',
      drought: 'medium',
      dustHaze: 'low',
      snow: 'low',
      tempExtremes: 'elevated',
      seaLakeIce: 'low',
      waterColor: 'low',
      manmade: 'elevated',
    };
    const icon = getNaturalEventIcon(event.category);
    const severityClass = categoryColors[event.category] || 'low';
    const timeAgo = this.getTimeAgo(event.date);

    return `
      <div class="popup-header nat-event ${event.category}">
        <span class="popup-icon">${icon}</span>
        <span class="popup-title">${escapeHtml(event.categoryTitle.toUpperCase())}</span>
        <span class="popup-badge ${severityClass}">${event.closed ? t('popups.naturalEvent.closed') : t('popups.naturalEvent.active')}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${escapeHtml(event.title)}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.naturalEvent.reported')}</span>
            <span class="stat-value">${timeAgo}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.coordinates')}</span>
            <span class="stat-value">${event.lat.toFixed(2)}°, ${event.lon.toFixed(2)}°</span>
          </div>
          ${event.magnitude ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.magnitude')}</span>
            <span class="stat-value">${event.magnitude}${event.magnitudeUnit ? ` ${escapeHtml(event.magnitudeUnit)}` : ''}</span>
          </div>
          ` : ''}
          ${event.sourceName ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.source')}</span>
            <span class="stat-value">${escapeHtml(event.sourceName)}</span>
          </div>
          ` : ''}
        </div>
        ${event.description ? `<p class="popup-description">${escapeHtml(event.description)}</p>` : ''}
        ${event.sourceUrl ? `<a href="${sanitizeUrl(event.sourceUrl)}" target="_blank" class="popup-link">${t('popups.naturalEvent.viewOnSource', { source: escapeHtml(event.sourceName || t('popups.source')) })} →</a>` : ''}
        <div class="popup-attribution">${t('popups.naturalEvent.attribution')}</div>
      </div>
    `;
  }

  private renderPortPopup(port: Port): string {
    const typeLabels: Record<string, string> = {
      container: t('popups.port.types.container'),
      oil: t('popups.port.types.oil'),
      lng: t('popups.port.types.lng'),
      naval: t('popups.port.types.naval'),
      mixed: t('popups.port.types.mixed'),
      bulk: t('popups.port.types.bulk'),
    };
    const typeColors: Record<string, string> = {
      container: 'elevated',
      oil: 'high',
      lng: 'high',
      naval: 'elevated',
      mixed: 'normal',
      bulk: 'low',
    };
    const typeIcons: Record<string, string> = {
      container: '🏭',
      oil: '🛢️',
      lng: '🔥',
      naval: '⚓',
      mixed: '🚢',
      bulk: '📦',
    };

    const rankSection = port.rank
      ? `<div class="popup-stat"><span class="stat-label">${t('popups.port.worldRank')}</span><span class="stat-value">#${port.rank}</span></div>`
      : '';

    return `
      <div class="popup-header port ${escapeHtml(port.type)}">
        <span class="popup-icon">${typeIcons[port.type] || '🚢'}</span>
        <span class="popup-title">${escapeHtml(port.name.toUpperCase())}</span>
        <span class="popup-badge ${typeColors[port.type] || 'normal'}">${typeLabels[port.type] || port.type.toUpperCase()}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${escapeHtml(port.country)}</div>
        <div class="popup-stats">
          ${rankSection}
          <div class="popup-stat">
            <span class="stat-label">${t('popups.type')}</span>
            <span class="stat-value">${typeLabels[port.type] || port.type.toUpperCase()}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.coordinates')}</span>
            <span class="stat-value">${port.lat.toFixed(2)}°, ${port.lon.toFixed(2)}°</span>
          </div>
        </div>
        <p class="popup-description">${escapeHtml(port.note)}</p>
      </div>
    `;
  }

  private renderSpaceportPopup(port: Spaceport): string {
    const statusColors: Record<string, string> = {
      'active': 'elevated',
      'construction': 'high',
      'inactive': 'low',
    };
    const statusLabels: Record<string, string> = {
      'active': t('popups.spaceport.status.active'),
      'construction': t('popups.spaceport.status.construction'),
      'inactive': t('popups.spaceport.status.inactive'),
    };

    return `
      <div class="popup-header spaceport ${port.status}">
        <span class="popup-icon">🚀</span>
        <span class="popup-title">${escapeHtml(port.name.toUpperCase())}</span>
        <span class="popup-badge ${statusColors[port.status] || 'normal'}">${statusLabels[port.status] || port.status.toUpperCase()}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${escapeHtml(port.operator)} • ${escapeHtml(port.country)}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.spaceport.launchActivity')}</span>
            <span class="stat-value">${escapeHtml(port.launches.toUpperCase())}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.coordinates')}</span>
            <span class="stat-value">${port.lat.toFixed(2)}°, ${port.lon.toFixed(2)}°</span>
          </div>
        </div>
        <p class="popup-description">${t('popups.spaceport.description')}</p>
      </div>
    `;
  }

  private renderMineralPopup(mine: CriticalMineralProject): string {
    const statusColors: Record<string, string> = {
      'producing': 'elevated',
      'development': 'high',
      'exploration': 'low',
    };
    const statusLabels: Record<string, string> = {
      'producing': t('popups.mineral.status.producing'),
      'development': t('popups.mineral.status.development'),
      'exploration': t('popups.mineral.status.exploration'),
    };

    // Icon based on mineral type
    const icon = mine.mineral === 'Lithium' ? '🔋' : mine.mineral === 'Rare Earths' ? '🧲' : '💎';

    return `
      <div class="popup-header mineral ${mine.status}">
        <span class="popup-icon">${icon}</span>
        <span class="popup-title">${escapeHtml(mine.name.toUpperCase())}</span>
        <span class="popup-badge ${statusColors[mine.status] || 'normal'}">${statusLabels[mine.status] || mine.status.toUpperCase()}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${t('popups.mineral.projectSubtitle', { mineral: escapeHtml(mine.mineral.toUpperCase()) })}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.operator')}</span>
            <span class="stat-value">${escapeHtml(mine.operator)}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.country')}</span>
            <span class="stat-value">${escapeHtml(mine.country)}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.coordinates')}</span>
            <span class="stat-value">${mine.lat.toFixed(2)}°, ${mine.lon.toFixed(2)}°</span>
          </div>
        </div>
        <p class="popup-description">${escapeHtml(mine.significance)}</p>
      </div>
    `;
  }

  private renderStockExchangePopup(exchange: StockExchangePopupData): string {
    const tierLabel = exchange.tier.toUpperCase();
    const tierClass = exchange.tier === 'mega' ? 'high' : exchange.tier === 'major' ? 'medium' : 'low';

    return `
      <div class="popup-header exchange">
        <span class="popup-title">${escapeHtml(exchange.shortName)}</span>
        <span class="popup-badge ${tierClass}">${tierLabel}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${escapeHtml(exchange.name)}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.location')}</span>
            <span class="stat-value">${escapeHtml(exchange.city)}, ${escapeHtml(exchange.country)}</span>
          </div>
          ${exchange.marketCap ? `<div class="popup-stat"><span class="stat-label">${t('popups.stockExchange.marketCap')}</span><span class="stat-value">$${exchange.marketCap}T</span></div>` : ''}
          ${exchange.tradingHours ? `<div class="popup-stat"><span class="stat-label">${t('popups.tradingHours')}</span><span class="stat-value">${escapeHtml(exchange.tradingHours)}</span></div>` : ''}
        </div>
        ${exchange.description ? `<p class="popup-description">${escapeHtml(exchange.description)}</p>` : ''}
      </div>
    `;
  }

  private renderFinancialCenterPopup(center: FinancialCenterPopupData): string {
    const typeLabel = center.type.toUpperCase();

    return `
      <div class="popup-header financial-center">
        <span class="popup-title">${escapeHtml(center.name)}</span>
        <span class="popup-badge">${typeLabel}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.location')}</span>
            <span class="stat-value">${escapeHtml(center.city)}, ${escapeHtml(center.country)}</span>
          </div>
          ${center.gfciRank ? `<div class="popup-stat"><span class="stat-label">${t('popups.financialCenter.gfciRank')}</span><span class="stat-value">#${center.gfciRank}</span></div>` : ''}
        </div>
        ${center.specialties && center.specialties.length > 0 ? `
          <div class="popup-section">
            <span class="section-label">${t('popups.financialCenter.specialties')}</span>
            <div class="popup-tags">
              ${center.specialties.map(s => `<span class="popup-tag">${escapeHtml(s)}</span>`).join('')}
            </div>
          </div>
        ` : ''}
        ${center.description ? `<p class="popup-description">${escapeHtml(center.description)}</p>` : ''}
      </div>
    `;
  }

  private renderCentralBankPopup(bank: CentralBankPopupData): string {
    const typeLabel = bank.type.toUpperCase();

    return `
      <div class="popup-header central-bank">
        <span class="popup-title">${escapeHtml(bank.shortName)}</span>
        <span class="popup-badge">${typeLabel}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${escapeHtml(bank.name)}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.location')}</span>
            <span class="stat-value">${escapeHtml(bank.city)}, ${escapeHtml(bank.country)}</span>
          </div>
          ${bank.currency ? `<div class="popup-stat"><span class="stat-label">${t('popups.centralBank.currency')}</span><span class="stat-value">${escapeHtml(bank.currency)}</span></div>` : ''}
        </div>
        ${bank.description ? `<p class="popup-description">${escapeHtml(bank.description)}</p>` : ''}
      </div>
    `;
  }

  private renderCommodityHubPopup(hub: CommodityHubPopupData): string {
    const typeLabel = hub.type.toUpperCase();

    return `
      <div class="popup-header commodity-hub">
        <span class="popup-title">${escapeHtml(hub.name)}</span>
        <span class="popup-badge">${typeLabel}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.location')}</span>
            <span class="stat-value">${escapeHtml(hub.city)}, ${escapeHtml(hub.country)}</span>
          </div>
        </div>
        ${hub.commodities && hub.commodities.length > 0 ? `
          <div class="popup-section">
            <span class="section-label">${t('popups.commodityHub.commodities')}</span>
            <div class="popup-tags">
              ${hub.commodities.map(c => `<span class="popup-tag">${escapeHtml(c)}</span>`).join('')}
            </div>
          </div>
        ` : ''}
        ${hub.description ? `<p class="popup-description">${escapeHtml(hub.description)}</p>` : ''}
      </div>
    `;
  }
}
