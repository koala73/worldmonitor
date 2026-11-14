import { Panel } from './Panel';
import { fetchGridDisruptionClock } from '@/services/grid-disruption-clock';
import { getLocale, t } from '@/services/i18n';
import { h, type DomChild } from '@/utils/dom-utils';
import { validateUrl } from '@/utils/sanitize';
import {
  deriveGridClock, GRID_CLOCK_MAX_AGE_MS, type GridClockRegion, type GridClockSnapshot, type GridClockWarning,
} from '../../shared/grid-disruption-clock.js';
import '../styles/grid-disruption-clock.css';

const regions = { CA: 'California', TN: 'Tennessee' } as const;
type ClockState = ReturnType<typeof deriveGridClock>;

function label(key: string, options?: Record<string, unknown>): string {
  return t('components.gridDisruptionClock.' + key, options);
}

function time(ms: number): HTMLElement {
  const date = new Date(ms);
  return h('time', { datetime: date.toISOString(), title: date.toISOString() },
    new Intl.DateTimeFormat(getLocale(), {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
    }).format(date));
}

function elapsed(since: number | null, now: number): string {
  if (since === null) return '—';
  const minutes = Math.max(0, Math.floor((now - since) / 60_000));
  if (minutes < 60) return label('minutes', { amount: minutes });
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? label('hours', { amount: hours }) : label('days', { amount: Math.floor(hours / 24) });
}

function source(name: string, url: string): HTMLElement {
  const link = validateUrl(url);
  return link.startsWith('https://')
    ? h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, name)
    : h('span', name);
}

function section(title: string, ...children: DomChild[]): HTMLElement {
  return h('section', { className: 'grid-clock-section' }, h('h3', title), ...children);
}

function warningRow(warning: GridClockWarning): HTMLElement {
  return h('li', { className: 'grid-clock-notice' },
    h('strong', warning.title),
    h('div', { className: 'grid-clock-meta' }, label('kind.' + warning.kind), ' · ', source(warning.sourceName, warning.sourceUrl)),
    h('div', { className: 'grid-clock-meta' }, label('issued'), ' ', time(warning.issuedAt), ' · ', label('until'), ' ', time(warning.expiresAt)));
}

function warnings(region: GridClockRegion, state: ClockState): HTMLElement {
  const current = state.activeWarnings;
  const earlier = region.recentWarnings?.filter(item => item.issuedAt <= Date.now())
    .sort((a, b) => b.issuedAt - a.issuedAt)[0];
  const checks = region.warningSources.map(check => {
    const checkedAt = check.checkedAt;
    const stale = checkedAt !== null && Date.now() - checkedAt > GRID_CLOCK_MAX_AGE_MS;
    const status = check.status === 'available' && stale ? 'stale' : check.status;
    return h('li', source(check.sourceName, check.sourceUrl), ' · ', label('checks.' + status),
      checkedAt ? h('span', ' · ', time(checkedAt)) : null);
  });
  const manualGridSource = region.warningSources.find(check => check.kind === 'grid' && check.status === 'not_monitored');
  return section(label('warnings'),
    current.length ? h('ul', { className: 'grid-clock-list' }, ...current.map(warningRow))
      : h('p', state.warningsFresh ? label('noActive') : label('unknownWarnings')),
    manualGridSource ? h('p', { className: 'grid-clock-meta' }, label('operatorLink'), ' ',
      source(manualGridSource.sourceName, manualGridSource.sourceUrl)) : null,
    earlier ? h('details', { dataset: { clockDisclosure: 'prior-notice' } }, h('summary', label('priorNotice')), h('ul', { className: 'grid-clock-list' }, warningRow(earlier))) : null,
    h('details', { dataset: { clockDisclosure: 'sources' } }, h('summary', label('sources')), h('ul', { className: 'grid-clock-checks' }, ...checks)));
}

function recovery(region: GridClockRegion, state: ClockState): HTMLElement {
  const format = new Intl.NumberFormat(getLocale());
  const point = state.freshness === 'unavailable' ? null : region.current;
  let change = label('noComparison');
  if (state.changeCustomers !== null) {
    const delta = state.changeCustomers;
    change = label(delta < 0 ? 'decreased' : delta > 0 ? 'increased' : 'unchanged',
      { amount: format.format(Math.abs(delta)) });
  }
  const history = [...region.history].sort((a, b) => b.observedAt - a.observedAt);
  const historyList = history.length ? h('details', { dataset: { clockDisclosure: 'history' } }, h('summary', label('history', { total: format.format(history.length) })),
    h('ol', { className: 'grid-clock-history' }, ...history.map(item =>
      h('li', time(item.observedAt), h('span', item.customersOut === null ? label('unknown') : format.format(item.customersOut)),
        h('small', item.coverageLabel))))) : null;
  return section(label('recovery'),
    h('p', change, state.comparisonAt === null ? null : h('span', ' · ', label('since'), ' ', time(state.comparisonAt))),
    point?.peakLoadRestoredPct == null ? null : h('p', label('peakLoad', { percent: format.format(point.peakLoadRestoredPct) })),
    historyList);
}

export class GridDisruptionClockPanel extends Panel {
  private snapshot: GridClockSnapshot | null = null;
  private selected: GridClockRegion['code'] = 'CA';
  private refreshFailed = false;
  private clockTimer: ReturnType<typeof setInterval>;

  constructor() {
    super({
      id: 'grid-disruption-clock', title: t('panels.gridDisruptionClock'),
      className: 'panel-wide', defaultRowSpan: 2, trackActivity: false,
    });
    this.showLoading();
    this.clockTimer = setInterval(() => this.render(), 60_000);
  }

  public override destroy(): void {
    clearInterval(this.clockTimer);
    super.destroy();
  }

  public async fetchData(): Promise<void> {
    try {
      this.snapshot = await fetchGridDisruptionClock();
      this.refreshFailed = false;
    } catch {
      if (!this.snapshot) {
        this.showError(label('loadError'), () => void this.fetchData());
        return;
      }
      this.refreshFailed = true;
    }
    this.render();
  }

  private render(): void {
    const region = this.snapshot?.regions.find(item => item.code === this.selected);
    if (!region) return;
    // A local clock tick must not close disclosures or steal keyboard focus.
    const openDetails = new Set([...this.content.querySelectorAll<HTMLDetailsElement>('details[open]')]
      .map(detail => detail.dataset.clockDisclosure));
    const focused = this.content.contains(document.activeElement) ? document.activeElement : null;
    const focusedRegion = focused instanceof HTMLElement ? focused.dataset.region : undefined;
    const focusedSummary = focused?.tagName === 'SUMMARY';
    const focusedHref = focused instanceof HTMLAnchorElement ? focused.href : null;
    const focusedDisclosure = focused?.closest('details')?.dataset.clockDisclosure;
    const now = Date.now();
    const state = deriveGridClock(region, now);
    const point = state.freshness === 'unavailable' ? null : region.current;
    const number = new Intl.NumberFormat(getLocale());
    const bar = h('div', { className: 'grid-clock-selector', role: 'group', 'aria-label': label('region') },
      ...(['CA', 'TN'] as const).map(code => h('button', {
        type: 'button', 'aria-pressed': String(code === this.selected), 'data-region': code,
        onclick: () => {
          this.selected = code;
          this.render();
          this.content.querySelector<HTMLButtonElement>(`button[data-region="${code}"]`)?.focus({ preventScroll: true });
        },
      }, regions[code])));
    const firstWarning = state.activeWarnings.length
      ? Math.min(...state.activeWarnings.map(warning => warning.issuedAt)) : null;
    const ageLabel = elapsed(firstWarning ?? point?.observedAt ?? null, now);
    const currentTotal = point?.customersOut;
    if (this.refreshFailed) this.setDataBadge('cached');
    else if (state.freshness === 'fresh' || state.warningsFresh) this.setDataBadge('live');
    else if (state.freshness === 'stale') this.setDataBadge('cached');
    else this.setDataBadge('unavailable');
    this.setContentNodes(h('div', { className: 'grid-clock', dataset: { phase: state.phase } }, bar,
      this.refreshFailed ? h('p', { className: 'grid-clock-meta', role: 'status' }, label('retained')) : null,
      h('div', { className: 'grid-clock-readout' },
        h('div', h('span', { className: 'grid-clock-phase' }, label('phase.' + state.phase)),
          h('strong', { className: 'grid-clock-total' }, currentTotal == null ? label('unknown') : number.format(currentTotal)),
          h('div', { className: 'grid-clock-meta' }, label(state.freshness === 'stale' || this.refreshFailed ? 'lastCustomers' : 'customers'))),
        h('div', { className: 'grid-clock-age' }, h('strong', ageLabel), h('span', label(firstWarning ? 'warningAge' : 'dataAge')))),
      point ? h('p', { className: 'grid-clock-coverage' }, point.coverageLabel,
        point.customersTracked === null ? h('span', ' · ', label('denominatorUnknown')) : h('span', ' · ', label('tracked', { amount: number.format(point.customersTracked) })),
        h('span', { className: 'grid-clock-attribution' }, source(point.sourceName, point.sourceUrl), ' · ', time(point.observedAt)),
        point.detail ? h('span', { className: 'grid-clock-attribution' }, point.detail) : null)
        : h('p', { className: 'grid-clock-coverage' }, label('noObservation')),
      warnings(region, state), recovery(region, state)));
    for (const detail of this.content.querySelectorAll('details')) {
      const summary = detail.querySelector('summary');
      detail.open = openDetails.has(detail.dataset.clockDisclosure);
      if (focusedSummary && detail.dataset.clockDisclosure === focusedDisclosure) summary?.focus({ preventScroll: true });
    }
    if (focusedRegion) {
      this.content.querySelector<HTMLButtonElement>(`button[data-region="${focusedRegion}"]`)?.focus({ preventScroll: true });
    }
    if (focusedHref) {
      [...this.content.querySelectorAll('a')].find(link => link.href === focusedHref
        && link.closest('details')?.dataset.clockDisclosure === focusedDisclosure)?.focus({ preventScroll: true });
    }
  }
}
