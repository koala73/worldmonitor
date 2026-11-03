import type { FoodPriceSource, FoodMarketPrice } from '@/generated/client/worldmonitor/economic/v1/service_client';
import { h } from '@/utils/dom-utils';
import { t } from '@/services/i18n';

const label = (key: string): string => t(`components.foodPrices.${key}`);

function sourceLink(url: string, text: string): HTMLElement {
  const link = h('a', { target: '_blank', rel: 'noopener noreferrer' }, text);
  try { if (new URL(url).protocol === 'https:') link.setAttribute('href', url); } catch { /* Leave invalid links inert. */ }
  return link;
}

export class FoodPricesCard {
  private sources: FoodPriceSource[] = [];
  private selected = '';
  private market = '';
  private country = '';

  constructor(private readonly host: HTMLElement) {
    host.classList.add('food-prices-card');
    host.textContent = label('loading');
  }

  public update(sources: FoodPriceSource[]): void {
    this.sources = sources;
    if (!sources.some(source => source.id === this.selected && !source.contextOnly)) {
      this.selected = sources.find(source => !source.contextOnly && source.prices.length)?.id ?? sources.find(source => !source.contextOnly)?.id ?? '';
    }
    this.render();
  }

  public showError(retry: () => void): void {
    this.host.replaceChildren(h('p', {}, label('unavailable')), h('button', { type: 'button', onclick: retry }, label('retry')));
  }

  private selector(title: string, values: { value: string; text: string }[], value: string, change: (value: string) => void): HTMLElement {
    const select = h('select', { 'aria-label': title, onchange: (event: Event) => {
      change((event.target as HTMLSelectElement).value);
      Array.from(this.host.querySelectorAll('select')).find(select => select.getAttribute('aria-label') === title)?.focus({ preventScroll: true });
    } },
      ...values.map(option => h('option', { value: option.value, selected: option.value === value }, option.text)));
    return h('label', { className: 'food-prices-filter' }, h('span', {}, title), select);
  }

  private table(prices: FoodMarketPrice[], contextOnly: boolean, sourceId: string): HTMLElement {
    const format = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 });
    return h('div', { className: 'food-prices-table-wrap', tabIndex: 0, role: 'region', 'aria-label': label('prices'), 'data-price-table': contextOnly ? `context:${sourceId}` : 'weekly' },
      h('table', { className: 'food-prices-table' },
        h('thead', {}, h('tr', {}, ...[label('product'), label('price'), ...(contextOnly ? [] : [label('weekly')])].map(text => h('th', { scope: 'col' }, text)))),
        h('tbody', {}, ...prices.map(price => h('tr', {},
          h('th', { scope: 'row' }, price.item, price.origin ? h('small', {}, `${label('origin')}: ${price.origin}`) : null),
          h('td', {}, `${format.format(price.price)} ${price.currency}`, h('small', {}, `/ ${price.unit}`)),
          contextOnly ? null : h('td', {}, price.wowAvailable ? `${price.wowPct > 0 ? '+' : ''}${price.wowPct.toFixed(1)}%` : '—',
            h('small', {}, price.wowAvailable ? `${label('versus')} ${price.previousDate}` : label('noBaseline'))),
        )))));
  }

  private render(): void {
    const wasOpen = this.host.querySelector('details')?.open ?? false;
    const active = document.activeElement;
    const focusLabel = active && this.host.contains(active) ? active.getAttribute('aria-label') : null;
    const focusTable = active && this.host.contains(active) ? active.getAttribute('data-price-table') : null;
    const summaryFocused = active === this.host.querySelector('summary');
    const sections: HTMLElement[] = [];
    const weekly = this.sources.filter(source => !source.contextOnly);
    const source = weekly.find(source => source.id === this.selected);
    sections.push(h('h3', {}, label('title')), h('p', { className: 'food-prices-note' }, label('method')));
    if (source) {
      const markets = [...new Set(source.prices.map(price => JSON.stringify([price.market, price.marketType])))];
      if (!markets.includes(this.market)) this.market = markets[0] ?? '';
      const filters = [this.selector(label('country'), weekly.map(source => ({ value: source.id, text: source.country })), this.selected, value => {
        this.selected = value; this.market = ''; this.render();
      })];
      if (markets.length) filters.push(this.selector(label('market'), markets.map(value => {
        const [market, kind] = JSON.parse(value) as string[];
        return { value, text: `${market} · ${label(kind!)}` };
      }), this.market, value => { this.market = value; this.render(); }));
      sections.push(h('div', { className: 'food-prices-filters' }, ...filters), this.sourceNote(source));
      const prices = source.prices.filter(price => JSON.stringify([price.market, price.marketType]) === this.market);
      sections.push(prices.length ? this.table(prices, false, source.id) : h('p', {}, label('unavailable')));
    } else sections.push(h('p', {}, label('unavailable')));

    const giews = this.sources.find(source => source.id === 'giews');
    const monthly = this.sources.filter(source => source.contextOnly && source.id !== 'giews');
    const context = h('details', { className: 'food-prices-context' }, h('summary', {}, label('context')));
    if (wasOpen) context.setAttribute('open', '');
    context.append(h('p', { className: 'food-prices-note' }, label('contextNote')));
    if (giews) {
      if (!giews.contexts.some(brief => brief.countryCode === this.country)) this.country = giews.contexts[0]?.countryCode ?? '';
      context.append(h('h4', {}, giews.name));
      if (giews.contexts.length) {
        context.append(this.selector(label('briefCountry'), giews.contexts.map(brief => ({ value: brief.countryCode, text: brief.country })), this.country, value => {
          this.country = value; this.render();
        }));
        const brief = giews.contexts.find(brief => brief.countryCode === this.country)!;
        context.append(h('p', {}, sourceLink(brief.url, brief.title), h('small', {}, `${label(brief.status)} · ${label('report')}: ${brief.referenceDate || label('unavailable')}`)));
      } else context.append(h('p', {}, label('unavailable')));
    }
    for (const source of monthly) {
      context.append(h('h4', {}, `${source.country} · ${source.name}`), this.sourceNote(source));
      context.append(source.prices.length ? this.table(source.prices, true, source.id) : h('p', {}, label('unavailable')));
    }
    sections.push(context);
    this.host.replaceChildren(...sections);
    if (summaryFocused) context.querySelector('summary')?.focus({ preventScroll: true });
    else if (focusTable) Array.from(this.host.querySelectorAll<HTMLElement>('[data-price-table]')).find(element => element.getAttribute('data-price-table') === focusTable)?.focus({ preventScroll: true });
    else if (focusLabel) Array.from(this.host.querySelectorAll<HTMLElement>('[aria-label]')).find(element => element.getAttribute('aria-label') === focusLabel)?.focus({ preventScroll: true });
  }

  private sourceNote(source: FoodPriceSource): HTMLElement {
    return h('p', { className: 'food-prices-source', role: 'status' },
      sourceLink(source.url, source.name), ` · ${label(source.status)}`,
      h('small', {}, `${label('report')}: ${source.latestReportDate || '—'} · ${label('checked')}: ${source.fetchedAt ? source.fetchedAt.slice(0, 10) : '—'}`),
      ...(source.attribution ? [h('small', { className: 'food-prices-attribution' }, source.attribution)] : []));
  }
}
