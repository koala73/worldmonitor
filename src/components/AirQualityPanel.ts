import { Panel } from './Panel';
import type { AirQualityReading, AqiLevel } from '@/services/air-quality';
import { escapeHtml } from '@/utils/sanitize';
import { t } from '@/services/i18n';

export class AirQualityPanel extends Panel {
  private readings: AirQualityReading[] = [];
  private lastUpdated: Date | null = null;

  constructor() {
    super({
      id: 'air-quality',
      title: t('panels.airQuality'),
      showCount: false,
      trackActivity: true,
      infoTooltip: 'Global air quality index (US AQI) for 18 major cities. Open-Meteo API — PM2.5, PM10, ozone, NO₂.',
    });
    this.showLoading('Fetching air quality data...');
  }

  public update(readings: AirQualityReading[]): void {
    this.readings = readings;
    this.lastUpdated = new Date();
    this.render();
  }

  private render(): void {
    if (this.readings.length === 0) {
      this.setContent('<div class="panel-empty">Air quality data unavailable.</div>');
      return;
    }

    const rows = this.readings.map(r => {
      const cls = aqiRowClass(r.aqiLevel);
      const pm25 = r.pm25 !== null ? `${r.pm25.toFixed(1)}` : '—';
      return `<tr class="${cls}">
        <td class="aq-city">${escapeHtml(r.city)}</td>
        <td class="aq-country">${escapeHtml(r.country)}</td>
        <td class="aq-aqi ${aqiClass(r.aqiLevel)}">${r.aqi}</td>
        <td class="aq-level">${aqiLabel(r.aqiLevel)}</td>
        <td class="aq-pm25">${pm25}</td>
      </tr>`;
    }).join('');

    const updatedStr = this.lastUpdated ? timeAgo(this.lastUpdated) : 'never';

    this.setContent(`
      <div class="aq-panel-content">
        <table class="eq-table">
          <thead>
            <tr>
              <th>City</th>
              <th>Country</th>
              <th>AQI</th>
              <th>Level</th>
              <th>PM2.5</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="fires-footer">
          <span class="fires-source">Open-Meteo Air Quality · US AQI scale</span>
          <span class="fires-updated">Updated ${updatedStr}</span>
        </div>
      </div>
    `);
  }
}

function aqiRowClass(level: AqiLevel): string {
  if (level === 'hazardous' || level === 'very_unhealthy') return 'eq-row eq-major';
  if (level === 'unhealthy') return 'eq-row eq-strong';
  if (level === 'sensitive') return 'eq-row eq-moderate';
  return 'eq-row';
}

function aqiClass(level: AqiLevel): string {
  if (level === 'hazardous') return 'aq-hazardous';
  if (level === 'very_unhealthy') return 'aq-very-unhealthy';
  if (level === 'unhealthy') return 'aq-unhealthy';
  if (level === 'sensitive') return 'aq-sensitive';
  if (level === 'moderate') return 'aq-moderate';
  return 'aq-good';
}

function aqiLabel(level: AqiLevel): string {
  const labels: Record<AqiLevel, string> = {
    good: 'Good',
    moderate: 'Moderate',
    sensitive: 'Sensitive',
    unhealthy: 'Unhealthy',
    very_unhealthy: 'Very Unhealthy',
    hazardous: 'Hazardous',
  };
  return labels[level];
}

function timeAgo(d: Date): string {
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}
