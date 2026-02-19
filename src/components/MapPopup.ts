import type { ConflictZone, Hotspot, Earthquake, NewsItem, MilitaryBase, StrategicWaterway, APTGroup, NuclearFacility, EconomicCenter, GammaIrradiator, Pipeline, UnderseaCable, CableAdvisory, RepairShip, InternetOutage, AIDataCenter, AisDisruptionEvent, SocialUnrestEvent, AirportDelayAlert, MilitaryFlight, MilitaryVessel, MilitaryFlightCluster, MilitaryVesselCluster, NaturalEvent, Port, Spaceport, CriticalMineralProject, CyberThreat } from '@/types';
import type { WeatherAlert } from '@/services/weather';
import type { StartupHub, Accelerator, TechHQ, CloudRegion } from '@/config/tech-geo';
import type { TechHubActivity } from '@/services/tech-activity';
import type { GeoHubActivity } from '@/services/geo-activity';
import { isMobileDevice } from '@/utils';
import { t } from '@/services/i18n';

import { renderConflictPopup } from './popups/ConflictPopup';
import { renderHotspotPopup, loadHotspotGdeltContext } from './popups/HotspotPopup';
import { renderEarthquakePopup } from './popups/EarthquakePopup';
import { renderWeatherPopup } from './popups/WeatherPopup';
import { renderBasePopup, renderWaterwayPopup, renderMilitaryFlightPopup, renderMilitaryVesselPopup, renderMilitaryFlightClusterPopup, renderMilitaryVesselClusterPopup } from './popups/MilitaryPopup';
import { renderAPTPopup, renderCyberThreatPopup } from './popups/CyberPopup';
import { renderNuclearPopup, renderIrradiatorPopup } from './popups/NuclearPopup';
import { renderEconomicPopup, renderStockExchangePopup, renderFinancialCenterPopup, renderCentralBankPopup, renderCommodityHubPopup } from './popups/EconomicPopup';
import type { StockExchangePopupData, FinancialCenterPopupData, CentralBankPopupData, CommodityHubPopupData } from './popups/EconomicPopup';
import { renderPipelinePopup, renderCablePopup, renderCableAdvisoryPopup, renderRepairShipPopup, renderOutagePopup } from './popups/InfrastructurePopup';
import { renderDatacenterPopup, renderDatacenterClusterPopup } from './popups/DatacenterPopup';
import type { DatacenterClusterData } from './popups/DatacenterPopup';
import { renderProtestPopup, renderProtestClusterPopup } from './popups/SocialUnrestPopup';
import type { ProtestClusterData } from './popups/SocialUnrestPopup';
import { renderAisPopup, renderFlightPopup, renderPortPopup, renderSpaceportPopup } from './popups/TransportPopup';
import { renderNaturalEventPopup } from './popups/NaturalEventPopup';
import { renderStartupHubPopup, renderCloudRegionPopup, renderTechHQPopup, renderAcceleratorPopup, renderTechEventPopup, renderTechHQClusterPopup, renderTechEventClusterPopup } from './popups/TechPopup';
import type { TechEventPopupData, TechHQClusterData, TechEventClusterData } from './popups/TechPopup';
import { renderMineralPopup } from './popups/MineralPopup';

export type PopupType = 'conflict' | 'hotspot' | 'earthquake' | 'weather' | 'base' | 'waterway' | 'apt' | 'cyberThreat' | 'nuclear' | 'economic' | 'irradiator' | 'pipeline' | 'cable' | 'cable-advisory' | 'repair-ship' | 'outage' | 'datacenter' | 'datacenterCluster' | 'ais' | 'protest' | 'protestCluster' | 'flight' | 'militaryFlight' | 'militaryVessel' | 'militaryFlightCluster' | 'militaryVesselCluster' | 'natEvent' | 'port' | 'spaceport' | 'mineral' | 'startupHub' | 'cloudRegion' | 'techHQ' | 'accelerator' | 'techEvent' | 'techHQCluster' | 'techEventCluster' | 'techActivity' | 'geoActivity' | 'stockExchange' | 'financialCenter' | 'centralBank' | 'commodityHub';

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
      requestAnimationFrame(() => this.popup?.classList.add('open'));
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

  public async loadHotspotGdeltContext(hotspot: Hotspot): Promise<void> {
    return loadHotspotGdeltContext(this.popup, hotspot);
  }

  private renderContent(data: PopupData): string {
    switch (data.type) {
      case 'conflict':
        return renderConflictPopup(data.data as ConflictZone);
      case 'hotspot':
        return renderHotspotPopup(data.data as Hotspot, data.relatedNews);
      case 'earthquake':
        return renderEarthquakePopup(data.data as Earthquake);
      case 'weather':
        return renderWeatherPopup(data.data as WeatherAlert);
      case 'base':
        return renderBasePopup(data.data as MilitaryBase);
      case 'waterway':
        return renderWaterwayPopup(data.data as StrategicWaterway);
      case 'apt':
        return renderAPTPopup(data.data as APTGroup);
      case 'cyberThreat':
        return renderCyberThreatPopup(data.data as CyberThreat);
      case 'nuclear':
        return renderNuclearPopup(data.data as NuclearFacility);
      case 'economic':
        return renderEconomicPopup(data.data as EconomicCenter);
      case 'irradiator':
        return renderIrradiatorPopup(data.data as GammaIrradiator);
      case 'pipeline':
        return renderPipelinePopup(data.data as Pipeline);
      case 'cable':
        return renderCablePopup(data.data as UnderseaCable, this.cableAdvisories, this.repairShips);
      case 'cable-advisory':
        return renderCableAdvisoryPopup(data.data as CableAdvisory);
      case 'repair-ship':
        return renderRepairShipPopup(data.data as RepairShip);
      case 'outage':
        return renderOutagePopup(data.data as InternetOutage);
      case 'datacenter':
        return renderDatacenterPopup(data.data as AIDataCenter);
      case 'datacenterCluster':
        return renderDatacenterClusterPopup(data.data as DatacenterClusterData);
      case 'ais':
        return renderAisPopup(data.data as AisDisruptionEvent);
      case 'protest':
        return renderProtestPopup(data.data as SocialUnrestEvent);
      case 'protestCluster':
        return renderProtestClusterPopup(data.data as ProtestClusterData);
      case 'flight':
        return renderFlightPopup(data.data as AirportDelayAlert);
      case 'militaryFlight':
        return renderMilitaryFlightPopup(data.data as MilitaryFlight);
      case 'militaryVessel':
        return renderMilitaryVesselPopup(data.data as MilitaryVessel);
      case 'militaryFlightCluster':
        return renderMilitaryFlightClusterPopup(data.data as MilitaryFlightCluster);
      case 'militaryVesselCluster':
        return renderMilitaryVesselClusterPopup(data.data as MilitaryVesselCluster);
      case 'natEvent':
        return renderNaturalEventPopup(data.data as NaturalEvent);
      case 'port':
        return renderPortPopup(data.data as Port);
      case 'spaceport':
        return renderSpaceportPopup(data.data as Spaceport);
      case 'mineral':
        return renderMineralPopup(data.data as CriticalMineralProject);
      case 'startupHub':
        return renderStartupHubPopup(data.data as StartupHub);
      case 'cloudRegion':
        return renderCloudRegionPopup(data.data as CloudRegion);
      case 'techHQ':
        return renderTechHQPopup(data.data as TechHQ);
      case 'accelerator':
        return renderAcceleratorPopup(data.data as Accelerator);
      case 'techEvent':
        return renderTechEventPopup(data.data as TechEventPopupData);
      case 'techHQCluster':
        return renderTechHQClusterPopup(data.data as TechHQClusterData);
      case 'techEventCluster':
        return renderTechEventClusterPopup(data.data as TechEventClusterData);
      case 'stockExchange':
        return renderStockExchangePopup(data.data as StockExchangePopupData);
      case 'financialCenter':
        return renderFinancialCenterPopup(data.data as FinancialCenterPopupData);
      case 'centralBank':
        return renderCentralBankPopup(data.data as CentralBankPopupData);
      case 'commodityHub':
        return renderCommodityHubPopup(data.data as CommodityHubPopupData);
      default:
        return '';
    }
  }
}
