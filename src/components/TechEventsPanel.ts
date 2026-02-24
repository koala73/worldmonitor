import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { sanitizeUrl } from '@/utils/sanitize';
import { h, replaceChildren } from '@/utils/dom-utils';
import { ResearchServiceClient } from '@/generated/client/worldmonitor/research/v1/service_client';
import type { TechEvent } from '@/generated/client/worldmonitor/research/v1/service_client';

type ViewMode = 'upcoming' | 'conferences' | 'earnings' | 'all';

const researchClient = new ResearchServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });

export class TechEventsPanel extends Panel {
  private viewMode: ViewMode = 'upcoming';
  private events: TechEvent[] = [];
  private loading = true;
  private error: string | null = null;

  constructor(id: string) {
    super({ id, title: t('panels.events'), showCount: true });
    this.element.classList.add('panel-tall');
    void this.fetchEvents();
  }

  private async fetchEvents(): Promise<void> {
    this.loading = true;
    this.error = null;
    this.render();

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const data = await researchClient.listTechEvents({
          type: '',
          mappable: false,
          days: 180,
          limit: 100,
        });
        if (!data.success) throw new Error(data.error || 'Unknown error');

        this.events = data.events;
        this.setCount(data.conferenceCount);
        this.error = null;

        if (this.events.length === 0 && attempt < 2) {
          this.showRetrying();
          await new Promise(r => setTimeout(r, 15_000));
          continue;
        }
        break;
      } catch (err) {
        if (this.isAbortError(err)) return;
        if (attempt < 2) {
          this.showRetrying();
          await new Promise(r => setTimeout(r, 15_000));
          continue;
        }
        this.error = err instanceof Error ? err.message : 'Failed to fetch events';
        console.error('[TechEvents] Fetch error:', err);
      }
    }
    this.loading = false;
    this.render();
  }

  protected render(): void {
    if (this.loading) {
      replaceChildren(this.content,
        h('div', { className: 'tech-events-loading' },
          h('div', { className: 'loading-spinner' }),
          h('span', null, t('components.techEvents.loading')),
        ),
      );
      return;
    }

    if (this.error) {
      replaceChildren(this.content,
        h('div', { className: 'tech-events-error' },
          h('span', { className: 'error-icon' }, '⚠️'),
          h('span', { className: 'error-text' }, this.error),
          h('button', { className: 'retry-btn', onClick: () => this.refresh() }, t('common.retry')),
        ),
      );
      return;
    }

    const filteredEvents = this.getFilteredEvents();
    const upcomingConferences = this.events.filter(e => e.type === 'conference' && new Date(e.startDate) >= new Date());
    const mappableCount = upcomingConferences.filter(e => e.coords && !e.coords.virtual).length;

    const tabEntries: [ViewMode, string][] = [
      ['upcoming', t('components.techEvents.upcoming')],
      ['conferences', t('components.techEvents.conferences')],
      ['earnings', t('components.techEvents.earnings')],
      ['all', t('components.techEvents.all')],
    ];

    replaceChildren(this.content,
      h('div', { className: 'tech-events-panel' },
        h('div', { className: 'tech-events-tabs' },
          ...tabEntries.map(([view, label]) =>
            h('button', {
              className: `tab ${this.viewMode === view ? 'active' : ''}`,
              dataset: { view },
              onClick: () => { this.viewMode = view; this.render(); },
            }, label),
          ),
        ),
        h('div', { className: 'tech-events-stats' },
          h('span', { className: 'stat' }, `📅 ${t('components.techEvents.conferencesCount', { count: String(upcomingConferences.length) })}`),
          h('span', { className: 'stat' }, `📍 ${t('components.techEvents.onMap', { count: String(mappableCount) })}`),
          h('a', { href: 'https://www.techmeme.com/events', target: '_blank', rel: 'noopener', className: 'source-link' }, t('components.techEvents.techmemeEvents')),
        ),
        h('div', { className: 'tech-events-list' },
          ...(filteredEvents.length > 0
            ? filteredEvents.map(e => this.buildEvent(e))
            : [h('div', { className: 'empty-state' }, t('components.techEvents.noEvents'))]),
        ),
      ),
    );
  }

  private getFilteredEvents(): TechEvent[] {
    const now = new Date();
    const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    switch (this.viewMode) {
      case 'upcoming':
        return this.events.filter(e => {
          const start = new Date(e.startDate);
          return start >= now && start <= thirtyDaysFromNow;
        }).slice(0, 20);

      case 'conferences':
        return this.events.filter(e => e.type === 'conference' && new Date(e.startDate) >= now).slice(0, 30);

      case 'earnings':
        return this.events.filter(e => e.type === 'earnings' && new Date(e.startDate) >= now).slice(0, 30);

      case 'all':
        return this.events.filter(e => new Date(e.startDate) >= now).slice(0, 50);

      default:
        return [];
    }
  }

  private buildEvent(event: TechEvent): HTMLElement {
    const startDate = new Date(event.startDate);
    const endDate = new Date(event.endDate);
    const now = new Date();

    const isToday = startDate.toDateString() === now.toDateString();
    const isSoon = !isToday && startDate <= new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
    const isThisWeek = startDate <= new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const dateStr = startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const endDateStr = endDate > startDate && endDate.toDateString() !== startDate.toDateString()
      ? ` - ${endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
      : '';

    const typeIcons: Record<string, string> = {
      conference: '🎤',
      earnings: '📊',
      ipo: '🔔',
      other: '📌',
    };

    const typeClasses: Record<string, string> = {
      conference: 'type-conference',
      earnings: 'type-earnings',
      ipo: 'type-ipo',
      other: 'type-other',
    };

    const className = [
      'tech-event',
      typeClasses[event.type],
      isToday ? 'is-today' : '',
      isSoon ? 'is-soon' : '',
      isThisWeek ? 'is-this-week' : '',
    ].filter(Boolean).join(' ');

    const safeEventUrl = sanitizeUrl(event.url || '');

    return h('div', { className },
      h('div', { className: 'event-date' },
        h('span', { className: 'event-month' }, startDate.toLocaleDateString('en-US', { month: 'short' }).toUpperCase()),
        h('span', { className: 'event-day' }, String(startDate.getDate())),
        isToday ? h('span', { className: 'today-badge' }, t('components.techEvents.today')) : false,
        isSoon ? h('span', { className: 'soon-badge' }, t('components.techEvents.soon')) : false,
      ),
      h('div', { className: 'event-content' },
        h('div', { className: 'event-header' },
          h('span', { className: 'event-icon' }, typeIcons[event.type] ?? '📌'),
          h('span', { className: 'event-title' }, event.title),
          safeEventUrl
            ? h('a', { href: safeEventUrl, target: '_blank', rel: 'noopener', className: 'event-url', title: t('components.techEvents.moreInfo') }, '↗')
            : false,
        ),
        h('div', { className: 'event-meta' },
          h('span', { className: 'event-dates' }, `${dateStr}${endDateStr}`),
          event.location
            ? h('span', { className: 'event-location' }, event.location)
            : false,
          event.coords && !event.coords.virtual
            ? h('button', {
              className: 'event-map-link',
              title: t('components.techEvents.showOnMap'),
              onClick: (e: Event) => {
                e.preventDefault();
                this.panToLocation(event.coords!.lat, event.coords!.lng);
              },
            }, '📍')
            : false,
        ),
      ),
    );
  }

  private panToLocation(lat: number, lng: number): void {
    // Dispatch event for map to handle
    window.dispatchEvent(new CustomEvent('tech-event-location', {
      detail: { lat, lng, zoom: 10 }
    }));
  }

  public refresh(): void {
    void this.fetchEvents();
  }

  public getConferencesForMap(): TechEvent[] {
    return this.events.filter(e =>
      e.type === 'conference' &&
      e.coords &&
      !e.coords.virtual &&
      new Date(e.startDate) >= new Date()
    );
  }
}
