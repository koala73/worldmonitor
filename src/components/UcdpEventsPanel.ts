import { Panel } from './Panel';
import { escapeHtml, unsafeRawHtml } from '@/utils/sanitize';
import type { UcdpGeoEvent, UcdpEventType } from '@/types';
import { t } from '@/services/i18n';
import { currentUcdpCountryName, fetchUcdpEvents, type UcdpTabAggregate } from '@/services/conflict';
import { bindActivationKeys } from '@/utils/activation';
import type { ResolvedScope } from '@/services/tab-focus';
import { countryCodeFromName } from '@/services/scope-attribution';
import { PanelScopeFilter, focusedEmptyHtml, scopeTagHtml, type ScopeRow } from './panel-scope-filter';

/** Loads the full UCDP event set (the RPC, not the bootstrap projection); null on failure. */
export type UcdpFullSetLoader = () => Promise<UcdpGeoEvent[] | null>;

const loadFullUcdpSet: UcdpFullSetLoader = async () => {
  const result = await fetchUcdpEvents();
  return result.success ? result.data : null;
};

const ucdpEventCountry = (event: UcdpGeoEvent): string | null => countryCodeFromName(event.country);

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
  // Dashboard focus (#10453). The bootstrap payload is a 150-row projection
  // (#5300): filtering it would call a country quiet when its events simply
  // were not in the slice. Under a focus the panel loads the full set once
  // and filters that in memory; later focus changes reuse it.
  private readonly scopeFilter: PanelScopeFilter;
  private readonly loadFullSet: UcdpFullSetLoader;
  private fullEvents: UcdpGeoEvent[] | null = null;
  private fullSetState: 'idle' | 'loading' | 'failed' = 'idle';
  /** Identifies the full-set request whose result may still be applied. */
  private fullSetRequest = 0;

  constructor(options: { loadFullSet?: UcdpFullSetLoader } = {}) {
    super({
      id: 'ucdp-events',
      title: t('panels.ucdpEvents'),
      showCount: true,
      trackActivity: true,
      infoTooltip: t('components.ucdpEvents.infoTooltip'),
      defaultRowSpan: 2,
    });
    this.loadFullSet = options.loadFullSet ?? loadFullUcdpSet;
    this.scopeFilter = new PanelScopeFilter({ content: this.content, onChange: () => this.renderContent() });
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
    bindActivationKeys(this.content, '.ucdp-row');
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
    // A full set supersedes any earlier upgrade; a projection keeps it.
    if (!aggregates) {
      this.fullEvents = null;
      this.fullSetState = 'idle';
      this.fullSetRequest++; // an upgrade still in flight is now stale
    }
    this.ensureFullSetForScope();
    this.renderContent();
  }

  public override applyScope(scope: ResolvedScope | null): void {
    if (!this.scopeFilter.setScope(scope)) return;
    // A failed full-set load is retried on the next focus change.
    if (this.fullSetState === 'failed') this.fullSetState = 'idle';
    this.ensureFullSetForScope();
    if (this.hasLoadedEvents && !this.showingLoadFailure) this.renderContent();
  }

  public override showError(message?: string, onRetry?: () => void, autoRetrySeconds?: number): void {
    this.scopeFilter.hideStrip();
    super.showError(message, onRetry, autoRetrySeconds);
  }

  public override showLoading(message?: string): void {
    this.scopeFilter?.hideStrip();
    super.showLoading(message);
  }

  /** True while `events` is the bootstrap projection rather than the full set. */
  private get holdsProjection(): boolean {
    return this.aggregates !== undefined;
  }

  private ensureFullSetForScope(): void {
    if (!this.scopeFilter.scope || !this.hasLoadedEvents || !this.holdsProjection) return;
    if (this.fullEvents || this.fullSetState !== 'idle') return;
    this.fullSetState = 'loading';
    const request = ++this.fullSetRequest;
    this.loadFullSet().then(
      (events) => {
        if (request !== this.fullSetRequest) return; // a newer result superseded this request
        if (events && events.length > 0) {
          this.fullEvents = events;
          this.fullSetState = 'idle';
        } else {
          this.fullSetState = 'failed';
        }
        if (!this.showingLoadFailure) this.renderContent();
      },
      () => {
        if (request !== this.fullSetRequest) return;
        this.fullSetState = 'failed';
        if (!this.showingLoadFailure) this.renderContent();
      },
    );
  }

  public hasData(): boolean {
    return this.hasLoadedEvents;
  }

  private renderContent(): void {
    if (!this.scopeFilter.scope) {
      this.scopeFilter.hideStrip();
      this.setCount(this.aggregates ? totalFromAggregates(this.aggregates) : this.events.length);
      this.renderEvents(this.events, this.aggregates, null);
      return;
    }
    const source = this.fullEvents ?? this.events;
    const view = this.scopeFilter.view(source, ucdpEventCountry);
    if (!view.partition) {
      // "Show all": the whole set, with its own counts.
      this.scopeFilter.renderStrip(view);
      const aggregates = this.fullEvents ? undefined : this.aggregates;
      this.setCount(aggregates ? totalFromAggregates(aggregates) : source.length);
      this.renderEvents(source, aggregates, null);
      return;
    }
    const partial = this.holdsProjection && !this.fullEvents;
    if (view.emptyByFocus && partial && this.fullSetState === 'loading') {
      this.showLoading(t('focus.filter.loadingConflict'));
      return;
    }
    // A partial list (full set missing) must say so even when rows are shown:
    // the counts would describe the 150-row projection, not the focus.
    this.scopeFilter.renderStrip(view, undefined, partial && this.fullSetState !== 'idle'
      ? t(this.fullSetState === 'loading' ? 'focus.filter.partialConflictLoading' : 'focus.filter.partialConflict')
      : undefined);
    const scoped = view.rows.map((row) => row.item);
    this.setCount(scoped.length);
    if (view.emptyByFocus) {
      const message = partial ? t('focus.filter.emptyConflictPartial') : t('focus.filter.emptyConflict');
      this.setSafeContent(unsafeRawHtml(focusedEmptyHtml(message), 'focus empty state: escaped by focusedEmptyHtml'));
      return;
    }
    // Tab counts and deaths describe the focused events, not the world.
    this.renderEvents(scoped, undefined, new Map(view.rows.map((row) => [row.item, row])));
  }

  private renderEvents(
    events: UcdpGeoEvent[],
    aggregates: Record<string, UcdpTabAggregate> | undefined,
    rowFor: Map<UcdpGeoEvent, ScopeRow<UcdpGeoEvent>> | null,
  ): void {
    const filtered = events.filter(e => e.type_of_violence === this.activeTab);
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
    if (aggregates) {
      for (const type of UCDP_EVENT_TYPES) {
        tabCounts[type] = aggregates[PROTO_VIOLENCE_TYPE[type]]?.count ?? 0;
      }
    } else {
      for (const event of events) {
        tabCounts[event.type_of_violence] += 1;
      }
    }

    const totalDeaths = aggregates
      ? (aggregates[PROTO_VIOLENCE_TYPE[this.activeTab]]?.totalDeaths ?? 0)
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

        return `<tr class="ucdp-row" data-lat="${e.latitude}" data-lon="${e.longitude}" tabindex="0">
          <td class="ucdp-country">${escapeHtml(currentUcdpCountryName(e.country))}${scopeTagHtml(rowFor?.get(e))}</td>
          <td class="ucdp-deaths">${deathsHtml}</td>
          <td class="ucdp-date">${e.date_start}</td>
          <td class="ucdp-actors">${actors}</td>
        </tr>`;
      }).join('');

      bodyHtml = `
        <div class="table-scroll" role="group" tabindex="0" aria-labelledby="${this.panelId}Title">
          <table class="wm-table ucdp-table">
            <thead>
              <tr>
                <th scope="col">${t('components.ucdpEvents.country')}</th>
                <th scope="col">${t('components.ucdpEvents.deaths')}</th>
                <th scope="col">${t('components.ucdpEvents.date')}</th>
                <th scope="col">${t('components.ucdpEvents.actors')}</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
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
