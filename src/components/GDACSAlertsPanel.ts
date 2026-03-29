import { Panel } from './Panel';
import type { GDACSEvent } from '@/services/gdacs';
import { getEventTypeIcon } from '@/services/gdacs';
import { escapeHtml } from '@/utils/sanitize';

export class GDACSAlertsPanel extends Panel {
  private events: GDACSEvent[] = [];
  private onEventClick: ((lat: number, lon: number) => void) | null = null;

  constructor() {
    super({
      id: 'gdacs-alerts',
      title: 'GDACS Disaster Alerts',
      showCount: true,
      trackActivity: true,
      infoTooltip: 'Active global disaster alerts from GDACS (Global Disaster Alert and Coordination System) — earthquakes, floods, tropical cyclones, volcanoes.',
    });
    this.showLoading('Fetching GDACS alerts...');
  }

  public setEventClickHandler(fn: (lat: number, lon: number) => void): void {
    this.onEventClick = fn;
  }

  public update(events: GDACSEvent[]): void {
    this.events = events;
    this.setCount(events.length);
    this.render();
  }

  private render(): void {
    if (this.events.length === 0) {
      this.setContent('<div class="panel-empty">No active GDACS disaster alerts above Green level.</div>');
      return;
    }

    const rows = this.events.slice(0, 80).map(e => {
      const [lng, lat] = e.coordinates;
      const icon = getEventTypeIcon(e.eventType);
      const levelClass = e.alertLevel === 'Red' ? 'eq-row eq-major' : (e.alertLevel === 'Orange' ? 'eq-row eq-strong' : 'eq-row eq-moderate');
      const date = e.fromDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return `<tr class="${levelClass}" role="button" tabindex="0" data-lat="${lat}" data-lon="${lng}" style="cursor:pointer">
        <td>${icon}</td>
        <td>${e.alertLevel}</td>
        <td>${escapeHtml(e.country)}</td>
        <td>${escapeHtml(e.name.length > 35 ? e.name.slice(0, 33) + '…' : e.name)}</td>
        <td>${escapeHtml(e.severity || '—')}</td>
        <td>${date}</td>
      </tr>`;
    }).join('');

    const el = this.getContentElement();
    el.innerHTML = `
      <div class="ct-panel-content">
        <table class="eq-table ct-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Level</th>
              <th>Country</th>
              <th>Event</th>
              <th>Severity</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="fires-footer">
          <span class="fires-source">GDACS Global Disaster Coordination</span>
        </div>
      </div>
    `;

    el.addEventListener('click', (e) => {
      const row = (e.target as Element).closest('tr[data-lat]') as HTMLElement | null;
      if (!row) return;
      const lat = Number.parseFloat(row.dataset.lat ?? '0');
      const lon = Number.parseFloat(row.dataset.lon ?? '0');
      if (!isNaN(lat) && !isNaN(lon) && this.onEventClick) this.onEventClick(lat, lon);
    });
  }
}
