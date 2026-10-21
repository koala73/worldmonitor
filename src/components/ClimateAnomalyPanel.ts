import { Panel } from './Panel';
import { joinSafeHtml, safeHtml } from '@/utils/sanitize';
import { type ClimateAnomaly, getSeverityIcon, formatDelta } from '@/services/climate';
import { t } from '@/services/i18n';
import { bindActivationKeys } from '@/utils/activation';

export class ClimateAnomalyPanel extends Panel {
  private anomalies: ClimateAnomaly[] = [];
  private hasLoadedAnomalies = false;
  private onZoneClick?: (lat: number, lon: number) => void;

  constructor() {
    super({
      id: 'climate',
      title: t('panels.climate'),
      showCount: true,
      trackActivity: true,
      infoTooltip: t('components.climate.infoTooltip'),
    });
    this.showLoading(t('common.loadingClimateData'));
    // Delegated click on the stable content node: setSafeContent debounces the
    // DOM write by 150ms, so querySelectorAll after render would bind the
    // loading placeholder and miss the flushed rows. bindActivationKeys'
    // synthesized click then reaches this same handler.
    this.content.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement | null)?.closest<HTMLElement>('.climate-row');
      if (!row || !this.content.contains(row)) return;
      const lat = Number(row.dataset.lat);
      const lon = Number(row.dataset.lon);
      if (Number.isFinite(lat) && Number.isFinite(lon)) this.onZoneClick?.(lat, lon);
    });
    bindActivationKeys(this.content, '.climate-row');
  }

  public setZoneClickHandler(handler: (lat: number, lon: number) => void): void {
    this.onZoneClick = handler;
  }

  public setAnomalies(anomalies: ClimateAnomaly[]): void {
    this.anomalies = anomalies;
    this.hasLoadedAnomalies = true;
    this.setCount(anomalies.length);
    this.renderContent();
  }

  public hasData(): boolean {
    return this.hasLoadedAnomalies;
  }

  private renderContent(): void {
    if (this.anomalies.length === 0) {
      this.setSafeContent(safeHtml`<div class="panel-empty">${t('components.climate.noAnomalies')}</div>`);
      return;
    }

    const sorted = [...this.anomalies].sort((a, b) => {
      const severityOrder = { extreme: 0, moderate: 1, normal: 2 };
      return (severityOrder[a.severity] || 2) - (severityOrder[b.severity] || 2);
    });

    const rows = joinSafeHtml(sorted.map(a => {
      const icon = getSeverityIcon(a);
      const tempClass = a.tempDelta > 0 ? 'climate-warm' : 'climate-cold';
      const precipClass = a.precipDelta > 0 ? 'climate-wet' : 'climate-dry';
      const sevClass = `severity-${a.severity}`;
      const rowClass = a.severity === 'extreme' ? ' climate-extreme-row' : '';

      return safeHtml`<tr class="climate-row${rowClass}" data-lat="${a.lat}" data-lon="${a.lon}" tabindex="0">
        <td class="climate-zone"><span class="climate-icon">${icon}</span>${a.zone}</td>
        <td class="climate-num ${tempClass}">${formatDelta(a.tempDelta, '°C')}</td>
        <td class="climate-num ${precipClass}">${formatDelta(a.precipDelta, 'mm')}</td>
        <td><span class="climate-badge ${sevClass}">${t(`components.climate.severity.${a.severity}`)}</span></td>
      </tr>`;
    }));

    this.setSafeContent(safeHtml`
      <div class="climate-panel-content">
        <table class="climate-table">
          <thead>
            <tr>
              <th scope="col">${t('components.climate.zone')}</th>
              <th scope="col">${t('components.climate.temp')}</th>
              <th scope="col">${t('components.climate.precip')}</th>
              <th scope="col">${t('components.climate.severityLabel')}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `);
  }
}
