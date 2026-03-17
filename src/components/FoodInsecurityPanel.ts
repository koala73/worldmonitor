import { Panel } from './Panel';
import type { FoodInsecurityAlert } from '@/services/food-insecurity';
import { foodSeverityClass, ipcPhaseName } from '@/services/food-insecurity';
import { escapeHtml } from '@/utils/sanitize';

export class FoodInsecurityPanel extends Panel {
  private alerts: FoodInsecurityAlert[] = [];

  constructor() {
    super({
      id: 'food-insecurity',
      title: 'Food Insecurity Alerts',
      showCount: true,
      trackActivity: true,
      infoTooltip: 'Famine early warnings from FEWS NET and IPC. Tracks countries at risk of food insecurity crises.',
    });
    this.showLoading('Fetching food insecurity data...');
  }

  public update(alerts: FoodInsecurityAlert[]): void {
    this.alerts = alerts;
    this.setCount(alerts.filter(a => a.severity === 'critical' || a.severity === 'high').length);
    this.render();
  }

  private render(): void {
    if (this.alerts.length === 0) {
      this.setContent('<div class="panel-empty">No food insecurity alerts available.</div>');
      return;
    }

    const rows = this.alerts.slice(0, 60).map(a => {
      const rowClass = foodSeverityClass(a.severity);
      const sevBadge = sevLabel(a.severity);
      const ipcCell = a.ipcPhase !== null
        ? `Phase ${a.ipcPhase} — ${escapeHtml(ipcPhaseName(a.ipcPhase))}`
        : '—';
      const popCell = a.populationAffected !== null
        ? formatPop(a.populationAffected)
        : '—';
      return `<tr class="${rowClass}">
        <td class="fi-sev">${sevBadge}</td>
        <td class="fi-country">${escapeHtml(a.country)}</td>
        <td class="fi-ipc">${ipcCell}</td>
        <td class="fi-pop">${popCell}</td>
        <td class="fi-source">${escapeHtml(a.source)}</td>
        <td class="fi-date">${timeAgo(a.pubDate)}</td>
      </tr>`;
    }).join('');

    this.setContent(`
      <div class="fi-panel-content">
        <table class="eq-table">
          <thead>
            <tr>
              <th>Sev</th>
              <th>Country</th>
              <th>IPC Phase</th>
              <th>Population</th>
              <th>Source</th>
              <th>Age</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="fires-footer">
          <span class="fires-source">FEWS NET · IPC · ${this.alerts.length} alerts</span>
        </div>
      </div>
    `);
  }
}

function sevLabel(sev: FoodInsecurityAlert['severity']): string {
  const labels: Record<string, string> = { critical: 'CRIT', high: 'HIGH', medium: 'MED', low: 'LOW' };
  return labels[sev] ?? sev;
}

function formatPop(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
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
