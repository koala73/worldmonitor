import { Panel } from './Panel';
import type { VolcanoAlert } from '@/services/volcano-alerts';
import { alertLevelClass } from '@/services/volcano-alerts';
import { escapeHtml } from '@/utils/sanitize';

export class VolcanoAlertsPanel extends Panel {
  private alerts: VolcanoAlert[] = [];
  private onEventClick: ((lat: number, lon: number) => void) | null = null;

  constructor() {
    super({
      id: 'volcano-alerts',
      title: 'Volcano Alerts',
      showCount: true,
      trackActivity: true,
      infoTooltip: 'US volcano alert levels from USGS Volcano Hazards Program — Advisory, Watch, and Warning status.',
    });
    this.showLoading('Fetching USGS volcano alerts...');
  }

  public setEventClickHandler(fn: (lat: number, lon: number) => void): void {
    this.onEventClick = fn;
  }

  public update(alerts: VolcanoAlert[]): void {
    this.alerts = alerts;
    this.setCount(alerts.filter(a => a.alertLevel !== 'Normal').length);
    this.render();
  }

  private render(): void {
    if (this.alerts.length === 0) {
      this.setContent('<div class="panel-empty">No volcano alert data available.</div>');
      return;
    }

    const sorted = [...this.alerts].sort((a, b) => {
      const order = { Warning: 3, Watch: 2, Advisory: 1, Normal: 0 };
      return (order[b.alertLevel] ?? 0) - (order[a.alertLevel] ?? 0);
    });

    const rows = sorted.slice(0, 60).map(a => {
      const rowClass = alertLevelClass(a.alertLevel);
      const colorDot = { Red: '🔴', Orange: '🟠', Yellow: '🟡', Green: '🟢' }[a.color] ?? '⚪';
      return `<tr class="${rowClass}" role="button" tabindex="0" data-lat="${a.lat}" data-lon="${a.lon}" style="cursor:pointer">
        <td>${colorDot}</td>
        <td>${escapeHtml(a.alertLevel)}</td>
        <td>${escapeHtml(a.name)}</td>
        <td>${escapeHtml(a.location)}</td>
        <td style="font-size:10px;color:var(--text-dim)">${escapeHtml(a.observatory)}</td>
      </tr>`;
    }).join('');

    const el = this.getContentElement();
    el.innerHTML = `
      <div class="ct-panel-content">
        <table class="eq-table ct-table">
          <thead>
            <tr>
              <th></th>
              <th>Level</th>
              <th>Volcano</th>
              <th>Location</th>
              <th>Observatory</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="fires-footer">
          <span class="fires-source">USGS Volcano Hazards Program</span>
        </div>
      </div>
    `;

    el.addEventListener('click', (e) => {
      const row = (e.target as Element).closest('tr[data-lat]') as HTMLElement | null;
      if (!row) return;
      const lat = Number.parseFloat(row.dataset.lat ?? '0');
      const lon = Number.parseFloat(row.dataset.lon ?? '0');
      if (!isNaN(lat) && !isNaN(lon) && lat !== 0 && this.onEventClick) this.onEventClick(lat, lon);
    });
  }
}
