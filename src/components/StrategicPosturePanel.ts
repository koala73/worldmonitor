import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { fetchCachedTheaterPosture, type CachedTheaterPosture } from '@/services/cached-theater-posture';
import { fetchMilitaryVessels, isMilitaryVesselTrackingConfigured } from '@/services/military-vessels';
import type { TheaterPostureSummary } from '@/services/military-surge';

export class StrategicPosturePanel extends Panel {
  private postures: TheaterPostureSummary[] = [];
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private vesselTimeouts: ReturnType<typeof setTimeout>[] = [];
  private loadingElapsedInterval: ReturnType<typeof setInterval> | null = null;
  private loadingStartTime: number = 0;
  private onLocationClick?: (lat: number, lon: number) => void;
  private lastTimestamp: string = '';
  private isStale: boolean = false;

  constructor() {
    super({
      id: 'strategic-posture',
      title: 'AI Strategic Posture',
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
    // Re-augment with vessels after stream has had time to populate
    // AIS data accumulates gradually - check at 30s, 60s, 90s, 120s
    this.vesselTimeouts.push(setTimeout(() => this.reaugmentVessels(), 30 * 1000));
    this.vesselTimeouts.push(setTimeout(() => this.reaugmentVessels(), 60 * 1000));
    this.vesselTimeouts.push(setTimeout(() => this.reaugmentVessels(), 90 * 1000));
    this.vesselTimeouts.push(setTimeout(() => this.reaugmentVessels(), 120 * 1000));
  }

  private startAutoRefresh(): void {
    this.refreshInterval = setInterval(() => this.fetchAndRender(), 5 * 60 * 1000);
  }

  private async reaugmentVessels(): Promise<void> {
    if (this.postures.length === 0) return;
    console.log('[StrategicPosturePanel] Re-augmenting with vessels...');
    await this.augmentWithVessels();
    this.render();
  }

  public override showLoading(): void {
    this.loadingStartTime = Date.now();
    this.setContent(`
      <div class="posture-panel">
        <div class="posture-loading">
          <div class="posture-loading-radar">
            <div class="posture-radar-sweep"></div>
            <div class="posture-radar-dot"></div>
          </div>
          <div class="posture-loading-title">Scanning Theaters</div>
          <div class="posture-loading-stages">
            <div class="posture-stage active">
              <span class="posture-stage-dot"></span>
              <span>Aircraft positions</span>
            </div>
            <div class="posture-stage pending">
              <span class="posture-stage-dot"></span>
              <span>Naval vessels</span>
            </div>
            <div class="posture-stage pending">
              <span class="posture-stage-dot"></span>
              <span>Theater analysis</span>
            </div>
          </div>
          <div class="posture-loading-tip">
            Connecting to live ADS-B &amp; AIS streams...
          </div>
          <div class="posture-loading-elapsed">Elapsed: 0s</div>
          <div class="posture-loading-note">
            Initial load takes 30-60 seconds as tracking data accumulates
          </div>
        </div>
      </div>
    `);
    this.startLoadingTimer();
  }

  private startLoadingTimer(): void {
    if (this.loadingElapsedInterval) clearInterval(this.loadingElapsedInterval);
    this.loadingElapsedInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.loadingStartTime) / 1000);
      const elapsedEl = this.content.querySelector('.posture-loading-elapsed');
      if (elapsedEl) {
        elapsedEl.textContent = `Elapsed: ${elapsed}s`;
      }
    }, 1000);
  }

  private stopLoadingTimer(): void {
    if (this.loadingElapsedInterval) {
      clearInterval(this.loadingElapsedInterval);
      this.loadingElapsedInterval = null;
    }
  }

  private showLoadingStage(stage: 'aircraft' | 'vessels' | 'analysis'): void {
    const stages = this.content.querySelectorAll('.posture-stage');
    if (stages.length === 0) return;

    stages.forEach((el, i) => {
      el.classList.remove('active', 'complete');
      if (stage === 'aircraft' && i === 0) el.classList.add('active');
      else if (stage === 'vessels') {
        if (i === 0) el.classList.add('complete');
        else if (i === 1) el.classList.add('active');
      } else if (stage === 'analysis') {
        if (i <= 1) el.classList.add('complete');
        else if (i === 2) el.classList.add('active');
      }
    });
  }

  private async fetchAndRender(): Promise<void> {
    try {
      // Fetch aircraft data from server
      this.showLoadingStage('aircraft');
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
      this.showLoadingStage('vessels');
      await this.augmentWithVessels();

      this.showLoadingStage('analysis');
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
      console.log(`[StrategicPosturePanel] Got ${vessels.length} total military vessels`);
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
          (v) => v.vesselType === 'auxiliary' || v.vesselType === 'special' || v.vesselType === 'amphibious' || v.vesselType === 'icebreaker' || v.vesselType === 'research' || v.vesselType === 'unknown'
        ).length;
        posture.totalVessels = theaterVessels.length;

        if (theaterVessels.length > 0) {
          console.log(`[StrategicPosturePanel] ${posture.shortName}: ${theaterVessels.length} vessels`, theaterVessels.map(v => v.vesselType));
        }

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
    this.isStale = data.stale || false;
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
    this.stopLoadingTimer();
    this.setContent(`
      <div class="posture-panel">
        <div class="posture-no-data">
          <div class="posture-no-data-icon pulse">📡</div>
          <div class="posture-no-data-title">Acquiring Data</div>
          <div class="posture-no-data-desc">
            Connecting to ADS-B network for military flight data.
            This may take 30-60 seconds on first load.
          </div>
          <div class="posture-data-sources">
            <div class="posture-source">
              <span class="posture-source-icon connecting">✈️</span>
              <span>OpenSky ADS-B</span>
            </div>
            <div class="posture-source">
              <span class="posture-source-icon waiting">🚢</span>
              <span>AIS Vessel Stream</span>
            </div>
          </div>
          <button class="posture-retry-btn">↻ Retry Now</button>
        </div>
      </div>
    `);
    this.content.querySelector('.posture-retry-btn')?.addEventListener('click', () => this.refresh());
  }

  private showFetchError(): void {
    this.stopLoadingTimer();
    this.setContent(`
      <div class="posture-panel">
        <div class="posture-no-data">
          <div class="posture-no-data-icon">⚠️</div>
          <div class="posture-no-data-title">Feed Rate Limited</div>
          <div class="posture-no-data-desc">
            OpenSky API has request limits. The panel will automatically
            retry in a few minutes, or you can try again now.
          </div>
          <div class="posture-error-hint">
            <strong>Tip:</strong> Peak hours (UTC 12:00-20:00) often see higher limits.
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
      // Compact single-line view for normal theaters
      const chips: string[] = [];
      if (p.totalAircraft > 0) chips.push(`<span class="posture-chip air">✈️ ${p.totalAircraft}</span>`);
      if (p.totalVessels > 0) chips.push(`<span class="posture-chip naval">⚓ ${p.totalVessels}</span>`);

      return `
        <div class="posture-theater posture-compact" data-lat="${p.centerLat}" data-lon="${p.centerLon}" title="Click to view ${escapeHtml(p.theaterName)} on map">
          <span class="posture-name">${escapeHtml(p.shortName)}</span>
          <div class="posture-chips">${chips.join('')}</div>
          ${this.getPostureBadge(p.postureLevel)}
        </div>
      `;
    }

    // Build compact stat chips for expanded view
    const airChips: string[] = [];
    if (p.fighters > 0) airChips.push(`<span class="posture-stat" title="Fighters">✈️ ${p.fighters}</span>`);
    if (p.tankers > 0) airChips.push(`<span class="posture-stat" title="Tankers">⛽ ${p.tankers}</span>`);
    if (p.awacs > 0) airChips.push(`<span class="posture-stat" title="AWACS">📡 ${p.awacs}</span>`);
    if (p.reconnaissance > 0) airChips.push(`<span class="posture-stat" title="Recon">🔍 ${p.reconnaissance}</span>`);
    if (p.transport > 0) airChips.push(`<span class="posture-stat" title="Transport">📦 ${p.transport}</span>`);
    if (p.bombers > 0) airChips.push(`<span class="posture-stat" title="Bombers">💣 ${p.bombers}</span>`);
    if (p.drones > 0) airChips.push(`<span class="posture-stat" title="Drones">🛸 ${p.drones}</span>`);
    // Fallback: show total aircraft if no typed breakdown available
    if (airChips.length === 0 && p.totalAircraft > 0) {
      airChips.push(`<span class="posture-stat" title="Aircraft">✈️ ${p.totalAircraft}</span>`);
    }

    const navalChips: string[] = [];
    if (p.carriers > 0) navalChips.push(`<span class="posture-stat carrier" title="Carriers">🚢 ${p.carriers}</span>`);
    if (p.destroyers > 0) navalChips.push(`<span class="posture-stat" title="Destroyers">⚓ ${p.destroyers}</span>`);
    if (p.frigates > 0) navalChips.push(`<span class="posture-stat" title="Frigates">🛥️ ${p.frigates}</span>`);
    if (p.submarines > 0) navalChips.push(`<span class="posture-stat" title="Submarines">🦈 ${p.submarines}</span>`);
    if (p.patrol > 0) navalChips.push(`<span class="posture-stat" title="Patrol">🚤 ${p.patrol}</span>`);
    if (p.auxiliaryVessels > 0) navalChips.push(`<span class="posture-stat" title="Auxiliary">⚓ ${p.auxiliaryVessels}</span>`);
    // Fallback: show total vessels if no typed breakdown available
    if (navalChips.length === 0 && p.totalVessels > 0) {
      navalChips.push(`<span class="posture-stat" title="Naval Vessels">⚓ ${p.totalVessels}</span>`);
    }

    const hasAir = airChips.length > 0;
    const hasNaval = navalChips.length > 0;

    return `
      <div class="posture-theater posture-expanded ${p.postureLevel}" data-lat="${p.centerLat}" data-lon="${p.centerLon}" title="Click to view on map">
        <div class="posture-theater-header">
          <span class="posture-name">${escapeHtml(p.theaterName)}</span>
          ${this.getPostureBadge(p.postureLevel)}
        </div>

        <div class="posture-forces">
          ${hasAir ? `<div class="posture-force-row"><span class="posture-domain">AIR</span><div class="posture-stats">${airChips.join('')}</div></div>` : ''}
          ${hasNaval ? `<div class="posture-force-row"><span class="posture-domain">SEA</span><div class="posture-stats">${navalChips.join('')}</div></div>` : ''}
        </div>

        <div class="posture-footer">
          ${p.strikeCapable ? '<span class="posture-strike">⚡ STRIKE</span>' : ''}
          ${this.getTrendIcon(p.trend, p.changePercent)}
          ${p.targetNation ? `<span class="posture-focus">→ ${escapeHtml(p.targetNation)}</span>` : ''}
        </div>
      </div>
    `;
  }

  private render(): void {
    this.stopLoadingTimer();
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
        console.log('[StrategicPosturePanel] Theater clicked:', {
          lat,
          lon,
          dataLat: (el as HTMLElement).dataset.lat,
          dataLon: (el as HTMLElement).dataset.lon,
          element: (el as HTMLElement).textContent?.slice(0, 30),
          hasHandler: !!this.onLocationClick,
        });
        if (this.onLocationClick && !isNaN(lat) && !isNaN(lon)) {
          console.log('[StrategicPosturePanel] Calling onLocationClick with:', lat, lon);
          this.onLocationClick(lat, lon);
        } else {
          console.warn('[StrategicPosturePanel] No handler or invalid coords!', {
            hasHandler: !!this.onLocationClick,
            lat,
            lon,
          });
        }
      });
    });
  }

  public setLocationClickHandler(handler: (lat: number, lon: number) => void): void {
    console.log('[StrategicPosturePanel] setLocationClickHandler called, handler:', typeof handler);
    this.onLocationClick = handler;
    // Verify it's stored
    console.log('[StrategicPosturePanel] Handler stored, onLocationClick now:', typeof this.onLocationClick);
  }

  public destroy(): void {
    if (this.refreshInterval) clearInterval(this.refreshInterval);
    this.stopLoadingTimer();
    this.vesselTimeouts.forEach(t => clearTimeout(t));
    this.vesselTimeouts = [];
    super.destroy();
  }
}
