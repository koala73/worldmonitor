import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import type { UcdpGeoEvent, UcdpEventType } from '@/types';

export class UcdpEventsPanel extends Panel {
  private events: UcdpGeoEvent[] = [];
  private activeTab: UcdpEventType = 'state-based';
  private onEventClick?: (lat: number, lon: number) => void;

  constructor() {
    super({
      id: 'ucdp-events',
      title: 'UCDP Conflict Events',
      showCount: true,
      trackActivity: true,
      infoTooltip: `<strong>UCDP Georeferenced Events</strong>
        Event-level conflict data from Uppsala University.
        <ul>
          <li><strong>State-Based</strong>: Government vs rebel group</li>
          <li><strong>Non-State</strong>: Armed group vs armed group</li>
          <li><strong>One-Sided</strong>: Violence against civilians</li>
        </ul>
        Deaths shown as best estimate (low-high range).
        ACLED duplicates are filtered out automatically.`,
    });
    this.showLoading('Loading UCDP events');
  }

  public setEventClickHandler(handler: (lat: number, lon: number) => void): void {
    this.onEventClick = handler;
  }

  public setEvents(events: UcdpGeoEvent[]): void {
    this.events = events;
    this.setCount(events.length);
    this.renderContent();
  }

  public getEvents(): UcdpGeoEvent[] {
    return this.events;
  }

  private renderContent(): void {
    const filtered = this.events.filter(e => e.type_of_violence === this.activeTab);
    const tabs: { key: UcdpEventType; label: string }[] = [
      { key: 'state-based', label: 'State-Based' },
      { key: 'non-state', label: 'Non-State' },
      { key: 'one-sided', label: 'One-Sided' },
    ];

    const tabCounts: Record<UcdpEventType, number> = {
      'state-based': 0,
      'non-state': 0,
      'one-sided': 0,
    };
    for (const event of this.events) {
      tabCounts[event.type_of_violence] += 1;
    }

    const totalDeaths = filtered.reduce((sum, e) => sum + e.deaths_best, 0);

    const tabsHtml = tabs.map(t =>
      `<button class="ucdp-tab ${t.key === this.activeTab ? 'ucdp-tab-active' : ''}" data-tab="${t.key}">${t.label} <span class="ucdp-tab-count">${tabCounts[t.key]}</span></button>`
    ).join('');

    const displayed = filtered.slice(0, 50);
    let bodyHtml: string;

    if (displayed.length === 0) {
      bodyHtml = '<div class="panel-empty">No events in this category</div>';
    } else {
      const rows = displayed.map(e => {
        const deathsClass = e.type_of_violence === 'state-based' ? 'ucdp-deaths-state'
          : e.type_of_violence === 'non-state' ? 'ucdp-deaths-nonstate'
          : 'ucdp-deaths-onesided';
        const deathsHtml = e.deaths_best > 0
          ? `<span class="${deathsClass}">${e.deaths_best}</span> <small class="ucdp-range">(${e.deaths_low}-${e.deaths_high})</small>`
          : '<span class="ucdp-deaths-zero">0</span>';
        const actors = `${escapeHtml(e.side_a)} vs ${escapeHtml(e.side_b)}`;

        return `<tr class="ucdp-row" data-lat="${e.latitude}" data-lon="${e.longitude}">
          <td class="ucdp-country">${escapeHtml(e.country)}</td>
          <td class="ucdp-deaths">${deathsHtml}</td>
          <td class="ucdp-date">${e.date_start}</td>
          <td class="ucdp-actors">${actors}</td>
        </tr>`;
      }).join('');

      bodyHtml = `
        <table class="ucdp-table">
          <thead>
            <tr>
              <th>Country</th>
              <th>Deaths</th>
              <th>Date</th>
              <th>Actors</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
    }

    const moreHtml = filtered.length > 50
      ? `<div class="panel-more">${filtered.length - 50} more events not shown</div>`
      : '';

    this.setContent(`
      <div class="ucdp-panel-content">
        <div class="ucdp-header">
          <div class="ucdp-tabs">${tabsHtml}</div>
          ${totalDeaths > 0 ? `<span class="ucdp-total-deaths">${totalDeaths.toLocaleString()} deaths</span>` : ''}
        </div>
        ${bodyHtml}
        ${moreHtml}
      </div>
      <style>
        .ucdp-panel-content { font-size: 12px; }
        .ucdp-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; flex-wrap: wrap; gap: 4px; }
        .ucdp-tabs { display: flex; gap: 2px; }
        .ucdp-tab { background: transparent; border: 1px solid var(--border-strong); color: var(--text-dim); padding: 4px 10px; font-size: 11px; cursor: pointer; border-radius: 3px; transition: all 0.15s; }
        .ucdp-tab:hover { border-color: var(--text-faint); color: var(--text-secondary); }
        .ucdp-tab-active { background: color-mix(in srgb, var(--threat-critical) 10%, transparent); border-color: var(--threat-critical); color: var(--threat-critical); }
        .ucdp-tab-count { font-variant-numeric: tabular-nums; opacity: 0.7; margin-left: 2px; }
        .ucdp-total-deaths { color: var(--threat-critical); font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
        .ucdp-table { width: 100%; border-collapse: collapse; }
        .ucdp-table th { text-align: left; color: var(--text-muted); font-weight: 600; font-size: 10px; text-transform: uppercase; padding: 4px 8px; border-bottom: 1px solid var(--border); }
        .ucdp-table th:nth-child(2) { text-align: right; }
        .ucdp-table td { padding: 5px 8px; border-bottom: 1px solid var(--border-subtle); color: var(--text-secondary); }
        .ucdp-row { cursor: pointer; }
        .ucdp-row:hover { background: var(--surface-hover); }
        .ucdp-date { color: var(--text-muted); white-space: nowrap; }
        .ucdp-deaths { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
        .ucdp-deaths-state { color: var(--semantic-critical); font-weight: 600; }
        .ucdp-deaths-nonstate { color: var(--semantic-high); font-weight: 600; }
        .ucdp-deaths-onesided { color: var(--semantic-elevated); font-weight: 600; }
        .ucdp-deaths-zero { color: var(--text-faint); }
        .ucdp-range { color: var(--text-faint); font-size: 10px; }
        .ucdp-actors { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-dim); font-size: 11px; }
        .ucdp-country { white-space: nowrap; }
      </style>
    `);

    this.content.querySelectorAll('.ucdp-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        this.activeTab = (btn as HTMLElement).dataset.tab as UcdpEventType;
        this.renderContent();
      });
    });

    this.content.querySelectorAll('.ucdp-row').forEach(el => {
      el.addEventListener('click', () => {
        const lat = Number((el as HTMLElement).dataset.lat);
        const lon = Number((el as HTMLElement).dataset.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) this.onEventClick?.(lat, lon);
      });
    });
  }
}
