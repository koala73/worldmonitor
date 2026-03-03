import { Panel } from './Panel';
import type { NWSAlert } from '@/services/nws-alerts';
import { nwsSeverityClass } from '@/services/nws-alerts';
import { escapeHtml } from '@/utils/sanitize';

export class NWSAlertsPanel extends Panel {
  private alerts: NWSAlert[] = [];

  constructor() {
    super({
      id: 'nws-alerts',
      title: 'NWS Hazard Alerts',
      showCount: true,
      trackActivity: true,
      infoTooltip: 'Active US weather hazard alerts from NOAA National Weather Service — tornadoes, floods, blizzards, extreme heat, and more.',
    });
    this.showLoading('Fetching NWS alerts...');
  }

  public update(alerts: NWSAlert[]): void {
    this.alerts = alerts;
    this.setCount(alerts.length);
    this.render();
  }

  private render(): void {
    if (this.alerts.length === 0) {
      this.setContent('<div class="panel-empty">No active NWS hazard alerts.</div>');
      return;
    }

    const rows = this.alerts.slice(0, 80).map(a => {
      const rowClass = nwsSeverityClass(a.severity);
      const onset = a.onset ? new Date(a.onset).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
      const area = a.areaDesc.length > 40 ? a.areaDesc.slice(0, 38) + '…' : a.areaDesc;
      return `<tr class="${rowClass}" title="${escapeHtml(a.headline)}">
        <td><span class="sev-badge">${escapeHtml(a.severity)}</span></td>
        <td>${escapeHtml(a.event)}</td>
        <td>${escapeHtml(area)}</td>
        <td>${onset}</td>
      </tr>`;
    }).join('');

    this.setContent(`
      <div class="ct-panel-content">
        <table class="eq-table ct-table">
          <thead>
            <tr>
              <th>Sev</th>
              <th>Event</th>
              <th>Area</th>
              <th>Onset</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="fires-footer">
          <span class="fires-source">NOAA National Weather Service</span>
        </div>
      </div>
    `);
  }
}
