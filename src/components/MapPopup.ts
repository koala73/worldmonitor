import type { ConflictZone, Hotspot, Earthquake, NewsItem, MilitaryBase, StrategicWaterway, APTGroup, NuclearFacility, EconomicCenter, GammaIrradiator, Pipeline, UnderseaCable, InternetOutage, AIDataCenter, SocialUnrestEvent } from '@/types';
import type { WeatherAlert } from '@/services/weather';

export type PopupType = 'conflict' | 'hotspot' | 'earthquake' | 'weather' | 'base' | 'waterway' | 'apt' | 'nuclear' | 'economic' | 'irradiator' | 'pipeline' | 'cable' | 'outage' | 'datacenter' | 'protest';

interface PopupData {
  type: PopupType;
  data: ConflictZone | Hotspot | Earthquake | WeatherAlert | MilitaryBase | StrategicWaterway | APTGroup | NuclearFacility | EconomicCenter | GammaIrradiator | Pipeline | UnderseaCable | InternetOutage | AIDataCenter | SocialUnrestEvent;
  relatedNews?: NewsItem[];
  x: number;
  y: number;
}

export class MapPopup {
  private container: HTMLElement;
  private popup: HTMLElement | null = null;
  private onClose?: () => void;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  public show(data: PopupData): void {
    this.hide();

    this.popup = document.createElement('div');
    this.popup.className = 'map-popup';

    const content = this.renderContent(data);
    this.popup.innerHTML = content;

    // Position popup
    const maxX = this.container.clientWidth - 400;
    const maxY = this.container.clientHeight - 300;
    this.popup.style.left = `${Math.min(data.x + 20, maxX)}px`;
    this.popup.style.top = `${Math.min(data.y - 20, maxY)}px`;

    this.container.appendChild(this.popup);

    // Close button handler
    this.popup.querySelector('.popup-close')?.addEventListener('click', () => this.hide());

    // Click outside to close
    setTimeout(() => {
      document.addEventListener('click', this.handleOutsideClick);
    }, 100);
  }

  private handleOutsideClick = (e: MouseEvent) => {
    if (this.popup && !this.popup.contains(e.target as Node)) {
      this.hide();
    }
  };

  public hide(): void {
    if (this.popup) {
      this.popup.remove();
      this.popup = null;
      document.removeEventListener('click', this.handleOutsideClick);
      this.onClose?.();
    }
  }

  public setOnClose(callback: () => void): void {
    this.onClose = callback;
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
      case 'outage':
        return this.renderOutagePopup(data.data as InternetOutage);
      case 'datacenter':
        return this.renderDatacenterPopup(data.data as AIDataCenter);
      case 'protest':
        return this.renderProtestPopup(data.data as SocialUnrestEvent);
      default:
        return '';
    }
  }

  private renderConflictPopup(conflict: ConflictZone): string {
    const severityClass = conflict.intensity === 'high' ? 'high' : conflict.intensity === 'medium' ? 'medium' : 'low';
    const severityLabel = conflict.intensity?.toUpperCase() || 'UNKNOWN';

    return `
      <div class="popup-header conflict">
        <span class="popup-title">${conflict.name.toUpperCase()}</span>
        <span class="popup-badge ${severityClass}">${severityLabel}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">START DATE</span>
            <span class="stat-value">${conflict.startDate || 'Unknown'}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">CASUALTIES</span>
            <span class="stat-value">${conflict.casualties || 'Unknown'}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">DISPLACED</span>
            <span class="stat-value">${conflict.displaced || 'Unknown'}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">LOCATION</span>
            <span class="stat-value">${conflict.location || `${conflict.center[1]}°N, ${conflict.center[0]}°E`}</span>
          </div>
        </div>
        ${conflict.description ? `<p class="popup-description">${conflict.description}</p>` : ''}
        ${conflict.parties && conflict.parties.length > 0 ? `
          <div class="popup-section">
            <span class="section-label">BELLIGERENTS</span>
            <div class="popup-tags">
              ${conflict.parties.map(p => `<span class="popup-tag">${p}</span>`).join('')}
            </div>
          </div>
        ` : ''}
        ${conflict.keyDevelopments && conflict.keyDevelopments.length > 0 ? `
          <div class="popup-section">
            <span class="section-label">KEY DEVELOPMENTS</span>
            <ul class="popup-list">
              ${conflict.keyDevelopments.map(d => `<li>${d}</li>`).join('')}
            </ul>
          </div>
        ` : ''}
      </div>
    `;
  }

  private renderHotspotPopup(hotspot: Hotspot, relatedNews?: NewsItem[]): string {
    const severityClass = hotspot.level || 'low';
    const severityLabel = (hotspot.level || 'low').toUpperCase();

    return `
      <div class="popup-header hotspot">
        <span class="popup-title">${hotspot.name.toUpperCase()}</span>
        <span class="popup-badge ${severityClass}">${severityLabel}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        ${hotspot.subtext ? `<div class="popup-subtitle">${hotspot.subtext}</div>` : ''}
        ${hotspot.description ? `<p class="popup-description">${hotspot.description}</p>` : ''}
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">COORDINATES</span>
            <span class="stat-value">${hotspot.lat.toFixed(2)}°N, ${hotspot.lon.toFixed(2)}°E</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">STATUS</span>
            <span class="stat-value">${hotspot.status || 'Monitoring'}</span>
          </div>
        </div>
        ${hotspot.agencies && hotspot.agencies.length > 0 ? `
          <div class="popup-section">
            <span class="section-label">KEY ENTITIES</span>
            <div class="popup-tags">
              ${hotspot.agencies.map(a => `<span class="popup-tag">${a}</span>`).join('')}
            </div>
          </div>
        ` : ''}
        ${relatedNews && relatedNews.length > 0 ? `
          <div class="popup-section">
            <span class="section-label">RELATED HEADLINES</span>
            <div class="popup-news">
              ${relatedNews.slice(0, 5).map(n => `
                <div class="popup-news-item">
                  <span class="news-source">${n.source}</span>
                  <a href="${n.link}" target="_blank" class="news-title">${n.title}</a>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }

  private renderEarthquakePopup(earthquake: Earthquake): string {
    const severity = earthquake.magnitude >= 6 ? 'high' : earthquake.magnitude >= 5 ? 'medium' : 'low';
    const severityLabel = earthquake.magnitude >= 6 ? 'MAJOR' : earthquake.magnitude >= 5 ? 'MODERATE' : 'MINOR';

    const timeAgo = this.getTimeAgo(earthquake.time);

    return `
      <div class="popup-header earthquake">
        <span class="popup-title magnitude">M${earthquake.magnitude.toFixed(1)}</span>
        <span class="popup-badge ${severity}">${severityLabel}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <p class="popup-location">${earthquake.place}</p>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">Depth</span>
            <span class="stat-value">${earthquake.depth.toFixed(1)} km</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">Coordinates</span>
            <span class="stat-value">${earthquake.lat.toFixed(2)}°, ${earthquake.lon.toFixed(2)}°</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">Time</span>
            <span class="stat-value">${timeAgo}</span>
          </div>
        </div>
        <a href="${earthquake.url}" target="_blank" class="popup-link">View on USGS →</a>
      </div>
    `;
  }

  private renderProtestPopup(event: SocialUnrestEvent): string {
    const severityClass = event.severity ?? 'low';
    const severityLabel = event.severity?.toUpperCase() ?? 'LOW';
    const location = [event.city, event.country].filter(Boolean).join(', ');
    const clusterInfo = event.clusterSize && event.clusterSize > 1
      ? `<div class="popup-stat"><span class="stat-label">CLUSTER</span><span class="stat-value">${event.clusterSize} events / ${event.clusterWindowHours ?? 48}h</span></div>`
      : '';

    return `
      <div class="popup-header protest">
        <span class="popup-title">${event.title.toUpperCase()}</span>
        <span class="popup-badge ${severityClass}">${severityLabel}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        ${event.summary ? `<p class="popup-description">${event.summary}</p>` : ''}
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">LOCATION</span>
            <span class="stat-value">${location}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">TIME</span>
            <span class="stat-value">${event.time.toUTCString().replace('GMT', 'UTC')}</span>
          </div>
          ${clusterInfo}
        </div>
        ${event.tags && event.tags.length > 0 ? `
          <div class="popup-section">
            <span class="section-label">TAGS</span>
            <div class="popup-tags">
              ${event.tags.map(t => `<span class="popup-tag">${t}</span>`).join('')}
            </div>
          </div>
        ` : ''}
        ${event.sources && event.sources.length > 0 ? `
          <div class="popup-section">
            <span class="section-label">SOURCES</span>
            <div class="popup-tags">
              ${event.sources.map(s => `<span class="popup-tag">${s}</span>`).join('')}
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }

  private getTimeAgo(date: Date): string {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  private renderWeatherPopup(alert: WeatherAlert): string {
    const severityClass = alert.severity.toLowerCase();
    const expiresIn = this.getTimeUntil(alert.expires);

    return `
      <div class="popup-header weather ${severityClass}">
        <span class="popup-title">${alert.event.toUpperCase()}</span>
        <span class="popup-badge ${severityClass}">${alert.severity.toUpperCase()}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <p class="popup-headline">${alert.headline}</p>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">Area</span>
            <span class="stat-value">${alert.areaDesc}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">Expires</span>
            <span class="stat-value">${expiresIn}</span>
          </div>
        </div>
        <p class="popup-description">${alert.description.slice(0, 300)}${alert.description.length > 300 ? '...' : ''}</p>
      </div>
    `;
  }

  private getTimeUntil(date: Date): string {
    const ms = date.getTime() - Date.now();
    if (ms <= 0) return 'Expired';
    const hours = Math.floor(ms / (1000 * 60 * 60));
    if (hours < 1) return `${Math.floor(ms / (1000 * 60))}m`;
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  }

  private renderBasePopup(base: MilitaryBase): string {
    const typeLabels: Record<string, string> = {
      'us-nato': 'US/NATO',
      'china': 'CHINA',
      'russia': 'RUSSIA',
    };
    const typeColors: Record<string, string> = {
      'us-nato': 'elevated',
      'china': 'high',
      'russia': 'high',
    };

    return `
      <div class="popup-header base">
        <span class="popup-title">${base.name.toUpperCase()}</span>
        <span class="popup-badge ${typeColors[base.type] || 'low'}">${typeLabels[base.type] || base.type.toUpperCase()}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        ${base.description ? `<p class="popup-description">${base.description}</p>` : ''}
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">TYPE</span>
            <span class="stat-value">${typeLabels[base.type] || base.type}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">COORDINATES</span>
            <span class="stat-value">${base.lat.toFixed(2)}°, ${base.lon.toFixed(2)}°</span>
          </div>
        </div>
      </div>
    `;
  }

  private renderWaterwayPopup(waterway: StrategicWaterway): string {
    return `
      <div class="popup-header waterway">
        <span class="popup-title">${waterway.name}</span>
        <span class="popup-badge elevated">STRATEGIC</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        ${waterway.description ? `<p class="popup-description">${waterway.description}</p>` : ''}
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">COORDINATES</span>
            <span class="stat-value">${waterway.lat.toFixed(2)}°, ${waterway.lon.toFixed(2)}°</span>
          </div>
        </div>
      </div>
    `;
  }

  private renderAPTPopup(apt: APTGroup): string {
    return `
      <div class="popup-header apt">
        <span class="popup-title">${apt.name}</span>
        <span class="popup-badge high">THREAT</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">Also known as: ${apt.aka}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">SPONSOR</span>
            <span class="stat-value">${apt.sponsor}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">ORIGIN</span>
            <span class="stat-value">${apt.lat.toFixed(1)}°, ${apt.lon.toFixed(1)}°</span>
          </div>
        </div>
        <p class="popup-description">Advanced Persistent Threat group with state-level capabilities. Known for sophisticated cyber operations targeting critical infrastructure, government, and defense sectors.</p>
      </div>
    `;
  }

  private renderNuclearPopup(facility: NuclearFacility): string {
    const typeLabels: Record<string, string> = {
      'plant': 'POWER PLANT',
      'enrichment': 'ENRICHMENT',
      'weapons': 'WEAPONS COMPLEX',
      'research': 'RESEARCH',
    };
    const statusColors: Record<string, string> = {
      'active': 'elevated',
      'contested': 'high',
      'decommissioned': 'low',
    };

    return `
      <div class="popup-header nuclear">
        <span class="popup-title">${facility.name.toUpperCase()}</span>
        <span class="popup-badge ${statusColors[facility.status] || 'low'}">${facility.status.toUpperCase()}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">TYPE</span>
            <span class="stat-value">${typeLabels[facility.type] || facility.type.toUpperCase()}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">STATUS</span>
            <span class="stat-value">${facility.status.toUpperCase()}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">COORDINATES</span>
            <span class="stat-value">${facility.lat.toFixed(2)}°, ${facility.lon.toFixed(2)}°</span>
          </div>
        </div>
        <p class="popup-description">Nuclear facility under monitoring. Strategic importance for regional security and non-proliferation concerns.</p>
      </div>
    `;
  }

  private renderEconomicPopup(center: EconomicCenter): string {
    const typeLabels: Record<string, string> = {
      'exchange': 'STOCK EXCHANGE',
      'central-bank': 'CENTRAL BANK',
      'financial-hub': 'FINANCIAL HUB',
    };
    const typeIcons: Record<string, string> = {
      'exchange': '📈',
      'central-bank': '🏛',
      'financial-hub': '💰',
    };

    const marketStatus = center.marketHours ? this.getMarketStatus(center.marketHours) : null;

    return `
      <div class="popup-header economic ${center.type}">
        <span class="popup-title">${typeIcons[center.type] || ''} ${center.name.toUpperCase()}</span>
        <span class="popup-badge ${marketStatus === 'OPEN' ? 'elevated' : 'low'}">${marketStatus || typeLabels[center.type]}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        ${center.description ? `<p class="popup-description">${center.description}</p>` : ''}
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">TYPE</span>
            <span class="stat-value">${typeLabels[center.type] || center.type.toUpperCase()}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">COUNTRY</span>
            <span class="stat-value">${center.country}</span>
          </div>
          ${center.marketHours ? `
          <div class="popup-stat">
            <span class="stat-label">TRADING HOURS</span>
            <span class="stat-value">${center.marketHours.open} - ${center.marketHours.close}</span>
          </div>
          ` : ''}
          <div class="popup-stat">
            <span class="stat-label">COORDINATES</span>
            <span class="stat-value">${center.lat.toFixed(2)}°, ${center.lon.toFixed(2)}°</span>
          </div>
        </div>
      </div>
    `;
  }

  private renderIrradiatorPopup(irradiator: GammaIrradiator): string {
    return `
      <div class="popup-header irradiator">
        <span class="popup-title">☢ ${irradiator.city.toUpperCase()}</span>
        <span class="popup-badge elevated">GAMMA</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">Industrial Gamma Irradiator Facility</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">COUNTRY</span>
            <span class="stat-value">${irradiator.country}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">CITY</span>
            <span class="stat-value">${irradiator.city}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">COORDINATES</span>
            <span class="stat-value">${irradiator.lat.toFixed(2)}°, ${irradiator.lon.toFixed(2)}°</span>
          </div>
        </div>
        <p class="popup-description">Industrial irradiation facility using Cobalt-60 or Cesium-137 sources for medical device sterilization, food preservation, or material processing. Source: IAEA DIIF Database.</p>
      </div>
    `;
  }

  private renderPipelinePopup(pipeline: Pipeline): string {
    const typeLabels: Record<string, string> = {
      'oil': 'OIL PIPELINE',
      'gas': 'GAS PIPELINE',
      'products': 'PRODUCTS PIPELINE',
    };
    const typeColors: Record<string, string> = {
      'oil': 'high',
      'gas': 'elevated',
      'products': 'low',
    };
    const statusLabels: Record<string, string> = {
      'operating': 'OPERATING',
      'construction': 'UNDER CONSTRUCTION',
    };
    const typeIcon = pipeline.type === 'oil' ? '🛢' : pipeline.type === 'gas' ? '🔥' : '⛽';

    return `
      <div class="popup-header pipeline ${pipeline.type}">
        <span class="popup-title">${typeIcon} ${pipeline.name.toUpperCase()}</span>
        <span class="popup-badge ${typeColors[pipeline.type] || 'low'}">${pipeline.type.toUpperCase()}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${typeLabels[pipeline.type] || 'PIPELINE'}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">STATUS</span>
            <span class="stat-value">${statusLabels[pipeline.status] || pipeline.status.toUpperCase()}</span>
          </div>
          ${pipeline.capacity ? `
          <div class="popup-stat">
            <span class="stat-label">CAPACITY</span>
            <span class="stat-value">${pipeline.capacity}</span>
          </div>
          ` : ''}
          ${pipeline.length ? `
          <div class="popup-stat">
            <span class="stat-label">LENGTH</span>
            <span class="stat-value">${pipeline.length}</span>
          </div>
          ` : ''}
          ${pipeline.operator ? `
          <div class="popup-stat">
            <span class="stat-label">OPERATOR</span>
            <span class="stat-value">${pipeline.operator}</span>
          </div>
          ` : ''}
        </div>
        ${pipeline.countries && pipeline.countries.length > 0 ? `
          <div class="popup-section">
            <span class="section-label">COUNTRIES</span>
            <div class="popup-tags">
              ${pipeline.countries.map(c => `<span class="popup-tag">${c}</span>`).join('')}
            </div>
          </div>
        ` : ''}
        <p class="popup-description">Major ${pipeline.type} pipeline infrastructure. ${pipeline.status === 'operating' ? 'Currently operational and transporting resources.' : 'Currently under construction.'}</p>
      </div>
    `;
  }

  private renderCablePopup(cable: UnderseaCable): string {
    return `
      <div class="popup-header cable">
        <span class="popup-title">🌐 ${cable.name.toUpperCase()}</span>
        <span class="popup-badge elevated">${cable.major ? 'MAJOR' : 'CABLE'}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">Undersea Fiber Optic Cable</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">TYPE</span>
            <span class="stat-value">SUBMARINE CABLE</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">WAYPOINTS</span>
            <span class="stat-value">${cable.points.length}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">STATUS</span>
            <span class="stat-value">ACTIVE</span>
          </div>
        </div>
        <p class="popup-description">Undersea telecommunications cable carrying international internet traffic. These fiber optic cables form the backbone of global internet connectivity, transmitting over 95% of intercontinental data.</p>
      </div>
    `;
  }

  private renderOutagePopup(outage: InternetOutage): string {
    const severityColors: Record<string, string> = {
      'total': 'high',
      'major': 'elevated',
      'partial': 'low',
    };
    const severityLabels: Record<string, string> = {
      'total': 'TOTAL BLACKOUT',
      'major': 'MAJOR OUTAGE',
      'partial': 'PARTIAL DISRUPTION',
    };
    const timeAgo = this.getTimeAgo(outage.pubDate);

    return `
      <div class="popup-header outage ${outage.severity}">
        <span class="popup-title">📡 ${outage.country.toUpperCase()}</span>
        <span class="popup-badge ${severityColors[outage.severity] || 'low'}">${severityLabels[outage.severity] || 'DISRUPTION'}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${outage.title}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">SEVERITY</span>
            <span class="stat-value">${outage.severity.toUpperCase()}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">REPORTED</span>
            <span class="stat-value">${timeAgo}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">COORDINATES</span>
            <span class="stat-value">${outage.lat.toFixed(2)}°, ${outage.lon.toFixed(2)}°</span>
          </div>
        </div>
        ${outage.categories && outage.categories.length > 0 ? `
          <div class="popup-section">
            <span class="section-label">CATEGORIES</span>
            <div class="popup-tags">
              ${outage.categories.slice(0, 5).map(c => `<span class="popup-tag">${c}</span>`).join('')}
            </div>
          </div>
        ` : ''}
        <p class="popup-description">${outage.description.slice(0, 250)}${outage.description.length > 250 ? '...' : ''}</p>
        <a href="${outage.link}" target="_blank" class="popup-link">Read full report →</a>
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
      'existing': 'OPERATIONAL',
      'planned': 'PLANNED',
      'decommissioned': 'DECOMMISSIONED',
    };

    const formatNumber = (n: number) => {
      if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
      if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
      return n.toString();
    };

    return `
      <div class="popup-header datacenter ${dc.status}">
        <span class="popup-title">🖥️ ${dc.name}</span>
        <span class="popup-badge ${statusColors[dc.status] || 'normal'}">${statusLabels[dc.status] || 'UNKNOWN'}</span>
        <button class="popup-close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${dc.owner} • ${dc.country}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">GPU/CHIP COUNT</span>
            <span class="stat-value">${formatNumber(dc.chipCount)}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">CHIP TYPE</span>
            <span class="stat-value">${dc.chipType || 'Unknown'}</span>
          </div>
          ${dc.powerMW ? `
          <div class="popup-stat">
            <span class="stat-label">POWER</span>
            <span class="stat-value">${dc.powerMW.toFixed(0)} MW</span>
          </div>
          ` : ''}
          ${dc.sector ? `
          <div class="popup-stat">
            <span class="stat-label">SECTOR</span>
            <span class="stat-value">${dc.sector}</span>
          </div>
          ` : ''}
        </div>
        ${dc.note ? `<p class="popup-description">${dc.note}</p>` : ''}
        <div class="popup-attribution">Data: Epoch AI GPU Clusters</div>
      </div>
    `;
  }

  private getMarketStatus(hours: { open: string; close: string; timezone: string }): string {
    try {
      const now = new Date();
      const formatter = new Intl.DateTimeFormat('en-US', {
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
        return 'OPEN';
      }
      return 'CLOSED';
    } catch {
      return 'UNKNOWN';
    }
  }
}
