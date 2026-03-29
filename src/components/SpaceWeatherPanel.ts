import { Panel } from './Panel';
import type { SpaceWeatherData } from '@/services/space-weather';
import { escapeHtml } from '@/utils/sanitize';
import { t } from '@/services/i18n';

export class SpaceWeatherPanel extends Panel {
  private data: SpaceWeatherData | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super({
      id: 'space-weather',
      title: t('panels.spaceWeather'),
      showCount: false,
      trackActivity: true,
      infoTooltip: 'NOAA SWPC real-time data — Kp index, solar wind, X-ray flares, geomagnetic storm alerts.',
    });
    this.showLoading('Fetching NOAA space weather...');
  }

  public update(data: SpaceWeatherData): void {
    this.data = data;
    this.render();
  }

  override destroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    super.destroy();
  }

  private render(): void {
    if (!this.data) {
      this.setContent('<div class="panel-empty">Space weather data unavailable.</div>');
      return;
    }

    const d = this.data;
    const kpLabel = kpLabel_(d.kpIndex);
    const kpColor = kpColorClass(d.kpClass);
    const windSpeed = d.solarWindSpeed === null ? '—' : `${Math.round(d.solarWindSpeed)} km/s`;
    const windDensity = d.solarWindDensity === null ? '—' : `${d.solarWindDensity.toFixed(1)} p/cm³`;
    const bzDisplay = d.bz === null ? '—' : `${d.bz > 0 ? '+' : ''}${d.bz.toFixed(1)} nT`;
    const bzClass = d.bz !== null && d.bz < -10 ? 'sw-danger' : (d.bz !== null && d.bz < -5 ? 'sw-warning' : '');
    const xray = d.xrayClass ? escapeHtml(d.xrayClass) : '—';
    const updatedAgo = timeAgo(d.fetchedAt);

    const alertRows = d.alertMessages.slice(0, 8).map(a => {
      const sevClass = a.severity === 'alert' ? 'sw-danger' : (a.severity === 'warning' ? 'sw-warning' : 'sw-info');
      return `<div class="sw-alert-row ${sevClass}">
        <span class="sw-alert-sev">${escapeHtml(a.severity.toUpperCase())}</span>
        <span class="sw-alert-msg">${escapeHtml(a.message)}</span>
        <span class="sw-alert-age">${timeAgo(a.issuedAt)}</span>
      </div>`;
    }).join('');

    this.setContent(`
      <div class="sw-panel-content">
        <div class="sw-grid">
          <div class="sw-metric">
            <div class="sw-metric-label">Kp Index</div>
            <div class="sw-metric-value ${kpColor}">${d.kpIndex === null ? '—' : d.kpIndex.toFixed(1)}</div>
            <div class="sw-metric-sub">${kpLabel}</div>
          </div>
          <div class="sw-metric">
            <div class="sw-metric-label">Solar Wind</div>
            <div class="sw-metric-value">${windSpeed}</div>
            <div class="sw-metric-sub">${windDensity}</div>
          </div>
          <div class="sw-metric">
            <div class="sw-metric-label">Bz (IMF)</div>
            <div class="sw-metric-value ${bzClass}">${bzDisplay}</div>
            <div class="sw-metric-sub">${d.bz !== null && d.bz < 0 ? 'Storm driver' : 'Northward'}</div>
          </div>
          <div class="sw-metric">
            <div class="sw-metric-label">X-Ray</div>
            <div class="sw-metric-value">${xray}</div>
            <div class="sw-metric-sub">Solar flares</div>
          </div>
        </div>
        ${alertRows ? `<div class="sw-alerts">
          <div class="sw-alerts-header">Active Alerts</div>
          ${alertRows}
        </div>` : '<div class="panel-empty" style="padding:8px 0">No active alerts</div>'}
        <div class="fires-footer">
          <span class="fires-source">NOAA SWPC</span>
          <span class="fires-updated">Updated ${updatedAgo}</span>
        </div>
      </div>
    `);
  }
}

function kpLabel_(kp: number | null): string {
  if (kp === null) return 'No data';
  if (kp >= 7) return 'Severe storm';
  if (kp >= 6) return 'Moderate storm';
  if (kp >= 5) return 'Minor storm';
  if (kp >= 4) return 'Active';
  if (kp >= 3) return 'Unsettled';
  return 'Quiet';
}

function kpColorClass(cls: SpaceWeatherData['kpClass']): string {
  if (cls === 'severe_storm' || cls === 'moderate_storm') return 'sw-danger';
  if (cls === 'minor_storm' || cls === 'active') return 'sw-warning';
  return '';
}

function timeAgo(d: Date): string {
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}
