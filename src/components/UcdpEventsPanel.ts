import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import type { UcdpGeoEvent, UcdpEventType } from '@/types';
import { t } from '@/services/i18n';

export class UcdpEventsPanel extends Panel {
  private events: UcdpGeoEvent[] = [];
  private activeTab: UcdpEventType = 'state-based';
  private onEventClick?: (lat: number, lon: number) => void;

  constructor() {
    super({
      id: 'ucdp-events',
      title: t('panels.ucdpEvents'),
      showCount: true,
      trackActivity: true,
      infoTooltip: t('components.ucdpEvents.infoTooltip'),
    });
    this.showLoading(t('common.loadingUcdpEvents'));
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
      { key: 'state-based', label: t('components.ucdpEvents.stateBased') },
      { key: 'non-state', label: t('components.ucdpEvents.nonState') },
      { key: 'one-sided', label: t('components.ucdpEvents.oneSided') },
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
      bodyHtml = `<div class="panel-empty">${t('common.noEventsInCategory')}</div>`;
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
              <th>${t('components.ucdpEvents.country')}</th>
              <th>${t('components.ucdpEvents.deaths')}</th>
              <th>${t('components.ucdpEvents.date')}</th>
              <th>${t('components.ucdpEvents.actors')}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
    }

    const moreHtml = filtered.length > 50
      ? `<div class="panel-more">${t('components.ucdpEvents.moreNotShown', { count: filtered.length - 50 })}</div>`
      : '';

    this.setContent(`
      <div class="ucdp-panel-content">
        <div class="ucdp-header">
          <div class="ucdp-tabs">${tabsHtml}</div>
          ${totalDeaths > 0 ? `<span class="ucdp-total-deaths">${t('components.ucdpEvents.deathsCount', { count: totalDeaths.toLocaleString() })}</span>` : ''}
        </div>
        ${bodyHtml}
        ${moreHtml}
      </div>
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
