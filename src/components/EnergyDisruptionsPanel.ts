import { Panel } from './Panel';
import { escapeHtml } from '@/utils/sanitize';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { attributionFooterHtml, ATTRIBUTION_FOOTER_CSS } from '@/utils/attribution-footer';
import { SupplyChainServiceClient } from '@/generated/client/worldmonitor/supply_chain/v1/service_client';
import type {
  ListEnergyDisruptionsResponse,
  EnergyDisruptionEntry,
} from '@/generated/client/worldmonitor/supply_chain/v1/service_client';
import {
  formatEventWindow,
  formatCapacityOffline,
  statusForEvent,
  type DisruptionStatus,
} from '@/shared/disruption-timeline';

const client = new SupplyChainServiceClient(getRpcBaseUrl(), {
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
});

// One glyph per event type so readers can scan the timeline by nature of
// disruption. Kept terse — the type string itself is shown next to the glyph.
const EVENT_GLYPH: Record<string, string> = {
  sabotage:    '💥',
  sanction:    '🚫',
  maintenance: '🔧',
  mechanical:  '⚙️',
  weather:     '🌀',
  commercial:  '💼',
  war:         '⚔️',
  other:       '•',
};

const STATUS_COLOR: Record<DisruptionStatus, string> = {
  ongoing:  '#e74c3c',
  resolved: '#7f8c8d',
  unknown:  '#95a5a6',
};

const EVENT_TYPE_FILTERS: Array<{ key: string; label: string }> = [
  { key: '',            label: 'All events' },
  { key: 'sabotage',    label: 'Sabotage' },
  { key: 'sanction',    label: 'Sanction' },
  { key: 'mechanical',  label: 'Mechanical' },
  { key: 'maintenance', label: 'Maintenance' },
  { key: 'war',         label: 'War' },
  { key: 'weather',     label: 'Weather' },
  { key: 'commercial',  label: 'Commercial' },
  { key: 'other',       label: 'Other' },
];

function statusChip(status: DisruptionStatus): string {
  const color = STATUS_COLOR[status] ?? STATUS_COLOR.unknown;
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return `<span class="ed-badge" style="background:${color}">${escapeHtml(label)}</span>`;
}

/**
 * Standalone reverse-chronological timeline of every disruption event in
 * `energy:disruptions:v1`. Per plan §L #4 this panel is the primary
 * disruption surface — PipelineStatusPanel and StorageFacilityMapPanel
 * each render an *asset-scoped* slice of the same events in their drawer,
 * but neither lists the global log.
 *
 * Click-through dispatches the same events those panels already listen
 * for (`energy:open-pipeline-detail` / `energy:open-storage-facility-detail`),
 * so the event-routing contract stays the same as CountryDeepDivePanel's
 * disruption row — no new panel-open protocol introduced.
 */
export class EnergyDisruptionsPanel extends Panel {
  private data: ListEnergyDisruptionsResponse | null = null;
  private activeTypeFilter = '';
  private ongoingOnly = false;

  constructor() {
    super({
      id: 'energy-disruptions',
      title: 'Energy Disruptions Log',
      defaultRowSpan: 2,
      infoTooltip:
        'Curated log of disruption events affecting oil & gas pipelines and ' +
        'storage facilities — sabotage, sanctions, maintenance, mechanical, ' +
        'weather, war, commercial. Each event ties back to a seeded asset; ' +
        'click a row to jump to the pipeline / storage panel with that event ' +
        'highlighted. See /docs/methodology/disruptions for the schema.',
    });

    // Event delegation on the persistent `content` element. Panel.setContent
    // debounces the DOM write by 150ms (see Panel.ts:1025), so attaching
    // listeners immediately after setContent() in render() would target the
    // stale DOM — chips, rows, and the ongoing-toggle button would all be
    // silently non-interactive. Codex P1 on PR #3378.
    //
    // Delegating from the persistent parent sidesteps the debounce entirely:
    // the handler uses `closest(...)` on the clicked element to route by
    // data-attributes, so it works regardless of whether the DOM has
    // flushed yet or has been re-rendered since the last filter change.
    this.content.addEventListener('click', this.handleContentClick);
  }

  private handleContentClick = (e: Event): void => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const filterBtn = target.closest<HTMLButtonElement>('[data-filter-type]');
    if (filterBtn) {
      this.setTypeFilter(filterBtn.dataset.filterType ?? '');
      return;
    }

    const ongoingBtn = target.closest<HTMLButtonElement>('[data-toggle-ongoing]');
    if (ongoingBtn) {
      this.toggleOngoingOnly();
      return;
    }

    const row = target.closest<HTMLTableRowElement>('tr.ed-row');
    if (row) {
      const eventId = row.dataset.eventId;
      const assetId = row.dataset.assetId;
      const assetType = row.dataset.assetType;
      if (eventId && assetId && assetType) {
        this.dispatchOpenAsset(eventId, assetId, assetType);
      }
    }
  };

  public async fetchData(): Promise<void> {
    try {
      const live = await client.listEnergyDisruptions({
        assetId: '',
        assetType: '',
        ongoingOnly: false,
      });
      if (!this.element?.isConnected) return;
      // Distinguish upstream unavailability from a healthy empty result.
      // The server contract (see list-energy-disruptions.ts) returns
      // `upstreamUnavailable: true` only when Redis itself can't be
      // read; an empty `events` array with `upstreamUnavailable: false`
      // is a valid response shape the UI should render as "no events
      // match" rather than as an error. Conflating the two previously
      // showed a retry button on what was a legitimate empty state.
      if (live.upstreamUnavailable) {
        this.showError('Energy disruptions log unavailable', () => void this.fetchData());
        return;
      }
      this.data = live;
      this.render();
    } catch (err) {
      if (this.isAbortError(err)) return;
      if (!this.element?.isConnected) return;
      this.showError('Energy disruptions log error', () => void this.fetchData());
    }
  }

  private setTypeFilter(type: string): void {
    this.activeTypeFilter = type;
    this.render();
  }

  private toggleOngoingOnly(): void {
    this.ongoingOnly = !this.ongoingOnly;
    this.render();
  }

  private filterEvents(): EnergyDisruptionEntry[] {
    if (!this.data) return [];
    let events = this.data.events;
    if (this.activeTypeFilter) {
      events = events.filter(e => e.eventType === this.activeTypeFilter);
    }
    if (this.ongoingOnly) {
      events = events.filter(e => !e.endAt);
    }
    // Newest first. Server already sorts by startAt DESC but defensive
    // sort keeps the UI stable when filters reshuffle.
    return [...events].sort((a, b) => b.startAt.localeCompare(a.startAt));
  }

  private render(): void {
    if (!this.data) return;

    // Compute once — previously filterEvents() ran twice per render, once
    // for the row HTML and again for filteredCount. Trivial for 52 events
    // but the redundant sort on every render was noise. Codex P2.
    const filtered = this.filterEvents();
    const rows = filtered.map(e => this.renderRow(e)).join('');
    const totalCount = this.data.events.length;
    const ongoingCount = this.data.events.filter(e => !e.endAt).length;
    const filteredCount = filtered.length;
    const summary = this.activeTypeFilter || this.ongoingOnly
      ? `${filteredCount} shown · ${totalCount} total · ${ongoingCount} ongoing`
      : `${totalCount} events · ${ongoingCount} ongoing`;

    const typeButtons = EVENT_TYPE_FILTERS.map(f => {
      const active = f.key === this.activeTypeFilter;
      return `<button class="ed-chip${active ? ' ed-chip-active' : ''}" data-filter-type="${escapeHtml(f.key)}">${escapeHtml(f.label)}</button>`;
    }).join('');

    const ongoingBtn = `<button class="ed-chip${this.ongoingOnly ? ' ed-chip-active' : ''}" data-toggle-ongoing>Ongoing only</button>`;

    const attribution = attributionFooterHtml({
      sourceType: 'classifier',
      method: 'curated event log',
      sampleSize: totalCount,
      sampleLabel: 'disruption events',
      updatedAt: this.data.fetchedAt,
      classifierVersion: this.data.classifierVersion,
      creditName: 'Operator press + regulator filings + OFAC/EU sanctions + major wire',
      creditUrl: '/docs/methodology/disruptions',
    });

    this.setContent(`
      <div class="ed-wrap">
        <div class="ed-summary">${escapeHtml(summary)}</div>
        <div class="ed-filters">${typeButtons}${ongoingBtn}</div>
        <table class="ed-table">
          <thead>
            <tr>
              <th>Event</th>
              <th>Asset</th>
              <th>Window</th>
              <th>Offline</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>${rows || `<tr><td colspan="5" class="ed-empty">No events match the current filter.</td></tr>`}</tbody>
        </table>
        ${attribution}
      </div>
      ${ATTRIBUTION_FOOTER_CSS}
      <style>
        .ed-wrap { font-size: 11px; }
        .ed-summary { font-size: 10px; color: var(--text-dim, #888); text-transform: uppercase; letter-spacing: 0.04em; margin: 4px 0 6px 0; }
        .ed-filters { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
        .ed-chip { background: rgba(255,255,255,0.04); color: var(--text-dim, #aaa); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 2px 8px; font-size: 10px; cursor: pointer; }
        .ed-chip:hover { background: rgba(255,255,255,0.08); color: var(--text, #eee); }
        .ed-chip-active { background: #2980b9; border-color: #2980b9; color: #fff; }
        .ed-chip-active:hover { background: #2471a3; }
        .ed-table { width: 100%; border-collapse: collapse; }
        .ed-table th { text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-dim, #888); padding: 4px 6px; border-bottom: 1px solid rgba(255,255,255,0.08); }
        .ed-table td { padding: 6px; border-bottom: 1px solid rgba(255,255,255,0.04); vertical-align: top; }
        .ed-row { cursor: pointer; }
        .ed-row:hover td { background: rgba(255,255,255,0.03); }
        .ed-event { font-weight: 600; color: var(--text, #eee); }
        .ed-sub { font-size: 9px; color: var(--text-dim, #888); text-transform: uppercase; letter-spacing: 0.04em; }
        .ed-asset-type { display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; background: rgba(255,255,255,0.08); color: var(--text-dim, #aaa); margin-right: 4px; }
        .ed-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 9px; font-weight: 700; color: #fff; text-transform: uppercase; letter-spacing: 0.04em; }
        .ed-empty { text-align: center; color: var(--text-dim, #888); padding: 20px; font-style: italic; }
        .ed-offline { font-family: monospace; font-size: 10px; color: var(--text, #eee); }
      </style>
    `);

    // No inline listener attachment — the constructor registers a single
    // delegated click handler on `this.content` that routes by data-
    // attribute via `closest(...)`. Attaching listeners here would target
    // the stale DOM because Panel.setContent() debounces by 150ms.
  }

  private dispatchOpenAsset(_eventId: string, assetId: string, assetType: string): void {
    // Dispatch only the {pipelineId, facilityId} field the receiving
    // drawers actually consume today (see PipelineStatusPanel and
    // StorageFacilityMapPanel `openDetailHandler`). The row click
    // jumps the user to the asset — they see the full disruption
    // timeline for that asset and can locate the specific event
    // visually. A future PR can add a `highlightEventId` contract
    // with matching drawer-side rendering (scroll-into-view + visual
    // emphasis); until then, emitting an unread field was a misleading
    // API surface (Codex P2).
    const detail = assetType === 'storage'
      ? { facilityId: assetId }
      : { pipelineId: assetId };
    const eventName = assetType === 'storage'
      ? 'energy:open-storage-facility-detail'
      : 'energy:open-pipeline-detail';
    window.dispatchEvent(new CustomEvent(eventName, { detail }));
  }

  private renderRow(e: EnergyDisruptionEntry): string {
    const glyph = EVENT_GLYPH[e.eventType] ?? '•';
    const status = statusForEvent({ startAt: e.startAt, endAt: e.endAt || undefined });
    const eventWindow = formatEventWindow(e.startAt, e.endAt || undefined);
    const offline = formatCapacityOffline(e.capacityOfflineBcmYr, e.capacityOfflineMbd);
    const causeChain = e.causeChain.join(' → ') || '—';

    return `
      <tr class="ed-row"
          data-event-id="${escapeHtml(e.id)}"
          data-asset-id="${escapeHtml(e.assetId)}"
          data-asset-type="${escapeHtml(e.assetType)}">
        <td>
          <div class="ed-event">${glyph} ${escapeHtml(e.eventType)}</div>
          <div class="ed-sub">${escapeHtml(e.shortDescription)}</div>
          <div class="ed-sub">${escapeHtml(causeChain)}</div>
        </td>
        <td>
          <span class="ed-asset-type">${escapeHtml(e.assetType)}</span>
          <span class="ed-asset-id">${escapeHtml(e.assetId)}</span>
        </td>
        <td>${escapeHtml(eventWindow)}</td>
        <td><span class="ed-offline">${escapeHtml(offline || '—')}</span></td>
        <td>${statusChip(status)}</td>
      </tr>`;
  }
}
