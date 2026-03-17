import { Panel } from './Panel';
import type { TsunamiAlert } from '@/services/tsunami-alerts';
import { tsunamiSeverityClass } from '@/services/tsunami-alerts';
import { escapeHtml } from '@/utils/sanitize';

export class TsunamiAlertsPanel extends Panel {
  private alerts: TsunamiAlert[] = [];

  constructor() {
    super({
      id: 'tsunami-alerts',
      title: 'Tsunami Alerts',
      showCount: true,
      trackActivity: true,
      infoTooltip: 'Tsunami warnings, watches, and advisories from PTWC (Pacific Tsunami Warning Center).',
    });
    this.showLoading('Fetching tsunami alert data...');
  }

  public update(alerts: TsunamiAlert[]): void {
    this.alerts = alerts;
    this.setCount(alerts.filter(a => a.severity === 'warning' || a.severity === 'watch').length);
    this.render();
  }

  private render(): void {
    if (this.alerts.length === 0) {
      this.setContent('<div class="panel-empty">No active tsunami alerts.</div>');
      return;
    }

    const rows = this.alerts.map(a => {
      const rowClass = tsunamiSeverityClass(a.severity);
      const badge = sevBadge(a.severity);
      const title = a.title.length > 60 ? a.title.slice(0, 57) + '…' : a.title;
      return `<tr class="${rowClass}">
        <td class="ts-sev">${badge}</td>
        <td class="ts-region">${escapeHtml(a.region)}</td>
        <td class="ts-title">${escapeHtml(title)}</td>
        <td class="ts-date">${timeAgo(a.pubDate)}</td>
      </tr>`;
    }).join('');

    this.setContent(`
      <div class="ts-panel-content">
        <table class="eq-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Region</th>
              <th>Alert</th>
              <th>Age</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="fires-footer">
          <span class="fires-source">PTWC · NTWC · ${this.alerts.length} alerts</span>
        </div>
      </div>
    `);
  }
}

function sevBadge(sev: TsunamiAlert['severity']): string {
  const labels: Record<string, string> = {
    warning: 'WARNING',
    watch: 'WATCH',
    advisory: 'ADVISORY',
    information: 'INFO',
    'threat-canceled': 'CANCELED',
  };
  return labels[sev] ?? sev.toUpperCase();
}

function timeAgo(d: Date): string {
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
