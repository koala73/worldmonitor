import { Panel } from './Panel';
import type {
  GetTorontoSafetyResponse,
  TorontoAnnualAggregate,
  TorontoReportedOccurrence,
} from '@/generated/client/worldmonitor/safety/v1/service_client';
import { fetchTorontoSafetyDataset, type TorontoSafetyDataset } from '@/services/toronto-safety';
import { h } from '@/utils/dom-utils';
import { sanitizeUrl } from '@/utils/sanitize';
import {
  TORONTO_SAFETY_SEMANTICS,
  torontoSafetySourceById,
} from '../../shared/toronto-safety.js';

const OCCURRENCES = TORONTO_SAFETY_SEMANTICS.reportedOccurrence as TorontoSafetyDataset;
const AGGREGATES = TORONTO_SAFETY_SEMANTICS.annualAggregate as TorontoSafetyDataset;

export class TorontoSafetyPanel extends Panel {
  private mode: TorontoSafetyDataset = OCCURRENCES;
  private responses = new Map<TorontoSafetyDataset, GetTorontoSafetyResponse>();
  private loading = true;
  private error: string | null = null;

  constructor() {
    super({
      id: 'toronto-safety',
      title: 'Toronto Safety',
      showCount: true,
      infoTooltip: 'Official retrospective Toronto Police Service datasets. Reported occurrences and annual calls-attended aggregates are separate. This is not live dispatch.',
    });
    this.element.classList.add('panel-tall');
    void this.fetchData();
  }

  private async fetchData(): Promise<void> {
    if (!this.element.isConnected) {
      this.runWhenConnected(() => { void this.fetchData(); });
      return;
    }
    this.loading = true;
    this.error = null;
    this.render();
    try {
      const [occurrences, aggregates] = await Promise.all([
        fetchTorontoSafetyDataset(OCCURRENCES),
        fetchTorontoSafetyDataset(AGGREGATES),
      ]);
      if (!this.element.isConnected) return;
      this.responses.set(OCCURRENCES, occurrences);
      this.responses.set(AGGREGATES, aggregates);
    } catch (error) {
      if (this.isAbortError(error) || !this.element.isConnected) return;
      this.error = 'Toronto Police Service data is unavailable.';
      console.error('[TorontoSafety] Fetch error:', error);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  protected render(): void {
    if (this.loading) {
      this.setContentNodes(h('div', { className: 'empty-state' }, 'Loading Toronto safety data…'));
      return;
    }
    if (this.error) {
      this.showError(this.error, () => this.refresh());
      return;
    }

    const response = this.responses.get(this.mode);
    const rows = this.mode === OCCURRENCES ? response?.occurrences ?? [] : response?.aggregates ?? [];
    this.setCount(rows.length);
    const descriptor = torontoSafetySourceById(this.mode === OCCURRENCES ? 'tps-mci' : 'tps-calls-attended');
    const sourceUrl = sanitizeUrl(response?.sourceUrl || descriptor?.sourceUrl || '');

    this.setContentNodes(
      h('div', { className: 'toronto-safety-panel' },
        h('div', { className: 'panel-tabs', role: 'tablist', 'aria-label': 'Toronto safety dataset' },
          this.tab(OCCURRENCES, 'Reported occurrences'),
          this.tab(AGGREGATES, 'Annual calls attended'),
        ),
        response?.degraded ? h('div', { className: 'empty-state' }, 'Last-good data is shown because the source is degraded.') : false,
        response?.unavailable
          ? h('div', { className: 'empty-state' }, 'This on-demand dataset has not been published yet.')
          : h('div', { className: 'toronto-safety-list' },
            ...(rows.length > 0
              ? rows.map((row) => this.mode === OCCURRENCES
                ? this.occurrenceRow(row as TorontoReportedOccurrence)
                : this.aggregateRow(row as TorontoAnnualAggregate))
              : [h('div', { className: 'empty-state' }, 'No records match this view.')]),
          ),
        h('div', { className: 'panel-source' },
          h('div', null, response?.attribution || descriptor?.attribution || ''),
          h('div', null, response?.disclaimer || descriptor?.disclaimer || ''),
          sourceUrl ? h('a', { href: sourceUrl, target: '_blank', rel: 'noopener' }, 'Toronto Police Service source ↗') : false,
        ),
      ),
    );
  }

  private tab(mode: TorontoSafetyDataset, label: string): HTMLElement {
    return h('button', {
      className: `panel-tab ${this.mode === mode ? 'active' : ''}`,
      role: 'tab',
      'aria-selected': this.mode === mode ? 'true' : 'false',
      onClick: () => { this.mode = mode; this.render(); },
    }, label);
  }

  private occurrenceRow(row: TorontoReportedOccurrence): HTMLElement {
    const date = row.reportDate ? new Date(row.reportDate).toLocaleDateString() : 'Unknown date';
    return h('div', { className: 'intel-item' },
      h('div', { className: 'intel-item-title' }, row.offence || 'Reported occurrence'),
      h('div', { className: 'intel-item-meta' }, `${date} · ${row.division || 'Unknown division'} · ${row.neighbourhood || 'Unknown neighbourhood'}`),
      h('div', { className: 'intel-item-summary' }, `${row.locationType || row.premisesType || 'Location withheld'} · Approximate offset location`),
    );
  }

  private aggregateRow(row: TorontoAnnualAggregate): HTMLElement {
    return h('div', { className: 'intel-item' },
      h('div', { className: 'intel-item-title' }, `${row.eventCount.toLocaleString()} calls attended`),
      h('div', { className: 'intel-item-meta' }, `${row.eventYear || 'Unknown year'} · ${row.divisionFinal || row.divisionOriginal || 'Unknown division'}`),
      h('div', { className: 'intel-item-summary' }, `${row.neighbourhood || 'Unknown neighbourhood'} · Annual aggregate, not an incident point`),
    );
  }

  public refresh(): void {
    void this.fetchData();
  }
}
