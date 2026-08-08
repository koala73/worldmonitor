import { Panel } from './Panel';
import { escapeHtml, unsafeRawHtml } from '@/utils/sanitize';
import type { UcdpGeoEvent, UcdpEventType } from '@/types';
import { t } from '@/services/i18n';
import type { UcdpTabAggregate } from '@/services/conflict';

// The panel's tabs are the three UCDP violence types. The projection keys its
// aggregates by the proto enum, so map between them in exactly one place.
const UCDP_EVENT_TYPES: UcdpEventType[] = ['state-based', 'non-state', 'one-sided'];
const PROTO_VIOLENCE_TYPE: Record<UcdpEventType, string> = {
  'state-based': 'UCDP_VIOLENCE_TYPE_STATE_BASED',
  'non-state': 'UCDP_VIOLENCE_TYPE_NON_STATE',
  'one-sided': 'UCDP_VIOLENCE_TYPE_ONE_SIDED',
};

function totalFromAggregates(aggregates: Record<string, UcdpTabAggregate>): number {
  return UCDP_EVENT_TYPES.reduce((sum, type) => sum + (aggregates[PROTO_VIOLENCE_TYPE[type]]?.count ?? 0), 0);
}

export class UcdpEventsPanel extends Panel {
  private events: UcdpGeoEvent[] = [];
  private aggregates?: Record<string, UcdpTabAggregate>;
  private hasLoadedEvents = false;
  private activeTab: UcdpEventType = 'state-based';
  private onEventClick?: (lat: number, lon: number) => void;

  constructor() {
    super({
      id: 'ucdp-events',
      title: t('panels.ucdpEvents'),
      showCount: true,
      trackActivity: true,
      infoTooltip: t('components.ucdpEvents.infoTooltip'),
      defaultRowSpan: 2,
    });
    this.showLoading(t('common.loadingUcdpEvents'));

    this.content.addEventListener('click', (e) => {
      const tab = (e.target as HTMLElement).closest<HTMLElement>('.panel-tab');
      if (tab?.dataset.tab) {
        this.activeTab = tab.dataset.tab as UcdpEventType;
        this.renderContent();
        return;
      }
      const row = (e.target as HTMLElement).closest<HTMLElement>('.ucdp-row');
      if (row) {
        const lat = Number(row.dataset.lat);
        const lon = Number(row.dataset.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) this.onEventClick?.(lat, lon);
      }
    });
  }

  public setEventClickHandler(handler: (lat: number, lon: number) => void): void {
    this.onEventClick = handler;
  }

  /**
   * `aggregates` carries per-tab counts and death totals computed over the FULL
   * event set. The bootstrap payload is a projection (#5300) — `events` holds only
   * the rows this panel renders — so deriving those numbers from `events` would
   * silently under-report them. When the caller has the full set (the RPC path, or
   * the map layer being on) it passes no aggregates and we compute as before.
   */
  public setEvents(events: UcdpGeoEvent[], aggregates?: Record<string, UcdpTabAggregate>): void {
    this.events = events;
    this.aggregates = aggregates;
    this.hasLoadedEvents = true;
    this.setCount(aggregates ? totalFromAggregates(aggregates) : events.length);
    this.renderContent();
  }

  public hasData(): boolean {
    return this.hasLoadedEvents;
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
    if (this.aggregates) {
      for (const type of UCDP_EVENT_TYPES) {
        tabCounts[type] = this.aggregates[PROTO_VIOLENCE_TYPE[type]]?.count ?? 0;
      }
    } else {
      for (const event of this.events) {
        tabCounts[event.type_of_violence] += 1;
      }
    }

    const totalDeaths = this.aggregates
      ? (this.aggregates[PROTO_VIOLENCE_TYPE[this.activeTab]]?.totalDeaths ?? 0)
      : filtered.reduce((sum, e) => sum + e.deaths_best, 0);

    const tabsHtml = tabs.map(t =>
      `<button class="panel-tab ${t.key === this.activeTab ? 'active' : ''}" data-tab="${t.key}">${t.label} <span class="ucdp-tab-count">${tabCounts[t.key]}</span></button>`
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

    this.setSafeContent(unsafeRawHtml(`
      <div class="ucdp-panel-content">
        <div class="ucdp-header">
          <div class="panel-tabs">${tabsHtml}</div>
          ${totalDeaths > 0 ? `<span class="ucdp-total-deaths">${t('components.ucdpEvents.deathsCount', { count: totalDeaths.toLocaleString() })}</span>` : ''}
        </div>
        ${bodyHtml}
        ${moreHtml}
      </div>
    `, 'legacy Panel.setContent() migration'));
  }
}
