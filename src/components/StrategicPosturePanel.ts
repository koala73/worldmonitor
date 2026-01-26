import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { fetchCachedTheaterPosture, type CachedTheaterPosture } from '@/services/cached-theater-posture';
import { fetchMilitaryVessels, isMilitaryVesselTrackingConfigured } from '@/services/military-vessels';
import type { TheaterPostureSummary } from '@/services/military-surge';

export class StrategicPosturePanel extends Panel {
  private postures: TheaterPostureSummary[] = [];
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private onLocationClick?: (lat: number, lon: number) => void;
  private lastTimestamp: string = '';
  private isStale: boolean = false;

  constructor() {
    super({
      id: 'strategic-posture',
      title: 'Strategic Posture',
      showCount: false,
      trackActivity: true,
      infoTooltip: `<strong>Methodology</strong>
        <p>Aggregates military aircraft and naval vessels by theater.</p>
        <ul>
          <li><strong>Normal:</strong> Baseline activity</li>
          <li><strong>Elevated:</strong> Above threshold (50+ aircraft)</li>
          <li><strong>Critical:</strong> High concentration (100+ aircraft)</li>
        </ul>
        <p><strong>Strike Capable:</strong> Tankers + AWACS + Fighters present in sufficient numbers for sustained operations.</p>`,
    });
    this.init();
  }

  private init(): void {
    this.showLoading();
    this.fetchAndRender();
    this.startAutoRefresh();
  }

  private startAutoRefresh(): void {
    this.refreshInterval = setInterval(() => this.fetchAndRender(), 5 * 60 * 1000);
  }

  public override showLoading(): void {
    this.setContent(`
      <div class="posture-panel">
        <div class="posture-no-data">
          <div class="posture-no-data-icon">⏳</div>
          <div class="posture-no-data-title">Loading...</div>
          <div class="posture-no-data-desc">
            Fetching theater posture data.
          </div>
        </div>
      </div>
    `);
  }

  private async fetchAndRender(): Promise<void> {
    try {
      // Fetch aircraft data from server
      const data = await fetchCachedTheaterPosture();
      if (!data || data.postures.length === 0) {
        this.showNoData();
        return;
      }

      // Deep clone to avoid mutating cached data
      this.postures = data.postures.map((p) => ({
        ...p,
        byOperator: { ...p.byOperator },
      }));
      this.lastTimestamp = data.timestamp;
      this.isStale = data.stale || false;

      // Try to augment with vessel data (client-side)
      await this.augmentWithVessels();

      this.updateBadges();
      this.render();
    } catch (error) {
      console.error('[StrategicPosturePanel] Fetch error:', error);
      this.showFetchError();
    }
  }

  private async augmentWithVessels(): Promise<void> {
    if (!isMilitaryVesselTrackingConfigured()) {
      return;
    }

    try {
      const { vessels } = await fetchMilitaryVessels();
      if (vessels.length === 0) return;

      // Merge vessel counts into each theater
      for (const posture of this.postures) {
        if (!posture.bounds) continue;

        // Filter vessels within theater bounds
        const theaterVessels = vessels.filter(
          (v) =>
            v.lat >= posture.bounds!.south &&
            v.lat <= posture.bounds!.north &&
            v.lon >= posture.bounds!.west &&
            v.lon <= posture.bounds!.east
        );

        // Count by type
        posture.destroyers = theaterVessels.filter((v) => v.vesselType === 'destroyer').length;
        posture.frigates = theaterVessels.filter((v) => v.vesselType === 'frigate').length;
        posture.carriers = theaterVessels.filter((v) => v.vesselType === 'carrier').length;
        posture.submarines = theaterVessels.filter((v) => v.vesselType === 'submarine').length;
        posture.patrol = theaterVessels.filter((v) => v.vesselType === 'patrol').length;
        posture.auxiliaryVessels = theaterVessels.filter(
          (v) => v.vesselType === 'auxiliary' || v.vesselType === 'special' || v.vesselType === 'amphibious' || v.vesselType === 'icebreaker' || v.vesselType === 'research'
        ).length;
        posture.totalVessels = theaterVessels.length;

        // Add vessel operators to byOperator
        for (const v of theaterVessels) {
          const op = v.operator || 'unknown';
          posture.byOperator[op] = (posture.byOperator[op] || 0) + 1;
        }
      }

      console.log('[StrategicPosturePanel] Augmented with', vessels.length, 'vessels');
    } catch (error) {
      console.warn('[StrategicPosturePanel] Failed to fetch vessels:', error);
    }
  }

  public updatePostures(data: CachedTheaterPosture): void {
    if (!data || data.postures.length === 0) {
      this.showNoData();
      return;
    }
    // Deep clone to avoid mutating cached data
    this.postures = data.postures.map((p) => ({
      ...p,
      byOperator: { ...p.byOperator },
    }));
    this.lastTimestamp = data.timestamp;
    this.augmentWithVessels().then(() => {
      this.updateBadges();
      this.render();
    });
  }

  private updateBadges(): void {
    const hasCritical = this.postures.some((p) => p.postureLevel === 'critical');
    const hasElevated = this.postures.some((p) => p.postureLevel === 'elevated');
    if (hasCritical) {
      this.setNewBadge(1, true);
    } else if (hasElevated) {
      this.setNewBadge(1, false);
    } else {
      this.clearNewBadge();
    }
  }

  public refresh(): void {
    this.fetchAndRender();
  }

  private showNoData(): void {
    this.setContent(`
      <div class="posture-panel">
        <div class="posture-no-data">
          <div class="posture-no-data-icon">📡</div>
          <div class="posture-no-data-title">Acquiring Data</div>
          <div class="posture-no-data-desc">
            Military flight tracking uses public ADS-B transponder data.
            Data may take a moment to load, or the feed may be temporarily rate-limited.
          </div>
          <button class="posture-retry-btn">↻ Try Again</button>
        </div>
      </div>
    `);
    this.content.querySelector('.posture-retry-btn')?.addEventListener('click', () => this.refresh());
  }

  private showFetchError(): void {
    this.setContent(`
      <div class="posture-panel">
        <div class="posture-no-data">
          <div class="posture-no-data-icon">⚠️</div>
          <div class="posture-no-data-title">Feed Temporarily Unavailable</div>
          <div class="posture-no-data-desc">
            The OpenSky flight feed is rate-limited or temporarily down.
            This is normal during peak hours. Will retry automatically.
          </div>
          <button class="posture-retry-btn">↻ Try Again</button>
        </div>
      </div>
    `);
    this.content.querySelector('.posture-retry-btn')?.addEventListener('click', () => this.refresh());
  }

  private getPostureBadge(level: string): string {
    switch (level) {
      case 'critical':
        return '<span class="posture-badge posture-critical">CRIT</span>';
      case 'elevated':
        return '<span class="posture-badge posture-elevated">ELEV</span>';
      default:
        return '<span class="posture-badge posture-normal">NORM</span>';
    }
  }

  private getTrendIcon(trend: string, change: number): string {
    switch (trend) {
      case 'increasing':
        return `<span class="posture-trend trend-up">↗ +${change}%</span>`;
      case 'decreasing':
        return `<span class="posture-trend trend-down">↘ ${change}%</span>`;
      default:
        return '<span class="posture-trend trend-stable">→ stable</span>';
    }
  }

  private renderTheater(p: TheaterPostureSummary): string {
    const isExpanded = p.postureLevel !== 'normal';

    if (!isExpanded) {
      const summary = p.totalVessels > 0
        ? `${p.totalAircraft} aircraft, ${p.totalVessels} vessels`
        : `${p.totalAircraft} aircraft`;
      return `
        <div class="posture-theater posture-compact" data-lat="${p.centerLat}" data-lon="${p.centerLon}">
          <div class="posture-theater-header">
            <span class="posture-name">${escapeHtml(p.shortName)}</span>
            ${this.getPostureBadge(p.postureLevel)}
          </div>
          <div class="posture-summary-mini">${summary}</div>
        </div>
      `;
    }

    // Build aircraft rows
    const aircraftRows = [
      p.fighters > 0 ? `<div class="posture-row"><span class="posture-icon">✈️</span><span class="posture-count">${p.fighters}</span><span class="posture-label">Fighters</span></div>` : '',
      p.tankers > 0 ? `<div class="posture-row"><span class="posture-icon">⛽</span><span class="posture-count">${p.tankers}</span><span class="posture-label">Tankers</span></div>` : '',
      p.awacs > 0 ? `<div class="posture-row"><span class="posture-icon">📡</span><span class="posture-count">${p.awacs}</span><span class="posture-label">AWACS</span></div>` : '',
      p.reconnaissance > 0 ? `<div class="posture-row"><span class="posture-icon">🔍</span><span class="posture-count">${p.reconnaissance}</span><span class="posture-label">Recon</span></div>` : '',
      p.transport > 0 ? `<div class="posture-row"><span class="posture-icon">📦</span><span class="posture-count">${p.transport}</span><span class="posture-label">Transport</span></div>` : '',
      p.bombers > 0 ? `<div class="posture-row"><span class="posture-icon">💣</span><span class="posture-count">${p.bombers}</span><span class="posture-label">Bombers</span></div>` : '',
      p.drones > 0 ? `<div class="posture-row"><span class="posture-icon">🛸</span><span class="posture-count">${p.drones}</span><span class="posture-label">Drones</span></div>` : '',
    ].filter(Boolean).join('');

    // Build vessel rows
    const vesselRows = [
      p.carriers > 0 ? `<div class="posture-row"><span class="posture-icon">🚢</span><span class="posture-count">${p.carriers}</span><span class="posture-label">Carriers</span></div>` : '',
      p.destroyers > 0 ? `<div class="posture-row"><span class="posture-icon">⚓</span><span class="posture-count">${p.destroyers}</span><span class="posture-label">Destroyers</span></div>` : '',
      p.frigates > 0 ? `<div class="posture-row"><span class="posture-icon">🛥️</span><span class="posture-count">${p.frigates}</span><span class="posture-label">Frigates</span></div>` : '',
      p.submarines > 0 ? `<div class="posture-row"><span class="posture-icon">🦈</span><span class="posture-count">${p.submarines}</span><span class="posture-label">Submarines</span></div>` : '',
      p.patrol > 0 ? `<div class="posture-row"><span class="posture-icon">🚤</span><span class="posture-count">${p.patrol}</span><span class="posture-label">Patrol</span></div>` : '',
      p.auxiliaryVessels > 0 ? `<div class="posture-row"><span class="posture-icon">🔧</span><span class="posture-count">${p.auxiliaryVessels}</span><span class="posture-label">Auxiliary</span></div>` : '',
    ].filter(Boolean).join('');

    return `
      <div class="posture-theater posture-expanded ${p.postureLevel}" data-lat="${p.centerLat}" data-lon="${p.centerLon}">
        <div class="posture-theater-header">
          <span class="posture-name">${escapeHtml(p.theaterName)}</span>
          ${this.getPostureBadge(p.postureLevel)}
        </div>

        ${aircraftRows ? `
        <div class="posture-section-label">AIR</div>
        <div class="posture-breakdown">${aircraftRows}</div>
        ` : ''}

        ${vesselRows ? `
        <div class="posture-section-label">NAVAL</div>
        <div class="posture-breakdown">${vesselRows}</div>
        ` : ''}

        <div class="posture-meta">
          ${p.strikeCapable ? '<span class="posture-strike">⚡ STRIKE CAPABLE</span>' : ''}
          ${this.getTrendIcon(p.trend, p.changePercent)}
        </div>

        ${p.targetNation ? `<div class="posture-target">Focus: ${escapeHtml(p.targetNation)}</div>` : ''}
      </div>
    `;
  }

  private render(): void {
    const sorted = [...this.postures].sort((a, b) => {
      const order: Record<string, number> = { critical: 0, elevated: 1, normal: 2 };
      return (order[a.postureLevel] ?? 2) - (order[b.postureLevel] ?? 2);
    });

    const updatedTime = this.lastTimestamp
      ? new Date(this.lastTimestamp).toLocaleTimeString()
      : new Date().toLocaleTimeString();

    const staleWarning = this.isStale
      ? '<div class="posture-stale-warning">⚠️ Using cached data - live feed temporarily unavailable</div>'
      : '';

    const html = `
      <div class="posture-panel">
        ${staleWarning}
        ${sorted.map((p) => this.renderTheater(p)).join('')}

        <div class="posture-footer">
          <span class="posture-updated">${this.isStale ? '⚠️ ' : ''}Updated: ${updatedTime}</span>
          <button class="posture-refresh-btn" title="Refresh">↻</button>
        </div>
      </div>
    `;

    this.setContent(html);
    this.attachEventListeners();
  }

  private attachEventListeners(): void {
    this.content.querySelector('.posture-refresh-btn')?.addEventListener('click', () => {
      this.refresh();
    });

    const theaters = this.content.querySelectorAll('.posture-theater');
    theaters.forEach((el) => {
      el.addEventListener('click', () => {
        const lat = parseFloat((el as HTMLElement).dataset.lat || '0');
        const lon = parseFloat((el as HTMLElement).dataset.lon || '0');
        if (this.onLocationClick && !isNaN(lat) && !isNaN(lon)) {
          this.onLocationClick(lat, lon);
        }
      });
    });
  }

  public setLocationClickHandler(handler: (lat: number, lon: number) => void): void {
    this.onLocationClick = handler;
  }

  public destroy(): void {
    if (this.refreshInterval) clearInterval(this.refreshInterval);
    super.destroy();
  }
}
