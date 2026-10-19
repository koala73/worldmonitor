import { t } from '@/services/i18n';
import { fetchCountryHistory, type GetCountryHistoryResponse, type CountryHistoryPoint } from '@/services/country-history';
import { onEntitlementChange } from '@/services/entitlements';

export class CountryHistory {
  private days = 7;
  private request = new AbortController();
  private unsubscribe: () => void;
  private data: GetCountryHistoryResponse | null = null;
  private disposed = false;

  constructor(private mount: HTMLElement, private country: string, private signal: AbortSignal) {
    let started = false;
    this.unsubscribe = onEntitlementChange(() => {
      started = true;
      this.days = 7;
      void this.load();
    });
    signal.addEventListener('abort', () => this.destroy(), { once: true });
    if (!started) void this.load();
  }

  destroy(): void {
    this.disposed = true;
    this.request.abort();
    this.unsubscribe();
  }

  private element<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    element.textContent = text;
    element.className = className;
    return element;
  }

  private async load(): Promise<void> {
    this.request.abort();
    this.request = new AbortController();
    const request = this.request;
    this.data = null;
    this.mount.replaceChildren(this.element('p', t('countryHistory.loading')));
    try {
      const data = await fetchCountryHistory(this.country, this.days, AbortSignal.any([this.signal, request.signal]));
      if (request.signal.aborted || this.disposed) return;
      if (data.upstreamUnavailable) throw new Error('history unavailable');
      this.data = data;
      this.render();
    } catch {
      if (request.signal.aborted || this.disposed) return;
      const retry = this.element('button', t('countryHistory.retry'), 'cdp-action-btn');
      retry.type = 'button';
      retry.addEventListener('click', () => void this.load());
      this.mount.replaceChildren(this.element('p', t('countryHistory.unavailable')), retry);
    }
  }

  private render(): void {
    const data = this.data;
    if (!data) return;
    const controls = this.element('div', '', 'country-history-controls');
    const label = this.element('label', `${t('countryHistory.window')} `);
    const select = this.element('select');
    for (const days of [7, 30, 90, 365].filter(value => value <= data.allowedDays)) {
      const option = this.element('option', t('countryHistory.days', { days }));
      option.value = String(days);
      option.selected = days === this.days;
      select.append(option);
    }
    select.addEventListener('change', () => { this.days = Number(select.value); void this.load(); });
    label.append(select);
    controls.append(label, this.element('span', t('countryHistory.observed', { count: data.returnedDays, days: data.effectiveDays })));
    this.mount.replaceChildren(controls);
    if (data.stale) this.mount.append(this.element('p', t('countryHistory.stale'), 'country-history-notice'));
    this.mount.append(this.element('p', t('countryHistory.legend'), 'country-history-legend'));
    if (!data.points.length) {
      this.mount.append(this.element('p', t('countryHistory.empty')));
    } else {
      this.mount.append(this.chart(data.points));
      const dates = this.element('div', '', 'country-history-dates');
      const detail = this.element('div', '', 'country-history-detail');
      detail.setAttribute('aria-live', 'polite');
      for (const point of data.points) {
        const button = this.element('button', `${point.date.slice(5)}${point.topEvents.length ? ' •' : ''}`);
        button.type = 'button';
        button.dataset.historyDate = point.date;
        button.setAttribute('aria-label', t('countryHistory.selectDate', { date: point.date, count: point.topEvents.length }));
        button.addEventListener('click', () => {
          dates.querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
          this.renderDetail(detail, point);
        });
        dates.append(button);
      }
      this.mount.append(dates, detail);
      (dates.lastElementChild as HTMLButtonElement).click();
    }
    if (this.days >= data.allowedDays && data.allowedDays < 365) {
      const upsell = this.element('a', t(data.allowedDays <= 7 ? 'countryHistory.unlock90' : 'countryHistory.unlock365'), 'panel-locked-cta');
      upsell.href = '/pro#pricing';
      this.mount.append(upsell);
    }
  }

  private renderDetail(detail: HTMLElement, point: CountryHistoryPoint): void {
    const scores = [point.cii ? `CII ${point.cii.score.toFixed(0)} · ${point.cii.version}` : t('countryHistory.ciiMissing'), point.resilience ? `${t('countryHistory.resilience')} ${point.resilience.score.toFixed(0)} · ${point.resilience.version}` : t('countryHistory.resilienceMissing')];
    detail.replaceChildren(this.element('strong', point.date), this.element('p', scores.join(' / ')));
    if (point.ciiVersionBreak || point.resilienceVersionBreak) detail.append(this.element('p', t('countryHistory.break'), 'country-history-notice'));
    if (point.keySignals.includes('news_partial')) detail.append(this.element('p', t('countryHistory.partial')));
    const list = this.element('ul');
    for (const event of point.topEvents) {
      const item = this.element('li');
      const link = this.element('a', event.title);
      if (!/^https?:\/\//i.test(event.link)) continue;
      link.href = event.link;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      item.append(link, this.element('span', ` · ${event.source}`));
      list.append(item);
    }
    detail.append(list.childElementCount ? list : this.element('p', t('countryHistory.noEvents')));
  }

  private chart(points: CountryHistoryPoint[]): SVGSVGElement {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 600 110');
    svg.classList.add('country-history-chart');
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', t('countryHistory.chart'));
    const first = Date.parse(points[0]!.date), last = Date.parse(points[points.length - 1]!.date);
    const x = (point: CountryHistoryPoint) => last === first ? 300 : 10 + (Date.parse(point.date) - first) / (last - first) * 580;
    for (const kind of ['cii', 'resilience'] as const) {
      let previous: CountryHistoryPoint | null = null;
      for (const point of points) {
        const score = point[kind];
        if (!score) { previous = null; continue; }
        const prior = previous?.[kind];
        const broken = kind === 'cii' ? point.ciiVersionBreak : point.resilienceVersionBreak;
        if (previous && prior && !broken) {
          const path = document.createElementNS(ns, 'path');
          path.setAttribute('d', `M${x(previous)},${100 - prior.score * .9} L${x(point)},${100 - score.score * .9}`);
          path.setAttribute('class', `country-history-${kind}`);
          svg.append(path);
        }
        const circle = document.createElementNS(ns, 'circle');
        circle.setAttribute('cx', String(x(point))); circle.setAttribute('cy', String(100 - score.score * .9));
        circle.setAttribute('r', point.topEvents.length ? '4' : '2');
        circle.setAttribute('class', `country-history-${kind}`);
        circle.setAttribute('role', 'button');
        circle.setAttribute('tabindex', '-1');
        circle.setAttribute('aria-label', t('countryHistory.selectDate', { date: point.date, count: point.topEvents.length }));
        const selectDate = () => this.mount.querySelector<HTMLButtonElement>(`[data-history-date="${point.date}"]`)?.click();
        circle.addEventListener('click', selectDate);
        circle.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectDate(); }
        });
        svg.append(circle);
        previous = point;
      }
    }
    return svg;
  }
}
