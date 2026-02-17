import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import type { ClimateAnomaly } from '@/types';
import { getSeverityIcon, formatDelta } from '@/services/climate';
import { t } from '@/services/i18n';

export class ClimateAnomalyPanel extends Panel {
  private anomalies: ClimateAnomaly[] = [];
  private onZoneClick?: (lat: number, lon: number) => void;

  constructor() {
    super({
      id: 'climate',
      title: t('panels.climate'),
      showCount: true,
      trackActivity: true,
      infoTooltip: `<strong>Climate Anomaly Monitor</strong>
        Temperature and precipitation deviations from 30-day baseline.
        Data from Open-Meteo (ERA5 reanalysis).
        <ul>
          <li><strong>Extreme</strong>: >5°C or >80mm/day deviation</li>
          <li><strong>Moderate</strong>: >3°C or >40mm/day deviation</li>
        </ul>
        Monitors 15 conflict/disaster-prone zones.`,
    });
    this.showLoading(t('common.loadingClimateData'));
  }

  public setZoneClickHandler(handler: (lat: number, lon: number) => void): void {
    this.onZoneClick = handler;
  }

  public setAnomalies(anomalies: ClimateAnomaly[]): void {
    this.anomalies = anomalies;
    this.setCount(anomalies.length);
    this.renderContent();
  }

  private renderContent(): void {
    if (this.anomalies.length === 0) {
      this.setContent(`<div class="panel-empty">${t('components.climate.noAnomalies')}</div>`);
      return;
    }

    const sorted = [...this.anomalies].sort((a, b) => {
      const severityOrder = { extreme: 0, moderate: 1, normal: 2 };
      return (severityOrder[a.severity] || 2) - (severityOrder[b.severity] || 2);
    });

    const rows = sorted.map(a => {
      const icon = getSeverityIcon(a);
      const tempClass = a.tempDelta > 0 ? 'climate-warm' : 'climate-cold';
      const precipClass = a.precipDelta > 0 ? 'climate-wet' : 'climate-dry';
      const sevClass = `severity-${a.severity}`;
      const rowClass = a.severity === 'extreme' ? ' climate-extreme-row' : '';

      return `<tr class="climate-row${rowClass}" data-lat="${a.lat}" data-lon="${a.lon}">
        <td class="climate-zone"><span class="climate-icon">${icon}</span>${escapeHtml(a.zone)}</td>
        <td class="climate-num ${tempClass}">${formatDelta(a.tempDelta, '°C')}</td>
        <td class="climate-num ${precipClass}">${formatDelta(a.precipDelta, 'mm')}</td>
        <td><span class="climate-badge ${sevClass}">${t(`components.climate.severity.${a.severity}`)}</span></td>
      </tr>`;
    }).join('');

    this.setContent(`
      <div class="climate-panel-content">
        <table class="climate-table">
          <thead>
            <tr>
              <th>${t('components.climate.zone')}</th>
              <th>${t('components.climate.temp')}</th>
              <th>${t('components.climate.precip')}</th>
              <th>${t('components.climate.severityLabel')}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <style>
        .climate-panel-content { font-size: 12px; }
        .climate-table { width: 100%; border-collapse: collapse; }
        .climate-table th { text-align: left; color: var(--text-muted); font-weight: 600; font-size: 10px; text-transform: uppercase; padding: 4px 8px; border-bottom: 1px solid var(--border); }
        .climate-table th:nth-child(2), .climate-table th:nth-child(3) { text-align: right; }
        .climate-table td { padding: 5px 8px; border-bottom: 1px solid var(--border-subtle); color: var(--text-secondary); }
        .climate-row { cursor: pointer; }
        .climate-row:hover { background: var(--surface-hover); }
        .climate-extreme-row { background: color-mix(in srgb, var(--semantic-critical) 5%, transparent); }
        .climate-extreme-row:hover { background: color-mix(in srgb, var(--semantic-critical) 10%, transparent); }
        .climate-zone { white-space: nowrap; }
        .climate-icon { margin-right: 6px; }
        .climate-num { text-align: right; font-variant-numeric: tabular-nums; }
        .climate-warm { color: var(--semantic-high); }
        .climate-cold { color: var(--semantic-low); }
        .climate-wet { color: var(--semantic-low); }
        .climate-dry { color: var(--threat-high); }
        .climate-badge { font-size: 9px; font-weight: 700; padding: 2px 6px; border-radius: 3px; letter-spacing: 0.5px; }
        .severity-extreme { background: color-mix(in srgb, var(--semantic-critical) 20%, transparent); color: var(--semantic-critical); }
        .severity-moderate { background: color-mix(in srgb, var(--semantic-high) 15%, transparent); color: var(--semantic-high); }
        .severity-normal { background: var(--overlay-medium); color: var(--text-dim); }
      </style>
    `);

    this.content.querySelectorAll('.climate-row').forEach(el => {
      el.addEventListener('click', () => {
        const lat = Number((el as HTMLElement).dataset.lat);
        const lon = Number((el as HTMLElement).dataset.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) this.onZoneClick?.(lat, lon);
      });
    });
  }
}
