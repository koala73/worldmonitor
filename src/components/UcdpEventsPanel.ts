import { Panel } from './Panel';
import { WindowedList } from './VirtualList';
import { escapeHtml } from '@/utils/sanitize';
import type { UcdpGeoEvent, UcdpEventType } from '@/types';
import { t } from '@/services/i18n';

const VIRTUAL_SCROLL_THRESHOLD = 20;

export class UcdpEventsPanel extends Panel {
  private events: UcdpGeoEvent[] = [];
  private visibleEvents: UcdpGeoEvent[] = [];
  private activeTab: UcdpEventType = 'state-based';
  private windowedList: WindowedList<UcdpGeoEvent> | null = null;
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
    this.visibleEvents = filtered;
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

    const useVirtualScroll = filtered.length > VIRTUAL_SCROLL_THRESHOLD;
    const displayed = useVirtualScroll ? filtered : filtered.slice(0, 50);
    let bodyHtml: string;

    if (displayed.length === 0) {
      bodyHtml = `<div class="panel-empty">${t('common.noEventsInCategory')}</div>`;
    } else {
      const rows = displayed.map((e, index) => {
        const deathsClass = e.type_of_violence === 'state-based' ? 'ucdp-deaths-state'
          : e.type_of_violence === 'non-state' ? 'ucdp-deaths-nonstate'
            : 'ucdp-deaths-onesided';
        const deathsHtml = e.deaths_best > 0
          ? `<span class="${deathsClass}">${e.deaths_best}</span> <small class="ucdp-range">(${e.deaths_low}-${e.deaths_high})</small>`
          : '<span class="ucdp-deaths-zero">0</span>';
        const actors = `${escapeHtml(e.side_a)} vs ${escapeHtml(e.side_b)}`;

        return `<div class="ucdp-row" data-index="${index}">
          <div class="ucdp-country">${escapeHtml(e.country)}</div>
          <div class="ucdp-deaths">${deathsHtml}</div>
          <div class="ucdp-date">${e.date_start}</div>
          <div class="ucdp-actors">${actors}</div>
        </div>`;
      }).join('');

      bodyHtml = `
        <div class="ucdp-table-head">
          <span>${t('components.ucdpEvents.country')}</span>
          <span>${t('components.ucdpEvents.deaths')}</span>
          <span>${t('components.ucdpEvents.date')}</span>
          <span>${t('components.ucdpEvents.actors')}</span>
        </div>
        ${useVirtualScroll
          ? `<div class="ucdp-list ucdp-virtual-list"></div>`
          : `<div class="ucdp-list">${rows}</div>`}`;
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
      <style>
        .ucdp-panel-content { font-size: 12px; }
        .ucdp-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; flex-wrap: wrap; gap: 4px; }
        .ucdp-tabs { display: flex; gap: 2px; }
        .ucdp-tab { background: transparent; border: 1px solid var(--border-strong); color: var(--text-dim); padding: 4px 10px; font-size: 11px; cursor: pointer; border-radius: 3px; transition: all 0.15s; }
        .ucdp-tab:hover { border-color: var(--text-faint); color: var(--text-secondary); }
        .ucdp-tab-active { background: color-mix(in srgb, var(--threat-critical) 10%, transparent); border-color: var(--threat-critical); color: var(--threat-critical); }
        .ucdp-tab-count { font-variant-numeric: tabular-nums; opacity: 0.7; margin-left: 2px; }
        .ucdp-total-deaths { color: var(--threat-critical); font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
        .ucdp-table-head,
        .ucdp-row { display: grid; grid-template-columns: 90px 86px 76px minmax(0, 1fr); gap: 8px; align-items: center; }
        .ucdp-table-head { color: var(--text-muted); font-weight: 600; font-size: 10px; text-transform: uppercase; padding: 4px 8px; border-bottom: 1px solid var(--border); }
        .ucdp-table-head span:nth-child(2) { text-align: right; }
        .ucdp-list { max-height: 280px; overflow-y: auto; }
        .ucdp-row { padding: 5px 8px; border-bottom: 1px solid var(--border-subtle); color: var(--text-secondary); }
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

    if (useVirtualScroll && displayed.length > 0) {
      const listContainer = this.content.querySelector('.ucdp-virtual-list') as HTMLElement | null;
      if (listContainer) {
        this.windowedList?.destroy();
        this.windowedList = new WindowedList<UcdpGeoEvent>(
          {
            container: listContainer,
            chunkSize: 10,
            bufferChunks: 1,
          },
          (event, index) => this.renderEventRow(event, index)
        );
        this.windowedList.setItems(displayed);
      }
    } else {
      this.windowedList?.destroy();
      this.windowedList = null;
    }

    this.content.querySelectorAll('.ucdp-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        this.activeTab = (btn as HTMLElement).dataset.tab as UcdpEventType;
        this.renderContent();
      });
    });

    this.content.querySelectorAll('.ucdp-row').forEach(el => {
      el.addEventListener('click', () => {
        const index = Number((el as HTMLElement).dataset.index);
        const event = this.visibleEvents[index];
        if (event) this.onEventClick?.(event.latitude, event.longitude);
      });
    });
  }

  private renderEventRow(event: UcdpGeoEvent, index: number): string {
    const deathsClass = event.type_of_violence === 'state-based' ? 'ucdp-deaths-state'
      : event.type_of_violence === 'non-state' ? 'ucdp-deaths-nonstate'
        : 'ucdp-deaths-onesided';
    const deathsHtml = event.deaths_best > 0
      ? `<span class="${deathsClass}">${event.deaths_best}</span> <small class="ucdp-range">(${event.deaths_low}-${event.deaths_high})</small>`
      : '<span class="ucdp-deaths-zero">0</span>';
    const actors = `${escapeHtml(event.side_a)} vs ${escapeHtml(event.side_b)}`;

    return `<div class="ucdp-row" data-index="${index}">
      <div class="ucdp-country">${escapeHtml(event.country)}</div>
      <div class="ucdp-deaths">${deathsHtml}</div>
      <div class="ucdp-date">${event.date_start}</div>
      <div class="ucdp-actors">${actors}</div>
    </div>`;
  }

  public destroy(): void {
    this.windowedList?.destroy();
    this.windowedList = null;
    super.destroy();
  }
}
